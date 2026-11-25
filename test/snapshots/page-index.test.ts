/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies and raw rows */
/**
 * The 25 November 2026 Snapshots freeze (ADR 0042 amendment 2): the page index behind the Snapshots page, against the
 * mock LegendKeeper.
 *
 * - It is kept current by a full snapshot and by change snapshots (an edit, a rename, a deletion and the page back), and
 *   by retention removing a snapshot: after every step it equals what the old aggregate worked out from every piece row
 *   (`reference` below, the removed `pagesWithHistory`'s rules), and so do the logical totals.
 * - The one-time backfill builds it for snapshots indexed before it (and their missing-piece lists), yielding to the event
 *   loop between chunks.
 * - The page list is paged and filtered on the server; following `next` gives exactly the whole list, across cursor
 *   boundaries, with a name filter and a branch filter. A page's history, paged, gives exactly the old unpaged history
 *   (the same snapshots, the same change against the previous state), for every piece filter.
 * - `GET /snapshots` answers at once while a full snapshot runs, with its progress; a closed request stops.
 */
import { EventEmitter } from 'node:events';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closedSignal } from '../../src/admin/routes/util.js';
import { historyOf, type HistoryEntry } from '../../src/snapshots/history.js';
import type { PieceRow } from '../../src/snapshots/db.js';
import type { Manifest } from '../../src/snapshots/index.js';
import type { SnapshotService } from '../../src/snapshots/service.js';
import { PROJECT, PUBLIC_URL } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld;
let c: Client;
let svc: SnapshotService;
beforeAll(async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  svc = w.stack.runtime.snapshots;
});
afterAll(async () => w?.close());

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await w.stack.call(c, name, { project: 'test', ...args });
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  await svc.settled();
  return r;
};

/** The page list as the old aggregate worked it out from every piece row (the removed `pagesWithHistory`). */
function reference(): { pageId: string; name: string | null; lastAt: number; deleted: boolean }[] {
  const rows = w.stack.db
    .prepare(
      `SELECT page_id, piece, name, taken_at, snapshot_id FROM snapshot_pieces WHERE project_id = ? AND page_id <> '*'`,
    )
    .all(PROJECT) as {
    page_id: string;
    piece: string;
    name: string | null;
    taken_at: number;
    snapshot_id: string;
  }[];
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.page_id, [...(by.get(r.page_id) ?? []), r]);
  const newest = (xs: typeof rows) =>
    [...xs].sort((a, b) => b.taken_at - a.taken_at || b.snapshot_id.localeCompare(a.snapshot_id))[0];
  return [...by.entries()]
    .map(([pageId, xs]) => ({
      pageId,
      name:
        newest(xs.filter((x) => x.name !== null && ['resource', 'sidebar', 'deleted'].includes(x.piece)))
          ?.name ?? null,
      lastAt: Math.max(...xs.map((x) => x.taken_at)),
      deleted: newest(xs.filter((x) => x.piece === 'resource' || x.piece === 'deleted'))?.piece === 'deleted',
    }))
    .sort((a, b) => b.lastAt - a.lastAt || b.pageId.localeCompare(a.pageId));
}

/** The old logical totals: every piece row's bytes, and each distinct hash once. */
function referenceTotals() {
  return svc.index.logicalTotals(PROJECT);
}

function indexed() {
  return svc.pages
    .list(PROJECT, { limit: 10_000 })
    .pages.map((p) => ({ pageId: p.pageId, name: p.name, lastAt: p.lastAt, deleted: p.deleted }));
}

function expectCurrent(label: string) {
  expect(indexed(), label).toEqual(reference());
  expect(svc.pages.totals(PROJECT), label).toEqual(referenceTotals());
  // Every snapshot's pages are in, and every page's count is the snapshots holding it.
  expect(svc.pages.status(PROJECT).pending, label).toBe(0);
  for (const p of svc.pages.list(PROJECT, { limit: 10_000 }).pages) {
    const n = (
      w.stack.db
        .prepare(
          'SELECT COUNT(DISTINCT snapshot_id) AS n FROM snapshot_pieces WHERE project_id = ? AND page_id = ?',
        )
        .get(PROJECT, p.pageId) as { n: number }
    ).n;
    expect(p.snapshots, `${label}: ${p.pageId}`).toBe(n);
  }
}

/** The old, unpaged history (git HEAD before the freeze fix): every row of the page, compared oldest first. */
function oldHistory(pageId: string, f: { piece?: string; ref?: string }): HistoryEntry[] {
  const rows = svc.index.pageHistory(PROJECT, pageId, {
    ...(f.piece ? { piece: f.piece } : {}),
    ...(f.ref !== undefined ? { ref: f.ref } : {}),
    limit: 5000,
  });
  const asc = [...rows].reverse();
  const prevOf = new Map<PieceRow, PieceRow | undefined>();
  const lastBy = new Map<string, PieceRow>();
  for (const r of asc) {
    const k =
      r.piece === 'deleted' ? '*' : `${r.piece === 'document-deleted' ? 'document' : r.piece}:${r.ref}`;
    const prev = r.piece === 'deleted' ? undefined : (lastBy.get(k) ?? lastBy.get('*'));
    prevOf.set(r, prev);
    lastBy.set(k, r);
    if (r.piece === 'deleted') for (const key of [...lastBy.keys()]) lastBy.set(key, r);
  }
  const bySnap = new Map<string, PieceRow[]>();
  for (const r of rows) bySnap.set(r.snapshotId, [...(bySnap.get(r.snapshotId) ?? []), r]);
  return [...bySnap.entries()].map(([id, list]) => ({
    snapshot: id,
    takenAt: new Date(list[0]!.takenAt).toISOString(),
    kind: list[0]!.kind,
    pieces: list.map((r) => {
      const prev = prevOf.get(r);
      const doc = r.piece === 'document' || r.piece === 'document-deleted';
      return {
        piece: doc ? `document ${r.name ?? r.ref}` : r.piece === 'resource' ? 'settings' : r.piece,
        ...(doc ? { documentId: r.ref } : {}),
        change:
          r.piece === 'deleted' || r.piece === 'document-deleted'
            ? 'deleted'
            : r.sha256 === null
              ? 'missing (a partial snapshot)'
              : !prev
                ? 'first seen'
                : prev.piece === 'deleted' || prev.piece === 'document-deleted'
                  ? 'back'
                  : prev.sha256 === r.sha256
                    ? 'unchanged'
                    : 'changed',
      };
    }) as any,
  }));
}

/** The new history, followed page by page (`limit` at a time), in the old one's shape. */
function pagedHistory(
  pageId: string,
  f: { piece?: 'resource' | 'sidebar' | 'document'; ref?: string },
  limit: number,
) {
  const out: { snapshot: string; takenAt: string; kind: string; changes: string[] }[] = [];
  let cursor: string | undefined;
  let count = -1;
  for (let i = 0; i < 1000; i++) {
    const h = historyOf(svc, PROJECT, pageId, f, limit, cursor);
    count = h.count;
    for (const e of h.snapshots)
      out.push({
        snapshot: e.snapshot,
        takenAt: e.takenAt,
        kind: e.kind,
        changes: e.pieces.map((p) => `${p.piece}${(p as any).documentId ?? ''}: ${p.change}`).sort(),
      });
    if (!h.next) break;
    expect(h.snapshots).toHaveLength(limit);
    expect(h.more).toBeGreaterThan(0);
    cursor = h.next;
  }
  expect(out).toHaveLength(count);
  return out;
}

function expectHistories(label: string) {
  for (const pageId of indexed().map((p) => p.pageId)) {
    const docs = (
      w.stack.db
        .prepare(
          `SELECT DISTINCT ref FROM snapshot_pieces WHERE project_id = ? AND page_id = ? AND piece IN ('document', 'document-deleted')`,
        )
        .all(PROJECT, pageId) as { ref: string }[]
    ).map((r) => r.ref);
    const filters: { piece?: 'resource' | 'sidebar' | 'document'; ref?: string }[] = [
      {},
      { piece: 'resource' },
      { piece: 'sidebar' },
      ...docs.map((ref) => ({ piece: 'document' as const, ref })),
    ];
    for (const f of filters) {
      const want = oldHistory(pageId, f).map((e) => ({
        snapshot: e.snapshot,
        takenAt: e.takenAt,
        kind: e.kind,
        changes: e.pieces.map((p) => `${p.piece}${(p as any).documentId ?? ''}: ${p.change}`).sort(),
      }));
      for (const limit of [1, 2, 500])
        expect(
          pagedHistory(pageId, f, limit),
          `${label}: ${pageId} ${JSON.stringify(f)} by ${limit}`,
        ).toEqual(want);
    }
  }
}

describe('the page index', () => {
  it('is kept current by a full snapshot and by change snapshots, a deletion and a rename included', async () => {
    await svc.full(PROJECT, 'manual');
    expectCurrent('after the full snapshot');
    expect(indexed().length).toBeGreaterThan(5);
    const atlas = svc.pages.page(PROJECT, S.atlas)!;
    expect(atlas.snapshots).toBe(1);
    expect(atlas.branch?.name).toBe('Locations');

    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Appended for the page index.' });
    expectCurrent('after an edit');
    expect(svc.pages.page(PROJECT, S.atlas)!.snapshots).toBe(2);
    expect(svc.pages.list(PROJECT, { limit: 1 }).pages[0]!.pageId).toBe(S.atlas);

    const made = await call('create_bare_resource', { name: '[BWRK] Index Scratch' });
    const id = String(
      (made.body as any).id ?? (made.body as any).page?.id ?? (made.body as any).resource?.id,
    );
    const scratch = indexed().find((p) => p.name === '[BWRK] Index Scratch')!;
    expect(scratch, JSON.stringify(made.body)).toBeDefined();
    expectCurrent('after a new page');
    await call('delete_resource', { page: scratch.pageId, confirm: true });
    expectCurrent('after a deletion');
    expect(svc.pages.page(PROJECT, scratch.pageId)).toMatchObject({
      deleted: true,
      name: '[BWRK] Index Scratch',
    });
    await call('restore_resource', { page: scratch.pageId });
    expectCurrent('after the page came back');
    expect(svc.pages.page(PROJECT, scratch.pageId)!.deleted).toBe(false);
    await call('update_resource', { page: scratch.pageId, name: '[BWRK] Index Scratch Renamed' });
    expectCurrent('after a rename');
    expect(svc.pages.page(PROJECT, scratch.pageId)!.name).toBe('[BWRK] Index Scratch Renamed');
    void id;

    // A second full snapshot, then the histories, paged, equal the old unpaged ones.
    await svc.full(PROJECT, 'manual');
    expectCurrent('after a second full snapshot');
    expectHistories('before retention');
  });

  it('follows retention: a snapshot removed takes its pages out (a page held by no other is gone)', async () => {
    const scratch = indexed().find((p) => p.name === '[BWRK] Index Scratch Renamed')!;
    // Every change snapshot of the scratch page made old enough for retention, and so the deletion is forgotten.
    const old = Date.now() - 40 * 86_400_000;
    const changes = svc.index
      .snapshots(PROJECT, { kind: 'change', limit: 1000 })
      .filter((s) => svc.index.piecesOf(s.id, scratch.pageId).length > 0);
    expect(changes.length).toBeGreaterThanOrEqual(4);
    // The deletion's change snapshot first: the page's state goes back to what the others say.
    const deletion = changes.find((s) =>
      svc.index.piecesOf(s.id, scratch.pageId).some((r) => r.piece === 'deleted'),
    )!;
    w.stack.db.prepare('UPDATE snapshots SET taken_at = ? WHERE id = ?').run(old, deletion.id);
    expect((await svc.prune()).removed).toBe(1);
    expectCurrent('after the deletion’s snapshot went');
    expect(svc.pages.page(PROJECT, scratch.pageId)!.deleted).toBe(false);
    // Then every snapshot holding it but the full ones: it stays (the full snapshots hold it).
    for (const s of changes)
      w.stack.db.prepare('UPDATE snapshots SET taken_at = ? WHERE id = ?').run(old, s.id);
    await svc.prune();
    expectCurrent('after its change snapshots went');
    // A page only change snapshots held goes from the index with them.
    const only = await call('create_bare_resource', { name: '[BWRK] Index Short Lived' });
    void only;
    const short = indexed().find((p) => p.name === '[BWRK] Index Short Lived')!;
    for (const s of svc.index.snapshots(PROJECT, { kind: 'change', limit: 1000 }))
      w.stack.db.prepare('UPDATE snapshots SET taken_at = ? WHERE id = ?').run(old, s.id);
    await svc.prune();
    expectCurrent('after every change snapshot went');
    expect(svc.pages.page(PROJECT, short.pageId)).toBeNull();
    expectHistories('after retention');
  });

  it('the backfill builds it for snapshots indexed before it (and their missing lists), yielding between chunks', async () => {
    // More nightly full snapshots (the full manifest written again, a day apart), as the retention keeps about 30.
    const full = svc.index.snapshots(PROJECT, { kind: 'full', limit: 1 })[0]!;
    const m = (await svc.manifest(full.id))!;
    for (let k = 1; k <= 30; k++) {
      const at = (t: string) => new Date(Date.parse(t) - k * 86_400_000).toISOString();
      const stamp = at(m.takenAt)
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      // One of them partial: a missing piece recorded in its manifest.
      const partial = k === 3;
      const clone: Manifest = {
        ...m,
        id: `${stamp}-full-${(0xb00000 + k).toString(16)}`,
        takenAt: at(m.takenAt),
        startedAt: at(m.startedAt),
        complete: !partial,
        counts: { ...m.counts, missing: partial ? 1 : 0 },
        pages: m.pages.map((p, i) =>
          partial && i === 1
            ? { ...p, missing: [{ piece: 'document', ref: 'gone0001', reason: 'a test: the read failed' }] }
            : p,
        ),
      };
      await svc.writeSnapshot(clone);
    }
    const want = indexed();
    const totals = svc.pages.totals(PROJECT);
    expectCurrent('before the backfill');
    // As a database from before migration 4600: nothing in the index, every snapshot unlisted.
    const db = w.stack.db;
    db.exec(`DELETE FROM snapshot_page_snapshots; DELETE FROM snapshot_pages; DELETE FROM snapshot_hash_refs;
             DELETE FROM snapshot_totals; DELETE FROM snapshot_missing;
             UPDATE snapshots SET paged = 0, missing_listed = CASE WHEN missing = 0 THEN 1 ELSE 0 END;`);
    expect(svc.pages.status(PROJECT).pending).toBeGreaterThan(30);
    expect(svc.pages.list(PROJECT, { limit: 10 }).pages).toEqual([]);
    const partial = svc.index.snapshots(PROJECT, { limit: 1000 }).find((s) => s.missing > 0)!;
    expect(svc.index.missingOf(partial.id, { limit: 10 })).toBeNull();
    // The event loop turns while it runs: a timer keeps ticking, and no chunk holds it for long.
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    const yields0 = svc.pages.yields;
    svc.pages.longestSliceMs = 0;
    const r = await svc.backfillIndex();
    clearInterval(t);
    expect(r.paged).toBeGreaterThan(30);
    expect(r.listed).toBe(1);
    expect(svc.pages.yields - yields0).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
    expect(svc.pages.longestSliceMs).toBeLessThan(50);
    expect(indexed()).toEqual(want);
    expect(svc.pages.totals(PROJECT)).toEqual(totals);
    expectCurrent('after the backfill');
    expect(svc.index.missingOf(partial.id, { limit: 10 })).toEqual({
      total: 1,
      pieces: [
        expect.objectContaining({ piece: 'document', ref: 'gone0001', reason: 'a test: the read failed' }),
      ],
    });
    // Run again: nothing to do.
    expect(await svc.backfillIndex()).toEqual({ paged: 0, listed: 0 });
  });

  it('pages the list on the server: following `next` gives the whole list, with a name and a branch filter', () => {
    const all = svc.pages.list(PROJECT, { limit: 10_000 }).pages;
    expect(all.length).toBeGreaterThan(5);
    const follow = (q: { query?: string; branch?: string }, limit: number) => {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 1000; i++) {
        const r = svc.pages.list(PROJECT, { ...q, limit, ...(cursor ? { cursor } : {}) });
        out.push(...r.pages.map((p) => p.pageId));
        if (!r.next) break;
        expect(r.pages).toHaveLength(limit);
        cursor = r.next;
      }
      return out;
    };
    for (const limit of [1, 2, 3, 7]) expect(follow({}, limit)).toEqual(all.map((p) => p.pageId));
    // Name contains (any case), across pages of results.
    const named = all.filter((p) => (p.name ?? '').toLowerCase().includes('index')).map((p) => p.pageId);
    expect(named.length).toBeGreaterThan(1);
    expect(follow({ query: 'INDEX' }, 1)).toEqual(named);
    // A branch: its pages only.
    const branch = svc.pages.branches(PROJECT).find((b) => b.name === 'Locations')!;
    expect(branch.pages).toBeGreaterThan(1);
    const inBranch = all.filter((p) => p.branch?.id === branch.id).map((p) => p.pageId);
    expect(inBranch).toContain(S.atlas);
    expect(follow({ branch: branch.id }, 1)).toEqual(inBranch);
    expect(follow({ branch: branch.id, query: 'atlas' }, 1)).toEqual([S.atlas]);
    // Ties on the time are ordered by id, so a cursor never skips or repeats one.
    w.stack.db.prepare('UPDATE snapshot_pages SET last_at = 1000 WHERE project_id = ?').run(PROJECT);
    const tied = svc.pages.list(PROJECT, { limit: 10_000 }).pages.map((p) => p.pageId);
    expect(follow({}, 2)).toEqual(tied);
    expect(new Set(tied).size).toBe(all.length);
  });

  it('the admin routes: the list paged, a page’s history paged, a bad cursor refused, an unknown page a 404', async () => {
    const o = owner();
    const first = await o.get('/snapshots/pages?limit=2');
    expect(first.status).toBe(200);
    expect(first.json.pages).toHaveLength(2);
    expect(typeof first.json.next).toBe('string');
    expect(first.json.branches.length).toBeGreaterThan(0);
    expect(first.json.index).toMatchObject({ pending: 0 });
    const second = await o.get(`/snapshots/pages?limit=2&cursor=${encodeURIComponent(first.json.next)}`);
    expect(second.json.pages.map((p: any) => p.pageId)).not.toContain(first.json.pages[0].pageId);
    const h = await o.get(`/snapshots/pages/${S.atlas}?limit=1`);
    expect(h.status).toBe(200);
    expect(h.json.history.snapshots).toHaveLength(1);
    expect(h.json.history.next).toBeDefined();
    const older = await o.get(
      `/snapshots/pages/${S.atlas}?limit=1&cursor=${encodeURIComponent(h.json.history.next)}`,
    );
    expect(older.json.history.snapshots[0].snapshot).not.toBe(h.json.history.snapshots[0].snapshot);
    expect((await o.get('/snapshots/pages?cursor=')).status).toBe(400);
    expect((await o.get('/snapshots/pages/zzzzzz99')).status).toBe(404);
  });

  it('GET /snapshots answers at once while a full snapshot runs, with its progress', async () => {
    // The run is held after its third page until the test lets it go.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pages = 0;
    (svc.o as { afterPage?: unknown }).afterPage = async () => {
      if (++pages === 3) await gate;
    };
    const running = svc.full(PROJECT, 'manual');
    try {
      for (let i = 0; i < 400 && pages < 3; i++) await new Promise((r) => setTimeout(r, 10));
      const t0 = performance.now();
      const r = await owner().get('/snapshots');
      const ms = performance.now() - t0;
      expect(r.status).toBe(200);
      expect(ms).toBeLessThan(300);
      expect(r.json.running).toMatchObject({ done: 3, trigger: 'manual' });
      expect(r.json.running.total).toBeGreaterThan(3);
      expect(r.json.overview.store.bytes).toBeGreaterThan(0);
    } finally {
      release();
      (svc.o as { afterPage?: unknown }).afterPage = undefined;
      await running;
    }
    expect((await owner().get('/snapshots')).json.running).toBeNull();
  });

  it('a request whose client has gone is aborted (ADR 0061 amendment 2)', () => {
    const raw = Object.assign(new EventEmitter(), { writableEnded: false });
    const signal = closedSignal({ raw } as never);
    expect(signal.aborted).toBe(false);
    raw.emit('close');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ status: 499, code: 'REQUEST_CLOSED' });
    // An answer sent, then the connection closed: not aborted.
    const done = Object.assign(new EventEmitter(), { writableEnded: true });
    const s2 = closedSignal({ raw: done } as never);
    done.emit('close');
    expect(s2.aborted).toBe(false);
  });
});

/** The dashboard's owner session against the world's server. */
function owner() {
  const s = w.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const headers = {
    cookie: `${s.owner.sessionCookie}=${session}`,
    origin: PUBLIC_URL,
  };
  const url = (path: string) =>
    `${w.stack.base}/api/admin${path}${path.includes('?') ? '&' : '?'}project=test`;
  return {
    async get(path: string) {
      const res = await fetch(url(path), { headers });
      return { status: res.status, json: await res.json() };
    },
  };
}
