/**
 * CR-2026-11-R4 (ADR 0062 decision 5; the review's SE-02 to SE-04b): the consent page asks for the step-up, on the page
 * itself, before a choice that lets a connection do more (an existing profile's scope raised, a new profile above the
 * default scope, a connection on a profile at scope `write`), and goes on with the same pending request once it
 * succeeds. The step-up is the authenticator code (or a recovery code), or the password without one; it is counted
 * against the sign-in limits, logged and audited as the dashboard's is, and holds on the session for the window (ADR 0081:
 * `AUTH_STEP_UP_WINDOW_SECONDS`, 12 hours). An
 * ordinary connection at `read` or `propose`, a lowering, and a session that stepped up within the window are not asked.
 * The refusals themselves are the review's (test/review/r4-sessions/consent-stepup.test.ts). Mocks only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { totp } from '../../src/auth/totp.js';
import {
  Browser,
  type ConsentPage,
  type TestBridge,
  authorizeUrl,
  formBody,
  logEvents,
  pkcePair,
  reachConsent,
  registerPublicClient,
  startBridge,
  tokenRequest,
} from './helpers.js';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';

let bridge: TestBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

interface Consent {
  readonly page: ConsentPage;
  readonly clientId: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

/** The consent page of a new client, in a browser signed in already. */
async function consent(b: TestBridge, browser: Browser, redirectUri: string): Promise<Consent> {
  const clientId = await registerPublicClient(b, [redirectUri]);
  const { verifier, challenge } = pkcePair();
  const page = await reachConsent(
    browser,
    authorizeUrl({ clientId, redirectUri, challenge, method: 'S256', resource: b.mcpUrl }, browser.base),
  );
  if (page instanceof Response) throw new Error(`no consent page: ${page.status} ${await page.text()}`);
  return { page, clientId, verifier, redirectUri };
}

/** Posts the consent form (repeated `replace` fields allowed), as the page's own form would. */
const post = (browser: Browser, c: Consent, fields: Record<string, string | string[]>) =>
  browser.request(`${browser.base}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ request_id: c.page.requestId, csrf_token: c.page.csrf, decision: 'approve', ...fields }),
  });

const codeOf = (res: Response): string | null => {
  const loc = res.headers.get('location');
  return res.status === 303 && loc ? new URL(loc).searchParams.get('code') : null;
};

const exchange = (b: TestBridge, c: Consent, code: string) =>
  tokenRequest(b, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.redirectUri,
    code_verifier: c.verifier,
    client_id: c.clientId,
    resource: b.mcpUrl,
  });

const reauthAt = (b: TestBridge, browser: Browser) =>
  (
    b.db
      .prepare('SELECT reauth_at FROM auth_owner_sessions WHERE session_hash = ?')
      .get(b.services.sessionHash(browser.cookies.get(b.services.owner.sessionCookie)!)) as {
      reauth_at: number | null;
    }
  ).reauth_at;

const stepUpAudits = (b: TestBridge) =>
  b.policy.commands.listAudit('owner', { action: 'owner.reauth' }).map((a) => a.after);

describe('the step-up on the consent page', () => {
  it('a raise: the page asks; a wrong password keeps it there, changing nothing; the right one goes on with the same request', async () => {
    const b = (bridge = await startBridge());
    const p = b.policy.commands.createProfile('owner', { label: 'r4 raise', kind: 'chatgpt', scope: 'read' });
    const browser = new Browser(b);
    expect((await browser.login()).status).toBe(200);
    const c = await consent(b, browser, CHATGPT);
    expect((await post(browser, c, { profile: p.id, scope: 'write' })).status).toBe(200); // Confirm scope change
    const confirmed = { profile: p.id, scope: 'write', confirm_scope_change: `${p.id}:read:write` };

    const asked = await post(browser, c, confirmed);
    expect(asked.status).toBe(200);
    const html = await asked.text();
    expect(html).toContain('<h1>Confirm it’s you</h1>');
    expect(html).toContain('This raises the scope of profile “r4 raise” from read to write.');
    expect(html).toContain('name="stepup_password"');
    expect(html).not.toContain('name="stepup_totp"');
    // The choice is carried through unchanged, with the same request and its form token.
    for (const [k, v] of Object.entries({
      ...confirmed,
      request_id: c.page.requestId,
      csrf_token: c.page.csrf,
    }))
      expect(html).toContain(`name="${k}" value="${v}"`);
    expect(html).toContain('formnovalidate'); // Deny needs no password
    expect(html).not.toMatch(/<script/i);
    expect(logEvents(b, 'consent.step_up_asked')).toHaveLength(1);

    const wrong = await post(browser, c, { ...confirmed, stepup_password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Those details were not recognised.');
    expect(codeOf(wrong)).toBeNull();
    expect(b.policy.store.getProfile(p.id)!.scope).toBe('read');
    expect(reauthAt(b, browser)).toBeNull();

    const done = await post(browser, c, { ...confirmed, stepup_password: b.password });
    const code = codeOf(done);
    expect(code, `${done.status} ${await done.clone().text()}`).toBeTruthy();
    expect(b.policy.store.getProfile(p.id)!.scope).toBe('write');
    expect(reauthAt(b, browser)).not.toBeNull(); // the session has stepped up (for 12 hours)
    expect(stepUpAudits(b)).toEqual([
      { ok: true, via: 'consent' },
      { ok: false, reason: 'invalid', via: 'consent' },
    ]);
    expect(logEvents(b, 'reauth.succeeded')).toHaveLength(1);
    expect(logEvents(b, 'reauth.failed')).toHaveLength(1);
    const t = await exchange(b, c, code!);
    expect(t.res.status).toBe(200);
    // The request was answered once: posting it again is refused.
    expect((await post(browser, c, { ...confirmed, stepup_password: b.password })).status).toBe(400);
  });

  it('with the authenticator, its code (never the password); a new profile above the default; the window then holds for 12 hours', async () => {
    const b = (bridge = await startBridge({ totp: true }));
    const secret = b.totpSecret!;
    const browser = new Browser(b);
    expect((await browser.login('', { totp: totp(secret, b.clock.now()) })).status).toBe(200);
    const c = await consent(b, browser, CLAUDE);
    const choice = { profile: 'new', new_label: 'r4 writer', new_kind: 'claude', scope: 'write' };

    const asked = await post(browser, c, choice);
    expect(asked.status).toBe(200);
    const html = await asked.text();
    expect(html).toContain('This makes a new profile “r4 writer” at scope write.');
    expect(html).toContain('New connections start at read, the default.');
    expect(html).toContain('name="stepup_totp"');
    expect(html).not.toContain('name="stepup_password"');
    expect(html).toContain('checked within the last 12 hours'); // ADR 0081: the window, from the setting
    expect(b.policy.store.getProfileByLabel('r4 writer')).toBeUndefined();

    // The password is not the step-up once the authenticator is set up, in either field.
    for (const f of [{ stepup_totp: b.password }, { stepup_password: b.password }]) {
      const r = await post(browser, c, { ...choice, ...f });
      expect(r.status, JSON.stringify(Object.keys(f))).toBe(401);
      expect(b.policy.store.getProfileByLabel('r4 writer')).toBeUndefined();
    }
    b.clock.advance(30); // the sign-in used this time step's code
    const done = await post(browser, c, { ...choice, stepup_totp: totp(secret, b.clock.now()) });
    expect(codeOf(done), await done.clone().text()).toBeTruthy();
    expect(b.policy.store.getProfileByLabel('r4 writer')).toMatchObject({ scope: 'write' });

    // Stepped up within the window: the next connection on the write profile is not asked again.
    const writer = b.policy.store.getProfileByLabel('r4 writer')!;
    const again = await consent(b, browser, CLAUDE);
    expect(codeOf(await post(browser, again, { profile: writer.id, scope: 'keep' }))).toBeTruthy();
    // Eleven hours later it still is not; over 12 hours later it is.
    b.clock.advance(11 * 3600);
    const within = await consent(b, browser, CLAUDE);
    expect(codeOf(await post(browser, within, { profile: writer.id, scope: 'keep' }))).toBeTruthy();
    b.clock.advance(3600 + 1);
    const later = await consent(b, browser, CLAUDE);
    const asks = await post(browser, later, { profile: writer.id, scope: 'keep' });
    expect(asks.status).toBe(200);
    expect(await asks.text()).toContain(
      'This connection would act under profile “r4 writer”, at scope write.',
    );
  });

  it('an ordinary connection at read or propose, a new profile at the default, and a lowering are not asked', async () => {
    const b = (bridge = await startBridge());
    const browser = new Browser(b);
    expect((await browser.login()).status).toBe(200);
    const reader = b.policy.commands.createProfile('owner', {
      label: 'r4 reader',
      kind: 'claude',
      scope: 'read',
    });
    const proposer = b.policy.commands.createProfile('owner', {
      label: 'r4 proposer',
      kind: 'claude',
      scope: 'propose',
    });
    const writer = b.policy.commands.createProfile('owner', {
      label: 'r4 lowered',
      kind: 'claude',
      scope: 'write',
    });
    for (const fields of [
      { profile: reader.id, scope: 'keep' },
      { profile: proposer.id, scope: 'keep' },
      { profile: proposer.id, scope: 'propose' },
      { profile: 'new', new_label: 'r4 kept', new_kind: 'claude', scope: 'keep' },
      { profile: 'new', new_label: 'r4 read', new_kind: 'claude', scope: 'read' },
    ]) {
      const c = await consent(b, browser, CLAUDE);
      expect(codeOf(await post(browser, c, fields)), JSON.stringify(fields)).toBeTruthy();
    }
    // A new profile at the configured default (here propose) is not asked either; above it would be.
    b.policy.commands.setDefaultScope('owner', 'propose');
    const atDefault = await consent(b, browser, CLAUDE);
    expect(
      codeOf(
        await post(browser, atDefault, {
          profile: 'new',
          new_label: 'r4 at default',
          new_kind: 'claude',
          scope: 'propose',
        }),
      ),
    ).toBeTruthy();
    b.policy.commands.setDefaultScope('owner', 'read');
    // A lowering, once confirmed, is one click (the owner's rule: tightening is one click).
    const down = await consent(b, browser, CLAUDE);
    expect((await post(browser, down, { profile: writer.id, scope: 'read' })).status).toBe(200);
    const lowered = await post(browser, down, {
      profile: writer.id,
      scope: 'read',
      confirm_scope_change: `${writer.id}:write:read`,
    });
    expect(codeOf(lowered)).toBeTruthy();
    expect(b.policy.store.getProfile(writer.id)!.scope).toBe('read');
    expect(logEvents(b, 'consent.step_up_asked')).toEqual([]);
    expect(reauthAt(b, browser)).toBeNull();
  });

  it('the page carries the ticked connections through, and Deny there needs no step-up', async () => {
    const b = (bridge = await startBridge());
    const browser = new Browser(b);
    expect((await browser.login()).status).toBe(200);
    const p = b.policy.commands.createProfile('owner', {
      label: 'r4 carried',
      kind: 'claude',
      scope: 'read',
    });
    const first = await consent(b, browser, CLAUDE);
    const code = codeOf(await post(browser, first, { profile: p.id, scope: 'keep' }));
    expect((await exchange(b, first, code!)).res.status).toBe(200);
    const old = b.policy.commands
      .listGrantsAndPats('owner')
      .find((g) => g.type === 'grant' && g.clientId === first.clientId)!;
    b.policy.commands.setScope('owner', p.id, 'write');

    const c = await consent(b, browser, CLAUDE);
    const asked = await post(browser, c, { profile: p.id, scope: 'keep', replace: [old.id] });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain(`name="replace" value="${old.id}"`);
    const denied = await post(browser, c, {
      profile: p.id,
      scope: 'keep',
      replace: [old.id],
      decision: 'deny',
    });
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(b.services.store.getFamily(old.id)!.revokedAt).toBeNull();
  });

  it('failed step-ups on the consent page count against the sign-in limits (and the reverse)', async () => {
    const b = (bridge = await startBridge());
    const p = b.policy.commands.createProfile('owner', {
      label: 'r4 limits',
      kind: 'claude',
      scope: 'write',
    });
    const browser = new Browser(b);
    expect((await browser.login()).status).toBe(200);
    const c = await consent(b, browser, CLAUDE);
    for (let i = 0; i < 5; i++) {
      const r = await post(browser, c, { profile: p.id, scope: 'keep', stepup_password: `wrong ${i}` });
      expect(r.status).toBe(401);
    }
    const locked = await post(browser, c, { profile: p.id, scope: 'keep', stepup_password: b.password });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await locked.text()).toContain('Too many failed attempts.');
    expect(codeOf(locked)).toBeNull();
    expect((await new Browser(b).login()).status).toBe(429);
  });
});
