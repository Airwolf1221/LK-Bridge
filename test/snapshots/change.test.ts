/**
 * v2 E1a (ADR 0042): change snapshots: after every bridge write that changes a page, that page's changed pieces are taken
 * inside the job's end, from the reads the job made after its writes (the verify step, the tree's re-read) where they
 * cover the piece, and read otherwise. One kind of write each, with its extra cost; and the daily pass.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { Manifest } from '../../src/snapshots/index.js';
import { asCanon } from '../resources/world.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 60_000 });

let w: SnapshotsWorld;
let c: Client;
const costs: Record<string, number> = {};
beforeAll(async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
});
afterAll(async () => {
  process.stdout.write(
    `change snapshot reads per tool (mock): ${Object.entries(costs)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}\n`,
  );
  await w.close();
});

const call = (name: string, args: Record<string, unknown>) =>
  w.stack.call(c, name, { project: 'test', ...args });

/** The change snapshot a call made: the newest one, after it. */
async function changeAfter(before: number, label: string, r?: ToolCall): Promise<Manifest> {
  if (r) expect(r.isError, JSON.stringify(r.body)).toBe(false);
  const snaps = w.stack.runtime.snapshots;
  await snaps.settled();
  const rows = snaps.index.snapshots(PROJECT, { kind: 'change', limit: 50 });
  expect(rows.length, `a change snapshot after ${label}`).toBeGreaterThan(before);
  const m = (await snaps.manifest(rows[0]!.id))!;
  costs[label] = m.counts.reads;
  return m;
}
const changes = () =>
  w.stack.runtime.snapshots.index.snapshots(PROJECT, { kind: 'change', limit: 1000 }).length;

describe('change snapshots after each kind of bridge write', () => {
  it('write_page: the document only, from the verify read (no second read of the blocks)', async () => {
    const n = changes();
    const blockGets = () =>
      w.seen.filter((l) => l.startsWith(`GET /resources/${S.atlas}/docs/${w.d.main}/blocks`)).length;
    const g0 = blockGets();
    const r = await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Appended by a test.' });
    const m = await changeAfter(n, 'write_page', r);
    expect(m.trigger).toMatchObject({ tool: 'write_page', ops: ['replaceDocumentBlocks'] });
    expect(m.pages).toHaveLength(1);
    const p = m.pages[0]!;
    expect(p.id).toBe(S.atlas);
    expect(p.resource).toBeUndefined();
    expect(p.sidebar).toBeUndefined();
    expect(p.documents!.map((d) => d.id)).toEqual([w.d.main]);
    // The plan's read, the read inside the lock, and the verify read: the change snapshot read the blocks no more.
    expect(blockGets() - g0).toBe(3);
    // The piece is what a full snapshot of the same state stores (the same hash).
    const full = (await w.stack.runtime.snapshots.manifest(
      (await w.stack.runtime.snapshots.full(PROJECT, 't')).snapshotId!,
    ))!;
    expect(full.pages.find((x) => x.id === S.atlas)!.documents!.find((d) => d.id === w.d.main)!.sha256).toBe(
      p.documents![0]!.sha256,
    );
  });

  it('set_facts: the sidebar, from the reads the job already made', async () => {
    const n = changes();
    const r = await call('set_facts', { page: S.atlas, facts: { Scope: 'Every document type, and more' } });
    const m = await changeAfter(n, 'set_facts', r);
    expect(m.pages[0]).toMatchObject({ id: S.atlas });
    expect(m.pages[0]!.sidebar).toBeDefined();
    expect(m.pages[0]!.documents).toBeUndefined();
    expect(m.counts.reads).toBe(0);
  });

  it('create_bare_resource: the whole new page; delete_resource: the page as deleted; restore_resource: the whole page again', async () => {
    let n = changes();
    const r = await call('create_bare_resource', { name: '[BWRK] Snapshot Scratch' });
    let m = await changeAfter(n, 'create_bare_resource', r);
    const id = m.pages[0]!.id;
    expect(m.pages[0]).toMatchObject({ name: '[BWRK] Snapshot Scratch', parentId: 'working1' });
    expect(m.pages[0]!.resource).toBeDefined();
    expect(m.pages[0]!.sidebar).toBeDefined();
    expect(m.pages[0]!.documents!.length).toBeGreaterThan(0);
    n = changes();
    const d = await call('delete_resource', { page: id, confirm: true });
    m = await changeAfter(n, 'delete_resource', d);
    expect(m.pages).toEqual([expect.objectContaining({ id, deleted: true }) as unknown]);
    n = changes();
    const back = await call('restore_resource', { page: id });
    m = await changeAfter(n, 'restore_resource', back);
    expect(m.pages[0]).toMatchObject({ id });
    expect(m.pages[0]!.deleted).toBeUndefined();
    expect(m.pages[0]!.resource).toBeDefined();
  });

  it('update_resource and move_resource: the resource and its place', async () => {
    const n = changes();
    const r = await call('update_resource', { page: S.atlas, tags: { add: ['charted'] } });
    const m = await changeAfter(n, 'update_resource', r);
    expect(m.pages[0]!.resource).toBeDefined();
    expect(m.pages[0]!.documents).toBeUndefined();
  });

  it('create_document, update_document and delete_document: that document only', async () => {
    let n = changes();
    const r = await call('create_document', { page: S.atlas, name: 'Second Map', type: 'map' });
    let m = await changeAfter(n, 'create_document', r);
    const doc = m.pages[0]!.documents!.find((d) => d.name === 'Second Map')!;
    expect(doc.type).toBe('map');
    n = changes();
    m = await changeAfter(
      n,
      'update_document',
      await call('update_document', { page: S.atlas, document: 'Second Map', name: 'Second Map (renamed)' }),
    );
    expect(m.pages[0]!.documents!.map((d) => d.name)).toEqual(['Second Map (renamed)']);
    n = changes();
    m = await changeAfter(
      n,
      'delete_document',
      await call('delete_document', { page: S.atlas, document: 'Second Map (renamed)', confirm: true }),
    );
    expect(m.pages[0]!.deletedDocuments).toEqual([doc.id]);
  });

  it('create_map_feature: the map (its settings and features)', async () => {
    const n = changes();
    const r = await call('create_map_feature', {
      page: S.atlas,
      document: 'Map',
      type: 'pin',
      name: 'Lighthouse',
      latlng: [-5, 5],
    });
    const m = await changeAfter(n, 'create_map_feature', r);
    expect(m.pages[0]!.documents!.map((d) => d.id)).toEqual([w.d.map]);
    const piece = (await w.stack.runtime.snapshots.store.getJson<{ features: { name: string }[] }>(
      m.pages[0]!.documents![0]!.sha256,
    ))!;
    expect(piece.features.map((f) => f.name)).toContain('Lighthouse');
  });

  it('lk_api_write on a timeline, a board and a block (as the chronology tools write): the document', async () => {
    for (const [label, op, params] of [
      [
        'lk_api_write createEvent',
        'createEvent',
        {
          path: { resourceId: S.atlas, documentId: w.d.chronicle },
          body: { laneId: 'lane0002', type: 'event', name: 'A storm', start: 400, end: 400, detail: 1 },
        },
      ],
      [
        'lk_api_write insertBlock',
        'insertBlock',
        {
          path: { resourceId: S.atlas, documentId: w.d.main },
          body: { block: { kind: 'paragraph', content: [{ text: 'One block.' }] } },
        },
      ],
    ] as const) {
      const n = changes();
      const r = await call('lk_api_write', { operationId: op, params });
      const m = await changeAfter(n, label, r);
      expect(m.pages[0]!.documents!.map((d) => d.id)).toEqual([params.path.documentId]);
    }
    const n = changes();
    const board = (
      await call('lk_api_read', {
        operationId: 'getBoardContent',
        params: { path: { resourceId: S.atlas, documentId: w.d.plot } },
        detail: 'full',
      })
    ).body as { result: { version: string; shapes: unknown[] } };
    const r = await call('lk_api_write', {
      operationId: 'replaceBoardContent',
      params: {
        path: { resourceId: S.atlas, documentId: w.d.plot },
        ifMatch: board.result.version,
        body: { shapes: board.result.shapes.slice(0, 1), bindings: [], assets: [] },
      },
    });
    const m = await changeAfter(n, 'lk_api_write replaceBoardContent', r);
    expect(m.pages[0]!.documents!.map((d) => d.id)).toEqual([w.d.plot]);
  });

  it('an asset write: the library, from the asset tree (no request), with new images’ bytes', async () => {
    const n = changes();
    const r = await call('lk_api_write', {
      operationId: 'createAssetFolder',
      params: { body: { name: 'Snapshot folder' } },
    });
    const m = await changeAfter(n, 'lk_api_write createAssetFolder', r);
    expect(m.library).not.toBeNull();
    expect(m.counts.reads).toBe(0);
    const lib = (await w.stack.runtime.snapshots.store.getJson<{ folders: { name: string }[] }>(
      m.library!.piece!.sha256,
    ))!;
    expect(lib.folders.map((f) => f.name)).toContain('Snapshot folder');
  });

  it('a lifecycle tool (archive_page, accepted as canon): every piece it changed, in one change snapshot', async () => {
    const n = changes();
    const r = await asCanon(w, await call('archive_page', { page: S.harbour }));
    expect(r.body.status, JSON.stringify(r.body)).toBe('written');
    const m = await changeAfter(n, 'archive_page');
    const p = m.pages.find((x) => x.id === S.harbour)!;
    expect(p.name).toMatch(/^\[BARC\] /);
    expect(p.parentId).toBe('archive1');
    expect(p.resource).toBeDefined();
    expect(p.sidebar).toBeDefined();
    expect(p.documents!.length).toBe(1);
  });

  it('a write outside the AI REPOSITORY (a template) takes no snapshot', async () => {
    const n = changes();
    await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'tplnote1' }, body: { aliases: ['x'] } },
    });
    await w.stack.runtime.snapshots.settled();
    expect(changes()).toBe(n);
    expect(w.stack.runtime.snapshots.index.owedCount(PROJECT)).toBe(0);
  });

  it('owed pieces survive a crash: they are taken at the next start', async () => {
    const snaps = w.stack.runtime.snapshots;
    snaps.index.addOwed([
      {
        projectId: PROJECT,
        jobId: 'job_lost',
        pageId: S.atlas,
        piece: 'sidebar',
        ref: '',
        opId: 'updatePropertyRow',
        tool: null,
      },
    ]);
    const n = changes();
    await snaps.takeChange(PROJECT, 'job_lost');
    expect(changes()).toBe(n + 1);
    expect(snaps.index.owedCount(PROJECT)).toBe(0);
  });
});

describe('the daily changed-pages pass', () => {
  it('is off by default (until the sandbox run confirms updatedAt), and says why', async () => {
    const r = await w.stack.runtime.snapshots.daily(PROJECT, 'schedule');
    expect(r).toMatchObject({ skipped: true });
    expect(r.summary).toMatch(/switched off/);
  });

  it('when on: snapshots exactly the pages whose updatedAt moved since a snapshot saw them', async () => {
    const snaps = w.stack.runtime.snapshots;
    w.stack.runtime.projects.setSetting(PROJECT, 'snapshotDailyPass', true);
    // The world's listing carries updatedAt; a full snapshot records what it saw.
    const stamps = new Map<string, string>();
    // Ahead of the world's own routes (overrides are tried in the order they were added).
    const rest = [...w.overrides];
    w.overrides.clear();
    w.overrides.set(/\/resources$/, (req) => {
      if (req.method !== 'GET') return undefined;
      const r = w.repo.respond(req);
      if (!r || r.status !== 200) return r;
      const b = r.body as { data: { id: string }[] };
      return {
        status: 200,
        body: {
          ...b,
          data: b.data.map((x) => ({ ...x, updatedAt: stamps.get(x.id) ?? '2026-11-01T00:00:00Z' })),
        },
      };
    });
    w.overrides.set(/\/resources\/[^/]+$/, (req) => {
      if (req.method !== 'GET') return undefined;
      const id = req.path.replace(/\/$/, '').split('/').pop()!;
      const r =
        w.sidebars.respond(req, (x) => {
          const res = w.repo.live(x);
          return res ? w.repo.resourceView(res) : undefined;
        }) ?? w.repo.respond(req);
      if (!r || r.status !== 200) return r;
      return {
        status: 200,
        body: { ...(r.body as object), updatedAt: stamps.get(id) ?? '2026-11-01T00:00:00Z' },
      };
    });
    for (const [k, v] of rest) w.overrides.set(k, v);
    await snaps.full(PROJECT, 'manual');
    let r = await snaps.daily(PROJECT, 'schedule');
    expect(r.summary).toMatch(/No page’s updatedAt moved/);
    stamps.set(S.atlas, '2026-11-12T10:00:00Z');
    r = await snaps.daily(PROJECT, 'schedule');
    expect(r.changed).toBe(true);
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.kind).toBe('daily');
    expect(m.pages.map((p) => p.id)).toEqual([S.atlas]);
    // Seen now: the next pass finds nothing.
    const again = await snaps.daily(PROJECT, 'schedule');
    expect(again.summary).toMatch(/No page’s updatedAt moved/);
    w.stack.runtime.projects.setSetting(PROJECT, 'snapshotDailyPass', false);
  });
});
