/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F12 follow-up (the owner, 27 November 2026; ADR 0081 amendment 1, decision 2): a Status or Continuity Type value
 * that only looks like an allowed value (Unicode's confusables, UTS #39) is an invalid value, refused at every scope and
 * by every route, the allowed values listed. Nothing is written, nothing is proposed.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let writer: Client;
let proposer: Client;
const call = (c: Client, tool: string, args: Record<string, unknown>) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const proposals = () => w.stack.runtime.policy.commands.listProposals('owner', { project: PROJECT }).length;
const rowId = (page: string, key: string) =>
  w.sidebars.pages.get(page)!.props[0]!.rows!.find((r) => r.key === key)!.id;
const propId = (page: string) => w.sidebars.pages.get(page)!.props[0]!.id;
const valueOf = (page: string, key: string) =>
  JSON.stringify(w.sidebars.pages.get(page)!.props[0]!.rows!.find((r) => r.key === key)!.content);

/** Authoritative with a Cyrillic а; CANON with a Cyrillic А; Working with a zero-width space. */
const AUTHORITATIVE = 'Authoritаtive';
const CANON = 'CАNON';
const WORKING = 'Wor​king';

beforeAll(async () => {
  w = await lifecycleWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  writer = await w.stack.connect(w.stack.newToken('f12-lookalike-writer', 'write').token);
  proposer = await w.stack.connect(w.stack.newToken('f12-lookalike-proposer', 'propose').token);
});
afterAll(async () => w.close());

async function refused(c: Client, tool: string, args: Record<string, unknown>, allowed: RegExp) {
  const before = { writes: writes().length, proposals: proposals() };
  const r = await call(c, tool, args);
  expect(r.isError, r.text).toBe(true);
  expect(r.body.status, r.text).not.toBe('proposal_captured');
  expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
  expect(r.body.error?.message, r.text).toMatch(/only looks like .*not an allowed value/);
  expect(r.body.error?.message, r.text).toMatch(allowed);
  expect({ writes: writes().length, proposals: proposals() }).toEqual(before);
}

const STATUS_ALLOWED = /“Authoritative”, “Working”, “Archived”/;
const CONTINUITY_ALLOWED = /“CANON”, “AU”/;

describe('a look-alike lifecycle value is refused at every scope, the allowed values listed', () => {
  for (const [scope, client] of [
    ['write', () => writer],
    ['propose', () => proposer],
  ] as const) {
    it(`at scope ${scope}: set_facts Status “Authoritаtive” (a Cyrillic а) on an Authoritative page`, async () => {
      const before = valueOf(L.harbour, 'Status');
      await refused(
        client(),
        'set_facts',
        { page: L.harbour, facts: { Status: AUTHORITATIVE } },
        STATUS_ALLOWED,
      );
      expect(valueOf(L.harbour, 'Status')).toBe(before);
    });

    it(`at scope ${scope}: set_facts Continuity Type “CАNON” (a Cyrillic А)`, async () => {
      await refused(
        client(),
        'set_facts',
        { page: L.harbour, facts: { 'Continuity Type': CANON } },
        CONTINUITY_ALLOWED,
      );
    });
  }

  it('through the low-level tools: lk_api_write updatePropertyRow with a zero-width space in Working', async () => {
    await refused(
      writer,
      'lk_api_write',
      {
        operationId: 'updatePropertyRow',
        params: {
          path: { resourceId: L.ferry, propertyId: propId(L.ferry), rowId: rowId(L.ferry, 'Status') },
          body: { content: [{ text: WORKING }] },
        },
      },
      STATUS_ALLOWED,
    );
  });
});

describe('an allowed value, typed plainly, is not a look-alike', () => {
  it('Continuity Type AU at scope write: direct (F12)', async () => {
    const r = await call(writer, 'set_facts', { page: L.harbour, facts: { 'Continuity Type': 'AU' } });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect(valueOf(L.harbour, 'Continuity Type')).toContain('AU');
  });
});
