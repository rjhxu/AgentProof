import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Mock provider UI test: Gamma and repository GET requests use the live servers.
// Only repository POST/DELETE responses are fixtures; no GitHub access is exercised.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifacts = path.join(root, 'data/artifacts/repository-smoke');
const repositoryUrl = 'https://github.com/example/northwind-store';
const testToken = 'ghp_test_123';
const commit = 'a'.repeat(40);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  const posts = [];
  const tokenValuesAtRequest = [];
  let deletes = 0;
  let runId;

  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost:4000/runs/*/repository', async (route) => {
    const request = route.request();
    if (!['POST', 'DELETE'].includes(request.method())) return route.continue();

    const headers = { 'access-control-allow-origin': 'http://localhost:3000' };
    if (request.method() === 'DELETE') {
      deletes++;
      return route.fulfill({ status: 200, headers, json: { repository: null } });
    }

    posts.push(request.postDataJSON());
    tokenValuesAtRequest.push(await page.getByLabel('GitHub access token').inputValue());
    if (posts.length === 1) {
      return route.fulfill({
        status: 401,
        headers,
        json: {
          error: 'GitHub could not authenticate this token. Check repository access and try again.',
        },
      });
    }
    return route.fulfill({
      status: 200,
      headers,
      json: {
        repository: {
          id: 'repo_123456abcdef',
          runId,
          url: repositoryUrl,
          fullName: 'example/northwind-store',
          defaultBranch: 'main',
          commitSha: commit,
          connectedAt: new Date().toISOString(),
          files: [
            'README.md',
            'package.json',
            'apps/storefront/src/cart.ts',
            'apps/storefront/src/commerce/a-very-long-directory-name-to-check-mobile-repository-file-layout/product-variants.ts',
          ],
          fileCount: 4,
          truncated: false,
        },
      },
    });
  });

  console.log(
    'MOCK PROVIDER UI TEST: live Gamma + repository GET; fixture repository POST/DELETE only.',
  );
  await page.goto('http://localhost:3000');
  const connectionStatus = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/runs\/[^/]+\/repository$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Run Gamma test', exact: true }).click();
  const actualStatus = await connectionStatus;
  assert.equal(actualStatus.status(), 200, 'The live repository lookup should succeed');
  assert.deepEqual(await actualStatus.json(), { repository: null });
  runId = new URL(actualStatus.url()).pathname.split('/')[2];
  const actualRun = await page.request.get(`http://localhost:4000/runs/${runId}`);
  assert.equal(actualRun.status(), 200);
  const { run } = await actualRun.json();
  assert.equal(run.agent.kind, 'gamma_structured');
  assert.equal(run.status, 'failed', 'The live Gamma test must catch the planted variant bug');
  const failedCount = run.verification.checkpoints.filter(
    (checkpoint) => checkpoint.status === 'failed',
  ).length;
  assert(failedCount > 0);

  const panel = page.getByRole('region', { name: 'Connect your Git repository', exact: true });
  await panel.waitFor();
  await panel
    .getByText(`Gamma found ${failedCount} failed checkpoints.`, { exact: false })
    .waitFor();
  const url = page.getByLabel('GitHub repository URL', { exact: true });
  const token = page.getByLabel('GitHub access token');
  const consent = page.getByRole('checkbox', { name: /I allow AgentProof/ });
  const connect = page.getByRole('button', { name: 'Connect repository', exact: true });
  await url.waitFor();
  assert.equal(await token.getAttribute('type'), 'password');
  await url.fill(repositoryUrl);
  await token.fill(testToken);
  assert.equal(
    await connect.isDisabled(),
    true,
    'Connecting requires explicit source download consent',
  );
  await consent.check();
  assert.equal(await connect.isEnabled(), true);

  await connect.click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'GitHub could not authenticate this token.' })
    .waitFor();
  assert.equal(await token.inputValue(), '', 'Credentials must clear after a failed connection');
  assert(
    !(await page.locator('body').innerText()).includes(testToken),
    'The token must not appear in error text',
  );
  assert.deepEqual(posts[0], { url: repositoryUrl, token: testToken, consent: true });
  assert.equal(
    tokenValuesAtRequest[0],
    '',
    'The password input should clear before the request starts',
  );

  await token.fill(testToken);
  await connect.click();
  await page.getByRole('heading', { name: 'Repository connected', exact: true }).waitFor();
  assert.deepEqual(posts[1], { url: repositoryUrl, token: testToken, consent: true });
  assert.equal(
    tokenValuesAtRequest[1],
    '',
    'Credentials must clear on the successful connection attempt',
  );
  assert.equal(await token.count(), 0, 'The credential form is removed after connecting');
  assert.deepEqual(
    (await page.getByRole('alert').allTextContents()).filter(Boolean),
    [],
    'A successful retry clears the previous error',
  );
  await page.getByText('main', { exact: true }).waitFor();
  await page.getByText(commit, { exact: true }).waitFor();
  await page.getByText('Preview repository files · 4 tracked', { exact: true }).click();
  await page.getByText('apps/storefront/src/cart.ts', { exact: true }).waitFor();
  assert(
    !(await page.locator('body').innerText()).match(/Â·|â€™|â€¦/),
    'Visible text must not contain encoding artifacts',
  );

  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'The connected panel must fit a mobile viewport',
  );
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });

  await page.getByRole('button', { name: 'Disconnect repository', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect your Git repository', exact: true }).waitFor();
  assert.equal(deletes, 1);
  await page
    .getByText('Disconnected. The downloaded repository source has been removed.', { exact: true })
    .waitFor();
  assert.equal(await token.inputValue(), '', 'The returned form must not retain the token');
  assert.equal(await consent.isChecked(), false, 'A new connection requires fresh consent');
  assert.equal(await connect.isDisabled(), true);
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'The connection form must fit a mobile viewport',
  );

  // A public repository can be connected without supplying a token.
  await consent.check();
  await connect.click();
  await page.getByRole('heading', { name: 'Repository connected', exact: true }).waitFor();
  assert.deepEqual(posts[2], { url: repositoryUrl, consent: true });
  await page.getByRole('button', { name: 'Disconnect repository', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect your Git repository', exact: true }).waitFor();
  assert.equal(deletes, 2);
  const unchangedStatus = await page.request.get(`http://localhost:4000/runs/${runId}/repository`);
  assert.deepEqual(
    await unchangedStatus.json(),
    { repository: null },
    'Mocked provider actions must leave the live runner unchanged',
  );
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(
    'PASS: live Gamma failure; real empty connection lookup; mock consent, private-token error/retry, credential clearing, connected metadata/files, public access, disconnect, and mobile layout.',
  );
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
