import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseRepoFullName,
  GitHubClient,
  GitHubOperationRefused,
  GitHubRequestError,
  isAllowedOperation,
  agentproofBranchName,
  isAgentproofBranch,
  compareUrl,
  clampPullRequestBody,
  COMPARE_BODY_MAX_CHARS,
  PR_BODY_MAX_CHARS,
  BRANCH_PATTERN,
} from './github';

describe('parseRepoFullName', () => {
  it('accepts owner/repo format', () => {
    const result = parseRepoFullName('owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('accepts https://github.com/owner/repo', () => {
    const result = parseRepoFullName('https://github.com/owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('accepts https://github.com/owner/repo.git', () => {
    const result = parseRepoFullName('https://github.com/owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('accepts https://github.com/owner/repo/ (trailing slash)', () => {
    const result = parseRepoFullName('https://github.com/owner/repo/');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('rejects https://gitlab.com/owner/repo', () => {
    expect(() => parseRepoFullName('https://gitlab.com/owner/repo')).toThrow(
      'Not a GitHub repository',
    );
  });

  it('rejects plain owner without repo', () => {
    expect(() => parseRepoFullName('owner')).toThrow('Not a GitHub repository');
  });

  it('rejects owner/repo/extra', () => {
    expect(() => parseRepoFullName('owner/repo/extra')).toThrow('Not a GitHub repository');
  });

  it('rejects git@github.com:owner/repo.git', () => {
    expect(() => parseRepoFullName('git@github.com:owner/repo.git')).toThrow(
      'Not a GitHub repository',
    );
  });
});

describe('isAllowedOperation', () => {
  it('allows GET /repos/o/r', () => {
    expect(isAllowedOperation('GET', '/repos/o/r')).toBe(true);
  });

  it('allows POST /repos/o/r/pulls', () => {
    expect(isAllowedOperation('POST', '/repos/o/r/pulls')).toBe(true);
  });

  it('allows GET /repos/o/r/installation', () => {
    expect(isAllowedOperation('GET', '/repos/o/r/installation')).toBe(true);
  });

  it('allows POST /app/installations/123/access_tokens', () => {
    expect(isAllowedOperation('POST', '/app/installations/123/access_tokens')).toBe(true);
  });

  it('rejects PUT /repos/o/r/pulls/1/merge', () => {
    expect(isAllowedOperation('PUT', '/repos/o/r/pulls/1/merge')).toBe(false);
  });

  it('rejects PATCH /repos/o/r/pulls/1', () => {
    expect(isAllowedOperation('PATCH', '/repos/o/r/pulls/1')).toBe(false);
  });

  it('rejects POST /repos/o/r/pulls/1/reviews', () => {
    expect(isAllowedOperation('POST', '/repos/o/r/pulls/1/reviews')).toBe(false);
  });

  it('rejects DELETE /repos/o/r/git/refs/heads/x', () => {
    expect(isAllowedOperation('DELETE', '/repos/o/r/git/refs/heads/x')).toBe(false);
  });

  it('rejects POST /repos/o/r/merges', () => {
    expect(isAllowedOperation('POST', '/repos/o/r/merges')).toBe(false);
  });

  it('rejects PUT /repos/o/r/contents/a.ts', () => {
    expect(isAllowedOperation('PUT', '/repos/o/r/contents/a.ts')).toBe(false);
  });

  it('rejects GET /repos/o/r/pulls (list)', () => {
    expect(isAllowedOperation('GET', '/repos/o/r/pulls')).toBe(false);
  });

  it('rejects POST /repos/o/r/pulls?x=1 (query string)', () => {
    expect(isAllowedOperation('POST', '/repos/o/r/pulls?x=1')).toBe(false);
  });
});

describe('GitHubClient.request', () => {
  let mockFetch: ReturnType<typeof vi.fn> & typeof fetch;

  beforeEach(() => {
    mockFetch = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
  });

  it('refuses PUT operations', async () => {
    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    await expect(client.request('PUT' as any, '/repos/o/r/pulls/1/merge')).rejects.toBeInstanceOf(
      GitHubOperationRefused,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses paths with ..', async () => {
    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    await expect(client.request('GET', '/repos/../o/r')).rejects.toBeInstanceOf(
      GitHubOperationRefused,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses paths with query strings', async () => {
    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    await expect(client.request('POST', '/repos/o/r/pulls?x=1')).rejects.toBeInstanceOf(
      GitHubOperationRefused,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends correct headers for allowed operation', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ default_branch: 'main' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    await client.request('GET', '/repos/o/r');

    expect(mockFetch).toHaveBeenCalledWith('https://api.github.com/repos/o/r', {
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer tok_123',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AgentProof',
      }),
    });
  });
});

describe('GitHubClient.createDraftPullRequest', () => {
  let mockFetch: ReturnType<typeof vi.fn> & typeof fetch;

  beforeEach(() => {
    mockFetch = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
  });

  it('sends POST with draft=true and maintainer_can_modify=true', async () => {
    const response = {
      number: 7,
      html_url: 'https://github.com/o/r/pull/7',
      draft: true,
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    const result = await client.createDraftPullRequest(
      { owner: 'o', repo: 'r', fullName: 'o/r' },
      {
        head: 'agentproof/fix-1',
        base: 'main',
        title: 'Fix bug',
        body: 'This fixes the bug',
      },
    );

    expect(result).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      draft: true,
    });

    const call = (mockFetch as any).mock.calls[0];
    const [_url, opts] = call as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.draft).toBe(true);
    expect(body.maintainer_can_modify).toBe(true);
  });
});

describe('GitHubClient.getRepository', () => {
  let mockFetch: ReturnType<typeof vi.fn> & typeof fetch;

  beforeEach(() => {
    mockFetch = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
  });

  it('maps response fields correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/o/r',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    const result = await client.getRepository({ owner: 'o', repo: 'r', fullName: 'o/r' });

    expect(result).toEqual({
      defaultBranch: 'main',
      private: false,
      htmlUrl: 'https://github.com/o/r',
    });
  });
});

describe('GitHubRequestError', () => {
  let mockFetch: ReturnType<typeof vi.fn> & typeof fetch;

  beforeEach(() => {
    mockFetch = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
  });

  it('extracts message from JSON response and never includes token', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Validation Failed' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new GitHubClient({ token: 'tok_123', fetch: mockFetch });
    try {
      await client.request('GET', '/repos/o/r');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRequestError);
      if (err instanceof GitHubRequestError) {
        expect(err.status).toBe(422);
        expect(err.message).toContain('Validation Failed');
        expect(err.message).not.toContain('tok_123');
      }
    }
  });
});

describe('agentproofBranchName', () => {
  it('formats slug and id8 correctly', () => {
    const branch = agentproofBranchName('Fix: Size picker (Bug A)!', 'fix_0123456789ab');
    expect(branch).toBe('agentproof/fix-size-picker-bug-a-01234567');
  });

  it('cuts long slugs to 40 chars', () => {
    const longSlug = 'a'.repeat(100);
    const branch = agentproofBranchName(longSlug, 'fix_00000000');
    expect(branch).toMatch(BRANCH_PATTERN);
    // Extract the slug part
    const slug = branch.split('/')[1]!.split('-').slice(0, -1).join('-');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('throws for invalid result', () => {
    // Create a slug that would result in an invalid branch name
    // The empty slug should fail
    const empty = '';
    expect(() => agentproofBranchName(empty, 'fix_00000000')).toThrow('Invalid branch name');
  });
});

describe('isAgentproofBranch', () => {
  it('accepts valid agentproof branches', () => {
    expect(isAgentproofBranch('agentproof/fix-size-picker-bug-a-01234567')).toBe(true);
    expect(isAgentproofBranch('agentproof/a-00000000')).toBe(true);
    expect(isAgentproofBranch('agentproof/fix_name-01234567')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isAgentproofBranch('main')).toBe(false);
    expect(isAgentproofBranch('agentproof')).toBe(false);
    expect(isAgentproofBranch('agentproof/')).toBe(false);
    expect(isAgentproofBranch('agentproof/Has Upper')).toBe(false);
    expect(isAgentproofBranch('feature/agentproof/x')).toBe(false);
  });
});

describe('compareUrl', () => {
  it('encodes title and body and truncates long body', () => {
    const shortBody = 'This is the body';
    const url = compareUrl(
      { owner: 'o', repo: 'r', fullName: 'o/r' },
      {
        base: 'main',
        head: 'agentproof/fix-1',
        title: 'Fix bug',
        body: shortBody,
      },
    );

    expect(url).toContain('https://github.com/o/r/compare/main...agentproof/fix-1');
    expect(url).toContain('title=Fix+bug');
    expect(url).toContain('This+is+the+body');
  });

  it('truncates long body to COMPARE_BODY_MAX_CHARS', () => {
    const longBody = 'x'.repeat(10000);
    const url = compareUrl(
      { owner: 'o', repo: 'r', fullName: 'o/r' },
      {
        base: 'main',
        head: 'agentproof/fix-1',
        title: 'Fix',
        body: longBody,
      },
    );

    // Extract the body param
    const bodyMatch = url.match(/body=([^&]+)/);
    expect(bodyMatch).toBeTruthy();
    if (bodyMatch && bodyMatch[1]) {
      const bodyParam = decodeURIComponent(bodyMatch[1]).replace(/\+/g, ' ');
      expect(bodyParam).toContain('[truncated; the full report is attached to the AgentProof run]');
      // The truncated body should not exceed the limit plus the note (plus newlines)
      const truncationNote = '[truncated; the full report is attached to the AgentProof run]';
      expect(bodyParam.length).toBe(COMPARE_BODY_MAX_CHARS + 2 + truncationNote.length);
    }
  });
});

describe('clampPullRequestBody', () => {
  it('leaves short bodies alone', () => {
    const body = 'This is a short body';
    expect(clampPullRequestBody(body)).toBe(body);
  });

  it('cuts long bodies with truncation note', () => {
    const longBody = 'x'.repeat(65000);
    const result = clampPullRequestBody(longBody);

    expect(result).toContain('[truncated; the full report is attached to the AgentProof run]');
    // PR_BODY_MAX_CHARS + '\n\n' (2) + note (62) = 60064
    const truncationNote = '[truncated; the full report is attached to the AgentProof run]';
    expect(result.length).toBe(PR_BODY_MAX_CHARS + 2 + truncationNote.length);
  });
});
