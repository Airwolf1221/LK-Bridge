/**
 * CR-2026-11-R3, opt-in, WRITES then cleans up: what the code reviewed in the third review (renames, splits, retagging,
 * the block-id sweep, and this review's own fixes) assumes of LegendKeeper and no sandbox check confirms yet. Written
 * for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r3
 *
 * Each check reports PASS, FAIL or NOTED (a fact recorded, never a failure) with what LegendKeeper answered:
 *
 * - **X1** `updateAsset` renames an asset FOLDER (a rename renames a character's art folder: src/packs/rename/plan.ts),
 *   and `getAsset` and the folder listing answer the new name.
 * - **X2** a mention run inside a TABLE CELL reads back with its page (a rename reports table cells rather than editing
 *   them, ADR 0058 departures; the split moves tables verbatim): its `resourceId` kept, its custom label NOTED (kept, or
 *   dropped: LegendKeeper shows the page's current name).
 * - **X3** `assignBlockIds` on a document holding the SAME id twice (the block-id sweep, ADR 0056, and the split's
 *   refusal of such a page until the sweep has run): first whether LegendKeeper lets such a document be written at all
 *   (NOTED), then, if it does, whether `assignBlockIds` leaves every id unique and the content unchanged.
 * - **X4** a page's tags come back in the order written, and two spellings of one tag (`lkb-r3-a`, `LKB-R3-A`) are kept
 *   as written or folded (NOTED): the retag moves a status tag first by writing the array in order, and treats a second
 *   spelling of a status tag as a hold (CR-2026-11-R3, R3-06).
 * - **X5** block ids beyond split-ids: (a) the same id in two page documents of ONE page; (b) an id taken out of a
 *   document and written back later keeps that id (Revert of a split puts the source's blocks back with their ids).
 * - **X6** a document's `version` (getDocumentBlocks) moves on a content edit, and getResource's per-document
 *   `updatedAt`: present or not, and whether it moves (NOTED). The retag read-back (CR-2026-11-R3, fix C) compares the
 *   versions and says "documents' metadata … unchanged" of `updatedAt`.
 * - **X7** a NESTED block with an id a top-level block of the same document already has: refused, or kept twice
 *   (NOTED; the split assumes a refusal, its report's "suspected, not reproduced" 1).
 * - **X8** a plain mention (no label) reads back with its page, and the generic verify finds the document as written:
 *   LegendKeeper fills in display fields on read-back (the owner saw `name` and `text`, NOTED), which the verify ignores,
 *   comparing a mention by its target (CR-2026-11-R3, R3-67: a split's job read its own mentions back as differences).
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project with its own key, refused otherwise before any request. What it makes: two throwaway pages
 * `lk-bridge r3 check A|B <time>` (B with a second page document) and one asset folder `lk-bridge r3 X1 <time>`; plain
 * names, no prefix, no status tag. All are deleted at the end, even after a failure; the report names any to delete by
 * hand. Cost: about 26 writes and 26 reads. The steps are in `assumptions-r3.ts`; the ordinary suite runs them against
 * the mock in `test/sandbox-mock/assumptions-r3.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { formatAssumptionsR3Report, runAssumptionsR3 } from './assumptions-r3.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: what the third review assumes (X1–X8)', () => {
  it('confirms each assumption on the real API, and cleans up', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sb = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    try {
      const items = await runAssumptionsR3(sb);
      process.stdout.write(formatAssumptionsR3Report(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    } finally {
      await sb.close();
    }
  }, 900_000);
});
