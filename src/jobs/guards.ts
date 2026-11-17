/**
 * Data-loss and safety guards (PLAN §4 rules 2, 3, 4 and 6), applied generically from registry metadata.
 *
 * - `checkSubmitGuards` runs before anything is queued: read-only mode, member/invite admin, cascade confirmation, and
 *   (W18) a move to the reserved parent `templates`.
 * - `unsupportedLoss` is the unsupported-block guard: it runs on the same read the engine makes for the If-Match
 *   version and the journal pre-image, immediately before `replaceDocumentBlocks` / `replaceBlock`.
 */
import type { OperationDef } from '../lk/registry-types.js';
import {
  CascadeConfirmationRequiredError,
  MemberAdminDisabledError,
  ReadOnlyError,
  TemplatesDestinationError,
  UnsupportedBlockLossError,
  type JobRef,
} from './errors.js';
import type { OpParams, StepOptions } from './types.js';

export interface GuardContext {
  readonly readOnly: boolean;
  readonly allowMemberAdmin: boolean;
  /** v2 A1: the project, and whether the refusal is its own flag (the bridge-wide flag is off). */
  readonly project?: { readonly name: string; readonly projectOnly: boolean };
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
  if (isWriteOp(op) && ctx.readOnly) throw new ReadOnlyError(op.operationId, ctx.project);
  if (op.risk === 'admin' && !ctx.allowMemberAdmin) throw new MemberAdminDisabledError(op.operationId);
  if (cascadeRequested(params) && options.confirm !== 'cascade') {
    throw new CascadeConfirmationRequiredError(op.operationId);
  }
  if (op.operationId === 'moveResource' && movesToTemplates(params)) {
    throw new TemplatesDestinationError(op.operationId);
  }
}

/** W18: a move whose destination is the reserved parent `templates` (any case, spaces trimmed). */
export function movesToTemplates(params: OpParams): boolean {
  const p = (params.body as { parentId?: unknown } | undefined)?.parentId;
  return typeof p === 'string' && p.trim().toLowerCase() === 'templates';
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
      if (o.kind === 'unsupported' && typeof o.id === 'string' && o.id !== '') out.add(o.id);
      for (const x of Object.values(o)) if (typeof x === 'object' && x !== null) stack.push(x);
    }
  }
  return out;
}

/**
 * How many `unsupported` blocks in a tree have no string `id` (chunk 8, F-06). LegendKeeper's schema requires the id,
 * but legacy documents are described as having blocks without ids until `assignBlockIds`; such a block cannot be
 * echoed by id, so a replace can never keep it.
 */
export function idlessUnsupportedCount(tree: unknown): number {
  let n = 0;
  const stack: unknown[] = [tree];
  let guard = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (++guard > 5_000_000) break;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if (o.kind === 'unsupported' && (typeof o.id !== 'string' || o.id === '')) n++;
      for (const x of Object.values(o)) if (typeof x === 'object' && x !== null) stack.push(x);
    }
  }
  return n;
}

/**
 * Ids of `unsupported` blocks in `current` that `incoming` would drop, then one `(no id) #n` entry for each
 * `unsupported` block in `current` that has no id (it cannot be echoed, so it is always lost).
 * For a delete (`incoming` undefined) every `unsupported` block in `current`, the target and its subtree, is lost.
 */
export function unsupportedLoss(current: unknown, incoming: unknown): string[] {
  const keep = unsupportedBlockIds(incoming);
  const lost = [...unsupportedBlockIds(current)].filter((id) => !keep.has(id)).sort();
  const idless = idlessUnsupportedCount(current);
  for (let i = 1; i <= idless; i++) lost.push(`(no id) #${i}`);
  return lost;
}

/**
 * CR-2026-11 (CR-02): what the unsupported-block guard compares for a write, by the operation's `guard` kind (op-meta):
 * the document's blocks; a block (a delete sends nothing, so everything under it is lost); a property, whose delete loses
 * the property itself when it is `unsupported` and every `unsupported` block among its children, and whose update loses
 * only what its new `children` leave out (an update that sends no children keeps them). Null: nothing to compare.
 */
export function unsupportedGuardSides(
  guard: 'document' | 'block' | 'property',
  opId: string,
  params: OpParams,
  current: { readonly body: unknown; readonly entity?: unknown },
): { readonly existing: unknown; readonly incoming: unknown } | null {
  if (guard === 'document') {
    return {
      existing: (current.body as { blocks?: unknown } | undefined)?.blocks,
      incoming: (params.body as { blocks?: unknown } | undefined)?.blocks,
    };
  }
  if (guard === 'block') return { existing: current.body, incoming: params.body };
  const entity = current.entity ?? current.body;
  if (opId.startsWith('delete')) return { existing: entity, incoming: undefined };
  const children = (params.body as { children?: unknown } | undefined)?.children;
  if (children === undefined) return null;
  return { existing: (entity as { children?: unknown } | undefined)?.children, incoming: children };
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
