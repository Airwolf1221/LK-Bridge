/**
 * An approval covers only the pages it listed (ADR 0036 decision 5, accepted by the owner on 11 November 2026; C2d).
 *
 * Most operations name every page they touch in their parameters, so the proposal's own targets (re-read at approval)
 * already are its captured list. Two operations touch pages they do not name: a cascade `deleteResource` (every page
 * under the one it names) and `createResourceFromTemplate` with `includeChildren` (every page under the template is
 * copied). For those, the pages under the named one are listed live when the proposal is captured and kept with it
 * (`pageScope`, in the proposal's job options). At approval they are listed again, and again inside the lock just before
 * the write is sent (`PageScopeGuard`): a page added, gone, or moved to another parent is a conflict; the proposal ends
 * `conflicted` and nothing is written. The whole-set lifecycle tools keep their set here too (checked at approval; their
 * job checks it again itself, in its `bridge.expect` step).
 */
import { listSubtree } from '../facts/canonical.js';
import { StateConflictError, type OpParams } from '../jobs/index.js';
import type { WriteGuard, WriteGuardInLock } from '../jobs/write-guard.js';

/** At most this many pages are listed under one page (a larger cascade is refused at capture: delete it in parts). */
export const PAGE_SCOPE_LIMIT = 500;

export interface ScopedPage {
  readonly id: string;
  readonly parentId: string | null;
  readonly name?: string | null;
}

export interface PageScopeEntry {
  /** The operation (0-based, the job's step number minus one) whose write is checked inside the lock; absent: the job
   * checks it itself (the lifecycle sets' `bridge.expect`). */
  readonly step?: number;
  /** The page whose subtree it is (deleted with a cascade, or the template copied with its children, or a set's root). */
  readonly rootId: string;
  readonly label: string;
  /** Every page under `rootId` when the proposal was captured (not `rootId` itself). */
  readonly pages: readonly ScopedPage[];
}

export interface PageScope {
  readonly subtrees: readonly PageScopeEntry[];
}

/** The operations of a request that touch pages they do not name, and the page whose subtree that is. */
export function implicitSubtrees(
  ops: readonly { readonly op: string; readonly params: OpParams }[],
): { step: number; rootId: string; label: string }[] {
  const out: { step: number; rootId: string; label: string }[] = [];
  ops.forEach((o, step) => {
    const body = (o.params.body ?? {}) as Record<string, unknown>;
    const cascade = o.params.query?.cascade;
    if (o.op === 'deleteResource' && (cascade === true || cascade === 'true')) {
      const rid = o.params.path?.resourceId;
      if (typeof rid === 'string')
        out.push({ step, rootId: rid, label: `the pages under ${rid} (a cascade delete)` });
    }
    if (
      o.op === 'createResourceFromTemplate' &&
      body.includeChildren === true &&
      typeof body.templateId === 'string'
    )
      out.push({
        step,
        rootId: body.templateId,
        label: `the pages under the template ${body.templateId} (copied with it)`,
      });
  });
  return out;
}

/** The pages under `rootId` as LegendKeeper holds them now (with their parents), or null when they cannot be listed. */
export async function listScope(
  read: (opId: string, params: OpParams) => Promise<unknown>,
  rootId: string,
  limit = PAGE_SCOPE_LIMIT,
): Promise<ScopedPage[] | null> {
  const list = await listSubtree(read, rootId, limit);
  return list ? list.map((p) => ({ id: p.id, parentId: p.parentId, name: p.name })) : null;
}

export interface ScopeDifference {
  readonly added: readonly ScopedPage[];
  readonly gone: readonly ScopedPage[];
  readonly moved: readonly {
    readonly id: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
}

/** What differs between the captured pages and the pages now (pure). */
export function compareScope(captured: readonly ScopedPage[], now: readonly ScopedPage[]): ScopeDifference {
  const was = new Map(captured.map((p) => [p.id, p]));
  const is = new Map(now.map((p) => [p.id, p]));
  return {
    added: now.filter((p) => !was.has(p.id)),
    gone: captured.filter((p) => !is.has(p.id)),
    moved: now
      .filter((p) => was.has(p.id) && (was.get(p.id)!.parentId ?? null) !== (p.parentId ?? null))
      .map((p) => ({ id: p.id, from: was.get(p.id)!.parentId ?? null, to: p.parentId ?? null })),
  };
}

export const scopeChanged = (d: ScopeDifference): boolean =>
  d.added.length + d.gone.length + d.moved.length > 0;

/** One sentence for the owner: which pages differ. */
export function scopeText(entry: Pick<PageScopeEntry, 'label'>, d: ScopeDifference): string {
  const names = (l: readonly ScopedPage[]) =>
    l
      .slice(0, 5)
      .map((p) => p.name ?? p.id)
      .join(', ') + (l.length > 5 ? `, and ${l.length - 5} more` : '');
  const parts = [
    d.added.length ? `${d.added.length} page(s) added (${names(d.added)})` : '',
    d.gone.length ? `${d.gone.length} page(s) gone (${names(d.gone)})` : '',
    d.moved.length
      ? `${d.moved.length} page(s) moved (${d.moved
          .slice(0, 5)
          .map((m) => m.id)
          .join(', ')})`
      : '',
  ].filter(Boolean);
  return `${entry.label} changed since the proposal was made: ${parts.join('; ')}; the approval covers only the pages it listed, so nothing was written`;
}

/** The differences as a `StateConflictError`'s list. */
export function scopeDifferences(d: ScopeDifference): { path: string; expected: unknown; actual: unknown }[] {
  return [
    ...d.added.map((p) => ({
      path: `page ${p.name ?? p.id}`,
      expected: '(not in the approved list)',
      actual: p.id,
    })),
    ...d.gone.map((p) => ({ path: `page ${p.name ?? p.id}`, expected: p.id, actual: '(gone)' })),
    ...d.moved.map((m) => ({ path: `page ${m.id} parent`, expected: m.from, actual: m.to })),
  ];
}

/**
 * A conflict of the captured page list (decision 5): nothing was written. A `StateConflictError` (VERSION_CONFLICT), so
 * the job stops before the write and the proposal ends `conflicted`, whatever tool made it (`scope: true`).
 */
export class ScopeConflictError extends StateConflictError {
  readonly scope = true;
  constructor(opId: string, entry: Pick<PageScopeEntry, 'label'>, d: ScopeDifference | null, ref = {}) {
    super(
      opId,
      entry.label,
      d ? scopeDifferences(d) : [{ path: entry.label, expected: 'listed', actual: '(could not be listed)' }],
      null,
      null,
      ref,
    );
    this.message = d
      ? scopeText(entry, d)
      : `${entry.label} could not be listed again just before the write, so the bridge cannot tell they are the pages the approval listed; nothing was written`;
  }
  override toJSON() {
    return { ...super.toJSON(), scope: true };
  }
}

/** Reads a proposal's page scope from a job's stored options (null when it has none). */
export function pageScopeOf(jobOptions: Readonly<Record<string, unknown>> | undefined): PageScope | null {
  const s = jobOptions?.pageScope as PageScope | undefined;
  return s && Array.isArray(s.subtrees) ? s : null;
}

/**
 * Inside the lock, just before a cascade delete or a copy with children that an approved proposal captured: the pages
 * under it listed again and compared with the captured list. Any difference refuses the write (nothing is sent).
 */
export class PageScopeGuard implements WriteGuard {
  entry() {
    return { decision: 'allow' as const };
  }

  async inLock(input: WriteGuardInLock): Promise<void> {
    const scope = pageScopeOf(input.jobOptions);
    if (!scope) return;
    const step = input.step.stepNo - 1;
    for (const entry of scope.subtrees) {
      if (entry.step !== step) continue;
      const now = await listScope((op, params) => input.read(op, params), entry.rootId);
      if (now === null)
        throw new ScopeConflictError(input.opId, entry, null, {
          jobId: input.job.id,
          stepNo: input.step.stepNo,
        });
      const d = compareScope(entry.pages, now);
      if (scopeChanged(d))
        throw new ScopeConflictError(input.opId, entry, d, {
          jobId: input.job.id,
          stepNo: input.step.stepNo,
        });
    }
  }
}
