/**
 * v3 F4c (ADR 0065; design E2): a narrative page's tags: `Narrative`, then its kind (`Story`, `Story Map`, `Act`,
 * `Act Map`, `Chapter Plan`, `Chapter`, `Chronology Map`), then `AU` in an AU's continuity. The tools set them; the
 * retag audit leaves Narratives alone. Any other tag a page carries (`Flashback`, an owner's own) is kept after them.
 */
import type { NarrativeRules } from '../packs/types.js';
import { parseNarrativeName } from './names.js';
import { continuityOf, placeOf, type NView, type Roots } from './layout.js';

export type NarrativeKindTag =
  'story' | 'storyMap' | 'act' | 'actMap' | 'chapterPlan' | 'chapter' | 'chronologyMap' | 'continuity';

const lower = (s: string) => s.toLocaleLowerCase('en-GB');

/** The tags of a narrative page of this kind (`extra` kept after them, without repeats, any case). */
export function narrativeTags(
  rules: NarrativeRules,
  kind: NarrativeKindTag | null,
  au: boolean,
  extra: readonly string[] = [],
): string[] {
  const t = rules.tags;
  const own = [
    t.narrative,
    ...(kind === 'continuity' ? (t.continuity ? [t.continuity] : []) : kind ? [t[kind]] : []),
    ...(au ? [t.au] : []),
  ];
  const statusTags = new Set(['canon', 'working', 'archived'].map(lower));
  const out: string[] = [];
  for (const x of [...own, ...extra])
    if (!out.some((y) => lower(y) === lower(x)) && !(statusTags.has(lower(x)) && !own.includes(x)))
      out.push(x);
  return out;
}

/**
 * The kind and continuity of a page about to be made under `parentId` (a page of the narrative tools, or one
 * `create_resource` makes under Narratives): by its name's pattern, else by where it goes (an index directly in a
 * continuity is a story). Null when the parent is not inside Narratives.
 */
export function newPageKind(
  view: NView,
  rules: NarrativeRules,
  roots: Roots,
  parentId: string,
  displayName: string,
  isIndex: boolean,
): { readonly kind: NarrativeKindTag | null; readonly au: boolean } | null {
  const parent = view.node(parentId);
  if (!parent || !roots.narratives) return null;
  if (parent.id === roots.narratives.id) {
    const c = continuityOf(view, rules, roots, {
      ...parent,
      id: '\u0000',
      parentId: parent.id,
      displayName,
      kind: 'index',
    });
    return { kind: 'continuity', au: c !== null && !c.main };
  }
  const place = placeOf(view, rules, roots, parentId);
  if (!place) return null;
  const au = place.continuity !== null && !place.continuity.main;
  const parsed = parseNarrativeName(rules, displayName, isIndex);
  if (parsed) return { kind: parsed.kind, au };
  if (place.kind === 'continuity' && isIndex) return { kind: 'story', au };
  return { kind: null, au };
}
