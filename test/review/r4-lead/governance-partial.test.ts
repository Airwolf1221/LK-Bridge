/**
 * CR-2026-11-R4, the lead reviewer's check of ADR 0063's decision 3 (the owner's correction of 20 November 2026): a name
 * that resolves only as a run inside a longer name is reported as an info near miss, never resolved silently. The
 * fixtures are \`test/audits/governance.test.ts\`'s, copied verbatim; each test asserts the SAFE behaviour.
 *
 * - LD-05: "the Native Tagging Standard" (a run inside the tab "Controlled Native Tagging Standard") while a governance
 *   document also has a heading "Tagging": its sub-run "Tagging Standard" resolved as the one-word heading plus a generic
 *   word, and the rest ("Native") was dropped, so nothing was reported.
 * - LD-06: "the Tagging Standard" itself (the owner's own example) with that heading.
 * - Controls: the same texts without the heading are reported as partial near misses (held before and after).
 */
import { describe, expect, it } from 'vitest';
import {
  governanceCheck,
  knows,
  nameNorm,
  resolvableNames,
  type GovernanceAuditInput,
  type KnownNames,
} from '../../../src/audits/checks/governance.js';
import type { AuditContext } from '../../../src/audits/context.js';
import type { FindingDraft } from '../../../src/audits/types.js';
import { ARKONA_PACK } from '../../../src/packs/arkona.js';
import { context, model, page } from '../../audits/helpers.js';

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


describe('decision 3: a run inside a longer name is never resolved silently (LD-05, LD-06)', () => {
  const tagging = heading('pn9', 2, 'Tagging');
  const partialOf = (drafts: readonly FindingDraft[], name: string) =>
    byName(drafts, name).map((d) => (d.evidence as { nearMiss?: { closest?: string; partial?: boolean } }).nearMiss);

  it('control: “the Native Tagging Standard” alone is a partial near miss for the tab', () => {
    const drafts = world({ navigation: [para('pn7', t('Read the Native Tagging Standard.'))] });
    expect(partialOf(drafts, 'Native Tagging Standard')).toEqual([
      expect.objectContaining({ closest: 'Controlled Native Tagging Standard', partial: true }),
    ]);
  });

  it('LD-05: with a heading “Tagging” in a governance document, “the Native Tagging Standard” is still a partial near miss', () => {
    const drafts = world({ navigation: [para('pn7', t('Read the Native Tagging Standard.')), tagging] });
    expect(
      partialOf(drafts, 'Native Tagging Standard'),
      'resolved silently: a one-word heading plus a generic word took the run',
    ).toEqual([expect.objectContaining({ closest: 'Controlled Native Tagging Standard', partial: true })]);
  });

  it('LD-06: with that heading, the owner’s own example “the Tagging Standard” is still a partial near miss', () => {
    const drafts = world({ navigation: [para('pn7', t('Read the Tagging Standard.')), tagging] });
    expect(partialOf(drafts, 'Tagging Standard'), 'resolved silently through the heading “Tagging”').toEqual([
      expect.objectContaining({ closest: 'Controlled Native Tagging Standard', partial: true }),
    ]);
  });

  it('a single word never stands for a name: a two-word name does not resolve to a one-word known name', () => {
    const known = resolvableNames(['Tagging', 'Fiction Writing Reference']);
    expect(knows(known, nameNorm('Tagging Standard'))).toBe(false);
    // A whole name of two words or more still resolves without its trailing generic word.
    expect(knows(known, nameNorm('Fiction Writing Standard'))).toBe(true);
  });
});
