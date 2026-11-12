/**
 * v2 E1a (ADR 0042): the snapshot store: canonical hashing, deduplication, compression and permissions, the verify
 * finding, partial snapshots, the disk check, retention with the collector, and sharing with D3's kept bytes.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boardDocumentPiece,
  mapDocumentPiece,
  pageDocumentPiece,
  pieceHash,
  sidebarPiece,
  SnapshotStore,
  timelineDocumentPiece,
} from '../../src/snapshots/index.js';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 60_000 });

let w: SnapshotsWorld | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('canonical hashing', () => {
  it('does not depend on key order, nor on the order LegendKeeper returns rows and items in (C2a.1: rank, then id)', () => {
    const rows = [
      { id: 'r2', rank: 'b', key: 'Scope', text: 'x', content: [{ text: 'x' }] },
      { id: 'r1', rank: 'a', key: 'Status', text: 'y', content: [{ text: 'y' }] },
      { id: 'r3', rank: 'b', key: 'Tie', text: 'z', content: [{ text: 'z' }] },
    ];
    const a = sidebarPiece([
      { id: 'p1', kind: 'keyValue', title: 'PROPERTIES', rows, version: 'v9' },
      {
        kind: 'resourceCollection',
        title: 'Deps',
        id: 'c1',
        items: [
          { id: 'i2', rank: 'b', resourceId: 'x' },
          { id: 'i1', rank: 'a', resourceId: 'y' },
        ],
      },
    ]);
    const b = sidebarPiece({
      data: [
        { title: 'PROPERTIES', kind: 'keyValue', id: 'p1', rows: [rows[1], rows[2], rows[0]] },
        {
          id: 'c1',
          items: [
            { resourceId: 'y', rank: 'a', id: 'i1' },
            { rank: 'b', id: 'i2', resourceId: 'x' },
          ],
          title: 'Deps',
          kind: 'resourceCollection',
        },
      ],
    });
    expect(pieceHash(a).sha256).toBe(pieceHash(b).sha256);
    // Rank order, ties by id; the property's version and a row's derived text are not part of the piece.
    expect((a.properties[0]!.rows as { id: string }[]).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(JSON.stringify(a)).not.toContain('v9');
    expect(JSON.stringify(a)).not.toContain('"text":"x","key"');
  });

  it('ignores block versions but keeps block order; features, lanes, events and board records in one order', () => {
    const p1 = pageDocumentPiece(
      { name: 'Main', type: 'page' },
      {
        version: 'v3',
        blocks: [
          { id: 'a', kind: 'paragraph', version: 'b7', content: [{ text: 'x' }] },
          { id: 'b', kind: 'paragraph', content: [] },
        ],
      },
    );
    const p2 = pageDocumentPiece(
      { type: 'page', name: 'Main' },
      {
        version: 'v4',
        blocks: [
          { content: [{ text: 'x' }], kind: 'paragraph', id: 'a', version: 'b8' },
          { id: 'b', kind: 'paragraph', content: [] },
        ],
      },
    );
    expect(pieceHash(p1).sha256).toBe(pieceHash(p2).sha256);
    const p3 = pageDocumentPiece(
      { type: 'page', name: 'Main' },
      {
        blocks: [
          { id: 'b', kind: 'paragraph', content: [] },
          { id: 'a', kind: 'paragraph', content: [{ text: 'x' }] },
        ],
      },
    );
    expect(pieceHash(p3).sha256).not.toBe(pieceHash(p1).sha256);
    const f = [
      { id: 'f2', rank: 'b', updatedAt: '1' },
      { id: 'f1', rank: 'a', updatedAt: '2' },
    ];
    expect(pieceHash(mapDocumentPiece({ type: 'map' }, f)).sha256).toBe(
      pieceHash(mapDocumentPiece({ type: 'map' }, [...f].reverse())).sha256,
    );
    const ev = [
      { id: 'e2', laneId: 'l1', rank: 'a' },
      { id: 'e1', laneId: 'l0', rank: 'z' },
    ];
    expect(pieceHash(timelineDocumentPiece({ type: 'time' }, [], ev)).sha256).toBe(
      pieceHash(timelineDocumentPiece({ type: 'time' }, [], [...ev].reverse())).sha256,
    );
    const c = {
      pages: [{ id: 'page:1' }],
      shapes: [{ id: 'shape:2' }, { id: 'shape:1' }],
      bindings: [],
      assets: [],
      version: 'b3',
    };
    expect(pieceHash(boardDocumentPiece({ type: 'board' }, c)).sha256).toBe(
      pieceHash(
        boardDocumentPiece({ type: 'board' }, { ...c, shapes: [...c.shapes].reverse(), version: 'b4' }),
      ).sha256,
    );
  });
});

describe('the store on disk', () => {
  it('stores each piece once, gzip-compressed, named by the SHA-256 of the content, private (0700 / 0600)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-store-'));
    dirs.push(dir);
    const store = new SnapshotStore(join(dir, 'snapshots'));
    const text = Buffer.from(
      JSON.stringify({
        blocks: Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, text: 'the same words again' })),
      }),
    );
    const a = await store.putBytes(text, { compress: 'text' });
    const b = await store.putBytes(text, { compress: 'text' });
    expect(a).toMatchObject({ sha256: sha(text), size: text.length, created: true });
    expect(b).toMatchObject({ sha256: sha(text), stored: 0, created: false });
    const path = store.objectPath(a.sha256);
    expect(path).toBe(join(dir, 'snapshots', 'objects', a.sha256.slice(0, 2), `${a.sha256}.gz`));
    const raw = readFileSync(path);
    expect(raw.length).toBeLessThan(text.length / 4);
    expect(gunzipSync(raw).equals(text)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const d of ['', 'objects', 'manifests', 'tmp'])
      expect(statSync(join(dir, 'snapshots', d)).mode & 0o777).toBe(0o700);
    const marker = JSON.parse(readFileSync(join(dir, 'snapshots', 'STORE.json'), 'utf8')) as {
      format: string;
      version: number;
    };
    expect(marker).toMatchObject({ format: 'lk-bridge-snapshot-store', version: 1 });
    expect((await store.get(a.sha256))!.equals(text)).toBe(true);
    expect(await store.usage()).toMatchObject({ objects: 1 });
  });

  it('a damaged object reads as null, is reported by check, and is rewritten when the same content is stored again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-store-'));
    dirs.push(dir);
    const store = new SnapshotStore(dir);
    const r = await store.putBytes(Buffer.from('a piece'), { compress: 'text' });
    writeFileSync(store.objectPath(r.sha256), Buffer.from('not gzip at all'));
    expect(await store.get(r.sha256)).toBeNull();
    expect(await store.check(r.sha256)).toBe('corrupt');
    await store.putBytes(Buffer.from('a piece'), { compress: 'text', repair: true });
    expect(await store.check(r.sha256)).toBe('ok');
    rmSync(store.objectPath(r.sha256));
    expect(await store.check(r.sha256)).toBe('missing');
  });

  it('moves D3’s old kept-bytes directory into the store (hash-checked), leaving a damaged file where it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-store-'));
    dirs.push(dir);
    const old = join(dir, 'images', 'kept-bytes');
    const good = Buffer.from('an old image');
    const h = sha(good);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(old, h.slice(0, 2)), { recursive: true });
    writeFileSync(join(old, h.slice(0, 2), h), good);
    const bad = '0'.repeat(64);
    mkdirSync(join(old, '00'), { recursive: true });
    writeFileSync(join(old, '00', bad), Buffer.from('not what the name says'));
    const store = new SnapshotStore(join(dir, 'snapshots'));
    const r = await store.adoptKeptBytes(old);
    expect(r).toEqual({ adopted: 1, damaged: [bad] });
    expect((await store.get(h))!.equals(good)).toBe(true);
  });
});

describe('the snapshot service’s store', () => {
  it('verify: a missing or damaged piece is a finding, and every snapshot that uses it becomes partial', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect((await snaps.verify()).missing + (await snaps.verify()).corrupt).toBe(0);
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    const victim = atlas.documents!.find((d) => d.type === 'page')!.sha256;
    writeFileSync(snaps.store.objectPath(victim), Buffer.from('bit rot'));
    const v = await snaps.verify();
    expect(v.corrupt).toBe(1);
    expect(snaps.index.openFindings()[0]).toMatchObject({
      sha256: victim,
      problem: 'corrupt',
      snapshots: [m.id],
    });
    expect(snaps.index.snapshot(m.id)).toMatchObject({
      state: 'partial',
      damaged: expect.stringMatching(/corrupt/) as unknown,
    });
    // A later full snapshot stores the same content again: the object is whole again, and the finding resolves.
    await snaps.full(PROJECT, 'manual');
    await snaps.verify();
    expect(await snaps.store.check(victim)).toBe('ok');
    expect(snaps.index.openFindings()).toHaveLength(0);
  });

  it('a piece that cannot be read makes the snapshot partial, with the reason, never silently complete', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    // Ahead of the world's own routes (overrides are tried in the order they were added).
    const rest = [...w.overrides];
    w.overrides.clear();
    w.overrides.set(new RegExp(`/docs/${w.d.plot}/board$`), () => ({
      status: 500,
      body: { code: 'INTERNAL', message: 'boom', requestId: 'x' },
    }));
    for (const [k, v] of rest) w.overrides.set(k, v);
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete).toBe(false);
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    expect(atlas.missing).toEqual([expect.objectContaining({ piece: 'document', ref: w.d.plot }) as unknown]);
    expect(snaps.index.snapshot(m.id)).toMatchObject({ state: 'partial', missing: 1 });
    expect(snaps.index.pageHistory(PROJECT, S.atlas, { piece: 'document', ref: w.d.plot })[0]).toMatchObject({
      sha256: null,
    });
  });

  it('retention keeps 8 complete full snapshots and 30 days of change snapshots; the collector removes what nothing refers to', async () => {
    w = await snapshotsWorld({ snapshots: { keepWeekly: 2, keepDays: 30 } });
    const snaps = w.stack.runtime.snapshots;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      // A different Main each time: each snapshot stores one new piece.
      w.repo.blocks
        .get(w.d.main)!
        .blocks.push({ id: `extra${i}`, kind: 'paragraph', content: [{ text: `edit ${i}` }] });
      ids.push((await snaps.full(PROJECT, 'manual')).snapshotId!);
    }
    const shaOf = async (id: string) =>
      (await snaps.manifest(id))!.pages
        .find((p) => p.id === S.atlas)!
        .documents!.find((d) => d.type === 'page')!.sha256;
    const oldest = await shaOf(ids[0]!);
    const newest = await shaOf(ids[2]!);
    // An old change snapshot, past 30 days.
    const c = w.stack.db.prepare(`SELECT id FROM snapshots WHERE kind = 'change' LIMIT 1`).get() as
      { id: string } | undefined;
    if (c)
      w.stack.db
        .prepare('UPDATE snapshots SET taken_at = ? WHERE id = ?')
        .run(Date.now() - 31 * 86_400_000, c.id);
    const r = await snaps.prune();
    expect(snaps.index.snapshots(PROJECT, { kind: 'full' }).map((s) => s.id)).toEqual([ids[2], ids[1]]);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    // The oldest Main is still within the grace hour: kept; without the grace it goes; the newest stays.
    expect(await snaps.store.check(oldest)).toBe('ok');
    await snaps.gc({ graceMs: 0 });
    expect(await snaps.store.check(oldest)).toBe('missing');
    expect(await snaps.store.check(newest)).toBe('ok');
  });

  it('kept bytes and snapshot images are one store: the same image is stored once, and kept while either refers to it', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    await snaps.full(PROJECT, 'manual');
    const img = w.sha(S.imgCrest);
    const before = (await snaps.store.usage()).objects;
    // The bytes kept before an asset delete land in the same object.
    expect(await w.stack.runtime.images.bytes.put(w.served.get(S.imgCrest)!)).toBe(img);
    expect((await snaps.store.usage()).objects).toBe(before);
    // Referred to by a kept-bytes row in its window, it survives the snapshots' going.
    w.stack.runtime.images.store.keepBytes(img, 10, 'image/webp');
    w.stack.runtime.images.store.addKeptRef({
      projectId: PROJECT,
      assetId: S.imgCrest,
      name: 'Crest',
      folderId: null,
      sha256: img,
      jobId: null,
      stepNo: null,
      expiresAt: Date.now() + 86_400_000,
    });
    for (const s of snaps.index.snapshots(PROJECT)) snaps.index.removeSnapshot(s.id);
    await snaps.gc({ graceMs: 0 });
    expect(await snaps.store.check(img)).toBe('ok');
    w.stack.db.prepare('UPDATE asset_kept_refs SET expires_at = ?').run(Date.now() - 1);
    await w.stack.runtime.images.expireKept();
    await snaps.gc({ graceMs: 0 });
    expect(await snaps.store.check(img)).toBe('missing');
  });

  it('the dashboard’s view: the store’s size, the dedup ratio, the free space and the minimum', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    await snaps.full(PROJECT, 'manual');
    await snaps.full(PROJECT, 'manual');
    const o = (await snaps.overview(PROJECT)) as {
      store: { bytes: number };
      dedupRatio: number;
      disk: { free: number };
      minFreeBytes: number;
      counts: { full: { count: number } };
    };
    expect(o.store.bytes).toBeGreaterThan(0);
    expect(o.dedupRatio).toBeGreaterThan(1.9); // two snapshots of the same content: about 2
    expect(o.disk.free).toBeGreaterThan(0);
    expect(o.minFreeBytes).toBe(0); // the test world sets it to 0
    expect(o.counts.full.count).toBe(2);
  });
});
