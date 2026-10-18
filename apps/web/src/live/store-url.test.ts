import { describe, expect, it } from 'vitest';

import { normalizeStoreUrl } from './store-url';

describe('normalizeStoreUrl', () => {
  it('gives a bare host the http scheme', () => {
    expect(normalizeStoreUrl('localhost:5000')).toBe('http://localhost:5000');
    expect(normalizeStoreUrl('shop.example.com')).toBe('http://shop.example.com');
  });

  it('trims and drops the trailing slash, the query and the hash', () => {
    expect(normalizeStoreUrl(' https://shop.example.com/ ')).toBe('https://shop.example.com');
    expect(normalizeStoreUrl('https://shop.example.com/store/?utm=x#top')).toBe(
      'https://shop.example.com/store',
    );
    expect(normalizeStoreUrl('http://localhost:5000/shop///')).toBe('http://localhost:5000/shop');
    expect(normalizeStoreUrl('HTTP://Shop.Example.COM')).toBe('http://shop.example.com');
  });

  it('refuses anything that is not an http(s) URL', () => {
    expect(normalizeStoreUrl('ftp://x')).toBeUndefined();
    expect(normalizeStoreUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeStoreUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeStoreUrl('')).toBeUndefined();
    expect(normalizeStoreUrl('   ')).toBeUndefined();
    expect(normalizeStoreUrl('http://')).toBeUndefined();
    expect(normalizeStoreUrl('not a url')).toBeUndefined();
  });
});
