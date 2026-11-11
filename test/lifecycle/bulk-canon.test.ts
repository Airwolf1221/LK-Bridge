/**
 * "Accept selected as canon" (owner, 11 November): the bulk version of "Approve and accept as canon", through the REAL
 * server and policy layer. Three kinds of canonical proposal in one bulk (Status → Authoritative, archive_page, the delete
 * of an Authoritative page): each is approved on its own, in order, with its own audit row; the guards run again at
 * execution; an ordinary proposal is refused here and left pending; plain bulk approve passes canonical ones over.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import { kvText, P } from '../facts/world.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const commands = () => w.stack.runtime.policy.commands;
const proposals = () => w.stack.runtime.policy.proposals;

/** A second set of pages, so the conflict test has three of its own to act on. */
const B = { saltRoad: 'saltrd01', lampKeepers: 'lamps001' } as const;

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      world.repo.seed({ id: B.saltRoad, name: '[BSRC] Salt Road', parentId: 'locs0001', tags: ['CANON'] });
      world.repo.seed({
        id: B.lampKeepers,
        name: '[BSRC] Lamp Keepers',
        parentId: 'locs0001',
        tags: ['CANON'],
      });
    },
  });
  for (const id of [B.saltRoad, B.lampKeepers]) {
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id}`, 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Authoritative'],
        ['Continuity Type', 'CANON'],
        ['Scope', 'A place'],
        ['Temporal Scope', 'Fourth Age'],
      ]),
    ]);
  }
  client = await w.stack.connect();
});
afterAll(async () => w.close());

/** Captures one proposal and returns its id (checked canonical). */
async function capture(tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(tool, args);
  expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  return String(r.body.proposalId);
}

async function settle(ids: string[]): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ids.every((id) => ['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state))) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('proposals did not settle');
}

const auditRows = (action: string) => w.stack.policy.store.listAudit({ limit: 200, action });

describe('Accept selected as canon', () => {
  it('runs a mix of three canonical proposals, each with its own approval and audit row', async () => {
    const ids = [
      await capture('set_facts', { page: P.miyabi, facts: { Status: 'Authoritative' } }),
      await capture('archive_page', { page: 'Old Harbour' }),
      await capture('delete_resource', { page: 'Tide Tables', confirm: true }),
    ];
    const before = auditRows('proposal.approve_as_canon').length;

    const results = await commands().bulkApproveAsCanon('owner', ids);
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    await settle(ids);

    for (const id of ids) {
      const p = proposals().get(id)!;
      expect(p, JSON.stringify(p)).toMatchObject({ state: 'executed', canonicalApprovedBy: 'owner' });
      expect(p.canonicalApprovedAt).toBeTypeOf('number');
    }
    // The three changes happened.
    expect(kvText(w.sidebars.rows(P.miyabi))).toContain('Status=Authoritative');
    expect(w.repo.live(L.harbour)!.name).toBe('[BARC] Old Harbour');
    expect(w.repo.live(L.tides)).toBeUndefined();

    // One audit row per proposal, each recording who accepted it as canon, and that it was a bulk.
    const rows = auditRows('proposal.approve_as_canon');
    expect(rows.length - before).toBe(3);
    for (const id of ids) {
      const row = rows.find((r) => r.target === id)!;
      expect(row, id).toBeDefined();
      expect(row.after).toMatchObject({ state: 'approved', canonicalApprovedBy: 'owner', bulk: true });
    }
  });

  it('checks the guards again at execution: a target changed after capture ends conflicted, the others run', async () => {
    const ids = [
      await capture('set_facts', { page: P.mehrana, facts: { Status: 'Authoritative' } }),
      await capture('archive_page', { page: 'Lamp Keepers' }),
      await capture('delete_resource', { page: 'Salt Road', confirm: true }),
    ];
    // Meanwhile, in the LegendKeeper app: someone edits Mehrana's sidebar.
    w.sidebars.outside(P.mehrana, (sb) => {
      sb.props[0]!.rows!.push({
        id: 'rowoutsd',
        key: 'Notes',
        rank: 'zz',
        content: [{ text: 'Edited in the app' }],
      });
    });

    const results = await commands().bulkApproveAsCanon('owner', ids);
    await settle(ids);
    expect(results[0]).toMatchObject({ id: ids[0], ok: false, state: 'conflicted' });
    expect(results[1]!.ok && results[2]!.ok).toBe(true);

    expect(proposals().get(ids[0]!)).toMatchObject({ state: 'conflicted' });
    expect(kvText(w.sidebars.rows(P.mehrana))).not.toContain('Status=Authoritative');
    expect(proposals().get(ids[1]!)!.state).toBe('executed');
    expect(proposals().get(ids[2]!)!.state).toBe('executed');
    expect(w.repo.live(B.saltRoad)).toBeUndefined();
    expect(w.repo.live(B.lampKeepers)!.name).toBe('[BARC] Lamp Keepers');
  });

  it('refuses an ordinary proposal in the canon action and leaves it pending; plain bulk approve skips canonical ones', async () => {
    // At scope propose an ordinary write is captured as a proposal rather than run.
    const proposer = await w.stack.connect(w.stack.newToken('bulk-proposer', 'propose').token);
    const ordinary = await w.stack.call(proposer, 'set_facts', {
      project: 'test',
      page: P.ashgate,
      facts: { Notes: 'Proposed notes' },
    });
    expect(ordinary.body, ordinary.text).toMatchObject({ status: 'proposal_captured' });
    expect(ordinary.body.requiresCanonicalApproval).toBeFalsy();
    const ordId = String(ordinary.body.proposalId);
    const canonId = await capture('set_facts', { page: P.inae, facts: { Status: 'Outline' } });

    const canon = await commands().bulkApproveAsCanon('owner', [ordId]);
    expect(canon).toEqual([
      {
        id: ordId,
        ok: false,
        state: 'pending',
        error: { code: 'NOT_CANONICAL', message: 'ordinary proposal; use Approve' },
      },
    ]);
    expect(proposals().get(ordId)!.state).toBe('pending');

    const plain = await commands().bulkApprove('owner', [canonId]);
    expect(plain).toMatchObject([
      {
        id: canonId,
        ok: false,
        skipped: true,
        state: 'pending',
        error: { code: 'CANONICAL_APPROVAL_REQUIRED' },
      },
    ]);
    expect(proposals().get(canonId)!.state).toBe('pending');
    // An unknown id is refused on its own, not skipped.
    const [missing] = await commands().bulkApproveAsCanon('owner', ['prop_nope']);
    expect(missing).toMatchObject({ ok: false, error: { code: 'PROPOSAL_NOT_FOUND' } });
    expect(missing!.skipped).toBeUndefined();
  });

  it('bulk reject works on canonical proposals: rejecting needs no canon decision', async () => {
    const id = await capture('archive_page', { page: 'Harbour Guild' });
    const out = commands().bulkReject('owner', [id], 'No canon change');
    expect(out).toEqual([{ id, ok: true, state: 'rejected' }]);
    expect(proposals().get(id)).toMatchObject({ state: 'rejected', canonicalApprovedBy: null });
  });

  it('is for the owner alone', async () => {
    const id = await capture('archive_page', { page: 'Harbour Guild' });
    await expect(commands().bulkApproveAsCanon('agent' as never, [id])).rejects.toMatchObject({
      code: 'NOT_OWNER',
    });
    expect(proposals().get(id)!.state).toBe('pending');
  });
});
