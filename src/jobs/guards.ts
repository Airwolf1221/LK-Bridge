/**
 * Data-loss and safety guards (PLAN §4 rules 2, 3, 4 and 6), applied generically from registry metadata.
 *
 * - `checkSubmitGuards` runs before anything is queued: read-only mode, member/invite admin, cascade confirmation.
 * - `unsupportedLoss` is the unsupported-block guard: it runs on the same read the engine makes for the If-Match
 *   version and the journal pre-image, immediately before `replaceDocumentBlocks` / `replaceBlock`.
 */
import type { OperationDef } from '../lk/registry-types.js';
import {
  CascadeConfirmationRequiredError,
  MemberAdminDisabledError,
  ReadOnlyError,
  UnsupportedBlockLossError,
  type JobRef,
} from './errors.js';
import type { OpParams, StepOptions } from './types.js';

export interface GuardContext {
  readonly readOnly: boolean;
  readonly allowMemberAdmin: boolean;
}

export function isWriteOp(op: OperationDef): boolean {
  return op.kind !== 'read';
}

/** Throws the first guard that refuses the call. Pure: no I/O. */
export function checkSubmitGuards(
  op: OperationDef,
  params: OpParams,
  options: StepOptions,
  ctx: GuardContext,
): void {
  if (isWriteOp(op) && ctx.readOnly) throw new ReadOnlyError(op.operationId);
  if (op.risk === 'admin' && !ctx.allowMemberAdmin) throw new MemberAdminDisabledError(op.operationId);
  if (cascadeRequested(params) && options.confirm !== 'cascade') {
    throw new CascadeConfirmationRequiredError(op.operationId);
  }
}

/** `cascade=true` on any operation that takes it (today only deleteResource). Strings count: LK reads the query. */
export function cascadeRequested(params: OpParams): boolean {
  const v = params.query?.cascade;
  return v === true || v === 'true';
}

/** Every `unsupported` block id anywhere in a block tree (children, table rows, columns, property bodies…). */
export function unsupportedBlockIds(tree: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [tree];
  let guard = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (++guard > 5_000_000) break; // a pathological tree; LK caps nesting at 64 and blocks at 10,000
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if (o.kind === 'unsupported' && typeof o.id === 'string') out.add(o.id);
      for (const x of Object.values(o)) if (typeof x === 'object' && x !== null) stack.push(x);
    }
  }
  return out;
}

/** Ids of `unsupported` blocks in `current` that `incoming` would drop. */
export function unsupportedLoss(current: unknown, incoming: unknown): string[] {
  const keep = unsupportedBlockIds(incoming);
  return [...unsupportedBlockIds(current)].filter((id) => !keep.has(id)).sort();
}

/** Throws `UnsupportedBlockLossError` unless nothing is lost or the caller allowed the loss. */
export function assertNoUnsupportedLoss(
  opId: string,
  current: unknown,
  incoming: unknown,
  options: StepOptions,
  ref: JobRef = {},
): string[] {
  const lost = unsupportedLoss(current, incoming);
  if (lost.length > 0 && options.allowUnsupportedLoss !== true) {
    throw new UnsupportedBlockLossError(opId, lost, ref);
  }
  return lost;
}
