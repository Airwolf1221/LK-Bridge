/**
 * After the owner's run of the third review's checks (assumptions-r3), opt-in, WRITES then cleans up: what the fixes of
 * that run assume and no sandbox check confirms yet. Written for the owner; never run by an agent or in CI. On the
 * server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r4
 *
 * Each check reports PASS, FAIL or NOTED (a fact recorded, never a failure):
 *
 * - **Y1** X6's follow-up: do a BOARD's, a MAP's and a TIMELINE's own timestamps move on a content edit? For each, its
 *   `updatedAt` in getResource's document list and in getDocument, before and after an edit (a shape, a feature, an
 *   event), NOTED; PASS when the content read (getBoardContent, listFeatures, listEvents) shows the edit. The retag
 *   read-back now compares their content (a hash of what the snapshots take), so it is right either way; if the
 *   timestamps do move, a cheaper comparison is possible later.
 * - **Y2** X2's follow-up: the generic verify compares a label the bridge wrote: a mention with a custom label (in a
 *   paragraph and in a table cell) reads back with that label, and `compareStoredBlocks` finds the document as sent; a
 *   mention sent without a label reads back with one LegendKeeper filled in, which the verify ignores.
 * - **Y3** X5's follow-up: with one block id in two documents of one page, `getBlock` answers each document's own block
 *   (the bridge looks blocks up by document and id), and `updateBlock` on one leaves the other as it was.
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project with its own key, refused otherwise before any request. What it makes: one throwaway page
 * `lk-bridge r4 check <time>` with a page document, a second page document, a board, a map and a timeline; plain name,
 * no prefix, no status tag. Deleted at the end, even after a failure; the report names it if it must be deleted by hand.
 * Cost: about 25 writes and 30 reads. The steps are in `assumptions-r4.ts`; the ordinary suite runs them against the
 * mock in `test/sandbox-mock/assumptions-r4.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatAssumptionsR4Report, runAssumptionsR4 } from './assumptions-r4.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: what the fixes after the third review assume (Y1–Y3)',
  () => {
    // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
    const steps = sandboxRun({ name: 'assumptions-r4' });
    let runtime: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await runtime?.close();
      }
    }, steps.hookTimeoutMs);

    it('confirms each assumption on the real API, and cleans up', async () => {
      // Refuses (throws) before any request unless the project is a registered sandbox with a key.
      const target = resolveSandboxTarget(projectName);
      const sb = await steps.step('runtime', 'the sandbox runtime started', () =>
        createSoakRuntime({
          apiKey: target.apiKey,
          project: target.name,
          ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
        }),
      );
      runtime = sb;
      const items = await runAssumptionsR4(sb, steps);
      process.stdout.write(formatAssumptionsR4Report(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 900_000);
  },
);
