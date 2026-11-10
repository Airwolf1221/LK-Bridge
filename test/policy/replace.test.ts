/**
 * Replace on reconnect (ADR 0033), through the real consent page and token endpoint: the application's existing
 * connections are listed (by client_id for a Client ID Metadata Document client, else by the verified redirect origin;
 * never another application's), nothing is revoked at approval, and the ticked ones are revoked only when the new
 * connection's code is exchanged successfully, after a re-check, with an audit row each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameApplication } from '../../src/auth/application.js';
import {
  Browser,
  type TestBridge,
  authorizeUrl,
  decide,
  formBody,
  pkcePair,
  reachConsent,
  startBridge,
  tokenRequest,
} from '../auth/helpers.js';

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge({});
});
afterAll(() => bridge.close());

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';

interface Session {
  page: Awaited<ReturnType<typeof reachConsent>> & { html: string; requestId: string; csrf: string };
  browser: Browser;
  clientId: string;
  verifier: string;
  redirectUri: string;
}

async function consent(redirectUri: string, clientName = 'Claude'): Promise<Session> {
  const res = await bridge.fetch(`${bridge.publicUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const clientId = ((await res.json()) as { client_id: string }).client_id;
  const browser = new Browser(bridge);
  const { verifier, challenge } = pkcePair();
  const page = await reachConsent(
    browser,
    authorizeUrl(
      {
        clientId,
        redirectUri,
        challenge,
        method: 'S256',
        state: 's',
        scope: 'mcp offline_access',
        resource: bridge.mcpUrl,
      },
      browser.base,
    ),
  );
  if (page instanceof Response) throw new Error(`no consent page: ${page.status}`);
  return { page: page, browser, clientId, verifier, redirectUri };
}

/** Posts the consent form as a browser would, with repeated `replace` fields. */
async function approve(s: Session, fields: Record<string, string | string[]> = {}) {
  const res = await s.browser.request(`${bridge.publicUrl}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      request_id: s.page.requestId,
      csrf_token: s.page.csrf,
      decision: 'approve',
      profile: 'new',
      new_label: 'x',
      new_kind: 'claude',
      scope: 'keep',
      ...fields,
    }),
  });
  return res;
}

const codeOf = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('code')!;
const exchange = (s: Session, code: string, verifier = s.verifier) =>
  tokenRequest(bridge, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: s.redirectUri,
    code_verifier: verifier,
    client_id: s.clientId,
    resource: bridge.mcpUrl,
  });

/** One finished connection of an application: consent (the profile `label`), approve with nothing ticked, exchange. */
async function connect(redirectUri: string, label: string, name = 'Claude') {
  const s = await consent(redirectUri, name);
  const profile = bridge.policy.store.getProfileByLabel(label);
  const res = await approve(
    s,
    profile ? { profile: profile.id, replace: [] } : { profile: 'new', new_label: label, replace: [] },
  );
  expect(res.status).toBe(303);
  const t = await exchange(s, codeOf(res));
  expect(t.res.status).toBe(200);
  const grant = bridge.policy.commands
    .listGrantsAndPats('owner')
    .find((c) => c.type === 'grant' && c.clientId === s.clientId)!;
  return { id: grant.id, clientId: s.clientId };
}

const family = (id: string) => bridge.services.store.getFamily(id)!;
const audits = (id: string) =>
  bridge.policy.commands.listAudit('owner', { action: 'connection.revoke' }).filter((a) => a.target === id);
const offered = (html: string) =>
  [...html.matchAll(/name="replace" value="([^"]+)" checked/g)].map((m) => m[1]!);

describe('which connections are offered', () => {
  it("lists the same origin's active grants (DCR), ticked by default, and never another application's", async () => {
    const c1 = await connect(CLAUDE, 'claude');
    const c2 = await connect(CLAUDE, 'claude');
    const gpt = await connect(CHATGPT, 'chatgpt', 'ChatGPT');
    const local = await connect('http://127.0.0.1:41000/callback', 'claude-code', 'Claude Code');
    const s = await consent(CLAUDE);
    expect(new Set(offered(s.page.html))).toEqual(new Set([c1.id, c2.id]));
    expect(s.page.html).not.toContain(gpt.id);
    expect(s.page.html).not.toContain(local.id);
    expect(s.page.html).toContain("This application's existing connections");
    expect(s.page.html).toContain('Ticked connections are revoked as soon as this new connection is issued.');
    expect(s.page.html).toContain(
      'Untick one to keep it, for example a second device or a separate Claude Code session.',
    );
    // label, profile, created (with the year) and last used
    expect(s.page.html).toMatch(
      /Profile: claude · created \d{1,2} \w+ 2\d{3}, \d{2}:\d{2} · last used (never|\d)/,
    );
    // ChatGPT's page lists ChatGPT's own only.
    const g = await consent(CHATGPT, 'ChatGPT');
    expect(offered(g.page.html)).toEqual([gpt.id]);
  });

  it('only ACTIVE grants are offered, and there is no fieldset when there are none', async () => {
    const dead = await connect('http://localhost:41111/callback', 'claude-code', 'Other');
    bridge.policy.commands.revoke('owner', dead.id);
    // A different port of the same loopback host is the same application, but the grant is revoked: not offered.
    const s = await consent('http://localhost:41112/callback', 'Other');
    expect(offered(s.page.html)).toEqual([]);
    expect(s.page.html).not.toContain('existing connections');
  });

  it('the rule itself: a CIMD client is the same application only by client_id; any other by redirect origin, loopback ignoring the port; the name never decides', () => {
    const other = (clientId: string, redirectUris: string[]) => ({ clientId, redirectUris });
    const cimd = { clientId: 'https://a.example/client.json', kind: 'cimd' as const, redirectUri: CLAUDE };
    expect(sameApplication(cimd, other('https://a.example/client.json', []))).toBe(true);
    expect(sameApplication(cimd, other('dcr_1', [CLAUDE]))).toBe(false); // same origin, but a CIMD client is its client_id
    const dcr = { clientId: 'dcr_new', kind: 'dcr' as const, redirectUri: CLAUDE };
    expect(sameApplication(dcr, other('dcr_old', [CLAUDE]))).toBe(true);
    expect(sameApplication(dcr, other('dcr_old', ['https://claude.com/api/mcp/auth_callback']))).toBe(false);
    expect(sameApplication(dcr, other('dcr_old', ['http://claude.ai/api/mcp/auth_callback']))).toBe(false);
    const loop = {
      clientId: 'dcr_new',
      kind: 'dcr' as const,
      redirectUri: 'http://127.0.0.1:50001/callback',
    };
    expect(sameApplication(loop, other('dcr_old', ['http://127.0.0.1:50002/callback']))).toBe(true);
    expect(sameApplication(loop, other('dcr_old', ['http://localhost:50002/callback']))).toBe(false);
  });
});

describe('revoked at token issue, not at approval', () => {
  it('approval revokes nothing; a successful exchange revokes exactly the ticked grants, with the reason and an audit row each', async () => {
    const old1 = await connect(CLAUDE, 'claude');
    const old2 = await connect(CLAUDE, 'claude');
    const keep = await connect(CLAUDE, 'claude');
    const s = await consent(CLAUDE);
    expect(offered(s.page.html)).toEqual(expect.arrayContaining([old1.id, old2.id, keep.id]));
    // Untick `keep`: only two ids are submitted.
    const res = await approve(s, {
      profile: bridge.policy.store.getProfileByLabel('claude')!.id,
      replace: [old1.id, old2.id],
    });
    expect(res.status).toBe(303);
    // Nothing is revoked at approval; the code carries the ids.
    for (const g of [old1, old2, keep]) expect(family(g.id).revokedAt).toBeNull();
    const code = bridge.services.store.getCode(
      (await import('../../src/auth/crypto.js')).hashSecret(codeOf(res)),
    )!;
    expect(new Set(code.replaces)).toEqual(new Set([old1.id, old2.id]));

    const t = await exchange(s, codeOf(res));
    expect(t.res.status).toBe(200);
    const fresh = bridge.policy.commands
      .listGrantsAndPats('owner')
      .find((c) => c.type === 'grant' && c.clientId === s.clientId)!;
    for (const g of [old1, old2]) {
      expect(family(g.id).revokedAt).not.toBeNull();
      expect(family(g.id).revokedReason).toBe(`replaced by ${fresh.id}`);
      expect(audits(g.id)[0]).toMatchObject({
        actor: 'owner',
        before: { active: true },
        after: { active: false, via: 'replaced', replacedBy: fresh.id },
      });
    }
    expect(family(keep.id).revokedAt).toBeNull(); // unticked: it survives
    expect(audits(keep.id)).toEqual([]);
    expect(family(fresh.id).revokedAt).toBeNull();
    // Refresh tokens of the replaced grants are revoked too.
    expect(
      bridge.db
        .prepare('SELECT COUNT(*) AS n FROM auth_refresh_tokens WHERE family_id = ? AND revoked_at IS NULL')
        .get(old1.id),
    ).toEqual({ n: 0 });
  });

  it('an abandoned or failed exchange revokes nothing', async () => {
    const old = await connect(CLAUDE, 'claude');
    const profileId = bridge.policy.store.getProfileByLabel('claude')!.id;
    // Abandoned: approved, never exchanged.
    const a = await consent(CLAUDE);
    expect((await approve(a, { profile: profileId, replace: [old.id] })).status).toBe(303);
    expect(family(old.id).revokedAt).toBeNull();
    // Failed: the wrong PKCE verifier.
    const b = await consent(CLAUDE);
    const res = await approve(b, { profile: profileId, replace: [old.id] });
    const bad = await exchange(b, codeOf(res), pkcePair().verifier);
    expect(bad.res.status).toBe(400);
    expect(family(old.id).revokedAt).toBeNull();
    // Denied: nothing either.
    const c = await consent(CLAUDE);
    const denied = await approve(c, { decision: 'deny', profile: profileId, replace: [old.id] });
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(family(old.id).revokedAt).toBeNull();
    expect(audits(old.id).filter((x) => (x.after as { via?: string } | null)?.via === 'replaced')).toEqual(
      [],
    );
  });

  it('a grant that was revoked meanwhile, or changed application, is skipped; ids that were never offered are ignored', async () => {
    const gone = await connect(CLAUDE, 'claude');
    const moved = await connect(CLAUDE, 'claude');
    const intact = await connect(CLAUDE, 'claude');
    const foreign = await connect(CHATGPT, 'chatgpt', 'ChatGPT');
    const profileId = bridge.policy.store.getProfileByLabel('claude')!.id;
    const s = await consent(CLAUDE);
    const res = await approve(s, {
      profile: profileId,
      replace: [gone.id, moved.id, intact.id, foreign.id, 'grant_made_up'],
    });
    expect(res.status).toBe(303);
    // Between approval and exchange: one is revoked by the owner, one now belongs to another application.
    bridge.policy.commands.revoke('owner', gone.id);
    const revokedAt = family(gone.id).revokedAt;
    bridge.db
      .prepare('UPDATE auth_token_families SET client_id = ? WHERE family_id = ?')
      .run(foreign.clientId, moved.id);
    const t = await exchange(s, codeOf(res));
    expect(t.res.status).toBe(200);
    expect(family(intact.id).revokedReason).toMatch(/^replaced by grant_/);
    expect(family(gone.id).revokedReason).toBe('revoked_by_owner'); // untouched, not re-revoked
    expect(family(gone.id).revokedAt).toBe(revokedAt);
    expect(family(moved.id).revokedAt).toBeNull(); // another application now
    expect(family(foreign.id).revokedAt).toBeNull(); // never offered to this page: dropped at approval
    expect(audits(gone.id).filter((x) => (x.after as { via?: string } | null)?.via === 'replaced')).toEqual(
      [],
    );
    expect(audits(moved.id)).toEqual([]);
    expect(audits(foreign.id)).toEqual([]);
  });

  it('the scope-change confirmation page carries the ticked connections through', async () => {
    const old = await connect(CLAUDE, 'claude');
    const profile = bridge.policy.store.getProfileByLabel('claude')!;
    const s = await consent(CLAUDE);
    const ask = await approve(s, {
      profile: profile.id,
      scope: profile.scope === 'write' ? 'read' : 'write',
      replace: [old.id],
    });
    expect(ask.status).toBe(200);
    const html = await ask.text();
    expect(html).toContain('Confirm scope change');
    expect(html).toContain(`name="replace" value="${old.id}"`);
    expect(family(old.id).revokedAt).toBeNull();
    // Keep ... and approve, with the carried choice.
    const token = /name="confirm_scope_change" value="([^"]+)"/.exec(html)![1]!;
    const [, from] = token.split(':');
    const done = await approve(s, {
      profile: profile.id,
      scope: from!,
      confirm_scope_change: token,
      replace: [old.id],
    });
    expect(done.status).toBe(303);
    await exchange(s, codeOf(done));
    expect(family(old.id).revokedReason).toMatch(/^replaced by /);
  });
});

describe('without the policy layer nothing is offered', () => {
  it('decide() with the page defaults still works (the page ticks the offered connections)', async () => {
    const old = await connect(CLAUDE, 'claude');
    const s = await consent(CLAUDE);
    // The browser submits the ticked boxes by name; `decide` (page defaults) submits none, so nothing is replaced.
    const { location } = await decide(s.browser, s.page, 'approve');
    const t = await exchange(s, location.searchParams.get('code')!);
    expect(t.res.status).toBe(200);
    expect(family(old.id).revokedAt).toBeNull();
  });
});
