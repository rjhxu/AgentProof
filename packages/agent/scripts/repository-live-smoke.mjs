import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Live integration test: all browser and API requests reach the actual servers.
// Requires web :3000, runner :4000, storefront :5000, and outbound GitHub access.
// Downloads octocat/Hello-World without credentials and removes its snapshot afterward.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifacts = path.join(root, 'data/artifacts/repository-smoke');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
let connectionUrl;

try {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });

  console.log(
    'LIVE PUBLIC REPOSITORY TEST: real Gamma, GitHub download, reload, and disconnect; no mocks or credentials.',
  );
  await page.goto('http://localhost:3000');
  const lookup = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/runs\/[^/]+\/repository$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Run Gamma test', exact: true }).click();
  const initial = await lookup;
  connectionUrl = initial.url();
  assert.equal(initial.status(), 200);
  assert.deepEqual(await initial.json(), { repository: null });
  const runId = new URL(connectionUrl).pathname.split('/')[2];
  const runResponse = await page.request.get(`http://localhost:4000/runs/${runId}`);
  assert.equal(runResponse.status(), 200);
  const { run } = await runResponse.json();
  assert.equal(run.agent.kind, 'gamma_structured');
  assert.equal(run.status, 'failed', 'Gamma must detect the planted hoodie bug');

  await page
    .getByLabel('GitHub repository URL', { exact: true })
    .fill('https://github.com/octocat/Hello-World');
  assert.equal(await page.getByLabel('GitHub access token').inputValue(), '');
  await page.getByRole('checkbox', { name: /I allow AgentProof/ }).check();
  const connecting = page.waitForResponse(
    (response) => response.url() === connectionUrl && response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  const connected = await connecting;
  assert.equal(
    connected.status(),
    200,
    `Public repository connection failed: ${await connected.text()}`,
  );
  const { repository } = await connected.json();
  assert.equal(repository.fullName, 'octocat/Hello-World');
  assert(repository.files.includes('README'), 'The downloaded GitHub source should contain README');
  assert(repository.commitSha.match(/^[a-f0-9]{40,64}$/));
  await page.getByRole('heading', { name: 'Repository connected', exact: true }).waitFor();
  assert.equal(
    new URL(page.url()).searchParams.get('run'),
    runId,
    'The URL must preserve the run for reload',
  );

  await page.reload();
  await page.getByRole('heading', { name: 'Repository connected', exact: true }).waitFor();
  await page.getByRole('link', { name: 'octocat/Hello-World', exact: true }).waitFor();
  await page.getByText(repository.commitSha, { exact: true }).waitFor();
  await page
    .getByText(`Preview repository files · ${repository.fileCount} tracked`, { exact: true })
    .click();
  await page.getByText('README', { exact: true }).waitFor();
  assert.deepEqual((await page.getByRole('alert').allTextContents()).filter(Boolean), []);
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'live-public.png'), fullPage: true });

  const disconnecting = page.waitForResponse(
    (response) => response.url() === connectionUrl && response.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Disconnect repository', exact: true }).click();
  const disconnected = await disconnecting;
  assert.equal(
    disconnected.status(),
    200,
    'The real browser DELETE request must succeed across origins',
  );
  assert.deepEqual(await disconnected.json(), { repository: null });
  await page.getByRole('heading', { name: 'Connect your Git repository', exact: true }).waitFor();
  await page.getByLabel('GitHub repository URL', { exact: true }).waitFor();
  assert.deepEqual((await page.getByRole('alert').allTextContents()).filter(Boolean), []);
  const final = await page.request.get(connectionUrl);
  assert.equal(final.status(), 200);
  assert.deepEqual(await final.json(), { repository: null });
  assert.deepEqual(errors, [], 'The real flow must produce no browser or network errors');
  console.log(
    `PASS: live Gamma failure, public GitHub source download (${repository.defaultBranch}, ${repository.commitSha}), saved run/connection reload, README preview, and real browser disconnect.`,
  );
  console.log(`Screenshot: ${path.join(artifacts, 'live-public.png')}`);
} finally {
  try {
    if (connectionUrl) {
      const cleanup = await page.request.delete(connectionUrl);
      assert.equal(cleanup.status(), 200, 'Final cleanup must remove any live repository snapshot');
    }
  } finally {
    await browser.close();
  }
}
