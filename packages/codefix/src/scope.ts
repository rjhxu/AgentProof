import type { CodeFixCheck } from '@agentproof/shared';

export interface ScopePolicy {
  /** Directory of the store inside the repository, '' for the root. Normalized: no leading/trailing slashes. */
  storeRoot: string;
  /** Directories under storeRoot the diff may touch, default ['src'] */
  sourceDirs: string[];
  allowedExtensions: string[];
  /** Patterns that are never allowed anywhere, tested against the normalized full path */
  deniedPatterns: RegExp[];
  maxFiles: number;
  maxChangedLines: number;
}

export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_MAX_CHANGED_LINES = 300;
export const DEFAULT_SOURCE_DIRS: readonly string[] = Object.freeze(['src']);
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
]);

/** Dependency, CI, environment, scripts and git metadata. */
export const DEFAULT_DENIED_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.nvmrc$/,
  /(^|\/)\.node-version$/,
  /(^|\/)\.github\//,
  /(^|\/)\.env$/,
  /(^|\/)\.env\..*/,
  /\.sh$/,
  /(^|\/)Dockerfile/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
]);

export function scopePolicyFor(storeRoot: string, overrides?: Partial<ScopePolicy>): ScopePolicy {
  // Strip leading/trailing slashes for convenience, then normalize
  let cleaned = storeRoot;
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }

  const normalized = normalizeRepoPath(cleaned);
  const root = normalized ?? '';

  return {
    storeRoot: root,
    sourceDirs: overrides?.sourceDirs ?? [...DEFAULT_SOURCE_DIRS],
    allowedExtensions: overrides?.allowedExtensions ?? [...DEFAULT_ALLOWED_EXTENSIONS],
    deniedPatterns: overrides?.deniedPatterns ?? [...DEFAULT_DENIED_PATTERNS],
    maxFiles: overrides?.maxFiles ?? DEFAULT_MAX_FILES,
    maxChangedLines: overrides?.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES,
  };
}

/**
 * POSIX-normalize a repository-relative path. Returns undefined for anything unsafe: empty, absolute ('/x', 'C:\x'),
 * containing '..' segments, backslashes, NUL bytes, or a URL scheme. Strips a leading './' and collapses duplicate slashes.
 */
export function normalizeRepoPath(p: string): string | undefined {
  // Check for empty string
  if (!p) {
    return undefined;
  }

  // Check for NUL bytes
  if (p.includes('\0')) {
    return undefined;
  }

  // Check for URL scheme (e.g., 'file://', 'http://')
  if (p.includes('://')) {
    return undefined;
  }

  // Check for Windows paths (C:\x) or backslashes
  if (/^[a-zA-Z]:/.test(p) || p.includes('\\')) {
    return undefined;
  }

  // Check for absolute paths (starts with /)
  if (p.startsWith('/')) {
    return undefined;
  }

  // Strip leading './'
  let normalized = p;
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // Strip trailing '/'
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  // Split by / and process each part
  const parts = normalized.split('/');
  const result: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      // '..' segments are not allowed
      return undefined;
    } else if (part !== '' && part !== '.') {
      // Keep non-empty, non-'.' parts
      result.push(part);
    }
    // Skip empty parts and '.' to collapse slashes
  }

  const joined = result.join('/');

  // If nothing was left, path was invalid
  if (!joined) {
    return undefined;
  }

  return joined;
}

/** passed when every path normalizes and lies under `<storeRoot>/<sourceDir>/` with an allowed extension; the detail names each offender. */
export function checkPathsInScope(files: string[], policy: ScopePolicy): CodeFixCheck {
  if (files.length === 0) {
    return {
      id: 'paths_in_scope',
      status: 'failed',
      detail: 'no files touched',
    };
  }

  const offenders: string[] = [];

  for (const file of files) {
    const normalized = normalizeRepoPath(file);

    // If path doesn't normalize, it's unsafe
    if (normalized === undefined) {
      offenders.push(`${file} (unsafe path)`);
      continue;
    }

    let inScope = false;

    // Check if it's under <storeRoot>/<sourceDir>/
    for (const sourceDir of policy.sourceDirs) {
      let prefix: string;
      if (policy.storeRoot) {
        prefix = `${policy.storeRoot}/${sourceDir}/`;
      } else {
        prefix = `${sourceDir}/`;
      }

      if (normalized.startsWith(prefix)) {
        // Check the extension
        const ext = normalized.match(/\.[^/]*$/)?.[0];
        if (ext && policy.allowedExtensions.includes(ext)) {
          inScope = true;
          break;
        } else {
          // Wrong extension
          offenders.push(`${file} (extension ${ext || 'none'} not allowed)`);
          inScope = true; // Mark as processed with error
          break;
        }
      }
    }

    // If not in scope for any sourceDir
    if (!inScope) {
      const expectedScope = policy.storeRoot
        ? `${policy.storeRoot}/${policy.sourceDirs.join('|')}`
        : policy.sourceDirs.join('|');
      offenders.push(`${file} (not under ${expectedScope})`);
    }
  }

  if (offenders.length === 0) {
    const count = files.length;
    const storePrefix = policy.storeRoot ? `${policy.storeRoot}/` : '';
    const sourceDirsStr = policy.sourceDirs.join('|');
    const detail = `${count} file${count === 1 ? '' : 's'} inside ${storePrefix}${sourceDirsStr} with allowed extensions`;
    return {
      id: 'paths_in_scope',
      status: 'passed',
      detail,
    };
  }

  // Truncate if too many offenders
  let offenderStr = offenders.slice(0, 5).join('; ');
  if (offenders.length > 5) {
    offenderStr += `; ... and ${offenders.length - 5} more`;
  }

  return {
    id: 'paths_in_scope',
    status: 'failed',
    detail: `outside scope: ${offenderStr}`,
  };
}

/** passed when no path matches a denied pattern; the detail names each offender. */
export function checkNoDependencyChanges(files: string[], policy: ScopePolicy): CodeFixCheck {
  const offenders: string[] = [];

  for (const file of files) {
    const normalized = normalizeRepoPath(file);
    if (normalized === undefined) continue;

    for (const pattern of policy.deniedPatterns) {
      if (pattern.test(normalized)) {
        offenders.push(file);
        break;
      }
    }
  }

  if (offenders.length === 0) {
    return {
      id: 'no_dependency_changes',
      status: 'passed',
      detail: 'no dependency or CI files touched',
    };
  }

  // Truncate if too many offenders
  let offenderStr = offenders.slice(0, 5).join('; ');
  if (offenders.length > 5) {
    offenderStr += `; ... and ${offenders.length - 5} more`;
  }

  return {
    id: 'no_dependency_changes',
    status: 'failed',
    detail: `dependency or CI files touched: ${offenderStr}`,
  };
}

export interface DiffFootprint {
  files: string[];
  added: number;
  removed: number;
}

/** passed when files.length <= maxFiles and added + removed <= maxChangedLines; detail states the numbers either way. */
export function checkSizeWithinBounds(footprint: DiffFootprint, policy: ScopePolicy): CodeFixCheck {
  const fileCount = footprint.files.length;
  const changedLines = footprint.added + footprint.removed;

  const filesFail = fileCount > policy.maxFiles;
  const linesFail = changedLines > policy.maxChangedLines;

  if (!filesFail && !linesFail) {
    return {
      id: 'size_within_bounds',
      status: 'passed',
      detail: `${fileCount} file${fileCount === 1 ? '' : 's'}, ${changedLines} changed line${changedLines === 1 ? '' : 's'}`,
    };
  }

  const details = [];
  if (filesFail) {
    details.push(`${fileCount} files > ${policy.maxFiles} limit`);
  } else {
    details.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  }

  if (linesFail) {
    details.push(`${changedLines} changed lines > ${policy.maxChangedLines} limit`);
  } else {
    details.push(`${changedLines} changed line${changedLines === 1 ? '' : 's'}`);
  }

  return {
    id: 'size_within_bounds',
    status: 'failed',
    detail: details.join(', '),
  };
}

/** The three checks in order: paths_in_scope, no_dependency_changes, size_within_bounds. Always returns all three. */
export function runScopeChecks(footprint: DiffFootprint, policy: ScopePolicy): CodeFixCheck[] {
  return [
    checkPathsInScope(footprint.files, policy),
    checkNoDependencyChanges(footprint.files, policy),
    checkSizeWithinBounds(footprint, policy),
  ];
}
