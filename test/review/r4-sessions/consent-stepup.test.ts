/**
 * CR-2026-11 round 4 (sessions), the step-up's second routes: the OAuth consent page (`/oauth/authorize`, then
 * `POST /oauth/consent`) is reached with the same owner session as the dashboard (ADR 0062 decision 1), and it can choose
 * a profile and its scope for the new connection (ADR 0019, ADR 0033). ADR 0062 decision 5 asks for the step-up before "a
 * profile's scope ... raised, a connection moved ... to a profile at scope `write`, ... a new profile given a scope", and
 * before "a personal access token (at any scope)" (a new credential). The attempts: a session that has NOT stepped up
 * (what a stolen cookie gives) does each of these through the consent page instead of the dashboard.
 *
 * The safe behaviour asserted: the consent page asks for (or refuses without) the step-up exactly where the dashboard
 * route does; nothing is raised, created or issued. The controls show the dashboard's own routes ask on the same session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';
import {
  Browser,
  authorizeUrl,
  pkcePair,
  reachConsent,
  registerPublicClient,
  tokenRequest,
  mcpPost,
  type ConsentPage,
} from '../../auth/helpers.js';
import { asksStepUp, ownerSession, type Owner } from './helpers.js';

const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

let s: AdminStack;
beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
});
afterAll(async () => {
  await s?.close();
});

/** A browser signed in through the sign-in form (a fresh session: no step-up), and its session as the dashboard sees it. */
async function signedIn(): Promise<{ browser: Browser; owner: Owner }> {
  const browser = new Browser(s.bridge);
  const res = await browser.login();
  expect(res.status, await res.clone().text()).toBe(200);
  const token = browser.cookies.get(s.services.owner.sessionCookie)!;
  const owner = ownerSession(s, s.bridge.publicUrl, token);
  expect(owner.reauthAt()).toBeNull(); // signed in, never stepped up
  return { browser, owner };
}

async function consent(browser: Browser, redirectUri: string) {
  const clientId = await registerPublicClient(s.bridge, [redirectUri]);
  const pkce = pkcePair();
  const page = await reachConsent(
    browser,
    authorizeUrl(
      { clientId, redirectUri, challenge: pkce.challenge, method: 'S256', resource: s.bridge.mcpUrl },
      browser.base,
    ),
  );
  if (page instanceof Response) throw new Error(`no consent page: ${page.status} ${await page.text()}`);
  return { page: page, clientId, pkce, redirectUri };
}

const decideWith = (browser: Browser, page: ConsentPage, fields: Record<string, string>) =>
  browser.post(`${browser.base}/oauth/consent`, {
    request_id: page.requestId,
    csrf_token: page.csrf,
    decision: 'approve',
    ...fields,
  });

/** The `code` the consent page sent the browser back with, if it did. */
const codeOf = (res: Response): string | null => {
  const loc = res.headers.get('location');
  return res.status === 303 && loc ? new URL(loc).searchParams.get('code') : null;
};

describe('the consent page is a second route around the step-up (ADR 0062 decision 5)', () => {
  it('SE-01 (control): the same session, on the dashboard, is asked for the step-up to raise a profile', async () => {
    const { owner } = await signedIn();
    const p = s.policy.commands.createProfile('owner', { label: 'r4 se01', kind: 'chatgpt', scope: 'read' });
    asksStepUp(
      await owner.call('PUT', `/api/admin/clients/profiles/${p.id}/scope`, {
        scope: 'write',
        confirmRaise: true,
      }),
      'raise on the dashboard',
    );
    asksStepUp(
      await owner.call('POST', '/api/admin/clients/profiles', {
        label: 'r4 se01 new',
        kind: 'other',
        scope: 'write',
      }),
      'new profile at write on the dashboard',
    );
    asksStepUp(
      await owner.call('POST', '/api/admin/clients/pats', { name: 'r4 se01 key', profileId: p.id }),
      'a new token on the dashboard',
    );
    expect(s.policy.store.getProfile(p.id)!.scope).toBe('read');
  });

  it("SE-02: raising an existing profile's scope (read → write) through the consent page needs the step-up too", async () => {
    const { browser, owner } = await signedIn();
    const p = s.policy.commands.createProfile('owner', { label: 'r4 se02', kind: 'chatgpt', scope: 'read' });
    const c = await consent(browser, CHATGPT);
    const confirmPage = await decideWith(browser, c.page, { profile: p.id, scope: 'write' });
    expect(confirmPage.status).toBe(200); // the second page ("Confirm scope change"): nothing changed yet
    const res = await decideWith(browser, c.page, {
      profile: p.id,
      scope: 'write',
      confirm_scope_change: `${p.id}:read:write`, // the page's own confirmation token (not a secret)
    });
    // Safe: the raise is not applied without the step-up (the session never stepped up).
    expect(owner.reauthAt()).toBeNull();
    expect(s.policy.store.getProfile(p.id)!.scope, `consent answered ${res.status}`).toBe('read');
    expect(codeOf(res)).toBeNull();
  });

  it('SE-03: a new profile at scope write, made on the consent page, needs the step-up too', async () => {
    const { browser } = await signedIn();
    const c = await consent(browser, CLAUDE);
    const res = await decideWith(browser, c.page, {
      profile: 'new',
      new_label: 'r4 se03 writer',
      new_kind: 'other',
      scope: 'write',
    });
    const made = s.policy.store.getProfileByLabel('r4 se03 writer');
    expect(made?.scope ?? null, `consent answered ${res.status}`).not.toBe('write');
    expect(codeOf(res)).toBeNull();
  });

  it('SE-04: a new connection on a profile at scope write (a credential like a token) needs the step-up too', async () => {
    const { browser, owner } = await signedIn();
    const p = s.policy.commands.createProfile('owner', { label: 'r4 se04', kind: 'claude', scope: 'write' });
    // The dashboard asks this session for the step-up before a token for this profile.
    asksStepUp(
      await owner.call('POST', '/api/admin/clients/pats', { name: 'r4 se04 key', profileId: p.id }),
      'a token for a write profile',
    );
    const c = await consent(browser, CLAUDE);
    const res = await decideWith(browser, c.page, { profile: p.id, scope: 'keep' });
    const code = codeOf(res);
    let issued: string | null = null;
    if (code) {
      const t = await tokenRequest(s.bridge, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.redirectUri,
        code_verifier: c.pkce.verifier,
        client_id: c.clientId,
        resource: s.bridge.mcpUrl,
      });
      issued = t.res.status === 200 ? String(t.body.access_token) : null;
    }
    const grant = grantOf(c.clientId);
    const scope = grant ? (s.policy.gate.scopeOf(grant.family_id) ?? null) : null;
    // Safe: no write-scope credential comes out of a session that has not stepped up.
    expect({
      code: code !== null,
      issued: issued !== null,
      scope,
      profile: grant?.profile_id ?? null,
    }).toEqual({
      code: false,
      issued: false,
      scope: null,
      profile: null,
    });
  });
});

describe('what a stolen session cookie alone yields through the consent page', () => {
  it('SE-04b: no credential minted from a never-stepped-up session outlives Sign out everywhere', async () => {
    // The attacker has only the cookie: no browser (no Sec-Fetch-* headers, no Origin), their own client registration
    // with a loopback redirect (any port is allowed for native clients), and reads the code from the Location header.
    const { owner } = await signedIn();
    const p = s.policy.commands.createProfile('owner', {
      label: 'r4 se04b',
      kind: 'claude-code',
      scope: 'write',
    });
    const redirectUri = 'http://127.0.0.1:9/callback';
    const clientId = await registerPublicClient(s.bridge, [redirectUri]);
    const pkce = pkcePair();
    const url = authorizeUrl({
      clientId,
      redirectUri,
      challenge: pkce.challenge,
      method: 'S256',
      resource: s.bridge.mcpUrl,
      scope: 'mcp offline_access',
    });
    const page = await s.bridge.fetch(url, { headers: { cookie: owner.cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(html)?.[1] ?? '';
    const consent = await s.bridge.fetch(`${s.bridge.publicUrl}/oauth/consent`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: field('request_id'),
        csrf_token: field('csrf_token'),
        decision: 'approve',
        profile: p.id,
        scope: 'keep',
      }).toString(),
    });
    const code = codeOf(consent);
    let refresh: string | null = null;
    let access: string | null = null;
    if (code) {
      const t = await tokenRequest(s.bridge, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
        client_id: clientId,
        resource: s.bridge.mcpUrl,
      });
      refresh = (t.body.refresh_token as string | undefined) ?? null;
      access = (t.body.access_token as string | undefined) ?? null;
    }
    // The owner notices and presses "Sign out everywhere".
    const me = ownerSession(s, s.bridge.publicUrl, s.sessionToken);
    expect((await me.call('POST', '/api/admin/security/sessions/revoke-all', { confirm: true })).status).toBe(
      200,
    );
    const stillRefreshes = refresh
      ? (
          await tokenRequest(s.bridge, {
            grant_type: 'refresh_token',
            refresh_token: refresh,
            client_id: clientId,
          })
        ).res.status === 200
      : false;
    const stillCallsMcp = access ? (await mcpPost(s.bridge, access)).status === 200 : false;
    expect({ minted: code !== null, stillRefreshes, stillCallsMcp }).toEqual({
      minted: false,
      stillRefreshes: false,
      stillCallsMcp: false,
    });
  });
});

/** The newest grant (token family) of a client: the connection the consent made, and its profile. */
function grantOf(clientId: string): { family_id: string; profile_id: string | null } | undefined {
  return s.db
    .prepare(
      'SELECT family_id, profile_id FROM auth_token_families WHERE client_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(clientId) as { family_id: string; profile_id: string | null } | undefined;
}
