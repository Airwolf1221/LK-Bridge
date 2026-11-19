/**
 * v3 F3e (ADR 0059): the split's work on blocks, pure (the planner, the job's fillers, its checks and its rebasers all use
 * it, so what is planned, what is written inside the lock and what is verified are worked out the same way).
 *
 * - **The outline** of the source's main document: every heading (any level) with the top-level blocks it covers (to the
 *   next heading of its level or higher), so a section is assigned whole, and a block inside it on its own (D1).
 * - **Fingerprints**: a block as planned (its JSON without versions), so the job moves exactly what the owner saw.
 * - **The source edit** of one item: its blocks removed, its interface summaries (or a universal item's application
 *   text) put where its first block was. Done, not done, or changed meanwhile: never anything in between.
 * - **The append** to an existing owner: the moved blocks, verbatim, under the heading the agent gives (found, or made
 *   before the page's boundary sections); a block id the page already uses is replaced by a derived one (said).
 * - **The routing line** of a new page in its character's index.
 * - **The content check**: every original block is in exactly one place (its home), by id, with its text unchanged.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../../jobs/sidebar-state.js';
import { withoutVersions } from '../../pages/blockwise.js';
import { textKey } from '../engine/text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// ============================================================================================ text and ids

/** The text of a block and everything under it (mentions by their label), one line. */
export function blockText(b: Obj): string {
  const parts: string[] = [];
  if (Array.isArray(b.content))
    parts.push(
      (b.content as unknown[])
        .map((r) =>
          isObj(r)
            ? typeof r.text === 'string'
              ? r.text
              : isObj(r.mention)
                ? (str(r.mention.text) ?? str(r.mention.name) ?? '')
                : ''
            : '',
        )
        .join(''),
    );
  else if (typeof b.text === 'string') parts.push(b.text);
  if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) parts.push(blockText(c));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** A block as planned: its JSON without the per-block versions, hashed. */
export function fingerprint(b: Obj): string {
  return createHash('sha256')
    .update(stableJson(withoutVersions([b])[0]))
    .digest('hex')
    .slice(0, 32);
}

/** The text of a block as the content check compares it (whitespace and case aside). */
export const textPrint = (b: Obj): string =>
  createHash('sha256')
    .update(textKey(blockText(b)))
    .digest('hex')
    .slice(0, 24);

/** Every block id in a tree of blocks (top level and below). */
export function idsIn(blocks: readonly unknown[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (typeof b.id === 'string') out.add(b.id);
    if (Array.isArray(b.children)) idsIn(b.children, out);
  }
  return out;
}

/**
 * The id a moved block takes when its destination already uses its own (a lowercase letter and 23 more, as LegendKeeper
 * mints them): derived from the item and the old id, so the job, a resume and the content check all agree.
 */
export function altId(item: string, id: string): string {
  const h = createHash('sha256').update(`${item}\u0000${id}`).digest('hex');
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return `${letters[parseInt(h.slice(0, 2), 16) % 26]}${h.slice(2, 25).replace(/[^a-z0-9]/g, '0')}`;
}

/** A moved block with every id inside it that the destination already uses replaced (and the replacements). */
export function withFreeIds(
  b: Obj,
  item: string,
  taken: ReadonlySet<string>,
): { block: Obj; renamed: Record<string, string> } {
  const renamed: Record<string, string> = {};
  const walk = (x: Obj): Obj => {
    const out: Obj = { ...x };
    if (typeof x.id === 'string' && taken.has(x.id)) {
      const n = altId(item, x.id);
      renamed[x.id] = n;
      out.id = n;
    }
    if (Array.isArray(x.children))
      out.children = (x.children as unknown[]).map((c) => (isObj(c) ? walk(c) : c));
    return out;
  };
  return { block: walk(b), renamed };
}

// ============================================================================================ the outline

/** A heading of the source and the top-level blocks it covers (itself first). */
export interface OutlineHeading {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  /** The top-level blocks from the heading to the next heading of its level or higher. */
  readonly blockIds: readonly string[];
  /** The heading's top-level section (the outermost heading that covers it): itself at the top level. */
  readonly top: string;
}

export interface SourceOutline {
  readonly headings: readonly OutlineHeading[];
  /** The top-level blocks before the first heading (assigned as `(preamble)`). */
  readonly preamble: readonly string[];
  /** Every top-level block id, in order. */
  readonly order: readonly string[];
  /** Top-level blocks by id. */
  readonly byId: ReadonlyMap<string, Obj>;
}

export const PREAMBLE = '(preamble)';

export function outlineOf(blocks: readonly Obj[]): SourceOutline {
  const order: string[] = [];
  const byId = new Map<string, Obj>();
  for (const b of blocks) {
    const id = str(b.id);
    if (!id) continue;
    order.push(id);
    byId.set(id, b);
  }
  const levelOf = (b: Obj) => (typeof b.level === 'number' ? b.level : 1);
  const headings: OutlineHeading[] = [];
  const top = blocks.filter((b) => b.kind === 'heading').map(levelOf);
  const topLevel = top.length ? Math.min(...top) : 1;
  let currentTop = '';
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading' || typeof b.id !== 'string') return;
    const level = levelOf(b);
    if (level <= topLevel) currentTop = b.id;
    const ids: string[] = [b.id];
    for (let j = i + 1; j < blocks.length; j++) {
      const n = blocks[j]!;
      if (n.kind === 'heading' && levelOf(n) <= level) break;
      if (typeof n.id === 'string') ids.push(n.id);
    }
    headings.push({ id: b.id, title: blockText(b), level, blockIds: ids, top: currentTop || b.id });
  });
  const firstHeading = blocks.findIndex((b) => b.kind === 'heading');
  const preamble = (firstHeading < 0 ? blocks : blocks.slice(0, firstHeading))
    .map((b) => str(b.id))
    .filter((x): x is string => x !== null);
  return { headings, preamble, order, byId };
}

/** The heading a map entry names: its block id, else its text (exactly one), else null; `ambiguous` when several. */
export function findHeading(
  o: SourceOutline,
  section: string,
): { heading: OutlineHeading } | { ambiguous: OutlineHeading[] } | null {
  const byId = o.headings.find((h) => h.id === section);
  if (byId) return { heading: byId };
  const hits = o.headings.filter((h) => textKey(h.title) === textKey(section));
  if (hits.length === 1) return { heading: hits[0]! };
  if (hits.length > 1) return { ambiguous: hits };
  return null;
}

/** Whether a block (or anything inside it) is one LegendKeeper cannot create (`unsupported`): it can only stay. */
export function holdsUnsupported(b: Obj): boolean {
  if (b.kind === 'unsupported') return true;
  return Array.isArray(b.children) && (b.children as unknown[]).some((c) => isObj(c) && holdsUnsupported(c));
}

/** Whether a block shows an image (anywhere inside it). */
export function holdsImage(b: Obj): boolean {
  if (b.kind === 'image') return true;
  return Array.isArray(b.children) && (b.children as unknown[]).some((c) => isObj(c) && holdsImage(c));
}

/** The pages a block mentions (anywhere inside it). */
export function mentionedIn(b: Obj, out = new Set<string>()): Set<string> {
  if (Array.isArray(b.content))
    for (const r of b.content as unknown[])
      if (isObj(r) && isObj(r.mention) && typeof r.mention.resourceId === 'string')
        out.add(r.mention.resourceId);
  if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) mentionedIn(c, out);
  return out;
}

// ============================================================================================ the source edit

/** One item's edit of the source: its blocks removed; new blocks (a summary, an application text) in their places. */
export interface SourceEditInput {
  readonly item: string;
  /** The blocks it removes, in document order, with their fingerprints as planned. */
  readonly remove: readonly { readonly id: string; readonly fp: string }[];
  /** New blocks, each group placed before one of the removed blocks (it takes that block's place). */
  readonly inserts: readonly { readonly before: string; readonly blocks: readonly Obj[] }[];
  /** For the owner: where (the page and the sections). */
  readonly where: string;
}

export type SourceEditOutcome =
  | { readonly state: 'apply'; readonly blocks: Obj[] }
  | { readonly state: 'done' }
  | {
      readonly state: 'changed';
      readonly why: string;
      readonly before: string | null;
      readonly after: string | null;
    };

/** The source edit on the document as it is now (see SourceEditInput). */
export function applySourceEdit(current: readonly Obj[], e: SourceEditInput): SourceEditOutcome {
  const top = new Map(current.map((b) => [str(b.id) ?? '', b]));
  const present = e.remove.filter((r) => top.has(r.id));
  const insertIds = e.inserts.flatMap((g) => g.blocks.map((b) => str(b.id) ?? '')).filter((x) => x !== '');
  const inserted = insertIds.filter((id) => top.has(id));
  if (present.length === 0 && inserted.length === insertIds.length) return { state: 'done' };
  if (present.length !== e.remove.length || inserted.length > 0) {
    const missing = e.remove.filter((r) => !top.has(r.id)).map((r) => r.id);
    return {
      state: 'changed',
      why:
        inserted.length > 0
          ? `part of this item is in the source already (${inserted.length} of its ${insertIds.length} new blocks), the rest is not`
          : `${missing.length} of its ${e.remove.length} blocks are gone from the source (${missing.slice(0, 5).join(', ')})`,
      before: null,
      after: null,
    };
  }
  const changed = e.remove.find((r) => fingerprint(top.get(r.id)!) !== r.fp);
  if (changed)
    return {
      state: 'changed',
      why: `the block ${changed.id} changed in the source since the plan (it would be moved as it was, and the change lost)`,
      before: null,
      after: blockText(top.get(changed.id)!).slice(0, 300),
    };
  const removed = new Set(e.remove.map((r) => r.id));
  const before = new Map(e.inserts.map((g) => [g.before, g.blocks]));
  const out: Obj[] = [];
  for (const b of current) {
    const id = str(b.id) ?? '';
    const ins = before.get(id);
    if (ins) out.push(...ins.map((x) => ({ ...x })));
    if (!removed.has(id)) out.push(b);
  }
  return { state: 'apply', blocks: out };
}

// ============================================================================================ the append

/** An existing owner's append: the moved blocks under the agent's heading. */
export interface AppendInput {
  readonly item: string;
  /** The heading the blocks go under (found by its text, or made). */
  readonly under: string;
  /** The level a heading made here takes. */
  readonly level: number;
  /** The id a heading made here takes (minted when the plan was made, so a resume finds it). */
  readonly headingId: string;
  readonly blocks: readonly Obj[];
  /** Sections a new heading goes before (Source Boundaries, Unresolved Material), when the page has them. */
  readonly boundaries: readonly string[];
  readonly where: string;
}

export type AppendOutcome =
  | {
      readonly state: 'apply';
      readonly blocks: Obj[];
      readonly renamed: Record<string, string>;
      readonly madeHeading: boolean;
    }
  | { readonly state: 'done' };

/** The moved blocks as they land (their ids, or the derived ones where the page used them) on a page's blocks. */
export function landedIds(item: string, planned: readonly Obj[], current: readonly Obj[]): string[] {
  const ids = new Set(current.map((b) => str(b.id) ?? ''));
  return planned.map((b) => {
    const id = str(b.id) ?? '';
    return ids.has(id) ? id : altId(item, id);
  });
}

export function applyAppend(current: readonly Obj[], a: AppendInput): AppendOutcome {
  const topIds = new Set(current.map((b) => str(b.id) ?? ''));
  // Already there (a resumed job, or a write whose answer was lost): every moved block, by its id or its derived id.
  const there = a.blocks.every((b) => {
    const id = str(b.id) ?? '';
    return topIds.has(id) || topIds.has(altId(a.item, id));
  });
  if (there && a.blocks.length > 0) return { state: 'done' };
  const taken = idsIn(current);
  const renamed: Record<string, string> = {};
  const moved = a.blocks.map((b) => {
    const r = withFreeIds(b, a.item, taken);
    Object.assign(renamed, r.renamed);
    return r.block;
  });
  const levelOf = (b: Obj) => (typeof b.level === 'number' ? b.level : 1);
  const at = current.findIndex((b) => b.kind === 'heading' && textKey(blockText(b)) === textKey(a.under));
  if (at >= 0) {
    const lvl = levelOf(current[at]!);
    let end = current.length;
    for (let j = at + 1; j < current.length; j++)
      if (current[j]!.kind === 'heading' && levelOf(current[j]!) <= lvl) {
        end = j;
        break;
      }
    return {
      state: 'apply',
      blocks: [...current.slice(0, end), ...moved, ...current.slice(end)],
      renamed,
      madeHeading: false,
    };
  }
  const heading: Obj = { id: a.headingId, kind: 'heading', level: a.level, content: [{ text: a.under }] };
  const keys = new Set(a.boundaries.map(textKey));
  const boundary = current.findIndex((b) => b.kind === 'heading' && keys.has(textKey(blockText(b))));
  const pos = boundary >= 0 ? boundary : current.length;
  return {
    state: 'apply',
    blocks: [...current.slice(0, pos), heading, ...moved, ...current.slice(pos)],
    renamed,
    madeHeading: true,
  };
}

// ============================================================================================ the routing line

/** A new page's line in its character's index ("How to Use This Index"). */
export interface RouteInput {
  readonly item: string;
  readonly section: string;
  /** The line: a list item mentioning the new page. */
  readonly line: Obj;
  /** The list a line goes in when the section has none (its id minted when the plan was made). */
  readonly listId: string;
  readonly pageId: string;
  readonly where: string;
}

export type RouteOutcome =
  | { readonly state: 'apply'; readonly blocks: Obj[] }
  | { readonly state: 'done' }
  | { readonly state: 'missing'; readonly why: string };

export function applyRoute(current: readonly Obj[], r: RouteInput): RouteOutcome {
  const levelOf = (b: Obj) => (typeof b.level === 'number' ? b.level : 1);
  const at = current.findIndex((b) => b.kind === 'heading' && textKey(blockText(b)) === textKey(r.section));
  if (at < 0) return { state: 'missing', why: `the index has no “${r.section}” section now` };
  const lvl = levelOf(current[at]!);
  let end = current.length;
  for (let j = at + 1; j < current.length; j++)
    if (current[j]!.kind === 'heading' && levelOf(current[j]!) <= lvl) {
      end = j;
      break;
    }
  const section = current.slice(at + 1, end);
  if (section.some((b) => mentionedIn(b).has(r.pageId))) return { state: 'done' };
  const last = section.at(-1);
  if (last && last.kind === 'bulletList') {
    const list: Obj = { ...last, children: [...((last.children as unknown[] | undefined) ?? []), r.line] };
    return { state: 'apply', blocks: [...current.slice(0, end - 1), list, ...current.slice(end)] };
  }
  const list: Obj = { id: r.listId, kind: 'bulletList', children: [r.line] };
  return { state: 'apply', blocks: [...current.slice(0, end), list, ...current.slice(end)] };
}

// ============================================================================================ the content check

/** Where each original block must be once the split has run (per item, so a selection trims it). */
export interface ContentCheckInput {
  readonly source: { readonly resourceId: string; readonly documentId: string; readonly name: string };
  /** Every original top-level block with its text print and an excerpt (shared: never trimmed). */
  readonly original: readonly { readonly id: string; readonly text: string; readonly excerpt: string }[];
  /** Each item's moves (trimmed by the selection and by items skipped when the job ran). */
  readonly moves: readonly {
    readonly item: string;
    /** `move`: to `dest`; `universal`: removed (its application text replaces it). */
    readonly kind: 'move' | 'universal';
    readonly blocks: readonly string[];
    /** The destination (its page, and its document when known at plan time). */
    readonly dest: {
      readonly resourceId: string;
      readonly documentId: string | null;
      readonly name: string;
    } | null;
  }[];
}

export interface ContentProblem {
  readonly block: string;
  readonly text: string;
  readonly problem: 'missing' | 'changed' | 'duplicated' | 'left in the source';
  readonly where: string;
}

/**
 * The content check over the documents as read now (the source's and each destination's main document): every
 * original block that moves is in its destination exactly once (by its id, or the id derived for it), with its text
 * unchanged, and nowhere else; a block that stays is in the source; a universal block is gone (its application text
 * replaces it). Blocks the split made (interface summaries, headings, application text) are not original: not counted.
 */
export function contentProblems(
  input: ContentCheckInput,
  docs: ReadonlyMap<string, { readonly name: string; readonly blocks: readonly Obj[] }>,
): ContentProblem[] {
  const out: ContentProblem[] = [];
  const excerptOf = new Map(input.original.map((o) => [o.id, o.excerpt]));
  const home = new Map<
    string,
    { kind: 'source' | 'move' | 'universal'; dest: string | null; item: string | null }
  >();
  for (const o of input.original) home.set(o.id, { kind: 'source', dest: null, item: null });
  for (const m of input.moves)
    for (const b of m.blocks) home.set(b, { kind: m.kind, dest: m.dest?.resourceId ?? null, item: m.item });
  const index = new Map<string, Map<string, Obj>>();
  for (const [rid, d] of docs) index.set(rid, new Map(d.blocks.map((b) => [str(b.id) ?? '', b])));
  const nameOf = (rid: string) => docs.get(rid)?.name ?? rid;
  for (const o of input.original) {
    const h = home.get(o.id)!;
    const ids = h.item ? [o.id, altId(h.item, o.id)] : [o.id];
    const foundIn = [...index.entries()].filter(([, m]) => ids.some((id) => m.has(id))).map(([rid]) => rid);
    const label = excerptOf.get(o.id) ?? '';
    if (h.kind === 'universal') {
      for (const rid of foundIn)
        out.push({
          block: o.id,
          text: label,
          problem: rid === input.source.resourceId ? 'left in the source' : 'duplicated',
          where: nameOf(rid),
        });
      continue;
    }
    const want = h.kind === 'source' ? input.source.resourceId : h.dest!;
    if (!foundIn.includes(want)) {
      out.push({ block: o.id, text: label, problem: 'missing', where: nameOf(want) });
      continue;
    }
    const m = index.get(want)!;
    const b = ids.map((id) => m.get(id)).find((x) => x !== undefined)!;
    if (textPrint(b) !== o.text)
      out.push({ block: o.id, text: blockText(b).slice(0, 200), problem: 'changed', where: nameOf(want) });
    for (const rid of foundIn)
      if (rid !== want)
        out.push({
          block: o.id,
          text: label,
          problem: rid === input.source.resourceId ? 'left in the source' : 'duplicated',
          where: nameOf(rid),
        });
  }
  return out;
}
