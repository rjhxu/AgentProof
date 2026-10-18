import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodeFixCheck } from '@agentproof/shared';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /**
   * On Windows, start the command through cmd.exe. Only for the .cmd shims npm and tsc, which
   * Node refuses to start directly (CVE-2024-27980); ignored elsewhere, where the binaries start
   * on their own. The arguments are then joined into one command line, so exec() accepts only
   * plain literals for them, and only a command path free of shell metacharacters.
   */
  shell?: boolean;
}

export interface StepResult {
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

export const GIT_TIMEOUT_MS = 60_000;
export const INSTALL_TIMEOUT_MS = 180_000;
export const TYPECHECK_TIMEOUT_MS = 120_000;

/**
 * A child environment that cannot leak secrets or inherit git/npm overrides: start from an allowlist
 * copied from process.env and add CI=1, NO_COLOR=1, GIT_TERMINAL_PROMPT=0, GIT_CONFIG_NOSYSTEM=1,
 * GIT_CONFIG_GLOBAL=<os.devNull or 'NUL' on win32>, npm_config_update_notifier=false,
 * npm_config_fund=false, npm_config_audit=false. Never copy anything whose name matches
 * /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i, and never copy GIT_* or npm_config_* from the parent.
 * `extra` entries are added last.
 */
export function scrubbedEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const allowlist = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SHELL',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
  ];

  const env: NodeJS.ProcessEnv = {};

  // Copy allowed variables from parent env
  for (const key of allowlist) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  // Add required variables
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : os.devNull;
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';

  // Add extra entries last
  if (extra) {
    Object.assign(env, extra);
  }

  return env;
}

/**
 * With a shell the arguments become one command line, so only fixed literals may travel that way
 * (the npm and tsc flags are), and the command path may carry nothing cmd.exe would expand or
 * split a quoted path on.
 */
const SHELL_LITERAL = /^[A-Za-z0-9_.=-]+$/;
const SHELL_META = /["%&|<>^!\r\n]/;

function assertShellSafe(command: string, args: string[]): void {
  if (SHELL_META.test(command)) {
    throw new Error(
      `refusing to run "${command}" through a shell: the path contains shell metacharacters`,
    );
  }
  const unsafe = args.find((arg) => !SHELL_LITERAL.test(arg));
  if (unsafe !== undefined) {
    throw new Error(
      `refusing to pass "${unsafe}" through a shell: arguments must be plain literals`,
    );
  }
}

interface Launch {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  /** Started through cmd.exe, so a timeout has a process tree to end, not one process. */
  viaCmd: boolean;
}

/** A bare command name that cmd.exe resolves through PATH, as npm.cmd is. */
const BARE_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * How a .cmd shim starts on Windows: `cmd.exe /d /s /c "<command> <args>"`, the same line Node
 * builds for `shell: true` (spelled out here because Node 24 deprecates that option with
 * arguments, DEP0190). /d skips AutoRun; /s makes cmd strip only the outer quotes, so the quoted
 * command path survives. A path is always quoted: cmd.exe splits an unquoted one on whitespace and
 * also on ; , and =, all of which a directory name may carry. A bare name is never quoted: a shim
 * found through PATH under a quoted name sees the working directory as its own (%~dp0), and
 * npm.cmd then cannot find npm. The arguments reach cmd verbatim, after assertShellSafe(). A
 * missing shim is then cmd's "not recognized" on stderr with exit 1, not an ENOENT.
 */
function windowsShellLaunch(command: string, args: string[]): Launch {
  assertShellSafe(command, args);
  const file = BARE_NAME.test(command) ? command : `"${command}"`;
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[file, ...args].join(' ')}"`],
    windowsVerbatimArguments: true,
    viaCmd: true,
  };
}

/**
 * End a child that has outlived its timeout. Through cmd.exe on Windows the work runs in cmd's
 * grandchildren (node, for npm and tsc), which killing cmd alone would orphan: taskkill /T ends
 * the whole tree. Its outcome is not awaited; the execFile callback fires once cmd.exe is gone,
 * and should taskkill fail or be missing, cmd.exe itself is still killed.
 */
function killTree(child: ChildProcess, viaCmd: boolean): void {
  if (viaCmd && process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const fallback = () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    killer.on('error', fallback);
    killer.on('exit', fallback);
    killer.unref();
    return;
  }
  child.kill('SIGKILL');
}

/**
 * execFile (never a shell, except cmd.exe for Windows .cmd shims: see ExecOptions.shell),
 * windowsHide, maxBuffer 16 MiB, SIGKILL on timeout (through cmd.exe, taskkill on the whole
 * tree, so npm's and tsc's node grandchildren go too); never throws for a non-zero exit, returns
 * code/stdout/stderr. Throws only when the binary cannot be spawned (ENOENT), with a message
 * that names the command, or when a shell run is asked for with unsafe arguments.
 */
export function exec(command: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let timedOut = false;
    let resolved = false;

    const launch: Launch =
      opts.shell && process.platform === 'win32'
        ? windowsShellLaunch(command, args)
        : { file: command, args, windowsVerbatimArguments: false, viaCmd: false };

    // The timeout is the timer below, not execFile's own: cmd.exe has to be alive when taskkill
    // walks its tree, so nothing may kill it first.
    const child = execFile(
      launch.file,
      launch.args,
      {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout: string | Buffer, stderr: string | Buffer) => {
        const durationMs = Date.now() - startTime;
        const stdoutStr = typeof stdout === 'string' ? stdout : (stdout?.toString('utf-8') ?? '');
        const stderrStr = typeof stderr === 'string' ? stderr : (stderr?.toString('utf-8') ?? '');

        if (resolved) return;

        if (timedOut) {
          // Ended by the timer below, whatever exit cmd.exe or the binary reported for it.
          resolved = true;
          resolve({
            code: null,
            stdout: stdoutStr,
            stderr: stderrStr,
            timedOut: true,
            durationMs,
          });
        } else if (error) {
          if ((error as any).code === 'ENOENT') {
            // Command not found - reject
            resolved = true;
            reject(new Error(`Command not found: ${command}`));
          } else {
            // Non-zero exit code
            resolved = true;
            resolve({
              code: (error as any).code ?? null,
              stdout: stdoutStr,
              stderr: stderrStr,
              timedOut: false,
              durationMs,
            });
          }
        } else {
          resolved = true;
          resolve({
            code: 0,
            stdout: stdoutStr,
            stderr: stderrStr,
            timedOut: false,
            durationMs,
          });
        }
      },
    );

    // Handle error event (for spawn errors like ENOENT)
    child.on('error', (error) => {
      if (!resolved && (error as any).code === 'ENOENT') {
        resolved = true;
        reject(new Error(`Command not found: ${command}`));
      }
    });

    // Track timeout
    if (opts.timeoutMs) {
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree(child, launch.viaCmd);
      }, opts.timeoutMs);

      child.on('exit', () => {
        clearTimeout(timeoutHandle);
      });
    }

    // Send input if provided
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Collapse whitespace runs? NO: keep newlines, but cap at `max` chars keeping the LAST part
 * (errors are at the end), prefixed with '[... earlier output omitted]\n' when cut.
 * Default max 2000.
 */
export function trimOutput(text: string, max: number = 2000): string {
  if (text.length <= max) {
    return text;
  }

  const tail = text.slice(-max);
  return '[... earlier output omitted]\n' + tail;
}

/**
 * `git apply --check --whitespace=nowarn -` with the diff on stdin, hooks disabled
 * (-c core.hooksPath=<nonexistent dir under the worktree, e.g. .agentproof-no-hooks>),
 * in `worktreeDir`. passed / failed with trimmed stderr in detail.
 */
export async function gitApplyCheck(worktreeDir: string, diff: string): Promise<CodeFixCheck> {
  const startTime = Date.now();
  const hooksPath = path.join(worktreeDir, '.agentproof-no-hooks');

  const result = await exec(
    'git',
    ['-c', `core.hooksPath=${hooksPath}`, 'apply', '--check', '--whitespace=nowarn', '-'],
    {
      cwd: worktreeDir,
      timeoutMs: GIT_TIMEOUT_MS,
      env: scrubbedEnv(),
      input: diff,
    },
  );

  const durationMs = Date.now() - startTime;

  return {
    id: 'applies_cleanly',
    status: result.code === 0 ? 'passed' : 'failed',
    detail: result.code === 0 ? 'Diff applies cleanly' : trimOutput(result.stderr, 2000),
    durationMs,
  };
}

/**
 * `git apply --whitespace=nowarn -`; throws Error(trimmed stderr) on failure.
 */
export async function gitApply(worktreeDir: string, diff: string): Promise<void> {
  const hooksPath = path.join(worktreeDir, '.agentproof-no-hooks');

  const result = await exec(
    'git',
    ['-c', `core.hooksPath=${hooksPath}`, 'apply', '--whitespace=nowarn', '-'],
    {
      cwd: worktreeDir,
      timeoutMs: GIT_TIMEOUT_MS,
      env: scrubbedEnv(),
      input: diff,
    },
  );

  if (result.code !== 0) {
    throw new Error(trimOutput(result.stderr, 2000));
  }
}

/**
 * In `dir`: if node_modules exists -> skipped with detail 'node_modules already present'.
 * Else if package-lock.json exists -> `npm ci --ignore-scripts --no-audit --no-fund --loglevel=error`;
 * else if package.json exists -> `npm install --ignore-scripts --no-audit --no-fund --loglevel=error`;
 * else skipped 'no package.json'. Use scrubbedEnv(). passed on exit 0, failed with trimmed stderr
 * otherwise; timedOut -> failed 'npm install timed out after N ms'.
 * Always --ignore-scripts: repository code must never run here.
 */
export async function installDependencies(
  dir: string,
  opts?: { timeoutMs?: number },
  _exec = exec,
): Promise<StepResult> {
  const startTime = Date.now();
  const timeoutMs = opts?.timeoutMs ?? INSTALL_TIMEOUT_MS;

  // Check if node_modules already exists
  try {
    await fs.stat(path.join(dir, 'node_modules'));
    const durationMs = Date.now() - startTime;
    return {
      status: 'skipped',
      detail: 'node_modules already present',
      durationMs,
    };
  } catch {
    // node_modules doesn't exist, continue
  }

  // Check if package-lock.json exists
  let useLockfile = false;
  try {
    await fs.stat(path.join(dir, 'package-lock.json'));
    useLockfile = true;
  } catch {
    // package-lock.json doesn't exist
  }

  // Check if package.json exists
  let hasPackageJson = false;
  try {
    await fs.stat(path.join(dir, 'package.json'));
    hasPackageJson = true;
  } catch {
    // package.json doesn't exist
  }

  if (!hasPackageJson) {
    const durationMs = Date.now() - startTime;
    return {
      status: 'skipped',
      detail: 'no package.json',
      durationMs,
    };
  }

  // Run npm install or npm ci. Windows ships npm as npm.cmd, which Node starts only through the
  // shell; the arguments are fixed literals, which exec() asserts before joining them.
  const command = useLockfile ? 'ci' : 'install';
  const args = [command, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
  const windows = process.platform === 'win32';

  const result = await _exec(windows ? 'npm.cmd' : 'npm', args, {
    cwd: dir,
    timeoutMs,
    env: scrubbedEnv(),
    ...(windows ? { shell: true } : {}),
  });

  const durationMs = Date.now() - startTime;

  if (result.timedOut) {
    return {
      status: 'failed',
      detail: `npm install timed out after ${timeoutMs} ms`,
      durationMs,
    };
  }

  if (result.code === 0) {
    return {
      status: 'passed',
      detail: 'npm install passed',
      durationMs,
    };
  }

  return {
    status: 'failed',
    detail: trimOutput(result.stderr, 2000),
    durationMs,
  };
}

/**
 * In `dir`: no tsconfig.json -> skipped 'no tsconfig.json in <dir>'. If opts.install (default true)
 * run installDependencies first; if that failed, return failed with its detail. Resolve tsc as
 * path.join(dir, 'node_modules', '.bin', 'tsc') (on win32 tsc.cmd); if missing -> skipped
 * 'typescript is not installed in the repository'. Run `tsc -p tsconfig.json --noEmit --pretty false`
 * with scrubbedEnv(). passed on exit 0 with detail 'tsc --noEmit passed'; failed with the trimmed
 * stdout (tsc prints errors to stdout) otherwise; timeout -> failed.
 */
export async function typecheck(
  dir: string,
  opts?: { timeoutMs?: number; install?: boolean },
): Promise<CodeFixCheck> {
  const startTime = Date.now();
  const timeoutMs = opts?.timeoutMs ?? TYPECHECK_TIMEOUT_MS;
  const shouldInstall = opts?.install !== false;

  // Check if tsconfig.json exists
  try {
    await fs.stat(path.join(dir, 'tsconfig.json'));
  } catch {
    const durationMs = Date.now() - startTime;
    return {
      id: 'typecheck',
      status: 'skipped',
      detail: `no tsconfig.json in ${dir}`,
      durationMs,
    };
  }

  // Install dependencies if requested
  if (shouldInstall) {
    const installResult = await installDependencies(dir, { timeoutMs });
    if (installResult.status === 'failed') {
      const totalDurationMs = Date.now() - startTime;
      return {
        id: 'typecheck',
        status: 'failed',
        detail: installResult.detail,
        durationMs: totalDurationMs,
      };
    }
  }

  // Check if tsc exists
  const windows = process.platform === 'win32';
  const tscBinary = windows ? 'tsc.cmd' : 'tsc';
  const tscPath = path.join(dir, 'node_modules', '.bin', tscBinary);

  try {
    await fs.stat(tscPath);
  } catch {
    const durationMs = Date.now() - startTime;
    return {
      id: 'typecheck',
      status: 'skipped',
      detail: 'typescript is not installed in the repository',
      durationMs,
    };
  }

  // Run tsc (the .cmd shim needs the shell on Windows, as npm does above)
  const result = await exec(tscPath, ['-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], {
    cwd: dir,
    timeoutMs,
    env: scrubbedEnv(),
    ...(windows ? { shell: true } : {}),
  });

  const durationMs = Date.now() - startTime;

  if (result.timedOut) {
    return {
      id: 'typecheck',
      status: 'failed',
      detail: `tsc timed out after ${timeoutMs} ms`,
      durationMs,
    };
  }

  if (result.code === 0) {
    return {
      id: 'typecheck',
      status: 'passed',
      detail: 'tsc --noEmit passed',
      durationMs,
    };
  }

  return {
    id: 'typecheck',
    status: 'failed',
    detail: trimOutput(result.stdout, 2000),
    durationMs,
  };
}
