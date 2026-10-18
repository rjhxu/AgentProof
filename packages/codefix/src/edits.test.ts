import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits,
  unifiedDiff,
  combinedDiff,
  diffStats,
  diffFiles,
  type ApplyEditsResult,
} from './edits';
import type { CodeEdit } from '@agentproof/shared';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edits-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

/**
 * Helper that validates a unified diff against real git:
 * - Creates a temp git repo
 * - Writes before files, commits
 * - Applies the diff
 * - Verifies git accepts it and content matches after
 */
function validateDiffWithGit(files: Map<string, { before: string; after: string }>): void {
  const dir = createTempDir();

  // Initialize git repo
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });

  // Write before files and commit
  for (const [path, content] of files) {
    const fullPath = join(dir, path);
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (parentDir !== dir) {
      execFileSync('mkdir', ['-p', parentDir]);
    }
    writeFileSync(fullPath, content.before);
  }

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });

  // Create diff and apply it
  const changes = Array.from(files, ([path, { before, after }]) => ({
    path,
    before,
    after,
  }));
  const diff = combinedDiff(changes);

  const diffFile = join(dir, 'patch.diff');
  writeFileSync(diffFile, diff);

  // Verify git accepts the diff
  execFileSync('git', ['apply', '--check', diffFile], { cwd: dir });

  // Apply the diff
  execFileSync('git', ['apply', diffFile], { cwd: dir });

  // Verify content matches after
  for (const [path, expected] of files) {
    const fullPath = join(dir, path);
    const actual = readFileSync(fullPath, 'utf8');
    expect(actual).toBe(expected.after);
  }
}

describe('unifiedDiff', () => {
  it('case 1: single-line replacement in middle of 20-line file', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const middle = Array.from({ length: 20 }, (_, i) => {
      if (i === 9) return 'line 10 MODIFIED';
      return `line ${i + 1}`;
    }).join('\n');
    const after = middle + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 2: two separate hunks far apart (lines 3 and 40 of 50-line file)', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const lines = Array.from({ length: 50 }, (_, i) => {
      if (i === 2) return 'line 3 MODIFIED';
      if (i === 39) return 'line 40 MODIFIED';
      return `line ${i + 1}`;
    });
    const after = lines.join('\n') + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 3: two changes 4 lines apart with context 3 merged into one hunk', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const lines = Array.from({ length: 30 }, (_, i) => {
      if (i === 9) return 'line 10 MODIFIED';
      if (i === 13) return 'line 14 MODIFIED';
      return `line ${i + 1}`;
    });
    const after = lines.join('\n') + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 4: deletion of last 3 lines', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = Array.from({ length: 17 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 5: insertion of 2 lines at very top', () => {
    const before = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = 'new line 1\nnew line 2\n' + before;

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 6: file without trailing newline before and after', () => {
    const before = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const lines = Array.from({ length: 10 }, (_, i) => {
      if (i === 5) return 'line 6 MODIFIED';
      return `line ${i + 1}`;
    });
    const after = lines.join('\n');

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 7: adding trailing newline to file that lacked one', () => {
    const before = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 8: combinedDiff with two files, one unchanged', () => {
    const file1Before = 'file 1 line 1\nfile 1 line 2\n';
    const file1After = 'file 1 line 1 MODIFIED\nfile 1 line 2\n';
    const file2Before = 'file 2 line 1\nfile 2 line 2\n';
    const file2After = file2Before; // unchanged

    const files = new Map([
      ['file1.txt', { before: file1Before, after: file1After }],
      ['file2.txt', { before: file2Before, after: file2After }],
    ]);

    // Get combined diff
    const changes = Array.from(files, ([path, { before, after }]) => ({
      path,
      before,
      after,
    }));
    const diff = combinedDiff(changes);

    // Verify only file1 appears in diff
    const extractedFiles = diffFiles(diff);
    expect(extractedFiles).toEqual(['file1.txt']);

    // Validate with git
    validateDiffWithGit(files);
  });

  it('case 9: replacing entire content of 10-line file', () => {
    const before = Array.from({ length: 10 }, (_, i) => `old line ${i + 1}`).join('\n') + '\n';
    const after = Array.from({ length: 10 }, (_, i) => `new line ${i + 1}`).join('\n') + '\n';

    validateDiffWithGit(new Map([['test.txt', { before, after }]]));
  });

  it('case 10: 3000-line file with one change near end (performance)', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const lines = Array.from({ length: 3000 }, (_, i) => {
      if (i === 2950) return 'line 2951 MODIFIED';
      return `line ${i + 1}`;
    });
    const after = lines.join('\n') + '\n';

    const start = Date.now();
    const diff = unifiedDiff('large.txt', before, after);
    const duration = Date.now() - start;

    expect(diff).toBeTruthy();
    expect(duration).toBeLessThan(1000); // Must finish under 1 second

    validateDiffWithGit(new Map([['large.txt', { before, after }]]));
  });

  it('returns empty string when before === after', () => {
    const content = 'line 1\nline 2\n';
    const diff = unifiedDiff('test.txt', content, content);
    expect(diff).toBe('');
  });
});

describe('applyEdits', () => {
  it('success: two edits on one file and one on another', () => {
    const files = new Map([
      ['file1.ts', 'const x = 1;\nconst y = 2;\nconst z = 3;'],
      ['file2.ts', 'function foo() {\n  return 42;\n}'],
    ]);

    const edits: CodeEdit[] = [
      { path: 'file1.ts', search: 'const x = 1;', replace: 'const x = 10;', reason: 'update x' },
      { path: 'file1.ts', search: 'const y = 2;', replace: 'const y = 20;', reason: 'update y' },
      {
        path: 'file2.ts',
        search: 'return 42;',
        replace: 'return 100;',
        reason: 'update return',
      },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated.get('file1.ts')).toBe('const x = 10;\nconst y = 20;\nconst z = 3;');
      expect(result.updated.get('file2.ts')).toBe('function foo() {\n  return 100;\n}');
      expect(result.touched).toEqual(['file1.ts', 'file2.ts']);
    }
  });

  it('error: search text not found', () => {
    const files = new Map([['file.ts', 'const x = 1;']]);
    const edits: CodeEdit[] = [
      { path: 'file.ts', search: 'const y = 2;', replace: 'const y = 20;', reason: 'not there' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('edit 1 (file.ts): search text not found');
      expect(result.touched).toEqual([]);
    }
  });

  it('error: search text found multiple times', () => {
    const files = new Map([['file.ts', 'const x = 1;\nconst x = 2;']]);
    const edits: CodeEdit[] = [
      { path: 'file.ts', search: 'const x = ', replace: 'let x = ', reason: 'ambiguous' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        'edit 1 (file.ts): search text found 2 times; it must be unique',
      );
      expect(result.touched).toEqual([]);
    }
  });

  it('error: path not in files', () => {
    const files = new Map([['file.ts', 'const x = 1;']]);
    const edits: CodeEdit[] = [
      { path: 'missing.ts', search: 'const x = 1;', replace: 'const y = 1;', reason: 'wrong file' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        'edit 1 (missing.ts): path was not among the files shown to the model',
      );
      expect(result.touched).toEqual([]);
    }
  });

  it('error: search and replace identical', () => {
    const files = new Map([['file.ts', 'const x = 1;']]);
    const edits: CodeEdit[] = [
      { path: 'file.ts', search: 'const x = 1;', replace: 'const x = 1;', reason: 'no change' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('edit 1 (file.ts): search and replace are identical');
      expect(result.touched).toEqual([]);
    }
  });

  it('errors accumulate: two bad edits produce two errors', () => {
    const files = new Map([['file.ts', 'const x = 1;']]);
    const edits: CodeEdit[] = [
      { path: 'file.ts', search: 'missing', replace: 'replacement', reason: 'not found' },
      { path: 'missing.ts', search: 'anything', replace: 'else', reason: 'wrong file' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('search text not found');
      expect(result.errors[1]).toContain('path was not among the files shown to the model');
    }
  });

  it('exactness: trailing whitespace matters', () => {
    const files = new Map([['file.ts', 'const x = 1;']]);
    const edits: CodeEdit[] = [
      {
        path: 'file.ts',
        search: 'const x = 1; ',
        replace: 'const x = 10; ',
        reason: 'wrong space',
      },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('edit 1 (file.ts): search text not found');
    }
  });

  it('later edits see earlier edits to same file', () => {
    const files = new Map([['file.ts', 'aaa\nbbb\naaa']]);
    const edits: CodeEdit[] = [
      { path: 'file.ts', search: 'aaa\nbbb\naaa', replace: 'xxx\nbbb\naaa', reason: 'first' },
      { path: 'file.ts', search: 'xxx\nbbb', replace: 'xxx\nyyy', reason: 'sees first edit' },
    ];

    const result = applyEdits(files, edits);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updated.get('file.ts')).toBe('xxx\nyyy\naaa');
    }
  });
});

describe('diffStats', () => {
  it('parses diff correctly', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const lines = Array.from({ length: 50 }, (_, i) => {
      if (i === 2) return 'line 3 MODIFIED';
      if (i === 39) return 'line 40 MODIFIED';
      return `line ${i + 1}`;
    });
    const after = lines.join('\n') + '\n';

    const diff = unifiedDiff('test.txt', before, after);
    const stats = diffStats(diff);

    expect(stats.files).toContain('test.txt');
    expect(stats.added).toBeGreaterThan(0);
    expect(stats.removed).toBeGreaterThan(0);
    expect(stats.changed).toBe(stats.added + stats.removed);
  });
});

describe('diffFiles', () => {
  it('extracts files from diff', () => {
    const diff = unifiedDiff('a.txt', 'old', 'new') + unifiedDiff('b.txt', 'old', 'new');
    const files = diffFiles(diff);
    expect(files).toEqual(['a.txt', 'b.txt']);
  });
});

describe('combinedDiff', () => {
  it('skips unchanged files and includes changed ones', () => {
    const changes = [
      { path: 'changed.txt', before: 'before', after: 'after' },
      { path: 'unchanged.txt', before: 'same', after: 'same' },
      { path: 'changed2.txt', before: 'old', after: 'new' },
    ];

    const diff = combinedDiff(changes);
    const files = diffFiles(diff);

    expect(files).toEqual(['changed.txt', 'changed2.txt']);
    expect(files).not.toContain('unchanged.txt');
  });
});
