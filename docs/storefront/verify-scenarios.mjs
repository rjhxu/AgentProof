#!/usr/bin/env node
/**
 * Grades the Northwind Threads test store, scenario by scenario.
 *
 * For each scenario it runs two shoppers in fresh browser sessions and reads the resulting cart
 * from GET /api/cart:
 *   - agent: strictly semantic, like Agent Alpha. Finds controls only by ARIA role + exact
 *     accessible name (page.getByRole). Bug B uses the structured API instead (Agent Gamma).
 *   - human: clicks what is visible on screen (visible text, swatch colors, the "+" icon).
 *
 * Status per scenario:
 *   BUG PRESENT   agent got the known wrong cart (store as shipped)
 *   FIXED         agent got the correct cart
 *   UNEXPECTED    agent got some other cart (a fix half-worked, or something else broke)
 *   HUMAN BROKEN  the human shopper no longer gets the correct cart (a "fix" broke the UI)
 *
 * This file is the answer key in executable form. Keep it OUT of the storefront repo that a
 * code-fix agent works on.
 *
 * Usage:
 *   node docs/storefront/verify-scenarios.mjs                  # report; exit 1 on UNEXPECTED / HUMAN BROKEN
 *   node docs/storefront/verify-scenarios.mjs --expect=bugs    # also exit 1 unless every bug is present
 *   node docs/storefront/verify-scenarios.mjs --expect=fixed   # also exit 1 unless every bug is fixed
 *   node docs/storefront/verify-scenarios.mjs --only=C --json
 *   node docs/storefront/verify-scenarios.mjs --snapshot=black-hoodie   # what the agent sees
 *   STORE_URL=http://localhost:5050 node docs/storefront/verify-scenarios.mjs
 *
 * Needs Playwright with Chromium. Inside the AgentProof monorepo it borrows packages/agent's copy
 * (run `pnpm playwright:install` once). Elsewhere: `npm i -D playwright && npx playwright install chromium`.
 */
import { createRequire } from 'node:module';

function loadPlaywright() {
  const candidates = [
    import.meta.url, // a playwright install next to this script
    new URL('../../packages/agent/package.json', import.meta.url), // AgentProof monorepo
    `${process.cwd()}/package.json`, // the current project
  ];
  for (const from of candidates) {
    try {
      return createRequire(from)('playwright');
    } catch {}
  }
  console.error(
    'Playwright not found. Run `pnpm playwright:install` in AgentProof, or `npm i -D playwright`.',
  );
  process.exit(2);
}

const { chromium } = loadPlaywright();
const BASE = (process.env.STORE_URL ?? 'http://localhost:5000').replace(/\/$/, '');
const args = process.argv.slice(2);
const expect = args.find((a) => a.startsWith('--expect='))?.slice(9);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const asJson = args.includes('--json');

const NAVY = 'rgb(31, 53, 102)'; // #1f3566, the navy swatch fill

// ---- cart helpers --------------------------------------------------------------------------
const cartKey = (cart) =>
  cart.items.length ? cart.items.map((i) => `${i.variantId} x${i.quantity}`).join(', ') : '(empty)';

async function newSession(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const cart = async () => (await context.request.get(`${BASE}/api/cart`)).json();
  return { context, page, cart };
}

// ---- semantic shopper (role + exact accessible name only) ------------------------------------
async function byRole(page, role, name) {
  const loc = page.getByRole(role, { name, exact: true });
  return (await loc.count()) > 0 ? loc.first() : null;
}

/** Pick `value` for the option named `group`: radio "M", combobox "Size", or button "M". */
async function chooseOption(page, group, value) {
  const radio = await byRole(page, 'radio', value);
  if (radio) return void (await radio.check());
  const combo = await byRole(page, 'combobox', group);
  if (combo)
    return void (await combo.selectOption({ label: value }).catch(() => combo.selectOption(value)));
  const button = await byRole(page, 'button', value);
  if (button) return void (await button.click());
}

async function setQuantity(page, n) {
  const field = await byRole(page, 'spinbutton', 'Quantity');
  if (field) return void (await field.fill(String(n)));
  const plus = await byRole(page, 'button', 'Increase quantity');
  if (plus) for (let i = 1; i < n; i++) await plus.click();
}

async function agentShop(browser, { link, options = [], quantity }) {
  const { context, page, cart } = await newSession(browser);
  try {
    await page.goto(BASE);
    const product = await byRole(page, 'link', link);
    if (!product) return { cart: await cart(), checkout: false };
    await product.click();
    await page.waitForLoadState('domcontentloaded');
    for (const [group, value] of options) await chooseOption(page, group, value);
    if (quantity) await setQuantity(page, quantity);
    const add = await byRole(page, 'button', 'Add to cart');
    if (add) {
      await add.click();
      await page.waitForLoadState('domcontentloaded');
    }
    await page.goto(`${BASE}/cart`);
    const proceed = await byRole(page, 'link', 'Proceed to checkout');
    if (proceed) {
      await proceed.click();
      await page.waitForLoadState('domcontentloaded');
    }
    return { cart: await cart(), checkout: new URL(page.url()).pathname === '/checkout' };
  } finally {
    await context.close();
  }
}

// ---- human shopper (clicks what is visible; ignores the accessibility tree) -----------------
/** Mouse-click the middle of whatever shows `text`, the way a person would (whatever is on top gets it). */
async function clickVisibleText(page, text) {
  const target = page.locator('main').getByText(text, { exact: true }).filter({ visible: true });
  const box = await target.first().boundingBox();
  if (!box) throw new Error(`nothing visible reads "${text}"`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function humanShop(browser, slug, steps) {
  const { context, page, cart } = await newSession(browser);
  try {
    await page.goto(`${BASE}/products/${slug}`);
    await steps(page);
    await page
      .locator('main button', { hasText: 'Add to cart' })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForLoadState('domcontentloaded');
    return { cart: await cart() };
  } catch (err) {
    return { cart: await cart(), error: String(err.message).split('\n')[0] };
  } finally {
    await context.close();
  }
}

async function clickSwatchColored(page, rgb) {
  const handle = await page.evaluateHandle((color) => {
    for (const el of document.querySelectorAll('main *')) {
      const box = el.getBoundingClientRect();
      if (box.width > 10 && box.width < 80 && getComputedStyle(el).backgroundColor === color)
        return el;
    }
    return null;
  }, rgb);
  const el = handle.asElement();
  if (!el) throw new Error(`no visible swatch with color ${rgb}`);
  await el.click();
}

async function humanSetQuantity(page, n) {
  const input = page.locator('main input[type=number]').filter({ visible: true });
  if (await input.count()) return void (await input.first().fill(String(n)));
  const plus = page.locator('main button:has(svg path[d*="M12 5v14"])').filter({ visible: true });
  for (let i = 1; i < n; i++) await plus.first().click();
}

// ---- scenarios -------------------------------------------------------------------------------
const scenarios = [
  {
    id: 'Control',
    title: 'Canvas Tote, no bug',
    correct: 'TOTE-001-NAT x1',
    buggy: 'TOTE-001-NAT x1',
    agent: (b) => agentShop(b, { link: 'Canvas Tote' }),
  },
  {
    id: 'A',
    title: 'Black Hoodie size M (size chips)',
    correct: 'HOODIE-001-M x1',
    buggy: 'HOODIE-001-S x1',
    agent: (b) => agentShop(b, { link: 'Black Hoodie', options: [['Size', 'M']] }),
    human: (b) => humanShop(b, 'black-hoodie', (p) => clickVisibleText(p, 'M')),
  },
  {
    id: 'B',
    title: 'HOODIE-001-M via POST /api/cart (legacy id map)',
    correct: 'HOODIE-001-M x1',
    buggy: 'HOODIE-001-S x1',
    agent: async (b) => {
      const { context, cart } = await newSession(b);
      try {
        await context.request.get(`${BASE}/`);
        await context.request.post(`${BASE}/api/cart`, {
          data: { variantId: 'HOODIE-001-M', quantity: 1 },
        });
        return { cart: await cart(), checkout: null };
      } finally {
        await context.close();
      }
    },
  },
  {
    id: 'C',
    title: 'Crewneck navy L (swatch names)',
    correct: 'CREW-001-NVY-L x1',
    buggy: 'CREW-001-FOR-L x1',
    agent: (b) =>
      agentShop(b, {
        link: 'Crewneck Sweatshirt',
        options: [
          ['Color', 'Navy'],
          ['Size', 'L'],
        ],
      }),
    human: (b) =>
      humanShop(b, 'crewneck-sweatshirt', async (p) => {
        await clickSwatchColored(p, NAVY);
        await clickVisibleText(p, 'L');
      }),
  },
  {
    id: 'D',
    title: 'Merino socks M x3 (quantity stepper)',
    correct: 'SOCK-001-M x3',
    buggy: 'SOCK-001-M x1',
    agent: (b) =>
      agentShop(b, { link: 'Merino Crew Socks', options: [['Size', 'M']], quantity: 3 }),
    human: (b) =>
      humanShop(b, 'merino-socks', async (p) => {
        await clickVisibleText(p, 'M');
        await humanSetQuantity(p, 3);
      }),
  },
  {
    id: 'E',
    title: 'Studio Headphones wired (hidden buy box)',
    correct: 'HP-100-WIRED x1',
    buggy: '(empty)',
    agent: (b) => agentShop(b, { link: 'Studio Headphones', options: [['Connectivity', 'Wired']] }),
    human: (b) => humanShop(b, 'studio-headphones', (p) => clickVisibleText(p, 'Wired')),
  },
];

// ---- run -------------------------------------------------------------------------------------
const browser = await chromium.launch();

// --snapshot=<slug>: print what a semantic agent sees on that product page (or "home"), then exit.
const snapshotSlug = args.find((a) => a.startsWith('--snapshot='))?.slice(11);
if (snapshotSlug) {
  const page = await browser.newPage();
  await page.goto(snapshotSlug === 'home' ? BASE : `${BASE}/products/${snapshotSlug}`);
  console.log(await page.locator('main').ariaSnapshot());
  await browser.close();
  process.exit(0);
}
const results = [];
try {
  const probe = await fetch(`${BASE}/api/catalog.json`).catch(() => null);
  if (!probe?.ok) {
    console.error(`Store not reachable at ${BASE}. Start it, or set STORE_URL.`);
    process.exit(2);
  }
  for (const s of scenarios) {
    if (only && s.id.toLowerCase() !== only.toLowerCase()) continue;
    const agent = await s.agent(browser);
    const human = s.human ? await s.human(browser) : null;
    const got = cartKey(agent.cart);
    let status =
      s.id === 'Control'
        ? got === s.correct
          ? 'OK'
          : 'CONTROL BROKEN'
        : got === s.correct
          ? 'FIXED'
          : got === s.buggy
            ? 'BUG PRESENT'
            : 'UNEXPECTED';
    const humanCart = human ? cartKey(human.cart) : null;
    if (human && humanCart !== s.correct) status = 'HUMAN BROKEN';
    results.push({
      id: s.id,
      title: s.title,
      status,
      agentCart: got,
      agentReachedCheckout: agent.checkout,
      humanCart,
      humanError: human?.error,
      expected: s.correct,
    });
  }
} finally {
  await browser.close();
}

if (asJson) {
  console.log(JSON.stringify({ store: BASE, results }, null, 2));
} else {
  console.log(`Store: ${BASE}\n`);
  const rows = results.map((r) => [
    r.id,
    r.status,
    r.agentCart + (r.agentReachedCheckout === false ? ' (no checkout)' : ''),
    r.humanCart ?? '-',
    r.expected,
  ]);
  const head = ['Scenario', 'Status', 'Agent cart', 'Human cart', 'Correct cart'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  for (const r of results)
    if (r.humanError) console.log(`\n${r.id} human shopper: ${r.humanError}`);
}

const bad = results.filter((r) =>
  ['UNEXPECTED', 'HUMAN BROKEN', 'CONTROL BROKEN'].includes(r.status),
);
const scored = results.filter((r) => r.id !== 'Control');
const unmet =
  expect === 'bugs'
    ? scored.filter((r) => r.status !== 'BUG PRESENT')
    : expect === 'fixed'
      ? scored.filter((r) => r.status !== 'FIXED')
      : [];
process.exit(bad.length || unmet.length ? 1 : 0);
