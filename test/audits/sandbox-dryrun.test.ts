/**
 * v2 E2: the audits sandbox script (test/sandbox/audits.ts) run against the mock (no real LegendKeeper): it sets up its page,
 * snapshots it with the templates, audits it with no request, splits a paragraph through a proposal (the nested one is a NOTED
 * fact), checks the finding is gone after the next snapshot, and cleans up.
 *
 * CR-2026-11-R4 (the owner's request S): through the same runtime and harness as the owner's run (`createSoakRuntime`
 * pointed at the faithful mock, with the world's asset and upload hosts: test/sandbox-mock/hosts.ts; its own temporary
 * database and snapshot store), and every item must pass: a FAIL or an INCONCLUSIVE fails the build with the whole
 * report printed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAuditsReport, runAuditsSandbox } from '../sandbox/audits.js';
import { makeFaithful } from '../sandbox-mock/faithful.js';
import { expectEveryItemPasses, type OnMock } from '../sandbox-mock/harness.js';
import { sandboxOnMockWithHosts } from '../sandbox-mock/hosts.js';
import { auditsWorld, type AuditsWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000 });

let w: AuditsWorld | undefined;
let on: OnMock | undefined;
afterEach(async () => {
  await on?.close();
  await w?.close();
  on = undefined;
  w = undefined;
});

describe('the audits sandbox script (dry run against the mock)', () => {
  it('every item passes (F2 noted), and it leaves nothing behind', async () => {
    w = makeFaithful(await auditsWorld());
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: w.assetHosts });
    // The real run's target (test/sandbox/audits.test.ts): the sandbox runtime, its database and its counters.
    const report = await runAuditsSandbox(
      { runtime: on.sb.runtime, db: on.sb.db, projectId: on.sb.projectId, counters: on.sb.counters },
      { wait: { waitMs: 5_000, maxWaits: 30 } },
    );
    const text = formatAuditsReport(report, on.sb.counters);
    expectEveryItemPasses(report.findings, text);
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    for (const id of ['setup', 'T', 'A', 'F1', 'R', 'cleanup'])
      expect(byId[id]?.verdict, `${id}: ${byId[id]?.detail}\n${text}`).toBe('pass');
    // The nested paragraph is a fact to verify on the real API, noted either way.
    expect(byId.F2?.verdict, `${byId.F2?.detail}\n${text}`).toBe('noted');
    const live = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge audits /.test(r.name),
    );
    expect(
      live.map((r) => r.name),
      text,
    ).toEqual([]);
  });
});
