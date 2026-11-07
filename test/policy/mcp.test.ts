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
import { mcpOrigin } from '../../src/policy/index.js';
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
            { origin: mcpOrigin(ctx, 'stub_write'), jobKind: 'single_op' },
          ),
        ),
      },
    ],
  }),
});

/** Wrongly tagged `read`, so it is listed to everyone: the gate must still refuse its write. */
const mislabelled = (): McpToolProvider => ({ ...writeStub(), name: 'stub_mislabelled', access: 'read' });

beforeAll(async () => {
  bridge = await startBridge({ tools: [whoami, writeStub(), mislabelled()] });
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
    expect(consentDefaults(html)).toMatchObject({ new_label: 'claude', new_kind: 'claude', scope: 'read' });
    expect(html).toContain('name="scope" value="read" checked');
    expect(html).not.toMatch(/value="(propose|write)" checked/);
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
    expect(await toolNames(t.access)).toEqual([
      'bridge_proposal_status',
      'bridge_proposals_mine',
      'stub_mislabelled',
      'stub_whoami',
    ]);
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
    const t = await finish(c, { profile: claude.id, scope: 'propose' });
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
    await finish(c, { profile: 'new', new_label: 'Claude mobile', new_kind: 'claude', scope: 'write' });
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
        `INSERT INTO proposals (id, principal_id, principal_label, profile, origin, job_kind, title, priority, summary,
           state, created_at, updated_at, expires_at, reject_reason)
         VALUES ('prop_a1', ?, 'A', 'agent-a', '{"kind":"mcp"}', 'single_op', 't', 'P1', 'Proposed x', 'rejected',
           ?, ?, ?, 'No thanks')`,
      )
      .run(a.pat.id, now, now, now + 1000);
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    try {
      expect(
        json(await ca.callTool({ name: 'bridge_proposals_mine', arguments: {} })).proposals,
      ).toHaveLength(1);
      expect(
        json(await ca.callTool({ name: 'bridge_proposal_status', arguments: { proposalId: 'prop_a1' } })),
      ).toMatchObject({
        state: 'rejected',
        rejectReason: 'No thanks',
      });
      expect(json(await cb.callTool({ name: 'bridge_proposals_mine', arguments: {} })).proposals).toEqual([]);
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
