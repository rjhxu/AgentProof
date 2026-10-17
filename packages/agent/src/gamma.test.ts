import { describe, expect, it, vi } from 'vitest';
import { hoodieMission } from '@agentproof/shared/fixtures';
import { runGamma } from './gamma';

const variant = {
  id: 'HOODIE-001-M',
  attributes: { color: 'black', size: 'M' },
  price: 49,
  inStock: true,
};
const product = {
  id: 'HOODIE-001',
  slug: 'black-hoodie',
  name: 'Black Hoodie',
  category: 'apparel',
  basePrice: 49,
  variants: [variant],
};

function store(size: string) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    if (path === '/api/catalog.json')
      return Response.json(
        { products: [product] },
        { headers: { 'Set-Cookie': 'nw_session=isolated; Path=/; HttpOnly' } },
      );
    if (path === '/api/cart' && init?.method === 'POST') return Response.json({});
    if (path === '/api/cart')
      return Response.json({
        items: [
          {
            productId: product.id,
            variantId: 'HOODIE-001-' + size,
            name: product.name,
            attributes: { color: 'black', size },
            quantity: 1,
            unitPrice: 49,
          },
        ],
        subtotal: 49,
        currency: 'USD',
      });
    if (path === '/checkout')
      return new Response('<h1>Review your order</h1><form action="/checkout/place-order"></form>');
    throw new Error('Unexpected request: ' + path);
  });
  return { calls, fetcher };
}

describe('Gamma live commerce protocol', () => {
  it('detects the medium-to-small mismatch, with a session-preserving cart readback', async () => {
    const { calls, fetcher } = store('S');
    const result = await runGamma(hoodieMission, fetcher as typeof fetch);
    expect(result.checkpoints[0]?.status).toBe('failed');
    expect(result.cart?.items[0]?.attributes.size).toBe('S');
    expect(result.checkoutReached).toBe(true);
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ variantId: variant.id, quantity: 1 });
    expect(post.init?.headers).toMatchObject({ Cookie: 'nw_session=isolated' });
    expect(calls.some((c) => c.path === '/checkout/place-order')).toBe(false);
    expect(calls.every((c) => c.init?.redirect === 'error')).toBe(true);
  });

  it('passes when the same catalog variant is returned after repair', async () => {
    const { fetcher } = store('M');
    const result = await runGamma(hoodieMission, fetcher as typeof fetch);
    expect(result.checkpoints[0]?.status).toBe('passed');
  });

  it('fails without mutating a cart when nothing satisfies the budget', async () => {
    const { calls, fetcher } = store('M');
    const result = await runGamma(
      { ...hoodieMission, requirements: { ...hoodieMission.requirements, maxUnitPrice: 10 } },
      fetcher as typeof fetch,
    );
    expect(result.checkpoints[0]).toMatchObject({ id: 'product_discovered', status: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('blocks disallowed hosts before any request', async () => {
    const { fetcher } = store('M');
    await expect(
      runGamma({ ...hoodieMission, storeUrl: 'https://example.com' }, fetcher as typeof fetch),
    ).rejects.toThrow('not allowed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('treats an HTTP failure as an execution error, not a successful test', async () => {
    await expect(
      runGamma(hoodieMission, vi.fn(async () => new Response('', { status: 500 })) as typeof fetch),
    ).rejects.toThrow('HTTP 500');
  });
});
