/**
 * v3 F4b (ADR 0064), opt-in, WRITES then cleans up: the consistency check and "Pick the right value" end to end on the
 * real API. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- consistency-f4b
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and setting
 * packs from the bridge's database (as the write-scope rehearsal does: `copyBridgeState`), so the Arkona pack attached to
 * the test world and its consistency rules apply; it never writes to the bridge's database and never reads another
 * project. Each step reports PASS, FAIL or NOTED:
 *
 * - **F1** the calendar: the chronology's calendar read (one request), as the chronology tools keep it;
 * - **F2** two pages that restate one birth differently: a throwaway Character Core `[BSRC] F4b Probe <time> - Character
 *   Core` (Temporal Scope "Born Camue 1st, 4A 100") and a plain page saying "F4b Probe <time> was born on Camue 1st, 4A
 *   103.", under one plain throwaway index `lk-bridge f4b check <time>`. They are made with the sandbox's RAW client
 *   (the governor paces and counts them; no job, proposal or guard of the bridge is involved), as the assumptions checks
 *   make theirs: the Core is canon, which the bridge's governed route rightly refuses to make (the owner's sandbox run of
 *   20 November 2026). A tree sweep then shows them to the bridge;
 * - **F3** a full snapshot, then `arkona_consistency` for the probe: one Contradictory finding, the Core's value first;
 * - **F4** the owner's pick of the Core's value: ONE proposal with one item (the restating page), the Core untouched;
 * - **F5** approved, its job succeeds, and the page read live says "Camue 1st, 4A 100" in that sentence, the rest as it
 *   was; the Core's Temporal Scope is unchanged;
 * - **F6** the check run again over the job's change snapshot finds the pages agreeing.
 *
 * Clean-up: the throwaway index is deleted with everything under it (cascade), with the raw client, even after a failure;
 * the report names it if it must be deleted by hand. Cost: a full snapshot of the test world (its pages' reads), about 12 writes and 15 other
 * reads. The steps are in `consistency-f4b.ts`; the ordinary suite runs them against the mock in
 * `test/sandbox-mock/consistency-f4b.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { formatConsistencyReport, runConsistencyCheck } from './consistency-f4b.js';
import { rawLk } from './f4b-probe.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: the consistency check and the owner’s pick (F4b, F1–F6)',
  () => {
    it('finds a birth restated differently, proposes the owner’s pick, applies it on approval, and cleans up', async () => {
      // Refuses (throws) before any request unless the project is a registered sandbox with a key.
      const target = resolveSandboxTarget(projectName);
      const sb = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const raw = rawLk({
          lk: sb.lk,
          projectId: sb.projectId,
          apiKey: target.apiKey,
          ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
        });
        const items = await runConsistencyCheck(sb, raw, {
          bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        });
        process.stdout.write(formatConsistencyReport(items));
        expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
      } finally {
        await sb.close();
      }
    }, 1_800_000);
  },
);
