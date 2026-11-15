/**
 * v2 E2 (ADR 0044): the chronology check's findings folded into the audits' findings view as their own category, with
 * D1.1's "Propose a fix" kept (the chronology module's own, through the audits' button). The audit itself reads no
 * LegendKeeper: the check is a separate job with its own schedule, and the audit takes its last stored run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Audits } from '../../src/audits/index.js';
import type { SnapshotSource } from '../../src/audits/reader.js';
import type { Manifest } from '../../src/snapshots/manifest.js';
import { PROJECT } from '../tools/helpers.js';
import { chronologyWorld, type ChronologyWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: ChronologyWorld;
let audits: Audits;
const FOURTH = 'Fourth Arkonan Age';

/**
 * A full snapshot of just the root and the chronology page, in memory: this world's tables are large, and what this test
 * is about is the fold-in, not the snapshot (the audits' own tests take real ones). Everything else is the real stack.
 */
const manifest: Manifest = {
  format: 'lk-bridge-snapshot',
  version: 1,
  id: '20261113T003000Z-full-chrono1',
  project: { id: PROJECT, name: 'test' },
  kind: 'full',
  takenAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  rootId: 'airepo01',
  complete: true,
  trigger: {},
  pages: [
    { id: 'airepo01', parentId: null, rank: null, name: 'AI REPOSITORY', kind: 'root' },
    { id: 'chrono01', parentId: 'airepo01', rank: 'a', name: '[BSRC] Universal Chronology', kind: 'bsrc' },
  ],
  library: null,
  counts: {
    pages: 2,
    pieces: 0,
    reads: 0,
    downloads: 0,
    newObjects: 0,
    newBytes: 0,
    logicalBytes: 0,
    missing: 0,
  },
};
const source: SnapshotSource = {
  fulls: () => [{ id: manifest.id, takenAt: Date.parse(manifest.takenAt) }],
  changesAfter: () => [],
  manifest: () => Promise.resolve(manifest),
  piece: () => Promise.resolve(null),
};

beforeAll(async () => {
  w = await chronologyWorld();
  const rt = w.stack.runtime;
  audits = new Audits({
    db: w.stack.db,
    snapshots: rt.snapshots,
    registry: rt.registry,
    chronology: rt.chronology,
    tree: rt.tree,
    engine: rt.engine,
    projectSettings: () => ({}),
    audit: (actor, action, target, before, after) =>
      rt.policy.store.audit(actor, action, target, before, after),
    now: () => Date.now(),
    source: () => source,
  });
});
afterAll(async () => w.close());

const rt = () => w.stack.runtime;
const chronologyFindings = (state: 'open' | 'gone' = 'open') =>
  audits.list(PROJECT, { category: ['chronology'], state, limit: 100 }).findings;

describe('the chronology fold-in', () => {
  it('says the chronology was never checked until its check has run', async () => {
    const first = await audits.run(PROJECT, 'manual');
    expect(first.state, first.summary).toBe('succeeded');
    expect(chronologyFindings()).toEqual([]);
    const notChecked = audits.list(PROJECT, { code: ['chronology_not_checked'] }).findings;
    expect(notChecked).toHaveLength(1);
    expect(notChecked[0]).toMatchObject({ category: 'audit', source: { kind: 'bridge' } });
  });

  it('folds in each finding of the last check with the check as its source; reads no LegendKeeper; keeps Propose a fix', async () => {
    // A timeline event deleted in the LegendKeeper app: its row now has no event.
    await rt().engine.run(
      'deleteEvent',
      { path: { resourceId: 'chrono01', documentId: w.ages[FOURTH]!.timeline, eventId: 'efour005' } },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    await rt().chronology.check(PROJECT, 'manual', 'P2');
    const check = rt().chronology.store.lastCheck(PROJECT)!;
    expect(check.findings.some((f) => f.kind === 'row_without_event')).toBe(true);

    const done = w.mark();
    const out = await audits.run(PROJECT, 'manual');
    expect(out.state, out.summary).toBe('succeeded');
    expect(done()).toMatchObject({ reads: 0, writes: 0 }); // the audit read nothing

    const found = chronologyFindings();
    expect(found.map((f) => f.code)).toContain('chronology_row_without_event');
    expect(found.length).toBe(check.findings.length);
    const row = found.find((f) => f.code === 'chronology_row_without_event')!;
    expect(row).toMatchObject({
      category: 'chronology',
      source: { kind: 'chronology-check', checkId: check.id },
    });
    expect(row.pageId).toBe('chrono01');
    expect(row.fix).toMatchObject({ kind: 'chronology_sync', args: { age: FOURTH } });
    expect(audits.list(PROJECT, { code: ['chronology_not_checked'] }).findings).toEqual([]);

    // "Propose a fix" goes through the chronology module's own (sync_timeline_event as ONE proposal), never applied.
    const before = w.liveEvents(w.ages[FOURTH]!.timeline).length;
    const r = await audits.proposeFix('owner', PROJECT, row.id);
    expect(r).toMatchObject({ status: 'proposal_captured', fix: 'chronology_sync' });
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(w.liveEvents(w.ages[FOURTH]!.timeline)).toHaveLength(before);
    await rt().policy.commands.approve('owner', r.proposalId);
    for (let i = 0; i < 400 && rt().policy.proposals.get(r.proposalId)!.state !== 'executed'; i++)
      await new Promise((x) => setTimeout(x, 20));
    expect(rt().policy.proposals.get(r.proposalId)!.state).toBe('executed');
    expect(w.liveEvents(w.ages[FOURTH]!.timeline)).toHaveLength(before + 1);

    // The check again, then the audit: that finding is gone.
    await rt().chronology.check(PROJECT, 'manual', 'P2');
    await audits.run(PROJECT, 'manual');
    expect(chronologyFindings().map((f) => f.code)).not.toContain('chronology_row_without_event');
    expect(chronologyFindings('gone').map((f) => f.code)).toContain('chronology_row_without_event');
  });

  it('v2 E5 hotfix: a count mismatch offers Propose a fix, routed through the chronology module', async () => {
    // The Main table says one more than the 4A table has (the test world's 337 against 336), edited in the app.
    const main = w.repo.blocks.get(w.mainDoc)! as { version: number; blocks: Record<string, unknown>[] };
    const table = main.blocks.find((b) => b.kind === 'table')!;
    const row = (table.children as Record<string, unknown>[]).find((r) => r.id === w.ages[FOURTH]!.mainRow)!;
    const para = ((row.children as Record<string, unknown>[])[1]!.children as Record<string, unknown>[])[0]!;
    const rows = w.rows(FOURTH).length;
    para.content = [{ text: String(rows + 1) }];
    main.version++;
    await rt().chronology.check(PROJECT, 'manual', 'P2');
    await audits.run(PROJECT, 'manual');
    const f = chronologyFindings().find((x) => x.code === 'chronology_count_mismatch')!;
    expect(f.fix).toMatchObject({ kind: 'chronology_count', args: { age: FOURTH } });
    const r = await audits.proposeFix('owner', PROJECT, f.id);
    expect(r).toMatchObject({ status: 'proposal_captured', fix: 'chronology_count' });
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(r.summary).toBe(
      `${FOURTH}: Main ${rows + 1} → ${rows} (table rows ${rows}; timeline events ${w.liveEvents(w.ages[FOURTH]!.timeline).length})`,
    );
    expect(w.count(FOURTH)).toBe(String(rows + 1)); // nothing written yet
    await rt().policy.commands.approve('owner', r.proposalId);
    for (let i = 0; i < 400 && rt().policy.proposals.get(r.proposalId)!.state !== 'executed'; i++)
      await new Promise((x) => setTimeout(x, 20));
    expect(rt().policy.proposals.get(r.proposalId)!.state).toBe('executed');
    expect(w.count(FOURTH)).toBe(String(rows));
    expect(
      rt()
        .policy.store.listAudit({ action: 'audits.propose_fix' })
        .some((a) => {
          const after = a.after as { fix?: string } | null;
          return after?.fix === 'chronology_count';
        }),
    ).toBe(true);
  });
});
