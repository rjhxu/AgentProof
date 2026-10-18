export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

/** One unified-diff line, by its first characters. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
