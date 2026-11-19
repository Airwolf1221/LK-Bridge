/**
 * v3 F3d amendment (ADR 0058, "A conflict partway through"): rebasing an item's write on a conflict, inside its lock.
 *
 * Arkona's governance (Lifecycle › Concurrent LegendKeeper Writing): "Read the live target before editing, use the
 * required expected version, and reconcile changed content rather than overwriting it." A long job (a rename of a
 * heavily referenced character is hundreds of requests) meets other writers part-way. When one of its writes finds its
 * target changed (the bridge's own compare-and-swap inside the lock sees another version or state, or LegendKeeper
 * answers 412 `VERSION_MISMATCH`), the step's REBASER is asked, with the target as it is now:
 *
 * - **`retry`**: what the item edits is still exactly there; these params re-apply the same change to the fresh content
 *   (the engine sends them with the current version as If-Match). They may leave out some of the step's items (`skipped`).
 * - **`unchanged`**: the target already holds the change; nothing is sent.
 * - **`skip`**: what the item edits is gone or changed ("changed meanwhile"), or cannot be told apart (an occurrence that
 *   now appears more than once): the step's items are skipped, recorded with a before and after excerpt, and the job
 *   carries on with its other items. A CORE item (`rebase.core`: the subject's own pages and identity facts) is never
 *   skipped: its conflict stops the job, which stays resumable, because a half-renamed identity is worse than a stopped
 *   one.
 *
 * At most {@link MAX_CONFLICTS} conflicts per step (so at most three sends), with the governor's backoff before each
 * re-read that follows a refused send. A rebaser NEVER widens an edit: it re-applies the same change to the same text, or
 * skips. Only bridge code sets `rebase` (agents cannot pass step options other than `allowUnsupportedLoss` and
 * `confirm`); rebasers are registered by name (`engine.registerRebaser`) and are synchronous (they work on data already
 * read).
 *
 * Skipped items are kept in the step's result (`skippedItems`); every later step whose items are all skipped is not sent
 * (recorded as succeeded with `{ skipped }`), and the parts of a shared step (a read-back target, a Last Major Revision
 * step's evidence) that belong only to skipped items are left out (`skippedOfJob`, `trimSkipped`).
 */
import type { OpParams, SkippedItem } from './types.js';

/** Conflicts one step may meet: the third one ends it (skipped, or the job stopped for a core item). */
export const MAX_CONFLICTS = 3;

export interface RebaseContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly opId: string;
  /** The step's params as they stand (the last ones tried). */
  readonly params: OpParams;
  /** What the step stored for its rebaser (`options.rebase.input`). */
  readonly input: unknown;
  /**
   * CR-2026-11-R3 (R3-12): the step's items that may still be applied: its own items (and `rebase.with`), less those
   * the job skipped earlier (changed meanwhile). A rebaser re-applies only these items' changes, never a skipped one's.
   */
  readonly items?: readonly string[];
  /** 1 for the first conflict, then 2. */
  readonly conflict: number;
  /** The target as read inside the lock now. */
  readonly current: {
    readonly exists: boolean;
    readonly version: string | null;
    readonly body: unknown;
    readonly entity: unknown;
  };
}

export type RebaseResult =
  | {
      readonly kind: 'retry';
      /** The params to send (their `ifMatch` is set to the current version by the engine for a versioned write). */
      readonly params: OpParams;
      /** Items of this step left out of the retry (changed meanwhile). */
      readonly skipped?: readonly SkippedItem[];
      readonly note?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'unchanged'; readonly note?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'skip'; readonly skipped: readonly SkippedItem[] };

export type Rebaser = (ctx: RebaseContext) => RebaseResult;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The skipped items a step's stored result names (a check's or a write's). */
export function skippedIn(result: unknown): SkippedItem[] {
  if (!isObj(result)) return [];
  const list = result.skippedItems;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (x): x is SkippedItem => isObj(x) && typeof x.item === 'string' && typeof x.reason === 'string',
  );
}

/** One line per skipped item, at most 300 characters each side, for the record. */
export function excerpt(s: string | null | undefined, max = 300): string | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
