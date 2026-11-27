/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * The guards of the page lifecycle (v2 C2c, ADR 0035):
 *
 * - canonical at scope `propose`: each lifecycle tool is a canonical proposal, the ordinary Approve is refused, and
 *   the guards run again at execution (a page changed after capture conflicts; approved work without the lifecycle
 *   marker is refused); v3 F12 (ADR 0081): at scope `write` the lifecycle tools are direct;
 * - the side routes (Part 3, owner): set_facts, lk_api_write (updatePropertyRow), a rename and a move are each refused,
 *   naming the tool to use; an agent's body can never carry the marker.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { facts } from '../resources/world.js';
import { L, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let writer: Client;
let proposer: Client;
const call = (c: Client, tool: string, args: Record<string, unknown>) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const proposals = () => w.stack.runtime.policy.proposals;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const rowId = (page: string, key: string) =>
  w.sidebars.pages.get(page)!.props[0]!.rows!.find((r) => r.key === key)!.id;
const propId = (page: string) => w.sidebars.pages.get(page)!.props[0]!.id;

beforeAll(async () => {
  w = await lifecycleWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('lifecycle-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('at scope propose, always the owner’s canonical approval', () => {
  it('each tool is a canonical proposal at scope propose; the ordinary Approve is refused', async () => {
    const before = writes().length;
    const cases: [Client, string, Record<string, unknown>][] = [
      [proposer, 'archive_page', { page: 'Old Harbour' }],
      [proposer, 'archive_page', { page: 'Tide Tables' }],
      [proposer, 'move_to_working', { page: 'Harbour Guild' }],
      [proposer, 'promote_page', { page: 'Sky Ferry', destination: 'Kumikas' }],
    ];
    for (const [c, tool, args] of cases) {
      const r = await call(c, tool, args);
      expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
      expect(r.body.reason).toMatch(new RegExp(`${tool} changes a page’s lifecycle state`));
      const id = String(r.body.proposalId);
      await expect(w.stack.runtime.policy.commands.approve('owner', id)).rejects.toMatchObject({
        code: 'CANONICAL_APPROVAL_REQUIRED',
      });
      // A second request for the same page while the first waits is a duplicate.
      const dup = await call(c, tool, args);
      expect(dup.body.error, dup.text).toMatchObject({ code: 'DUPLICATE_REQUEST', proposalId: id });
      w.stack.runtime.policy.commands.reject('owner', id, 'not now');
    }
    expect(writes().length).toBe(before);
  });

  it('checked again at execution: a page changed after capture conflicts, and nothing is written', async () => {
    const r = await call(proposer, 'archive_page', { page: 'Old Harbour' });
    const id = String(r.body.proposalId);
    // Someone renames the page in the app before the owner approves.
    w.repo.res.get(L.harbour)!.name = '[BSRC] Old Harbour (renamed)';
    const before = writes().length;
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id).catch(() => undefined);
    for (
      let i = 0;
      i < 200 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state);
      i++
    )
      await new Promise((res) => setTimeout(res, 20));
    expect(['conflicted', 'failed']).toContain(proposals().get(id)!.state);
    expect(writes().length).toBe(before);
    w.repo.res.get(L.harbour)!.name = '[BSRC] Old Harbour';
  });

  it('approved work without the lifecycle marker is refused at execution (the marker is bridge code’s alone)', async () => {
    const r = await call(proposer, 'move_to_working', { page: 'Harbour Guild' });
    const id = String(r.body.proposalId);
    // Tampered in the database: the stored job options lose the marker.
    const row = w.stack.db.prepare('SELECT job_options FROM proposals WHERE id = ?').get(id) as {
      job_options: string;
    };
    const opts = JSON.parse(row.job_options) as Record<string, unknown>;
    delete opts.lifecycle;
    w.stack.db.prepare('UPDATE proposals SET job_options = ? WHERE id = ?').run(JSON.stringify(opts), id);
    const before = writes().length;
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id).catch(() => undefined);
    for (
      let i = 0;
      i < 200 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state);
      i++
    )
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals().get(id)!.state).toBe('failed');
    expect(JSON.stringify(proposals().detail(id))).toMatch(
      /Lifecycle changes .* happen only through the lifecycle tools/,
    );
    expect(writes().length).toBe(before);
    expect(w.repo.live(L.guild)!.name).toBe('[BSRC] Harbour Guild');
  });
});

describe('the side routes are refused, naming the tool to use', () => {
  it('set_facts: Status → Archived, Working → Authoritative, Authoritative → Working', async () => {
    const before = writes().length;
    const a = await call(writer, 'set_facts', { page: 'Old Harbour', facts: { Status: 'Archived' } });
    expect(a.body.error, a.text).toMatchObject({ code: 'POLICY_DENIED' });
    expect(a.body.error.message).toMatch(/use archive_page/);
    const p = await call(writer, 'set_facts', { page: 'Sky Ferry', facts: { Status: 'Authoritative' } });
    expect(p.body.error.message).toMatch(/use promote_page/);
    const m = await call(writer, 'set_facts', { page: 'Old Harbour', facts: { Status: 'Working' } });
    expect(m.body.error.message).toMatch(/use move_to_working/);
    // Even at scope propose: refused, not proposed.
    const pr = await call(proposer, 'set_facts', { page: 'Old Harbour', facts: { Status: 'Archived' } });
    expect(pr.body.error.code).toBe('POLICY_DENIED');
    expect(writes().length).toBe(before);
    expect(facts(w, L.harbour)).toContain('Status=Authoritative');
  });

  it('lk_api_write (updatePropertyRow), lk_api_batch and lk_op_*', async () => {
    const before = writes().length;
    const path = { resourceId: L.harbour, propertyId: propId(L.harbour), rowId: rowId(L.harbour, 'Status') };
    const low = await call(writer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path, body: { content: [{ text: 'Archived' }] } },
    });
    expect(low.body.error, low.text).toMatchObject({ code: 'POLICY_DENIED' });
    expect(low.body.error.message).toMatch(/use archive_page/);
    const batch = await call(writer, 'lk_api_batch', {
      calls: [
        { operationId: 'updateResource', params: { path: { resourceId: L.harbour }, body: { tags: ['x'] } } },
        {
          operationId: 'moveResource',
          params: { path: { resourceId: L.harbour }, body: { parentId: LIFECYCLE.archived } },
        },
      ],
    });
    expect(batch.body.error.message).toMatch(/moved into \[INDEX\] Archived — use archive_page/);
    const op = await call(writer, 'lk_op_updateResource', {
      path: { resourceId: L.harbour },
      body: { name: '[BARC] Old Harbour' },
    });
    expect(op.body.error.message).toMatch(/renamed to \[BARC\] Old Harbour — use archive_page/);
    // A create body: a [BWRK] page by hand, or a page under [INDEX] Archived.
    const create = await call(writer, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[BWRK] Sneaky', parentId: LIFECYCLE.working } },
    });
    expect(create.body.error.message).toMatch(/create_resource with status "working"/);
    expect(writes().length).toBe(before);
  });

  it('update_resource and move_resource: a prefix change and a move across a lifecycle index', async () => {
    const before = writes().length;
    const rename = await call(writer, 'update_resource', { page: 'Old Harbour', name: '[BARC] Old Harbour' });
    expect(rename.body.error.code).toBe('PREFIX_CHANGE');
    expect(rename.body.error.message).toMatch(
      /archive_page, unarchive_page, move_to_working or promote_page/,
    );
    const into = await call(writer, 'move_resource', { page: 'Old Harbour', to: LIFECYCLE.archived });
    expect(into.body.error, into.text).toMatchObject({ code: 'POLICY_DENIED' });
    expect(into.body.error.message).toMatch(/use archive_page/);
    const out = await call(writer, 'move_resource', { page: 'Sky Ferry', to: 'Kumikas' });
    expect(out.body.error.message).toMatch(/use promote_page/);
    const between = await call(writer, 'move_resource', { page: 'Sky Ferry', to: LIFECYCLE.archived });
    expect(between.body.error.message).toMatch(/use archive_page/);
    expect(writes().length).toBe(before);
    // Ordinary changes still go through: a Working page's other facts, and its tags.
    const ok = await call(writer, 'set_facts', {
      page: 'Sky Ferry',
      facts: { Scope: 'A ferry of the high clouds' },
    });
    expect(ok.body, ok.text).toMatchObject({ status: 'written', verified: true });
    const rn = await call(writer, 'update_resource', { page: 'Sky Ferry', name: 'Cloud Ferry' });
    expect(rn.body, rn.text).toMatchObject({ status: 'written' });
    expect(w.repo.live(L.ferry)!.name).toBe('[BWRK] Cloud Ferry');
  });

  it('the lifecycle tools themselves pass the guards (direct at scope write, F12)', async () => {
    const r = await call(writer, 'archive_page', { page: 'Tide Tables' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.jobId).toEqual(expect.any(String));
    expect(w.stack.runtime.lifecycle.store.latest(PROJECT, L.tides, ['archive'])).toMatchObject({
      state: 'complete',
    });
  });
});
