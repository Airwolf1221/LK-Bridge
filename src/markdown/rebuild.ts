/**
 * Markdown drafts + the current page → the new block tree, its write plan and warnings (`fromMarkdown`, `applyEdit`).
 *
 * At each container level the parsed blocks are aligned with the current blocks by fingerprint (align.ts). A block
 * whose Markdown is unchanged is restored verbatim: same object, same id, every attribute. Unmatched blocks of the same
 * kind in the same gap are paired as "edited": they keep their id and every field Markdown does not show, and take the
 * shown fields from the Markdown. Keep regions restore their block by id; raw `lk-block` blocks are taken as given.
 *
 * Then the rules: missing keep regions are refused unless named in `dropRegions`; the unsupported-block guard of the
 * job engine applies; editor limits, field limits, image URLs and duplicate ids are checked for everything new or
 * changed. The plan is derived by comparing the result with the current page, so "nothing changed" is exactly an empty
 * plan.
 */
import { unsupportedLoss } from '../jobs/guards.js';
import { lcsPairs, pairGap } from './align.js';
import { MarkdownError } from './errors.js';
import { editorProblems, fieldProblems, type LimitProblem } from './limits.js';
import {
  CONTAINER_KINDS,
  fingerprint,
  Interner,
  isObj,
  jsonEqual,
  mentionLabel,
  projectedChildren,
  runsPlainText,
  SHOWN_FIELDS,
  type ANode,
  type Obj,
} from './model.js';
import { normaliseRegionText, type Draft, type DraftBlock, type DraftKeep, type DraftRaw } from './parse.js';
import { readableLines } from './readable.js';
import { draftFingerprint, type RenderedPage } from './render.js';
import { MAX_DOCUMENT_BLOCKS } from './schema.js';
import type {
  FromMarkdownContext,
  FromMarkdownOptions,
  KeepRegion,
  LkBlock,
  MarkdownWarning,
  PlanBlockRef,
  WritePlan,
} from './types.js';

/** The current page, analysed once. */
export interface BasePage {
  readonly blocks: readonly LkBlock[];
  readonly page: RenderedPage;
  /** Keep regions (including blocks the self-check turned into regions) by their keep id. */
  readonly regions: ReadonlyMap<string, ANode>;
  /** Every block object of the page with a string id, by id (inside keep regions too). */
  readonly byId: ReadonlyMap<string, LkBlock>;
  /** Every mention of the page, by `resourceId|documentId|label`, to reuse the original object. */
  readonly mentions: ReadonlyMap<string, Obj>;
  /** Every image URL the page already holds. */
  readonly imageUrls: ReadonlySet<string>;
}

const mentionKey = (resourceId: unknown, documentId: unknown, label: string) =>
  `${String(resourceId)}|${typeof documentId === 'string' ? documentId : ''}|${label}`;

export function indexBase(blocks: readonly LkBlock[], page: RenderedPage): BasePage {
  const regions = new Map<string, ANode>();
  const walkNodes = (list: readonly ANode[]) => {
    for (const n of list) {
      if (n.keep !== null || page.forced.has(n)) {
        if (n.keepId !== null) regions.set(n.keepId, n);
      } else walkNodes(n.children);
    }
  };
  walkNodes(page.nodes);
  const byId = new Map<string, LkBlock>();
  const mentions = new Map<string, Obj>();
  const imageUrls = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 200) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.kind === 'string' && typeof v.id === 'string' && !byId.has(v.id))
      byId.set(v.id, v as LkBlock);
    if (isObj(v.mention) && typeof v.mention.resourceId === 'string') {
      const k = mentionKey(v.mention.resourceId, v.mention.documentId, mentionLabel(v.mention));
      if (!mentions.has(k)) mentions.set(k, v.mention);
    }
    if (typeof v.url === 'string') imageUrls.add(v.url);
    for (const x of Object.values(v)) if (typeof x === 'object' && x !== null) visit(x, depth + 1);
  };
  visit(blocks, 0);
  return { blocks, page, regions, byId, mentions, imageUrls };
}

interface State {
  readonly base: BasePage;
  readonly ctx: FromMarkdownContext;
  readonly warnings: MarkdownWarning[];
  readonly interner: Interner;
  /** Base keep ids and block ids the Markdown names explicitly (keep regions, lk-blocks). */
  readonly claimed: Set<string>;
  /** result block → the base block it derives from (for blocks without an id). */
  readonly origin: Map<LkBlock, LkBlock>;
  /** Current blocks already placed in the result (restored, moved or edited). */
  readonly used: Set<ANode>;
  /** New blocks waiting for the second pass: their place in the result and their draft. */
  readonly pending: { readonly into: LkBlock[]; readonly at: number; readonly draft: DraftBlock }[];
}

// ------------------------------------------------------------------------------------------------ pre-checks

/** Collects keep and raw references, refusing duplicates and unknown regions, warning about edits. */
function preCheck(drafts: readonly Draft[], st: State, scope: ReadonlySet<string> | null): void {
  const seen = new Map<string, number>();
  const walk = (list: readonly Draft[]) => {
    for (const d of list) {
      if (d.t === 'keep') {
        const prev = seen.get(d.id);
        if (prev !== undefined)
          throw new MarkdownError(
            'KEEP_REGION_DUPLICATE',
            `The keep region "${d.id}" appears twice (lines ${prev} and ${d.line}). A region stands for one block; keep it once.`,
            { id: d.id, lines: [prev, d.line] },
          );
        seen.set(d.id, d.line);
        const node = st.base.regions.get(d.id);
        if (!node)
          throw new MarkdownError(
            'KEEP_REGION_UNKNOWN',
            `Line ${d.line}: the keep region "${d.id}" is not on this page (it may have been removed or changed since you read it). Read the page again.`,
            { id: d.id, line: d.line },
          );
        if (scope !== null && !scope.has(d.id))
          throw new MarkdownError(
            'KEEP_REGION_DUPLICATE',
            `Line ${d.line}: the keep region "${d.id}" belongs to another part of the page, which stays as it is. Leave it out of this edit.`,
            { id: d.id, line: d.line },
          );
        if (node.block.kind !== d.kind)
          st.warnings.push({
            code: 'KEEP_REGION_KIND',
            message: `Line ${d.line}: the keep region "${d.id}" says kind "${d.kind}", but the block is a ${node.block.kind}; the block was kept as it is.`,
            at: d.id,
          });
        if (normaliseRegionText(readableLines(node.block).join('\n')) !== d.inner)
          st.warnings.push({
            code: 'KEEP_REGION_EDITED',
            message: `Line ${d.line}: changes inside the keep region "${d.id}" (${node.block.kind}) were ignored; a keep region is restored exactly. To change that block, replace the region with a fenced lk-block holding its JSON.`,
            at: d.id,
          });
        st.claimed.add(d.id);
      } else if (d.t === 'raw') {
        const id = d.block.id;
        if (typeof id === 'string') {
          const prev = seen.get(id);
          if (prev !== undefined)
            throw new MarkdownError(
              'DUPLICATE_BLOCK_ID',
              `Lines ${prev} and ${d.line} both use block id "${id}".`,
              {
                id,
                lines: [prev, d.line],
              },
            );
          seen.set(id, d.line);
          st.claimed.add(id);
          if (scope !== null && st.base.byId.has(id) && !scope.has(id))
            throw new MarkdownError(
              'DUPLICATE_BLOCK_ID',
              `Line ${d.line}: block id "${id}" belongs to another part of the page, which stays as it is.`,
              { id, line: d.line },
            );
        }
        // Every unsupported block in it, at any depth, must echo one the page holds.
        const check = (b: unknown, depth: number): void => {
          if (!isObj(b) || depth > 200) return;
          if (b.kind === 'unsupported') {
            const held = typeof b.id === 'string' ? st.base.byId.get(b.id) : undefined;
            if (!held || held.kind !== 'unsupported')
              throw new MarkdownError(
                'UNSUPPORTED_KIND',
                `Line ${d.line}: an unsupported block can only be kept (echoed by the id of one the page holds), never created.`,
                { line: d.line },
              );
          }
          if (Array.isArray(b.children)) for (const c of b.children as unknown[]) check(c, depth + 1);
        };
        check(d.block, 0);
      } else if (d.children) walk(d.children);
    }
  };
  walk(drafts);
}

// ------------------------------------------------------------------------------------------------ alignment

function claimedNode(n: ANode, st: State): boolean {
  if (n.keepId !== null && st.claimed.has(n.keepId)) return true;
  return typeof n.block.id === 'string' && st.claimed.has(n.block.id);
}

function isRegion(n: ANode, st: State): boolean {
  return n.keep !== null || st.base.page.forced.has(n);
}

function nodeFp(n: ANode, st: State): number {
  if (claimedNode(n, st)) return st.interner.fresh();
  if (st.base.page.forced.has(n)) return st.interner.id(`K:${n.keepId}`);
  return fingerprint(n, st.interner);
}

function draftText(d: Draft): string {
  if (d.t !== 'block') return '';
  const own = d.own;
  if (Array.isArray(own.content)) return runsPlainText(own.content);
  if (typeof own.text === 'string') return own.text;
  if (typeof own.url === 'string') return `${own.url} ${typeof own.alt === 'string' ? own.alt : ''}`;
  if (typeof own.title === 'string' && !d.children) return own.title;
  return (d.children ?? []).map(draftText).join(' ').slice(0, 4000);
}

function nodeText(n: ANode): string {
  const b = n.block;
  if (Array.isArray(b.content)) return runsPlainText(b.content);
  if (typeof b.text === 'string') return b.text;
  if (typeof b.url === 'string') return `${b.url} ${typeof b.alt === 'string' ? b.alt : ''}`;
  if (typeof b.title === 'string' && !CONTAINER_KINDS.has(b.kind)) return b.title;
  return n.children.map(nodeText).join(' ').slice(0, 4000);
}

/** Aligns the drafts of one container level with its current blocks and builds the new children. */
/** Marks a node and everything under it as placed (a verbatim block brings its whole subtree). */
function useSubtree(n: ANode, st: State): void {
  st.used.add(n);
  for (const c of n.children) useSubtree(c, st);
}

/** Aligns the drafts of one container level with its current blocks and builds the new children. */
function alignLevel(baseNodes: readonly ANode[], drafts: readonly Draft[], st: State): LkBlock[] {
  const fa = baseNodes.map((n) => nodeFp(n, st));
  const fb = drafts.map((d) => (d.t === 'block' ? draftFingerprint(d, st.interner) : st.interner.fresh()));
  const matches = lcsPairs(fa, fb);
  const result = new Array<LkBlock | null>(drafts.length).fill(null);
  const usedA = new Set<number>();
  for (const [i, j] of matches) {
    result[j] = baseNodes[i]!.block; // verbatim: the same object
    usedA.add(i);
    useSubtree(baseNodes[i]!, st);
  }
  // Moves within the level: an unchanged block written elsewhere among its siblings is still that block.
  const pool = new Map<number, number[]>();
  baseNodes.forEach((_, i) => {
    if (usedA.has(i) || fa[i]! < 0) return;
    pool.set(fa[i]!, [...(pool.get(fa[i]!) ?? []), i]);
  });
  drafts.forEach((d, j) => {
    if (result[j] || d.t !== 'block') return;
    const i = pool.get(fb[j]!)?.shift();
    if (i === undefined) return;
    result[j] = baseNodes[i]!.block;
    usedA.add(i);
    useSubtree(baseNodes[i]!, st);
  });
  // Edits: in each gap between matches, pair the rest by kind and similarity.
  const pairOf = new Map<number, ANode>();
  let pa = 0;
  let pb = 0;
  const gap = (a1: number, b1: number) => {
    const ai: number[] = [];
    for (let i = pa; i < a1; i++) if (!usedA.has(i)) ai.push(i);
    const bj: number[] = [];
    for (let j = pb; j < b1; j++) if (!result[j]) bj.push(j);
    const pairs = pairGap(
      ai.map((i) => {
        const n = baseNodes[i]!;
        return { kind: n.block.kind, text: nodeText(n), pairable: !isRegion(n, st) && !claimedNode(n, st) };
      }),
      bj.map((j) => {
        const d = drafts[j]!;
        return { kind: d.t === 'block' ? d.own.kind : '', text: draftText(d), pairable: d.t === 'block' };
      }),
    );
    for (const [x, y] of pairs) pairOf.set(bj[y]!, baseNodes[ai[x]!]!);
  };
  for (const [i, j] of matches) {
    gap(i, j);
    pa = i + 1;
    pb = j + 1;
  }
  gap(baseNodes.length, drafts.length);
  for (const n of pairOf.values()) st.used.add(n);
  const out: LkBlock[] = [];
  drafts.forEach((d, j) => {
    const done = result[j];
    if (done) out.push(done);
    else if (d.t === 'keep') out.push(restoreKeep(d, st));
    else if (d.t === 'raw') out.push(d.block);
    else {
      const paired = pairOf.get(j);
      if (paired) out.push(merge(paired, d, st));
      else {
        // New here: decided in the second pass, once every level has taken what it matches.
        st.pending.push({ into: out, at: out.length, draft: d });
        out.push(PENDING);
      }
    }
  });
  return out;
}

const PENDING: LkBlock = { kind: '(pending)' };

/**
 * The second pass: a block that is new where it stands may be an unchanged block of the page written somewhere else
 * (wrapped in a quote or secret, taken out of one, moved into another container). It is restored verbatim, keeping its
 * id and every attribute; anything else is new.
 */
function placePending(st: State): void {
  const pool = new Map<number, ANode[]>();
  const walk = (list: readonly ANode[]) => {
    for (const n of list) {
      if (!st.used.has(n) && !isRegion(n, st) && !claimedNode(n, st)) {
        const fp = nodeFp(n, st);
        if (fp >= 0) pool.set(fp, [...(pool.get(fp) ?? []), n]);
      }
      if (!isRegion(n, st)) walk(n.children);
    }
  };
  walk(st.base.page.nodes);
  const free = (n: ANode): boolean => !st.used.has(n) && n.children.every(free);
  const resolve = (d: DraftBlock): LkBlock => {
    const candidates = pool.get(draftFingerprint(d, st.interner)) ?? [];
    const n = candidates.find(free);
    if (n) {
      useSubtree(n, st);
      return n.block;
    }
    return fresh(d, st, resolve);
  };
  for (const p of st.pending) p.into[p.at] = resolve(p.draft);
}

function restoreKeep(d: DraftKeep, st: State): LkBlock {
  return st.base.regions.get(d.id)!.block;
}

/**
 * Runs from the Markdown, reusing the page's own mention objects where the label is unchanged: first those of the block
 * being edited (in order), then any on the page.
 */
function reuseMentions(content: unknown, st: State, own?: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const local = Array.isArray(own)
    ? own.filter((r): r is Obj => isObj(r) && isObj(r.mention)).map((r) => r.mention as Obj)
    : [];
  return content.map((r: unknown) => {
    if (!isObj(r) || !isObj(r.mention)) return r;
    const m = r.mention;
    const label = typeof m.text === 'string' ? m.text : '';
    if (label === '') return r;
    const key = mentionKey(m.resourceId, m.documentId, label);
    const i = local.findIndex((x) => mentionKey(x.resourceId, x.documentId, mentionLabel(x)) === key);
    if (i >= 0) return { mention: local.splice(i, 1)[0] };
    const orig = st.base.mentions.get(key);
    return orig ? { mention: orig } : r;
  });
}

function merge(n: ANode, d: DraftBlock, st: State): LkBlock {
  const b = n.block;
  const shown = SHOWN_FIELDS[b.kind] ?? [];
  const take = (k: string) => (k === 'content' ? reuseMentions(d.own[k], st, b.content) : d.own[k]);
  // The current block's fields, in their order, with the shown ones taken from the Markdown.
  const out = {} as LkBlock;
  for (const [k, v] of Object.entries(b)) {
    if (k === 'children') continue;
    if (!shown.includes(k)) out[k] = v;
    else if (d.own[k] !== undefined) out[k] = take(k);
  }
  for (const k of shown) {
    if (k in out || d.own[k] === undefined) continue;
    out[k] = take(k);
  }
  if (CONTAINER_KINDS.has(b.kind)) out.children = alignLevel(projectedChildren(n), d.children ?? [], st);
  st.origin.set(out, b);
  return out;
}

function fresh(d: DraftBlock, st: State, child: (d: DraftBlock) => LkBlock): LkBlock {
  const out: LkBlock = { ...(st.ctx.mintBlockId ? { id: st.ctx.mintBlockId() } : {}), ...d.own };
  if (Array.isArray(out.content)) out.content = reuseMentions(out.content, st);
  if (d.children)
    out.children = d.children.map((c) =>
      c.t === 'keep' ? restoreKeep(c, st) : c.t === 'raw' ? c.block : child(c),
    );
  return out;
}

// ------------------------------------------------------------------------------------------------ the plan

interface Entry {
  readonly block: LkBlock;
  readonly parent: LkBlock | null;
  readonly index: number;
  readonly depth: number;
  readonly ancestors: readonly LkBlock[];
}

function index(blocks: readonly LkBlock[]): Entry[] {
  const out: Entry[] = [];
  const walk = (list: readonly unknown[], parent: LkBlock | null, ancestors: LkBlock[], depth: number) => {
    list.forEach((x, i) => {
      if (!isObj(x)) return;
      const b = x as LkBlock;
      out.push({ block: b, parent, index: i, depth, ancestors });
      if (Array.isArray(b.children)) walk(b.children, b, [...ancestors, b], depth + 1);
    });
  };
  walk(blocks, null, [], 1);
  return out;
}

function ownEqual(a: LkBlock, b: LkBlock): boolean {
  if (a === b) return true;
  const strip = (x: LkBlock) => {
    const o: Obj = {};
    for (const [k, v] of Object.entries(x)) if (k !== 'children') o[k] = v;
    return o;
  };
  return jsonEqual(strip(a), strip(b));
}

const idOrNull = (b: LkBlock | null): string | null => (b && typeof b.id === 'string' ? b.id : null);

export interface PlanResult {
  readonly plan: WritePlan;
  /** Result blocks that are new or whose own fields changed, or that moved, with their place in the result. */
  readonly touched: readonly Entry[];
  /** The current page's entry for a result block that derives from one (to tell old problems from new ones). */
  readonly baseEntryOf: (b: LkBlock) => Entry | undefined;
}

export function computePlan(
  base: BasePage,
  result: readonly LkBlock[],
  origin: ReadonlyMap<LkBlock, LkBlock>,
): PlanResult {
  const before = index(base.blocks);
  const after = index(result);
  // A block is known by its id when the page holds that id once; otherwise (no id, or a legacy page repeating an id)
  // by the object it was restored or edited from.
  const idCount = new Map<string, number>();
  for (const e of before)
    if (typeof e.block.id === 'string') idCount.set(e.block.id, (idCount.get(e.block.id) ?? 0) + 1);
  const uniqueId = (b: LkBlock): string | null =>
    typeof b.id === 'string' && idCount.get(b.id) === 1 ? b.id : null;
  const keyOf = (b: LkBlock): unknown => uniqueId(b) ?? b;
  const beforeByKey = new Map<unknown, Entry>();
  for (const e of before) if (!beforeByKey.has(keyOf(e.block))) beforeByKey.set(keyOf(e.block), e);
  const afterKey = (b: LkBlock): unknown => {
    const o = origin.get(b);
    if (o) return keyOf(o);
    if (typeof b.id === 'string' && !idCount.has(b.id)) return b.id; // a new id
    return keyOf(b);
  };
  const afterKeys = new Set<unknown>();
  const changed: (PlanBlockRef & { before: LkBlock; after: LkBlock })[] = [];
  const added: (PlanBlockRef & { block: LkBlock; afterId: string | null })[] = [];
  const moved: (PlanBlockRef & { fromParentId: string | null; fromIndex: number })[] = [];
  const touched: Entry[] = [];
  const addedSet = new Set<LkBlock>();
  let kept = 0;
  // Children order per parent, for moves within a parent.
  const orderAfter = new Map<unknown, unknown[]>();
  for (const e of after) {
    const k = afterKey(e.block);
    afterKeys.add(k);
    const b = beforeByKey.get(k);
    const ref = { id: idOrNull(e.block), kind: e.block.kind, parentId: idOrNull(e.parent), index: e.index };
    if (!b) {
      if (!(e.parent && addedSet.has(e.parent))) {
        const prevSibling =
          e.index > 0 ? (e.parent ? (e.parent.children as LkBlock[]) : result)[e.index - 1] : undefined;
        added.push({ ...ref, block: e.block, afterId: prevSibling ? idOrNull(prevSibling) : null });
      }
      addedSet.add(e.block);
      touched.push(e);
      continue;
    }
    const pk = e.parent ? afterKey(e.parent) : null;
    const bpk = b.parent ? keyOf(b.parent) : null;
    if (!ownEqual(b.block, e.block)) {
      changed.push({ ...ref, before: b.block, after: e.block });
      touched.push(e);
    } else kept++;
    if (pk !== bpk) {
      moved.push({ ...ref, fromParentId: idOrNull(b.parent), fromIndex: b.index });
      touched.push(e);
    } else {
      const list = orderAfter.get(pk) ?? [];
      list.push(k);
      orderAfter.set(pk, list);
    }
  }
  // Moves within the same parent: survivors out of their old relative order.
  const orderBefore = new Map<unknown, unknown[]>();
  for (const e of before) {
    const k = keyOf(e.block);
    if (!afterKeys.has(k)) continue;
    const pk = e.parent ? keyOf(e.parent) : null;
    const list = orderBefore.get(pk) ?? [];
    list.push(k);
    orderBefore.set(pk, list);
  }
  const afterEntryByKey = new Map<unknown, Entry>();
  for (const e of after) afterEntryByKey.set(afterKey(e.block), e);
  for (const [pk, list] of orderAfter) {
    const inList = new Set(list);
    const old = (orderBefore.get(pk) ?? []).filter((k) => inList.has(k));
    if (old.length === list.length && old.every((k, i) => k === list[i])) continue;
    const ids = new Map<unknown, number>();
    const fa = old.map((k) => ids.get(k) ?? (ids.set(k, ids.size + 1), ids.size));
    const fb = list.map((k) => ids.get(k) ?? -1);
    const keep = new Set(lcsPairs(fa, fb).map(([, j]) => j));
    list.forEach((k, j) => {
      if (keep.has(j)) return;
      const e = afterEntryByKey.get(k)!;
      const b = beforeByKey.get(k)!;
      moved.push({
        id: idOrNull(e.block),
        kind: e.block.kind,
        parentId: idOrNull(e.parent),
        index: e.index,
        fromParentId: idOrNull(b.parent),
        fromIndex: b.index,
      });
      touched.push(e);
    });
  }
  const removed: PlanBlockRef[] = [];
  const removedKeys = new Set<unknown>();
  for (const e of before) {
    const k = keyOf(e.block);
    if (afterKeys.has(k)) continue;
    removedKeys.add(k);
    if (e.parent && removedKeys.has(keyOf(e.parent))) continue;
    removed.push({ id: idOrNull(e.block), kind: e.block.kind, parentId: idOrNull(e.parent), index: e.index });
  }
  const droppedRegions: KeepRegion[] = [];
  for (const [id, n] of base.regions) {
    if (!afterKeys.has(keyOf(n.block)))
      droppedRegions.push({ id, kind: n.block.kind, reason: n.keep ?? base.page.forced.get(n) ?? '' });
  }
  // Parents whose child list changed: their children are checked against the editor rules too.
  const touchedParents = new Set<LkBlock | null>();
  for (const e of touched) touchedParents.add(e.parent);
  const afterById = new Map<string, LkBlock>();
  for (const e of after) if (typeof e.block.id === 'string') afterById.set(e.block.id, e.block);
  for (const r of removed) {
    const p = r.parentId === null ? null : afterById.get(r.parentId);
    if (p !== undefined) touchedParents.add(p);
  }
  const touchedSet = new Set(touched);
  for (const e of after) if (touchedParents.has(e.parent) && !touchedSet.has(e)) touched.push(e);
  const empty = changed.length === 0 && added.length === 0 && removed.length === 0 && moved.length === 0;
  return {
    plan: { empty, kept, changed, added, removed, moved, droppedRegions },
    touched,
    baseEntryOf: (b) => beforeByKey.get(afterKey(b)),
  };
}

// ------------------------------------------------------------------------------------------------ checks

function checkResult(
  base: BasePage,
  result: readonly LkBlock[],
  planRes: PlanResult,
  st: State,
  opts: FromMarkdownOptions,
): void {
  // Duplicate ids anywhere in the result (ids the page itself already repeats, as legacy pages can, are its own).
  const count = (blocks: readonly LkBlock[]) => {
    const ids = new Map<string, number>();
    for (const e of index(blocks)) {
      const id = e.block.id;
      if (typeof id === 'string') ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    return ids;
  };
  const before = count(base.blocks);
  const dups = [...count(result)].filter(([id, n]) => n > 1 && n > (before.get(id) ?? 0)).map(([id]) => id);
  if (dups.length > 0)
    throw new MarkdownError(
      'DUPLICATE_BLOCK_ID',
      `Block id${dups.length > 1 ? 's' : ''} ${dups.map((d) => `"${d}"`).join(', ')} would appear more than once. An lk-block may reuse the id of the block it replaces, and that block must then be left out.`,
      { ids: dups },
    );
  // Missing keep regions.
  const drop = new Set(opts.dropRegions ?? []);
  const missing = planRes.plan.droppedRegions.filter((r) => !drop.has(r.id));
  if (missing.length > 0)
    throw new MarkdownError(
      'KEEP_REGIONS_MISSING',
      `This write would delete ${missing.length} block${missing.length > 1 ? 's' : ''} shown as keep regions: ${missing
        .map((r) => `${r.id} (${r.kind})`)
        .join(
          ', ',
        )}. Put each <!-- lk:keep … --> … <!-- /lk:keep --> back where it belongs, or, to delete them on purpose, pass dropRegions with their ids.`,
      { ids: missing.map((r) => r.id), regions: missing },
    );
  const droppedIds = new Set(planRes.plan.droppedRegions.map((r) => r.id));
  for (const id of drop)
    if (!droppedIds.has(id))
      st.warnings.push({
        code: 'DROP_REGION_NOT_MISSING',
        message: `dropRegions names "${id}", which this write keeps (or which is not a keep region of this page).`,
        at: id,
      });
  // The job engine's unsupported-block guard, applied to the whole result.
  const lost = unsupportedLoss(base.blocks, result);
  if (lost.length > 0 && opts.allowUnsupportedLoss !== true)
    throw new MarkdownError(
      'UNSUPPORTED_BLOCK_LOSS',
      `This write would delete ${lost.length} unsupported block${lost.length > 1 ? 's' : ''} (${lost.join(', ')}): content LegendKeeper's API cannot show and cannot recreate. Keep their regions, or pass allowUnsupportedLoss with dropRegions to delete them on purpose.`,
      { blockIds: lost },
    );
  // Limits, for what is new or changed.
  if (result.length > MAX_DOCUMENT_BLOCKS && result.length > base.blocks.length)
    throw new MarkdownError(
      'FIELD_LIMIT',
      `A page holds at most ${MAX_DOCUMENT_BLOCKS} top-level blocks; this would make ${result.length}.`,
      { limit: MAX_DOCUMENT_BLOCKS, count: result.length },
    );
  const problems: LimitProblem[] = [];
  const addedOrChanged = new Set<LkBlock>([
    ...planRes.plan.changed.map((c) => c.after),
    ...index(planRes.plan.added.map((a) => a.block)).map((e) => e.block),
  ]);
  const seen = new Set<LkBlock>();
  for (const e of planRes.touched) {
    if (seen.has(e.block)) continue;
    seen.add(e.block);
    // A rule the block already broke in the same place on the current page is LegendKeeper's own content: not refused.
    const was = planRes.baseEntryOf(e.block);
    const old = was
      ? new Set(editorProblems(was.block, { ancestors: was.ancestors, index: was.index }).map((x) => x.rule))
      : null;
    problems.push(
      ...editorProblems(e.block, { ancestors: e.ancestors, index: e.index }).filter((x) => !old?.has(x.rule)),
    );
    if (addedOrChanged.has(e.block)) {
      problems.push(...fieldProblems(e.block, e.depth));
      imageProblems(e.block, base, st, problems);
    }
  }
  if (problems.length > 0) {
    const first = problems[0]!;
    const list = problems
      .slice(0, 10)
      .map((p) => `${p.kind}${p.blockId ? ` ${p.blockId}` : ''}: ${p.message}`)
      .join(' ');
    throw new MarkdownError(
      first.code,
      `The new content breaks ${problems.length} limit${problems.length > 1 ? 's' : ''}. ${list}`,
      {
        problems: problems.slice(0, 50),
        ...(first.rule ? { rule: first.rule } : {}),
      },
    );
  }
}

function imageProblems(b: LkBlock, base: BasePage, st: State, out: LimitProblem[]): void {
  if (b.kind !== 'image' || typeof b.url !== 'string') return;
  const url = b.url;
  const id = typeof b.id === 'string' ? b.id : null;
  const refuse = (message: string) => {
    throw new MarkdownError('IMAGE_URL_REFUSED', message, { url, blockId: id });
  };
  if (/^(data|blob):/i.test(url))
    refuse('Images cannot be inline data. Upload the image (upload_image) and use the asset URL it returns.');
  if (base.imageUrls.has(url)) return;
  if (st.ctx.isProjectAsset) {
    if (!st.ctx.isProjectAsset(url))
      refuse(
        `${url} is not an image asset of this project. Upload it first (upload_image) and use the asset URL it returns.`,
      );
    return;
  }
  if (!/^https:\/\//i.test(url))
    refuse(`${url} is not an https URL of an image asset. Upload it first and use the asset URL.`);
  st.warnings.push({
    code: 'IMAGE_URL_UNCHECKED',
    message: `${url} could not be checked against the project's assets here; LegendKeeper refuses it if it is not one.`,
    ...(id ? { at: id } : {}),
  });
  void out;
}

// ------------------------------------------------------------------------------------------------ entry point

export interface RebuildInput {
  readonly base: BasePage;
  /** The top-level range of the current page being replaced: [start, end). */
  readonly start: number;
  readonly end: number;
  readonly drafts: readonly Draft[];
  /** True for append modes: nothing in the range is matched (the range is empty). */
  readonly ctx: FromMarkdownContext;
  readonly opts: FromMarkdownOptions;
  readonly warnings: MarkdownWarning[];
}

export interface RebuildOutput {
  readonly blocks: LkBlock[];
  readonly plan: WritePlan;
  readonly warnings: MarkdownWarning[];
}

/** Replaces top-level blocks [start, end) of the current page with the drafts, aligned against them. */
export function rebuild(input: RebuildInput): RebuildOutput {
  const { base, start, end, drafts } = input;
  const st: State = {
    base,
    ctx: input.ctx,
    warnings: input.warnings,
    interner: new Interner(),
    claimed: new Set(),
    origin: new Map(),
    used: new Set(),
    pending: [],
  };
  const fullRange = start === 0 && end === base.page.nodes.length;
  let scope: Set<string> | null = null;
  if (!fullRange) {
    scope = new Set();
    const collect = (list: readonly ANode[]) => {
      for (const n of list) {
        if (n.keepId !== null) scope!.add(n.keepId);
        if (typeof n.block.id === 'string') scope!.add(n.block.id);
        collect(n.children);
      }
    };
    collect(base.page.nodes.slice(start, end));
  }
  preCheck(drafts, st, scope);
  const middle = alignLevel(base.page.nodes.slice(start, end), drafts, st);
  // Blocks outside the edited range stay where they are: they cannot be taken by a move.
  for (const n of [...base.page.nodes.slice(0, start), ...base.page.nodes.slice(end)]) useSubtree(n, st);
  placePending(st);
  const blocks = [...base.blocks.slice(0, start), ...middle, ...base.blocks.slice(end)];
  const planRes = computePlan(base, blocks, st.origin);
  checkResult(base, blocks, planRes, st, input.opts);
  return { blocks: structuredClone(blocks), plan: structuredClone(planRes.plan), warnings: st.warnings };
}

export type { DraftRaw };
