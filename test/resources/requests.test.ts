/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Request coordination and proposals for the create tools (v2 C2b, PLAN-v2 4.13): operation_id (a repeat returns the
 * earlier result, a different request with the same id is refused, a repeat of a proposal returns the proposal);
 * overlapping create_character requests for one character from two connections; `propose` scope (ONE proposal, ids
 * minted at capture and kept at approval, the page-level summary first); a failed job is never replayed and says what
 * was written and what was not, with the journal.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts, resourcesWorld, T, type ResourcesWorld, LIFECYCLE } from './world.js';

let w: ResourcesWorld;
let writer: Client;
let other: Client;
let proposer: Client;
const proposals = () => w.stack.runtime.policy.proposals;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const settle = async (id: string) => {
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};

beforeAll(async () => {
  w = await resourcesWorld();
  writer = await w.stack.connect();
  other = await w.stack.connect(w.stack.newToken('second-agent', 'write').token);
  proposer = await w.stack.connect(w.stack.newToken('c2b-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('operation_id', () => {
  it('the same id with the same request returns the earlier result and writes nothing again', async () => {
    const args = {
      project: 'test',
      name: 'Echo Hall',
      template: T.general,
      operation_id: 'op-echo-1',
    };
    const first = await w.stack.call(writer, 'create_resource', args);
    expect(first.body, first.text).toMatchObject({ status: 'written', verified: true });
    const before = writes().length;
    // Spacing and key order do not make it a different request.
    const again = await w.stack.call(writer, 'create_resource', { ...args, name: ' Echo  Hall ' });
    expect(again.body, again.text).toMatchObject({
      status: 'written',
      repeated: true,
      operation_id: 'op-echo-1',
      jobId: first.body.jobId,
      pages: [{ id: first.body.pages[0].id }],
    });
    expect(writes().length).toBe(before);
    expect(childNames(w, LIFECYCLE.working).filter((n) => n === '[BWRK] Echo Hall')).toHaveLength(1);
  });

  it('the same id with a different request is refused, and nothing is done', async () => {
    const before = writes().length;
    const r = await w.stack.call(writer, 'create_resource', {
      project: 'test',
      name: 'Other Hall',
      template: T.general,
      operation_id: 'op-echo-1',
    });
    expect(r.body.error).toMatchObject({ code: 'OPERATION_ID_REUSED', operation_id: 'op-echo-1' });
    expect(writes().length).toBe(before);
  });

  it('ids are per principal; a dry run or a refusal does not use the id up', async () => {
    const dry = await w.stack.call(writer, 'create_bare_resource', {
      project: 'test',
      name: '[BSRC] Dry Hall',
      operation_id: 'op-dry',
      dryRun: true,
    });
    expect(dry.body.status).toBe('dry_run');
    const refused = await w.stack.call(writer, 'create_bare_resource', {
      project: 'test',
      name: 'No Prefix',
      operation_id: 'op-dry',
    });
    expect(refused.body.error.code).toBe('INVALID_NAME');
    const real = await w.stack.call(writer, 'create_bare_resource', {
      project: 'test',
      name: '[BSRC] Dry Hall',
      operation_id: 'op-dry',
    });
    expect(real.body, real.text).toMatchObject({ status: 'written' });
    // Another connection may use the same id for its own request.
    const mine = await w.stack.call(other, 'create_bare_resource', {
      project: 'test',
      name: '[BSRC] Wet Hall',
      operation_id: 'op-dry',
    });
    expect(mine.body, mine.text).toMatchObject({ status: 'written' });
  });

  it('a repeat of a proposal returns the proposal', async () => {
    const args = {
      project: 'test',
      name: 'Proposed Hall',
      template: T.general,
      operation_id: 'op-prop',
    };
    const first = await w.stack.call(proposer, 'create_resource', args);
    expect(first.body, first.text).toMatchObject({ status: 'proposal_captured' });
    const again = await w.stack.call(proposer, 'create_resource', args);
    expect(again.body).toMatchObject({
      status: 'proposal_captured',
      repeated: true,
      proposalId: first.body.proposalId,
      proposalState: { state: 'pending' },
    });
    expect(
      proposals()
        .list({ project: PROJECT })
        .filter((p) => p.summary.includes('Proposed Hall')),
    ).toHaveLength(1);
  });
});

describe('duplicate character requests', () => {
  it('two overlapping requests for one character from two connections: the second is DUPLICATE_REQUEST', async () => {
    // The first waits for the owner (a pending proposal); the second, from another connection at scope write, overlaps.
    const first = await w.stack.call(proposer, 'create_character', {
      project: 'test',
      kind: 'core',
      name: 'Asagiri Sora',
      race: 'Foxians',
    });
    expect(first.body, first.text).toMatchObject({ status: 'proposal_captured' });
    const before = writes().length;
    const second = await w.stack.call(other, 'create_character', {
      project: 'test',
      kind: 'compact',
      name: '[BSRC]  asagiri   sora ',
      race: 'Foxians',
    });
    expect(second.body.error, second.text).toMatchObject({
      code: 'DUPLICATE_REQUEST',
      proposalId: first.body.proposalId,
    });
    expect(writes().length).toBe(before);
    // Once the first is decided, a new request is no longer a duplicate: it finds the page the first made.
    const id = String(first.body.proposalId);
    await w.stack.runtime.policy.commands.approve('owner', id);
    expect((await settle(id)).state).toBe('executed');
    const third = await w.stack.call(other, 'create_character', {
      project: 'test',
      kind: 'core',
      name: 'Asagiri Sora',
      race: 'Foxians',
    });
    expect(third.body, third.text).toMatchObject({ status: 'existing' });
  });

  it('a queued job counts as overlapping (writes paused)', async () => {
    w.stack.runtime.engine.controls.pauseWrites('test');
    try {
      const first = await w.stack.call(writer, 'create_character', {
        project: 'test',
        kind: 'compact',
        name: 'Held Person',
      });
      expect(first.body, first.text).toMatchObject({ status: 'queued' });
      const second = await w.stack.call(other, 'create_character', {
        project: 'test',
        kind: 'compact',
        name: 'held person',
      });
      expect(second.body.error).toMatchObject({ code: 'DUPLICATE_REQUEST', jobId: first.body.jobId });
    } finally {
      w.stack.runtime.engine.controls.resumeWrites('test');
    }
  });
});

describe('propose scope', () => {
  it('ONE proposal: the page-level summary first, ids minted at capture and kept at approval', async () => {
    const r = await w.stack.call(proposer, 'create_character', {
      project: 'test',
      kind: 'core',
      name: 'Ilse Varn',
      race: 'Humans',
      facts: { Scope: 'Ferrywoman' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured' });
    const [idx, core] = r.body.pages;
    const d = proposals().detail(String(r.body.proposalId))!;
    expect(d.pageSummary.map((e) => e.label)).toEqual([
      // v2 C2c: a Working character, under [INDEX] Working; its index gets no Status.
      `New page [INDEX] Ilse Varn under [INDEX] Working`,
      `New page [BWRK] Ilse Varn - Character Core under [INDEX] Ilse Varn: 6 facts`,
    ]);
    expect(d.operations).toHaveLength(2);
    expect(w.repo.res.get(idx.id)).toBeUndefined();
    await w.stack.runtime.policy.commands.approve('owner', d.id);
    expect((await settle(d.id)).state).toBe('executed');
    // Exactly the ids the proposal showed: the core under the index it showed.
    expect(w.repo.live(idx.id)).toMatchObject({ name: '[INDEX] Ilse Varn', parentId: LIFECYCLE.working });
    expect(w.repo.live(core.id)).toMatchObject({
      name: '[BWRK] Ilse Varn - Character Core',
      parentId: idx.id,
    });
    expect(facts(w, core.id)).toContain('Scope=Ferrywoman');
    expect(proposals().detail(d.id)!.execution).toMatchObject({ verified: true });
  });
});

describe('never replay failed work', () => {
  it('a job that stops part-way says what was written and what was not, with the journal; nothing is retried', async () => {
    // Someone deletes the new page's PROPERTIES right after the copy check: the next row write fails.
    let armed = true;
    w.sidebars.after(/^PATCH \/resources\/[^/]+\/properties\/[^/]+\/rows\//, 0, () => {
      if (!armed) return;
      armed = false;
      const id = [...w.sidebars.pages.keys()].at(-1)!;
      w.sidebars.outside(id, (sb) => {
        sb.props = sb.props.filter((p) => p.title !== 'PROPERTIES');
      });
    });
    const r = await w.stack.call(writer, 'create_resource', {
      project: 'test',
      name: 'Broken Hall',
      template: T.general,
      facts: { Scope: 'Half done' },
    });
    expect(r.body.error, r.text).toMatchObject({ code: 'WRITTEN_IN_PART' });
    expect(r.body.error.written).toEqual(expect.arrayContaining(['create [BWRK] Broken Hall']));
    expect(r.body.error.notWritten.length).toBeGreaterThan(0);
    expect(r.body.error.journal.length).toBeGreaterThanOrEqual(2);
    expect(r.body.error.hint).toMatch(/Do not repeat this request/);
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, r.body.error.jobId)!.status).toBe('failed');
  });
});
