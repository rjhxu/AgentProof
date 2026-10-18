import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config';

const MAX_FILES = 500;
const GIT_TIMEOUT_MS = 90_000;

export interface ConnectedRepository {
  id: string;
  url: string;
  fullName: string;
  defaultBranch: string;
  commitSha: string;
  connectedAt: string;
  files: string[];
  fileCount: number;
  truncated: boolean;
}

export class RepositoryConnectionError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'RepositoryConnectionError';
  }
}

/** Accept one GitHub repository, never a local path, alternate protocol, or credential URL. */
export function validateGitHubUrl(value: string): string {
  const invalid = () =>
    new RepositoryConnectionError(
      'Enter a GitHub repository URL such as https://github.com/owner/repo.',
    );
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalid();
  }
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]+)\/?$/.exec(url.pathname);
  if (!match) throw invalid();
  const owner = match[1]!;
  const name = match[2]!.replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..' || name.length > 100) throw invalid();
  return `https://github.com/${owner}/${name}`;
}

function repositoryDirectory(id: string): { root: string; directory: string } {
  if (!/^repo_[a-f0-9]{12}$/.test(id)) {
    throw new RepositoryConnectionError('Invalid repository connection ID.');
  }
  const root = path.resolve(config.dataDir, 'repositories');
  const directory = path.resolve(root, id);
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RepositoryConnectionError('Invalid repository connection path.');
  }
  return { root, directory };
}

function gitEnvironment(token: string | undefined): NodeJS.ProcessEnv {
  // Ignore inherited Git settings, including alternate config/working-directory overrides.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GIT_CONFIG_NOSYSTEM = '1';
  // Git for Windows accepts NUL, but not Node's \\.\nul device path.
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : os.devNull;
  if (token) {
    // Git reads this ephemeral config from the child environment. It never reaches argv,
    // the remote URL, disk, response metadata, or an error message.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function git(args: string[], root: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.interactive=never',
        '-c',
        'core.askPass=',
        '-c',
        `core.hooksPath=${path.join(root, '.disabled-hooks')}`,
        '-c',
        'init.templateDir=',
        '-c',
        'protocol.file.allow=never',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'http.followRedirects=false',
        ...args,
      ],
      { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // Git stderr and Node's error can contain authentication details. Never expose them.
        if (error)
          reject(new RepositoryConnectionError('Git could not read this repository.', 502));
        else resolve(stdout);
      },
    );
  });
}

/** Save a shallow, read-only source snapshot. Repository code, hooks, and submodules never run. */
export async function connectRepository(
  input: { url: string; token?: string },
  id: string,
): Promise<ConnectedRepository> {
  const url = validateGitHubUrl(input.url);
  const token = input.token?.trim() || undefined;
  if (token && !/^[a-zA-Z0-9_-]{1,512}$/.test(token)) {
    throw new RepositoryConnectionError('The access token contains invalid characters.');
  }
  const { root, directory } = repositoryDirectory(id);
  const env = gitEnvironment(token);
  let created = false;
  try {
    await fs.mkdir(root, { recursive: true });
    try {
      await fs.mkdir(directory);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RepositoryConnectionError('This repository connection already exists.', 409);
      }
      throw error;
    }
    // Bare clones cannot check out files or run repository-defined executable content.
    await git(
      [
        'clone',
        '--bare',
        '--depth',
        '1',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        url,
        directory,
      ],
      root,
      env,
    ).catch(() => {
      throw new RepositoryConnectionError(
        'Could not access the repository. Check the URL and, for a private repository, provide a token with Contents read access. Renamed repositories require their current URL.',
        502,
      );
    });
    // Authentication is only needed during the clone, not subsequent local Git reads.
    const localEnv = gitEnvironment(undefined);
    const branch = (
      await git(['--git-dir', directory, 'symbolic-ref', '--short', 'HEAD'], root, localEnv)
    ).trim();
    const commitSha = (
      await git(['--git-dir', directory, 'rev-parse', '--verify', 'HEAD'], root, localEnv).catch(
        () => {
          throw new RepositoryConnectionError(
            'The repository must contain at least one commit.',
            422,
          );
        },
      )
    ).trim();
    const tree = await git(
      ['--git-dir', directory, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'],
      root,
      localEnv,
    );
    const names = tree.split('\0').filter(Boolean);
    return {
      id,
      url,
      fullName: url.slice('https://github.com/'.length),
      defaultBranch: branch,
      commitSha,
      connectedAt: new Date().toISOString(),
      files: names.slice(0, MAX_FILES),
      fileCount: names.length,
      truncated: names.length > MAX_FILES,
    };
  } catch (error) {
    if (created) await removeRepository(id).catch(() => undefined);
    if (error instanceof RepositoryConnectionError) throw error;
    throw new RepositoryConnectionError('Could not save this repository connection.', 500);
  }
}

/** Delete only an app-owned repository directory; repeated disconnects are harmless. */
export async function removeRepository(id: string): Promise<void> {
  const { directory } = repositoryDirectory(id);
  try {
    const entry = await fs.lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new RepositoryConnectionError(
        'Repository connection path is not a safe directory.',
        409,
      );
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    // The code-fix agent's worktree, when one was left behind (see createWorktree).
    await fs.rm(worktreeDirectory(id), { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof RepositoryConnectionError) throw error;
    throw new RepositoryConnectionError('Could not remove the repository snapshot.', 500);
  }
}

// ---- code-fix agent helpers (docs/CODEFIX.md) ------------------------------------------------
// Everything below reuses the hardened git wrapper above: hooks disabled, credential helpers off,
// alternate protocols refused, tokens only in the child environment, stderr never surfaced.

/** Worktree directory for a snapshot: a sibling of the bare clone, never inside it. */
function worktreeDirectory(id: string): string {
  return `${repositoryDirectory(id).directory}.work`;
}

const SNAPSHOT_PATH = /^[A-Za-z0-9][A-Za-z0-9._@+-]*(\/[A-Za-z0-9._@+-]+)*$/;

/** True for a repository-relative POSIX path with no '..' segment, no leading '/' or '-'. */
export function isSafeSnapshotPath(filePath: string): boolean {
  return (
    SNAPSHOT_PATH.test(filePath) &&
    filePath.length <= 512 &&
    !filePath.split('/').some((segment) => segment === '..' || segment === '.')
  );
}

/** A file's content at the snapshot commit, read from the bare clone; undefined when absent. */
export async function readSnapshotFile(id: string, filePath: string): Promise<string | undefined> {
  if (!isSafeSnapshotPath(filePath)) return undefined;
  const { root, directory } = repositoryDirectory(id);
  try {
    // Regular files only: a symlink's blob is its target path and a submodule is another repo.
    const entry = await git(
      ['--git-dir', directory, 'ls-tree', 'HEAD', '--', filePath],
      root,
      gitEnvironment(undefined),
    );
    if (!/^100(644|755) blob /.test(entry)) return undefined;
    return await git(
      ['--git-dir', directory, 'show', `HEAD:${filePath}`],
      root,
      gitEnvironment(undefined),
    );
  } catch {
    return undefined;
  }
}

/**
 * A detached worktree at the snapshot commit, for `git apply --check`, typechecking and the
 * rematch store. Repository code does not run by creating it. Replaces any previous worktree.
 */
export async function createWorktree(id: string): Promise<string> {
  const { root, directory } = repositoryDirectory(id);
  const work = worktreeDirectory(id);
  await removeWorktree(id);
  await git(
    ['--git-dir', directory, 'worktree', 'add', '--detach', work, 'HEAD'],
    root,
    gitEnvironment(undefined),
  ).catch(() => {
    throw new RepositoryConnectionError('Could not create a worktree for this snapshot.', 500);
  });
  return work;
}

export async function removeWorktree(id: string): Promise<void> {
  const { root, directory } = repositoryDirectory(id);
  const work = worktreeDirectory(id);
  const env = gitEnvironment(undefined);
  await git(['--git-dir', directory, 'worktree', 'remove', '--force', work], root, env).catch(
    () => undefined,
  );
  await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await git(['--git-dir', directory, 'worktree', 'prune'], root, env).catch(() => undefined);
}

/** Branches the code-fix agent may create. Never the default branch, never anything else. */
export const AGENTPROOF_BRANCH = /^agentproof\/[a-z0-9][a-z0-9._-]{0,60}$/;

export interface CommitAndPushInput {
  id: string;
  worktree: string;
  branch: string;
  /** Repository-relative paths to stage; nothing else in the worktree is committed */
  files: string[];
  message: string;
  /** Fine-grained token with Contents write, memory-only for this call */
  token?: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Commit every change in the worktree on a new `agentproof/*` branch and push that branch, and
 * only that branch, to origin. No force, no tags, no default branch. The token reaches git only
 * through the environment and only for the push.
 */
export async function commitAndPush(input: CommitAndPushInput): Promise<{ commitSha: string }> {
  if (!AGENTPROOF_BRANCH.test(input.branch)) {
    throw new RepositoryConnectionError(
      'Refusing to push: branch names must match agentproof/<slug>.',
      400,
    );
  }
  const token = input.token?.trim() || undefined;
  if (token && !/^[a-zA-Z0-9_-]{1,512}$/.test(token)) {
    throw new RepositoryConnectionError('The access token contains invalid characters.');
  }
  const { root } = repositoryDirectory(input.id);
  const work = worktreeDirectory(input.id);
  if (path.resolve(input.worktree) !== work) {
    throw new RepositoryConnectionError(
      'Refusing to push from a directory that is not the snapshot worktree.',
      400,
    );
  }
  const local = gitEnvironment(undefined);
  const name = input.authorName ?? 'AgentProof';
  const email = input.authorEmail ?? 'bot@agentproof.local';
  const fail = (message: string) => () => {
    throw new RepositoryConnectionError(message, 502);
  };
  await git(['-C', work, 'checkout', '-q', '-b', input.branch], root, local).catch(
    fail('Could not create the fix branch in the worktree.'),
  );
  if (input.files.length === 0 || !input.files.every(isSafeSnapshotPath)) {
    throw new RepositoryConnectionError('Refusing to commit: no files, or an unsafe path.', 400);
  }
  await git(['-C', work, 'add', '-A', '--', ...input.files], root, local).catch(
    fail('Could not stage the fix.'),
  );
  await git(
    [
      '-C',
      work,
      '-c',
      `user.name=${name}`,
      '-c',
      `user.email=${email}`,
      'commit',
      '-q',
      '--no-verify',
      '-m',
      input.message,
    ],
    root,
    local,
  ).catch(fail('Could not commit the fix (is the diff empty?).'));
  const commitSha = (await git(['-C', work, 'rev-parse', '--verify', 'HEAD'], root, local)).trim();
  await git(
    ['-C', work, 'push', '-q', '--no-tags', 'origin', `HEAD:refs/heads/${input.branch}`],
    root,
    gitEnvironment(token),
  ).catch(
    fail(
      'Could not push the fix branch. The token needs Contents write access to this repository.',
    ),
  );
  return { commitSha };
}
