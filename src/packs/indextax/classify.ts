/**
 * v3 F6b (ADR 0079; design T12 step 1): the classification of every current index, by rules over the bridge's own data
 * only. PURE: the tree's nodes, the pack's rules and lists, the registry's character taxonomy and the narrative rules in;
 * one verdict per index out. A page's kind is never guessed from its name or body: a rule decides (its id and words given),
 * or the row is `undecided` and the owner decides (T12).
 *
 * The rules, each from one source:
 *
 * - **The pack's exact-name lists** (`indexTaxonomy.structural`, the owner edits them on the dashboard): a top-level
 *   branch (directly under the AI REPOSITORY root); a routing index by its exact name anywhere (Arkona's Continents,
 *   Lost Realmships…); Setting Framework's category indexes (under Setting Framework); Divine Realms' category indexes
 *   (under Divine Realms). All `nav`.
 * - **Category words with position**: `<Continent> <word>` (and `<Realmship> <word>`), where the continent is an
 *   ancestor index of exactly that name and not a nation (`Salahad Polities`, `Salahad Conflicts`); `<worldPrefix>
 *   <word>` (`Arkonan Cultures`); a nation subindex, a child of a nation index named `<word>` or `<Nation> <word>`. All
 *   `nav`.
 * - **Subjects by position**: a nation (an index directly in a `<Continent> Polities` index: the owner tools' own rule,
 *   src/packs/engine/homes.ts) is `subject` (Polity); a continent or a Realmship (an index directly in one of the pack's
 *   continent or Realmship parents) and a named Divine Realm (directly in a realm category of Divine Realms) are
 *   `subject` (Place); a culture or religion family (an index directly in a `<…> Cultures` or `<…> Religions` category
 *   index) is `subject` (Culture, Religion).
 * - **The registry**: a race or racial group index (a taxonomy entry of a character type) and the unknown-race index are
 *   `nav`; a character index (under a character type's root, not an entry, holding the Character Core or Compact
 *   Character Reference of its own subject) is `subject` (Character). An index under the root holding neither is left
 *   undecided: the registry does not say what it is.
 * - **The narrative layout**: a continuity index (Main CANON, or an index an AU under Continuities names) and an act
 *   index are `nav`; a story index is `subject` (Story).
 *
 * Two rules that disagree leave the row undecided, both named (`conflict`). Pages under Working, Archive, the Legacy
 * Canon Archive or the Design References (the pack's `outOfScope`, by an ancestor's name) are reported, never proposed.
 */
import type { IndexRole } from '../../tree/classify.js';
import type { NodeScanRow } from '../../tree/index.js';
import { continuityOf, placeOf, rootsOf, type NNode, type NView } from '../../narrative/layout.js';
import type { IndexTaxonomyRules, NarrativeRules } from '../types.js';
import type { SubjectKind } from './rules.js';

export const RULE_IDS = [
  'top_level',
  'structural_name',
  'setting_framework_category',
  'divine_realm_category',
  'continent_category',
  'world_category',
  'nation_subindex',
  'race',
  'narrative_continuity',
  'narrative_act',
  'character',
  'nation',
  'continent',
  'realmship',
  'divine_realm',
  'culture_family',
  'religion_family',
  'narrative_story',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Each rule in words, as the report and the dashboard say it. */
export const RULE_TEXT: Readonly<Record<RuleId | 'conflict' | 'no_rule' | 'out_of_scope', string>> = {
  top_level: 'a top-level branch (the pack’s list), directly under the AI REPOSITORY root',
  structural_name: 'a routing index by its exact name (the pack’s list)',
  setting_framework_category: 'a category index of Setting Framework (the pack’s list)',
  divine_realm_category: 'a category index of Divine Realms (the pack’s list)',
  continent_category:
    'a category index of a continent or Realmship: “<Continent> <category>” under that continent',
  world_category: 'a world-level category index: “<world prefix> <category>”',
  nation_subindex: 'a nation subindex: a child of a nation index named “<category>” or “<Nation> <category>”',
  race: 'a race, racial group or unknown-race index (the registry’s character taxonomy)',
  narrative_continuity: 'a continuity index under Narratives (Main CANON, or an AU named under Continuities)',
  narrative_act: 'an act index inside a story (the narrative layout)',
  character:
    'a character index: under the Characters root, holding its own Character Core or Compact Reference',
  nation: 'a nation: an index directly in a “<Continent> Polities” index',
  continent: 'a continent: an index directly in the pack’s continents index',
  realmship: 'a Realmship: an index directly in one of the pack’s Realmship indexes',
  divine_realm: 'a named Divine Realm: an index directly in a realm category of Divine Realms',
  culture_family: 'a culture family: an index directly in a Cultures category index',
  religion_family: 'a religion family: an index directly in a Religions category index',
  narrative_story: 'a story: an index directly in a continuity index under Narratives',
  conflict: 'two rules disagree; the owner decides',
  no_rule: 'no rule settles it; the owner decides',
  out_of_scope: 'in an area that is reported but never proposed',
};

/** The role and subject each rule gives. */
const RULE_VERDICT: Readonly<Record<RuleId, { role: IndexRole; subject: SubjectKind | null }>> = {
  top_level: { role: 'nav', subject: null },
  structural_name: { role: 'nav', subject: null },
  setting_framework_category: { role: 'nav', subject: null },
  divine_realm_category: { role: 'nav', subject: null },
  continent_category: { role: 'nav', subject: null },
  world_category: { role: 'nav', subject: null },
  nation_subindex: { role: 'nav', subject: null },
  race: { role: 'nav', subject: null },
  narrative_continuity: { role: 'nav', subject: null },
  narrative_act: { role: 'nav', subject: null },
  character: { role: 'subject', subject: 'character' },
  nation: { role: 'subject', subject: 'polity' },
  continent: { role: 'subject', subject: 'place' },
  realmship: { role: 'subject', subject: 'place' },
  divine_realm: { role: 'subject', subject: 'place' },
  culture_family: { role: 'subject', subject: 'culture' },
  religion_family: { role: 'subject', subject: 'religion' },
  narrative_story: { role: 'subject', subject: 'story' },
};

/** A character type of the registry, as the rules read it. */
export interface CharacterTaxonomy {
  readonly rootIndexId: string;
  readonly unknownIndexName: string;
  /** The taxonomy entries' index ids (races and racial groups). */
  readonly entryIds: ReadonlySet<string>;
  /** The Character Core's and the Compact Character Reference's Reference Types. */
  readonly identityTypes: readonly string[];
}

export interface ClassifyInput {
  readonly nodes: readonly NodeScanRow[];
  readonly rootId: string | null;
  readonly rules: IndexTaxonomyRules;
  /** The owner tools' words: the nations' category (`Polities`) and the world prefix (`Arkonan`); null: no such rules. */
  readonly owners: { readonly nations: string; readonly worldPrefix: string } | null;
  readonly narrative: NarrativeRules | null;
  readonly characters: readonly CharacterTaxonomy[];
}

export interface Verdict {
  readonly pageId: string;
  readonly proposed: IndexRole | 'undecided';
  readonly subject: SubjectKind | null;
  /** The deciding rule (`conflict`, `no_rule` or `out_of_scope` when none decides). */
  readonly rule: RuleId | 'conflict' | 'no_rule' | 'out_of_scope';
  readonly why: string;
  /** Every rule that matched (two that disagree make a conflict). */
  readonly matched: readonly RuleId[];
  readonly scope: 'in' | 'out';
  /** The out-of-scope area's name. */
  readonly area: string | null;
}

/** The comparison key of names: case, spacing and the dash forms aside. */
export const nameKeyOf = (s: string): string =>
  s.normalize('NFC').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');

/** The subject of a page's name: before " - " (any dash). */
const subjectPart = (s: string): string => s.split(/\s+[-–—]\s+/)[0]!.trim();

/**
 * Classifies every index of the tree (the root aside). `onStep` is called every `chunk` indexes, so a caller that runs
 * this in a generator can yield between chunks.
 */
export function* classifySteps(input: ClassifyInput, chunk = 100): Generator<void, Verdict[]> {
  const { rules } = input;
  const s = rules.structural;
  const byId = new Map<string, NodeScanRow>();
  const kids = new Map<string, NodeScanRow[]>();
  for (const n of input.nodes) {
    byId.set(n.id, n);
    if (n.parentId !== null) {
      const l = kids.get(n.parentId);
      if (l) l.push(n);
      else kids.set(n.parentId, [n]);
    }
  }
  yield;
  const set = (xs: readonly string[]) => new Set(xs.map(nameKeyOf));
  const topLevel = set(s.topLevel);
  const named = set(s.named);
  const sfCats = set(s.settingFrameworkCategories);
  const drCats = set(s.divineRealmCategories);
  const continentParents = set(s.continentParents);
  const realmshipParents = set(s.realmshipParents);
  const outOfScope = set(rules.outOfScope);
  const sfKey = nameKeyOf(s.settingFramework);
  const drKey = nameKeyOf(s.divineRealms);
  const isIndex = (n: NodeScanRow | undefined | null): n is NodeScanRow => !!n && n.kind === 'index';
  const key = (n: NodeScanRow) => nameKeyOf(n.displayName);
  const parentOf = (n: NodeScanRow) => (n.parentId ? (byId.get(n.parentId) ?? null) : null);
  const ancestors = (n: NodeScanRow): NodeScanRow[] =>
    n.pathIds
      .slice(0, -1)
      .map((id) => byId.get(id))
      .filter((x): x is NodeScanRow => !!x);

  /** `<prefix> <word>` for one of the words: the prefix, or null. */
  const prefixFor = (name: string, words: readonly string[]): string | null => {
    const k = nameKeyOf(name);
    for (const w of words) {
      const wk = nameKeyOf(w);
      if (k.length > wk.length + 1 && k.endsWith(` ${wk}`))
        return k.slice(0, k.length - wk.length - 1).trim();
    }
    return null;
  };
  const endsWithWord = (name: string, words: readonly string[]): boolean => {
    const k = nameKeyOf(name);
    return words.some((w) => {
      const wk = nameKeyOf(w);
      return k === wk || k.endsWith(` ${wk}`);
    });
  };
  const isPolities = (n: NodeScanRow | null): boolean =>
    !!input.owners && isIndex(n) && prefixFor(n.displayName, [input.owners.nations]) !== null;
  const isNation = (n: NodeScanRow | null): boolean => isIndex(n) && isPolities(parentOf(n));

  // The narrative layout over the same nodes.
  const nview: NView = {
    node: (id) => (byId.get(id) as NNode | undefined) ?? null,
    children: (id) => kids.get(id) ?? [],
    indexesNamed: (name) => input.nodes.filter((n) => n.kind === 'index' && key(n) === nameKeyOf(name)),
    fact: () => null,
  };
  const roots = input.narrative ? rootsOf(nview, input.narrative) : null;

  const matchesOf = (n: NodeScanRow): RuleId[] => {
    const out: RuleId[] = [];
    const parent = parentOf(n);
    const k = key(n);
    const anc = ancestors(n);
    if (input.rootId !== null && n.parentId === input.rootId && topLevel.has(k)) out.push('top_level');
    if (named.has(k)) out.push('structural_name');
    if (sfCats.has(k) && anc.some((a) => key(a) === sfKey)) out.push('setting_framework_category');
    if (drCats.has(k) && anc.some((a) => key(a) === drKey)) out.push('divine_realm_category');
    // `<Continent> <word>`: the continent an ancestor index of exactly that name, not a nation.
    const p = prefixFor(n.displayName, s.continentCategories);
    if (p !== null) {
      if (input.owners && p === nameKeyOf(input.owners.worldPrefix)) out.push('world_category');
      else {
        const owner = [...anc].reverse().find((a) => a.kind === 'index' && key(a) === p);
        if (owner && !isNation(owner)) out.push('continent_category');
      }
    }
    if (parent && isNation(parent)) {
      const sub = s.nationSubindexes.some((w) => {
        const wk = nameKeyOf(w);
        return k === wk || k === `${key(parent)} ${wk}`;
      });
      if (sub) out.push('nation_subindex');
    }
    // The registry's character taxonomy.
    for (const t of input.characters) {
      if (n.id === t.rootIndexId || !n.pathIds.includes(t.rootIndexId)) continue;
      if (t.entryIds.has(n.id) || k === nameKeyOf(t.unknownIndexName)) {
        out.push('race');
        continue;
      }
      const own = (kids.get(n.id) ?? []).some(
        (c) =>
          c.kind !== 'index' &&
          c.kind !== 'unclassified' &&
          c.referenceType !== null &&
          t.identityTypes.some((r) => nameKeyOf(r) === nameKeyOf(c.referenceType!)) &&
          nameKeyOf(c.canonicalDisplayName ?? subjectPart(c.displayName)) === k,
      );
      if (own) out.push('character');
    }
    // Subjects by position.
    if (parent && isPolities(parent)) out.push('nation');
    if (parent && isIndex(parent) && continentParents.has(key(parent))) out.push('continent');
    if (parent && isIndex(parent) && realmshipParents.has(key(parent))) out.push('realmship');
    if (parent && isIndex(parent) && drCats.has(key(parent)) && anc.some((a) => key(a) === drKey))
      out.push('divine_realm');
    if (parent && isIndex(parent) && endsWithWord(parent.displayName, s.cultureCategories))
      out.push('culture_family');
    if (parent && isIndex(parent) && endsWithWord(parent.displayName, s.religionCategories))
      out.push('religion_family');
    // The narrative layout.
    if (input.narrative && roots?.narratives) {
      const place = placeOf(nview, input.narrative, roots, n.id);
      if (place?.kind === 'continuity') {
        const c = continuityOf(nview, input.narrative, roots, n);
        if (c && (c.main || c.au !== null)) out.push('narrative_continuity');
      } else if (place?.kind === 'story') out.push('narrative_story');
      else if (place?.kind === 'act') out.push('narrative_act');
    }
    return [...new Set(out)];
  };

  const verdicts: Verdict[] = [];
  let i = 0;
  for (const n of input.nodes) {
    if (n.kind !== 'index' || n.id === input.rootId) continue;
    if (++i % chunk === 0) yield;
    const area = ancestors(n)
      .filter((a) => a.id !== input.rootId)
      .find((a) => outOfScope.has(key(a)));
    if (area) {
      verdicts.push({
        pageId: n.id,
        proposed: 'undecided',
        subject: null,
        rule: 'out_of_scope',
        why: `${RULE_TEXT.out_of_scope}: ${area.displayName}`,
        matched: [],
        scope: 'out',
        area: area.displayName,
      });
      continue;
    }
    const matched = matchesOf(n);
    const roles = new Set(matched.map((r) => RULE_VERDICT[r].role));
    const subjects = new Set(matched.map((r) => RULE_VERDICT[r].subject).filter((x) => x !== null));
    if (matched.length === 0) {
      verdicts.push({
        pageId: n.id,
        proposed: 'undecided',
        subject: null,
        rule: 'no_rule',
        why: RULE_TEXT.no_rule,
        matched,
        scope: 'in',
        area: null,
      });
    } else if (roles.size > 1 || subjects.size > 1) {
      verdicts.push({
        pageId: n.id,
        proposed: 'undecided',
        subject: null,
        rule: 'conflict',
        why: `${RULE_TEXT.conflict}: ${matched.map((r) => `${RULE_VERDICT[r].role} by “${RULE_TEXT[r]}”`).join('; ')}`,
        matched,
        scope: 'in',
        area: null,
      });
    } else {
      const first = matched[0]!;
      verdicts.push({
        pageId: n.id,
        proposed: RULE_VERDICT[first].role,
        subject: RULE_VERDICT[first].role === 'subject' ? ([...subjects][0] ?? null) : null,
        rule: first,
        why: RULE_TEXT[first],
        matched,
        scope: 'in',
        area: null,
      });
    }
  }
  return verdicts;
}

/** The classification at once (tests, and synchronous callers). */
export function classifyIndexes(input: ClassifyInput): Verdict[] {
  const g = classifySteps(input);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
