/**
 * v2 E5.2 (ADR 0041, ADR 0042, ADR 0046 decision 11), Arkona's first full snapshot and first rehearsal:
 *
 * - the map's image is served from `assets2` (a 302 from `assets`): the snapshot follows it and comes out complete,
 *   recording the URL the page holds;
 * - features drawn in the app hold the old label sizes (`small`, `medium`, `large`): a restore and a rehearsal write them
 *   as `sm`, `md`, `lg`; an unknown one is left out and noted; the plan and the rehearsal compare old and new as equal;
 *   `iconSize` (which legitimately takes `small`) is untouched.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import type { Manifest } from '../../src/snapshots/index.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

async function approve(r: ToolCall): Promise<{ state: string; job: unknown }> {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  const job = p.jobId ? w!.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  return { state: p.state, job };
}

type Obj = Record<string, unknown>;
const mapFeatures = () => w!.features.get(w!.d.map)!;
const feature = (id: string) => mapFeatures().find((f) => f.id === id)!;

/** Arkona's map as the app drew it: old label sizes on a label, a region and a path; a small pin icon. */
function drawnInTheApp(extra: Obj[] = []): void {
  const feats = mapFeatures();
  feature('reg00001').labelSize = 'medium';
  feature('pin00002').iconSize = 'small';
  feats.push(
    { id: 'lbl00001', type: 'label', name: 'Harbour Mouth', pos: [-5, 5], labelSize: 'small', rank: 'a5' },
    {
      id: 'pth00001',
      type: 'path',
      name: 'Coast Road',
      polyline: [
        [-1, 1],
        [-2, 2],
      ],
      labelSize: 'large',
      rank: 'a6',
    },
    ...extra,
  );
}

describe('a map image LegendKeeper serves from assets2 (E5.2)', () => {
  it('the full snapshot follows the 302 and comes out complete; the page’s URL is what it records', async () => {
    w = await snapshotsWorld();
    w.movedToAssets2.add(S.imgMap);
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete, JSON.stringify(snaps.index.snapshot(m.id))).toBe(true);
    expect(snaps.index.snapshot(m.id)).toMatchObject({ state: 'complete' });
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    const img = atlas.images!.find((i) => i.url === w!.url(S.imgMap))!;
    // The reference is the URL the page holds (on `assets`), never rewritten; the bytes are the final ones.
    expect(img.url).toMatch(/^https:\/\/assets\.test:/);
    expect(img.sha256).toBe(w.sha(S.imgMap));
    expect(m.library!.images.find((i) => i.assetId === S.imgMap)!.sha256).toBe(w.sha(S.imgMap));
    const hops = w.assetRequests.filter((x) => x.path.includes(S.imgMap));
    expect(hops.map((x) => x.host).slice(0, 2)).toEqual(['assets.test', 'assets2.test']);
    for (const x of w.assetRequests) {
      expect(x.headers.authorization).toBeUndefined();
      expect(x.headers.cookie).toBeUndefined();
    }
  });

  it('an image URL already on assets2 is recognised as an asset image by the snapshot', async () => {
    w = await snapshotsWorld();
    const onAssets2 = w.url(S.imgSea).replace('https://assets.test:', 'https://assets2.test:');
    const main = w.repo.blocks.get(w.d.main)!;
    (main.blocks as Obj[]).find((b) => b.id === 'aimg')!.url = onAssets2;
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete).toBe(true);
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    expect(atlas.images!.find((i) => i.url === onAssets2)?.sha256).toBe(w.sha(S.imgSea));
  });
});

describe('old label sizes on map features (E5.2)', () => {
  async function snapshotOfTheAppMap(extra: Obj[] = []): Promise<string> {
    w = await snapshotsWorld();
    drawnInTheApp(extra);
    c = await w.stack.connect();
    return (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  }

  it('a restore sends small, medium and large as sm, md and lg; iconSize is untouched', async () => {
    const snap = await snapshotOfTheAppMap();
    // Deleted since, and one changed: the restore creates two and updates one.
    w!.features.set(
      w!.d.map,
      mapFeatures().filter((f) => f.id !== 'lbl00001' && f.id !== 'pth00001'),
    );
    feature('reg00001').name = 'The Weeping Sea (renamed)';
    feature('pin00002').name = 'Isar (renamed)';
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    const done = await approve(r);
    expect(done.state, JSON.stringify(done.job)).toBe('executed');
    expect(feature('lbl00001').labelSize).toBe('sm');
    expect(feature('pth00001').labelSize).toBe('lg');
    expect(feature('reg00001')).toMatchObject({ name: 'The Weeping Sea', labelSize: 'md' });
    expect(feature('pin00002')).toMatchObject({ name: 'Isar', iconSize: 'small' });
  });

  it('recreating a deleted page writes its features’ old sizes as the new ones', async () => {
    const snap = await snapshotOfTheAppMap();
    await call('delete_resource', { page: S.atlas, confirm: true });
    w!.repo.res.delete(S.atlas);
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const pol = w!.stack.runtime.policy;
    await pol.commands.approveAsCanon('owner', String(r.body.proposalId));
    for (
      let i = 0;
      i < 400 &&
      !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(String(r.body.proposalId))!.state);
      i++
    )
      await new Promise((res) => setTimeout(res, 20));
    expect(pol.proposals.get(String(r.body.proposalId))!.state).toBe('executed');
    const map = w!.repo.liveDocs(w!.repo.live(S.atlas)!).find((x) => x.name === 'Map')!;
    const byId = new Map(w!.features.get(map.id)!.map((f) => [f.id, f]));
    expect(byId.get('lbl00001')!.labelSize).toBe('sm');
    expect(byId.get('reg00001')!.labelSize).toBe('md');
    expect(byId.get('pth00001')!.labelSize).toBe('lg');
    expect(byId.get('pin00002')!.iconSize).toBe('small');
  });

  it('an unknown label size is left out of the write and noted, rather than failing the restore', async () => {
    const snap = await snapshotOfTheAppMap([
      { id: 'lbl00002', type: 'label', name: 'Odd Label', pos: [-6, 6], labelSize: 'huge', rank: 'a7' },
    ]);
    w!.features.set(
      w!.d.map,
      mapFeatures().filter((f) => f.id !== 'lbl00002'),
    );
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    const notes = (r.body.notRestored ?? []) as { what: string; why: string }[];
    const note = notes.find((x) => x.what.includes('Odd Label'))!;
    expect(note.what).toContain('lbl00002');
    expect(note.why).toMatch(/label size "huge"/);
    expect((await approve(r)).state).toBe('executed');
    const made = feature('lbl00002');
    expect(made.name).toBe('Odd Label');
    expect(made.labelSize).toBeUndefined();
  });

  it('the plan sees small against a live sm as unchanged: nothing to do, nothing re-written', async () => {
    const snap = await snapshotOfTheAppMap();
    // As a first restore leaves them: the new names.
    feature('lbl00001').labelSize = 'sm';
    feature('reg00001').labelSize = 'md';
    feature('pth00001').labelSize = 'lg';
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    expect(r.body.status, r.text).toBe('nothing_to_do');
  });
});

describe('a rehearsal of a snapshot with old label sizes (E5.2)', () => {
  const SOURCE = 'proj_arkona';

  async function setup(extra: Obj[] = []): Promise<string> {
    w = await snapshotsWorld();
    drawnInTheApp(extra);
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    w.stack.db
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
    new ProjectStore(w.stack.db).setSandbox(PROJECT, true);
    (w.stack.runtime.projects as unknown as { reload(): void }).reload();
    return copy.id;
  }

  const rehearse = async (snapshotId: string) => {
    const rh = w!.stack.runtime.rehearsals;
    const row = await rh.start({
      targetProject: 'test',
      snapshotId,
      mode: 'sampled',
      keep: false,
      by: 'owner',
      max: 10,
    });
    return (await rh.settled(row.id))!;
  };

  it('completes, with the old sizes written as the new ones and no difference reported for them', async () => {
    const id = await setup();
    const done = await rehearse(id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as { differences: unknown[]; pagesCompared: number };
    expect(res.differences, JSON.stringify(res.differences, null, 1)).toEqual([]);
    // What the rehearsal wrote: the copy of the Harbour Mouth label holds `sm`.
    const copies = [...w!.features.values()].flat().filter((f) => f.name === 'Harbour Mouth');
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.filter((f) => f.id !== 'lbl00001').every((f) => f.labelSize === 'sm')).toBe(true);
    const pins = [...w!.features.values()].flat().filter((f) => f.name === 'Isar');
    expect(pins.every((f) => f.iconSize === 'small')).toBe(true);
  });

  it('an unknown size is left out and listed under what it cannot restore, naming the feature', async () => {
    const id = await setup([
      { id: 'lbl00002', type: 'label', name: 'Odd Label', pos: [-6, 6], labelSize: 'huge', rank: 'a7' },
    ]);
    const done = await rehearse(id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as { differences: unknown[]; cannotRestore: { piece: string; reason: string }[] };
    expect(res.differences, JSON.stringify(res.differences, null, 1)).toEqual([]);
    const note = res.cannotRestore.find((x) => x.piece.includes('Odd Label'))!;
    expect(note.piece).toContain('lbl00002');
    expect(note.reason).toMatch(/label size "huge"/);
  });
});
