/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * Whole-set lifecycle (C2d, ADR 0037): for each of the four set operations, a fault after each step (the k-th
 * LegendKeeper write fails, for every k), then the same tool called again: the set record is incomplete, no page claims a
 * state it is not in, the second call is a new canonical proposal that resumes the same set record, and the set ends
 * exactly as one clean run leaves it, with only the writes that were left (nothing replayed). Also, for each operation,
 * a set of more than 100 pages and a mixed or inconsistent set are refused, listing pages.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LifecycleAction } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { facts } from '../resources/world.js';
import { failWrite, firstText, seedSet, type SetIds } from './sets.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET')).length;
const LIMITS = {
  'key-min': 50000,
  'write-min': 20000,
  'key-hour': 600000,
  'write-hour': 300000,
  'project-hour': 600000,
  'key-day': 6000000,
};

beforeAll(async () => {
  w = await lifecycleWorld({ env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS });
  client = await w.stack.connect();
});
afterAll(async () => w.close());

const TOOLS: Record<LifecycleAction, string> = {
  archive: 'archive_page',
  unarchive: 'unarchive_page',
  move_to_working: 'move_to_working',
  promote: 'promote_page',
};

/** A set ready for the operation (unarchive: an Authoritative set archived cleanly first). */
async function ready(action: LifecycleAction): Promise<SetIds> {
  const s = await seedSet(w, action === 'promote' ? 'working' : 'authoritative');
  if (action === 'unarchive') {
    const a = await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
  }
  return s;
}
const args = (action: LifecycleAction, s: SetIds) => ({
  page: s.root,
  subtree: true,
  ...(action === 'promote' ? { destination: 'locs0001' } : {}),
});

/** The set's state with its own name and ids taken out, so two sets can be compared. */
function snapshot(s: SetIds) {
  const role = new Map<string, string>([
    [s.root, 'root'],
    [s.art, 'art'],
    [s.core, 'core'],
    [s.portraits, 'portraits'],
  ]);
  const norm = (t: string) =>
    t
      .split(s.name)
      .join('NAME')
      .split(/k[0-9a-z]{3}(root|artx|core|port)/)
      .join('ID');
  return s.all.map((id) => {
    const r = w.repo.live(id)!;
    return {
      role: role.get(id),
      name: norm(r.name),
      parent: role.get(r.parentId ?? '') ?? r.parentId,
      tags: r.tags,
      facts: facts(w, id).map(norm),
      first: norm(firstText(w, id)),
    };
  });
}

/** A page claiming a state it is not in (C2c's rule, for a set: the area is the root's lifecycle index). */
function misleading(s: SetIds): string | null {
  const area = (id: string): 'archived' | 'working' | null => {
    let p = w.repo.live(id)?.parentId ?? null;
    for (let i = 0; p && i < 10; i++) {
      if (p === LIFECYCLE.archived) return 'archived';
      if (p === LIFECYCLE.working) return 'working';
      p = w.repo.live(p)?.parentId ?? null;
    }
    return null;
  };
  for (const id of [s.core, s.portraits]) {
    const r = w.repo.live(id)!;
    const status =
      facts(w, id)
        .find((f) => f.startsWith('Status='))
        ?.slice(7) ?? '';
    const note = firstText(w, id).startsWith('Archived - ');
    if (r.name.startsWith('[BSRC] ') && (status === 'Archived' || status === 'Working'))
      return `${r.name} reads ${status}`;
    if (r.name.startsWith('[BSRC] ') && area(id) !== null) return `${r.name} sits under a lifecycle index`;
    if (r.name.startsWith('[BSRC] ') && note) return `${r.name} carries the archive note`;
    if (r.name.startsWith('[BARC] ') && area(id) === 'archived' && status === 'Authoritative')
      return `${r.name} reads Authoritative in the archive`;
  }
  return null;
}

describe.each(['archive', 'unarchive', 'move_to_working', 'promote'] as const)(
  '%s with subtree: a fault after each step, then a resume',
  (action) => {
    const tool = TOOLS[action];
    let clean: ReturnType<typeof snapshot>;
    let total = 0;

    it('a clean run, for reference', async () => {
      const s = await ready(action);
      const before = writes();
      const done = await accept(w, await call(tool, args(action, s)));
      expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
      total = writes() - before;
      clean = snapshot(s);
      expect(total).toBeGreaterThan(0);
    });

    it('stops after each write in turn, misleads nowhere, and resumes to exactly the clean result', async () => {
      for (let k = 0; k < total; k++) {
        const s = await ready(action);
        const disarm = failWrite(w, k);
        let first;
        try {
          first = await accept(w, await call(tool, args(action, s)));
        } finally {
          disarm();
        }
        expect(first.body.status, `k=${k}: ${first.text}`).not.toBe('written');
        const set = w.stack.runtime.lifecycle.store.setsForRoot(PROJECT, s.root)[0]!;
        expect(set, `k=${k}`).toMatchObject({ action, state: 'incomplete' });
        expect(misleading(s), `k=${k}`).toBeNull();
        // A single-page tool on a page of the stopped set is refused, naming the set.
        const single = await call(tool, {
          page: s.core,
          ...(action === 'promote' ? { destination: 'locs0001' } : {}),
        });
        expect(single.body.error?.code, `k=${k}: ${single.text}`).toBe('LIFECYCLE_INCOMPLETE');
        // Another lifecycle tool on the root waits for it.
        const other = await call(action === 'archive' ? 'move_to_working' : 'archive_page', {
          page: s.root,
          subtree: true,
        });
        expect(other.body.error?.code, `k=${k}: ${other.text}`).toBe('LIFECYCLE_INCOMPLETE');
        // The same tool resumes it (v3 F12, ADR 0081: directly at scope write).
        const before = writes();
        const done = await call(tool, args(action, s));
        expect(done.body, `k=${k}: ${done.text}`).toMatchObject({
          status: 'written',
          verified: true,
          resumes: { setId: set.id },
        });
        // Only what was left: nothing replayed.
        expect(writes() - before, `k=${k}`).toBe(total - k);
        const after = w.stack.runtime.lifecycle.store.set(PROJECT, set.id)!;
        expect(after.state).toBe('complete');
        expect(after.jobs).toHaveLength(2);
        expect(
          w.stack.runtime.lifecycle.store.setRecords(PROJECT, set.id).every((r) => r.state === 'complete'),
        ).toBe(true);
        expect(snapshot(s), `k=${k}`).toEqual(clean);
      }
    }, 120_000);

    it('refuses a set of more than 100 pages, and a mixed or inconsistent one, listing the pages', async () => {
      const big = `big${action.slice(0, 4)}`.padEnd(8, 'x').slice(0, 8);
      const parent =
        action === 'promote' ? LIFECYCLE.working : action === 'unarchive' ? LIFECYCLE.archived : 'locs0001';
      w.repo.seed({ id: big, name: `[INDEX] Huge ${action}`, parentId: parent });
      for (let i = 0; i < 101; i++)
        w.repo.seed({
          id: `${big.slice(0, 4)}${i.toString().padStart(4, '0')}`,
          name: `[INDEX] H${i}`,
          parentId: big,
        });
      await w.stack.runtime.tree.sweep(PROJECT);
      const r = await call(tool, { ...args(action, { root: big } as SetIds), dryRun: true });
      expect(r.body.error, r.text).toMatchObject({ code: 'SET_TOO_LARGE', cap: 100 });

      const s = await ready(action);
      w.repo.seed({ id: `${s.root.slice(0, 4)}lose`, name: 'Loose Notes', parentId: s.art });
      await w.stack.runtime.tree.sweep(PROJECT);
      const m = await call(tool, { ...args(action, s), dryRun: true });
      expect(m.body.error?.code, m.text).toBe('SET_NOT_ELIGIBLE');
      expect(m.body.error.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `${s.root.slice(0, 4)}lose`,
            problem: expect.stringMatching(/unclassified/),
          }),
        ]),
      );
    });
  },
);
