/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.* matchers are typed any */
/**
 * v2 E2 (ADR 0044): findings tracked across runs and the owner's acknowledgements (src/audits/store.ts), on a real
 * migrated database: new, still present (with "first seen"), gone (with when); gone and back; acknowledge, hide, and
 * reappear when the evidence changes; the config; runs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditConfigInputSchema } from '../../src/audits/config.js';
import { AuditStore, fingerprintOf, type StoredDraft } from '../../src/audits/store.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function open() {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'lkb-audits-')), 'bridge.db'));
  runMigrations(db);
  let t = 1_000_000;
  const now = () => (t += 1000);
  const ps = new ProjectStore(db, now);
  for (const id of ['prj', 'other']) ps.insert({ id, name: id, displayName: null, verifiedAt: null });
  return { store: new AuditStore(db, now), now };
}

const draft = (o: Partial<StoredDraft> & { key?: string } = {}): StoredDraft => {
  const { key, ...rest } = o;
  const base = {
    code: 'out_of_order' as const,
    category: 'ordering' as const,
    severity: 'warning' as const,
    pageId: 'p1',
    pageName: '[BSRC] One',
    pagePath: 'Things / One',
    documentId: null,
    blockId: null,
    message: 'out of order',
    evidence: { position: 2 },
    source: { kind: 'snapshot' as const, snapshotId: 'F1', takenAt: 1, ageMs: 5, baseSnapshotId: 'F1' },
    fix: null,
    ...rest,
  };
  return { ...base, fingerprint: fingerprintOf('prj', { ...base, key }) };
};

describe('findings across runs', () => {
  it('new, then still present (first seen kept), then gone (with when), then back as new', () => {
    const { store } = open();
    const r1 = store.startRun('prj', 'manual').id;
    const c1 = store.commit('prj', r1, [draft(), draft({ pageId: 'p2', key: 'x' })]);
    expect(c1).toMatchObject({ open: 2, new: 2, still: 0, gone: 0 });
    store.finishRun(r1, { state: 'succeeded', counts: c1 });
    const first = store.list('prj').findings.find((f) => f.pageId === 'p1')!;

    const r2 = store.startRun('prj', 'manual').id;
    const c2 = store.commit('prj', r2, [draft({ message: 'still out of order' })]);
    expect(c2).toMatchObject({ open: 1, new: 0, still: 1, gone: 1 });
    store.finishRun(r2, { state: 'succeeded', counts: c2 });
    const still = store.get('prj', first.id)!;
    expect(still).toMatchObject({
      state: 'open',
      firstSeenRun: r1,
      firstSeenAt: first.firstSeenAt,
      lastSeenRun: r2,
      message: 'still out of order',
    });
    const gone = store.list('prj', { state: 'gone' }).findings;
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ pageId: 'p2', state: 'gone', resolvedRun: r2 });
    expect(gone[0]!.resolvedAt).toBeGreaterThan(gone[0]!.firstSeenAt);
    expect(store.list('prj').total).toBe(1);

    // "New" is relative to the latest completed run.
    expect(store.list('prj', { onlyNew: true }).total).toBe(0);
    const r3 = store.startRun('prj', 'manual').id;
    const c3 = store.commit('prj', r3, [draft(), draft({ pageId: 'p2', key: 'x' })]);
    expect(c3).toMatchObject({ open: 2, new: 1, still: 1, gone: 0 });
    store.finishRun(r3, { state: 'succeeded', counts: c3 });
    const back = store.list('prj', { onlyNew: true }).findings;
    expect(back.map((f) => f.pageId)).toEqual(['p2']);
    expect(back[0]).toMatchObject({ state: 'open', firstSeenRun: r3, resolvedAt: null });
  });

  it('a failed run commits nothing, so nothing is marked resolved', () => {
    const { store } = open();
    const r1 = store.startRun('prj', 'manual').id;
    store.finishRun(r1, { state: 'succeeded', counts: store.commit('prj', r1, [draft()]) });
    const r2 = store.startRun('prj', 'manual').id;
    store.finishRun(r2, { state: 'failed', error: 'boom' });
    expect(store.list('prj').total).toBe(1);
    expect(store.latestRun('prj')!.id).toBe(r1);
  });

  it('projects are separate', () => {
    const { store } = open();
    const r = store.startRun('prj', 'manual').id;
    store.commit('prj', r, [draft()]);
    expect(store.list('other').total).toBe(0);
    expect(store.summary('other').open).toBe(0);
  });

  it('filters: category, code, severity, page path, page id, new; ordered errors first', () => {
    const { store } = open();
    const r = store.startRun('prj', 'manual').id;
    store.commit('prj', r, [
      draft(),
      draft({
        code: 'missing_target',
        category: 'references',
        severity: 'error',
        pageId: 'p2',
        pageName: '[BSRC] Two',
        pagePath: 'Places / Two',
        evidence: { t: 'x' },
        key: 'x',
      }),
      draft({
        code: 'unsupported_blocks',
        category: 'keep_regions',
        severity: 'info',
        pageId: 'p3',
        pagePath: 'Places / Three',
        evidence: { n: 1 },
      }),
    ]);
    store.finishRun(r, { state: 'succeeded' });
    expect(store.list('prj').findings.map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
    expect(store.list('prj', { category: ['references'] }).total).toBe(1);
    expect(store.list('prj', { code: ['out_of_order', 'unsupported_blocks'] }).total).toBe(2);
    expect(store.list('prj', { severity: ['error', 'info'] }).total).toBe(2);
    expect(store.list('prj', { page: 'places' }).total).toBe(2);
    expect(store.list('prj', { page: 'two' }).total).toBe(1);
    expect(store.list('prj', { pageId: 'p3' }).total).toBe(1);
    expect(store.list('prj', { onlyNew: true }).total).toBe(3);
    expect(store.list('prj', { limit: 2, offset: 2 }).findings).toHaveLength(1);
    const s = store.summary('prj');
    expect(s.byCategory.references).toEqual({ error: 1, warning: 0, info: 0 });
    expect(s.open).toBe(3);
    expect(store.codes('prj').map((c) => c.code)).toEqual([
      'missing_target',
      'out_of_order',
      'unsupported_blocks',
    ]);
  });
});

describe('acknowledging', () => {
  it('hides a finding while its evidence is the same, shows it again when the evidence changes, and keeps the reason', () => {
    const { store } = open();
    const r1 = store.startRun('prj', 'manual').id;
    store.commit('prj', r1, [draft()]);
    store.finishRun(r1, { state: 'succeeded' });
    const f = store.list('prj').findings[0]!;
    const acked = store.acknowledge('prj', f.id, 'The owner keeps this one on purpose.', 'owner')!;
    expect(acked.acknowledgement).toMatchObject({
      reason: 'The owner keeps this one on purpose.',
      by: 'owner',
    });
    expect(store.list('prj').total).toBe(0); // hidden from the default view
    expect(store.list('prj', { acknowledged: 'only' }).total).toBe(1);
    expect(store.list('prj', { acknowledged: 'include' }).total).toBe(1);
    expect(store.summary('prj')).toMatchObject({ open: 0, acknowledged: 1 });

    // The same evidence in the next run: still hidden.
    const r2 = store.startRun('prj', 'manual').id;
    const c2 = store.commit('prj', r2, [draft({ message: 'reworded, same evidence' })]);
    store.finishRun(r2, { state: 'succeeded', counts: c2 });
    expect(store.list('prj').total).toBe(0);
    expect(c2.acknowledged).toBe(1);

    // The evidence changes: it reappears, marked as having been acknowledged.
    const r3 = store.startRun('prj', 'manual').id;
    store.commit('prj', r3, [draft({ evidence: { position: 3 } })]);
    store.finishRun(r3, { state: 'succeeded' });
    const shown = store.list('prj').findings;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ acknowledgement: null, acknowledgementLapsed: true });
    expect(store.list('prj', { acknowledged: 'only' }).total).toBe(0);
  });

  it('survives the finding going and coming back with the same evidence; un-acknowledging shows it again', () => {
    const { store } = open();
    const r1 = store.startRun('prj', 'manual').id;
    store.commit('prj', r1, [draft()]);
    store.finishRun(r1, { state: 'succeeded' });
    const id = store.list('prj').findings[0]!.id;
    store.acknowledge('prj', id, 'fine', 'owner');
    const r2 = store.startRun('prj', 'manual').id;
    store.commit('prj', r2, []);
    store.finishRun(r2, { state: 'succeeded' });
    const r3 = store.startRun('prj', 'manual').id;
    store.commit('prj', r3, [draft()]);
    store.finishRun(r3, { state: 'succeeded' });
    expect(store.list('prj').total).toBe(0);
    expect(store.get('prj', id)!.acknowledgement).toMatchObject({ reason: 'fine' });
    store.unacknowledge('prj', id);
    expect(store.list('prj').total).toBe(1);
    expect(store.acknowledge('prj', 999, 'x', 'owner')).toBeNull();
  });
});

describe('config and runs', () => {
  it('stores the rules, the tag source and the settings; a field left out is kept; null restores the defaults', () => {
    const { store } = open();
    expect(store.config('prj')).toMatchObject({
      rules: null,
      tagSource: null,
      settings: { reportUnmatched: true, maxSnapshotAgeHours: 36 },
    });
    const rule = {
      id: 'core',
      name: 'Core',
      enabled: true,
      selectors: { referenceType: 'Character Core' },
      template: { templateName: 'Core' },
    };
    const input = auditConfigInputSchema.parse({
      rules: [rule],
      tagSource: { pageId: 'pg', documentId: 'dc' },
      settings: { reportUnmatched: false },
    });
    const { before, after } = store.setConfig('prj', input, 'owner');
    expect(before.rules).toBeNull();
    expect(after).toMatchObject({
      rules: [rule],
      tagSource: { pageId: 'pg', documentId: 'dc' },
      settings: { reportUnmatched: false, maxSnapshotAgeHours: 36 },
      updatedBy: 'owner',
    });
    store.setConfig('prj', auditConfigInputSchema.parse({ settings: { maxSnapshotAgeHours: 48 } }), 'owner');
    expect(store.config('prj')).toMatchObject({
      rules: [rule],
      settings: { reportUnmatched: false, maxSnapshotAgeHours: 48 },
    });
    store.setConfig('prj', auditConfigInputSchema.parse({ rules: null, tagSource: null }), 'owner');
    expect(store.config('prj')).toMatchObject({ rules: null, tagSource: null });
  });

  it('the rule schema refuses what it cannot use', () => {
    const base = { id: 'a', name: 'A', selectors: { kind: 'index' }, template: { templateName: 'T' } };
    expect(auditConfigInputSchema.safeParse({ rules: [base] }).success).toBe(true);
    expect(auditConfigInputSchema.safeParse({ rules: [{ ...base, selectors: {} }] }).success).toBe(false);
    expect(
      auditConfigInputSchema.safeParse({ rules: [{ ...base, selectors: { role: 'core' } }] }).success,
    ).toBe(false);
    expect(auditConfigInputSchema.safeParse({ rules: [{ ...base, template: {} }] }).success).toBe(false);
    expect(
      auditConfigInputSchema.safeParse({
        rules: [{ ...base, template: { templateId: 'x', templateName: 'y' } }],
      }).success,
    ).toBe(false);
    expect(auditConfigInputSchema.safeParse({ rules: [base, base] }).success).toBe(false);
    expect(auditConfigInputSchema.safeParse({ rules: [{ ...base, id: 'Bad Id' }] }).success).toBe(false);
    expect(auditConfigInputSchema.safeParse({ rules: [{ ...base, extra: 1 }] }).success).toBe(false);
  });

  it('runs record their duration and snapshot; a run a restart left running is closed as failed', () => {
    const { store } = open();
    const run = store.startRun('prj', 'snapshot');
    expect(store.runningRun('prj')!.id).toBe(run.id);
    const done = store.finishRun(run.id, {
      state: 'succeeded',
      snapshotId: 'F1',
      snapshotTakenAt: 5,
      snapshotAgeMs: 99,
      changeSnapshots: 2,
      newestSnapshotId: 'C2',
      pages: 10,
      stale: false,
      summary: 'ok',
    })!;
    expect(done).toMatchObject({
      state: 'succeeded',
      snapshotId: 'F1',
      snapshotAgeMs: 99,
      changeSnapshots: 2,
      pages: 10,
      trigger: 'snapshot',
    });
    expect(done.durationMs).toBeGreaterThan(0);
    const hung = store.startRun('prj', 'manual');
    store.closeStaleRuns();
    expect(store.run(hung.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('interrupted'),
    });
    expect(store.runs('prj').map((r) => r.id)).toEqual([hung.id, run.id]);
  });
});
