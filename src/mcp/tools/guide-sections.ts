/**
 * Forgiving guide sections (v2 E3b, ADR 0045). Agents guess the section they ask `get_bridge_guide` or
 * `get_markdown_guide` for ("find pages", "Promote", a row of the which-tool table), and an exact-heading match sent six
 * of the owner's evaluation runs to SECTION_NOT_FOUND. The guides still match a heading exactly first (see
 * `getSection`); only a miss comes here. A miss is matched loosely:
 *
 * - case, punctuation and spacing do not matter ("find-and-read a page", "Page’s  Text");
 * - the key words of a heading count, and a few common synonyms lead to the same place ("promote", "promotion" and
 *   "lifecycle" to the page lifecycle; "find", "search" and "read" to finding and reading);
 * - the labels of the "Which tool?" table are aliases of the section they point to;
 * - one clear match is returned (the reply names the exact section); several are listed as candidates; none lists every
 *   exact section name.
 *
 * It is a scoring heuristic with a deliberate bias to "several" over a wrong guess: a word that is in many headings
 * ("page", "text") counts for little, one that is in few counts for a lot, and a lone match must beat the runner-up by half.
 *
 * v2 E4 (the owner's run of 15 November 2026): **task sections rank above reference sections.** `section: "chronology"`
 * answered SECTION_AMBIGUOUS because the task section "Dates and the chronology" tied with the generated reference
 * sections "Operations > Timelines" and "Operations > Calendars". The guide's level-2 sections other than `Reference` and
 * `Operations` (and nothing beneath those two) are its tasks; a match among the tasks alone is decided first, by the same
 * rules, and only when no task section matches clearly are the reference sections weighed with them.
 */
import type { OutlineEntry } from '../../markdown/index.js';

export type SectionMatch =
  | { readonly kind: 'one'; readonly heading: OutlineEntry }
  | { readonly kind: 'several'; readonly candidates: readonly OutlineEntry[] }
  | { readonly kind: 'none' };

const STOP = new Set(
  (
    'a an the of to or and for in on with my your how do does did i it is are be been when what which where one ' +
    'some any all about into from at by as this that can should would use using me please want need'
  ).split(' '),
);

/** Words so common in the guides' headings that they say little about which section is meant. */
const GENERIC = new Set(['page', 'text', 'section', 'guide', 'tool', 'bridge', 'thing', 'part']);
const GENERIC_WEIGHT = 0.3;

/**
 * Synonym groups: every word (and its plural and -ed / -ing / -ion forms) is one concept. A group is first-come: a word
 * in an earlier group is not taken by a later one.
 */
const GROUPS: readonly (readonly string[])[] = [
  ['audit', 'finding', 'lint', 'problem', 'issue'],
  [
    'find',
    'search',
    'read',
    'look',
    'lookup',
    'locate',
    'browse',
    'discover',
    'view',
    'get',
    'list',
    'outline',
  ],
  ['edit', 'write', 'rewrite', 'append', 'replace', 'modify', 'revise', 'paragraph'],
  ['fact', 'sidebar', 'property', 'link', 'scope', 'rank', 'attribute'],
  ['create', 'new', 'add', 'make', 'build', 'template'],
  ['rename', 'move', 'delete', 'remove', 'tag', 'alias', 'hide', 'lock', 'destroy', 'undo'],
  ['promote', 'promotion', 'lifecycle', 'archive', 'unarchive', 'retire', 'retirement'],
  ['date', 'chronology', 'timeline', 'calendar', 'event', 'age', 'lane'],
  ['map', 'pin', 'region', 'path', 'marker', 'feature', 'label'],
  ['image', 'upload', 'picture', 'photo', 'asset', 'png', 'jpeg'],
  ['snapshot', 'history', 'revision', 'diff', 'rollback', 'older', 'earlier'],
  ['budget', 'job', 'proposal', 'estimate', 'rate', 'queue', 'wait'],
  ['canon', 'canonical', 'approval', 'approve', 'authoritative', 'status', 'protected', 'continuity'],
  ['low', 'level', 'lk', 'api', 'fallback', 'raw'],
  ['error', 'wrong', 'refusal', 'refuse', 'fail', 'failure', 'troubleshoot', 'trouble', 'code'],
];

const SUFFIXES = ['', 's', 'es', 'd', 'ed', 'ing', 'ion', 'ions'];

/** word → the group's first word (its concept). */
const CONCEPT = new Map<string, string>();
for (const g of GROUPS) {
  const root = g[0]!;
  for (const w of g) {
    for (const sfx of SUFFIXES) {
      const forms = [w + sfx];
      if (w.endsWith('e') && (sfx === 'd' || sfx === 'ing' || sfx === 'ion' || sfx === 'ions'))
        forms.push(w.slice(0, -1) + sfx);
      for (const f of forms) if (!CONCEPT.has(f)) CONCEPT.set(f, root);
    }
  }
}

/** The tokens of a text: lower case, punctuation and underscores as spaces, apostrophes dropped. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t !== '' && !STOP.has(t));
}

/** A token as a concept: its synonym group's root, else the word without a plural. */
function concept(token: string): string {
  const g = CONCEPT.get(token);
  if (g) return g;
  if (/ies$/.test(token) && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(token)) return token;
  if (/s$/.test(token) && token.length > 3) return token.slice(0, -1);
  return token;
}

const conceptsOf = (text: string): Set<string> => new Set(tokens(text).map(concept));

/** The normal form of a phrase, to compare an asked name with an alias exactly (case, punctuation, spacing). */
export const normalise = (text: string): string =>
  tokens(text)
    .map((t) => (/(ss|us|is)$/.test(t) || t.length <= 3 ? t : t.replace(/s$/, '')))
    .join(' ');

/**
 * Extra phrases that lead to a section, by the section's heading text: the labels of the which-tool table in the
 * bridge guide's "How to decide" (agents copy them), and the words of the tasks. A test checks every key is a heading.
 */
export const SECTION_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  bridge: {
    'How to decide': [
      'which tool',
      'which tool should I use',
      'choose a tool',
      'five rules',
      'start',
      'overview',
    ],
    'Find and read a page': [
      'Find a page when you know part of its name or a tag',
      'See how a part of the repository is laid out',
      "Look at one page's facts, links, tags",
      "Read a page's text (or one section)",
      'find pages',
      'finding and reading',
      'search',
      'read',
    ],
    "Edit a page's text": ["Change a page's text", 'write a page', 'edit text', 'write_page', 'baseVersion'],
    'Change facts and links': ['Change facts or links', 'set facts', 'set_facts', 'baseFactsVersion'],
    'Create a page or a character (Working first)': [
      'Make a character',
      'Make any other page',
      'create a page',
      'create a character',
      'new page from a template',
      'create a page from a template',
      'page from a template',
      'template',
    ],
    // v3 F3a (ADR 0050) and F3b (ADR 0052): the setting packs' tools. The section has a part per tool; F3a's section name
    // leads to the character part.
    'Setting packs (Arkona)': ['setting pack', 'Arkona', 'Arkona pack', 'pack tools'],
    'Arkona characters': [
      'Make an Arkona character, or add pages to one',
      'Setting packs (Arkona characters)',
      'arkona_create_character',
      'create an Arkona character',
      'character package',
      'completion gate',
    ],
    'Arkona owners': [
      'Make any other Arkona owner page (polity, race…)',
      'Make any other Arkona owner page',
      'arkona_create_owner',
      'Arkona owner',
      'create an Arkona owner',
      'owner page',
      'promoteNation',
      'race roster',
    ],
    'Arkona relationships, art and the brief': [
      'Relate two Arkona characters, or add art to one',
      'Relate two existing Arkona characters',
      'Add art to an existing Arkona character',
      'Recall who an Arkona character is',
      'Recall who an Arkona character is (free, no read)',
      'arkona_create_relationship',
      'arkona_add_character_art',
      'arkona_character_brief',
      'character brief',
      'character art',
    ],
    // v3 F4a (ADR 0063): the topic brief (the first step for any subject) and the name check.
    'Arkona briefs and names': [
      'Brief on any Arkona subject (or a character)',
      'Brief on any Arkona subject',
      "Check a character's name before an intake or rename",
      'Know a subject first (free, no read)',
      'Check a name: namesakes, naming culture (free)',
      'arkona_brief',
      'arkona_name_check',
      'topic brief',
      'subject brief',
      'name check',
      'namesake',
      'namesakes',
      'naming culture',
    ],
    // v3 F4b (ADR 0064): the consistency check and "as of a date".
    'Arkona consistency checks': [
      'A character at a date (free)',
      'Dates and identity facts that disagree (free)',
      'Which characters have readable dates (free)',
      'Suggest the right value to the owner',
      // Not `arkona_as_of` or "as of": "as" and "of" are dropped, leaving "arkona" (the pack's own section).
      'a character at a date',
      'age at a date',
      'arkona_as_of_coverage',
      'arkona_consistency',
      'arkona_consistency_suggest',
      'consistency',
      'contradiction',
      'contradictions',
      'pick the right value',
    ],
    // v3 F4c (ADR 0065): the narrative layout and tools.
    'Arkona fiction': [
      'A story or chapter',
      'arkona_story_create',
      'arkona_chapter_plan',
      'arkona_chapter_save',
      'arkona_chapter_insert',
      'arkona_chapter_move',
      'arkona_chapter_context',
      'arkona_chapter_check',
      'arkona_promote_from_chapter',
      'new lore',
      'promote lore',
      'fiction',
      'story',
      'stories',
      'chapter',
      'chapters',
      'narrative',
      'narratives',
      'dateline',
      'question gate',
      'drafting gate',
    ],
    // v3 F3c (ADR 0054): the appraisal part (read-only reports, fixes are proposals).
    'Arkona appraisal': [
      'Appraise Arkona pages, or see what a change breaks',
      'Appraise pages against Source Formatting (free)',
      'See what depends on a page, a rename, a proposal',
      'See what is in progress (Working pages and more)',
      'Check the images and the asset library',
      'Make the fix an appraisal finding offers',
      'Propose the fix an appraisal finding offers',
      'arkona_appraise_owner',
      'arkona_change_impact',
      'arkona_working_digest',
      'arkona_visual_hygiene',
      'arkona_appraisal_fix',
      'appraisal',
      'appraise',
      'change impact',
      'working digest',
      'visual hygiene',
    ],
    // v3 F3e (ADR 0059): the splits part (the appraisal of the Split Triggers, and the split itself).
    'Arkona splits': [
      'Split an Arkona owner into several owners',
      'See whether an owner page should be split (free)',
      'Split an owner page into owners',
      'arkona_split_appraisal',
      'arkona_split_owner',
      'split an owner',
      'split a character',
      'split triggers',
      'split',
      'splits',
      'monolith',
    ],
    'Rename, move, delete and restore': [
      'Rename, tag, alias, hide, lock',
      'Move a page',
      'Delete (and undo)',
    ],
    'The page lifecycle': [
      'Retire a page or a whole character',
      'Make Working work canon',
      'promote',
      'promotion',
      'archive',
      'lifecycle',
    ],
    'Dates and the chronology': [
      'Check or convert a date',
      'Add, change, remove a chronology event',
      'calendar',
      'timeline',
    ],
    Maps: ['Add or move a map pin, region, path'],
    Images: ['Put an image in the library', 'upload an image'],
    'Snapshots and restores': ['See older states of a page and bring one back'],
    'Audit findings': ['See what the audits found'],
    'Budgets, jobs and proposals': [
      'Know how much budget is left, or if work fits',
      'Know what happened to a proposal or job',
    ],
    'Canon and approval': ['canon', 'approval'],
    // v3 F3.4 (ADR 0055): what scope write makes at once and what it still proposes.
    'At write scope': [
      'write scope',
      'scope write',
      'safety rails',
      'rails',
      'proposedBecause',
      'proposed because',
      'bulk change',
      'review',
      'revert',
    ],
    'When the low-level tools are right': [
      'Do something none of the above does',
      'low-level tools',
      'lk_api',
    ],
  },
  markdown: {},
};

/** Key words added to a heading's own (by the heading's text), where its words alone would not be asked for. */
const KEYWORDS: Readonly<Record<string, string>> = {
  'How to decide': 'rules choose overview start',
  'Setting packs (Arkona)': 'package',
  'Arkona characters': 'package gate identity',
  'Arkona owners': 'home nation polity institution place species race',
  // Not "finding": it stands for "audit" (a synonym group), which must keep leading to "Audit findings".
  'Arkona appraisal': 'appraise appraisal impact digest hygiene',
  'Arkona splits': 'split monolith trigger fragmentation destination',
};

interface Entry {
  readonly heading: OutlineEntry;
  readonly bag: Set<string>;
  readonly aliases: readonly string[];
  /** A task section (v2 E4): not `Reference` or `Operations`, nor beneath them. */
  readonly task: boolean;
}

/** The level-2 sections that hold reference material rather than a task (the second is generated at serve time). */
const REFERENCE_SECTIONS = new Set(['reference', 'operation']);

/** Whether a heading is a task section: its top section (below the title) is not a reference one. */
function isTask(h: OutlineEntry): boolean {
  const top = h.path.split(' > ')[1] ?? h.text;
  return !REFERENCE_SECTIONS.has(normalise(top));
}

type Scored = { readonly e: Entry; readonly hits: number; readonly score: number };

/** One clear winner among `scored` (best first), or undefined. */
function clearWinner(scored: readonly Scored[], asked: number): Scored | undefined {
  const top = scored[0];
  if (!top) return undefined;
  const second = scored[1]?.score ?? 0;
  // A clear match needs a strong score, a lead over the runner-up, and at least half of what was asked: one shared word
  // in a long, unrelated ask ("no such heading" and "Headings and paragraphs") is a candidate, never the answer.
  return top.score >= 1 && top.score >= second * 1.5 && top.hits * 2 >= asked ? top : undefined;
}

/**
 * Matches `asked` against the guide's headings (the level-2 and deeper ones: the title is not a section).
 * `guide` selects the alias table.
 */
export function matchSection(
  headings: readonly OutlineEntry[],
  asked: string,
  guide: 'bridge' | 'markdown',
): SectionMatch {
  // "A > B": a loose ask names the last segment.
  const query = asked
    .split('>')
    .at(-1)!
    .replace(/\s*\[\d+\]\s*$/, '');
  const aliasTable = SECTION_ALIASES[guide] ?? {};
  const entries: Entry[] = headings
    .filter((h) => h.level >= 2)
    .map((h) => {
      const aliases = aliasTable[h.text] ?? [];
      // The bag is the heading's own key words (and what their synonym groups stand for), plus a few extras; the
      // aliases only match as whole phrases, because a table label's verb ("Add a pin") would pull in other sections.
      const bag = conceptsOf(`${h.text} ${KEYWORDS[h.text] ?? ''}`);
      return { heading: h, bag, aliases: aliases.map(normalise), task: isTask(h) };
    });
  if (entries.length === 0) return { kind: 'none' };

  const nq = normalise(query);
  if (nq === '') return { kind: 'none' };

  // 0. "A > B" spelled as a heading's whole path, whatever the case and punctuation.
  if (asked.includes('>')) {
    const np = asked.split('>').map(normalise).join(' > ');
    const byPath = entries.filter((e) => exactName(e.heading).split(' > ').map(normalise).join(' > ') === np);
    if (byPath.length === 1) return { kind: 'one', heading: byPath[0]!.heading };
  }

  // 1. The same words as a heading's text, or as one of its aliases (exactly, whatever the case and punctuation). A
  // single task section among several matches wins (v2 E4).
  const same = entries.filter((e) => normalise(e.heading.text) === nq || e.aliases.includes(nq));
  const sameSections = [...new Set(same.map((e) => e.heading.path))];
  if (sameSections.length === 1) return { kind: 'one', heading: same[0]!.heading };
  const sameTasks = [...new Set(same.filter((e) => e.task).map((e) => e.heading.path))];
  if (sameTasks.length === 1) return { kind: 'one', heading: same.find((e) => e.task)!.heading };
  if (sameSections.length > 1) return { kind: 'several', candidates: same.map((e) => e.heading) };

  // 2. Key words: every concept of the ask that is in a heading counts, by how few headings have it.
  const df = new Map<string, number>();
  for (const e of entries) for (const c of e.bag) df.set(c, (df.get(c) ?? 0) + 1);
  const weight = (c: string): number => {
    const n = df.get(c);
    if (!n) return 0;
    const idf = Math.log(1 + entries.length / n);
    return GENERIC.has(c) ? idf * GENERIC_WEIGHT : idf;
  };
  const q = conceptsOf(query);
  const scored: Scored[] = entries
    .map((e) => {
      const hit = [...q].filter((c) => e.bag.has(c));
      return { e, hits: hit.length, score: hit.reduce((s, c) => s + weight(c), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.heading.line - b.e.heading.line);
  if (scored.length === 0) return { kind: 'none' };
  // v2 E4: the task sections are judged on their own first; a clear task match is the answer even when reference
  // sections share its words. Only when no task section wins are the reference sections weighed with them.
  const taskWinner = clearWinner(
    scored.filter((x) => x.e.task),
    q.size,
  );
  if (taskWinner) return { kind: 'one', heading: taskWinner.e.heading };
  const winner = clearWinner(scored, q.size);
  if (winner) return { kind: 'one', heading: winner.e.heading };
  const top = scored[0]!;
  const near = scored.filter((x) => x.score >= top.score * 0.5).slice(0, 6);
  return { kind: 'several', candidates: near.map((x) => x.e.heading) };
}

/**
 * A section's exact name as `section` takes it: its heading path without the guide's title ("Find and read a page",
 * "Reference > Projects"). Both guides have one level-1 heading, the title, at the root of every path.
 */
export function exactName(h: OutlineEntry): string {
  return h.path.split(' > ').slice(1).join(' > ');
}

/** Every exact section name of a guide, in order (the title is not one). */
export function sectionNames(headings: readonly OutlineEntry[]): string[] {
  return headings.filter((h) => h.level >= 2).map(exactName);
}
