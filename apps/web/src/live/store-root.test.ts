import { describe, expect, it } from 'vitest';

import { repositoryA } from '../design/fixtures';
import { detectStoreRoot } from './store-root';

/** The storefront exported on its own (scripts/make-fixed-store.sh): the store is the repository. */
const northwindExport = [
  'package.json',
  'tsconfig.json',
  'public/store.css',
  'public/images/black-hoodie.jpg',
  'src/server.ts',
  'src/views.ts',
  'src/cart.ts',
  'src/catalog.ts',
];

/** This monorepo as GitHub lists it: the store is one app beside the runner, which has a server too. */
const monorepo = [
  'package.json',
  'pnpm-workspace.yaml',
  'apps/web/package.json',
  'apps/runner/package.json',
  'apps/runner/src/server.ts',
  'apps/runner/src/routes.ts',
  'packages/shared/package.json',
  'packages/shared/src/index.ts',
  ...repositoryA.files,
];

describe('detectStoreRoot', () => {
  it('is the root when the store is the repository', () => {
    expect(detectStoreRoot(northwindExport)).toBe('');
    expect(detectStoreRoot(['src/server.ts'])).toBe('');
    expect(detectStoreRoot(['package.json', 'src/index.ts'])).toBe('');
  });

  it('finds the store inside the monorepo by its server file', () => {
    expect(detectStoreRoot(monorepo)).toBe('apps/storefront');
    expect(detectStoreRoot(repositoryA.files)).toBe('apps/storefront');
  });

  it('prefers a directory named for the store, then the shortest server path', () => {
    expect(detectStoreRoot(['apps/runner/src/server.ts', 'apps/storefront/src/server.ts'])).toBe(
      'apps/storefront',
    );
    expect(detectStoreRoot(['services/api/src/server.ts', 'sites/webshop/src/server.ts'])).toBe(
      'sites/webshop',
    );
    expect(
      detectStoreRoot([
        'package.json',
        'examples/deep/nested/site/src/server.ts',
        'apps/site/src/server.ts',
      ]),
    ).toBe('apps/site');
  });

  it('falls back to the nested package.json, the store-named or shortest one first', () => {
    expect(
      detectStoreRoot([
        'package.json',
        'README.md',
        'packages/site/package.json',
        'packages/site/index.js',
      ]),
    ).toBe('packages/site');
    expect(detectStoreRoot(['a/b/package.json', 'a/package.json'])).toBe('a');
    expect(detectStoreRoot(['apps/api/package.json', 'apps/store/package.json'])).toBe(
      'apps/store',
    );
  });

  it('is the root when nothing says otherwise', () => {
    expect(detectStoreRoot([])).toBe('');
    expect(detectStoreRoot(['README.md', 'docs/notes.md'])).toBe('');
    expect(detectStoreRoot(['package.json'])).toBe('');
  });

  it('tolerates backslashes and leading dots or slashes', () => {
    expect(detectStoreRoot(['./package.json', '.\\src\\server.ts'])).toBe('');
    expect(detectStoreRoot(['/apps/storefront/src/server.ts'])).toBe('apps/storefront');
  });
});
