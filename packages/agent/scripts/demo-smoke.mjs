import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Requires all three dev servers. Restores the planted bug after checking the UI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cartFile = path.join(root, 'apps/storefront/src/cart.ts');
const before = await fs.readFile(cartFile, 'utf8');
const buggy = "  'HOODIE-001-M': 'HOODIE-001-S', // BUG: should be HOODIE-001-M";
const fixed =
  "  'HOODIE-001-M': 'HOODIE-001-M', // Repaired: preserve the requested medium variant";
assert(
  before.includes(buggy),
  'Restore the planted hoodie mapping before running this smoke test.',
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost:3000');
  await page.getByRole('button', { name: 'Run Gamma test', exact: true }).click();
  const inspect = page.getByRole('button', {
    name: 'Inspect failure & propose repair',
    exact: true,
  });
  await inspect.waitFor({ timeout: 30_000 });
  await page.getByText('HOODIE-001-S', { exact: true }).waitFor();
  await inspect.click();
  const apply = page.getByRole('button', { name: 'Apply reviewed repair', exact: true });
  await apply.waitFor();
  await apply.click();
  const rerun = page.getByRole('button', { name: 'Run rematch', exact: true });
  await rerun.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent === 'Run rematch' && !b.disabled,
    ),
  );
  await rerun.click();
  await page
    .getByRole('heading', { name: 'Before / after comparison', exact: true })
    .waitFor({ timeout: 30_000 });
  assert.match(await page.locator('main').innerText(), /2 checkpoints improved.*0 regressed/);
  await page.getByText('HOODIE-001-M', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('main').getByRole('alert').allTextContents(), []);
  const artifacts = path.join(root, 'data/artifacts/demo-smoke');
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile layout overflows the viewport',
  );
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Browser errors');
  console.log('PASS: live failure, evidence, repair, passing rematch, comparison, mobile layout.');
} finally {
  await browser.close();
  const current = await fs.readFile(cartFile, 'utf8');
  if (current === before.replace(buggy, fixed)) await fs.writeFile(cartFile, before);
  else assert.equal(current, before, 'Source changed unexpectedly; leaving it untouched.');
}
