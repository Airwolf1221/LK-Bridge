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
import type { AuthServices } from '../../src/auth/services.js';
import type { Db } from '../../src/db/open.js';
import type { Policy } from '../../src/policy/index.js';
import { type TestBridge, startBridge } from '../auth/helpers.js';
import { startStack, type Stack } from '../tools/helpers.js';
import { specRespond } from '../tools/spec-mock.js';
import { operations } from '../../src/lk/index.js';

const operationIds = new Set(operations.map((o) => o.operationId));

let bridge: TestBridge;
let stack: Stack;
beforeAll(async () => {
  bridge = await startBridge(); // the auth harness: stub tools plus the proposal tools
  stack = await startStack({ respond: specRespond() }); // the real runtime: every production tool
});
afterAll(async () => {
  await bridge.close();
  await stack.close();
});

/** Everything an escalation would change (last-use timestamps excluded). */
function snapshot(db: Db): string {
  const q = (sql: string) => db.prepare(sql).all();
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

interface Target {
  readonly db: Db;
  readonly policy: Policy;
  readonly pats: AuthServices['pats'];
  readonly mcpUrl: string;
  readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

async function attack(t: Target): Promise<string[]> {
  const profile = t.policy.commands.createProfile('owner', { label: 'agent', kind: 'other', scope: 'write' });
  // v2 B2: the low-level tools are hidden by default; the attacker is shown every tool so every one is attacked.
  t.policy.commands.setShowLowLevelTools('owner', profile.id, true);
  const victim = t.policy.commands.createProfile('owner', { label: 'victim', kind: 'other', scope: 'read' });
  const { token, pat } = t.pats.create({ name: 'agent', profileId: profile.id });
  const other = t.pats.create({ name: 'other', profileId: victim.id });
  const now = Date.now();
  // v2 A1: proposals belong to a registered project (the runtime has registered the mock's; the auth harness has none).
  t.db
    .prepare(
      `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('proj_mock', 'mock', ?, ?)`,
    )
    .run(now, now);
  for (const [id, who] of [
    ['prop_mine', pat.id],
    ['prop_theirs', other.pat.id],
  ] as const) {
    t.db
      .prepare(
        `INSERT INTO proposals (id, project_id, principal_id, principal_label, profile, origin, job_kind, title,
           priority, summary, state, created_at, updated_at, expires_at)
         VALUES (?, 'proj_mock', ?, 'x', 'agent', '{"kind":"mcp"}', 'single_op', 't', 'P1', 's', 'pending', ?, ?, ?)`,
      )
      .run(id, who, now, now, now + 86_400_000);
  }
  const ids = ['prop_mine', 'prop_theirs', profile.id, victim.id, pat.id, other.pat.id];
  const before = snapshot(t.db);
  const client = new Client({ name: 'attacker', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(t.mcpUrl), {
      ...(t.fetch ? { fetch: t.fetch } : {}),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const names: string[] = [];
  try {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      names.push(tool.name);
      if (tool.name.startsWith('lk_op_')) {
        // A per-operation tool is exactly one LegendKeeper operation (lk_op_revokeInvite revokes a LegendKeeper invite,
        // refused unless LK_ALLOW_MEMBER_ADMIN=true; it touches no bridge policy).
        expect(operationIds.has(tool.name.slice('lk_op_'.length)), tool.name).toBe(true);
      } else {
        // No bridge tool even claims to administer policy.
        expect(tool.name).not.toMatch(
          // v2 E2: `audit_findings` reads the audits' findings (read-only); the policy audit log stays unreachable.
          /approve|reject|revoke|scope|profile|token|grant|policy|consent|audit(?!_findings$)/i,
        );
      }
      for (const args of argumentSets(tool.inputSchema as never, ids)) {
        await client.callTool({ name: tool.name, arguments: args }).catch(() => undefined);
      }
    }
  } finally {
    await client.close();
  }
  expect(snapshot(t.db)).toBe(before);
  return names;
}

describe('no MCP tool can change policy, tokens or proposal decisions', () => {
  it('calls every registered tool with hostile arguments and finds nothing changed (auth harness)', async () => {
    await attack({
      db: bridge.db,
      policy: bridge.policy,
      pats: bridge.services.pats,
      mcpUrl: bridge.mcpUrl,
      fetch: (url, init) => fetch(bridge.local(String(url)), init),
    });
  });

  it('the same against the real runtime, with every production tool', async () => {
    const names = await attack({
      db: stack.db,
      policy: stack.policy,
      pats: stack.services.pats,
      mcpUrl: `${stack.base}/mcp`,
    });
    // Retired names (v2 E3b) are registered but never listed: they answer "renamed to …" and do nothing.
    const listed = stack.runtime.tools.filter((t) => t.retired !== true);
    expect(names).toEqual(expect.arrayContaining(listed.map((t) => t.name)));
    expect(names).toHaveLength(listed.length);
  }, 30_000);

  it('the same with MCP_EXPOSE_PER_OP_TOOLS=true: every one of the 89 lk_op_* tools too (chunk 8, F-12)', async () => {
    const perOp = await startStack({ respond: specRespond(), env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
    try {
      const names = await attack({
        db: perOp.db,
        policy: perOp.policy,
        pats: perOp.services.pats,
        mcpUrl: `${perOp.base}/mcp`,
      });
      expect(names.filter((n) => n.startsWith('lk_op_'))).toHaveLength(89);
      const listed = perOp.runtime.tools.filter((t) => t.retired !== true);
      expect(names).toEqual(expect.arrayContaining(listed.map((t) => t.name)));
      expect(names).toHaveLength(listed.length);
    } finally {
      await perOp.close();
    }
  }, 120_000);

  it('no MCP module imports the owner command layer or mints approval tokens', () => {
    const files = [
      ...readdirSync(join('src', 'mcp')).map((f) => join('src', 'mcp', f)),
      ...readdirSync(join('src', 'mcp', 'tools')).map((f) => join('src', 'mcp', 'tools', f)),
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
