/**
 * v2 E5.4 (ADR 0046 decision 14), Arkona's second rehearsal: LegendKeeper's API contradicts itself on `labelSize`
 * (writes take only xs–3xl; `listFeatures` returns only small/medium/large and refuses to list a map holding anything
 * else). The mock LegendKeeper reproduces both halves (test/maps/label-size-bug.ts), so these tests mean something:
 *
 * - no feature body the bridge sends carries `labelSize`: restores, recreates and rehearsals leave it out and list it,
 *   once per map; the engine refuses any feature write that carries one;
 * - a snapshot of a map LegendKeeper cannot list is partial, with the reason, and the rest of it is complete;
 * - a read error in a rehearsal's comparison is a difference for that page and piece, and the run still completes;
 * - a sampled rehearsal copies at most 25 events per timeline and 40 features per map, and its plan says what was cut;
 * - its estimate includes the governor's pacing at P3.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidParamsError } from '../../src/jobs/errors.js';
import {
  LABEL_SIZE_NOT_RESTORABLE,
  LABEL_SIZE_UNLISTABLE,
  LABEL_SIZE_WRITABLE,
} from '../../src/maps/features.js';
import { ProjectStore } from '../../src/projects/index.js';
import type { DocumentPiece, Manifest } from '../../src/snapshots/index.js';
import {
  pacingOf,
  Rehearsals,
  type RehearsalDeps,
  SAMPLE_EVENTS_PER_TIMELINE,
  SAMPLE_FEATURES_PER_MAP,
  sampleMap,
  sampleTimeline,
} from '../../src/snapshots/rehearsal.js';
import { labelSizeListRefusal } from '../maps/label-size-bug.js';
import { PROJECT, PUBLIC_URL, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

type Obj = Record<string, unknown>;
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });
const mapFeatures = () => w!.features.get(w!.d.map)!;
const feature = (id: string) => mapFeatures().find((f) => f.id === id)!;
const sentLabelSizes = () => w!.featureWrites.filter((x) => Object.hasOwn(x.body, 'labelSize'));

async function settle(id: string, canon = false): Promise<string> {
  const pol = w!.stack.runtime.policy;
  if (canon) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  return pol.proposals.get(id)!.state;
}

/**
 * Arkona's map as the app drew it, with a label size on three features. One holds a new-style `md`, which LegendKeeper
 * would refuse to list: the snapshot is taken with the bug switched off, as if LegendKeeper had listed it.
 */
async function snapshotWithSizes(): Promise<string> {
  w = await snapshotsWorld();
  feature('reg00001').labelSize = 'medium';
  feature('pin00002').iconSize = 'small';
  mapFeatures().push(
    { id: 'lbl00001', type: 'label', name: 'Harbour Mouth', pos: [-5, 5], labelSize: 'small', rank: 'a5' },
    {
      id: 'pth00001',
      type: 'path',
      name: 'Coast Road',
      polyline: [
        [-1, 1],
        [-2, 2],
      ],
      labelSize: 'md',
      rank: 'a6',
    },
  );
  c = await w.stack.connect();
  w.bugs.labelSize = false;
  const id = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  w.bugs.labelSize = true;
  return id;
}

describe('label sizes are never sent (E5.4)', () => {
  it('the switch is off: LegendKeeper cannot round-trip a label size', () => {
    expect(LABEL_SIZE_WRITABLE).toBe(false);
  });

  it('a restore of features holding small and md sends neither, and lists them once for the map', async () => {
    const snap = await snapshotWithSizes();
    // Deleted since (the label and the path, the one holding `md`), and one renamed: two creates, one update.
    w!.features.set(
      w!.d.map,
      mapFeatures().filter((f) => f.id !== 'lbl00001' && f.id !== 'pth00001'),
    );
    feature('reg00001').name = 'The Weeping Sea (renamed)';
    const r: ToolCall = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const notes = (r.body.notRestored ?? []) as { what: string; why: string }[];
    const note = notes.find((x) => x.what.includes('label size'))!;
    expect(note.what).toBe('the label size of 3 feature(s) of map Map');
    expect(note.why).toContain(LABEL_SIZE_NOT_RESTORABLE);
    expect(await settle(String(r.body.proposalId))).toBe('executed');
    expect(sentLabelSizes()).toEqual([]);
    expect(w!.featureWrites.length).toBeGreaterThanOrEqual(3);
    expect(feature('lbl00001').labelSize).toBeUndefined();
    expect(feature('pth00001').labelSize).toBeUndefined();
    // Not a label size, and not touched: a pin's icon size keeps `small`.
    expect(feature('pin00002').iconSize).toBe('small');
    expect(feature('reg00001')).toMatchObject({ name: 'The Weeping Sea', labelSize: 'medium' });
    // The map is still listable through the API.
    const read = await call('read_document', { resource: S.atlas, document: 'Map' });
    expect(read.isError, read.text).toBeFalsy();
  });

  it('a feature differing only in its label size is no difference: nothing to restore', async () => {
    const snap = await snapshotWithSizes();
    feature('lbl00001').labelSize = 'large';
    delete feature('pth00001').labelSize;
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    expect(r.body.status, r.text).toBe('nothing_to_do');
  });

  it('recreating a deleted page sends no label size, and lists them', async () => {
    const snap = await snapshotWithSizes();
    await call('delete_resource', { page: S.atlas, confirm: true });
    w!.repo.res.delete(S.atlas);
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const notes = (r.body.notRestored ?? []) as { what: string; why: string }[];
    expect(notes.find((x) => x.what.includes('label size'))?.why).toContain(LABEL_SIZE_NOT_RESTORABLE);
    expect(await settle(String(r.body.proposalId), true)).toBe('executed');
    expect(sentLabelSizes()).toEqual([]);
    const map = w!.repo.liveDocs(w!.repo.live(S.atlas)!).find((x) => x.name === 'Map')!;
    const made = w!.features.get(map.id)!;
    expect(made.map((f) => String(f.id)).sort()).toEqual(
      expect.arrayContaining(['lbl00001', 'pth00001', 'reg00001']),
    );
    expect(made.every((f) => f.labelSize === undefined)).toBe(true);
    expect(made.find((f) => f.id === 'pin00002')!.iconSize).toBe('small');
  });

  it('the engine refuses any feature write carrying a label size, whoever built it: nothing is sent', async () => {
    w = await snapshotsWorld();
    for (const labelSize of ['sm', 'small']) {
      const err = await w.stack.runtime.engine
        .submit({
          project: PROJECT,
          kind: 'batch_ops',
          origin: { kind: 'ui', client: 'owner', tool: 'test' },
          steps: [
            {
              op: 'createFeature',
              params: {
                path: { resourceId: S.atlas, documentId: w.d.map },
                body: { type: 'label', name: 'x', pos: [0, 0], labelSize },
              },
            },
          ],
        })
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(InvalidParamsError);
      expect((err as Error).message).toContain('LABEL_SIZE_UNSUPPORTED');
    }
    expect(w.featureWrites).toEqual([]);
  });
});

describe('a map LegendKeeper cannot list (E5.4)', () => {
  it('the mock reproduces the bug: any value but small/medium/large makes listFeatures refuse', () => {
    expect(labelSizeListRefusal([{ labelSize: 'small' }, { labelSize: 'large' }, {}])).toBeUndefined();
    const r = labelSizeListRefusal([{ labelSize: 'small' }, { labelSize: 'md' }])!;
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("Expected 'small' | 'medium' | 'large', received 'md'");
  });

  it('a full snapshot comes out partial with the reason for that map, and the rest is complete', async () => {
    w = await snapshotsWorld();
    mapFeatures().push({ id: 'lbl00009', type: 'label', name: 'New Style', pos: [-2, 2], labelSize: 'md' });
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete).toBe(false);
    expect(snaps.index.snapshot(m.id)).toMatchObject({ state: 'partial', missing: 1 });
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    expect(atlas.missing).toEqual([
      { piece: 'document', ref: w.d.map, reason: `its features: ${LABEL_SIZE_UNLISTABLE}` },
    ]);
    // The page's other pieces are there: its resource, its sidebar and every other document.
    expect(atlas.resource).toBeDefined();
    expect(atlas.sidebar).toBeDefined();
    expect((atlas.documents ?? []).map((d) => d.id).sort()).toEqual(
      [w.d.main, w.d.chronicle, w.d.plot, w.d.notes].sort(),
    );
    // Every other page is complete.
    expect(m.pages.filter((p) => p.id !== S.atlas && (p.missing ?? []).length > 0)).toEqual([]);
    // v3 F2 (ADR 0049 decision 4): the missing piece is listed, on the Snapshots page and by list_snapshots.
    const svc = w.stack.services;
    const session = svc.owner.createSession('127.0.0.1', 'vitest');
    const res = await fetch(`${w.stack.base}/api/admin/snapshots?project=test`, {
      headers: { cookie: `${svc.owner.sessionCookie}=${session}`, origin: PUBLIC_URL },
    });
    const page = (await res.json()) as { snapshots: { id: string; missingPieces?: unknown }[] };
    expect(page.snapshots.find((x) => x.id === m.id)!.missingPieces).toEqual([
      {
        pageId: S.atlas,
        pageName: atlas.name,
        piece: 'document',
        ref: w.d.map,
        reason: `its features: ${LABEL_SIZE_UNLISTABLE}`,
      },
    ]);
    c = await w.stack.connect();
    const listed = await call('list_snapshots', { page: S.atlas });
    const entry = (listed.body.snapshots as { snapshot: string; missing?: unknown }[]).find(
      (x) => x.snapshot === m.id,
    )!;
    expect(entry.missing).toEqual({
      total: 1,
      thisPage: [{ piece: 'document', ref: w.d.map, reason: `its features: ${LABEL_SIZE_UNLISTABLE}` }],
    });
    // A restore of that map from this snapshot is refused (the piece was not taken), never read as "no features".
    const rs = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: m.id,
      scope: 'document',
      document: 'Map',
    });
    expect(rs.isError).toBe(true);
    expect(mapFeatures().length).toBeGreaterThan(4);
  });
});

// ============================================================================================ the rehearsal

const SOURCE = 'proj_arkona';

/** The world's full snapshot, copied as a snapshot of another project (`arkona`); the test project a sandbox. */
async function rehearsalSetup(before?: () => void): Promise<string> {
  w = await snapshotsWorld();
  before?.();
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

const rehearse = async (snapshotId: string, max = 10) => {
  const rh = w!.stack.runtime.rehearsals;
  const row = await rh.start({
    targetProject: 'test',
    snapshotId,
    mode: 'sampled',
    keep: false,
    by: 'owner',
    max,
  });
  return (await rh.settled(row.id))!;
};

type Result = {
  differences: { page: string; piece: string; reason: string }[];
  cannotRestore: { page: string; piece: string; reason: string }[];
  pagesCompared: number;
  exact: number;
};

describe('the rehearsal and label sizes (E5.4)', () => {
  it('sends no label size, lists them per map, and finds no difference for them', async () => {
    const id = await rehearsalSetup(() => {
      feature('reg00001').labelSize = 'medium';
      mapFeatures().push({
        id: 'lbl00001',
        type: 'label',
        name: 'Harbour Mouth',
        pos: [-5, 5],
        labelSize: 'small',
      });
    });
    const done = await rehearse(id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as Result;
    expect(res.differences, JSON.stringify(res.differences, null, 1)).toEqual([]);
    expect(sentLabelSizes()).toEqual([]);
    const listed = res.cannotRestore.filter((x) => x.reason === LABEL_SIZE_NOT_RESTORABLE);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.piece).toBe('Map: the label size of 2 feature(s)');
    expect(done.rootState).toBe('deleted');
  });

  it('a read error in the comparison is a difference for that page and piece, and the run completes', async () => {
    const id = await rehearsalSetup();
    // Every map of the copy (not the source's own) refuses to be listed, as LegendKeeper would.
    w!.listHook = (doc) => (doc === w!.d.map ? undefined : labelSizeListRefusal([{ labelSize: 'md' }]));
    const done = await rehearse(id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as Result;
    const atlas = res.differences.filter((x) => x.piece === 'Map');
    expect(atlas).toHaveLength(1);
    expect(atlas[0]!.reason).toBe(LABEL_SIZE_UNLISTABLE);
    expect(atlas[0]!.page).toContain('Atlas of Snapshots');
    // Only that piece differs: the other pages were compared, and the copy was deleted as usual.
    expect(res.differences).toHaveLength(1);
    expect(res.pagesCompared).toBeGreaterThan(1);
    expect(res.exact).toBe(res.pagesCompared - 1);
    expect(done.rootState).toBe('deleted');
  });
});

describe('sampled rehearsals are capped (E5.4)', () => {
  const lanes = [
    { id: 'lane0001', name: 'A' },
    { id: 'lane0002', name: 'B' },
    { id: 'lane0003', name: 'C' },
  ];
  const timeline = (n: number) =>
    ({
      settings: { type: 'time', name: 'Chronicle' },
      lanes,
      // Every event on lane A or B, except the last on C.
      events: Array.from({ length: n }, (_, i) => ({
        id: `e${String(i).padStart(7, '0')}`,
        laneId: i === n - 1 ? 'lane0003' : i % 2 ? 'lane0002' : 'lane0001',
        start: i,
      })),
    }) as unknown as DocumentPiece;

  it(`at most ${SAMPLE_EVENTS_PER_TIMELINE} events of a timeline, with every lane they use and no other`, () => {
    expect(sampleTimeline(timeline(25), 25).cut).toBe(false);
    const r = sampleTimeline(timeline(100), 25);
    expect(r.cut).toBe(true);
    const ev = r.piece.events as Obj[];
    expect(ev).toHaveLength(25);
    const used = new Set(ev.map((e) => e.laneId));
    expect((r.piece.lanes as Obj[]).map((l) => l.id).sort()).toEqual([...used].sort());
    // Spread over the timeline, not its first 25.
    expect(Math.max(...ev.map((e) => e.start as number))).toBeGreaterThan(90);
  });

  const map = (): DocumentPiece => {
    const features: Obj[] = [
      { id: 'fold0001', type: 'folder', name: 'Towns' },
      { id: 'fold0002', type: 'folder', name: 'Villages', parentId: 'fold0001' },
    ];
    for (let i = 0; i < 60; i++)
      features.push({
        id: `pin${String(i).padStart(5, '0')}`,
        type: 'pin',
        name: `Pin ${i}`,
        ...(i % 3 === 0 ? { parentId: 'fold0002' } : {}),
      });
    features.push(
      { id: 'reg00001', type: 'region', name: 'Sea' },
      { id: 'pth00001', type: 'path', name: 'Road' },
    );
    return { settings: { type: 'map', name: 'Map' }, features };
  };

  it(`at most ${SAMPLE_FEATURES_PER_MAP} features of a map, parents with their children, a region and a path kept`, () => {
    const r = sampleMap(map(), 40);
    expect(r.cut).toBe(true);
    const fs = r.piece.features as Obj[];
    expect(fs).toHaveLength(40);
    const ids = new Set(fs.map((f) => f.id));
    expect(ids.has('reg00001')).toBe(true);
    expect(ids.has('pth00001')).toBe(true);
    for (const f of fs)
      if (typeof f.parentId === 'string') expect(ids.has(f.parentId), String(f.id)).toBe(true);
    // In the map's order (the snapshot's).
    const order = (map().features as Obj[]).map((f) => f.id).filter((x) => ids.has(x));
    expect(fs.map((f) => f.id)).toEqual(order);
  });

  it('the plan says what was cut, the run copies only that, and full mode cuts nothing', async () => {
    const id = await rehearsalSetup(() => {
      const evs = w!.events.get(w!.d.chronicle)!;
      for (let i = 0; i < 40; i++)
        evs.push({
          id: `evx${String(i).padStart(5, '0')}`,
          laneId: 'lane0002',
          type: 'event',
          name: `E${i}`,
          start: 200 + i,
          end: 200 + i,
          detail: 1,
          rank: `c${i}`,
        });
      for (let i = 0; i < 50; i++)
        mapFeatures().push({
          id: `pnx${String(i).padStart(5, '0')}`,
          type: 'pin',
          name: `P${i}`,
          pos: [-i, i],
          rank: `b${String(i).padStart(3, '0')}`,
        });
    });
    const rh = w!.stack.runtime.rehearsals;
    const sampled = (await rh.plan({ targetProject: 'test', snapshotId: id, mode: 'sampled', max: 10 })).plan;
    const ev = sampled.cuts.find((x) => x.what === 'events')!;
    const ft = sampled.cuts.find((x) => x.what === 'features')!;
    expect(ev).toMatchObject({ document: 'Chronicle', kept: 25, of: 43 });
    expect(ft).toMatchObject({ document: 'Map', kept: 40, of: 54 });
    const full = (await rh.plan({ targetProject: 'test', snapshotId: id, mode: 'full' })).plan;
    expect(full.cuts).toEqual([]);
    expect(full.estimate.writes - sampled.estimate.writes).toBeGreaterThanOrEqual(18 + 14);

    const before = w!.featureWrites.length;
    const done = await rehearse(id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as Result;
    expect(res.differences, JSON.stringify(res.differences, null, 1)).toEqual([]);
    expect(w!.featureWrites.length - before).toBe(40);
    expect((done.plan as { cuts?: unknown[] }).cuts).toHaveLength(2);
  });

  it('the estimate includes the pacing: the writes at P3’s write rate and the reads at its request rate', async () => {
    const id = await rehearsalSetup();
    const real = w!.stack.runtime.rehearsals as unknown as { d: RehearsalDeps };
    // The governor as Arkona's runs meet it: 500 ms spacing, and a P3 share of 6 writes and 30 requests a minute.
    const stub: RehearsalDeps = {
      ...real.d,
      projects: {
        ...real.d.projects,
        find: (r) => real.d.projects.find(r),
        list: () => real.d.projects.list(),
        client: () => ({
          governor: {
            estimate: (i) => ({
              wallClockMs: 1000,
              fitsToday: true,
              tightestTier: 'write-min',
              pacingMs: i.writes * 500,
              tiers: [
                { tier: 'write-min', demand: i.writes, capacityPerWindow: 6 },
                { tier: 'key-min', demand: i.reads + i.writes, capacityPerWindow: 30 },
              ],
            }),
          },
        }),
      },
    };
    const { plan } = await new Rehearsals(stub).plan({
      targetProject: 'test',
      snapshotId: id,
      mode: 'sampled',
      max: 10,
    });
    expect(plan.estimate.pacing).toEqual({ msPerWrite: 10_000, msPerRead: 2000 });
    expect(plan.estimate.wallClockMs).toBe(plan.estimate.writes * 10_000 + plan.estimate.reads * 2000);
    // With the real governor too: never less than the pacing it implies.
    const own = (
      await w!.stack.runtime.rehearsals.plan({
        targetProject: 'test',
        snapshotId: id,
        mode: 'sampled',
        max: 10,
      })
    ).plan.estimate;
    expect(own.pacing).not.toBeNull();
    expect(own.wallClockMs!).toBeGreaterThanOrEqual(
      own.writes * own.pacing!.msPerWrite + own.reads * own.pacing!.msPerRead,
    );
  });

  it('pacing: a tier counts once the work needs more than its P3 share of a window', () => {
    const p = pacingOf(
      {
        pacingMs: 1000 * 500,
        tiers: [
          { tier: 'write-min', demand: 1000, capacityPerWindow: 60 },
          { tier: 'write-hour', demand: 1000, capacityPerWindow: 1500 },
          { tier: 'key-min', demand: 1300, capacityPerWindow: 150 },
          { tier: 'key-day', demand: 1300, capacityPerWindow: 30_000 },
        ],
      },
      1000,
    );
    expect(p).toEqual({ msPerWrite: 1000, msPerRead: 400 });
    // A small job: only the spacing.
    expect(
      pacingOf({ pacingMs: 10 * 500, tiers: [{ tier: 'write-min', demand: 10, capacityPerWindow: 60 }] }, 10),
    ).toEqual({
      msPerWrite: 500,
      msPerRead: 0,
    });
  });
});
