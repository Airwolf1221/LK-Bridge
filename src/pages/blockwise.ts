/**
 * Block-by-block page writes (v2 E4, ADR 0046 decision 1; PLAN-v2 E4 row, backlog 1).
 *
 * `write_page` sends a page back whole (`replaceDocumentBlocks`). A page that holds content LegendKeeper's write format
 * has no form for (an inline icon in a paragraph's text) cannot be sent back whole, so C1 refused it as
 * `PAGE_NOT_WRITABLE`, and E1a's restore refused it as `RESTORE_NOT_WRITABLE`. LegendKeeper's single-block operations
 * work beside such a block (tested on the real API on 10 November 2026): `insertBlock`, `replaceBlock` and
 * `deleteBlock`, each answering the document's new version (a delete in its `ETag`: B12, B13, D25).
 *
 * This module turns "the document as it is" and "the document as it must become" into those operations, by block id:
 *
 * - **inserts first**, each with its whole subtree, placed `after` its nearest earlier sibling in the result that is
 *   already there, else `before` its nearest later one, else at the start of what its parent holds (whose old children
 *   all go) or as its parent's last child; then **replaces** of the outermost blocks whose own fields changed (with their
 *   subtree as the result holds it); then **deletes** of the outermost removed blocks, last first. A stop part-way
 *   therefore never loses text: a failure after the inserts leaves old and new side by side.
 * - **refused** (nothing is planned) when: a block has no id or an id twice (a legacy page: `assignBlockIds` first); a
 *   block moved (another parent or another order: not done block by block); a block the write format cannot take back
 *   (`unwritable`, the icon paragraph) would be changed, removed or sent inside a replace (an edit to the icon paragraph
 *   itself stays refused); an `unsupported` block would be deleted (CLAUDE.md: never); the plan would need more than
 *   `MAX_BLOCKWISE_WRITES` writes.
 * - **self-checked**: the planned operations are replayed on a copy of the document (`applyBlockOps`, the same rules
 *   LegendKeeper documents) and must give the result exactly, or nothing is planned.
 *
 * It is not atomic. The job that runs it (src/mcp/tools/write-page.ts, src/snapshots/restore.ts) holds the document's
 * lock, checks inside it that the document is exactly as planned (`BLOCKWISE_CHECK`), chains each write's If-Match from
 * the one before, and verifies the whole document after. A job that stops part-way is undone from its own record
 * (src/pages/undo.ts): the document is written back block by block to the state before the job, but only when it is
 * exactly as the stopped job left it.
 *
 * Pure: no LegendKeeper calls, no clock.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../jobs/sidebar-state.js';
import type { DocumentChecker } from '../jobs/internal-steps.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The document checker the block-by-block job runs inside the lock (registered by the runtime). */
export const BLOCKWISE_CHECK = 'pages.blockwise';

/** At most this many writes in one block-by-block job (120 writes a minute is the key's limit). */
export const MAX_BLOCKWISE_WRITES = 200;

export type BlockOp =
  | {
      readonly op: 'insertBlock';
      readonly id: string;
      readonly block: Obj;
      readonly after?: string;
      readonly before?: string;
      readonly parent?: string;
    }
  | { readonly op: 'replaceBlock'; readonly id: string; readonly block: Obj }
  | { readonly op: 'deleteBlock'; readonly id: string };

export type BlockwiseRefusalReason =
  'ids' | 'moved' | 'unwritable' | 'unsupported' | 'too_many' | 'self_check' | 'invalid';

export interface BlockwiseRefusal {
  readonly reason: BlockwiseRefusalReason;
  readonly message: string;
  readonly blocks: readonly { readonly id: string | null; readonly kind: string }[];
}

export type BlockwisePlan =
  | { readonly ok: true; readonly ops: readonly BlockOp[]; readonly empty: boolean }
  | { readonly ok: false; readonly refusal: BlockwiseRefusal };

export interface BlockwiseOptions {
  /** Ids of blocks the write format cannot take back (the inline-icon paragraphs): never edited, removed or re-sent. */
  readonly unwritable?: ReadonlySet<string>;
  /** Checks one planned operation's request (the registry's schema); returns a problem, or null. */
  readonly validate?: (op: BlockOp) => string | null;
  readonly maxWrites?: number;
}

interface Entry {
  readonly block: Obj;
  readonly id: string;
  readonly parentId: string | null;
  readonly index: number;
}

/** A block's own fields (without `children` and the read-only per-block `version`), canonically. */
function ownKey(b: Obj): string {
  const o: Obj = {};
  for (const [k, v] of Object.entries(b)) if (k !== 'children' && k !== 'version') o[k] = v;
  return stableJson(o);
}

/** A tree without the read-only per-block `version`, for comparing and hashing documents. */
export function withoutVersions(blocks: readonly unknown[]): Obj[] {
  return blocks.map((b) => {
    if (!isObj(b)) return b as Obj;
    const o: Obj = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'version') continue;
      o[k] = k === 'children' && Array.isArray(v) ? withoutVersions(v) : v;
    }
    return o;
  });
}

/** The SHA-256 of a document's blocks as the block-by-block check compares them. */
export function blocksHash(blocks: readonly unknown[]): string {
  return createHash('sha256')
    .update(stableJson(withoutVersions(blocks)))
    .digest('hex');
}

function index(blocks: readonly unknown[]): { entries: Entry[]; problems: Obj[] } {
  const entries: Entry[] = [];
  const problems: Obj[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly unknown[], parentId: string | null): void => {
    list.forEach((b, i) => {
      if (!isObj(b)) {
        problems.push({ id: null, kind: '?' });
        return;
      }
      const id = typeof b.id === 'string' && b.id !== '' ? b.id : null;
      if (id === null || seen.has(id)) problems.push({ id, kind: typeof b.kind === 'string' ? b.kind : '?' });
      if (id !== null) {
        seen.add(id);
        entries.push({ block: b, id, parentId, index: i });
      }
      if (Array.isArray(b.children)) walk(b.children, id);
    });
  };
  walk(blocks, null);
  return { entries, problems };
}

const refuse = (
  reason: BlockwiseRefusalReason,
  message: string,
  blocks: readonly { id: string | null; kind: string }[] = [],
): BlockwisePlan => ({ ok: false, refusal: { reason, message, blocks: blocks.slice(0, 50) } });

const kindOf = (b: Obj): string => (typeof b.kind === 'string' ? b.kind : '?');

/** Every block id in a subtree (the block included). */
function subtreeIds(b: Obj, out: string[] = []): string[] {
  if (typeof b.id === 'string') out.push(b.id);
  if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) subtreeIds(c, out);
  return out;
}

function hasUnsupported(b: Obj): boolean {
  if (b.kind === 'unsupported') return true;
  return Array.isArray(b.children) && b.children.some((c) => isObj(c) && hasUnsupported(c));
}

/** Plans the block-level writes that turn `before` into `after` (see the module comment). */
export function planBlockwise(
  before: readonly unknown[],
  after: readonly unknown[],
  o: BlockwiseOptions = {},
): BlockwisePlan {
  const unwritable = o.unwritable ?? new Set<string>();
  const B = index(before);
  const A = index(after);
  if (B.problems.length > 0 || A.problems.length > 0) {
    return refuse(
      'ids',
      'Some blocks have no id, or share one (a legacy page). The page must be given block ids first (assignBlockIds); nothing was planned.',
      [...B.problems, ...A.problems] as { id: string | null; kind: string }[],
    );
  }
  const bById = new Map(B.entries.map((e) => [e.id, e]));
  const aById = new Map(A.entries.map((e) => [e.id, e]));

  // Moves: another parent, or survivors in another order under the same parent.
  const moved: Entry[] = [];
  for (const e of A.entries) {
    const b = bById.get(e.id);
    if (b && b.parentId !== e.parentId) moved.push(e);
  }
  const order = (entries: Entry[], keep: (id: string) => boolean): Map<string | null, string[]> => {
    const m = new Map<string | null, string[]>();
    for (const e of entries) {
      if (!keep(e.id)) continue;
      const l = m.get(e.parentId) ?? [];
      l.push(e.id);
      m.set(e.parentId, l);
    }
    return m;
  };
  const survives = (id: string) => bById.has(id) && aById.has(id);
  const oldOrder = order(B.entries, survives);
  const newOrder = order(A.entries, survives);
  for (const [p, ids] of newOrder) {
    const was = oldOrder.get(p) ?? [];
    if (was.length === ids.length && was.every((x, i) => x === ids[i])) continue;
    const sameParent = ids.filter((id) => was.includes(id));
    const wasHere = was.filter((id) => sameParent.includes(id));
    sameParent.forEach((id, i) => {
      if (wasHere[i] !== id) moved.push(aById.get(id)!);
    });
  }
  if (moved.length > 0) {
    return refuse(
      'moved',
      'This edit moves blocks (to another place or another order), which is not done block by block on a page that cannot be written back whole. Nothing was planned.',
      moved.map((e) => ({ id: e.id, kind: kindOf(e.block) })),
    );
  }

  const changed = A.entries.filter((e) => {
    const b = bById.get(e.id);
    return b !== undefined && ownKey(b.block) !== ownKey(e.block);
  });
  const changedIds = new Set(changed.map((e) => e.id));
  const addedIds = new Set(A.entries.filter((e) => !bById.has(e.id)).map((e) => e.id));
  const removedIds = new Set(B.entries.filter((e) => !aById.has(e.id)).map((e) => e.id));

  // The outermost changed blocks are replaced with their whole subtree; whatever lies inside goes with them.
  const ancestorsIn = (byId: Map<string, Entry>, id: string): string[] => {
    const out: string[] = [];
    let p = byId.get(id)?.parentId ?? null;
    while (p !== null) {
      out.push(p);
      p = byId.get(p)?.parentId ?? null;
    }
    return out;
  };
  const replaceRoots = changed.filter((e) => !ancestorsIn(aById, e.id).some((a) => changedIds.has(a)));
  const replaced = new Set(replaceRoots.map((e) => e.id));
  const insideReplaced = (byId: Map<string, Entry>, id: string) =>
    replaced.has(id) || ancestorsIn(byId, id).some((a) => replaced.has(a));
  const insertRoots = A.entries.filter(
    (e) =>
      addedIds.has(e.id) &&
      (e.parentId === null || !addedIds.has(e.parentId)) &&
      !(e.parentId !== null && insideReplaced(aById, e.parentId)),
  );
  const deleteRoots = B.entries.filter(
    (e) =>
      removedIds.has(e.id) &&
      (e.parentId === null || !removedIds.has(e.parentId)) &&
      !(e.parentId !== null && insideReplaced(bById, e.parentId)),
  );

  // The blocks the write format cannot take back are never changed, removed or re-sent.
  const touchedUnwritable: Entry[] = [];
  for (const id of unwritable) {
    const b = bById.get(id);
    if (!b) continue;
    if (changedIds.has(id) || removedIds.has(id) || insideReplaced(bById, id)) touchedUnwritable.push(b);
  }
  if (touchedUnwritable.length > 0) {
    return refuse(
      'unwritable',
      'This edit changes or removes a block LegendKeeper’s API cannot write back (for example a paragraph with an inline icon). That block can only be changed in the LegendKeeper app. Nothing was planned.',
      touchedUnwritable.map((e) => ({ id: e.id, kind: kindOf(e.block) })),
    );
  }
  const lostUnsupported = deleteRoots.filter((e) => hasUnsupported(e.block));
  for (const r of replaceRoots) {
    const was = bById.get(r.id)!.block;
    const keptIds = new Set(subtreeIds(r.block));
    const gone = subtreeIds(was).filter((id) => {
      const x = bById.get(id);
      return x !== undefined && x.block.kind === 'unsupported' && !keptIds.has(id);
    });
    if (gone.length > 0) lostUnsupported.push(bById.get(r.id)!);
  }
  if (lostUnsupported.length > 0) {
    return refuse(
      'unsupported',
      'This edit would delete content LegendKeeper’s API cannot represent (an `unsupported` block). The bridge never drops those. Nothing was planned.',
      lostUnsupported.map((e) => ({ id: e.id, kind: kindOf(e.block) })),
    );
  }
  const max = o.maxWrites ?? MAX_BLOCKWISE_WRITES;
  const writes = insertRoots.length + replaceRoots.length + deleteRoots.length;
  if (writes === 0) return { ok: true, ops: [], empty: true };
  if (writes > max) {
    return refuse(
      'too_many',
      `Written block by block, this edit would take ${writes} writes (at most ${max} in one job). Make it in smaller section edits. Nothing was planned.`,
    );
  }

  // Inserts in the result's order, anchored to what the document already holds at that point.
  let sim = structuredClone(before) as Obj[];
  const ops: BlockOp[] = [];
  const childrenOf = (tree: readonly unknown[], parentId: string | null): Obj[] | undefined => {
    if (parentId === null) return tree as Obj[];
    const p = findIn(tree, parentId);
    return p ? ((p.children as Obj[] | undefined) ?? []) : undefined;
  };
  for (const e of insertRoots) {
    const siblings = childrenOf(after, e.parentId)!;
    const present = (x: Obj) => typeof x.id === 'string' && findIn(sim, x.id) !== null;
    let anchor: { after?: string; before?: string; parent?: string } = {};
    let placed = false;
    for (let j = e.index - 1; j >= 0 && !placed; j--) {
      if (present(siblings[j]!)) {
        anchor = { after: String(siblings[j]!.id) };
        placed = true;
      }
    }
    for (let j = e.index + 1; j < siblings.length && !placed; j++) {
      if (present(siblings[j]!)) {
        anchor = { before: String(siblings[j]!.id) };
        placed = true;
      }
    }
    if (!placed) {
      // Every block the parent holds now goes (they are deletes, later): start before the first of them.
      const now = childrenOf(sim, e.parentId) ?? [];
      if (now.length > 0 && typeof now[0]!.id === 'string') anchor = { before: now[0]!.id };
      else if (e.parentId !== null) anchor = { parent: e.parentId };
    }
    const op: BlockOp = { op: 'insertBlock', id: e.id, block: structuredClone(e.block), ...anchor };
    ops.push(op);
    sim = applyBlockOps(sim, [op]);
  }
  for (const e of replaceRoots) {
    const op: BlockOp = { op: 'replaceBlock', id: e.id, block: structuredClone(e.block) };
    ops.push(op);
    sim = applyBlockOps(sim, [op]);
  }
  for (const e of [...deleteRoots].reverse()) {
    const op: BlockOp = { op: 'deleteBlock', id: e.id };
    ops.push(op);
    sim = applyBlockOps(sim, [op]);
  }
  if (stableJson(withoutVersions(sim)) !== stableJson(withoutVersions(after))) {
    return refuse(
      'self_check',
      'The block-by-block plan did not reproduce the edit exactly when replayed (a bug: please report it). Nothing was planned.',
    );
  }
  if (o.validate) {
    for (const op of ops) {
      const problem = o.validate(op);
      if (problem) {
        return refuse(
          op.op === 'replaceBlock' ? 'unwritable' : 'invalid',
          `LegendKeeper’s API would refuse the ${op.op} of block ${op.id}: ${problem}. Nothing was planned.`,
          [{ id: op.id, kind: kindOf(op.op === 'deleteBlock' ? {} : op.block) }],
        );
      }
    }
  }
  return { ok: true, ops, empty: false };
}

function findIn(tree: readonly unknown[], id: string): Obj | null {
  for (const b of tree) {
    if (!isObj(b)) continue;
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const hit = findIn(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The list that holds block `id` (the top level or a container's children), and its place in it. */
function placeOf(tree: Obj[], id: string): { list: Obj[]; at: number } | null {
  const walk = (list: Obj[]): { list: Obj[]; at: number } | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.id === id) return { list, at: i };
      if (Array.isArray(b.children)) {
        const hit = walk(b.children as Obj[]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(tree);
}

export class BlockOpError extends Error {
  override readonly name = 'BlockOpError';
}

/**
 * Applies block operations to a copy of a document, as LegendKeeper documents them: an insert goes `after` or `before`
 * a block (in that block's list), or last in a `parent` container, or last in the document; a replace keeps the block's
 * place and id; a delete removes the block and its subtree. Throws `BlockOpError` when an operation cannot apply.
 */
export function applyBlockOps(blocks: readonly unknown[], ops: readonly BlockOp[]): Obj[] {
  const tree = structuredClone(blocks) as Obj[];
  for (const op of ops) {
    if (op.op === 'insertBlock') {
      if (findIn(tree, op.id)) throw new BlockOpError(`insert: ${op.id} is already in the document`);
      const block = structuredClone(op.block);
      if (op.after !== undefined || op.before !== undefined) {
        const p = placeOf(tree, (op.after ?? op.before)!);
        if (!p) throw new BlockOpError(`insert: anchor ${op.after ?? op.before} is not in the document`);
        p.list.splice(op.after !== undefined ? p.at + 1 : p.at, 0, block);
      } else if (op.parent !== undefined) {
        const parent = findIn(tree, op.parent);
        if (!parent) throw new BlockOpError(`insert: parent ${op.parent} is not in the document`);
        const kids = Array.isArray(parent.children) ? (parent.children as Obj[]) : [];
        kids.push(block);
        parent.children = kids;
      } else tree.push(block);
    } else if (op.op === 'replaceBlock') {
      const p = placeOf(tree, op.id);
      if (!p) throw new BlockOpError(`replace: ${op.id} is not in the document`);
      p.list[p.at] = { ...structuredClone(op.block), id: op.id };
    } else {
      const p = placeOf(tree, op.id);
      if (!p) throw new BlockOpError(`delete: ${op.id} is not in the document`);
      p.list.splice(p.at, 1);
    }
  }
  return tree;
}

/** The request body of an operation (the path's `blockId` is the block's own for replace and delete). */
export function opBody(op: BlockOp): Obj | undefined {
  if (op.op === 'insertBlock') {
    return {
      block: op.block,
      ...(op.after !== undefined ? { after: op.after } : {}),
      ...(op.before !== undefined ? { before: op.before } : {}),
      ...(op.parent !== undefined ? { parent: op.parent } : {}),
    };
  }
  if (op.op === 'replaceBlock') return op.block;
  return undefined;
}

/** The input the in-lock check takes: the document's hash, and the document itself for the undo. */
export interface BlockwiseCheckInput {
  readonly hash: string;
  /** The document as planned, before any write (the undo writes it back). */
  readonly before: readonly unknown[];
  /** Set on an undo job: the job it undoes (an undo is never undone). */
  readonly undoOf?: string;
}

/** Inside the lock: the document must be exactly as planned (by content, the per-block versions aside). */
export const blockwiseChecker: DocumentChecker = (ctx) => {
  const input = ctx.input as BlockwiseCheckInput;
  if (blocksHash(ctx.document.blocks) === input.hash) return { differences: [] };
  return {
    differences: [
      {
        path: 'document',
        expected: 'the page as it was when the write was planned',
        actual: 'changed since (edited in LegendKeeper or by another write)',
      },
    ],
  };
};

/** The block operation a job step performs, from its op id and params (for the undo). */
export function stepOp(opId: string, params: { path?: Obj; body?: unknown }): BlockOp | null {
  const path = params.path ?? {};
  const body = isObj(params.body) ? params.body : {};
  if (opId === 'insertBlock' && isObj(body.block) && typeof body.block.id === 'string') {
    return {
      op: 'insertBlock',
      id: body.block.id,
      block: body.block,
      ...(typeof body.after === 'string' ? { after: body.after } : {}),
      ...(typeof body.before === 'string' ? { before: body.before } : {}),
      ...(typeof body.parent === 'string' ? { parent: body.parent } : {}),
    };
  }
  if (opId === 'replaceBlock' && typeof path.blockId === 'string')
    return { op: 'replaceBlock', id: path.blockId, block: body };
  if (opId === 'deleteBlock' && typeof path.blockId === 'string')
    return { op: 'deleteBlock', id: path.blockId };
  return null;
}
