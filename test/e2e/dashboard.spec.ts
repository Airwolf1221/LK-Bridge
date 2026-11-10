import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8799);
const CONTROL = `http://127.0.0.1:${PORT + 1}`;
const PASSWORD = 'e2e-password-not-a-secret';

/** Records anything the browser's Content-Security-Policy refuses, and any uncaught page error. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /content security policy|refused to/i.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.status() !== 401)
      problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

async function signIn(page: Page, path = '/ui') {
  await page.goto(path);
  await expect(page).toHaveURL(/\/oauth\/login\?return_to=/);
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signs in, comes back to where it was going, and every page renders under the strict CSP', async ({
  page,
}) => {
  const problems = watch(page);
  await signIn(page, '/ui/budgets');
  await expect(page).toHaveURL(/\/ui\/budgets$/);
  await expect(page.getByRole('heading', { name: 'Request Budgets' })).toBeVisible();
  await expect(page.locator('[data-tier="write-min"]')).toBeVisible();
  await expect(page.locator('[data-tier="upload"]')).toContainText('reactive only');

  for (const [name, heading] of [
    ['Overview', 'Overview'],
    ['Jobs', 'Jobs'],
    ['Errors', 'Errors'],
    ['Concurrent Writers', 'Concurrent Writers'],
    ['Proposals', 'Proposals'],
    ['Clients & Access', 'Clients & Access'],
    ['Journal', 'Journal'],
    ['Settings', 'Settings'],
    ['Maintenance Jobs', 'Maintenance Jobs'],
    ['Repository Mappings', 'Repository Mappings'],
    ['Projects', 'Projects'],
    ['Repository Tree', 'Repository Tree'], // v2 A2
    ['Asset Tree', 'Asset Tree'], // v2 A4
    ['Account', 'Account'], // OPS2
  ] as const) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: new RegExp(`^${name}`) })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  await expect(page.getByRole('status', { name: /Live updates: Live/ })).toBeVisible();

  // The headers really are on the document.
  const res = await page.request.get('/ui');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(problems).toEqual([]);
});

test('OPS2: the Account page asks for the password again, then draws the authenticator QR code under the CSP', async ({
  page,
}) => {
  const problems = watch(page);
  await signIn(page, '/ui/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up the authenticator…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  expect(Number(await qr.getAttribute('data-modules'))).toBeGreaterThanOrEqual(33);
  // Nothing was fetched for it: the code is drawn in the page.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(qr).toBeHidden();
  // The Projects page offers to add a project with a write-only key field.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Projects/ })
    .click();
  await page.getByRole('button', { name: 'Add a project…' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('type', 'password');
  // The one refusal is the bridge asking for the password again (403 REAUTH_REQUIRED), which opened the dialog.
  const expected = (p: string) =>
    /HTTP 403 POST .*\/api\/admin\/security\/totp\/enrol$/.test(p) || /status of 403 \(Forbidden\)$/.test(p);
  expect(problems.filter((p) => /HTTP 403 POST/.test(p))).toHaveLength(1);
  expect(problems.filter((p) => !expected(p))).toEqual([]);
});

test('a job runs while the Jobs, Budgets and Writers pages update live', async ({ page, request }) => {
  const problems = watch(page);
  await signIn(page, '/ui/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();

  const started = await request.get(`${CONTROL}/job?steps=5&title=Live%20E2E%20job`);
  const { jobId } = (await started.json()) as { jobId: string };
  expect(jobId).toBeTruthy();

  // Jobs: the row appears by itself and its progress moves.
  const row = page.locator(`tr[data-job="${jobId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Live E2E job');
  await expect(row.getByText(/[1-4] \/ 5 steps/)).toBeVisible({ timeout: 15_000 });

  // Writers: a slot is busy with the job while it runs.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Concurrent Writers', exact: true })
    .click();
  await expect(page.locator('[data-slot][data-state="busy"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-slot][data-state="busy"]')).toContainText('replaceDocumentBlocks');
  await expect(page.getByTestId('writes-per-minute')).not.toHaveText('0', { timeout: 10_000 });

  // WRITERS_MAX changes without a restart.
  await page.getByLabel('Writer slots').selectOption('3');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('[data-slot]')).toHaveCount(3);

  // Budgets: the writes gauge has moved.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Request Budgets', exact: true })
    .click();
  const gauge = page.locator('[data-tier="write-min"] .gauge-figure');
  await expect(gauge).not.toContainText(/^0 \//, { timeout: 10_000 });

  // The job finishes; it moves to history.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator(`tr[data-job="${jobId}"]`)).toContainText('Succeeded', { timeout: 30_000 });
  expect(problems).toEqual([]);
});

test('reviews a proposal as a readable diff and approves it; a token is shown once', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  const { proposalId } = (await (
    await request.get(`${CONTROL}/proposal?text=A%20brand%20new%20opening`)
  ).json()) as { proposalId: string };
  await signIn(page, '/ui/proposals');
  const row = page.locator(`tr[data-proposal="${proposalId}"]`);
  await expect(row).toContainText('Scribe');
  await row.getByRole('button', { name: 'Review' }).click();
  const diff = page.getByRole('group', { name: /Changes to/ });
  await expect(diff.locator('[data-kind="add"]').first()).toContainText('A brand new opening');
  await expect(diff.locator('[data-kind="del"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator(`tr[data-proposal="${proposalId}"]`)).toContainText(/Execut/, {
    timeout: 15_000,
  });

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Clients & Access', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Playwright laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.getByTestId('pat-token').textContent()) ?? '';
  expect(token).toMatch(/^lkb_pat_/);
  await page.getByRole('button', { name: 'I have copied it' }).click();
  await expect(page.getByTestId('pat-token')).toHaveCount(0);
  await page.reload();
  expect(await page.content()).not.toContain(token);
  expect(problems).toEqual([]);
});

test('v2 C1: a write_page proposal shows its Markdown diff, keep regions as placeholders, and is verified once approved', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  const { proposalId } = (await (await request.get(`${CONTROL}/page-proposal`)).json()) as {
    proposalId: string;
  };
  expect(proposalId).toMatch(/^prop_/);
  await signIn(page, `/ui/proposals?id=${proposalId}`);
  const section = page.getByRole('region', { name: 'Page write' });
  await expect(section).toContainText('replace_section of “Biography” on Asagiri Miyabi');
  const md = section.getByRole('group', { name: 'Markdown changes, part 1' });
  await expect(md.locator('[data-kind="add"]')).toContainText('Born at dawn on Kumikas 1st, 4A 881.');
  await expect(md.locator('[data-kind="del"]')).toContainText('Born on Kumikas 1st, 4A 881.');
  await expect(md).toContainText('[keep region: infobox mib1]');
  // The block-level diff is still shown.
  await expect(page.getByRole('group', { name: /Changes to/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('region', { name: 'Page write' })).toContainText('Written and verified', {
    timeout: 15_000,
  });
  expect(problems).toEqual([]);
});

test('is usable on a phone, in the dark', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const problems = watch(page);
  await signIn(page, '/ui');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const overflow = await page.evaluate(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/phone-dark-overview.png', fullPage: true });
  expect(problems).toEqual([]);
  await context.close();
});
