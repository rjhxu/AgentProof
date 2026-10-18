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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof RepositoryConnectionError) throw error;
    throw new RepositoryConnectionError('Could not remove the repository snapshot.', 500);
  }
}
