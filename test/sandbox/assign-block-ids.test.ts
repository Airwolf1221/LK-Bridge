/**
 * v3 F3.5 (ADR 0056), opt-in, WRITES then cleans up: the block-id sweep's sandbox check (point 2 of its approved-automation
 * statement). On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assign-block-ids
 *
 * It needs a page document with blocks that have no id (a legacy page). LegendKeeper's API may not be able to make one:
 * the check first writes a throwaway page with blocks sent without ids, and reads it back. If LegendKeeper gave them ids
 * on the write, there is no legacy document to try, and the verdict is **NOTED** with what to do: make a page in the
 * app's oldest editor form, or name an existing legacy page in a disposable copy of a world with
 * `LKB_BLOCKIDS_DOCUMENT=<resourceId>/<documentId>` (that document is given ids: nothing else is changed). Where it can
 * run, it confirms:
 *
 * - (1) `assignBlockIds` gives every block a unique id;
 * - (2) the content is unchanged, `unsupported` blocks included (the sweep's own comparison, src/blockids/detect.ts);
 * - (3) the document's version moves;
 * - (4) a second call changes nothing (it is idempotent).
 *
 * The verdict (PASS, NOTED or FAIL) is recorded in the BRIDGE'S database (`DB_PATH`, table `block_id_sandbox_checks`)
 * with the bridge version (package.json), which is what the sweep's prerequisite reads: only a PASS for the running
 * version lets the job be enabled without the owner's override. Everything else runs in the sandbox runtime's own
 * temporary database, through the job engine and the governor (never a raw request). The same guard as the other sandbox
 * tests: a registered sandbox project, with its own key. The steps are in `assign-block-ids.ts`; the ordinary suite
 * runs them against the mock in `test/sandbox-mock/assign-block-ids.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { formatBlockIdsReport, recordBlockIdsVerdict, runBlockIdsCheck } from './assign-block-ids.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: assignBlockIds, for the block-id sweep (writes, then cleans up)',
  () => {
    it('gives every block a unique id, changes no content, moves the version, and is idempotent', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const r = await runBlockIdsCheck(sandbox, { named: process.env.LKB_BLOCKIDS_DOCUMENT });
        const where = recordBlockIdsVerdict(
          process.env.DB_PATH ?? './data/bridge.db',
          target.name,
          r.verdict,
          r.summary.slice(0, 3900),
        );
        process.stdout.write(formatBlockIdsReport(r, where, sandbox.counters));
        expect(r.items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
      } finally {
        await sandbox.close();
      }
    }, 900_000);
  },
);
