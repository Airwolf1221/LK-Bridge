/**
 * v3 F6b (ADR 0079; design T11, T12): the pure rules.
 *
 * - T11's order: [NAV] first, then [INDEX], then sources, each alphabetical; a new [NAV] placed first; the narrative
 *   number order still applies inside a story, the rest following T11; the old rule unchanged where T11 is not in force.
 * - The classification report's rules (T12 step 1): one fixture per structural case (top-level branch, race, continent's
 *   category index, nation subindex, story act, continuity, character, nation, continent, Realmship, named Divine Realm,
 *   culture family), undecided cases left undecided (no rule, two rules that disagree), out-of-scope areas reported,
 *   never proposed. Never a guess from a name alone: an index named like a character, with no Core, stays undecided.
 * - The Tagging Standard section's form: read exactly, or refused.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import {
  classifyIndexes,
  type CharacterTaxonomy,
  type ClassifyInput,
  type Verdict,
} from '../../src/packs/indextax/classify.js';
import {
  expectedIndexTags,
  indexTagSectionText,
  NARRATIVE_EXCLUSION_LINE,
  parseIndexTagSection,
  templateNameOf,
} from '../../src/packs/indextax/rules.js';
import { narrativeCompare } from '../../src/narrative/names.js';
import {
  compareSiblings,
  compareSiblingsNav,
  outOfOrderAmong,
  slotAmong,
  type Orderable,
} from '../../src/registry/ordering.js';
import type { NodeScanRow } from '../../src/tree/index.js';
import { classifyName, roleOfClassified } from '../../src/tree/classify.js';

const RULES = ARKONA_PACK.rules.indexTaxonomy!;
const NARRATIVE = ARKONA_PACK.rules.narrative!;

const o = (id: string, rawName: string): Orderable => {
  const c = classifyName(rawName);
  return { id, rawName, displayName: c.displayName, kind: c.kind, indexRole: roleOfClassified(c) };
};

describe('T11’s order', () => {
  // The owner's problem, under Humans: "Bahram Kaviyan, High Humans, Miyubi Sakura".
  const humans = [
    o('a', '[INDEX] Bahram Kaviyan'),
    o('b', '[NAV] High Humans'),
    o('c', '[INDEX] Miyubi Sakura'),
    o('d', '[BSRC] Humans - Core Information'),
  ];
  it('puts [NAV] first, then [INDEX], then sources, each alphabetical', () => {
    const sorted = [...humans].sort(compareSiblingsNav).map((x) => x.rawName);
    expect(sorted).toEqual([
      '[NAV] High Humans',
      '[INDEX] Bahram Kaviyan',
      '[INDEX] Miyubi Sakura',
      '[BSRC] Humans - Core Information',
    ]);
    // Reported: one move puts it right (the fewest pages that must move).
    const bad = outOfOrderAmong(humans, compareSiblingsNav);
    expect(bad).toHaveLength(1);
    // With the race index already first, nothing is out of order.
    expect(outOfOrderAmong([humans[1]!, humans[0]!, humans[2]!, humans[3]!], compareSiblingsNav)).toEqual([]);
  });
  it('leaves the old rule as it was where T11 is not in force (indexes first, alphabetical)', () => {
    expect(outOfOrderAmong(humans, compareSiblings)).toEqual([]);
    expect(outOfOrderAmong(humans)).toEqual([]);
  });
  it('places a new [NAV] first among the indexes, and a new [INDEX] after the [NAV]s', () => {
    const sibs = [o('n1', '[NAV] Arkonans'), o('i1', '[INDEX] Aiko'), o('s1', '[BSRC] Zed')];
    expect(slotAmong(sibs, 'Zeta Group', 'index', compareSiblingsNav, 'nav')).toEqual({ after: 'n1' });
    expect(slotAmong(sibs, 'Aaron', 'index', compareSiblingsNav, 'subject')).toEqual({ after: 'n1' });
    expect(slotAmong(sibs, 'Bea', 'index', compareSiblingsNav, 'subject')).toEqual({ after: 'i1' });
    // The role read from the raw name when no role is stored.
    expect(
      compareSiblingsNav(
        { displayName: 'Z', kind: 'index', rawName: '[NAV] Z' },
        { displayName: 'A', kind: 'index', rawName: '[INDEX] A' },
      ),
    ).toBeLessThan(0);
  });
  it('keeps the narrative number order inside a story; what it does not place follows T11', () => {
    const cmp = narrativeCompare(NARRATIVE, compareSiblingsNav);
    const story = [
      o('m', 'Story Map'),
      o('a2', '[NAV] Act 2 - Return'),
      o('a1', '[NAV] Act 1 - Departure'),
      o('x', '[INDEX] Appendix'),
      o('y', '[NAV] Zed Notes'),
    ];
    const sorted = [...story].sort(cmp).map((x) => x.displayName);
    expect(sorted.slice(0, 3)).toEqual(['Story Map', 'Act 1 - Departure', 'Act 2 - Return']);
    expect(sorted.slice(3)).toEqual(['Zed Notes', 'Appendix']);
  });
});

// ============================================================================================ the classification

let seq = 0;
function tree() {
  const nodes: NodeScanRow[] = [];
  const add = (id: string, raw: string, parent: NodeScanRow | null, more: Partial<NodeScanRow> = {}) => {
    const c = classifyName(raw);
    const n: NodeScanRow = {
      id,
      rawName: raw,
      displayName: parent ? c.displayName : raw,
      kind: parent ? c.kind : 'root',
      indexRole: parent ? roleOfClassified(c) : null,
      parentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      pathIds: [...(parent?.pathIds ?? []), id],
      pathNames: [...(parent?.pathNames ?? []), parent ? c.displayName : raw],
      tags: [],
      referenceType: null,
      canonicalDisplayName: null,
      isLocked: null,
      ...more,
    };
    nodes.push(n);
    seq++;
    return n;
  };
  return { nodes, add };
}

function world() {
  const t = tree();
  const root = t.add('root', 'AI REPOSITORY', null);
  const ids: Record<string, string> = {};
  const x = (key: string, raw: string, parent: NodeScanRow, more: Partial<NodeScanRow> = {}) => {
    const n = t.add(key, raw, parent, more);
    ids[key] = n.id;
    return n;
  };
  // Top-level branches.
  const characters = x('characters', '[INDEX] Characters', root);
  const arkona = x('arkona', '[INDEX] Arkona', root);
  const sf = x('sf', '[INDEX] Setting Framework', root);
  const narratives = x('narratives', '[INDEX] Narratives', root);
  const continuities = x('continuities', '[INDEX] Continuities', root);
  const working = x('working', '[INDEX] Working', root);
  x('design', '[INDEX] Design References', root);
  // Characters: a racial group, a race, a character with its Core, a look-alike with no Core.
  const humansGroup = x('humans', '[INDEX] Humans', characters);
  const highHumans = x('highHumans', '[INDEX] High Humans', humansGroup);
  const miyubi = x('miyubi', '[INDEX] Miyubi Sakura', humansGroup);
  x('miyubiCore', '[BSRC] Miyubi Sakura - Character Core', miyubi, { referenceType: 'Character Core' });
  x('lookalike', '[INDEX] Bahram Kaviyan', highHumans);
  x('unknown', '[INDEX] Undetermined / Unknown', characters);
  // Arkona: continents, a continent's category indexes, a nation and its subindex, Realmships.
  const continents = x('continents', '[INDEX] Arkona’s Continents', arkona);
  const salahad = x('salahad', '[INDEX] Salahad', continents);
  const polities = x('polities', '[INDEX] Salahad Polities', salahad);
  const events = x('events', '[INDEX] Salahad Historical Events', salahad);
  x('conflicts', '[INDEX] Salahad Conflicts', events);
  const cultures = x('cultures', '[INDEX] Salahad Cultures', salahad);
  x('canthan', '[INDEX] Canthan Civilisation', cultures);
  const menkhet = x('menkhet', '[INDEX] Menkhet', polities);
  x('menkhetInst', '[INDEX] Menkhet Institutions', menkhet);
  x('menkhetOdd', '[INDEX] Menkhet Archives', menkhet);
  const realmships = x('realmships', '[INDEX] Arkona’s Realmships', arkona);
  x('vessel', '[INDEX] The Vessel of Dawn', realmships);
  x('arkCultures', '[INDEX] Arkonan Cultures', arkona);
  // Setting Framework, Divine Realms.
  x('bestiary', '[INDEX] Bestiary', sf);
  const divine = x('divine', '[INDEX] Divine Realms', sf);
  const upper = x('upper', '[INDEX] Upper Realms', divine);
  x('elysium', '[INDEX] Elysium', upper);
  // Narratives: Main CANON, a story, an act; an unknown continuity.
  const main = x('main', '[INDEX] Main CANON', narratives);
  const story = x('story', '[INDEX] The Long Road', main);
  x('act', '[INDEX] Act 1 - Departure', story);
  x('stray', '[INDEX] Someone’s Drafts', narratives);
  x('auDef', '[BSRC] Shattered Sky', continuities);
  // Out of scope: an index under Working.
  x('workingSet', '[INDEX] Asagiri Ren', working);
  // A conflict: an index named "<Continent> <category>" directly in Polities (a nation by position too).
  x('conflict', '[INDEX] Salahad Regions', polities);
  const characterTaxonomy: CharacterTaxonomy = {
    rootIndexId: characters.id,
    unknownIndexName: 'Undetermined / Unknown',
    entryIds: new Set([humansGroup.id, highHumans.id]),
    identityTypes: ['Character Core', 'Compact Character Reference'],
  };
  const input: ClassifyInput = {
    nodes: t.nodes,
    rootId: root.id,
    rules: RULES,
    owners: { nations: 'Polities', worldPrefix: 'Arkonan' },
    narrative: NARRATIVE,
    characters: [characterTaxonomy],
  };
  return { input, ids };
}

describe('the classification rules (T12 step 1)', () => {
  const { input } = world();
  const verdicts = classifyIndexes(input);
  const v = (id: string): Verdict => {
    const x = verdicts.find((y) => y.pageId === id);
    if (!x) throw new Error(`no verdict for ${id}`);
    return x;
  };
  const cases: [string, Verdict['proposed'], string, string | null][] = [
    ['characters', 'nav', 'top_level', null],
    ['arkona', 'nav', 'top_level', null],
    ['sf', 'nav', 'top_level', null],
    ['humans', 'nav', 'race', null],
    ['highHumans', 'nav', 'race', null],
    ['unknown', 'nav', 'race', null],
    ['polities', 'nav', 'continent_category', null],
    ['events', 'nav', 'continent_category', null],
    ['conflicts', 'nav', 'continent_category', null],
    ['menkhetInst', 'nav', 'nation_subindex', null],
    ['arkCultures', 'nav', 'structural_name', null],
    ['bestiary', 'nav', 'setting_framework_category', null],
    ['upper', 'nav', 'divine_realm_category', null],
    ['main', 'nav', 'narrative_continuity', null],
    ['act', 'nav', 'narrative_act', null],
    ['miyubi', 'subject', 'character', 'character'],
    ['menkhet', 'subject', 'nation', 'polity'],
    ['salahad', 'subject', 'continent', 'place'],
    ['vessel', 'subject', 'realmship', 'place'],
    ['elysium', 'subject', 'divine_realm', 'place'],
    ['canthan', 'subject', 'culture_family', 'culture'],
    ['story', 'subject', 'narrative_story', 'story'],
  ];
  for (const [id, proposed, rule, subject] of cases) {
    it(`${id}: ${proposed} by ${rule}`, () => {
      expect(v(id)).toMatchObject({ proposed, rule, subject, scope: 'in' });
    });
  }
  it('leaves undecided what no rule settles: never a guess from the name', () => {
    // Named like a character, under a race, but holding no Character Core or Compact Reference.
    expect(v('lookalike')).toMatchObject({ proposed: 'undecided', rule: 'no_rule' });
    // A nation's child whose name is no known subindex word.
    expect(v('menkhetOdd')).toMatchObject({ proposed: 'undecided', rule: 'no_rule' });
    // A child of Narratives that is neither Main CANON nor an AU named under Continuities.
    expect(v('stray')).toMatchObject({ proposed: 'undecided', rule: 'no_rule' });
  });
  it('leaves undecided two rules that disagree, naming both', () => {
    expect(v('conflict')).toMatchObject({ proposed: 'undecided', rule: 'conflict' });
    expect(v('conflict').matched).toEqual(expect.arrayContaining(['continent_category', 'nation']));
  });
  it('reports the out-of-scope areas, never proposing them (the branch itself still classified)', () => {
    expect(v('workingSet')).toMatchObject({
      scope: 'out',
      proposed: 'undecided',
      rule: 'out_of_scope',
      area: 'Working',
    });
    expect(v('working')).toMatchObject({ scope: 'in', proposed: 'nav', rule: 'top_level' });
  });
  it('classifies every index once, and nothing that is not an index', () => {
    const indexIds = input.nodes.filter((n) => n.kind === 'index').map((n) => n.id);
    expect(verdicts.map((x) => x.pageId).sort()).toEqual(indexIds.sort());
  });
});

describe('the tag rule and its governance section', () => {
  it('a [NAV] carries exactly Navigation; an [INDEX] exactly its subject’s category; never CANON', () => {
    expect(expectedIndexTags(RULES, 'nav', null)).toEqual(['Navigation']);
    expect(expectedIndexTags(RULES, 'subject', 'character')).toEqual(['Character']);
    expect(expectedIndexTags(RULES, 'subject', 'place')).toEqual(['Place']);
    expect(expectedIndexTags(RULES, 'subject', null)).toBeNull();
    for (const k of ['character', 'polity', 'culture', 'religion', 'place', 'story'] as const)
      expect(expectedIndexTags(RULES, 'subject', k)).not.toContain('CANON');
  });
  it('the section text the report gives is read back exactly', () => {
    const blocks = [
      { kind: 'heading', content: [{ text: 'Navigation and Subject Index Tags' }] },
      ...indexTagSectionText(RULES).map((t) => ({ kind: 'paragraph', content: [{ text: t }] })),
    ];
    const { story: _story, ...outside } = RULES.subjectTags;
    expect(parseIndexTagSection(blocks)).toEqual({
      ok: true,
      navTag: 'Navigation',
      subjectTags: outside,
      narrativeGrammar: true,
    });
    expect(indexTagSectionText(RULES)).toContain(NARRATIVE_EXCLUSION_LINE);
    expect(indexTagSectionText(RULES).some((l) => /^Story index/.test(l))).toBe(false);
  });
  // The owner's ruling at the F6b review: inside Narratives the narrative tag grammar governs story, continuity and act
  // indexes; the section says so in place of a story's tag.
  const para = (lines: string[]) =>
    parseIndexTagSection(lines.map((t) => ({ kind: 'paragraph', content: [{ text: t }] })));
  const OUTSIDE = [
    'Navigation index ([NAV]): Navigation.',
    'Character index: Character.',
    'Polity index (a nation or polity): Polity.',
    'Culture index (a culture family): Culture.',
    'Religion index (a religion family): Religion.',
    'Place index (a continent, a Realmship or a named Divine Realm): Place.',
  ];
  it('with the Narratives line: parsed, read as the Narratives exclusion (no story tag needed)', () => {
    const r = para([...OUTSIDE, NARRATIVE_EXCLUSION_LINE]);
    expect(r).toMatchObject({
      ok: true,
      narrativeGrammar: true,
      subjectTags: { character: 'Character', place: 'Place' },
    });
    expect(r.ok && r.subjectTags.story).toBeUndefined();
    // Any wording that starts "Narrative indexes" and names the narrative tag grammar.
    expect(para([...OUTSIDE, 'Narrative indexes follow the narrative tag grammar.'])).toMatchObject({
      ok: true,
      narrativeGrammar: true,
    });
  });
  it('without it: still parsed (Narratives excluded all the same), with or without a story tag', () => {
    expect(para(OUTSIDE)).toMatchObject({ ok: true, narrativeGrammar: false });
    const older = para([...OUTSIDE, 'Story index: Story.']);
    expect(older).toMatchObject({ ok: true, narrativeGrammar: false, subjectTags: { story: 'Story' } });
  });
  it('both a story tag and the Narratives line, or the line twice, cannot be read', () => {
    expect(para([...OUTSIDE, 'Story index: Story.', NARRATIVE_EXCLUSION_LINE])).toMatchObject({ ok: false });
    expect(para([...OUTSIDE, NARRATIVE_EXCLUSION_LINE, NARRATIVE_EXCLUSION_LINE])).toMatchObject({
      ok: false,
    });
  });
  it('a section that leaves a kind out, or states one twice, is refused (never guessed)', () => {
    const p = (lines: string[]) =>
      parseIndexTagSection(lines.map((t) => ({ kind: 'paragraph', content: [{ text: t }] })));
    expect(p(['Navigation index ([NAV]): Navigation.'])).toMatchObject({ ok: false });
    const all = indexTagSectionText(RULES).slice(1, 8);
    expect(p([...all, 'Character index: Person.'])).toMatchObject({ ok: false });
    expect(p(all.map((l) => l.replace('Navigation.', 'Navigation, Index.')))).toMatchObject({ ok: false });
    expect(parseIndexTagSection(null)).toMatchObject({ ok: false });
  });
  it('the templates are named, never ids', () => {
    expect(templateNameOf(RULES, 'nav')).toBe('[NAV] AI Navigation');
    expect(templateNameOf(RULES, 'subject')).toBe('[INDEX] AI Index');
    expect(templateNameOf(null, 'nav')).toBe('[NAV] AI Navigation');
    expect(seq).toBeGreaterThan(0);
  });
});
