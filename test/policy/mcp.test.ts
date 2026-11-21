/**
 * The policy layer at /mcp and on the consent screen, through the real bridge and the official MCP client:
 * profile and scope choice at consent, grants defaulting to `read`, tokens inheriting the grant's profile, tool lists
 * per scope, live scope changes on an existing token, refused hidden calls, the principal from the token (never from
 * clientInfo), and agents seeing only their own proposals.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { policyOpMeta } from '../../src/jobs/index.js';
import { getOperation } from '../../src/lk/registry.js';
import type { McpToolProvider } from '../../src/mcp/server.js';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { createLkClient } from '../../src/lk/client.js';
import { createPolicy, mcpOrigin } from '../../src/policy/index.js';
import { ProjectSelector, StaticProjects } from '../../src/projects/index.js';
import {
  Browser,
  type TestBridge,
  authorizeUrl,
  consentDefaults,
  decide,
  pkcePair,
  reachConsent,
  startBridge,
  tokenRequest,
} from '../auth/helpers.js';

let bridge: TestBridge;

const json = (r: { content: unknown }) =>
  JSON.parse(((r.content as { text: string }[])[0] as { text: string }).text) as Record<string, unknown>;

const whoami: McpToolProvider = {
  name: 'stub_whoami',
  description: 'Read stub: reports the principal the bridge resolved.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false },
  access: 'read',
  handler: (_i, ctx) => ({
    content: [
      { type: 'text', text: JSON.stringify({ principal: ctx.principal ?? null, scope: ctx.scope ?? null }) },
    ],
  }),
};

/** A write stub: asks the policy gate about a write, as an engine-backed write tool would. */
const writeStub = (): McpToolProvider => ({
  name: 'stub_write',
  description: 'Write stub.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: false, destructiveHint: true },
  access: 'write',
  handler: (_i, ctx) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          bridge.policy.gate.authorize(
            ctx.principal!,
            policyOpMeta(getOperation('updateResource')!, {}),
            {},
            { origin: mcpOrigin(ctx, 'stub_write'), project: PROJECT, jobKind: 'single_op' },
          ),
        ),
      },
    ],
  }),
});

/** Wrongly tagged `read`, so it is listed to everyone: the gate must still refuse its write. */
const mislabelled = (): McpToolProvider => ({ ...writeStub(), name: 'stub_mislabelled', access: 'read' });

/** v2 A1: proposals belong to a project; the proposal tools resolve the `project` argument (default: this one). */
const PROJECT = 'proj_mock';

beforeAll(async () => {
  bridge = await startBridge({
    tools: [whoami, writeStub(), mislabelled()],
    policy: (db) => {
      const projects = new StaticProjects(db, [
        {
          name: 'mock',
          // Never called: the proposal tools only read the database.
          client: createLkClient({
            apiKey: 'unused',
            projectId: PROJECT,
            baseUrl: 'http://127.0.0.1:9',
            governor: defaultGovernorSettings(),
          }),
        },
      ]);
      return createPolicy({
        db,
        allowMemberAdmin: false,
        proposalTools: { selector: new ProjectSelector(projects, true) },
      });
    },
  });
});
afterAll(() => bridge.close());

async function connect(token: string, name = 'lk-bridge-tests'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.mcpUrl), {
    fetch: (url: string | URL, init?: RequestInit) => fetch(bridge.local(String(url)), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function toolNames(token: string): Promise<string[]> {
  const c = await connect(token);
  try {
    return (await c.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await c.close();
  }
}

async function consentPage(redirectUri: string, clientName = 'Claude') {
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
  expect(res.status).toBe(201);
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
  return { page, browser, clientId, verifier, redirectUri };
}

async function finish(c: Awaited<ReturnType<typeof consentPage>>, fields: Record<string, string> = {}) {
  const { location } = await decide(c.browser, c.page, 'approve', fields);
  const { res, body } = await tokenRequest(bridge, {
    grant_type: 'authorization_code',
    code: location.searchParams.get('code') ?? undefined,
    redirect_uri: c.redirectUri,
    code_verifier: c.verifier,
    client_id: c.clientId,
    resource: bridge.mcpUrl,
  });
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { access: body.access_token as string, refresh: body.refresh_token as string };
}

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

describe('consent screen: profile and scope', () => {
  it('shows the redirect host, the untrusted client name escaped, and suggests a profile at read', async () => {
    const c = await consentPage(CLAUDE, '<img src=x onerror=alert(1)> Claude');
    const html = c.page.html;
    expect(html).toContain('<p class="host">claude.ai</p>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62; Claude');
    expect(html).toContain('untrusted name');
    // ADR 0033: the preselected scope radio is always "keep"; for a new profile it resolves to the default (read).
    expect(consentDefaults(html)).toMatchObject({ new_label: 'claude', new_kind: 'claude', scope: 'keep' });
    expect(html).toContain('name="scope" value="keep" checked');
    expect(html).not.toMatch(/value="(read|propose|write)" checked/);
  });

  it('suggests chatgpt for chatgpt.com and claude-code for loopback', async () => {
    const g = await consentPage('https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT');
    expect(consentDefaults(g.page.html)).toMatchObject({ new_label: 'chatgpt', new_kind: 'chatgpt' });
    const l = await consentPage('http://127.0.0.1:43123/callback', 'Claude Code');
    expect(consentDefaults(l.page.html)).toMatchObject({ new_label: 'claude-code', new_kind: 'claude-code' });
  });

  it('a new grant defaults to read; its access and refreshed tokens inherit the profile', async () => {
    const c = await consentPage(CLAUDE);
    const t = await finish(c);
    const grants = bridge.policy.commands.listGrantsAndPats('owner').filter((x) => x.type === 'grant');
    const grant = grants.find((x) => x.clientId === c.clientId)!;
    expect(grant).toMatchObject({ profile: 'claude', scope: 'read', active: true });
    expect(await toolNames(t.access)).toEqual(['bridge_proposal_status', 'stub_mislabelled', 'stub_whoami']);
    const r = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: c.clientId,
    });
    expect(r.res.status).toBe(200);
    const client = await connect(r.body.access_token as string);
    try {
      const who = json(await client.callTool({ name: 'stub_whoami', arguments: {} }));
      expect(who).toMatchObject({ principal: { principalId: grant.id, profile: 'claude' }, scope: 'read' });
    } finally {
      await client.close();
    }
  });

  it('can pick an existing profile and set its scope (audited), and refuses bad choices without using up the request', async () => {
    const c = await consentPage(CLAUDE);
    const claude = bridge.policy.store.getProfileByLabel('claude')!;
    const post = (fields: Record<string, string | undefined>) =>
      c.browser.post(`${bridge.publicUrl}/oauth/consent`, {
        request_id: c.page.requestId,
        csrf_token: c.page.csrf,
        decision: 'approve',
        ...fields,
      });
    expect((await post({ profile: claude.id })).status).toBe(400); // no scope
    expect((await post({ profile: claude.id, scope: 'admin' })).status).toBe(400);
    expect((await post({ profile: 'prof_nope', scope: 'read' })).status).toBe(400);
    expect(
      (await post({ profile: 'new', new_label: 'claude', new_kind: 'claude', scope: 'read' })).status,
    ).toBe(400);
    expect((await post({ profile: 'new', new_label: 'x', new_kind: 'robot', scope: 'read' })).status).toBe(
      400,
    );
    expect((await post({ profile: claude.id, scope: 'write', csrf_token: 'forged' })).status).toBe(403);
    expect(bridge.policy.store.getProfile(claude.id)!.scope).toBe('read');
    // A change to an existing profile's scope is confirmed on a second page first (v1.0.1, F-15).
    const ask = await post({ profile: claude.id, scope: 'propose' });
    expect(ask.status).toBe(200);
    expect(bridge.policy.store.getProfile(claude.id)!.scope).toBe('read');
    // CR-2026-11-R4 (ADR 0062 decision 5): the confirmed raise then asks for the step-up, on the page; nothing changes yet.
    const stepUp = await post({
      profile: claude.id,
      scope: 'propose',
      confirm_scope_change: `${claude.id}:read:propose`,
    });
    expect(stepUp.status).toBe(200);
    expect(await stepUp.text()).toContain('name="stepup_password"');
    expect(bridge.policy.store.getProfile(claude.id)!.scope).toBe('read');
    const t = await finish(c, {
      profile: claude.id,
      scope: 'propose',
      confirm_scope_change: `${claude.id}:read:propose`,
      stepup_password: bridge.password,
    });
    expect(bridge.policy.store.getProfile(claude.id)!.scope).toBe('propose');
    expect(await toolNames(t.access)).toContain('stub_write');
    const audit = bridge.policy.commands.listAudit('owner', { action: 'profile.set_scope' });
    expect(audit[0]).toMatchObject({
      actor: 'owner',
      target: claude.id,
      after: { scope: 'propose', via: 'consent' },
    });
    bridge.policy.commands.setScope('owner', claude.id, 'read');
  });

  it('creates a new profile at the chosen scope; denial is unchanged', async () => {
    const c = await consentPage(CLAUDE);
    // CR-2026-11-R4 (ADR 0062 decision 5): a new profile above the default scope needs the step-up (here, on the page).
    await finish(c, {
      profile: 'new',
      new_label: 'Claude mobile',
      new_kind: 'claude',
      scope: 'write',
      stepup_password: bridge.password,
    });
    expect(bridge.policy.store.getProfileByLabel('claude mobile')).toMatchObject({
      kind: 'claude',
      scope: 'write',
    });
    const d = await consentPage(CLAUDE);
    const res = await d.browser.post(`${bridge.publicUrl}/oauth/consent`, {
      request_id: d.page.requestId,
      csrf_token: d.page.csrf,
      decision: 'deny',
    });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe("consent keeps an existing profile's scope unless the owner confirms a change (v1.0.1, F-15)", () => {
  const profile = (label: string, scope: 'read' | 'propose' | 'write') => {
    const p =
      bridge.policy.store.getProfileByLabel(label) ??
      bridge.policy.commands.createProfile('owner', { label, kind: 'chatgpt', scope });
    if (p.scope !== scope) bridge.policy.commands.setScope('owner', p.id, scope);
    return bridge.policy.store.getProfile(p.id)!;
  };
  const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const scopeAudits = (id: string) =>
    bridge.policy.commands.listAudit('owner', { action: 'profile.set_scope' }).filter((a) => a.target === id);
  const post = (c: Awaited<ReturnType<typeof consentPage>>, fields: Record<string, string>) =>
    c.browser.post(`${bridge.publicUrl}/oauth/consent`, {
      request_id: c.page.requestId,
      csrf_token: c.page.csrf,
      decision: 'approve',
      ...fields,
    });

  it('preselects the existing profile and its current scope; approving untouched changes nothing', async () => {
    const chatgpt = profile('chatgpt', 'write');
    const before = scopeAudits(chatgpt.id).length;
    const c = await consentPage(CHATGPT, 'ChatGPT');
    expect(consentDefaults(c.page.html)).toMatchObject({ profile: chatgpt.id, scope: 'keep' });
    expect(c.page.html).toContain('name="scope" value="keep" checked');
    expect(c.page.html).not.toMatch(/value="(read|propose|write)" checked/);
    expect(c.page.html).toContain('Keep the chosen profile’s current scope');
    // CR-2026-11-R4 (ADR 0062 decision 5): a connection on a profile at scope write asks for the step-up first, on the
    // page; nothing is issued without it.
    const asked = await post(c, consentDefaults(c.page.html));
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('Confirm it’s you');
    expect(asked.headers.get('location')).toBeNull();
    await finish(c, { stepup_password: bridge.password }); // the page's own defaults, unchanged
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('write');
    expect(scopeAudits(chatgpt.id).length).toBe(before);
  });

  it('an explicit lower asks for confirmation with the warning, then applies it, audited', async () => {
    const chatgpt = profile('chatgpt', 'write');
    const c = await consentPage(CHATGPT, 'ChatGPT');
    const ask = await post(c, { profile: chatgpt.id, scope: 'read' });
    expect(ask.status).toBe(200);
    const html = await ask.text();
    expect(html).toContain('This affects every connection on the profile');
    expect(html).toContain('from <strong>write</strong> to <strong>read</strong> (a lowering)');
    expect(html).toContain(`name="confirm_scope_change" value="${chatgpt.id}:write:read"`);
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('write'); // nothing yet
    await finish(c, { profile: chatgpt.id, scope: 'read', confirm_scope_change: `${chatgpt.id}:write:read` });
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('read');
    expect(scopeAudits(chatgpt.id)[0]).toMatchObject({
      actor: 'owner',
      before: { scope: 'write' },
      after: { scope: 'read', via: 'consent' },
    });
  });

  it('an explicit raise asks for confirmation, then applies it, audited', async () => {
    const chatgpt = profile('chatgpt', 'read');
    const c = await consentPage(CHATGPT, 'ChatGPT');
    const ask = await post(c, { profile: chatgpt.id, scope: 'write' });
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('(a raise)');
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('read');
    await finish(c, {
      profile: chatgpt.id,
      scope: 'write',
      confirm_scope_change: `${chatgpt.id}:read:write`,
      stepup_password: bridge.password, // CR-2026-11-R4: a raise needs the step-up (ADR 0062 decision 5)
    });
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('write');
    expect(scopeAudits(chatgpt.id)[0]).toMatchObject({
      before: { scope: 'read' },
      after: { scope: 'write', via: 'consent' },
    });
  });

  it('a confirmation for another change, or a profile changed meanwhile, asks again; "Keep" changes nothing', async () => {
    const chatgpt = profile('chatgpt', 'propose');
    const c = await consentPage(CHATGPT, 'ChatGPT');
    // A token for a different change (wrong current scope, wrong target, wrong profile) is not a confirmation.
    for (const token of [
      `${chatgpt.id}:read:write`,
      `${chatgpt.id}:propose:read`,
      `prof_other:propose:write`,
    ]) {
      const r = await post(c, { profile: chatgpt.id, scope: 'write', confirm_scope_change: token });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Confirm scope change');
    }
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('propose');
    // The "Keep" button on the confirmation page posts the current scope: approved, unchanged.
    const before = scopeAudits(chatgpt.id).length;
    await finish(c, {
      profile: chatgpt.id,
      scope: 'propose',
      confirm_scope_change: `${chatgpt.id}:propose:write`,
    });
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('propose');
    expect(scopeAudits(chatgpt.id).length).toBe(before);
  });

  it('switching the page to another existing profile never carries the preselected scope over silently', async () => {
    const chatgpt = profile('chatgpt', 'write');
    const other = profile('chatgpt-spare', 'read');
    const c = await consentPage(CHATGPT, 'ChatGPT');
    expect(consentDefaults(c.page.html).scope).toBe('keep'); // follows whichever profile is chosen (ADR 0033)
    // Only the profile select was changed: the scope is still "keep", so the other profile asks for nothing and keeps its own.
    const kept = await post(c, { profile: other.id, scope: 'keep' });
    expect(kept.status).toBe(303);
    expect(new URL(kept.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    expect(bridge.policy.store.getProfile(other.id)!.scope).toBe('read');
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('write');
    // An EXPLICIT scope that differs from the other profile's still asks first, and changes nothing yet.
    const d = await consentPage(CHATGPT, 'ChatGPT');
    const r = await post(d, { profile: other.id, scope: 'write' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('chatgpt-spare');
    expect(bridge.policy.store.getProfile(other.id)!.scope).toBe('read');
  });

  it("keep resolves to the chosen profile's scope without any confirmation, and to the default for a new profile", async () => {
    const chatgpt = profile('chatgpt', 'propose');
    const before = scopeAudits(chatgpt.id).length;
    const c = await consentPage(CHATGPT, 'ChatGPT');
    const ok = await post(c, { profile: chatgpt.id, scope: 'keep' });
    expect(ok.status).toBe(303); // no "Confirm scope change" page
    expect(bridge.policy.store.getProfile(chatgpt.id)!.scope).toBe('propose');
    expect(scopeAudits(chatgpt.id).length).toBe(before);
    // A new profile: keep is the default scope (here propose), not read.
    bridge.policy.commands.setDefaultScope('owner', 'propose');
    try {
      const d = await consentPage(CHATGPT, 'ChatGPT');
      expect(
        (await post(d, { profile: 'new', new_label: 'kept-new', new_kind: 'chatgpt', scope: 'keep' })).status,
      ).toBe(303);
      expect(bridge.policy.store.getProfileByLabel('kept-new')).toMatchObject({ scope: 'propose' });
    } finally {
      bridge.policy.commands.setDefaultScope('owner', 'read');
    }
    // A profile that vanished meanwhile: keep fails like any other choice, without using up the request.
    const e = await consentPage(CHATGPT, 'ChatGPT');
    const gone = await post(e, { profile: 'prof_gone', scope: 'keep' });
    expect(gone.status).toBe(400);
    expect(await gone.text()).toContain('no longer exists');
  });

  it('the new-profile fields are hidden by CSS :has() unless "New profile…" is selected, and need no script', async () => {
    const c = await consentPage(CHATGPT, 'ChatGPT');
    const html = c.page.html;
    // The rule the browser applies, and the fallback: visible under a heading wherever :has() is unsupported.
    expect(html).toContain('@supports selector(:has(*)){');
    expect(html).toContain('.new-profile{display:none}');
    expect(html).toContain('form:has(#profile option[value="new"]:checked) .new-profile{display:block}');
    expect(html).toMatch(
      /<div class="new-profile">\s*<h3>Only for New profile…<\/h3>\s*<label for="new_label">New profile label<\/label>[^\n]*\s*<label for="new_kind">New profile kind<\/label>[\s\S]*?<\/select>\s*<\/div>/,
    );
    // The fields sit inside the form, after the profile select; no script was added.
    expect(html).not.toMatch(/<script/i);
  });

  it('a new profile defaults to read, and follows the configured default scope', async () => {
    const LOOPBACK = 'http://127.0.0.1:43999/callback';
    expect(bridge.policy.store.getProfileByLabel('claude-code')).toBeUndefined();
    const c = await consentPage(LOOPBACK, 'Claude Code');
    expect(consentDefaults(c.page.html)).toMatchObject({
      profile: 'new',
      new_label: 'claude-code',
      scope: 'keep', // ADR 0033: "keep" resolves to the default scope for a new profile
    });
    expect(c.page.html).toContain('A new profile starts at read');
    bridge.policy.commands.setDefaultScope('owner', 'propose');
    try {
      const d = await consentPage(LOOPBACK, 'Claude Code');
      expect(consentDefaults(d.page.html)).toMatchObject({ profile: 'new', scope: 'keep' });
      expect(d.page.html).toContain('A new profile starts at propose');
    } finally {
      bridge.policy.commands.setDefaultScope('owner', 'read');
    }
    await finish(c); // the first page's defaults: a new profile at the default scope, read
    expect(bridge.policy.store.getProfileByLabel('claude-code')).toMatchObject({
      kind: 'claude-code',
      scope: 'read',
    });
  });
});

describe('tool lists and calls per scope', () => {
  const pat = (label: string) => {
    const created = bridge.services.pats.create({ name: label, profileId: profileFor(label).id });
    return created;
  };
  const profileFor = (label: string) =>
    bridge.policy.store.getProfileByLabel(label) ??
    bridge.policy.commands.createProfile('owner', { label, kind: 'other', scope: 'read' });

  it('read hides write tools; propose and write show them; the change is live for an existing token', async () => {
    const { token, pat: p } = pat('lists');
    const profileId = p.profileId!;
    expect(await toolNames(token)).not.toContain('stub_write');
    bridge.policy.commands.setScope('owner', profileId, 'propose');
    expect(await toolNames(token)).toContain('stub_write');
    const c = await connect(token);
    try {
      expect(json(await c.callTool({ name: 'stub_write', arguments: {} }))).toEqual({ decision: 'propose' });
      bridge.policy.commands.setScope('owner', profileId, 'write');
      expect(json(await c.callTool({ name: 'stub_write', arguments: {} }))).toEqual({ decision: 'allow' });
    } finally {
      await c.close();
    }
  });

  it('refuses a hidden write tool, and the gate refuses a write behind a mis-tagged tool', async () => {
    const { token } = pat('reader-only');
    const c = await connect(token);
    try {
      const hidden = await c.callTool({ name: 'stub_write', arguments: {} }).catch((e: unknown) => e);
      expect(hidden instanceof Error ? true : (hidden as { isError?: boolean }).isError).toBe(true);
      const sneaky = json(await c.callTool({ name: 'stub_mislabelled', arguments: {} }));
      expect(sneaky).toMatchObject({
        decision: 'deny',
        reason: expect.stringContaining('read-only') as unknown,
      });
    } finally {
      await c.close();
    }
  });

  it('takes the principal from the token, never from clientInfo', async () => {
    const { token, pat: p } = pat('spoofer');
    const c = await connect(token, 'system');
    try {
      const who = json(await c.callTool({ name: 'stub_whoami', arguments: {} }));
      expect(who).toMatchObject({ principal: { principalId: p.id, profile: 'spoofer' }, scope: 'read' });
    } finally {
      await c.close();
    }
  });

  it('an agent sees only its own proposals', async () => {
    const a = pat('agent-a');
    const b = pat('agent-b');
    const now = Date.now();
    bridge.db
      .prepare(
        `INSERT INTO proposals (id, project_id, principal_id, principal_label, profile, origin, job_kind, title,
           priority, summary, state, created_at, updated_at, expires_at, reject_reason)
         VALUES ('prop_a1', ?, ?, 'A', 'agent-a', '{"kind":"mcp"}', 'single_op', 't', 'P1', 'Proposed x', 'rejected',
           ?, ?, ?, 'No thanks')`,
      )
      .run(PROJECT, a.pat.id, now, now, now + 1000);
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    try {
      expect(
        json(await ca.callTool({ name: 'bridge_proposal_status', arguments: {} })).proposals,
      ).toHaveLength(1);
      expect(
        json(await ca.callTool({ name: 'bridge_proposal_status', arguments: { proposalId: 'prop_a1' } })),
      ).toMatchObject({
        state: 'rejected',
        rejectReason: 'No thanks',
      });
      expect(json(await cb.callTool({ name: 'bridge_proposal_status', arguments: {} })).proposals).toEqual(
        [],
      );
      const other = await cb.callTool({
        name: 'bridge_proposal_status',
        arguments: { proposalId: 'prop_a1' },
      });
      expect(other.isError).toBe(true);
      expect(JSON.stringify(other.content)).not.toContain('No thanks');
    } finally {
      await ca.close();
      await cb.close();
    }
  });
});

describe('the hidden-tools wrapper and its fallback (chunk 8, F-11)', () => {
  it('reports when the SDK internals it relies on are missing, so the factory can fall back to the strict server', async () => {
    const { hideFromList } = await import('../../src/mcp/server.js');
    let registered = 0;
    const register = () => {
      registered++;
    };
    // No handler map at all.
    expect(hideFromList({ server: {} } as never, new Set(), register)).toBe(false);
    // A map without a tools/list handler.
    expect(hideFromList({ server: { _requestHandlers: new Map() } } as never, new Set(), register)).toBe(
      false,
    );
    // A handler map with tools/list: it is wrapped and filters to the visible names.
    const handlers = new Map<string, unknown>([
      ['tools/list', () => Promise.resolve({ tools: [{ name: 'shown' }, { name: 'hidden' }] })],
    ]);
    expect(
      hideFromList({ server: { _requestHandlers: handlers } } as never, new Set(['shown']), register),
    ).toBe(true);
    const wrapped = handlers.get('tools/list') as (
      r: unknown,
      c: unknown,
    ) => Promise<{ tools: { name: string }[] }>;
    expect((await wrapped({}, {})).tools.map((t) => t.name)).toEqual(['shown']);
    expect(registered).toBe(2);
  });
});
