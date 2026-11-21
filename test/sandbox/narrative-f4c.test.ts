/**
 * v3 F4c (ADR 0065), opt-in, WRITES then cleans up: the narrative tools end to end on the real API. Written for the
 * owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- narrative-f4c
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`, as the write-scope rehearsal does), so the APPROVED Arkona pack version
 * `arkona-2026-11-20-f4c` or later (its narrative rules) applies; it never writes to the bridge's database. The tools are called
 * as the MCP server calls them, for a temporary write-scope principal with the rails off. Each step reports PASS or FAIL:
 *
 * - **C1** the chronology's calendar, kept (copied from the bridge's database) or read now (ADR 0064 amendment 2);
 * - **N1** Narratives is found by name; Main CANON is found, or made (a plain index, with the sandbox's RAW client, as
 *   the consistency-f4b check makes its probe: the audit's "Propose a fix" is the owner's route on Arkona);
 * - **N2** `arkona_story_create`: a throwaway story `lk-bridge f4c check <time>` with one act (its Story Map first, its
 *   act index and Act Map);
 * - **N3** two Chapter Plans (gate closed) and two chapters (`arkona_chapter_save`), each read back word for word, its
 *   dateline first;
 * - **N4** `arkona_chapter_insert` at 2: chapter 2 becomes 3, plan 2 becomes 3, a new Chapter 2 Plan: names and Chapter
 *   Number fields read back live;
 * - **N5** the story's pages snapshotted first (the chapter tools read through the snapshots; R4.1: never the test
 *   world), `arkona_chapter_check` on chapter 1, then an audit: the story's narrative findings listed.
 *
 * Clean-up: the throwaway story deleted with everything under it, and Main CANON if this run made it, with the raw
 * client, even after a failure or a step's timeout, and again in this file's `afterAll` (its own timeout); the report
 * names what must be deleted by hand. Cost: about 60 writes and 60 reads (N5 snapshots the story's own pages, never the
 * test world: R4.1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatNarrativeReport, runNarrativeCheck } from './narrative-f4c.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the narrative tools (F4c, N1–N5)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'narrative-f4c' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('makes a story, saves and renumbers chapters, checks and audits them, and cleans up', async () => {
    const target = resolveSandboxTarget(projectName);
    const started = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    sb = started;
    const raw = rawLk({
      lk: started.lk,
      projectId: started.projectId,
      apiKey: target.apiKey,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    const items = await runNarrativeCheck(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatNarrativeReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
