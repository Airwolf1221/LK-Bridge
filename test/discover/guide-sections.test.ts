/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * Forgiving guide sections (v2 E3b, ADR 0045): every SECTION_NOT_FOUND the owner's evaluation produced, several matches,
 * and none; first as the matcher, then through the tools.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outline } from '../../src/markdown/index.js';
import {
  exactName,
  matchSection,
  SECTION_ALIASES,
  sectionNames,
} from '../../src/mcp/tools/guide-sections.js';
import { GUIDES, readGuide } from '../../src/mcp/tools/guides.js';
import { discoverWorld, type DiscoverWorld } from './world.js';

const guideOf = (id: 'bridge' | 'markdown') => outline(readGuide(GUIDES.find((g) => g.id === id)!));
const bridge = guideOf('bridge');
const markdown = guideOf('markdown');
const one = (asked: string, guide: 'bridge' | 'markdown' = 'bridge'): string => {
  const m = matchSection(guide === 'bridge' ? bridge : markdown, asked, guide);
  if (m.kind !== 'one') throw new Error(`${asked}: ${m.kind}`);
  return exactName(m.heading);
};

describe('the misses of the owner’s evaluation (14 to 15 November 2026)', () => {
  it.each([
    ['find pages', 'Find and read a page'], // scenario 1, ChatGPT
    ["Read a page's text (or one section)", 'Find and read a page'], // scenario 4, ChatGPT: a label of the which-tool table
    ['Promote', 'The page lifecycle'], // scenario 8, Claude
  ])('%j leads to %j', (asked, section) => {
    expect(one(asked)).toBe(section);
  });

  it('every label of the which-tool table in “How to decide” leads to a section, none to a wrong one', () => {
    const text = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
    const decide = text.slice(text.indexOf('## How to decide'), text.indexOf('\n## Find and read a page'));
    const labels = [...decide.matchAll(/^\| (?!You want|-)([^|]+?)\s+\|/gm)].map((m) => m[1]!.trim());
    expect(labels.length).toBeGreaterThan(15);
    const unmatched: string[] = [];
    for (const label of labels) {
      const m = matchSection(bridge, label, 'bridge');
      if (m.kind === 'none') unmatched.push(label);
    }
    // A label may be ambiguous between sections (listed as candidates), but it is never silently dropped.
    expect(unmatched).toEqual([]);
  });

  it.each([
    ['Make any other page', 'Create a page or a character (Working first)'], // scenarios 14 and 7
    ["Change a page's text", "Edit a page's text"], // scenario 10
    ['Make Working work canon', 'The page lifecycle'], // scenario 26
    ['promotion', 'The page lifecycle'],
    ['lifecycle', 'The page lifecycle'],
    ['promote_page', 'The page lifecycle'],
    ['Canon', 'Canon and approval'],
    ['arkona_create_character', 'Setting packs (Arkona) > Arkona characters'], // v3 F3a
    ['Make an Arkona character, or add pages to one', 'Setting packs (Arkona) > Arkona characters'],
    ['pack', 'Setting packs (Arkona)'],
    ['Arkona', 'Setting packs (Arkona)'],
    ['completion gate', 'Setting packs (Arkona) > Arkona characters'],
    // v3 F3b (ADR 0052): a part per tool; F3a's section name leads to the character part.
    ['Setting packs (Arkona characters)', 'Setting packs (Arkona) > Arkona characters'],
    ['arkona_create_owner', 'Setting packs (Arkona) > Arkona owners'],
    ['Make any other Arkona owner page (polity, race…)', 'Setting packs (Arkona) > Arkona owners'],
    ['promoteNation', 'Setting packs (Arkona) > Arkona owners'],
    ['Arkona owners', 'Setting packs (Arkona) > Arkona owners'],
    ['arkona_create_relationship', 'Setting packs (Arkona) > Arkona relationships, art and the brief'],
    ['arkona_add_character_art', 'Setting packs (Arkona) > Arkona relationships, art and the brief'],
    ['arkona_character_brief', 'Setting packs (Arkona) > Arkona relationships, art and the brief'],
    [
      'Relate two Arkona characters, or add art to one',
      'Setting packs (Arkona) > Arkona relationships, art and the brief',
    ],
    // v3 F3c (ADR 0054): the appraisal part.
    ['arkona_appraise_owner', 'Setting packs (Arkona) > Arkona appraisal'],
    ['arkona_change_impact', 'Setting packs (Arkona) > Arkona appraisal'],
    ['arkona_working_digest', 'Setting packs (Arkona) > Arkona appraisal'],
    ['arkona_visual_hygiene', 'Setting packs (Arkona) > Arkona appraisal'],
    ['arkona_appraisal_fix', 'Setting packs (Arkona) > Arkona appraisal'],
    ['Appraise Arkona pages, or see what a change breaks', 'Setting packs (Arkona) > Arkona appraisal'],
    ['appraisal', 'Setting packs (Arkona) > Arkona appraisal'],
    // v3 F3d (ADR 0058): the renames part.
    ['arkona_rename', 'Setting packs (Arkona) > Arkona renames'],
    ['Arkona renames', 'Setting packs (Arkona) > Arkona renames'],
    // v3 F3e (ADR 0059): the splits part.
    ['arkona_split_owner', 'Setting packs (Arkona) > Arkona splits'],
    ['arkona_split_appraisal', 'Setting packs (Arkona) > Arkona splits'],
    ['Arkona splits', 'Setting packs (Arkona) > Arkona splits'],
    ['Split an Arkona owner into several owners', 'Setting packs (Arkona) > Arkona splits'],
    ['Make a character', 'Create a page or a character (Working first)'],
    ['set_facts', 'Change facts and links'],
    ['write_page', "Edit a page's text"],
    ['upload_image', 'Images'],
    ['errors', 'Reference > When something goes wrong'],
  ])('%j leads to %j', (asked, section) => {
    expect(one(asked)).toBe(section);
  });

  it('is case-, punctuation- and spacing-insensitive', () => {
    for (const asked of ['FIND-AND-READ  a PAGE', 'find and read a page!', ' Find, and read a page ']) {
      expect(one(asked), asked).toBe('Find and read a page');
    }
    expect(one('A > Maps')).toBe('Maps'); // a path names its last segment
  });
});

describe('E4 (the owner’s run of 15 November 2026): a task section wins over reference sections', () => {
  // `section: "chronology"` answered SECTION_AMBIGUOUS: "Dates and the chronology" tied with the generated
  // "Operations > Timelines" and "Operations > Calendars". A task section that matches beats reference sections.
  it.each([
    ['chronology', 'Dates and the chronology'],
    ['timeline', 'Dates and the chronology'],
    ['event', 'Dates and the chronology'],
    ['date', 'Dates and the chronology'],
    ['dates', 'Dates and the chronology'],
    ['calendar', 'Dates and the chronology'],
    ['map', 'Maps'],
    ['image', 'Images'],
    ['snapshot', 'Snapshots and restores'],
    ['audit', 'Audit findings'],
  ])('%j leads to exactly one section, %j', (asked, section) => {
    expect(one(asked)).toBe(section);
  });

  it('a reference section is still found when no task section matches', () => {
    expect(one('errors')).toBe('Reference > When something goes wrong');
    expect(one('Operations > Timelines')).toBe('Operations > Timelines');
  });

  it('two task sections that both match stay ambiguous', () => {
    expect(matchSection(bridge, 'page', 'bridge').kind).toBe('several');
  });
});

describe('several matches and none', () => {
  it('a word several sections share lists the candidates, best first', () => {
    const m = matchSection(bridge, 'page', 'bridge');
    expect(m.kind).toBe('several');
    if (m.kind !== 'several') return;
    const names = m.candidates.map(exactName);
    expect(names).toContain('Find and read a page');
    expect(names).toContain("Edit a page's text");
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it('a name no section is near is none', () => {
    expect(matchSection(bridge, 'xyzzy', 'bridge').kind).toBe('none');
    expect(matchSection(bridge, '???', 'bridge').kind).toBe('none');
  });

  it('every alias belongs to a real section of its guide', () => {
    // Keyed by the heading's own text (a part such as "Arkona owners" too), as matchSection reads them.
    const real = new Set([...sectionNames(bridge), ...bridge.filter((h) => h.level >= 2).map((h) => h.text)]);
    for (const heading of Object.keys(SECTION_ALIASES.bridge!)) expect(real.has(heading), heading).toBe(true);
    const mdReal = new Set(sectionNames(markdown));
    for (const heading of Object.keys(SECTION_ALIASES.markdown!))
      expect(mdReal.has(heading), heading).toBe(true);
  });

  it('works on the Markdown guide too', () => {
    expect(one('keep region', 'markdown')).toBe('Keep regions');
    expect(one('error codes', 'markdown')).toBe('Errors');
    expect(one('limit', 'markdown')).toBe('Limits');
  });
});

describe('through the tools', () => {
  let w: DiscoverWorld;
  beforeAll(async () => {
    w = await discoverWorld({ bulk: 5 });
  });
  afterAll(() => w.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    w.stack.call(await w.stack.connect(), name, { project: 'test', ...args });

  it('returns a clear match, noting the exact name', async () => {
    for (const asked of ['find pages', "Read a page's text (or one section)", 'Promote']) {
      const r = await call('get_bridge_guide', { section: asked });
      expect(r.isError, asked).toBe(false);
      expect(r.body.matched, asked).toContain(`“${asked}” was read as the section “${r.body.section}”`);
      expect(r.body.markdown, asked).toMatch(new RegExp(`^## ${r.body.section}`));
    }
    expect((await call('get_bridge_guide', { section: 'Promote' })).body.section).toBe('The page lifecycle');
  });

  it('an exact name needs no note', async () => {
    const r = await call('get_bridge_guide', { section: 'Maps' });
    expect(r.body).toMatchObject({ section: 'Maps' });
    expect(r.body.matched).toBeUndefined();
  });

  it('lists the candidates when several match, and every exact name when none do', async () => {
    const several = await call('get_bridge_guide', { section: 'page' });
    expect(several.isError).toBe(true);
    expect(several.body.error).toMatchObject({ code: 'SECTION_AMBIGUOUS' });
    expect(several.body.error.candidates).toEqual(expect.arrayContaining(['Find and read a page']));
    expect(several.body.markdown).toBeUndefined();

    const none = await call('get_bridge_guide', { section: 'xyzzy' });
    expect(none.body.error).toMatchObject({ code: 'SECTION_NOT_FOUND' });
    const names: string[] = none.body.error.sections;
    for (const h of ['How to decide', 'Find and read a page', 'The page lifecycle', 'Reference > Projects'])
      expect(names, h).toContain(h);
    expect(names).not.toContain('The LK-Bridge guide for agents');
    expect(none.body.error.hint).toMatch(/exact section names/);
  });

  it('serves the Markdown guide the same way', async () => {
    const r = await call('get_markdown_guide', { section: 'keep region' });
    expect(r.body).toMatchObject({ section: 'Keep regions' });
    expect(r.body.matched).toBeDefined();
    const none = await call('get_markdown_guide', { section: 'nothing like it' });
    expect(none.body.error.code).toBe('SECTION_NOT_FOUND');
  });

  it('"How to decide" sends a subject’s rename to arkona_rename, on a line of its own (ADR 0058 amendment C)', () => {
    const text = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
    const decide = text.slice(text.indexOf('## How to decide'), text.indexOf('\n## Find and read a page'));
    expect(decide).toMatch(/^\*\*Rename a subject → `arkona_rename` \(never `update_resource`\)\.\*\*/m);
  });

  it('"How to decide" lists the exact section names to ask for', () => {
    const text = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
    const decide = text.slice(text.indexOf('## How to decide'), text.indexOf('\n## Find and read a page'));
    for (const name of sectionNames(bridge).filter((n) => !n.includes('>') && n !== 'How to decide')) {
      if (name === 'Operations') continue; // generated at serve time, named in the list too
      expect(decide, name).toContain(`\`${name}\``);
    }
    expect(decide).toContain('`Operations`');
    expect(decide).toContain('`When something goes wrong`');
  });
});
