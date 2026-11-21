/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
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
 * tests: a registered sandbox project, with its own key.
 *
 * The thin wrapper for the real run is `assign-block-ids.test.ts`; the ordinary suite runs these steps against the mock in
 * `test/sandbox-mock/assign-block-ids.test.ts`.
 */
import { sandboxRun, type SandboxRun } from './steps.js';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  BlockIdStore,
  isLegacy,
  legacyProblems,
  verifyAssigned,
  type SandboxVerdict,
} from '../../src/blockids/index.js';
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { withoutVersions } from '../../src/pages/blockwise.js';
import type { HttpCounters, SoakRuntime } from './soak.js';
import { notSucceeded, wholeError } from './whole.js';

export const BRIDGE_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

type Obj = Record<string, any>;

export interface BlockIdsCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}
type Item = BlockIdsCheckItem;
export interface BlockIdsCheckResult {
  readonly items: BlockIdsCheckItem[];
  readonly verdict: SandboxVerdict;
  readonly summary: string;
}

/** Blocks sent WITHOUT ids (a paragraph with marks, a nested list, a table cell), the closest the API comes to a legacy page. */
const LEGACY_ATTEMPT = [
  { kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
  { kind: 'paragraph', content: [{ text: 'An old page, ' }, { text: 'with marks', bold: true }] },
  {
    kind: 'bulletList',
    children: [{ kind: 'listItem', children: [{ kind: 'paragraph', content: [{ text: 'nested' }] }] }],
  },
];

/**
 * The check's steps, for the real run (`assign-block-ids.test.ts`) and, CR-2026-11-R4 (the owner's request S), the
 * ordinary suite's run against the mock (`test/sandbox-mock/assign-block-ids.test.ts`), through the same runtime and
 * harness. `named`: a legacy document `<resourceId>/<documentId>` to give ids to (the real run reads
 * `LKB_BLOCKIDS_DOCUMENT`); without it, a throwaway page whose blocks are sent without ids.
 */
export async function runBlockIdsCheck(
  sb: SoakRuntime,
  o: {
    readonly named?: string | undefined;
    /** R4.1: the run that prints each step and holds the clean-up (the test file's, for its `afterAll`). */
    readonly run?: SandboxRun;
  } = {},
): Promise<BlockIdsCheckResult> {
  const steps = o.run ?? sandboxRun({ name: 'assign-block-ids', out: () => undefined });
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'assign-block-ids' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw notSucceeded(op, r);
    return r.result as Obj;
  };
  const read = (resourceId: string, documentId: string) =>
    run('getDocumentBlocks', { path: { resourceId, documentId } }) as Promise<{
      version: string;
      blocks: Obj[];
    }>;

  let target: { resourceId: string; documentId: string };
  let throwaway: string | null = null;
  const named = o.named?.trim();
  steps.defer('the throwaway page deleted', async () => {
    if (throwaway) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: throwaway }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        record(
          'cleanup',
          'the throwaway page deleted',
          'fail',
          `${throwaway}: ${wholeError(e)}. Delete it by hand.`,
        );
      }
    }
  });
  try {
    const pre = await steps.step('setup', 'the document to give ids to, read', async () => {
      if (named) {
        const [resourceId, documentId] = named.split('/');
        if (!resourceId || !documentId) throw new Error('LKB_BLOCKIDS_DOCUMENT is <resourceId>/<documentId>');
        target = { resourceId, documentId };
      } else {
        // A throwaway page whose blocks are sent without ids.
        const id = mintClientId(8);
        const made = await run('createResource', {
          body: {
            id,
            name: `lk-bridge block-ids check ${new Date().toISOString()}`,
            documents: [{ name: 'Main', type: 'page', blocks: LEGACY_ATTEMPT }],
          },
        });
        throwaway = String(made.id ?? id);
        const doc =
          (made.documents as Obj[] | undefined)?.find((d) => d.name === 'Main') ?? made.documents?.[0];
        target = { resourceId: throwaway, documentId: String(doc?.id ?? '') };
      }
      return read(target.resourceId, target.documentId);
    });
    if (!isLegacy(pre.blocks)) {
      record(
        'legacy',
        'a legacy document to try',
        'noted',
        named
          ? `${named} is not a legacy document: every block already has an id, once.`
          : 'LegendKeeper gave every block an id when the page was written, so the API cannot make a legacy document. ' +
              'To run this check: make a page in the LegendKeeper app’s oldest editor form, or name an existing legacy ' +
              'page in a DISPOSABLE copy of a world, then rerun with LKB_BLOCKIDS_DOCUMENT=<resourceId>/<documentId> ' +
              '(that document is given ids; nothing else is changed).',
      );
    } else {
      const before = legacyProblems(pre.blocks);
      const { first, post } = await steps.step(
        '1-3',
        'assignBlockIds, then the document read back',
        async () => {
          const first = await run('assignBlockIds', { path: target });
          return { first, post: await read(target.resourceId, target.documentId) };
        },
      );
      const after = legacyProblems(post.blocks);
      record(
        '1',
        'assignBlockIds gives every block a unique id',
        after.missing === 0 && after.duplicates.length === 0 ? 'pass' : 'fail',
        `before: ${before.missing} without an id, ${before.duplicates.length} ids used twice; after: ${after.missing} and ${after.duplicates.length} (assigned ${String(first.assigned)})`,
      );
      const v = verifyAssigned(pre.blocks, post.blocks);
      record(
        '2',
        'the content is unchanged, unsupported blocks included',
        v.differences.filter((d) => d.path !== 'block ids').length === 0 ? 'pass' : 'fail',
        v.ok
          ? `identical but for ids (${before.unsupported} unsupported blocks before and after)`
          : `first difference at ${v.differences[0]!.path}: expected ${JSON.stringify(v.differences[0]!.expected)}, found ${JSON.stringify(v.differences[0]!.actual)}; every difference: ${stableJson(v.differences)}; the document after assignBlockIds: ${stableJson(post.blocks)}`,
      );
      record(
        '3',
        'the document version moves',
        post.version !== pre.version ? 'pass' : 'fail',
        `${pre.version} → ${post.version} (the call answered ${String(first.version)})`,
      );
      const { second, again } = await steps.step(
        '4',
        'assignBlockIds a second time, then read back',
        async () => {
          const second = await run('assignBlockIds', { path: target });
          return { second, again: await read(target.resourceId, target.documentId) };
        },
      );
      const same = stableJson(withoutVersions(again.blocks)) === stableJson(withoutVersions(post.blocks));
      record(
        '4',
        'a second call changes nothing (idempotent)',
        same && Number(second.assigned ?? 0) === 0 ? 'pass' : 'fail',
        `assigned ${String(second.assigned)}; blocks ${same ? 'identical, ids included' : 'CHANGED'}; version ${post.version} → ${again.version}`,
      );
    }
  } finally {
    await steps.cleanup();
  }
  const verdict: SandboxVerdict = items.some((i) => i.verdict === 'fail')
    ? 'FAIL'
    : items.some((i) => i.verdict === 'noted')
      ? 'NOTED'
      : 'PASS';
  const summary = items.map((i) => `${i.id} ${i.verdict.toUpperCase()}: ${i.title} (${i.detail})`).join('\n');
  return { items, verdict, summary };
}

/**
 * Records the verdict in the bridge's own database at `path` (what the sweep's prerequisite reads; the real run's is
 * `DB_PATH`), or says why it could not.
 */
export function recordBlockIdsVerdict(
  path: string,
  project: string,
  verdict: SandboxVerdict,
  detail: string,
): string {
  if (!existsSync(path)) return `not recorded: there is no bridge database at ${path} (DB_PATH)`;
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    new BlockIdStore(db, () => Date.now()).recordSandboxCheck({
      bridgeVersion: BRIDGE_VERSION,
      project,
      verdict,
      detail,
    });
    return `recorded ${verdict} for bridge version ${BRIDGE_VERSION} in ${path}`;
  } catch (e) {
    return `not recorded (${wholeError(e)}): has the bridge's database been migrated (migration 3300)?`;
  } finally {
    db.close();
  }
}

/** The report as the real run prints it: the verdict, where it was recorded, every item whole, and the requests. */
export function formatBlockIdsReport(
  r: BlockIdsCheckResult,
  where: string,
  counters: Pick<HttpCounters, 'reads' | 'writes'>,
): string {
  return (
    `\nblock-id sweep sandbox check: ${r.verdict} (${where})\n${r.summary}\n` +
    `requests: ${counters.reads} reads, ${counters.writes} writes (counted at the transport)\n`
  );
}
