/**
 * C2d, Part 3 (ADR 0036 decision 5, accepted by the owner on 11 November 2026): an approval covers only the pages it
 * listed. A cascade delete's pages are listed when the proposal is captured; a page added under it (or one gone, or
 * moved) since then makes the proposal `conflicted` at approval, or, if it happens between the approval and the write,
 * inside the lock: nothing is deleted. The same for every tool (the sets' case is in test/lifecycle/sets.test.ts).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { compareScope, PageScopeGuard, ScopeConflictError } from '../../src/policy/page-scope.js';
import { lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let proposer: Client;
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};
const live = (id: string) => w.repo.res.get(id)?.deletedAt === null;
let box = 0;
/** A box `[INDEX] Scratch Box n` under the root with one index under it, both known to the tree. */
async function scratch(): Promise<{ top: string; inner: string }> {
  box++;
  const top = `scrbox0${box}`;
  const inner = `scrinn0${box}`;
  w.repo.seed({ id: top, name: `[INDEX] Scratch Box ${box}`, parentId: ROOT });
  w.repo.seed({ id: inner, name: `[INDEX] Scratch Inner ${box}`, parentId: top });
  await w.stack.runtime.tree.sweep(PROJECT);
  return { top, inner };
}
const proposeDelete = async (top: string) => {
  const r = await w.stack.call(proposer, 'delete_resource', {
    project: 'test',
    page: top,
    confirm: true,
    cascade: true,
  });
  expect(r.body.status, r.text).toBe('proposal_captured');
  return String(r.body.proposalId);
};

beforeAll(async () => {
  w = await lifecycleWorld();
  proposer = await w.stack.connect(w.stack.newToken('scope-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('an approval covers only the pages it listed (decision 5)', () => {
  it('a cascade delete: a page added under it after capture → conflicted at approval, nothing deleted', async () => {
    const { top, inner } = await scratch();
    const id = await proposeDelete(top);
    // The owner adds a page in LegendKeeper before approving.
    w.repo.seed({ id: 'scrlate1', name: '[INDEX] Late Addition', parentId: inner });
    const p = await w.stack.runtime.policy.commands.approve('owner', id);
    expect(p.state).toBe('conflicted');
    const detail = proposals().get(id)!;
    expect(JSON.stringify(detail.conflict)).toMatch(/1 page\(s\) added \(\[INDEX\] Late Addition\)/);
    expect([top, inner, 'scrlate1'].every(live)).toBe(true);
  });

  it('a captured page gone, or moved elsewhere, conflicts too', async () => {
    const a = await scratch();
    const id = await proposeDelete(a.top);
    w.repo.res.get(a.inner)!.deletedAt = new Date().toISOString();
    expect((await w.stack.runtime.policy.commands.approve('owner', id)).state).toBe('conflicted');
    expect(JSON.stringify(proposals().get(id)!.conflict)).toMatch(/1 page\(s\) gone/);
    expect(live(a.top)).toBe(true);

    const b = await scratch();
    const id2 = await proposeDelete(b.top);
    w.repo.res.get(b.inner)!.parentId = ROOT;
    expect((await w.stack.runtime.policy.commands.approve('owner', id2)).state).toBe('conflicted');
    expect(live(b.top) && live(b.inner)).toBe(true);
  });

  it('a page added between the approval and the write: refused inside the lock, conflicted, nothing deleted', async () => {
    const { top, inner } = await scratch();
    const id = await proposeDelete(top);
    // After the approval's own listing (its two listResources calls), the page appears.
    let calls = 0;
    const re = /\/resources$/;
    w.overrides.set(re, (req: MockRequest) => {
      const parent = String(req.query.parentId ?? '');
      if (req.method === 'GET' && (parent === top || parent === inner) && ++calls === 3)
        w.repo.seed({ id: 'scrrace1', name: '[INDEX] Racing Addition', parentId: inner });
      return undefined;
    });
    try {
      await w.stack.runtime.policy.commands.approve('owner', id);
      const done = await settle(id);
      expect(done.state, JSON.stringify(done)).toBe('conflicted');
      expect(JSON.stringify(done.conflict)).toMatch(/Racing Addition/);
      expect([top, inner, 'scrrace1'].every(live)).toBe(true);
    } finally {
      w.overrides.delete(re);
    }
  });

  it('unchanged, it runs as approved', async () => {
    const { top, inner } = await scratch();
    const id = await proposeDelete(top);
    await w.stack.runtime.policy.commands.approve('owner', id);
    expect((await settle(id)).state).toBe('executed');
    expect(live(top) || live(inner)).toBe(false);
  });
});

describe('the page-scope guard (unit)', () => {
  it('compares by id and parent', () => {
    const was = [
      { id: 'a', parentId: 'r' },
      { id: 'b', parentId: 'a' },
    ];
    expect(compareScope(was, was)).toEqual({ added: [], gone: [], moved: [] });
    const d = compareScope(was, [
      { id: 'a', parentId: 'r' },
      { id: 'b', parentId: 'r' },
      { id: 'c', parentId: 'a' },
    ]);
    expect(d.added.map((p) => p.id)).toEqual(['c']);
    expect(d.moved).toEqual([{ id: 'b', from: 'a', to: 'r' }]);
  });

  it('refuses inside the lock only the step whose captured list differs, and when the list cannot be read', async () => {
    const g = new PageScopeGuard();
    const jobOptions = {
      pageScope: {
        subtrees: [{ step: 1, rootId: 'r', label: 'the pages under r', pages: [{ id: 'a', parentId: 'r' }] }],
      },
    };
    const input = (stepNo: number, read: () => Promise<unknown>) =>
      ({
        job: { id: 'job1' },
        step: { stepNo },
        opId: 'deleteResource',
        params: {},
        jobOptions,
        current: undefined,
        read,
      }) as unknown as Parameters<PageScopeGuard['inLock']>[0];
    const listing = (ids: string[]) => () =>
      Promise.resolve({
        data: ids.map((id) => ({ id, name: id })),
        hasMore: false,
        nextCursor: null,
      });
    await expect(g.inLock(input(1, listing(['a', 'x'])))).resolves.toBeUndefined(); // another step
    let n = 0;
    await expect(
      g.inLock(input(2, async () => (n++ === 0 ? await listing(['a'])() : await listing([])()))),
    ).resolves.toBeUndefined();
    n = 0;
    await expect(
      g.inLock(input(2, async () => (n++ === 0 ? await listing(['a', 'x'])() : await listing([])()))),
    ).rejects.toBeInstanceOf(ScopeConflictError);
    await expect(g.inLock(input(2, () => Promise.reject(new Error('down'))))).rejects.toBeInstanceOf(
      ScopeConflictError,
    );
  });
});
