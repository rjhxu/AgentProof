import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import {
  connectRepository,
  removeRepository,
  RepositoryConnectionError,
  validateGitHubUrl,
} from './repositories';

const { gitMock } = vi.hoisted(() => ({ gitMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: gitMock };
});
const actualGit = await vi.importActual<typeof import('node:child_process')>('node:child_process');

type GitCallback = (error: Error | null, stdout: string, stderr: string) => void;
type GitOptions = {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
};
const originalDataDir = config.dataDir;
let directory: string;
const sha = 'a'.repeat(40);
const token = 'github_pat_test_secret';

function mockGit(files = ['README.md', 'src/cart.ts']) {
  gitMock.mockImplementation(
    (_command: string, args: string[], _options: GitOptions, callback: GitCallback) => {
      let stdout = '';
      if (args.includes('symbolic-ref')) stdout = 'main\n';
      if (args.includes('rev-parse')) stdout = `${sha}\n`;
      if (args.includes('ls-tree')) stdout = files.join('\0') + '\0';
      callback(null, stdout, '');
    },
  );
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-repositories-'));
  config.dataDir = directory;
  gitMock.mockReset();
  mockGit();
});

afterEach(() => {
  config.dataDir = originalDataDir;
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('GitHub repository connections', () => {
  it('normalizes GitHub links and rejects alternate hosts, protocols, credentials, and paths', () => {
    expect(validateGitHubUrl(' https://github.com/Example/shop.git/ ')).toBe(
      'https://github.com/Example/shop',
    );
    for (const url of [
      'git@github.com:owner/repo.git',
      'http://github.com/owner/repo',
      'https://github.com.evil.test/owner/repo',
      'https://user:secret@github.com/owner/repo',
      'https://github.com:8443/owner/repo',
      'https://github.com/owner/repo/tree/main',
      'https://github.com/owner/repo?token=secret',
      'https://github.com/owner/repo#main',
      'file:///tmp/repo',
      '--upload-pack=command',
    ]) {
      expect(() => validateGitHubUrl(url)).toThrow(RepositoryConnectionError);
    }
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('returns a bounded file inventory and keeps the token out of argv and metadata', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'unsafe-inherited-helper');
    mockGit(Array.from({ length: 503 }, (_, index) => `src/file-${index}.ts`));
    const repository = await connectRepository(
      { url: 'https://github.com/owner/shop.git', token },
      'repo_000000000001',
    );
    expect(repository).toMatchObject({
      id: 'repo_000000000001',
      url: 'https://github.com/owner/shop',
      fullName: 'owner/shop',
      defaultBranch: 'main',
      commitSha: sha,
      fileCount: 503,
      truncated: true,
    });
    expect(repository.files).toHaveLength(500);
    expect(JSON.stringify(repository)).not.toContain(token);
    const clone = gitMock.mock.calls[0]!;
    expect(clone[0]).toBe('git');
    expect(clone[1]).toEqual(
      expect.arrayContaining(['clone', '--bare', '--depth', '1', '--no-recurse-submodules']),
    );
    expect(JSON.stringify(clone[1])).not.toContain(token);
    expect(clone[2].env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
    for (const call of gitMock.mock.calls.slice(1)) {
      expect(call[2].env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(call[2].env.GIT_CONFIG_VALUE_0).toBeUndefined();
    }
    expect(process.env.GIT_CONFIG_VALUE_0).toBe('unsafe-inherited-helper');
  });

  it('removes failed snapshots and never exposes raw Git errors or a secret', async () => {
    gitMock.mockImplementation(
      (_command: string, _args: string[], _options: GitOptions, callback: GitCallback) => {
        callback(new Error(`fatal: remote rejected ${token}`), '', `debug ${token}`);
      },
    );
    let failure: unknown;
    try {
      await connectRepository(
        { url: 'https://github.com/owner/private', token },
        'repo_000000000002',
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RepositoryConnectionError);
    expect((failure as RepositoryConnectionError).statusCode).toBe(502);
    expect((failure as Error).message).toContain('Contents read access');
    expect((failure as Error).message).not.toContain(token);
    expect(fs.existsSync(path.join(directory, 'repositories', 'repo_000000000002'))).toBe(false);
  });

  it('refuses unsafe IDs and header injection before starting Git', async () => {
    await expect(
      connectRepository({ url: 'https://github.com/owner/shop' }, '../outside'),
    ).rejects.toThrow('Invalid repository');
    await expect(
      connectRepository(
        { url: 'https://github.com/owner/shop', token: 'secret\r\nX-Header: value' },
        'repo_000000000003',
      ),
    ).rejects.toThrow('invalid characters');
    await expect(removeRepository('../outside')).rejects.toThrow('Invalid repository');
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('preserves an existing connection and deletes only its own snapshot on disconnect', async () => {
    const target = path.join(directory, 'repositories', 'repo_000000000004');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'existing snapshot');
    await expect(
      connectRepository({ url: 'https://github.com/owner/shop' }, 'repo_000000000004'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('existing snapshot');
    expect(gitMock).not.toHaveBeenCalled();
    await removeRepository('repo_000000000004');
    expect(fs.existsSync(target)).toBe(false);
    await expect(removeRepository('repo_000000000004')).resolves.toBeUndefined();
  });

  it('uses real Git to clone a source snapshot without checking out or saving credentials', async () => {
    const source = path.join(directory, 'fixture');
    fs.mkdirSync(source);
    actualGit.execFileSync('git', [
      '-c',
      'init.templateDir=',
      'init',
      '--initial-branch=main',
      source,
    ]);
    fs.writeFileSync(path.join(source, 'README.md'), '# Fixture\n');
    fs.writeFileSync(path.join(source, 'package.json'), '{"scripts":{"postinstall":"exit 42"}}\n');
    actualGit.execFileSync('git', ['-C', source, '-c', 'core.autocrlf=false', 'add', '.']);
    actualGit.execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Repository Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=' + path.join(directory, 'no-hooks'),
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Fixture',
    ]);
    // Redirect only the transport to a temporary local fixture, preserving all other options.
    let fixtureDiagnostic = '';
    gitMock.mockImplementation(
      (command: string, args: string[], options: GitOptions, callback: GitCallback) => {
        let localArgs = args;
        if (args.includes('clone')) {
          const index = args.indexOf('clone');
          localArgs = [
            ...args.slice(0, index),
            '-c',
            'protocol.file.allow=always',
            ...args
              .slice(index)
              .map((arg) =>
                arg === 'https://github.com/owner/fixture' ? pathToFileURL(source).href : arg,
              ),
          ];
        }
        return actualGit.execFile(command, localArgs, options, (error, stdout, stderr) => {
          fixtureDiagnostic = stderr.replaceAll(token, '[redacted]');
          callback(error, stdout, stderr);
        });
      },
    );
    const result = await connectRepository(
      { url: 'https://github.com/owner/fixture', token },
      'repo_000000000005',
    ).catch((error: Error) => {
      throw new Error(`${error.message}: ${fixtureDiagnostic}`);
    });
    expect(result.files).toEqual(['README.md', 'package.json']);
    expect(result.defaultBranch).toBe('main');
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    const snapshot = path.join(directory, 'repositories', 'repo_000000000005');
    expect(fs.existsSync(path.join(snapshot, 'README.md'))).toBe(false);
    expect(fs.readFileSync(path.join(snapshot, 'config'), 'utf8')).not.toContain(token);
    expect(fs.readFileSync(path.join(snapshot, 'config'), 'utf8')).not.toContain('extraheader');
    expect(
      actualGit.execFileSync(
        'git',
        ['--git-dir', snapshot, 'show', `${result.commitSha}:README.md`],
        {
          encoding: 'utf8',
        },
      ),
    ).toBe('# Fixture\n');
    await removeRepository('repo_000000000005');
  });
});
