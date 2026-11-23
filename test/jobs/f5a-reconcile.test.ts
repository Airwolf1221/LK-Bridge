/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H10): unknown write outcomes are
 * always reconciled. Each outcome on mocks (applied, not_applied, superseded), a write that stays unknown becoming the
 * audits' finding, the start-up sweep, the migration (a fifth outcome, every row kept), and journal entry 3897 of
 * 19 November 2026 (Arkona) modelled as a fixture: it settles as superseded without a read.
 */
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { WriteJournal, journalLookup } from '../../src/jobs/journal.js';
import { OutcomeReconciler, RECONCILE_DELAYS_MS } from '../../src/jobs/reconcile.js';
import { BridgeLkError } from '../../src/lk/errors.js';
import { FakeClock, flushMicrotasks } from '../../src/lk/governor/clock.js';
import { ProjectStore } from '../../src/projects/index.js';
import { writesCheck } from '../../src/audits/checks/writes.js';
import type { AuditContext } from '../../src/audits/context.js';
import type { OpParams } from '../../src/jobs/types.js';

const PROJECT = 'proj_arkona_fixture';
const notFound = () =>
  new BridgeLkError({
    message: 'gone',
    status: 404,
    code: 'NOT_FOUND',
    retryable: false,
    classification: 'user_fixable',
  });

function world(
  o: { reads?: (opId: string, params: OpParams) => unknown; steps?: Map<string, OpParams> } = {},
) {
  const db: Db = openDatabase(':memory:');
  runMigrations(db);
  new ProjectStore(db).insert({ id: PROJECT, name: 'arkona', displayName: null, verifiedAt: null });
  const clock = new FakeClock(Date.parse('2026-11-23T08:00:00Z'));
  const journal = new WriteJournal(db, () => clock.now());
  const reads: { opId: string; params: OpParams }[] = [];
  const rec = new OutcomeReconciler({
    db,
    journal,
    clock,
    read: (_p, opId, params) => {
      reads.push({ opId, params });
      try {
        return Promise.resolve(o.reads ? o.reads(opId, params) : undefined);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    stepParams: (_p, jobId, stepNo) => o.steps?.get(`${jobId}#${stepNo}`) ?? null,
  });
  const write = (
    e: Partial<Parameters<WriteJournal['record']>[0]> & { opId: string },
    outcome: 'applied' | 'unknown' | 'not_applied' = 'unknown',
  ) => {
    const id = journal.record({
      projectId: PROJECT,
      risk: 'destructive',
      targetKind: 'document',
      ...e,
    });
    journal.setOutcome(id, outcome);
    return id;
  };
  const advance = async (ms: number) => {
    await clock.advance(ms);
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  };
  return { db, clock, journal, rec, reads, write, advance };
}

const blocks = [
  { kind: 'heading', level: 2, content: [{ text: 'Rashad’s Freely Chosen Immortality' }] },
  { kind: 'paragraph', content: [{ text: 'He chose it freely.' }] },
];

describe('H10: each outcome, on mocks', () => {
  it('applied: the version moved and the content matches what the job sent (its step params, not the journal copy)', async () => {
    const steps = new Map<string, OpParams>([
      ['job_a#2', { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } }],
    ]);
    const w = world({
      steps,
      reads: () => ({ version: 'v2', blocks: blocks.map((b, i) => ({ id: `b${i}`, ...b })) }),
    });
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      jobId: 'job_a',
      stepNo: 2,
      resourceId: 'r1',
      documentId: 'd1',
      targetId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, bodyOmitted: true },
    });
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'applied', settledBy: 'bridge' });
    expect(journalLookup(w.db, PROJECT, { id })[0]!.outcome).toBe('applied');
    expect(w.reads).toHaveLength(1);
    expect(w.reads[0]!.opId).toBe('getDocumentBlocks');
    expect(w.rec.get(id)!.reason).toMatch(
      /the version moved \(v1 → v2\) and the content matches what the job sent/,
    );
  });

  it('not_applied: the version is unchanged', async () => {
    const w = world({
      reads: () => ({ version: 'v1', blocks: [{ id: 'x', kind: 'paragraph', content: [] }] }),
    });
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r1',
      documentId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } },
    });
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'not_applied' });
    expect(journalLookup(w.db, PROJECT, { id })[0]!.outcome).toBe('not_applied');
  });

  it('not_applied for an entity without a version: it still holds its pre-image, not what was sent', async () => {
    const w = world({ reads: () => ({ id: 'r1', name: 'Old', tags: ['CANON'] }) });
    const id = w.write({
      opId: 'updateResource',
      targetKind: 'resource',
      resourceId: 'r1',
      targetId: 'r1',
      params: { path: { resourceId: 'r1' }, body: { name: 'New' } },
      preImage: { id: 'r1', name: 'Old', tags: ['CANON'] },
    });
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'not_applied' });
  });

  it('applied for a delete: the entity is gone', async () => {
    const w = world({
      reads: () => {
        throw notFound();
      },
    });
    const id = w.write({
      opId: 'deleteResource',
      targetKind: 'resource',
      resourceId: 'r9',
      targetId: 'r9',
      params: { path: { resourceId: 'r9' } },
    });
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ outcome: 'applied' });
  });

  it('superseded: later applied writes to the same document exist; no read is made', async () => {
    const w = world({ reads: () => ({ version: 'v9', blocks: [] }) });
    const id = w.write({ opId: 'replaceDocumentBlocks', resourceId: 'r1', documentId: 'd1', version: 'v1' });
    const later = w.write(
      { opId: 'replaceDocumentBlocks', resourceId: 'r1', documentId: 'd1', version: 'v2' },
      'applied',
    );
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'superseded' });
    expect(w.rec.get(id)!.evidence).toMatchObject({ later: [later] });
    expect(journalLookup(w.db, PROJECT, { id })[0]!.outcome).toBe('superseded');
    expect(w.reads).toHaveLength(0);
  });

  it('a later write to ANOTHER document of the page does not supersede it', async () => {
    const w = world({ reads: () => ({ version: 'v1', blocks: [] }) });
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r1',
      documentId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } },
    });
    w.write({ opId: 'replaceDocumentBlocks', resourceId: 'r1', documentId: 'd2', version: 'x' }, 'applied');
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)!.outcome).toBe('not_applied');
  });

  it('the job settling it first wins (never overwritten)', async () => {
    const w = world({ reads: () => ({ version: 'v1', blocks: [] }) });
    const id = w.write({ opId: 'replaceDocumentBlocks', resourceId: 'r1', documentId: 'd1', version: 'v1' });
    w.rec.start();
    w.journal.setOutcome(id, 'applied');
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'applied', settledBy: 'job' });
    expect(w.reads).toHaveLength(0);
  });
});

describe('H10: a write that stays unknown', () => {
  it('reads back with back-off for about five minutes, then is unresolved and becomes a writes finding', async () => {
    // The version moved, but the content is neither what was sent nor what was there: an edit outside the bridge.
    const w = world({
      reads: () => ({
        version: 'v5',
        blocks: [{ id: 'z', kind: 'paragraph', content: [{ text: 'other' }] }],
      }),
    });
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r1',
      documentId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } },
      preImage: { blocks: [{ id: 'p', kind: 'paragraph', content: [{ text: 'before' }] }] },
      operation: {
        tool: 'write_page',
        mode: 'replace_section',
        section: 'Rashad’s Freely Chosen Immortality',
      },
    });
    w.rec.start();
    const total = RECONCILE_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(240_000);
    expect(total).toBeLessThanOrEqual(360_000);
    for (const d of RECONCILE_DELAYS_MS) await w.advance(d);
    expect(w.reads).toHaveLength(RECONCILE_DELAYS_MS.length);
    expect(w.rec.get(id)).toMatchObject({ state: 'unresolved', outcome: 'unknown' });
    expect(journalLookup(w.db, PROJECT, { id })[0]!.outcome).toBe('unknown');
    const items = w.rec.unresolved(PROJECT);
    expect(items).toHaveLength(1);
    const findings = writesCheck({ unknownWrites: items } as unknown as AuditContext);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'write_outcome_unknown',
      pageId: 'r1',
      documentId: 'd1',
      evidence: {
        journalId: id,
        operation: 'replaceDocumentBlocks',
        preImage: { blocks: [{ id: 'p', kind: 'paragraph', content: [{ text: 'before' }] }] },
        intendedChange: { body: { blocks } },
        highLevel: { tool: 'write_page', mode: 'replace_section' },
      },
    });
  });

  it('a read that fails is retried at the next step of the back-off, not judged', async () => {
    let n = 0;
    const w = world({
      reads: () => {
        if (n++ === 0) throw new Error('budget');
        return { version: 'v1', blocks: [] };
      },
    });
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r1',
      documentId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } },
    });
    w.rec.start();
    await w.advance(RECONCILE_DELAYS_MS[0]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'pending', attempts: 1 });
    await w.advance(RECONCILE_DELAYS_MS[1]!);
    expect(w.rec.get(id)).toMatchObject({ state: 'settled', outcome: 'not_applied', attempts: 2 });
  });
});

describe('H10: the start-up sweep', () => {
  it('settles every unknown entry left from before; an unresolved one is tried once more', async () => {
    const w = world({ reads: () => ({ version: 'v1', blocks: [] }) });
    const a = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r1',
      documentId: 'd1',
      version: 'v1',
      params: { path: { resourceId: 'r1', documentId: 'd1' }, body: { blocks } },
    });
    const b = w.write({
      opId: 'replaceDocumentBlocks',
      resourceId: 'r2',
      documentId: 'd2',
      version: 'v1',
      params: { path: { resourceId: 'r2', documentId: 'd2' }, body: { blocks } },
    });
    w.db
      .prepare(
        "INSERT INTO write_reconciliations (journal_id, project_id, state, outcome, attempts, first_at) VALUES (?, ?, 'unresolved', 'unknown', 5, 0)",
      )
      .run(b, PROJECT);
    expect(w.rec.sweep()).toBe(2);
    await w.advance(1);
    expect(w.rec.get(a)).toMatchObject({ state: 'settled', outcome: 'not_applied', settledBy: 'bridge' });
    expect(w.rec.get(b)).toMatchObject({ state: 'settled', outcome: 'not_applied' });
  });
});

describe('H10: journal entry 3897 (Arkona, 19 November 2026), as a fixture', () => {
  it('settles as superseded: entries 5607, 7022, 7323 and 7377 to the same document were applied after it', async () => {
    const w = world({ reads: () => ({ version: 'later', blocks: [] }) });
    // The journal continues from 3896, as Arkona's did.
    w.db
      .prepare(
        "INSERT INTO sqlite_sequence (name, seq) SELECT 'write_journal', 3896 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'write_journal')",
      )
      .run();
    w.db.prepare("UPDATE sqlite_sequence SET seq = 3896 WHERE name = 'write_journal'").run();
    const id = w.write({
      opId: 'replaceDocumentBlocks',
      principalId: 'oauth_chatgpt_removed',
      profile: 'chatgpt',
      resourceId: 'b9676687afa29604fb84259a',
      documentId: 'v4t6qncz',
      targetId: 'v4t6qncz',
      version: '6851087e63e8cf4f',
      params: { path: { resourceId: 'b9676687afa29604fb84259a', documentId: 'v4t6qncz' }, bodyOmitted: true },
      operation: {
        tool: 'write_page',
        mode: 'replace_section',
        section: 'Rashad’s Freely Chosen Immortality',
        baseVersion: '6851087e63e8cf4f',
      },
    });
    expect(id).toBe(3897);
    for (const later of [5607, 7022, 7323, 7377]) {
      w.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'write_journal'").run(later - 1);
      const n = w.write(
        {
          opId: 'replaceDocumentBlocks',
          resourceId: 'b9676687afa29604fb84259a',
          documentId: 'v4t6qncz',
          version: `v${later}`,
        },
        'applied',
      );
      expect(n).toBe(later);
    }
    // Before F5a's reconciler it had sat unknown for four days; at start-up it is swept.
    w.rec.start();
    await w.advance(1);
    expect(w.rec.get(3897)).toMatchObject({
      state: 'settled',
      outcome: 'superseded',
      evidence: { later: [5607, 7022, 7323, 7377] },
    });
    expect(journalLookup(w.db, PROJECT, { id: 3897 })[0]!.outcome).toBe('superseded');
    expect(w.reads).toHaveLength(0);
  });
});

describe('H10: the migration', () => {
  it('keeps every journal row and target, continues the sequence, and allows the fifth outcome', () => {
    const w = world();
    const id = w.write(
      { opId: 'createManyResources', targetKind: 'resource', targets: ['a', 'b'] },
      'applied',
    );
    expect(journalLookup(w.db, PROJECT, { targetId: 'b' }).map((e) => e.id)).toEqual([id]);
    w.db.prepare("UPDATE write_journal SET outcome = 'superseded' WHERE id = ?").run(id);
    expect(() =>
      w.db.prepare("UPDATE write_journal SET outcome = 'nonsense' WHERE id = ?").run(id),
    ).toThrow();
    const indexes = (
      w.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'write_journal'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['write_journal_project', 'write_journal_document', 'write_journal_outcome']),
    );
  });
});
