/**
 * v3 F4c (ADR 0065; design E1, E2, E4): where narrative pages are, read from a tree. Pure, over a small view that both
 * the repository tree (the tools) and the snapshots' model (the audit) can give.
 *
 * - **Narratives** and **Continuities** are found by name (exactly one index each; never by id). Every page under
 *   Narratives is a narrative page (E2): no lifecycle, no prefix (indexes keep `[INDEX]`, as every index does), tagged
 *   `Narrative` and its kind.
 * - **Continuities**: each direct child is an AU, named by its subject (its display name before " - ").
 * - **A continuity index** is a direct child of Narratives: Main CANON, or an AU's name. **A story** is an index directly
 *   in one. Inside a story: its Story Map (first), act indexes (`Act <n> - <Title>`) holding chapters, or chapters
 *   directly (a story without acts); under the Story Map, Act Maps holding Chapter Plans, or plans directly.
 */
import type { NodeKind } from '../tree/index.js';
import type { NarrativeRules } from '../packs/types.js';
import { parseNarrativeName } from './names.js';

/** A node, as the view gives it. */
export interface NNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: NodeKind;
  readonly tags: readonly string[];
}

/** What the layout reads. `children` in sibling order (LegendKeeper's). */
export interface NView {
  node(id: string): NNode | null;
  children(id: string): readonly NNode[];
  /** Every INDEX whose display name is this (any case). */
  indexesNamed(name: string): readonly NNode[];
  /** A sidebar field's text (the PROPERTIES row), or null. */
  fact(id: string, key: string): string | null;
}

export const nkey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
/** A page's subject: its display name before " - " (any dash). */
export const subjectOf = (displayName: string): string => displayName.split(/\s+[-–—]\s+/)[0]!.trim();

export interface Roots {
  readonly narratives: NNode | null;
  readonly continuities: NNode | null;
  /** Indexes found more than once by name (never guessed). */
  readonly ambiguous: readonly string[];
}

export function rootsOf(view: NView, rules: NarrativeRules): Roots {
  const ambiguous: string[] = [];
  const one = (name: string): NNode | null => {
    const hits = view.indexesNamed(name).filter((n) => n.kind === 'index');
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) ambiguous.push(name);
    return null;
  };
  return {
    narratives: one(rules.indexes.narratives),
    continuities: one(rules.indexes.continuities),
    ambiguous,
  };
}

/** The AUs defined under Continuities: each direct child, by its subject. */
export function auDefinitions(view: NView, roots: Roots): { readonly name: string; readonly node: NNode }[] {
  if (!roots.continuities) return [];
  return view.children(roots.continuities.id).map((n) => ({ name: subjectOf(n.displayName), node: n }));
}

export interface ContinuityIndex {
  readonly node: NNode;
  readonly name: string;
  readonly main: boolean;
  /** Its AU definition under Continuities (null for Main CANON, or an index no AU names). */
  readonly au: NNode | null;
}

/** The continuity indexes under Narratives: Main CANON and each index named as an AU (others: unknown, null). */
export function continuityOf(
  view: NView,
  rules: NarrativeRules,
  roots: Roots,
  node: NNode,
): ContinuityIndex | null {
  if (!roots.narratives || node.parentId !== roots.narratives.id || node.kind !== 'index') return null;
  const main = nkey(node.displayName) === nkey(rules.indexes.main);
  const au = main
    ? null
    : (auDefinitions(view, roots).find((a) => nkey(a.name) === nkey(node.displayName))?.node ?? null);
  return { node, name: node.displayName, main, au };
}

/** The path from a node up to (not including) the root: the node first. */
function ancestry(view: NView, id: string): NNode[] {
  const out: NNode[] = [];
  let cur = view.node(id);
  for (let i = 0; cur && i < 200; i++) {
    out.push(cur);
    cur = cur.parentId ? view.node(cur.parentId) : null;
  }
  return out;
}

/** Whether a page is under Narratives (Narratives itself is not: E2 "anything under Narratives"). */
export function isNarrativePage(view: NView, roots: Roots, id: string): boolean {
  if (!roots.narratives) return false;
  return ancestry(view, id)
    .slice(1)
    .some((n) => n.id === roots.narratives!.id);
}

export type PlaceKind =
  | 'continuity'
  | 'story'
  | 'storyMap'
  | 'act'
  | 'actMap'
  | 'chapterPlan'
  | 'chapter'
  | 'chronologyMap'
  | 'other';

/** Where a narrative page sits and what it is. Null: not under Narratives. */
export interface Place {
  readonly kind: PlaceKind;
  readonly continuity: ContinuityIndex | null;
  readonly story: NNode | null;
  readonly n?: number;
  readonly title?: string;
}

export function placeOf(view: NView, rules: NarrativeRules, roots: Roots, id: string): Place | null {
  if (!roots.narratives) return null;
  const up = ancestry(view, id); // node first
  const at = up.findIndex((n) => n.id === roots.narratives!.id);
  if (at <= 0) return null;
  const chain = up.slice(0, at).reverse(); // continuity first, node last
  const node = chain[chain.length - 1]!;
  const continuity = continuityOf(view, rules, roots, chain[0]!);
  const story = chain.length >= 2 && chain[1]!.kind === 'index' ? chain[1]! : null;
  const parsed = parseNarrativeName(rules, node.displayName, node.kind === 'index');
  const base = { continuity, story };
  if (chain.length === 1) return { kind: 'continuity', ...base, story: null };
  if (chain.length === 2) {
    if (node.kind === 'index') return { kind: 'story', ...base, story: node };
    if (parsed?.kind === 'chronologyMap') return { kind: 'chronologyMap', ...base, story: null };
    return { kind: 'other', ...base, story: null };
  }
  if (!parsed) return { kind: 'other', ...base };
  return {
    kind: parsed.kind,
    ...base,
    ...(parsed.n !== undefined ? { n: parsed.n } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  };
}

export interface Numbered {
  readonly node: NNode;
  readonly n: number;
  readonly title?: string;
}

export interface StoryLayout {
  readonly story: NNode;
  readonly continuity: ContinuityIndex | null;
  /** The Story Maps directly in the story (one expected). */
  readonly storyMaps: readonly NNode[];
  readonly acts: readonly Numbered[];
  readonly actMaps: readonly (Numbered & { readonly map: NNode })[];
  /** Every Chapter Plan, with the map it sits under (the Story Map, or an Act Map) and that map's act number. */
  readonly plans: readonly (Numbered & { readonly parent: NNode; readonly act: number | null })[];
  /** Every chapter, with the act it sits in (null: directly in the story). */
  readonly chapters: readonly (Numbered & { readonly title: string; readonly act: Numbered | null })[];
  /** Anything else in the story (named by no pattern), with its parent. */
  readonly others: readonly { readonly node: NNode; readonly parent: NNode }[];
  /** Whether the story is told in acts. */
  readonly hasActs: boolean;
}

/** The layout of one story (its index). */
export function storyLayout(view: NView, rules: NarrativeRules, roots: Roots, story: NNode): StoryLayout {
  const cont = story.parentId ? view.node(story.parentId) : null;
  const continuity = cont ? continuityOf(view, rules, roots, cont) : null;
  const storyMaps: NNode[] = [];
  const acts: Numbered[] = [];
  const actMaps: (Numbered & { map: NNode })[] = [];
  const plans: (Numbered & { parent: NNode; act: number | null })[] = [];
  const chapters: (Numbered & { title: string; act: Numbered | null })[] = [];
  const others: { node: NNode; parent: NNode }[] = [];
  const planIn = (parent: NNode, act: number | null) => {
    for (const k of view.children(parent.id)) {
      const p = parseNarrativeName(rules, k.displayName, k.kind === 'index');
      if (p?.kind === 'chapterPlan') plans.push({ node: k, n: p.n!, parent, act });
      else if (p?.kind === 'actMap' && act === null) {
        actMaps.push({ node: k, n: p.n!, map: parent });
        planIn(k, p.n!);
      } else others.push({ node: k, parent });
    }
  };
  for (const k of view.children(story.id)) {
    const p = parseNarrativeName(rules, k.displayName, k.kind === 'index');
    if (p?.kind === 'storyMap') {
      storyMaps.push(k);
      planIn(k, null);
    } else if (p?.kind === 'act') {
      const act = { node: k, n: p.n!, title: p.title ?? '' };
      acts.push(act);
      for (const c of view.children(k.id)) {
        const q = parseNarrativeName(rules, c.displayName, c.kind === 'index');
        if (q?.kind === 'chapter') chapters.push({ node: c, n: q.n!, title: q.title ?? '', act });
        else others.push({ node: c, parent: k });
      }
    } else if (p?.kind === 'chapter') chapters.push({ node: k, n: p.n!, title: p.title ?? '', act: null });
    else others.push({ node: k, parent: story });
  }
  const byN = <T extends { n: number }>(l: T[]) => l.sort((a, b) => a.n - b.n);
  return {
    story,
    continuity,
    storyMaps,
    acts: byN(acts),
    actMaps: byN(actMaps),
    plans: byN(plans),
    chapters: byN(chapters),
    others,
    hasActs: acts.length > 0 || actMaps.length > 0,
  };
}

/** Every story of a continuity index (its index children). */
export function storiesIn(view: NView, continuity: NNode): NNode[] {
  return view.children(continuity.id).filter((n) => n.kind === 'index');
}

/** Every continuity index under Narratives. */
export function continuityIndexes(view: NView, rules: NarrativeRules, roots: Roots): ContinuityIndex[] {
  if (!roots.narratives) return [];
  return view
    .children(roots.narratives.id)
    .map((n) => continuityOf(view, rules, roots, n))
    .filter((c): c is ContinuityIndex => c !== null);
}
