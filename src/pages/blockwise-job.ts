/**
 * The job of a block-by-block page write (v2 E4, ADR 0046 decision 1): the operations `planBlockwise` gives, as ONE job
 * holding the document's lock from its first step to its last.
 *
 * 1. `bridge.expect`, kind `document`, checker `pages.blockwise`: inside the lock the document must be exactly as planned
 *    (by content; the bridge's own compare-and-swap, PLAN-v2 10.6). Its step result holds the version read, which the
 *    first write chains from. The check's input also keeps the document as it was, for the undo.
 * 2. The writes, in the plan's order, each with If-Match chained from the write before (`ifMatchFrom`: a block write
 *    answers the document's new version in its body, a delete in its `ETag`, ADR 0039), `judgedInLock` (the check
 *    decides a proposal's freshness, not the version at approval), and journalled by the engine (replace and delete with
 *    their pre-image).
 * 3. `bridge.verify` of the whole document against the planned result: a difference is "written but not as planned".
 */
import { operationInputSchema } from '../lk/registry.js';
import { EXPECT_STEP, VERIFY_STEP } from '../jobs/internal-steps.js';
import type { StepSpec } from '../jobs/index.js';
import { BLOCKWISE_CHECK, blocksHash, opBody, type BlockOp, type BlockwiseCheckInput } from './blockwise.js';

type Obj = Record<string, unknown>;

export interface BlockwiseJobInput {
  readonly resourceId: string;
  readonly documentId: string;
  /** The document as planned (read), and as it must become. */
  readonly before: readonly unknown[];
  readonly after: readonly unknown[];
  readonly ops: readonly BlockOp[];
  /** The high-level operation each write's journal entry records. */
  readonly journalOperation: Obj;
  /** An undo names the job it undoes. */
  readonly undoOf?: string;
}

export interface BlockwiseJob {
  readonly steps: StepSpec[];
  /** A label per step: `check`, `insert block …`, `replace block …`, `delete block …`, `verify`. */
  readonly labels: string[];
}

const LABEL: Record<BlockOp['op'], string> = {
  insertBlock: 'insert block',
  replaceBlock: 'replace block',
  deleteBlock: 'delete block',
};

/** The request of one operation, as the job step sends it (If-Match is chained in the job). */
export function opParams(resourceId: string, documentId: string, op: BlockOp): Obj {
  const body = opBody(op);
  return {
    path: op.op === 'insertBlock' ? { resourceId, documentId } : { resourceId, documentId, blockId: op.id },
    ...(body !== undefined ? { body } : {}),
  };
}

/** Checks an operation's request against the registry's schema (LegendKeeper's write format); a problem, or null. */
export function validateBlockOp(resourceId: string, documentId: string, op: BlockOp): string | null {
  const r = operationInputSchema(op.op).safeParse({
    ...opParams(resourceId, documentId, op),
    ifMatch: 'v',
  });
  if (r.success) return null;
  const first = r.error.issues[0];
  return first ? `${first.path.join('.')}: ${first.message}` : 'not valid';
}

export function blockwiseJob(i: BlockwiseJobInput): BlockwiseJob {
  const input: BlockwiseCheckInput = {
    hash: blocksHash(i.before),
    before: i.before,
    ...(i.undoOf !== undefined ? { undoOf: i.undoOf } : {}),
  };
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'document',
              kind: 'document',
              resourceId: i.resourceId,
              documentId: i.documentId,
              checker: BLOCKWISE_CHECK,
              input,
            },
          ],
        },
      },
    },
    ...i.ops.map((op, n): StepSpec => ({
      op: op.op,
      judgedInLock: true,
      params: opParams(i.resourceId, i.documentId, op),
      ifMatchFrom: n === 0 ? { step: 1, key: 'document' } : { step: 1 + n },
      journalOperation: { ...i.journalOperation, blockwise: true, block: op.id },
    })),
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'blocks',
              label: 'the page',
              resourceId: i.resourceId,
              documentId: i.documentId,
              blocks: [...i.after],
            },
          ],
        },
      },
    },
  ];
  const labels = ['check', ...i.ops.map((op) => `${LABEL[op.op]} ${op.id}`), 'verify'];
  return { steps, labels };
}
