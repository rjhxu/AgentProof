import type { CodeEdit } from '@agentproof/shared';

export type ApplyEditsResult =
  | { ok: true; updated: Map<string, string>; touched: string[] }
  | { ok: false; errors: string[]; touched: string[] };

/**
 * All-or-nothing. Works on a copy of `files`; edits apply in order, so a later edit sees earlier edits to the same file.
 * Error strings (one per problem, collect them all before returning):
 *   `edit <n> (<path>): path was not among the files shown to the model`
 *   `edit <n> (<path>): search text not found`
 *   `edit <n> (<path>): search text found <k> times; it must be unique`
 *   `edit <n> (<path>): search and replace are identical`
 * where n is 1-based. `touched` lists paths whose content changed (unique, in first-touched order), empty on failure.
 * Normalize nothing: exact byte-for-byte matching (so the model must copy text exactly). Do not trim.
 */
export function applyEdits(files: Map<string, string>, edits: CodeEdit[]): ApplyEditsResult {
  const updated = new Map(files);
  const errors: string[] = [];
  const touched: string[] = [];
  const touchedSet = new Set<string>();

  for (let i = 0; i < edits.length; i++) {
    const n = i + 1; // 1-based edit number
    const edit = edits[i] ?? {};
    const path = (edit as any)?.path;
    const search = (edit as any)?.search;
    const replace = (edit as any)?.replace;

    // Check path exists in original files
    if (!updated.has(path)) {
      errors.push(`edit ${n} (${path}): path was not among the files shown to the model`);
      continue;
    }

    // Check search and replace are not identical
    if (search === replace) {
      errors.push(`edit ${n} (${path}): search and replace are identical`);
      continue;
    }

    const current = updated.get(path) ?? '';

    // Count occurrences of search text
    let count = 0;
    let index = 0;
    while ((index = current.indexOf(search, index)) !== -1) {
      count++;
      index += search.length;
    }

    if (count === 0) {
      errors.push(`edit ${n} (${path}): search text not found`);
      continue;
    }

    if (count > 1) {
      errors.push(`edit ${n} (${path}): search text found ${count} times; it must be unique`);
      continue;
    }

    // Apply the edit
    const newContent = current.replace(search, replace);
    updated.set(path, newContent);

    // Track touched file
    if (!touchedSet.has(path)) {
      touched.push(path);
      touchedSet.add(path);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, touched: [] };
  }

  return { ok: true, updated, touched };
}

/**
 * Unified diff for one file, git-compatible so `git apply` accepts it:
 *   --- a/<path>
 *   +++ b/<path>
 *   @@ -<start>,<count> +<start>,<count> @@
 * Returns '' when before === after. `context` lines of context (default 3); hunks whose context would overlap or touch
 * are merged into one. Use a line-based LCS (a simple O(n*m) DP is fine for files under ~5,000 lines; guard: if n*m > 25,000,000
 * fall back to a single hunk that replaces the whole differing middle, computed by trimming the common prefix and suffix).
 * Handle a missing trailing newline exactly as git does: emit `\ No newline at end of file` after the affected line.
 * Hunk headers: when count is 1 omit `,1`? NO: always write `,<count>` (git accepts both; be consistent and always include it),
 * and when a side has 0 lines use the line number before the insertion as git does (e.g. `@@ -0,0 +1,3 @@` for a new first block is
 * only for empty files; for an insertion after line 5 into a file, the old side is `-5,0`). Make sure `git apply --check` passes
 * for every test case: that is the oracle, not this description.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context: number = 3,
): string {
  if (before === after) {
    return '';
  }

  // Track if files have trailing newlines (before removing empty strings)
  const beforeHasTrailingNewline = before.endsWith('\n') && before.length > 0;
  const afterHasTrailingNewline = after.endsWith('\n') && after.length > 0;

  // Split and remove the trailing empty string from split (which represents the final newline)
  let beforeLines = before.split('\n');
  let afterLines = after.split('\n');

  // Remove trailing empty line from split only if there was a trailing newline
  if (beforeHasTrailingNewline && beforeLines[beforeLines.length - 1] === '') {
    beforeLines.pop();
  }
  if (afterHasTrailingNewline && afterLines[afterLines.length - 1] === '') {
    afterLines.pop();
  }

  // Special case: if lines are identical but trailing newline changed, show last line as changed
  if (
    beforeLines.length === afterLines.length &&
    beforeLines.every((line, i) => line === afterLines[i]) &&
    beforeHasTrailingNewline !== afterHasTrailingNewline &&
    beforeLines.length > 0
  ) {
    // Create a synthetic diff showing the last line changed
    const lastLineIdx = beforeLines.length - 1;
    const lines: Array<{ type: 'context' | 'remove' | 'add'; line: string }> = [];
    const hunks: Array<{
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: Array<{ type: 'context' | 'remove' | 'add'; line: string }>;
    }> = [];

    // Add context lines before the last line
    for (let i = Math.max(0, lastLineIdx - context); i < lastLineIdx; i++) {
      const line = beforeLines[i];
      if (line !== undefined) {
        lines.push({ type: 'context', line });
      }
    }

    // Add the last line as removed and re-added
    const lastLine = beforeLines[lastLineIdx];
    if (lastLine !== undefined) {
      lines.push({ type: 'remove', line: lastLine });
      lines.push({ type: 'add', line: lastLine });
    }

    const hunkStart = Math.max(1, lastLineIdx - context + 1);
    hunks.push({
      oldStart: hunkStart,
      oldCount: context + 1,
      newStart: hunkStart,
      newCount: context + 1,
      lines,
    });

    let result = `--- a/${path}\n+++ b/${path}\n`;
    for (const hunk of hunks) {
      result += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;

      for (let i = 0; i < hunk.lines.length; i++) {
        const item = hunk.lines[i];
        if (!item) continue;

        if (item.type === 'context') {
          result += ` ${item.line}\n`;
        } else if (item.type === 'remove') {
          result += `-${item.line}`;
          if (!beforeHasTrailingNewline) {
            result += '\n\\ No newline at end of file\n';
          } else {
            result += '\n';
          }
        } else if (item.type === 'add') {
          result += `+${item.line}`;
          if (!afterHasTrailingNewline) {
            result += '\n\\ No newline at end of file\n';
          } else {
            result += '\n';
          }
        }
      }
    }

    return result;
  }

  // Compute LCS with performance guard
  const n = beforeLines.length;
  const m = afterLines.length;

  let hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{ type: 'context' | 'remove' | 'add'; line: string }>;
  }> = [];

  if (n * m > 25000000) {
    // Performance: use single hunk for entire content
    const lines: (typeof hunks)[0]['lines'] = [];
    for (const line of beforeLines) {
      lines.push({ type: 'remove', line });
    }
    for (const line of afterLines) {
      lines.push({ type: 'add', line });
    }
    hunks = [
      {
        oldStart: 1,
        oldCount: beforeLines.length,
        newStart: 1,
        newCount: afterLines.length,
        lines,
      },
    ];
  } else {
    // Use LCS to compute minimal diff
    const diff = computeDiff(beforeLines, afterLines);
    hunks = groupIntoHunks(diff, context, beforeLines.length, afterLines.length);
  }

  // Merge adjacent hunks
  hunks = mergeAdjacentHunks(hunks, context);

  let result = `--- a/${path}\n+++ b/${path}\n`;

  for (const hunk of hunks) {
    result += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;

    for (let i = 0; i < hunk.lines.length; i++) {
      const item = hunk.lines[i];
      if (!item) continue;

      const isLastLine = i === hunk.lines.length - 1;

      if (item.type === 'context') {
        result += ` ${item.line}\n`;
      } else if (item.type === 'remove') {
        result += `-${item.line}`;
        // Add no-newline marker if this is last line of before without newline
        if (isLastLine && !beforeHasTrailingNewline) {
          result += '\n\\ No newline at end of file\n';
        } else {
          result += '\n';
        }
      } else if (item.type === 'add') {
        result += `+${item.line}`;
        // Add no-newline marker if this is last line of after without newline
        if (isLastLine && !afterHasTrailingNewline) {
          result += '\n\\ No newline at end of file\n';
        } else {
          result += '\n';
        }
      }
    }
  }

  return result;
}

interface DiffItem {
  type: 'context' | 'remove' | 'add';
  line: string;
}

function computeDiff(before: string[], after: string[]): DiffItem[] {
  const m = before.length;
  const n = after.length;

  // Compute LCS using DP
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const dpI = dp[i];
    if (!dpI) continue;

    const beforeI = before[i - 1];
    const dpPrevI = dp[i - 1];
    if (!dpPrevI) continue;

    for (let j = 1; j <= n; j++) {
      const afterJ = after[j - 1];
      if (beforeI === afterJ) {
        const prevVal = dpPrevI[j - 1];
        dpI[j] = (prevVal ?? 0) + 1;
      } else {
        dpI[j] = Math.max(dpPrevI[j] ?? 0, dpI[j - 1] ?? 0);
      }
    }
  }

  // Backtrack to get the diff
  const result: DiffItem[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    const dpI = dp[i];
    const dpIMinus1 = dp[i - 1];

    if (i > 0 && j > 0) {
      const beforeI = before[i - 1];
      const afterJ = after[j - 1];
      if (beforeI !== undefined && afterJ !== undefined && beforeI === afterJ) {
        // Match: backtrack diagonally
        result.unshift({ type: 'context', line: beforeI });
        i--;
        j--;
        continue;
      }
    }

    if (j > 0 && (i === 0 || (dpI?.[j - 1] ?? 0) >= (dpIMinus1?.[j] ?? 0))) {
      // Insert from after
      const afterJ = after[j - 1];
      if (afterJ !== undefined) {
        result.unshift({ type: 'add', line: afterJ });
      }
      j--;
    } else {
      // Delete from before
      const beforeI = before[i - 1];
      if (beforeI !== undefined) {
        result.unshift({ type: 'remove', line: beforeI });
      }
      i--;
    }
  }

  return result;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ type: 'context' | 'remove' | 'add'; line: string }>;
}

function groupIntoHunks(
  diff: DiffItem[],
  context: number,
  _beforeLen: number,
  _afterLen: number,
): Hunk[] {
  // Find all change positions
  const changePositions: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    if (diff[i]?.type !== 'context') {
      changePositions.push(i);
    }
  }

  if (changePositions.length === 0) {
    return [];
  }

  // Group changes into hunks
  const hunkRanges: Array<{ start: number; end: number }> = [];
  let currentStart = changePositions[0] ?? 0;
  let currentEnd = currentStart;

  for (let i = 1; i < changePositions.length; i++) {
    const pos = changePositions[i];
    if (pos === undefined) continue;

    const gap = pos - (currentEnd + 1);
    if (gap <= 2 * context) {
      // Merge with current hunk
      currentEnd = pos;
    } else {
      // Start new hunk
      hunkRanges.push({ start: currentStart, end: currentEnd });
      currentStart = pos;
      currentEnd = pos;
    }
  }
  hunkRanges.push({ start: currentStart, end: currentEnd });

  // Build hunks
  const hunks: Hunk[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const range of hunkRanges) {
    const hunkStart = Math.max(0, range.start - context);
    const hunkEnd = Math.min(diff.length - 1, range.end + context);

    let hunkOldStart = oldLineNum;
    let hunkNewStart = newLineNum;
    const hunkLines: Array<{ type: 'context' | 'remove' | 'add'; line: string }> = [];

    // Count lines up to hunk start
    for (let i = 0; i < hunkStart; i++) {
      const item = diff[i];
      if (!item) continue;
      if (item.type === 'context' || item.type === 'remove') oldLineNum++;
      if (item.type === 'context' || item.type === 'add') newLineNum++;
    }

    hunkOldStart = oldLineNum;
    hunkNewStart = newLineNum;

    // Collect hunk lines
    for (let i = hunkStart; i <= hunkEnd; i++) {
      const item = diff[i];
      if (!item) continue;

      hunkLines.push(item);
      if (item.type === 'context' || item.type === 'remove') oldLineNum++;
      if (item.type === 'context' || item.type === 'add') newLineNum++;
    }

    const oldCount = hunkLines.filter((l) => l.type === 'context' || l.type === 'remove').length;
    const newCount = hunkLines.filter((l) => l.type === 'context' || l.type === 'add').length;

    hunks.push({
      oldStart: hunkOldStart,
      oldCount,
      newStart: hunkNewStart,
      newCount,
      lines: hunkLines,
    });
  }

  return hunks;
}

function mergeAdjacentHunks(hunks: Hunk[], context: number): Hunk[] {
  if (hunks.length === 0) return hunks;

  const merged: Hunk[] = [];
  let current = hunks[0];
  if (!current) return hunks;

  for (let i = 1; i < hunks.length; i++) {
    const next = hunks[i];
    if (!next) continue;

    // Check if hunks overlap or are within context distance
    const oldEnd = current.oldStart + current.oldCount;
    const newEnd = current.newStart + current.newCount;

    if (next.oldStart <= oldEnd + context && next.newStart <= newEnd + context) {
      // Merge hunks
      const lines: Array<{ type: 'context' | 'remove' | 'add'; line: string }> = [...current.lines];
      lines.push(...next.lines);

      current = {
        oldStart: current.oldStart,
        oldCount: current.oldCount + next.oldCount,
        newStart: current.newStart,
        newCount: current.newCount + next.newCount,
        lines,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}

/** Per-file diffs concatenated in the given order (skip unchanged files). */
export function combinedDiff(
  changes: Array<{ path: string; before: string; after: string }>,
): string {
  let result = '';

  for (const change of changes) {
    const diff = unifiedDiff(change.path, change.before, change.after);
    if (diff) {
      result += diff;
    }
  }

  return result;
}

export interface DiffStats {
  files: string[];
  added: number;
  removed: number;
  changed: number;
}

/**
 * Walk a unified diff hunk by hunk. Inside a hunk the line counts from the `@@` header decide
 * which lines are content, so an added line that itself starts with "++" or "--" is never
 * mistaken for a file header; headers are only recognized between hunks.
 */
function walkDiff(
  diff: string,
  onFile: (path: string) => void,
  onLine: (kind: '+' | '-' | ' ', text: string) => void,
): void {
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      const kind = line[0];
      if (kind === '+') {
        newLeft -= 1;
        onLine('+', line.slice(1));
      } else if (kind === '-') {
        oldLeft -= 1;
        onLine('-', line.slice(1));
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        onLine(' ', line.slice(1));
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      if (path && path !== '/dev/null') onFile(path);
    }
  }
}

/** Files from the `+++` headers and counts of added and removed content lines; changed = added + removed. */
export function diffStats(diff: string): DiffStats {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  walkDiff(
    diff,
    (path) => files.push(path),
    (kind) => {
      if (kind === '+') added += 1;
      else if (kind === '-') removed += 1;
    },
  );
  return { files, added, removed, changed: added + removed };
}

/** Files from the `+++` headers, in order. */
export function diffFiles(diff: string): string[] {
  const files: string[] = [];
  walkDiff(
    diff,
    (path) => files.push(path),
    () => undefined,
  );
  return files;
}
