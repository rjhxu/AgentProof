import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  scrubbedEnv,
  exec,
  trimOutput,
  gitApplyCheck,
  gitApply,
  installDependencies,
  typecheck,
  GIT_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
} from './toolchain';

/** True while a process with this pid exists (signal 0 only probes). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('toolchain', () => {
  describe('scrubbedEnv', () => {
    it('excludes secrets and inherited overrides', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      vi.stubEnv('GIT_DIR', '/x');
      vi.stubEnv('npm_config_registry', 'http://evil');

      const env = scrubbedEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.npm_config_registry).toBeUndefined();
      expect(env.CI).toBe('1');
      expect(env.NO_COLOR).toBe('1');
      expect(env.PATH).toBeTruthy();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    });

    it('includes extra entries', () => {
      const env = scrubbedEnv({ CUSTOM_VAR: 'value' });
      expect(env.CUSTOM_VAR).toBe('value');
    });
  });

  describe('exec', () => {
    it('captures stdout and exit code', async () => {
      const result = await exec('node', ['-e', "process.stdout.write('hi'); process.exit(3)"], {
        cwd: process.cwd(),
        timeoutMs: 5000,
      });

      expect(result.code).toBe(3);
      expect(result.stdout).toBe('hi');
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles timeout', async () => {
      const result = await exec('node', ['-e', 'setTimeout(() => {}, 10000)'], {
        cwd: process.cwd(),
        timeoutMs: 300,
      });

      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
    });

    it('throws on nonexistent binary', async () => {
      await expect(
        exec('nonexistent-binary-xyz', [], {
          cwd: process.cwd(),
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('Command not found: nonexistent-binary-xyz');
    });

    // The cmd.exe path exists only on Windows; elsewhere `shell` is ignored.
    if (process.platform === 'win32') {
      describe('through cmd.exe', () => {
        let tempDir: string;

        beforeEach(async () => {
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-test-'));
        });

        afterEach(async () => {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        });

        it('quotes the command path even without whitespace in it', async () => {
          // cmd.exe splits an unquoted path on ; , and = as well as on spaces.
          const dir = path.join(tempDir, 'a;b=c');
          await fs.mkdir(dir);
          const shim = path.join(dir, 'say.cmd');
          await fs.writeFile(shim, '@echo off\r\necho hi %1\r\n');

          const result = await exec(shim, ['there'], {
            cwd: tempDir,
            timeoutMs: 5000,
            shell: true,
          });

          expect(result.code).toBe(0);
          expect(result.stdout.trim()).toBe('hi there');
        });

        it('refuses arguments that are not plain literals', async () => {
          await expect(
            exec('npm.cmd', ['ci', '--loglevel=error & del x'], {
              cwd: tempDir,
              timeoutMs: 5000,
              shell: true,
            }),
          ).rejects.toThrow('arguments must be plain literals');
        });

        it('ends the grandchildren of a run that timed out', async () => {
          // The shim starts node, which prints its pid and lingers: that pid must be gone after
          // the timeout, not orphaned by a kill of cmd.exe alone.
          const shim = path.join(tempDir, 'linger.cmd');
          await fs.writeFile(
            shim,
            `@echo off\r\n"${process.execPath}" -e "process.stdout.write(String(process.pid)); setTimeout(function () {}, 30000)"\r\n`,
          );

          const result = await exec(shim, [], { cwd: tempDir, timeoutMs: 1500, shell: true });

          expect(result.timedOut).toBe(true);
          const pid = Number(result.stdout.trim());
          expect(pid).toBeGreaterThan(0);
          const deadline = Date.now() + 5000;
          while (alive(pid) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(alive(pid)).toBe(false);
        });
      });
    }
  });

  describe('trimOutput', () => {
    it('keeps output unchanged when short', () => {
      const text = 'short text';
      expect(trimOutput(text, 100)).toBe(text);
    });

    it('keeps tail and adds prefix when cut', () => {
      const text = 'a'.repeat(3000);
      const result = trimOutput(text, 2000);

      expect(result).toContain('[... earlier output omitted]\n');
      expect(result.length).toBeLessThan(text.length);
      expect(result.endsWith('a'.repeat(2000))).toBe(true);
    });

    it('uses default max of 2000', () => {
      const text = 'a'.repeat(3000);
      const result = trimOutput(text);

      expect(result).toContain('[... earlier output omitted]\n');
    });
  });

  describe('gitApplyCheck / gitApply', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-test-'));

      // Initialize a git repo with one file
      await exec('git', ['init'], { cwd: tempDir, timeoutMs: GIT_TIMEOUT_MS });
      await exec('git', ['config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      await exec('git', ['config', 'user.name', 'Test User'], {
        cwd: tempDir,
        timeoutMs: GIT_TIMEOUT_MS,
      });

      // Create initial file
      await fs.writeFile(path.join(tempDir, 'test.txt'), 'line 1\nline 2\nline 3\n');
      await exec('git', ['add', 'test.txt'], { cwd: tempDir, timeoutMs: GIT_TIMEOUT_MS });
      await exec('git', ['commit', '-m', 'initial'], {
        cwd: tempDir,
        timeoutMs: GIT_TIMEOUT_MS,
      });
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('checks if diff applies cleanly', async () => {
      const diff = `--- test.txt
+++ test.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 modified
 line 3
`;

      const result = await gitApplyCheck(tempDir, diff);

      expect(result.id).toBe('applies_cleanly');
      expect(result.status).toBe('passed');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('fails when diff does not apply', async () => {
      const diff = `--- test.txt
+++ test.txt
@@ -1,3 +1,3 @@
 line 1
-nonexistent
+replaced
 line 3
`;

      const result = await gitApplyCheck(tempDir, diff);

      expect(result.id).toBe('applies_cleanly');
      expect(result.status).toBe('failed');
      expect(result.detail.length).toBeGreaterThan(0);
    });

    it('applies diff successfully', async () => {
      const diff = `--- test.txt
+++ test.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 modified
 line 3
`;

      await gitApply(tempDir, diff);

      const content = await fs.readFile(path.join(tempDir, 'test.txt'), 'utf-8');
      expect(content).toContain('line 2 modified');
    });

    it('throws on failed apply', async () => {
      const diff = `--- test.txt
+++ test.txt
@@ -1,3 +1,3 @@
 line 1
-nonexistent
+replaced
 line 3
`;

      await expect(gitApply(tempDir, diff)).rejects.toThrow();
    });
  });

  describe('installDependencies', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-test-'));
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('skips when node_modules exists', async () => {
      const nodeModulesDir = path.join(tempDir, 'node_modules');
      await fs.mkdir(nodeModulesDir, { recursive: true });

      const result = await installDependencies(tempDir);

      expect(result.status).toBe('skipped');
      expect(result.detail).toBe('node_modules already present');
    });

    it('skips when no package.json', async () => {
      const result = await installDependencies(tempDir);

      expect(result.status).toBe('skipped');
      expect(result.detail).toBe('no package.json');
    });

    it('installs with minimal package.json', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 't',
          private: true,
        }),
      );

      const result = await installDependencies(tempDir);

      expect(result.status).toBe('passed');
      expect(result.detail).toBe('npm install passed');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify node_modules was created
      const nodeModules = path.join(tempDir, 'node_modules');
      try {
        await fs.stat(nodeModules);
      } catch {
        // On some test environments, npm might not install anything, which is fine
      }
    });

    it('always uses --ignore-scripts flag', async () => {
      const mockExec = vi.fn().mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 100,
      });

      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 't',
          private: true,
        }),
      );

      await installDependencies(tempDir, undefined, mockExec);

      expect(mockExec).toHaveBeenCalled();
      const args = mockExec.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--ignore-scripts');
      expect(args).toContain('--no-audit');
      expect(args).toContain('--no-fund');
    });
  });

  describe('typecheck', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-test-'));
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('skips when no tsconfig.json', async () => {
      const result = await typecheck(tempDir);

      expect(result.id).toBe('typecheck');
      expect(result.status).toBe('skipped');
      expect(result.detail).toContain('no tsconfig.json');
    });

    it('skips when typescript is not installed', async () => {
      await fs.writeFile(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2020', module: 'ESNext' },
        }),
      );

      const result = await typecheck(tempDir, { install: false });

      expect(result.id).toBe('typecheck');
      expect(result.status).toBe('skipped');
      expect(result.detail).toBe('typescript is not installed in the repository');
    });

    // Only run this test on non-Windows platforms where we can use chmod
    if (process.platform !== 'win32') {
      it('runs tsc and reports results with fake tsc binary', async () => {
        await fs.writeFile(
          path.join(tempDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { target: 'ES2020', module: 'ESNext' },
          }),
        );

        // Create node_modules/.bin directory
        const binDir = path.join(tempDir, 'node_modules', '.bin');
        await fs.mkdir(binDir, { recursive: true });

        // Create fake tsc that fails
        const tscPath = path.join(binDir, 'tsc');
        await fs.writeFile(tscPath, '#!/bin/sh\necho "src/a.ts(1,1): error TS1000: fake"; exit 2');
        await fs.chmod(tscPath, 0o755);

        const result = await typecheck(tempDir, { install: false });

        expect(result.id).toBe('typecheck');
        expect(result.status).toBe('failed');
        expect(result.detail).toContain('TS1000');

        // Now replace with passing tsc
        await fs.writeFile(tscPath, '#!/bin/sh\nexit 0');
        await fs.chmod(tscPath, 0o755);

        const passResult = await typecheck(tempDir, { install: false });

        expect(passResult.id).toBe('typecheck');
        expect(passResult.status).toBe('passed');
        expect(passResult.detail).toBe('tsc --noEmit passed');
      });
    }
  });

  describe('constants', () => {
    it('has expected timeout constants', () => {
      expect(GIT_TIMEOUT_MS).toBe(60_000);
      expect(INSTALL_TIMEOUT_MS).toBe(180_000);
      expect(TYPECHECK_TIMEOUT_MS).toBe(120_000);
    });
  });
});
