import { describe, it, expect } from 'vitest';
import {
  normalizeRepoPath,
  checkPathsInScope,
  checkNoDependencyChanges,
  checkSizeWithinBounds,
  runScopeChecks,
  scopePolicyFor,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_CHANGED_LINES,
  DEFAULT_SOURCE_DIRS,
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_DENIED_PATTERNS,
} from './scope';
import type { ScopePolicy } from './scope';

describe('normalizeRepoPath', () => {
  it('strips leading ./', () => {
    expect(normalizeRepoPath('./src/a.ts')).toBe('src/a.ts');
  });

  it('collapses duplicate slashes', () => {
    expect(normalizeRepoPath('src//a.ts')).toBe('src/a.ts');
  });

  it('rejects empty string', () => {
    expect(normalizeRepoPath('')).toBeUndefined();
  });

  it('rejects absolute paths', () => {
    expect(normalizeRepoPath('/abs/a.ts')).toBeUndefined();
  });

  it('rejects Windows paths with drive letter', () => {
    expect(normalizeRepoPath('C:\\x\\a.ts')).toBeUndefined();
  });

  it('rejects paths with .. segments', () => {
    expect(normalizeRepoPath('src/../a.ts')).toBeUndefined();
  });

  it('rejects paths with backslashes', () => {
    expect(normalizeRepoPath('src\\a.ts')).toBeUndefined();
  });

  it('rejects paths with NUL bytes', () => {
    expect(normalizeRepoPath('a\0.ts')).toBeUndefined();
  });

  it('rejects URL schemes', () => {
    expect(normalizeRepoPath('file:///x')).toBeUndefined();
  });

  it('handles multiple leading slashes correctly', () => {
    expect(normalizeRepoPath('src///ui//file.ts')).toBe('src/ui/file.ts');
  });

  it('handles trailing slashes', () => {
    expect(normalizeRepoPath('src/ui/')).toBe('src/ui');
  });
});

describe('checkPathsInScope', () => {
  describe('with storeRoot empty string', () => {
    const policy = scopePolicyFor('');

    it('passes valid source files', () => {
      const result = checkPathsInScope(['src/views.ts', 'src/ui/chips.css'], policy);
      expect(result.id).toBe('paths_in_scope');
      expect(result.status).toBe('passed');
      expect(result.detail).toContain('2 files');
      expect(result.detail).toContain('src');
    });

    it('fails empty file list', () => {
      const result = checkPathsInScope([], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toBe('no files touched');
    });

    it('fails docs directory', () => {
      const result = checkPathsInScope(['docs/a.md'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('outside scope');
      expect(result.detail).toContain('docs/a.md');
      expect(result.detail).toContain('not under');
    });

    it('fails disallowed extension', () => {
      const result = checkPathsInScope(['src/a.png'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('outside scope');
      expect(result.detail).toContain('src/a.png');
      expect(result.detail).toContain('extension .png not allowed');
    });

    it('fails unsafe path', () => {
      const result = checkPathsInScope(['../src/a.ts'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('outside scope');
      expect(result.detail).toContain('../src/a.ts');
      expect(result.detail).toContain('unsafe path');
    });

    it('names multiple offenders', () => {
      const result = checkPathsInScope(['docs/a.md', 'src/a.png', '../x.ts'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('docs/a.md');
      expect(result.detail).toContain('src/a.png');
      expect(result.detail).toContain('../x.ts');
    });
  });

  describe('with storeRoot apps/storefront', () => {
    const policy = scopePolicyFor('apps/storefront');

    it('passes files in storefront src', () => {
      const result = checkPathsInScope(['apps/storefront/src/views.ts'], policy);
      expect(result.status).toBe('passed');
      expect(result.detail).toContain('1 file');
      expect(result.detail).toContain('apps/storefront');
    });

    it('fails files without storefront prefix', () => {
      const result = checkPathsInScope(['src/views.ts'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('src/views.ts');
      expect(result.detail).toContain('apps/storefront');
    });

    it('fails files from different app', () => {
      const result = checkPathsInScope(['apps/web/src/page.tsx'], policy);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('apps/web/src/page.tsx');
    });
  });
});

describe('checkNoDependencyChanges', () => {
  const policy = scopePolicyFor('');

  it('passes source files', () => {
    const result = checkNoDependencyChanges(['src/cart.ts'], policy);
    expect(result.status).toBe('passed');
    expect(result.detail).toContain('no dependency');
  });

  it('fails package.json', () => {
    const result = checkNoDependencyChanges(['package.json'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('package.json');
  });

  it('fails scoped package.json', () => {
    const result = checkNoDependencyChanges(['apps/storefront/package.json'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('apps/storefront/package.json');
  });

  it('fails package-lock.json', () => {
    const result = checkNoDependencyChanges(['package-lock.json'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('package-lock.json');
  });

  it('fails pnpm-lock.yaml', () => {
    const result = checkNoDependencyChanges(['pnpm-lock.yaml'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('pnpm-lock.yaml');
  });

  it('fails .github directory', () => {
    const result = checkNoDependencyChanges(['.github/workflows/ci.yml'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('.github/workflows/ci.yml');
  });

  it('fails .env files', () => {
    const result = checkNoDependencyChanges(['.env', '.env.local'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('.env');
    expect(result.detail).toContain('.env.local');
  });

  it('fails scripts', () => {
    const result = checkNoDependencyChanges(['scripts/x.sh'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('scripts/x.sh');
  });

  it('fails Dockerfile', () => {
    const result = checkNoDependencyChanges(['Dockerfile'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('Dockerfile');
  });

  it('fails tsconfig.json', () => {
    const result = checkNoDependencyChanges(['apps/storefront/tsconfig.json'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('tsconfig.json');
  });

  it('fails node_modules', () => {
    const result = checkNoDependencyChanges(['node_modules/x/index.js'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('node_modules/x/index.js');
  });

  it('fails multiple dependency files', () => {
    const result = checkNoDependencyChanges(['package.json', 'pnpm-lock.yaml', '.env'], policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('package.json');
    expect(result.detail).toContain('pnpm-lock.yaml');
    expect(result.detail).toContain('.env');
  });
});

describe('checkSizeWithinBounds', () => {
  const policy = scopePolicyFor('');

  it('passes within bounds', () => {
    const result = checkSizeWithinBounds(
      { files: ['a.ts', 'b.ts'], added: 10, removed: 12 },
      policy,
    );
    expect(result.status).toBe('passed');
    expect(result.detail).toContain('2 files');
    expect(result.detail).toContain('22 changed');
  });

  it('fails with too many files', () => {
    const files = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
    const result = checkSizeWithinBounds({ files, added: 10, removed: 12 }, policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('6 files');
    expect(result.detail).toContain('5 limit');
  });

  it('fails with too many changed lines', () => {
    const result = checkSizeWithinBounds({ files: ['a.ts'], added: 200, removed: 101 }, policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('301 changed lines');
    expect(result.detail).toContain('300 limit');
  });

  it('fails when both files and lines exceed limits', () => {
    const files = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
    const result = checkSizeWithinBounds({ files, added: 200, removed: 101 }, policy);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('6 files');
    expect(result.detail).toContain('301 changed lines');
  });

  it('uses singular form for single file and line', () => {
    const result = checkSizeWithinBounds({ files: ['a.ts'], added: 1, removed: 0 }, policy);
    expect(result.status).toBe('passed');
    expect(result.detail).toContain('1 file');
    expect(result.detail).toContain('1 changed line');
  });

  it('respects custom maxFiles and maxChangedLines', () => {
    const customPolicy = scopePolicyFor('', {
      maxFiles: 2,
      maxChangedLines: 50,
    });
    const result = checkSizeWithinBounds(
      { files: ['a.ts', 'b.ts', 'c.ts'], added: 30, removed: 20 },
      customPolicy,
    );
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('3 files');
    expect(result.detail).toContain('2 limit');
    expect(result.detail).toContain('50 changed lines');
  });
});

describe('runScopeChecks', () => {
  it('returns exactly three checks in order', () => {
    const policy = scopePolicyFor('');
    const footprint = {
      files: ['src/test.ts'],
      added: 10,
      removed: 5,
    };
    const checks = runScopeChecks(footprint, policy);

    expect(checks).toHaveLength(3);
    if (checks.length >= 3) {
      expect(checks[0]!.id).toBe('paths_in_scope');
      expect(checks[1]!.id).toBe('no_dependency_changes');
      expect(checks[2]!.id).toBe('size_within_bounds');
    }
  });

  it('returns all checks even when first fails', () => {
    const policy = scopePolicyFor('');
    const footprint = {
      files: ['docs/readme.md'],
      added: 10,
      removed: 5,
    };
    const checks = runScopeChecks(footprint, policy);

    expect(checks).toHaveLength(3);
    if (checks.length >= 3) {
      expect(checks[0]!.status).toBe('failed');
      expect(checks[1]!.status).toBe('passed');
      expect(checks[2]!.status).toBe('passed');
    }
  });

  it('includes all three check ids', () => {
    const policy = scopePolicyFor('');
    const footprint = {
      files: Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`),
      added: 400,
      removed: 100,
    };
    const checks = runScopeChecks(footprint, policy);

    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(['paths_in_scope', 'no_dependency_changes', 'size_within_bounds']);
  });
});

describe('scopePolicyFor', () => {
  it('returns default policy with empty storeRoot', () => {
    const policy = scopePolicyFor('');
    expect(policy.storeRoot).toBe('');
    expect(policy.sourceDirs).toEqual([...DEFAULT_SOURCE_DIRS]);
    expect(policy.allowedExtensions).toEqual([...DEFAULT_ALLOWED_EXTENSIONS]);
    expect(policy.maxFiles).toBe(DEFAULT_MAX_FILES);
    expect(policy.maxChangedLines).toBe(DEFAULT_MAX_CHANGED_LINES);
  });

  it('normalizes storeRoot path', () => {
    const policy = scopePolicyFor('/apps/storefront/');
    expect(policy.storeRoot).toBe('apps/storefront');
  });

  it('applies partial overrides', () => {
    const policy = scopePolicyFor('apps/storefront', {
      maxFiles: 10,
      sourceDirs: ['src', 'lib'],
    });
    expect(policy.storeRoot).toBe('apps/storefront');
    expect(policy.maxFiles).toBe(10);
    expect(policy.maxChangedLines).toBe(DEFAULT_MAX_CHANGED_LINES);
    expect(policy.sourceDirs).toEqual(['src', 'lib']);
  });

  it('applies all overrides', () => {
    const customDenied = [/^custom\.json$/];
    const policy = scopePolicyFor('store', {
      maxFiles: 3,
      maxChangedLines: 100,
      sourceDirs: ['lib'],
      allowedExtensions: ['.rs'],
      deniedPatterns: customDenied,
    });
    expect(policy.storeRoot).toBe('store');
    expect(policy.maxFiles).toBe(3);
    expect(policy.maxChangedLines).toBe(100);
    expect(policy.sourceDirs).toEqual(['lib']);
    expect(policy.allowedExtensions).toEqual(['.rs']);
    expect(policy.deniedPatterns).toEqual(customDenied);
  });

  it('does not mutate override objects', () => {
    const overrides = { maxFiles: 7 };
    const policy = scopePolicyFor('test', overrides);
    overrides.maxFiles = 999;
    expect(policy.maxFiles).toBe(7);
  });

  it('preserves defaults as separate arrays', () => {
    const policy1 = scopePolicyFor('');
    const policy2 = scopePolicyFor('');
    expect(policy1.sourceDirs).not.toBe(policy2.sourceDirs);
    expect(policy1.sourceDirs).toEqual(policy2.sourceDirs);
  });
});

describe('DEFAULT constants', () => {
  it('exports DEFAULT_MAX_FILES', () => {
    expect(DEFAULT_MAX_FILES).toBe(5);
  });

  it('exports DEFAULT_MAX_CHANGED_LINES', () => {
    expect(DEFAULT_MAX_CHANGED_LINES).toBe(300);
  });

  it('exports DEFAULT_SOURCE_DIRS', () => {
    const dirs = Array.from(DEFAULT_SOURCE_DIRS);
    expect(dirs).toContain('src');
  });

  it('exports DEFAULT_ALLOWED_EXTENSIONS', () => {
    const exts = Array.from(DEFAULT_ALLOWED_EXTENSIONS);
    expect(exts).toContain('.ts');
    expect(exts).toContain('.tsx');
    expect(exts).toContain('.js');
    expect(exts).toContain('.jsx');
    expect(exts).toContain('.mjs');
    expect(exts).toContain('.cjs');
    expect(exts).toContain('.html');
    expect(exts).toContain('.css');
  });

  it('exports DEFAULT_DENIED_PATTERNS', () => {
    const patterns = Array.from(DEFAULT_DENIED_PATTERNS);
    expect(patterns.length).toBeGreaterThan(0);
  });
});
