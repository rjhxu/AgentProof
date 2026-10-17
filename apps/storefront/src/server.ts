import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { addToCart, clearCart, getCart, resolveVariantId } from './cart';
import { findProductBySlug, findVariant, products } from './catalog';
import { cartPage, catalogPage, checkoutPage, layout, productPage } from './views';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STOREFRONT_PORT ?? 5000);
const SESSION_COOKIE = 'nw_session';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
await app.register(cookie);
await app.register(formbody);
await app.register(fastifyStatic, { root: path.join(here, '..', 'public'), prefix: '/static/' });

/** Every visitor gets a session cookie; carts hang off it. */
app.addHook('onRequest', async (req, reply) => {
  if (!req.cookies[SESSION_COOKIE]) {
    const id = randomUUID();
    reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'lax' });
    req.cookies[SESSION_COOKIE] = id;
  }
});
const sid = (req: { cookies: Record<string, string | undefined> }) => req.cookies[SESSION_COOKIE]!;

app.get('/health', async () => ({ ok: true, hoodieVariantId: resolveVariantId('HOODIE-001-M') }));

// ---- HTML pages -----------------------------------------------------------------
app.get('/', async (req, reply) => {
  reply
    .type('text/html')
    .send(layout('Shop', catalogPage(products), getCart(sid(req)).items.length));
});

app.get<{ Params: { slug: string } }>('/products/:slug', async (req, reply) => {
  const product = findProductBySlug(req.params.slug);
  if (!product)
    return reply
      .code(404)
      .type('text/html')
      .send(layout('Not found', '<h1>Product not found</h1>'));
  reply
    .type('text/html')
    .send(layout(product.name, productPage(product), getCart(sid(req)).items.length));
});

app.get('/cart', async (req, reply) => {
  const cart = getCart(sid(req));
  reply.type('text/html').send(layout('Cart', cartPage(cart), cart.items.length));
});

/**
 * Browser "Add to cart". Resolves the variant from the posted attribute values, which is
 * why human shoppers never go through the legacy id mapping that bites the API path.
 */
app.post<{ Body: Record<string, string> }>('/cart/add', async (req, reply) => {
  const { productId, quantity = '1', ...attrs } = req.body;
  const product = products.find((p) => p.id === productId);
  const variant = product?.variants.find((v) =>
    Object.entries(v.attributes).every(([k, val]) => attrs[k] === val),
  );
  if (!product || !variant) {
    return reply
      .code(400)
      .type('text/html')
      .send(layout('Error', '<h1>Could not add to cart</h1><p>Unknown variant.</p>'));
  }
  // Bypass resolveVariantId on purpose: pass the real id straight through.
  const result = addToCart(sid(req), variant.id, Math.max(1, Number(quantity) || 1));
  if ('error' in result) {
    return reply
      .code(400)
      .type('text/html')
      .send(layout('Error', `<h1>Could not add to cart</h1><p>${result.error}</p>`));
  }
  reply.redirect('/cart', 303);
});

app.post('/cart/clear', async (req, reply) => {
  clearCart(sid(req));
  reply.redirect('/cart', 303);
});

app.get('/checkout', async (req, reply) => {
  const cart = getCart(sid(req));
  if (cart.items.length === 0) return reply.redirect('/cart', 303);
  reply.type('text/html').send(layout('Checkout', checkoutPage(cart), cart.items.length));
});

app.post('/checkout/place-order', async (_req, reply) => {
  // Should never be reached by an AgentProof test. Logged loudly if it is.
  app.log.error('PLACE ORDER was submitted - the agent policy failed');
  reply
    .code(403)
    .type('text/html')
    .send(layout('Blocked', '<h1>Order placement is disabled on this test store.</h1>'));
});

// ---- Structured commerce interface (what Agent Gamma reads) ----------------------
app.get('/api/catalog.json', async () => ({
  store: 'Northwind Threads',
  currency: 'USD',
  products: products.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    basePrice: p.basePrice,
    url: `/products/${p.slug}`,
    variants: p.variants,
  })),
}));

app.get<{ Params: { id: string } }>('/api/variants/:id', async (req, reply) => {
  const hit = findVariant(req.params.id);
  if (!hit) return reply.code(404).send({ error: 'variant not found' });
  return { productId: hit.product.id, ...hit.variant };
});

app.get('/api/cart', async (req) => getCart(sid(req)));

/** Agent-facing add-to-cart by variant id. Goes through the legacy mapping (DEMO BUG B). */
app.post<{ Body: { variantId?: string; quantity?: number } }>('/api/cart', async (req, reply) => {
  const { variantId, quantity = 1 } = req.body ?? {};
  if (!variantId) return reply.code(400).send({ error: 'variantId required' });
  const result = addToCart(sid(req), variantId, Math.max(1, Number(quantity) || 1));
  if ('error' in result) return reply.code(400).send(result);
  return result;
});

app.delete('/api/cart', async (req) => {
  clearCart(sid(req));
  return getCart(sid(req));
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Northwind Threads storefront on http://localhost:${PORT}`);
