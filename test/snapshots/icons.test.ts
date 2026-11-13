/* eslint-disable @typescript-eslint/no-unsafe-return -- parsed tool results */
/**
 * v2 E1a (ADR 0042 decision 9): the owner's sandbox run showed LegendKeeper READS an icon as `fas fa-book` but WRITES it
 * as `book` (400 "Invalid icon name" otherwise). The mock now does the same. A restore, a recreate and the rehearsal write
 * the write form; an icon LegendKeeper still refuses is dropped, the run finishes, and the result says so.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import type { Manifest } from '../../src/snapshots/index.js';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** The world with read-form icons on the Atlas, a pin and an event; then a full snapshot. */
async function setup(): Promise<string> {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  w.repo.res.get(S.atlas)!.iconGlyph = 'fas fa-book';
  w.features.get(w.d.map)!.find((f) => f.id === 'pin00001')!.iconGlyph = 'fas fa-flag';
  w.events.get(w.d.chronicle)!.find((e) => e.id === 'evt00001')!.iconGlyph = 'far fa-star';
  const full = await w.stack.runtime.snapshots.full(PROJECT, 'manual');
  w.repo.iconWrites.length = 0;
  return full.snapshotId!;
}
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

async function approve(r: { body: Record<string, unknown> }, asCanon = true) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  if (asCanon) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  const job = p.jobId ? w!.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  return { state: p.state, lastError: job?.lastError };
}

/** The page deleted and purged, then recreated from the snapshot alone. */
async function recreate(snap: string) {
  await call('delete_resource', { page: S.atlas, confirm: true });
  w!.repo.res.delete(S.atlas);
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
  });
  return approve(r);
}

describe('restore and recreate write icons in the write form', () => {
  it('recreate: a page read as "fas fa-book", a pin as "fas fa-flag" and an event as "far fa-star" are written as book, flag and star', async () => {
    const snap = await setup();
    const res = await recreate(snap);
    expect(res.state, JSON.stringify(res.lastError)).toBe('executed');
    // Only bare names went to LegendKeeper; none was refused, so nothing was dropped.
    expect(w!.repo.iconWrites.sort()).toEqual(['book', 'flag', 'star']);
    expect(w!.repo.live(S.atlas)!.iconGlyph).toBe('fas fa-book');
    const rec = w!.stack.runtime.restores.list(PROJECT)[0]!;
    expect(rec.state).toBe('executed');
    expect(rec.couldntRestoreExactly).toEqual([]);
  });

  it('a name LegendKeeper still refuses is dropped: the recreate finishes, the page has its default icon, and the record lists it', async () => {
    const snap = await setup();
    w!.repo.refusedIcons.add('book').add('flag').add('star');
    const res = await recreate(snap);
    expect(res.state, JSON.stringify(res.lastError)).toBe('executed');
    const page = w!.repo.live(S.atlas)!;
    expect(page.name).toBe('[BSRC] Atlas of Snapshots');
    expect(page.iconGlyph ?? null).toBeNull();
    // Everything else came back.
    const docs = w!.repo.liveDocs(page);
    expect(docs.map((x) => x.name).sort()).toEqual(['Chronicle', 'Main', 'Map', 'Notes', 'Plot']);
    const mapDoc = docs.find((x) => x.name === 'Map')!;
    const pins = w!.features.get(mapDoc.id)!;
    expect(pins.map((f) => f.id).sort()).toEqual(['fold0001', 'pin00001', 'pin00002', 'reg00001']);
    expect(pins.find((f) => f.id === 'pin00001')!.iconGlyph).toBeUndefined();
    const events = w!.events.get(docs.find((x) => x.name === 'Chronicle')!.id)!;
    expect(events.length).toBe(3);
    expect(events.find((e) => e.id === 'evt00001')!.iconGlyph).toBeUndefined();
    // "Couldn't be restored exactly": one line a dropped icon.
    const rec = w!.stack.runtime.restores.list(PROJECT)[0]!;
    expect(rec.couldntRestoreExactly.map((x) => x.what).join('\n')).toMatch(/iconGlyph "book"/);
    expect(rec.couldntRestoreExactly.map((x) => x.what).join('\n')).toMatch(/iconGlyph "flag"/);
    expect(rec.couldntRestoreExactly.map((x) => x.what).join('\n')).toMatch(/iconGlyph "star"/);
    expect(rec.couldntRestoreExactly).toHaveLength(3);
  });

  it('a refusal that is not about the icon still fails the step (nothing is dropped for it)', async () => {
    const snap = await setup();
    await call('delete_resource', { page: S.atlas, confirm: true });
    // The id is still held by the soft-deleted page: DUPLICATE_ID, which is not an icon refusal.
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
    });
    const res = await approve(r);
    expect(res.state).toBe('failed');
  });

  it('a live map and timeline restore (the document exists) writes pin and event icons in the write form too', async () => {
    const snap = await setup();
    const pin = w!.features.get(w!.d.map)!.find((f) => f.id === 'pin00001')!;
    const ev = w!.events.get(w!.d.chronicle)!.find((e) => e.id === 'evt00001')!;
    pin.iconGlyph = 'fas fa-skull'; // changed in the app since the snapshot
    ev.iconGlyph = 'fas fa-skull';
    w!.repo.iconWrites.length = 0;
    for (const document of ['Map', 'Chronicle']) {
      const r = await call('restore_snapshot', {
        page: S.atlas,
        snapshot: snap,
        scope: 'document',
        document,
      });
      const res = await approve(r, false);
      expect(res.state, JSON.stringify(res.lastError)).toBe('executed');
    }
    expect(w!.repo.iconWrites.sort()).toEqual(['flag', 'star']);
    // Written as the bare name; read back in the read form, as snapshotted.
    expect(pin.iconGlyph).toBe('fas fa-flag');
    expect(ev.iconGlyph).toBe('fas fa-star');
  });
});

describe('the tools convert a read-form icon an agent passes back', () => {
  it('update_resource sends the bare name, and passing back what it already shows is no change', async () => {
    await setup();
    const r = await call('update_resource', { page: S.atlas, icon: { glyph: 'fas fa-dragon' } });
    expect(r.body.status, JSON.stringify(r.body)).not.toBe('error');
    expect(w!.repo.iconWrites).toContain('dragon');
    expect(w!.repo.iconWrites).not.toContain('fas fa-dragon');
    // Passing back what it already shows (read form) is no change at all.
    w!.repo.iconWrites.length = 0;
    const same = await call('update_resource', { page: S.atlas, icon: { glyph: 'fas fa-dragon' } });
    expect(JSON.stringify(same.body)).toMatch(/nothing to change|unchanged|no change/i);
    expect(w!.repo.iconWrites).toEqual([]);
  });
});

// ============================================================================================ the rehearsal

const SOURCE = 'proj_arkona';
async function rehearsalSetup(): Promise<string> {
  const snap = await setup();
  const snaps = w!.stack.runtime.snapshots;
  const m = (await snaps.manifest(snap))!;
  w!.stack.db
    .prepare(
      `INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at, updated_at, verified_at)
       VALUES (?, 'arkona', 'Arkona', 0, 0, 1, '{}', ?, ?, ?)`,
    )
    .run(SOURCE, Date.now(), Date.now(), Date.now());
  const copy: Manifest = {
    ...m,
    id: m.id.replace(/-full-/, '-full-0'),
    project: { id: SOURCE, name: 'arkona' },
  };
  await snaps.writeSnapshot(copy);
  new ProjectStore(w!.stack.db).setSandbox(PROJECT, true);
  (w!.stack.runtime.projects as unknown as { reload(): void }).reload();
  w!.repo.iconWrites.length = 0;
  return copy.id;
}

describe('the rehearsal writes icons in the write form', () => {
  const run = async (snapshotId: string) => {
    const rh = w!.stack.runtime.rehearsals;
    const row = await rh.start({ targetProject: 'test', snapshotId, mode: 'full', keep: false, by: 'owner' });
    return (await rh.settled(row.id))!;
  };

  it('a page, a pin and an event read in the read form are rehearsed exactly, with no icon refused', async () => {
    const snapshotId = await rehearsalSetup();
    const done = await run(snapshotId);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as { differences: unknown[]; pagesCompared: number; exact: number };
    expect(res.differences, JSON.stringify(res.differences)).toEqual([]);
    expect(res.exact).toBe(res.pagesCompared);
    expect(w!.repo.iconWrites.sort()).toEqual(['book', 'flag', 'star']);
  });

  it('an icon LegendKeeper refuses is dropped: the rehearsal completes, lists it, and does not count it as a difference', async () => {
    const snapshotId = await rehearsalSetup();
    w!.repo.refusedIcons.add('book').add('flag').add('star');
    const done = await run(snapshotId);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as {
      differences: unknown[];
      cannotRestore: { page: string; piece: string; reason: string }[];
      exact: number;
      pagesCompared: number;
    };
    expect(res.differences, JSON.stringify(res.differences)).toEqual([]);
    expect(res.exact).toBe(res.pagesCompared);
    const icons = res.cannotRestore.filter((x) => /iconGlyph/.test(x.piece));
    expect(icons.map((x) => x.piece).join('\n')).toMatch(/"book"[\s\S]*"flag"|"flag"[\s\S]*"book"/);
    expect(icons).toHaveLength(3);
    expect(icons[0]!.reason).toMatch(/refused it/);
  });
});
