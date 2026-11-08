/**
 * Chunk 8, required change A: every successful write is journalled (operation, targets, principal, profile, approver,
 * job, time), not only destructive ones; pre-images stay with the destructive writes. The lookup pages newest first by
 * id and its filters use indexes, because the journal now grows with every write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { WriteJournal, journalLookup, pruneJournal } from '../../src/jobs/journal.js';
import type { JobOrigin } from '../../src/jobs/index.js';
import { harness, origin, settle, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const asAgent: JobOrigin = {
  ...origin,
  kind: 'mcp',
  tool: 'lk_api_write',
  principal: { principalId: 'pat_agent', profile: 'claude', label: 'Claude' },
};

describe('every write is journalled', () => {
  it('records creates, inserts and patches with who, what and when, and no pre-image', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', {
      blocks: [{ id: 'p1', kind: 'paragraph', content: [{ text: 'a' }] }],
    });
    const e = h.newEngine();
    const created = await settle(
      h,
      e,
      e.engine.run('createResource', { body: { name: 'New page' } }, { origin: asAgent }),
    );
    expect(created.error).toBeUndefined();
    const inserted = await settle(
      h,
      e,
      e.engine.run(
        'insertBlock',
        {
          path: { resourceId, documentId },
          body: { block: { kind: 'paragraph', content: [{ text: 'b' }] } },
        },
        { origin: asAgent },
      ),
    );
    expect(inserted.error).toBeUndefined();
    const patched = await settle(
      h,
      e,
      e.engine.run(
        'updateBlock',
        { path: { resourceId, documentId, blockId: 'p1' }, body: { content: [{ text: 'c' }] } },
        { origin: asAgent },
      ),
    );
    expect(patched.error).toBeUndefined();

    const entries = e.engine.queries.journalLookup({ principalId: 'pat_agent', includePreImage: true });
    expect(entries.map((x) => x.opId)).toEqual(['updateBlock', 'insertBlock', 'createResource']);
    for (const x of entries) {
      expect(x).toMatchObject({
        outcome: 'applied',
        principalId: 'pat_agent',
        profile: 'claude',
        approvedBy: null,
      });
      expect(typeof x.jobId).toBe('string');
      expect(x.at).toBeGreaterThan(0);
      expect(x.preImage).toBeNull();
    }
    // The created resource is the target (its client-chosen id), and also the resource the write touched.
    const create = entries.find((x) => x.opId === 'createResource')!;
    const newId = (created.value as { result: { id: string } }).result.id;
    expect(create.targetId).toBe(newId);
    expect(create.resourceId).toBe(newId);
    // An insert's target is the id LegendKeeper gave the new block.
    const insert = entries.find((x) => x.opId === 'insertBlock')!;
    expect(insert.documentId).toBe(documentId);
    expect(insert.targetId).toBe((inserted.value as { result: { id: string } }).result.id);
    // A patch names the block it changed.
    expect(entries.find((x) => x.opId === 'updateBlock')!.targetId).toBe('p1');
  });

  it('keeps the pre-image for destructive writes only, and marks a refused write not_applied', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', {
      blocks: [{ id: 'p1', kind: 'paragraph', content: [{ text: 'a' }] }],
    });
    const e = h.newEngine();
    await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId, documentId }, body: { blocks: [{ kind: 'paragraph', content: [] }] } },
        { origin: asAgent },
      ),
    );
    // LegendKeeper refuses the next write outright.
    h.mock.inject((c) => c.method === 'PATCH', { kind: 'status', status: 400, code: 'VALIDATION_ERROR' });
    await settle(
      h,
      e,
      e.engine.run('updateResource', { path: { resourceId }, body: { name: 'x' } }, { origin: asAgent }),
    );
    const all = e.engine.queries.journalLookup({ includePreImage: true });
    const replace = all.find((x) => x.opId === 'replaceDocumentBlocks')!;
    expect(replace.preImage).not.toBeNull();
    expect(e.engine.queries.journalLookup({ withPreImage: true }).map((x) => x.opId)).toContain(
      'replaceDocumentBlocks',
    );
    expect(e.engine.queries.journalLookup({ outcome: 'not_applied' }).map((x) => x.opId)).toEqual([
      'updateResource',
    ]);
  });
});

describe('the journal at volume', () => {
  const fresh = () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    let t = 1_000_000;
    const j = new WriteJournal(db, () => (t += 1000));
    return { db, j };
  };

  it('pages newest first with a before cursor, and finds every target of a multi-target write', () => {
    const { db, j } = fresh();
    for (let i = 0; i < 250; i++) {
      j.record({
        opId: i % 2 ? 'updateBlock' : 'createBlockRow',
        risk: 'safe',
        targetKind: 'block',
        targetId: `b${i}`,
        documentId: i % 5 === 0 ? 'd-five' : 'd-other',
        principalId: i % 3 === 0 ? 'pat_a' : 'grant_b',
        profile: i % 3 === 0 ? 'claude' : 'chatgpt',
      });
    }
    const batch = j.record({
      opId: 'createManyResources',
      risk: 'safe',
      targetKind: 'resource',
      targetId: 'rnew0000',
      targets: ['rnew0000', 'rnew1111', 'rnew2222'],
    });
    const pages: number[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = journalLookup(db, { limit: 100, ...(before !== undefined ? { before } : {}) });
      if (page.length === 0) break;
      pages.push(page.map((x) => x.id));
      before = page.at(-1)!.id;
    }
    expect(pages.map((p) => p.length)).toEqual([100, 100, 51]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(251);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // Filters combine with the cursor.
    const five = journalLookup(db, { documentId: 'd-five', limit: 20 });
    expect(five).toHaveLength(20);
    expect(journalLookup(db, { documentId: 'd-five', before: five.at(-1)!.id, limit: 100 })).toHaveLength(30);
    expect(journalLookup(db, { profile: 'claude', limit: 1000 })).toHaveLength(84);
    // Every created id finds the batch entry.
    for (const t of ['rnew0000', 'rnew1111', 'rnew2222']) {
      expect(journalLookup(db, { targetId: t }).map((x) => x.id)).toEqual([batch]);
    }
    // `since` becomes an id bound: the newest 10 entries were written in the last 10 seconds of the fake clock.
    const newest = journalLookup(db, { limit: 1 })[0]!;
    expect(journalLookup(db, { since: newest.at - 9_500, limit: 100 })).toHaveLength(10);
  });

  it('uses an index for filtered pages: no full scan, no sort', () => {
    const { db } = fresh();
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    for (const col of [
      'resource_id',
      'document_id',
      'principal_id',
      'profile',
      'target_id',
      'op_id',
      'job_id',
    ]) {
      const p = plan(
        `SELECT id FROM write_journal WHERE ${col} = ? AND id < ? ORDER BY id DESC LIMIT 100`,
        'x',
        1000,
      );
      expect(p, col).toMatch(/USING (COVERING )?INDEX/);
      if (col !== 'job_id') expect(p, col).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('prunes by age and size, and the targets of pruned entries go with them; upload keys are never stored', () => {
    const { db, j } = fresh();
    j.record({
      opId: 'createManyResources',
      risk: 'safe',
      targetKind: 'resource',
      targetId: 'r0',
      targets: ['r0', 'r1'],
    });
    j.record({
      opId: 'createImageAsset',
      risk: 'safe',
      targetKind: 'Assets',
      params: { body: { uploadKey: 'secret-upload-key', name: 'n' } },
    });
    expect(JSON.stringify(db.prepare('SELECT params FROM write_journal').all())).not.toContain(
      'secret-upload-key',
    );
    const r = pruneJournal(db, { retentionDays: 0, maxBytes: 1 }, 10_000_000);
    expect(r.removedByAge).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM write_journal_targets').get()).toEqual({ n: 0 });
  });
});
