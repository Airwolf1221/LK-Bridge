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

/**
 * Clicks a link in the main navigation (v3 F3c). If its sidebar group is closed, the group's button is clicked first,
 * as the owner would.
 */
async function goTo(page: Page, name: string | RegExp, exact = false) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  const link = nav.getByRole('link', { name, exact, includeHidden: true });
  if (!(await link.isVisible())) {
    const inGroup = page.getByRole('link', { name, exact, includeHidden: true });
    const toggle = nav.locator('li.nav-group', { has: inGroup }).locator('button.nav-group-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await link.click();
}

/**
 * ADR 0062: a sensitive change (a setting, a key) asks for the step-up in a dialog: without an authenticator, the
 * password. The change then goes on by itself.
 */
async function stepUp(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

/** The browser's record of the one refusal that asked for the step-up (403 REAUTH_REQUIRED) on `method path`. */
const stepUpRefusal = (method: string, path: RegExp) => (p: string) =>
  new RegExp(`HTTP 403 ${method} .*${path.source}$`).test(p) || /status of 403 \(Forbidden\)$/.test(p);

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
    ['Packs', 'Packs'], // v3 F3a; under Setup since v3 F3c
    ['Evaluation', 'Evaluation'], // v3 F3c: its own page
    ['Projects', 'Projects'],
    ['Repository Tree', 'Repository Tree'], // v2 A2
    ['Asset Tree', 'Asset Tree'], // v2 A4
    ['Account', 'Account'], // OPS2
  ] as const) {
    await goTo(page, new RegExp(`^${name}`));
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
  await goTo(page, /^Projects/);
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
  await goTo(page, 'Concurrent Writers', true);
  await expect(page.locator('[data-slot][data-state="busy"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-slot][data-state="busy"]')).toContainText('replaceDocumentBlocks');
  await expect(page.getByTestId('writes-per-minute')).not.toHaveText('0', { timeout: 10_000 });

  // WRITERS_MAX changes without a restart (a setting: the step-up first, ADR 0062).
  await page.getByLabel('Writer slots').selectOption('3');
  await page.getByRole('button', { name: 'Apply' }).click();
  await stepUp(page);
  await expect(page.locator('[data-slot]')).toHaveCount(3);

  // Budgets: the writes gauge has moved.
  await goTo(page, 'Request Budgets', true);
  const gauge = page.locator('[data-tier="write-min"] .gauge-figure');
  await expect(gauge).not.toContainText(/^0 \//, { timeout: 10_000 });

  // The job finishes; it moves to history.
  await goTo(page, 'Jobs', true);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator(`tr[data-job="${jobId}"]`)).toContainText('Succeeded', { timeout: 30_000 });
  const expected = stepUpRefusal('PUT', /\/api\/admin\/writers\/max/);
  expect(problems.filter((p) => /HTTP 403/.test(p))).toHaveLength(1);
  expect(problems.filter((p) => !expected(p))).toEqual([]);
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

  // CR-2026-11-R4: approving this proposal (an lk_api_write document replace that drops the page's block, a delete for
  // the rails, ADR 0057 decision 4) needs the step-up (ADR 0062 decision 5). The token is made first: it asks for the
  // step-up, which then holds for 10 minutes, so the approval below goes through without asking again.
  await goTo(page, 'Clients & Access', true);
  await page.getByLabel('Name', { exact: true }).fill('Playwright laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  await stepUp(page); // ADR 0062: a token is a key
  const token = (await page.getByTestId('pat-token').textContent()) ?? '';
  expect(token).toMatch(/^lkb_pat_/);
  await page.getByRole('button', { name: 'I have copied it' }).click();
  await expect(page.getByTestId('pat-token')).toHaveCount(0);
  await page.reload();
  expect(await page.content()).not.toContain(token);

  await goTo(page, /^Proposals/);
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
  const expected = stepUpRefusal('POST', /\/api\/admin\/clients\/pats/);
  expect(problems.filter((p) => /HTTP 403/.test(p))).toHaveLength(1);
  expect(problems.filter((p) => !expected(p))).toEqual([]);
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

// v3 F3c (ADR 0051 decision 4): the proposal is promote_page's (Working → Authoritative), the only way the C2c
// lifecycle guard lets a page become canon; the fixture used to write the Status row directly, which the guard refuses.
test('v2 C2a: a proposal that touches protected canon is approved only with "Approve and accept as canon"', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  const { proposalId } = (await (await request.get(`${CONTROL}/canon-proposal`)).json()) as {
    proposalId: string;
  };
  expect(proposalId).toMatch(/^prop_/);
  await signIn(page, `/ui/proposals?id=${proposalId}`);
  const affected = page.getByRole('region', { name: 'Pages affected' });
  await expect(affected).toContainText('[BWRK] Inae Mikumo: renamed to [BSRC] Inae Mikumo');
  await expect(affected).toContainText('moved under [INDEX] Characters');
  const banner = page.getByRole('alert', { name: 'Protected canon' });
  await expect(banner).toContainText('This changes protected canon.');
  await expect(banner).toContainText('Status would be set to Authoritative');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Approve and accept as canon' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('protected canon');
  await dialog.getByRole('button', { name: 'Approve and accept as canon' }).click();
  await expect(page.getByRole('alert', { name: 'Protected canon' })).toContainText(
    'Accepted as canon by owner',
    {
      timeout: 15_000,
    },
  );
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${CONTROL}/canon-status`)).json()) as { status: string }).status,
      {
        timeout: 15_000,
      },
    )
    .toBe('Authoritative');
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

// ADR 0062: the session cookie is SameSite=Strict, so a link to the dashboard from another site arrives without it. The
// bridge answers that arrival once with a page of its own that opens the address again, a same-origin navigation that
// carries the cookie: the owner stays signed in.
test('ADR 0062: a link from another site opens the dashboard signed in (the Strict cookie, bounced once)', async ({
  page,
}) => {
  const problems = watch(page);
  await signIn(page, '/ui/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => /lkb_session$/.test(c.name));
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.httpOnly).toBe(true);
  // About 30 days ahead (a sliding session).
  expect(cookie!.expires * 1000 - Date.now()).toBeGreaterThan(29 * 86_400_000);

  const elsewhere = 'http://elsewhere.example.test/';
  await page.route(elsewhere, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Elsewhere</title><a id="go" href="http://127.0.0.1:${PORT}/ui/budgets">LK-Bridge</a>`,
    }),
  );
  await page.goto(elsewhere);
  const arrivals: string[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.url().includes('/ui/budgets')) arrivals.push(r.url());
  });
  await page.click('#go');
  await expect(page).toHaveURL(/\/ui\/budgets$/);
  await expect(page.getByRole('heading', { name: 'Request Budgets' })).toBeVisible();
  // Once without the cookie (cross-site: bounced), once with it (same-origin): never a third time.
  expect(arrivals).toHaveLength(2);
  expect(problems).toEqual([]);
});

test('v3 F5a: the Proposals page filters, selects and rejects in bulk with one confirmation (no step-up)', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  const ids: string[] = [];
  for (const text of ['Bulk one', 'Bulk two'])
    ids.push(
      (
        (await (await request.get(`${CONTROL}/proposal?text=${encodeURIComponent(text)}`)).json()) as {
          proposalId: string;
        }
      ).proposalId,
    );
  await signIn(page, '/ui/proposals');
  const filters = page.getByRole('search', { name: 'Filter proposals' });
  await expect(filters).toBeVisible();
  await filters.getByLabel('Age').selectOption('');
  for (const id of ids) await expect(page.locator(`tr[data-proposal="${id}"]`)).toBeVisible();
  // Keyboard: tick each with the space bar.
  for (const id of ids) {
    await page.locator(`tr[data-proposal="${id}"]`).getByRole('checkbox').focus();
    await page.keyboard.press('Space');
  }
  const bar = page.getByRole('group', { name: 'Bulk actions' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Reject selected' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reject all' }).click();
  await expect(page.getByRole('region', { name: 'Bulk results' })).toContainText('Rejected');
  for (const id of ids) await expect(page.locator(`tr[data-proposal="${id}"]`)).toHaveCount(0);
  // Rejecting is a brake: no step-up was asked.
  expect(problems.filter((p) => /HTTP 403/.test(p))).toEqual([]);
  expect(problems).toEqual([]);
});

// ============================================================================================ v3 F5b (ADR 0068)

test('v3 F5b: "Pause all automation" is one click; resuming asks for the step-up', async ({ page }) => {
  const problems = watch(page);
  await signIn(page, '/ui');
  await goTo(page, 'Automation', true);
  await expect(page.getByRole('heading', { name: 'Automation', level: 1 })).toBeVisible();
  const brake = page.getByRole('region', { name: 'Pause all automation' });
  await brake.getByRole('button', { name: 'Pause all automation' }).click();
  // A brake: no confirmation, no step-up.
  await expect(brake.getByRole('status')).toContainText('Paused');
  expect(problems.filter((p) => /HTTP 403/.test(p))).toEqual([]);
  await brake.getByRole('button', { name: 'Resume automation' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Resume' }).click();
  await stepUp(page);
  await expect(brake.getByText('Running')).toBeVisible();
  const expected = stepUpRefusal('POST', /\/api\/admin\/automation\/resume\?project=test/);
  expect(problems.filter((p) => /HTTP 403/.test(p))).toHaveLength(1);
  expect(problems.filter((p) => !expected(p))).toEqual([]);
});

test('v3 F5b: a code’s setting is changed with the step-up and recorded in Repository Automation', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  expect(await (await request.get(`${CONTROL}/automation-setup`)).json()).toEqual({ ok: true });
  await signIn(page, '/ui/automation');
  const row = page.locator('tr[data-code="blank_paragraphs"]');
  await expect(row).toContainText('Decorative blank paragraphs');
  // Every code starts Off.
  await expect(row.locator('.badge').first()).toHaveText('Off');
  await row.getByLabel('Setting for Decorative blank paragraphs').selectOption('propose');
  await row.getByRole('button', { name: 'Change' }).click();
  const confirmDialog = page.getByRole('alertdialog');
  await expect(confirmDialog).toContainText('Approved Narrow Automations');
  await confirmDialog.getByRole('button', { name: 'Change the setting' }).click();
  await stepUp(page);
  await expect(row.locator('.badge').first()).toHaveText('Propose automatically', { timeout: 15_000 });
  // Back Off, by keyboard: the labelled select, then Tab to Change and Enter (the step-up holds for ten minutes on this
  // session, so it is not asked again).
  await row.getByLabel('Setting for Decorative blank paragraphs').selectOption('off');
  await row.getByLabel('Setting for Decorative blank paragraphs').focus();
  await page.keyboard.press('Tab');
  await expect(row.getByRole('button', { name: 'Change' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Change the setting' }).click();
  await expect(row.locator('.badge').first()).toHaveText('Off', { timeout: 15_000 });
  const expected = stepUpRefusal('POST', /\/api\/admin\/automation\/codes\/blank_paragraphs\?project=test/);
  expect(problems.filter((p) => /HTTP 403/.test(p))).toHaveLength(1);
  expect(problems.filter((p) => !expected(p))).toEqual([]);
});

test('v3 F5b: the Overview shows what automation did overnight, linking to Review and Proposals', async ({
  page,
  request,
}) => {
  const problems = watch(page);
  await request.get(`${CONTROL}/automation-fixture`);
  await signIn(page, '/ui');
  const tile = page.getByRole('region', { name: 'Automation overnight' });
  await expect(tile).toBeVisible();
  const applied = tile.locator('tr[data-code="blank_paragraphs"]');
  await expect(applied.getByRole('rowheader')).toHaveText('Decorative blank paragraphs');
  await expect(applied.getByRole('cell').first()).toHaveText('1');
  await expect(applied.getByRole('link', { name: '1 on the Review page' })).toBeVisible();
  const proposed = tile.locator('tr[data-code="out_of_order"]');
  await expect(proposed.getByRole('cell').nth(1)).toHaveText('2');
  await proposed.getByRole('link', { name: '1 proposal' }).click();
  await expect(page).toHaveURL(/\/ui\/proposals/);
  expect(problems).toEqual([]);
});

// ============================================================================================ v3 F5c (ADR 0069)

test('v3 F5c: the Workstreams page lists a workstream and opens its report', async ({ page, request }) => {
  const problems = watch(page);
  await request.get(`${CONTROL}/workstream-fixture`);
  await signIn(page, '/ui');
  await goTo(page, 'Workstreams', true);
  await expect(page.getByRole('heading', { name: 'Workstreams', level: 1 })).toBeVisible();
  const row = page.locator('tr[data-workstream="E2E stream"]');
  await expect(row.getByRole('rowheader')).toHaveText('E2E stream');
  await expect(row).toContainText('1 page written');
  // By keyboard: the labelled Report button.
  await row.getByRole('button', { name: 'Report of E2E stream' }).focus();
  await page.keyboard.press('Enter');
  const report = page.getByRole('region', { name: 'Report: E2E stream' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('heading', { name: /Written and verified \(1 pages?\)/ })).toBeVisible();
  await expect(report).toContainText('nothing was read from LegendKeeper');
  await report.getByRole('button', { name: 'Close the report' }).click();
  await expect(report).toHaveCount(0);
  expect(problems).toEqual([]);
});
