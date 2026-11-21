/**
 * v3 F3e (ADR 0059), opt-in, WRITES then cleans up: what `arkona_split_owner` assumes of LegendKeeper when it moves blocks
 * verbatim from one page to another (the design's "keeping block IDs where LegendKeeper allows"). Written for the owner;
 * never run by an agent. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- split-ids
 *
 * Two throwaway pages, A and B, each with its Main document. It confirms:
 *
 * - (1) a block written to B with the id it has in A is kept with that id (block ids are per document, so a moved block
 *   keeps its id), its children's ids too;
 * - (2) the moved block arrives verbatim: its runs, marks, mention and nested list exactly as in A (versions aside);
 * - (3) A's own edit (the block taken out, an interface summary in its place) leaves B's copy as it is;
 * - (4) a requested id B already uses: what LegendKeeper does (a refusal, or another id) is recorded as NOTED; the split
 *   never sends one (it derives another id and says so in the job).
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project, with its own key. Both pages are deleted at the end; the report says which to delete by
 * hand if that fails. The steps are in `split-ids.ts`; the ordinary suite runs them against the mock in
 * `test/sandbox-mock/split-ids.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createSoakRuntime } from './soak.js';
import { formatSplitIdsReport, runSplitIdsCheck } from './split-ids.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: block ids across documents, for arkona_split_owner (writes, then cleans up)',
  () => {
    it('a moved block keeps its id and arrives verbatim; the source’s edit leaves it as it is', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const items = await runSplitIdsCheck(sandbox);
        process.stdout.write(formatSplitIdsReport(items, sandbox.counters));
        expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
      } finally {
        await sandbox.close();
      }
    }, 900_000);
  },
);
