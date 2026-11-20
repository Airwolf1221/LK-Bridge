/**
 * v3 F4a (ADR 0063): the governance drift check, the audits' `governance` category, on hand-made governance documents
 * shaped like the owner's repository check of 19 November 2026 (Character Architecture's old `write_lk` call, Repository
 * Automation's Startup section, its Diagnostic Workflows naming skills by their old names). With the owner's review:
 * "Fiction Writing" in that Startup section is the Design References page "Arkona – Fiction Writing Reference" (tagged
 * "Fiction Writing") and resolves; "Moonlit Ledger" resolves nowhere; "LK Bootstrap" is a near miss for the root's tab
 * "AI Bootstrap". A pure function of its context: no database, no LegendKeeper.
 */
import { describe, expect, it } from 'vitest';
import {
  argsIn,
  capitalisedRuns,
  closestName,
  containingName,
  editDistance,
  governanceBlocks,
  governanceCheck,
  knows,
  nameNorm,
  nearTool,
  partOfKnown,
  resolvableNames,
  unresolvedIn,
  type GovernanceAuditInput,
  type KnownKey,
  type KnownName,
  type KnownNames,
} from '../../src/audits/checks/governance.js';
import type { AuditContext } from '../../src/audits/context.js';
import { CODES, type FindingDraft } from '../../src/audits/types.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { context, model, page } from './helpers.js';

const RULES = ARKONA_PACK.rules.governanceAudit!;

const KNOWN: KnownNames = {
  tools: new Set([
    'get_bridge_guide',
    'get_resource',
    'read_document',
    'write_page',
    'search',
    'arkona_appraise_owner',
    'arkona_change_impact',
    'arkona_working_digest',
    'arkona_visual_hygiene',
    'audit_findings',
  ]),
  retired: new Map([['get_resources', 'get_resource']]),
  vocabulary: new Set(['operation_id', 'proposal_captured', 'baseVersion', 'out_of_order']),
};

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, ...runs: Record<string, unknown>[]) => ({ id, kind: 'paragraph', content: runs });
const t = (text: string) => ({ text });
const code = (text: string) => ({ text, code: true });
const item = (id: string, ...runs: Record<string, unknown>[]) => ({
  id: `${id}li`,
  kind: 'listItem',
  children: [para(id, ...runs)],
});

/** Character Architecture as the owner found it: the old bridge's guide call. */
const ARCHITECTURE = [
  heading('ca1', 1, 'Character Architecture'),
  heading('ca2', 2, 'Character Naming-Culture Verification & Identity Revision'),
  para('ca3', t('Before any intake, call '), code('write_lk {"job_action":"guide"}'), t(' and read it.')),
  heading('ca4', 2, 'Required Naming-Culture Question and Temporal Metadata Completion'),
  para('ca5', t('Ask the owner; then '), code('write_page'), t(' with '), code('operation_id'), t('.')),
];

/**
 * Repository Automation: its Startup names Fiction Writing (a Design References page), a page that is nowhere (the
 * Moonlit Ledger) and a near miss (LK Bootstrap, for the root's tab AI Bootstrap); its Diagnostic Workflows name the old
 * skills.
 */
const AUTOMATION = [
  heading('ra1', 1, 'Repository Automation'),
  heading('ra2', 2, 'Startup and Current Evidence'),
  {
    id: 'ra3',
    kind: 'orderedList',
    children: [
      item('ra4', t('Read Project Navigation and the Controlled Native Tagging Standard.')),
      item('ra5', t('Read Fiction Writing before any prose task.')),
      item('ra5a', t('Read the Moonlit Ledger before a chronology task.')),
      item('ra5b', t('Then open LK Bootstrap.')),
      item('ra6', t('Check the Salahad Reference and the White Fox before a Salahad task.')),
    ],
  },
  heading('ra7', 2, 'Diagnostic Workflows'),
  para('ra8', t('Owners: run '), code('format-baisheng-owners'), t('.')),
  para('ra9', t('Change impact: '), code('audit-baisheng-change-impact'), t('.')),
  para('ra10', t('Chronology: '), code('audit-baisheng-chronology'), t('.')),
  para('ra11', t('Visuals: '), code('intake-baisheng-visuals'), t('.')),
  para('ra12', t('Resuming: the resume-baisheng-workstreams skill.')),
  para(
    'ra13',
    t('Stories: '),
    code('plan-baisheng-stories'),
    t('; letters: '),
    code('draft-baisheng-letters'),
    t('.'),
  ),
  heading('ra14', 2, 'Notes'),
  // Outside the reference sections a missing name is never looked for.
  para(
    'ra15',
    t('See the Moonlit Ledger for style, and use '),
    code('get_resources'),
    t(' for several pages.'),
  ),
];

/** Project Navigation (a tab of the root): its Startup names only what exists. */
const NAVIGATION = [
  heading('pn1', 1, 'Project Navigation'),
  heading('pn2', 2, 'Startup'),
  para('pn3', t('Read Character Architecture, then Source Formatting, then the Salahad Reference.')),
  para('pn4', t('Use '), code('get_bridge_guide'), t(' and '), code('arkona_appraise_owner'), t('.')),
];

/**
 * How the Fiction Writing guidance is held: as the owner has it (the Design References page "Arkona – Fiction Writing
 * Reference", tagged "Fiction Writing"); by that page's name alone (an en dash, or a hyphen); by a page's tag or alias
 * alone; by a root tab; or not at all.
 */
type FictionHeld = 'owner' | 'name' | 'name-hyphen' | 'tag' | 'alias' | 'tab' | 'none';

function world(
  o: { allowed?: readonly string[]; navigation?: readonly unknown[]; fiction?: FictionHeld } = {},
) {
  const held = o.fiction ?? 'owner';
  const root = page({
    id: 'root',
    name: 'AI REPOSITORY',
    root: true,
    docs: [
      { id: 'docarch', name: 'Character Architecture', type: 'page' },
      { id: 'docauto', name: 'Repository Automation', type: 'page' },
      { id: 'docnav', name: 'Project Navigation', type: 'page' },
      { id: 'doctag', name: 'Controlled Native Tagging Standard', type: 'page' },
      { id: 'docfmt', name: 'Source Formatting', type: 'page' },
      { id: 'docboot', name: 'AI Bootstrap', type: 'page' },
      ...(held === 'tab' ? [{ id: 'docfic', name: 'Fiction Writing', type: 'page' as const }] : []),
    ],
  });
  const salahad = page({ id: 'salref01', name: '[BSRC] Salahad - Continent Reference', parent: 'root' });
  // A character known by an alias: "the White Fox" resolves through it.
  const miyuki = page({
    id: 'miyuki01',
    name: '[BSRC] Kamigawa Miyuki - Character Reference',
    parent: 'root',
    aliases: ['The White Fox'],
  });
  // The Design References (a non-current area, still part of the AI REPOSITORY).
  const design = page({ id: 'designix', name: '[INDEX] Design References', parent: 'root' });
  const fiction =
    held === 'tab'
      ? []
      : [
          page({
            id: 'fic00001',
            name:
              held === 'owner' || held === 'name'
                ? '[BSRC] Arkona – Fiction Writing Reference'
                : held === 'name-hyphen'
                  ? '[BSRC] Arkona - Fiction Writing Reference'
                  : '[BSRC] Arkona – Prose Style Guide',
            parent: 'designix',
            tags: held === 'owner' || held === 'tag' ? ['Fiction Writing'] : [],
            aliases: held === 'alias' ? ['Fiction Writing'] : [],
          }),
        ];
  const m = model([root, salahad, miyuki, design, ...fiction]);
  const governance: GovernanceAuditInput = {
    rules: RULES,
    packName: 'Arkona',
    documents: [
      { pageId: 'root', documentId: 'docarch', name: 'Character Architecture', blocks: ARCHITECTURE },
      { pageId: 'root', documentId: 'docauto', name: 'Repository Automation', blocks: AUTOMATION },
      {
        pageId: 'root',
        documentId: 'docnav',
        name: 'Project Navigation',
        blocks: [...NAVIGATION, ...(o.navigation ?? [])],
      },
      { pageId: 'root', documentId: 'doctag', name: 'Controlled Native Tagging Standard', blocks: null },
    ],
    known: KNOWN,
    allowed: new Set((o.allowed ?? []).map((a) => a.toLowerCase())),
  };
  const ctx: AuditContext = { ...context(m), governance };
  return governanceCheck(ctx);
}

const byName = (drafts: readonly FindingDraft[], name: string) =>
  drafts.filter((d) => (d.evidence as { name?: string }).name === name);

describe('the governance drift check (v3 F4a, ADR 0063)', () => {
  it('finds the old write_lk line and suggests get_bridge_guide (job_action folded into the call)', () => {
    const drafts = world();
    const hit = byName(drafts, 'write_lk');
    expect(hit).toHaveLength(1);
    const f = hit[0]!;
    expect(f.code).toBe('governance_unknown_tool');
    expect(f.pageId).toBe('root');
    expect(f.documentId).toBe('docarch');
    expect(f.evidence).toMatchObject({
      tab: { id: 'docarch', name: 'Character Architecture' },
      name: 'write_lk',
      arguments: { job_action: 'guide' },
      equivalent: { use: 'get_bridge_guide' },
      suggestedReplacement: 'get_bridge_guide',
      sections: ['Character Architecture › Character Naming-Culture Verification & Identity Revision'],
    });
    expect(f.message).toContain('`write_lk` (job_action: guide)');
    expect(f.message).toContain('get_bridge_guide');
    expect(f.message).toMatch(/old bridge’s call shapes/);
    // The call's argument is part of the call, never a finding of its own; no finding offers a fix.
    expect(byName(drafts, 'job_action')).toHaveLength(0);
    expect(drafts.every((d) => !d.fix)).toBe(true);
  });

  it('leaves the bridge’s own tools and words alone, and names a retired tool’s successor', () => {
    const drafts = world();
    for (const n of ['write_page', 'operation_id', 'get_bridge_guide', 'arkona_appraise_owner'])
      expect(byName(drafts, n), n).toHaveLength(0);
    const retired = byName(drafts, 'get_resources');
    expect(retired).toHaveLength(1);
    expect(retired[0]!.code).toBe('governance_unknown_tool');
    expect(retired[0]!.evidence).toMatchObject({
      retired: { renamedTo: 'get_resource' },
      suggestedReplacement: 'get_resource',
    });
  });

  it('reports each old skill name with its equivalent, the partial one said so, and one with none', () => {
    const drafts = world();
    const ext = (n: string) => {
      const l = byName(drafts, n);
      expect(l, n).toHaveLength(1);
      expect(l[0]!.code).toBe('governance_external_name');
      return l[0]!;
    };
    expect(ext('format-baisheng-owners').evidence).toMatchObject({
      equivalent: { use: 'arkona_appraise_owner' },
    });
    expect(ext('audit-baisheng-change-impact').evidence).toMatchObject({
      equivalent: { use: 'arkona_change_impact' },
    });
    expect(ext('audit-baisheng-chronology').evidence).toMatchObject({
      equivalent: { use: 'the chronology audit' },
    });
    expect(ext('intake-baisheng-visuals').evidence).toMatchObject({
      equivalent: { use: 'arkona_visual_hygiene' },
    });
    // In plain prose (no code formatting): a name the map lists is found anywhere. Partial, and said so.
    const resume = ext('resume-baisheng-workstreams');
    expect(resume.evidence).toMatchObject({ equivalent: { use: 'arkona_working_digest', partial: true } });
    expect(resume.message).toMatch(/nearest equivalent: arkona_working_digest \(partial: /);
    // v3 F4c (ADR 0065): the story-planning skill's work is the narrative tools now.
    const stories = ext('plan-baisheng-stories');
    expect(stories.evidence).toMatchObject({
      equivalent: { use: expect.stringMatching(/arkona_story_create.*arkona_chapter_save/) as unknown },
    });
    const letters = ext('draft-baisheng-letters');
    expect(letters.evidence).not.toHaveProperty('equivalent');
    expect(letters.message).toMatch(/no equivalent/);
    expect(letters.message).toMatch(/allow the name on the Audits page/);
  });

  it('is silent about an external name the owner allowed (compared without case)', () => {
    const drafts = world({ allowed: ['Format-Baisheng-Owners', 'plan-baisheng-stories'] });
    expect(byName(drafts, 'format-baisheng-owners')).toHaveLength(0);
    expect(byName(drafts, 'plan-baisheng-stories')).toHaveLength(0);
    // The others are still reported.
    expect(byName(drafts, 'intake-baisheng-visuals')).toHaveLength(1);
  });

  it('resolves “Fiction Writing” to the Design References page; reports a name that resolves nowhere, only in a reference section', () => {
    const drafts = world();
    // The owner's review: "Arkona – Fiction Writing Reference" under Design References, tagged "Fiction Writing".
    expect(byName(drafts, 'Fiction Writing')).toHaveLength(0);
    const missing = drafts.filter((d) => d.code === 'governance_missing_reference');
    const moonlit = byName(drafts, 'Moonlit Ledger');
    expect(moonlit).toHaveLength(1);
    expect(moonlit[0]!.code).toBe('governance_missing_reference');
    expect(moonlit[0]!.documentId).toBe('docauto');
    expect(moonlit[0]!.evidence).toEqual({
      tab: { id: 'docauto', name: 'Repository Automation' },
      section: 'Repository Automation › Startup and Current Evidence',
      name: 'Moonlit Ledger',
    });
    expect(moonlit[0]!.message).toContain('“Startup and Current Evidence”');
    // Nothing in the repository is near it, and the message says what to do instead.
    expect(moonlit[0]!.message).toMatch(/nothing is near it: .*Correct it by hand, remove it/);
    // The Notes section names it too, but is not a reference section: nothing from there.
    expect(missing.every((d) => !(d.evidence as { section: string }).section.endsWith('Notes'))).toBe(true);
  });

  it('resolves a short name generously before reporting it: a page’s name without its prefixes and generic word, a tab, an alias, a tag', () => {
    const fiction = (held: FictionHeld) => byName(world({ fiction: held }), 'Fiction Writing');
    // "[BSRC] Arkona – Fiction Writing Reference": its lifecycle prefix, "Arkona – " (any dash) and "Reference" removed.
    expect(fiction('name')).toHaveLength(0);
    expect(fiction('name-hyphen')).toHaveLength(0);
    // A page of another name, tagged or aliased "Fiction Writing"; a root tab of that name.
    expect(fiction('tag')).toHaveLength(0);
    expect(fiction('alias')).toHaveLength(0);
    expect(fiction('tab')).toHaveLength(0);
    // None of those: reported.
    expect(fiction('none')).toHaveLength(1);
    // A name in the text is tried without its own generic word too ("the Fiction Writing Standard").
    const standard = world({
      navigation: [para('pn6', t('Read the Fiction Writing Standard first.'))],
    });
    expect(byName(standard, 'Fiction Writing Standard')).toHaveLength(0);
    expect(RULES.resolution).toEqual({
      leading: ['Arkona -'],
      generic: ['Reference', 'Standard', 'Workflow', 'Index'],
    });
  });

  it('reports “LK Bootstrap” as an info near miss for the root tab “AI Bootstrap”, the closest match suggested', () => {
    const lk = byName(world(), 'LK Bootstrap');
    expect(lk).toHaveLength(1);
    expect(lk[0]!.code).toBe('governance_missing_reference');
    expect(CODES.governance_missing_reference.severity).toBe('info');
    expect(lk[0]!.evidence).toEqual({
      tab: { id: 'docauto', name: 'Repository Automation' },
      section: 'Repository Automation › Startup and Current Evidence',
      name: 'LK Bootstrap',
      nearMiss: { closest: 'AI Bootstrap', kind: 'tab', page: { id: 'root', name: 'AI REPOSITORY' } },
      suggestedReplacement: 'AI Bootstrap',
    });
    expect(lk[0]!.message).toContain('a near miss for the tab “AI Bootstrap” of AI REPOSITORY');
    expect(lk[0]!.message).toContain('Suggested replacement: “AI Bootstrap”');
    expect(lk[0]!.fix).toBeUndefined();
  });

  it('suggests a replacement for every finding: a near name, a near tool, or what to do', () => {
    const drafts = world({
      navigation: [para('pn5', t('Read Projet Navigation, then call '), code('get_bridge_guid'), t('.'))],
    });
    const typo = byName(drafts, 'Projet Navigation');
    expect(typo).toHaveLength(1);
    expect(typo[0]!.message).toContain('Suggested replacement: “Project Navigation”');
    // A near miss carries its closest match in the evidence: the tab, ahead of the governance heading of that name.
    expect(typo[0]!.evidence).toMatchObject({
      section: 'Project Navigation › Startup',
      name: 'Projet Navigation',
      nearMiss: { closest: 'Project Navigation', kind: 'tab' },
      suggestedReplacement: 'Project Navigation',
    });
    // A near tool depends on the bridge's version, so it stays in the message: an upgrade never re-opens a finding.
    const slip = byName(drafts, 'get_bridge_guid');
    expect(slip).toHaveLength(1);
    expect(slip[0]!.code).toBe('governance_unknown_tool');
    expect(slip[0]!.message).toContain('Suggested replacement: get_bridge_guide');
    expect(slip[0]!.evidence).not.toHaveProperty('suggestedReplacement');
    // An external name with no equivalent says what to do with it.
    expect(byName(drafts, 'draft-baisheng-letters')[0]!.message).toMatch(/Otherwise remove it/);
    // A finding with an equivalent (pack data, stable) carries it in the evidence too.
    expect(byName(drafts, 'write_lk')[0]!.evidence).toMatchObject({
      suggestedReplacement: 'get_bridge_guide',
    });
  });

  it('is silent about names that resolve to a tab, a page, an alias, a tag or a governance heading', () => {
    const drafts = world();
    const names = drafts
      .filter((d) => d.code === 'governance_missing_reference')
      .map((d) => (d.evidence as { name: string }).name);
    // Project Navigation and the Controlled Native Tagging Standard are tabs; the Salahad Reference is a page's subject
    // with its descriptor's last word (and its subject with "Reference" dropped); the White Fox is Kamigawa Miyuki's
    // alias "The White Fox" (a leading "The" is no part of a name); Character Architecture and Source Formatting are
    // headings or tabs; Fiction Writing is a Design References page and its tag. Each resolves as a whole name.
    for (const n of [
      'Project Navigation',
      'Controlled Native Tagging Standard',
      'Salahad Reference',
      'White Fox',
      'Character Architecture',
      'Source Formatting',
      'Fiction Writing',
    ])
      expect(names, n).not.toContain(n);
    expect([...names].sort()).toEqual(['LK Bootstrap', 'Moonlit Ledger']);
  });

  it('reports a name that is only a run inside a longer name as an info near miss, naming the name and page it partially matched', () => {
    // The owner's decision (20 November 2026): never resolved silently.
    const drafts = world({
      navigation: [para('pn7', t('Read the Tagging Standard, then the Continent Reference.'))],
    });
    const tagging = byName(drafts, 'Tagging Standard');
    expect(tagging).toHaveLength(1);
    expect(tagging[0]!.code).toBe('governance_missing_reference');
    expect(CODES.governance_missing_reference.severity).toBe('info');
    expect(tagging[0]!.evidence).toEqual({
      tab: { id: 'docnav', name: 'Project Navigation' },
      section: 'Project Navigation › Startup',
      name: 'Tagging Standard',
      nearMiss: {
        closest: 'Controlled Native Tagging Standard',
        kind: 'tab',
        page: { id: 'root', name: 'AI REPOSITORY' },
        partial: true,
      },
      suggestedReplacement: 'Controlled Native Tagging Standard',
    });
    expect(tagging[0]!.message).toContain(
      'only part of a longer name: a near miss for the tab “Controlled Native Tagging Standard” of AI REPOSITORY',
    );
    expect(tagging[0]!.message).toContain('acknowledge this finding if the short form is right as it is');
    // A run inside a page's name names that page.
    expect(byName(drafts, 'Continent Reference')[0]!.evidence).toMatchObject({
      nearMiss: {
        closest: 'Salahad - Continent Reference',
        kind: 'page',
        page: { id: 'salref01', name: '[BSRC] Salahad - Continent Reference' },
        partial: true,
      },
      suggestedReplacement: 'Salahad - Continent Reference',
    });
    // A whole name still resolves silently, and so do Fiction Writing and the Fiction Writing Standard.
    expect(byName(drafts, 'Controlled Native Tagging Standard')).toHaveLength(0);
    const fiction = world({
      navigation: [para('pn8', t('Read Fiction Writing and the Fiction Writing Standard.'))],
    });
    expect(byName(fiction, 'Fiction Writing')).toHaveLength(0);
    expect(byName(fiction, 'Fiction Writing Standard')).toHaveLength(0);
  });

  it('reads a tab the snapshot could not give as nothing (no finding about it)', () => {
    const drafts = world();
    expect(drafts.filter((d) => d.documentId === 'doctag')).toHaveLength(0);
  });

  it('does nothing without a pack’s drift rules (no governance input)', () => {
    const m = model([page({ id: 'root', name: 'AI REPOSITORY', root: true })]);
    expect(governanceCheck(context(m))).toEqual([]);
  });
});

describe('the governance check’s reading of text', () => {
  it('splits capitalised runs at clause punctuation and lower-case words, keeping joining words inside', () => {
    expect(capitalisedRuns('Read Fiction Writing before any prose task.')).toEqual([
      ['Read', 'Fiction', 'Writing'],
    ]);
    expect(
      capitalisedRuns('See “Approved Hierarchy and Standardised Navigation”, then Arkona’s Polities.'),
    ).toEqual([
      ['See'],
      ['Approved', 'Hierarchy', 'and', 'Standardised', 'Navigation'],
      ['Arkona'],
      ['Polities'],
    ]);
    expect(capitalisedRuns('Repository Automation’s Startup section')).toEqual([
      ['Repository', 'Automation'],
      ['Startup'],
    ]);
  });

  it('takes known names out of a run first, then drops a starter, and never lets one word stand for a name', () => {
    const known = resolvableNames([
      'Project Navigation',
      'Fiction',
      'Approved Hierarchy and Standardised Navigation',
    ]);
    expect(unresolvedIn(['Read', 'Project', 'Navigation'], known)).toEqual([]);
    // A page called "Fiction" does not hide a missing "Fiction Writing".
    expect(unresolvedIn(['Read', 'Fiction', 'Writing'], known)).toEqual(['Fiction Writing']);
    expect(unresolvedIn(['Project', 'Navigation', 'and', 'Fiction', 'Writing'], known)).toEqual([
      'Fiction Writing',
    ]);
    expect(unresolvedIn(['Approved', 'Hierarchy', 'and', 'Standardised', 'Navigation'], known)).toEqual([]);
    // Only a run inside a longer name: returned, for the check to report as a near miss naming that name.
    expect(unresolvedIn(['Read', 'Standardised', 'Navigation'], known)).toEqual(['Standardised Navigation']);
  });

  it('resolves a whole name only: as it is, without its trailing generic word or a leading “The”', () => {
    const known = resolvableNames([
      'Fiction Writing Reference',
      'Controlled Native Tagging Standard',
      'The White Fox',
    ]);
    // The tab without its generic word, a name in the text without its own, an alias without its "The".
    expect(knows(known, nameNorm('Controlled Native Tagging'))).toBe(true);
    expect(knows(known, nameNorm('Fiction Writing Standard'))).toBe(true);
    expect(knows(known, nameNorm('White Fox'))).toBe(true);
    expect(knows(known, nameNorm('Moonlit Ledger'))).toBe(false);
    // A run inside a longer name is not resolved: it is only part of one.
    expect(knows(known, nameNorm('Native Tagging Standard'))).toBe(false);
    expect(partOfKnown(known, nameNorm('Native Tagging Standard'))).toBe(true);
    expect(partOfKnown(known, nameNorm('Moonlit Ledger'))).toBe(false);
    expect(partOfKnown(known, nameNorm('Controlled Native Tagging Standard'))).toBe(false);
    // Only a trailing generic word: "Reference Desk" is not "Desk".
    expect(knows(resolvableNames(['Desk']), nameNorm('Reference Desk'))).toBe(false);
  });

  it('names the known name a run is part of: a tab first, then the fewest words, then alphabetical', () => {
    const root = { id: 'root', name: 'AI REPOSITORY' };
    const keys: KnownKey[] = (
      [
        { name: 'Controlled Native Tagging Standard', kind: 'heading' },
        { name: 'Controlled Native Tagging Standard', kind: 'tab', page: root },
        {
          name: 'Velaran - Continent Reference',
          kind: 'page',
          page: { id: 'velref01', name: '[BSRC] Velaran - Continent Reference' },
        },
        {
          name: 'Salahad - Continent Reference',
          kind: 'page',
          page: { id: 'salref01', name: '[BSRC] Salahad - Continent Reference' },
        },
      ] as const
    ).map((c) => ({ key: nameNorm(c.name), c }));
    const generic = new Set(['reference', 'standard', 'workflow', 'index']);
    // The tab ahead of the heading of the same name, counted once.
    expect(containingName('Tagging Standard', keys, generic)).toEqual({ c: keys[1]!.c, of: 1 });
    // Two pages hold the run: the first alphabetically is named, and both are counted.
    expect(containingName('Continent Reference', keys, generic)).toEqual({ c: keys[3]!.c, of: 2 });
    // A whole name is not part of itself; a name nowhere is part of nothing.
    expect(containingName('Controlled Native Tagging Standard', keys, generic)).toBeNull();
    expect(containingName('Moonlit Ledger', keys, generic)).toBeNull();
  });

  it('finds the closest name literally: a slip of two edits, the same words reordered, or a longer name holding them', () => {
    const root = { id: 'root', name: 'AI REPOSITORY' };
    const known = new Map<string, KnownName>(
      (
        [
          { name: 'Project Navigation', kind: 'tab', page: root },
          { name: 'AI Bootstrap', kind: 'tab', page: root },
          { name: 'Fiction and Prose Writing', kind: 'page' },
          { name: 'Writing Fiction', kind: 'alias' },
          { name: 'Source Formatting', kind: 'heading' },
        ] as const
      ).map((c) => [nameNorm(c.name), c]),
    );
    expect(closestName('Projet Navigation', known)?.name).toBe('Project Navigation');
    expect(closestName('LK Bootstrap', known)).toMatchObject({
      name: 'AI Bootstrap',
      kind: 'tab',
      page: root,
    });
    // The same words reordered are nearer than a longer name holding them.
    expect(closestName('Fiction Writing', known)?.name).toBe('Writing Fiction');
    expect(closestName('Character Voice', known)).toBeNull();
    // A short name allows one slip only.
    expect(
      closestName('XY Boot', new Map([['ai boot', { name: 'AI Boot', kind: 'tab' as const }]])),
    ).toBeNull();
    expect(
      closestName('AB Boot', new Map([['ai boot', { name: 'AI Boot', kind: 'tab' as const }]]))?.name,
    ).toBe('AI Boot');
    const tools = new Set(['get_bridge_guide', 'get_resource', 'search', 'lk_op_getresource']);
    expect(nearTool('get_bridge_guid', tools)).toBe('get_bridge_guide');
    expect(nearTool('get_resourc', tools)).toBe('get_resource');
    // Operations are never suggested, and a name far from every tool has no suggestion.
    expect(nearTool('lk_op_getresourc', tools)).toBeNull();
    expect(nearTool('frobnicate_pages', tools)).toBeNull();
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
    expect(editDistance('kitten', 'sitting', 1)).toBe(2);
  });

  it('reads an old call’s arguments, and a block’s section and code spans', () => {
    expect(argsIn('call write_lk {"job_action":"guide"}', ['job_action'])).toEqual({ job_action: 'guide' });
    expect(argsIn('write_lk with job_action = Guide', ['job_action'])).toEqual({ job_action: 'guide' });
    const b = governanceBlocks(ARCHITECTURE, ['Startup']);
    const call = b.find((x) => x.blockId === 'ca3')!;
    expect(call.code).toEqual(['write_lk {"job_action":"guide"}']);
    expect(call.section).toBe(
      'Character Architecture › Character Naming-Culture Verification & Identity Revision',
    );
  });
});
