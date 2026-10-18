/**
 * GitHub REST client with an operation allowlist.
 * The client can only: read repository metadata, open draft pull requests,
 * and (for GitHub App auth) find installations, list them and their repositories,
 * and mint tokens.
 * A merge operation cannot be expressed; tests assert it.
 */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  fullName: string; // 'owner/repo'
}

/**
 * Parse 'owner/repo' or a GitHub repository URL.
 * Throws Error('Not a GitHub repository: <input>') if invalid.
 */
export function parseRepoFullName(urlOrFullName: string): GitHubRepoRef {
  const trimmed = urlOrFullName.trim();

  // Reject git@ format early
  if (trimmed.startsWith('git@')) {
    throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
  }

  // Try to parse as URL first
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== 'github.com') {
        throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
      }
      if (!url.protocol.startsWith('http')) {
        throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
      }

      // Remove trailing slash and .git
      let pathname = url.pathname.replace(/\/$/, '');
      if (pathname.endsWith('.git')) {
        pathname = pathname.slice(0, -4);
      }

      const parts = pathname.split('/').filter((p) => p.length > 0);
      if (parts.length !== 2) {
        throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
      }

      const owner = parts[0]!;
      const repo = parts[1]!;
      return {
        owner,
        repo,
        fullName: `${owner}/${repo}`,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Not a GitHub repository')) {
        throw err;
      }
      throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
    }
  }

  // Try to parse as 'owner/repo'
  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0) {
    return {
      owner: parts[0]!,
      repo: parts[1]!,
      fullName: trimmed,
    };
  }

  throw new Error(`Not a GitHub repository: ${urlOrFullName}`);
}

export class GitHubOperationRefused extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string) {
    super(`Operation refused: ${method} ${path}`);
    this.method = method;
    this.path = path;
    Object.setPrototypeOf(this, GitHubOperationRefused.prototype);
  }
}

export class GitHubRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, GitHubRequestError.prototype);
  }
}

export type GitHubMethod = 'GET' | 'POST';

export interface AllowedOperation {
  method: GitHubMethod;
  pattern: RegExp;
  purpose: string;
  /** May carry only `?per_page=<digits>&page=<digits>`. Every other query is refused. */
  paginated?: true;
}

/**
 * The complete list of operations this client can perform.
 */
export const ALLOWED_OPERATIONS: readonly AllowedOperation[] = [
  {
    method: 'GET',
    pattern: /^\/repos\/[^/]+\/[^/]+$/,
    purpose: 'read repository metadata (default branch)',
  },
  {
    method: 'POST',
    pattern: /^\/repos\/[^/]+\/[^/]+\/pulls$/,
    purpose: 'open a pull request (always draft)',
  },
  {
    method: 'GET',
    pattern: /^\/repos\/[^/]+\/[^/]+\/installation$/,
    purpose: 'GitHub App: find the installation for a repo',
  },
  {
    method: 'POST',
    pattern: /^\/app\/installations\/\d+\/access_tokens$/,
    purpose: 'GitHub App: mint a short-lived installation token',
  },
  {
    method: 'GET',
    pattern: /^\/app\/installations$/,
    purpose: 'GitHub App: list the installations of this app',
    paginated: true,
  },
  {
    method: 'GET',
    pattern: /^\/installation\/repositories$/,
    purpose: 'GitHub App: list the repositories one installation covers',
    paginated: true,
  },
];

/** The only query an allowlisted operation may carry, and only when it is marked paginated. */
const PAGE_QUERY = /^\?per_page=[0-9]+&page=[0-9]+$/;

export function isAllowedOperation(method: string, path: string): boolean {
  return ALLOWED_OPERATIONS.some((op) => op.method === method && op.pattern.test(path));
}

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  userAgent?: string;
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com';
    this.userAgent = opts.userAgent ?? 'AgentProof';
  }

  /**
   * Make an HTTP request to the GitHub API.
   * Refuses non-allowlisted operations with GitHubOperationRefused.
   * Throws GitHubRequestError on non-2xx responses.
   */
  async request<T = unknown>(method: GitHubMethod, path: string, body?: unknown): Promise<T> {
    // Validate path: must start with /, no .., and a query only on a paginated operation.
    if (!path.startsWith('/')) {
      throw new GitHubOperationRefused(method, path);
    }
    if (path.includes('..')) {
      throw new GitHubOperationRefused(method, path);
    }
    const queryAt = path.indexOf('?');
    const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
    const query = queryAt === -1 ? '' : path.slice(queryAt);
    if (pathname.includes('?') || pathname.includes('#')) {
      throw new GitHubOperationRefused(method, path);
    }

    const operation = ALLOWED_OPERATIONS.find(
      (op) => op.method === method && op.pattern.test(pathname),
    );
    if (!operation) {
      throw new GitHubOperationRefused(method, path);
    }
    if (query !== '' && !(operation.paginated && PAGE_QUERY.test(query))) {
      throw new GitHubOperationRefused(method, path);
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
    };

    const fetchOpts: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }

    const response = await this.fetch(url, fetchOpts);

    if (response.status === 204) {
      return undefined as T;
    }

    const responseText = await response.text();
    let responseData: unknown;

    if (response.ok) {
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }
      return responseData as T;
    }

    // Parse error message from response body
    let errorMessage: string;
    try {
      const json = JSON.parse(responseText);
      if (json && typeof json.message === 'string') {
        // Limit message to 300 chars
        const msg = json.message;
        errorMessage = msg.length > 300 ? msg.substring(0, 300) : msg;
      } else {
        errorMessage = responseText.substring(0, 300);
      }
    } catch {
      errorMessage = responseText.substring(0, 300);
    }

    const fullMessage = `GitHub ${method} ${path} failed with ${response.status}: ${errorMessage}`;
    throw new GitHubRequestError(response.status, fullMessage);
  }

  async getRepository(ref: GitHubRepoRef): Promise<{
    defaultBranch: string;
    private: boolean;
    htmlUrl: string;
  }> {
    const response = await this.request<{
      default_branch: string;
      private: boolean;
      html_url: string;
    }>('GET', `/repos/${ref.owner}/${ref.repo}`);
    return {
      defaultBranch: response.default_branch,
      private: response.private,
      htmlUrl: response.html_url,
    };
  }

  async createDraftPullRequest(
    ref: GitHubRepoRef,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string; draft: boolean }> {
    const response = await this.request<{
      number: number;
      html_url: string;
      draft: boolean;
    }>('POST', `/repos/${ref.owner}/${ref.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: true,
      maintainer_can_modify: true,
    });

    return {
      number: response.number,
      url: response.html_url,
      draft: response.draft,
    };
  }
}

/**
 * Branch name pattern: agentproof/<slug>-<id8> where:
 * - slug = lowercase, non-[a-z0-9] runs -> '-', trimmed of '-', cut to 40 chars
 * - id8 = id with 'fix_' prefix removed, first 8 chars
 */
export const BRANCH_PATTERN = /^agentproof\/[a-z0-9][a-z0-9._-]{0,60}$/;

export function agentproofBranchName(slug: string, id: string): string {
  // Remove 'fix_' prefix if present
  let cleanId = id;
  if (cleanId.startsWith('fix_')) {
    cleanId = cleanId.slice(4);
  }
  const id8 = cleanId.substring(0, 8);

  // Normalize slug: lowercase, replace non-[a-z0-9] with '-', trim '-', cut to 40
  let normalizedSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);

  const branchName = `agentproof/${normalizedSlug}-${id8}`;

  if (!BRANCH_PATTERN.test(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  return branchName;
}

export function isAgentproofBranch(name: string): boolean {
  return BRANCH_PATTERN.test(name);
}

export const COMPARE_BODY_MAX_CHARS = 4000;

/**
 * Build a GitHub compare URL with title and body in the query string.
 * Body is truncated to COMPARE_BODY_MAX_CHARS with a truncation note if needed.
 */
export function compareUrl(
  ref: GitHubRepoRef,
  input: { base: string; head: string; title: string; body: string },
): string {
  let body = input.body;
  if (body.length > COMPARE_BODY_MAX_CHARS) {
    body =
      body.substring(0, COMPARE_BODY_MAX_CHARS) +
      '\n\n[truncated; the full report is attached to the AgentProof run]';
  }

  const params = new URLSearchParams({
    expand: '1',
    title: input.title,
    body,
  });

  return `https://github.com/${ref.fullName}/compare/${input.base}...${input.head}?${params.toString()}`;
}

export const PR_BODY_MAX_CHARS = 60000;

/**
 * Clamp PR body to PR_BODY_MAX_CHARS with a truncation note if needed.
 */
export function clampPullRequestBody(body: string): string {
  if (body.length <= PR_BODY_MAX_CHARS) {
    return body;
  }

  return (
    body.substring(0, PR_BODY_MAX_CHARS) +
    '\n\n[truncated; the full report is attached to the AgentProof run]'
  );
}
