/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON replies and log lines */
/**
 * v3 F6a.1 (ADR 0076 amendment 1), against the mock LegendKeeper (a 300-page Arkona-shaped world, the real server and
 * admin API):
 *
 * - "Accept all": one request, ids in, the rows it changed out; ONE transaction (a failure part way writes nothing);
 *   bounded by REFTYPE_BULK_MAX (more ids refused, a filter takes the first that many); idempotent (again on the same
 *   ids touches nothing; after a partial run, only the rows still open);
 * - decisions are cheap: a decide reads no tree (the cached base) and returns its row;
 * - the report's cache: a reload reuses it; a decision invalidates only the rows; a tree change rebuilds the base;
 * - the page is paged (100 rows) with "Value contains" on the server;
 * - a dashboard action is logged at debug when it starts (never its body).
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../packs/retag-world.js';
import { observationFromResource } from '../../src/tree/index.js';
import { rowIdOf } from '../../src/packs/reftypes/service.js';
import { PAGE_QUERY, scaleWorld, type ScaleWorld } from './world.js';

let s: ScaleWorld;
const logs: string[] = [];
const svc = () => s.w.stack.runtime.referenceTypes;
const decisions = () => svc().store.decisions(PROJECT);
const page = async (q = PAGE_QUERY) => {
  const r = await s.http.get(q);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const accept = (body: Record<string, unknown>) =>
  s.http.post('/reference-types/bulk-accept', { ...body, confirm: true });
const undoAll = () => {
  for (const d of decisions()) svc().undo('owner', PROJECT, d.id);
};
const setMax = (n: number | null) =>
  s.w.stack.runtime.configSettings.live.set('REFTYPE_BULK_MAX', n, 'test', Date.now());

beforeAll(async () => {
  s = await scaleWorld({
    pages: 300,
    snapshot: false,
    logStream: new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(
          ...chunk
            .toString('utf8')
            .split('\n')
            .filter((l) => l !== ''),
        );
        cb();
      },
    }),
  });
}, 120_000);
afterAll(async () => s?.close());

describe('Accept all: one request, ids in, rows out', () => {
  it('accepts exactly the rows named, returns them as they now stand, and writes one audit row each', async () => {
    const p = await page();
    expect(p.confident.count).toBeGreaterThan(20);
    expect(p.bulkMax).toBe(500);
    const ids: string[] = p.confident.ids.slice(0, 7);
    const auditBefore = (
      s.w.stack.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'reftypes.decide'").get() as any
    ).n;
    const r = await accept({ ids });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.accepted).toBe(7);
    expect(r.json.skipped).toBe(0);
    expect(r.json).not.toHaveProperty('report');
    expect((r.json.rows as any[]).map((x) => x.id).sort()).toEqual([...ids].sort());
    for (const row of r.json.rows as any[]) {
      expect(row.status).toBe('mapped');
      expect(row.decision).toMatchObject({ action: 'map', via: 'bulk', target: row.suggestion.value });
      expect(row.id).toBe(rowIdOf(row.value, row.category));
    }
    expect(decisions()).toHaveLength(7);
    const auditAfter = (
      s.w.stack.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'reftypes.decide'").get() as any
    ).n;
    expect(auditAfter - auditBefore).toBe(7);
    // The page now offers the rest only.
    expect((await page()).confident.count).toBe(p.confident.count - 7);
    undoAll();
  });

  it('is ONE transaction: a failure part way writes no decision and no audit row', async () => {
    const p = await page();
    const ids: string[] = p.confident.ids.slice(0, 10);
    const store = svc().store;
    const insert = store.insert.bind(store);
    let n = 0;
    (store as any).insert = (d: any) => {
      if (++n === 6) throw new Error('injected failure on the sixth row');
      return insert(d);
    };
    try {
      const r = await accept({ ids });
      expect(r.status).toBe(500);
    } finally {
      (store as any).insert = insert;
    }
    expect(decisions()).toHaveLength(0);
  });

  it('is bounded by REFTYPE_BULK_MAX: more ids are refused, a filter takes the first that many', async () => {
    setMax(5);
    try {
      const p = await page();
      expect(p.bulkMax).toBe(5);
      const tooMany = await accept({ ids: p.confident.ids.slice(0, 6) });
      expect(tooMany.status).toBe(413);
      expect(tooMany.json.error.code).toBe('BULK_TOO_LARGE');
      expect(decisions()).toHaveLength(0);
      const byFilter = await accept({});
      expect(byFilter.status).toBe(200);
      expect(byFilter.json.accepted).toBe(5);
      expect(byFilter.json.remaining).toBe(p.confident.count - 5);
      expect(byFilter.json.max).toBe(5);
    } finally {
      setMax(null);
      undoAll();
    }
  });

  it('is idempotent: again on the same ids touches nothing; after a partial run, only the rows still open', async () => {
    const p = await page();
    const all: string[] = p.confident.ids;
    // The 24 November case: most rows decided before the hang, a handful left.
    const first = await accept({ ids: all.slice(0, all.length - 5) });
    expect(first.json.accepted).toBe(all.length - 5);
    const kept = new Map(decisions().map((d) => [d.id, d.at]));
    const again = await accept({ ids: all });
    expect(again.json.accepted).toBe(5);
    expect(again.json.skipped).toBe(all.length - 5);
    expect(new Set((again.json.skippedRows as any[]).map((x) => x.reason))).toEqual(
      new Set(['already_decided']),
    );
    // The decisions made before were not touched.
    for (const d of decisions()) if (kept.has(d.id)) expect(d.at).toBe(kept.get(d.id));
    expect(decisions()).toHaveLength(all.length);
    const third = await accept({ ids: all });
    expect(third.json.accepted).toBe(0);
    expect(decisions()).toHaveLength(all.length);
    // An id no row has: skipped, said why.
    const unknown = await accept({ ids: ['rtr_0000000000000000'] });
    expect(unknown.json.skippedRows).toEqual([
      { id: 'rtr_0000000000000000', value: null, category: null, reason: 'not_in_use' },
    ]);
    undoAll();
  });
});

describe('decisions are cheap', () => {
  it('a decide reads no tree (the cached base) and returns its row, not a report', async () => {
    const p = await page();
    const row = (p.report.rows as any[]).find(
      (r) => r.status === 'open' && r.suggestion.kind === 'suggested',
    );
    const q = s.w.stack.runtime.tree.queries as any;
    const calls = { pageScan: 0, kinds: 0, node: 0 };
    const orig = { pageScan: q.pageScan, kinds: q.kinds, node: q.node };
    q.pageScan = (...a: unknown[]) => (calls.pageScan++, orig.pageScan.apply(q, a));
    q.kinds = (...a: unknown[]) => (calls.kinds++, orig.kinds.apply(q, a));
    q.node = (...a: unknown[]) => (calls.node++, orig.node.apply(q, a));
    try {
      const r = await s.http.post('/reference-types/decide', {
        value: row.value,
        category: row.category,
        action: 'accept',
        confirm: true,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.row).toMatchObject({ id: row.id, status: 'mapped' });
      expect(r.json).not.toHaveProperty('report');
    } finally {
      Object.assign(q, orig);
    }
    expect(calls).toEqual({ pageScan: 0, kinds: 0, node: 0 });
    undoAll();
  });
});

describe('the report’s cache', () => {
  it('a reload reuses it; a decision rebuilds only the rows; a tree change rebuilds the base', async () => {
    await page();
    const c0 = svc().cacheState(PROJECT);
    expect(c0.base).not.toBeNull();
    const q = s.w.stack.runtime.tree.queries as any;
    let scans = 0;
    const orig = q.pageScan;
    q.pageScan = (...a: unknown[]) => (scans++, orig.apply(q, a));
    try {
      await page();
      await page();
      expect(scans).toBe(0);
      expect(svc().cacheState(PROJECT)).toEqual(c0);
      // A decision: the rows change, the base does not.
      const p = await page();
      await accept({ ids: p.confident.ids.slice(0, 1) });
      await page();
      const c1 = svc().cacheState(PROJECT);
      expect(c1.base).toBe(c0.base);
      expect(c1.rows).not.toBe(c0.rows);
      expect(scans).toBe(0);
      // A tree change (a page's Reference Type edited and read back): the base is rebuilt, the new value counted.
      const r = s.w.repo.res.get('scp00000')!;
      s.w.repo.outside.setRow(r.id, 'Reference Type', 'Shared Character Core');
      const tree = s.w.stack.runtime.tree;
      const obs = observationFromResource(s.w.repo.resourceView(s.w.repo.live(r.id)!));
      tree.store.applyObservation(
        { projectId: PROJECT, rootId: 'airepo01', settings: tree.settings(PROJECT), by: 'check' },
        obs!,
        Date.now() * 1000 + 1,
      );
      const after = await page('/reference-types?status=open&limit=100&value=Shared%20Character%20Core');
      expect(scans).toBe(1);
      expect(svc().cacheState(PROJECT).base).not.toBe(c0.base);
      expect((after.report.rows as any[]).map((x) => [x.value, x.count])).toEqual([
        ['Shared Character Core', 1],
      ]);
    } finally {
      q.pageScan = orig;
      undoAll();
    }
  });
});

describe('the page', () => {
  it('is paged (100 rows a page) and filters "Value contains" on the server', async () => {
    const a = await page('/reference-types?limit=100');
    expect(a.report.rows.length).toBe(100);
    expect(a.report.totalRows).toBeGreaterThan(100);
    const b = await page('/reference-types?limit=100&offset=100');
    expect(b.report.rows[0].id).not.toBe(a.report.rows[0].id);
    const f = await page('/reference-types?limit=100&value=historical');
    expect((f.report.rows as any[]).every((r) => r.value.toLowerCase().includes('historical'))).toBe(true);
    expect(f.confident.ids.length).toBe(f.confident.count);
  });

  it('a dashboard action is logged at debug when it starts (method and path, never the body)', async () => {
    const p = await page();
    logs.length = 0;
    await accept({ ids: p.confident.ids.slice(0, 1) });
    const started = logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request started');
    expect(started).toEqual([
      expect.objectContaining({ level: 20, method: 'POST', url: '/api/admin/reference-types/bulk-accept' }),
    ]);
    expect(JSON.stringify(started)).not.toContain('rtr_');
    undoAll();
  });
});
