/**
 * CR-2026-11 round 2 (write scope), the bulk rail (ADR 0055 decision C: "Bulk changes, more than N pages in one job …
 * each page written, each page made (createManyResources item by item), a cascade's page and every page under it").
 *
 * Every test asserts the SAFE behaviour: a request that changes more than 10 pages at once, made by an agent at scope
 * `write` with the DEFAULT rails, is ONE proposal and nothing is sent. A failure means the attack worked.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WRITE_RAILS } from '../../../src/policy/rails.js';
import { buildModels, discoverWorld, ROOT, type DiscoverWorld } from '../../discover/world.js';
import { PROJECT } from '../../tools/helpers.js';
import {
  liveUnder,
  modelSaveAsTemplate,
  mutationsSince,
  railsOf,
  writeAgent,
  writeCallsSince,
  type Agent,
} from './helpers.js';

let w: DiscoverWorld;
let a: Agent;
const KIDS = 15;
const TEMPLATE = 'tplbulk1';
const SAVEBOX = 'savebox1';
const RESTOREBOX = 'rstbox01';
const STALEBOX = 'stalebx1';
const kid = (p: string, i: number) => `${p}${i.toString(36).padStart(8 - p.length, '0')}`;

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    build: false,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  // A plain template (no prefix, no Status) with 15 pages under it, as an owner might keep one.
  w.repo.seed({ id: TEMPLATE, name: 'Bulk Template', parentId: null });
  for (let i = 0; i < KIDS; i++)
    w.repo.seed({ id: kid('tbk', i), name: `Bulk child ${i}`, parentId: TEMPLATE });
  // A plain page in the repository with 15 pages under it (saved as a template with its children).
  w.repo.seed({ id: SAVEBOX, name: '[INDEX] Save box', parentId: ROOT });
  for (let i = 0; i < KIDS; i++)
    w.repo.seed({ id: kid('sbk', i), name: `Saved child ${i}`, parentId: SAVEBOX });
  // A plain index with 15 pages under it, deleted with its cascade by the owner (restored later by the agent).
  w.repo.seed({ id: RESTOREBOX, name: '[INDEX] Restore box', parentId: ROOT });
  for (let i = 0; i < KIDS; i++)
    w.repo.seed({ id: kid('rbk', i), name: `Restore child ${i}`, parentId: RESTOREBOX });
  // A plain index the tree knows, empty when the tree was built.
  w.repo.seed({ id: STALEBOX, name: '[INDEX] Stale box', parentId: ROOT });
  buildModels(w.stack, w.repo, w.assets);
  // 15 pages added under it in the app since the tree's last sweep (the tree has not seen them yet).
  for (let i = 0; i < KIDS; i++)
    w.repo.seed({ id: kid('stk', i), name: `Stale child ${i}`, parentId: STALEBOX });
  modelSaveAsTemplate(w);
  a = await writeAgent(w, 'r2-bulk-agent');
  // The owner deletes the box with its cascade (system principal, from the dashboard): journalled, tree tombstoned.
  await w.stack.runtime.engine.run(
    'deleteResource',
    { path: { resourceId: RESTOREBOX }, query: { cascade: true } },
    { project: PROJECT, origin: { kind: 'ui', client: 'owner' }, confirm: 'cascade', priority: 'P1' },
  );
  expect(w.repo.live(RESTOREBOX)).toBeUndefined();
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);

describe('control: the default rails are on and an 11-page batch is proposed', () => {
  it('B0: eleven updateResource calls in one lk_api_batch become one proposal (bulk rail)', async () => {
    expect(railsOf(w, a.profileId)).toEqual(DEFAULT_WRITE_RAILS);
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_batch', {
      calls: Array.from({ length: 11 }, (_, i) => ({
        operationId: 'updateResource',
        params: { path: { resourceId: `bk${i.toString(36).padStart(6, '0')}` }, body: { aliases: ['x'] } },
      })),
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toMatch(/bulk change \(11 pages > 10\)/);
    expect(writeCallsSince(w, n)).toEqual([]);
  });
});

describe('pages made or brought back in bulk that the bulk rail counts as one', () => {
  it('B1: createResourceFromTemplate with includeChildren (16 pages made) is a proposal, nothing sent', async () => {
    const m = w.repo.mutations.length;
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: { body: { templateId: TEMPLATE, includeChildren: true, name: 'Bulk copy', parentId: ROOT } },
    });
    const made = mutationsSince(w, m).filter((x) => x.op === 'createResourceFromTemplate');
    const copyId = made[0]?.id;
    const pagesMade = copyId ? 1 + liveUnder(w, copyId).length : 0;
    expect(
      { status: r.body.status, proposedBecause: r.body.proposedBecause, pagesMade },
      `${r.text}\nwrites sent: ${JSON.stringify(writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`))}`,
    ).toMatchObject({ status: 'proposal_captured', pagesMade: 0 });
    expect(r.body.proposedBecause).toMatch(/bulk change/);
  });

  it('B2: saveResourceAsTemplate with includeChildren (16 template pages made) is a proposal, nothing sent', async () => {
    const m = w.repo.mutations.length;
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'saveResourceAsTemplate',
      params: { path: { resourceId: SAVEBOX }, body: { name: 'Saved box template', includeChildren: true } },
    });
    const made = mutationsSince(w, m).filter((x) => x.op === 'saveResourceAsTemplate');
    const copyId = made[0]?.id;
    const pagesMade = copyId ? 1 + liveUnder(w, copyId).length : 0;
    expect(
      { status: r.body.status, pagesMade },
      `${r.text}\nwrites sent: ${JSON.stringify(writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`))}`,
    ).toMatchObject({ status: 'proposal_captured', pagesMade: 0 });
    expect(r.body.proposedBecause).toMatch(/bulk change/);
  });

  // Open (CR-2026-11-R2 section 7): LegendKeeper has no trash listing, so how many pages a restore brings back is not known (owner's decision).
  it.fails(
    'B3: restore_resource of a page deleted with 15 pages under it (16 pages back) is a proposal',
    async () => {
      const n = w.stack.mock.calls.length;
      const r = await call('restore_resource', { page: RESTOREBOX });
      const back = w.repo.live(RESTOREBOX) ? 1 + liveUnder(w, RESTOREBOX).length : 0;
      expect(
        { status: r.body.status, pagesBack: back },
        `${r.text}\nwrites sent: ${JSON.stringify(writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`))}`,
      ).toMatchObject({ status: 'proposal_captured', pagesBack: 0 });
    },
  );

  it('B4: a batch of [saveResourceAsTemplate, createResourceFromTemplate] with children (32 pages) is not run directly', async () => {
    const m = w.repo.mutations.length;
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'saveResourceAsTemplate',
          params: { path: { resourceId: SAVEBOX }, body: { id: 'tplsave2', includeChildren: true } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: {
            body: { templateId: 'tplsave2', includeChildren: true, name: 'Twice copied', parentId: ROOT },
          },
        },
      ],
    });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    const made = mutationsSince(w, m);
    // Safe: a proposal, or a refusal (the lifecycle guard refuses a copy with children in a request that also creates
    // pages, CR-10); never a direct job.
    expect(made.length, r.text).toBe(0);
    expect(r.body.status === 'proposal_captured' || r.body.error?.code === 'POLICY_DENIED', r.text).toBe(
      true,
    );
  });

  it('B5 (control): create_many_resources with 11 index pages is a proposal (the tool counts item by item)', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('create_many_resources', {
      items: Array.from({ length: 11 }, (_, i) => ({
        key: `k${i}`,
        name: `[INDEX] Rail index ${i}`,
        parent: ROOT,
      })),
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause, r.text).toMatch(/bulk change/);
    expect(writeCallsSince(w, n)).toEqual([]);
  });

  // Open (CR-2026-11-R2 section 7): as B3, the pages a restore brings back cannot be counted before it runs (owner's decision).
  it.fails(
    'B6: restoreResource through lk_api_write (same cascade, low-level route) is a proposal',
    async () => {
      // The owner deletes the box again (the agent restored it above when B3 held no rail).
      if (w.repo.live(RESTOREBOX)) {
        await w.stack.runtime.engine.run(
          'deleteResource',
          { path: { resourceId: RESTOREBOX }, query: { cascade: true } },
          { project: PROJECT, origin: { kind: 'ui', client: 'owner' }, confirm: 'cascade', priority: 'P1' },
        );
      }
      expect(w.repo.live(RESTOREBOX)).toBeUndefined();
      const r = await call('lk_api_write', {
        operationId: 'restoreResource',
        params: { path: { resourceId: RESTOREBOX } },
      });
      const back = w.repo.live(RESTOREBOX) ? 1 + liveUnder(w, RESTOREBOX).length : 0;
      expect({ status: r.body.status, pagesBack: back }, r.text).toMatchObject({
        status: 'proposal_captured',
        pagesBack: 0,
      });
    },
  );
});

describe('the bulk rail with the owner’s own choice of rails (deletes off, bulk on, N = 10)', () => {
  it('B7: a cascade delete of a page whose 15 children the tree has not seen yet is a proposal (bulk rail fails closed)', async () => {
    const cmd = w.stack.runtime.policy.commands;
    cmd.setRails('owner', a.profileId, { deletes: false, bulk: true, bulkPages: 10 });
    try {
      const r = await call('lk_api_write', {
        operationId: 'deleteResource',
        params: { path: { resourceId: STALEBOX }, query: { cascade: true } },
        confirm: 'cascade',
      });
      expect({ status: r.body.status, live: w.repo.live(STALEBOX) !== undefined }, r.text).toEqual({
        status: 'proposal_captured',
        live: true,
      });
    } finally {
      cmd.setRails('owner', a.profileId, { deletes: true });
    }
  });
});
