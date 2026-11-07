/**
 * Negative test (requirement 8): nothing reachable by an agent can change a profile's scope, approve or reject a
 * proposal, or create or revoke a token. Every MCP tool the bridge registers is listed (at `write` scope, so all are
 * visible) and called with arguments aimed at policy state; the policy, token and proposal tables must not change.
 * A static check also keeps the owner command layer and the approval-token minting out of every MCP module.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestBridge, startBridge } from '../auth/helpers.js';

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge(); // the production tool list
});
afterAll(() => bridge.close());

/** Everything an escalation would change (last-use timestamps excluded). */
function snapshot(): string {
  const q = (sql: string) => bridge.db.prepare(sql).all();
  return JSON.stringify({
    profiles: q('SELECT id, label, kind, scope FROM agent_profiles ORDER BY id'),
    settings: q('SELECT key, value FROM policy_settings ORDER BY key'),
    proposals: q(
      'SELECT id, state, decided_by, decided_at, reject_reason, job_id FROM proposals ORDER BY id',
    ),
    grants: q('SELECT family_id, revoked_at, profile_id FROM auth_token_families ORDER BY family_id'),
    pats: q('SELECT id, revoked_at, profile_id, expires_at FROM auth_pats ORDER BY id'),
    audit: q('SELECT COUNT(*) AS n FROM audit_log'),
  });
}

/** Candidate argument sets for a tool's JSON input schema, aimed at policy state. */
function argumentSets(
  schema: { properties?: Record<string, { type?: string; enum?: unknown[] }> },
  ids: string[],
) {
  const props = Object.entries(schema.properties ?? {});
  const extras = {
    approve: true,
    decision: 'approve',
    scope: 'write',
    profile: 'write',
    approvedBy: 'owner',
  };
  const sets: Record<string, unknown>[] = [{}, extras];
  for (const candidate of [...ids, 'write', 'owner', 'approve']) {
    const args: Record<string, unknown> = {};
    for (const [name, p] of props) {
      if (p.enum?.length) args[name] = p.enum[0];
      else if (p.type === 'string') args[name] = candidate;
      else if (p.type === 'number' || p.type === 'integer') args[name] = 1;
      else if (p.type === 'boolean') args[name] = true;
    }
    sets.push(args, { ...args, ...extras });
  }
  return sets;
}

describe('no MCP tool can change policy, tokens or proposal decisions', () => {
  it('calls every registered tool with hostile arguments and finds nothing changed', async () => {
    const profile = bridge.policy.commands.createProfile('owner', {
      label: 'agent',
      kind: 'other',
      scope: 'write',
    });
    const victim = bridge.policy.commands.createProfile('owner', {
      label: 'victim',
      kind: 'other',
      scope: 'read',
    });
    const { token, pat } = bridge.services.pats.create({ name: 'agent', profileId: profile.id });
    const other = bridge.services.pats.create({ name: 'other', profileId: victim.id });
    const now = Date.now();
    for (const [id, who] of [
      ['prop_mine', pat.id],
      ['prop_theirs', other.pat.id],
    ] as const) {
      bridge.db
        .prepare(
          `INSERT INTO proposals (id, principal_id, principal_label, profile, origin, job_kind, title, priority,
             summary, state, created_at, updated_at, expires_at)
           VALUES (?, ?, 'x', 'agent', '{"kind":"mcp"}', 'single_op', 't', 'P1', 's', 'pending', ?, ?, ?)`,
        )
        .run(id, who, now, now, now + 86_400_000);
    }
    const ids = ['prop_mine', 'prop_theirs', profile.id, victim.id, pat.id, other.pat.id];
    const before = snapshot();

    const client = new Client({ name: 'attacker', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.mcpUrl), {
        fetch: (url: string | URL, init?: RequestInit) => fetch(bridge.local(String(url)), init),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        // No tool even claims to administer policy.
        expect(tool.name).not.toMatch(
          /approve|reject|revoke|scope|profile|token|grant|policy|consent|audit/i,
        );
        for (const args of argumentSets(tool.inputSchema as never, ids)) {
          await client.callTool({ name: tool.name, arguments: args }).catch(() => undefined);
        }
      }
    } finally {
      await client.close();
    }
    expect(snapshot()).toBe(before);
  });

  it('no MCP module imports the owner command layer or mints approval tokens', () => {
    const files = [
      ...readdirSync(join('src', 'mcp')).map((f) => join('src', 'mcp', f)),
      join('src', 'policy', 'mcp.ts'),
    ].filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/commands\.js|issueApprovalToken|ApprovalToken\.mint/);
    }
    expect(readFileSync(join('src', 'policy', 'index.ts'), 'utf8')).not.toMatch(
      /export[^;]*issueApprovalToken/,
    );
  });
});
