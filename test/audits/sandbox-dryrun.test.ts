/**
 * v2 E2: the audits sandbox script (test/sandbox/audits.ts) run against the mock (no real LegendKeeper): it sets up its page,
 * snapshots it with the templates, audits it with no request, splits a paragraph through a proposal (the nested one is a NOTED
 * fact), checks the finding is gone after the next snapshot, and cleans up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAuditsReport, runAuditsSandbox } from '../sandbox/audits.js';
import { newCounters } from '../sandbox/soak.js';
import { PROJECT } from '../tools/helpers.js';
import { auditsWorld, type AuditsWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000 });

let w: AuditsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('the audits sandbox script (dry run against the mock)', () => {
  it('runs every check and leaves nothing behind', async () => {
    w = await auditsWorld();
    const calls = w.stack.mock.calls;
    const counters = Object.defineProperties(newCounters(), {
      reads: { get: () => calls.filter((c) => c.method === 'GET').length },
      writes: { get: () => calls.filter((c) => c.method !== 'GET').length },
    });
    const report = await runAuditsSandbox(
      { runtime: w.stack.runtime, db: w.stack.db, projectId: PROJECT, counters },
      { wait: { waitMs: 5_000, maxWaits: 30 } },
    );
    process.stdout.write(formatAuditsReport(report, counters));
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    for (const id of ['setup', 'T', 'A', 'F1', 'R', 'cleanup'])
      expect(byId[id]?.verdict, `${id}: ${byId[id]?.detail}`).toBe('pass');
    // The nested paragraph is a fact to verify on the real API, noted either way (the mock only knows top-level blocks).
    expect(byId.F2?.verdict, byId.F2?.detail).toBe('noted');
    const live = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge audits /.test(r.name),
    );
    expect(live.map((r) => r.name)).toEqual([]);
  });
});
