/**
 * Quick manual check that the Claude key and Playwright browser both work.
 *   pnpm --filter @agentproof/agent smoke
 */
import { chromium } from 'playwright';
import { generateMission } from './mission-generator';

const storeUrl = process.env.STOREFRONT_URL ?? 'http://localhost:5000';

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  console.log('Playwright OK -', await page.title());
} catch (err) {
  console.log('Playwright launched, but the storefront is not reachable at', storeUrl, String(err));
} finally {
  await browser.close();
}

const mission = await generateMission(
  storeUrl,
  'Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.',
);
console.log('Claude OK - mission:', JSON.stringify(mission, null, 2));
