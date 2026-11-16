/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052): `arkona_create_owner`, by the owner-approved design (docs/design/F3b-owner-tools.md, section 1),
 * against the mock LegendKeeper with the owners world's fixtures: every type of the pack's table makes the right
 * template, name, tags and sidebar (in rank order); every allowed home is accepted and a home of another kind refused
 * with suitable homes nearby; `homeOverride`'s reason reaches the proposal; the race roster's kinds, the Bestiary and the
 * character navigation; the name, facts, text and link rules; the Working default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HomeRule, OwnerType } from '../../src/packs/types.js';
import { approve, C } from './world.js';
import {
  compactPolity,
  O,
  PROJECT,
  OSTRAND,
  OTPL,
  OWNER_KEYS,
  ownerText,
  ownersWorld,
  TPL,
  VELARIA,
  type OwnersWorld,
} from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const TOOL = 'arkona_create_owner';
const call = (args: Record<string, unknown>) => w.call(TOOL, { project: 'test', ...args });
const dry = (args: Record<string, unknown>) => call({ ...args, dryRun: true });
const owners = () => w.stack.runtime.packs.get('arkona')!.rules.owners!;
const typeOf = (name: string): OwnerType => owners().types.find((t) => t.name === name)!;
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const rowsOf = (id: string) => w.sidebars.rows(id).map((r) => [r.key, r.text] as const);

/** The package for a type at a home (a valid, minimal owner). */
const pkg = (type: string, home: string, over: Record<string, unknown> = {}) => ({
  type,
  name: `Test ${type}`,
  descriptor: `${type} Reference`,
  home,
  status: 'authoritative',
  referenceType: `${type} Reference`,
  scope: `A ${type.toLowerCase()} of the test world`,
  temporalScope: '4A 1 - 4A 100',
  markdown: ownerText(`The ${type.toLowerCase()} reference.`),
  ...over,
});

/** A fixture index for a home rule (Salahad first, then Velaria and Ostrand, the world, the realms, the Bestiary). */
function homeFor(rule: HomeRule): string | null {
  switch (rule.kind) {
    case 'category': {
      if (rule.level === 'world') return `Arkonan ${rule.category}`;
      if (rule.level === 'continent') {
        const salahad = [
          'Polities',
          'Institutions',
          'Cultures',
          'Historical Events',
          'Conflicts',
          'Regions',
          'Settlements & Locations',
          'Unique Magic & Technologies',
        ];
        if (salahad.includes(rule.category)) return `Salahad ${rule.category}`;
        return rule.category in VELARIA ? `Velaria ${rule.category}` : null;
      }
      const menkhet = [
        'Government & Administration',
        'Institutions',
        'Settlements & Locations',
        'Unique Magic & Technologies',
      ];
      if (menkhet.includes(rule.category)) return `Menkhet ${rule.category}`;
      return rule.category in OSTRAND ? `Ostrand ${rule.category}` : null;
    }
    case 'nation':
      return 'Menkhet';
    case 'named':
      return rule.name;
    case 'under':
      return 'Celestine Vault';
    case 'index':
      return rule.name;
    case 'races':
      return null;
  }
}

/** Each type's template id in the owners world. */
const TEMPLATE_OF: Record<string, string> = {
  polity: OTPL.polity,
  place: OTPL.place,
  magictech: OTPL.magictech,
  creature: OTPL.creature,
  general: TPL.general,
};

describe('every type of the table (design 1.1)', () => {
  it('makes its template, name, tags and sidebar, in rank order', async () => {
    const types = owners().types;
    expect(types.map((t) => t.name)).toEqual([
      'Polity',
      'Institution',
      'Military',
      'Culture',
      'Event',
      'Place',
      'Technology',
      'Magic',
      'Material',
      'Equipment',
      'Species',
      'Creature',
      'Religion',
      'Law',
      'Programme',
      'Education',
      'Ceremony',
      'Condition',
      'Relationship',
    ]);
    for (const t of types) {
      const home = homeFor(t.homes.find((r) => homeFor(r) !== null)!)!;
      const r = await dry(pkg(t.name, home));
      expect(r.isError, `${t.name}: ${r.text}`).toBe(false);
      const page = r.body.pages.find((p: { role: string }) => p.role === 'owner');
      expect(page.name, t.name).toBe(`[BSRC] Test ${t.name} - ${t.name} Reference`);
      expect(page.template.id, t.name).toBe(TEMPLATE_OF[t.template]);
      expect(page.tags, t.name).toEqual(['CANON', t.primary]);
      // The ten rows in the template's rank order (Last Major Revision is dated by the job).
      expect(
        page.facts.map((f: { key: string }) => f.key),
        t.name,
      ).toEqual(OWNER_KEYS.filter((k) => k !== 'Last Major Revision'));
      expect(page.facts, t.name).toEqual(
        expect.arrayContaining([
          { key: 'Status', value: 'Authoritative' },
          { key: 'Continuity Type', value: 'CANON' },
          { key: 'Continuity', value: 'Main' },
          { key: 'Inheritance', value: 'None' },
          { key: 'Subject', value: `Test ${t.name}` },
          { key: 'Reference Type', value: `${t.name} Reference` },
          { key: 'Temporal Scope', value: '4A 1 - 4A 100' },
          { key: 'Supersedes', value: 'None' },
        ]),
      );
    }
  });

  it('a specialist tag from the type’s closed list follows the primary; another is refused', async () => {
    const ok = await dry(pkg('Polity', 'Salahad Polities', { specialistTag: 'Government' }));
    expect(ok.body.pages[0].tags).toEqual(['CANON', 'Polity', 'Government']);
    const eq = await dry(
      pkg('Equipment', 'Salahad Unique Magic & Technologies', { specialistTag: 'Sacred Blade' }),
    );
    expect(eq.body.pages[0].tags).toEqual(['CANON', 'Equipment', 'Sacred Blade']);
    const bad = await dry(pkg('Polity', 'Salahad Polities', { specialistTag: 'Magic' }));
    expect(bad.body.error.code).toBe('TAG_NOT_ALLOWED');
  });

  it('runs one owner of each template through the job and verifies its rows in rank order', async () => {
    for (const [type, home] of [
      ['Polity', 'Salahad Polities'],
      ['Culture', 'Salahad Cultures'],
      ['Place', 'Salahad Regions'],
      ['Magic', 'Salahad Unique Magic & Technologies'],
      ['Creature', 'Bestiary'],
    ] as const) {
      const p = await call(pkg(type, home, { name: `Job ${type}` }));
      expect(p.body.status, p.text).toBe('proposal_captured');
      const done = await approve(w, String(p.body.proposalId));
      expect(done.job?.status, `${type}: ${JSON.stringify(done.job?.lastError)}`).toBe('succeeded');
      expect((done.job?.result as { verified?: boolean }).verified, type).toBe(true);
      const page = pageNamed(`[BSRC] Job ${type} - ${type} Reference`)!;
      expect(w.repo.res.get(page.parentId!)!.name.replace('[INDEX] ', '')).toBe(home);
      expect(page.tags).toEqual(['CANON', typeOf(type).primary]);
      const rows = rowsOf(page.id);
      expect(rows.map(([k]) => k)).toEqual(OWNER_KEYS);
      expect(Object.fromEntries(rows)).toMatchObject({
        Status: 'Authoritative',
        Subject: `Job ${type}`,
        'Reference Type': `${type} Reference`,
        Supersedes: 'None',
      });
      expect(Object.fromEntries(rows)['Last Major Revision']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('homes (design 1.2)', () => {
  it('accepts every allowed home of every type', async () => {
    let tried = 0;
    for (const t of owners().types) {
      for (const rule of t.homes) {
        const home = homeFor(rule);
        if (home === null) continue;
        const r = await dry(pkg(t.name, home));
        expect(r.isError, `${t.name} in ${home}: ${r.text}`).toBe(false);
        expect(r.body.home.fits, `${t.name} in ${home}`).toBeTruthy();
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(45);
  });

  it('refuses a home of another kind for every type, with suitable homes nearby that are themselves allowed', async () => {
    for (const t of owners().types) {
      const wrong = t.homes.some((r) => homeFor(r) === 'Salahad Cultures')
        ? 'Salahad Polities'
        : 'Salahad Cultures';
      const r = await dry(pkg(t.name, wrong));
      expect(r.body.error?.code, `${t.name} in ${wrong}`).toBe('HOME_NOT_ALLOWED');
      const s = r.body.error.suggestions as { name: string; path: string; fits: string }[];
      expect(s.length, t.name).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(5);
      const first = await dry(pkg(t.name, s[0]!.path.split(' / ').slice(1).join(' / ')));
      expect(first.isError, `${t.name}: suggestion ${s[0]!.path}: ${first.text}`).toBe(false);
    }
  });

  it('suggests the nearest suitable homes first', async () => {
    const r = await dry(pkg('Institution', 'Salahad Cultures'));
    expect(r.body.error.suggestions[0].name).toBe('[INDEX] Salahad Institutions');
  });

  it('refuses a substantive page as a home (Races of Arkona for a Polity), and a home that is not there', async () => {
    const races = await dry(pkg('Polity', 'Races of Arkona'));
    expect(races.body.error.code).toBe('HOME_NOT_ALLOWED');
    expect(races.body.error.message).toMatch(/substantive page/);
    const ref = await dry(pkg('Polity', 'Salahad - Continent Reference'));
    expect(ref.body.error.code).toBe('HOME_NOT_ALLOWED');
    const none = await dry(pkg('Polity', 'Nowhere Polities'));
    expect(none.body.error.code).toBe('HOME_NOT_FOUND');
    expect(none.body.error.suggestions.length).toBeGreaterThan(0);
  });

  it('takes a home by id or by path', async () => {
    const byId = await dry(pkg('Polity', O.salahadPolities));
    expect(byId.body.home.name).toBe('[INDEX] Salahad Polities');
    const byPath = await dry(pkg('Event', 'Salahad / Salahad Historical Events / Salahad Conflicts'));
    expect(byPath.isError, byPath.text).toBe(false);
    expect(byPath.body.home.fits).toBe('<Continent> Conflicts');
  });

  it('homeOverride lets a home through and prints its reason in the proposal', async () => {
    const reason = 'The owner files this polity with the cultures until its polity page is split.';
    const r = await dry(pkg('Polity', 'Salahad Cultures', { homeOverride: { reason } }));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.warnings.map((x: { code: string }) => x.code)).toContain('HOME_OVERRIDDEN');
    expect(r.body.home.override).toBe(reason);
    const p = await call(
      pkg('Polity', 'Salahad Cultures', { name: 'Override Polity', homeOverride: { reason } }),
    );
    expect(p.body.status, p.text).toBe('proposal_captured');
    const prop = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(prop.summary).toContain(`home override: ${reason}`);
    expect(prop.pages.join('\n')).toContain(reason);
    // An override needs a reason.
    const none = await dry(pkg('Polity', 'Salahad Cultures', { homeOverride: { reason: ' ' } }));
    expect(none.body.error.code).toBe('OVERRIDE_NEEDS_REASON');
  });

  it('never takes a home in the Working or Archived area', async () => {
    const r = await dry(pkg('Polity', 'Working', { homeOverride: { reason: 'try' } }));
    expect(r.body.error.code).toBe('HOME_IN_LIFECYCLE_AREA');
  });
});

describe('the race roster and the Bestiary (design 1.1a, the owner’s ruling)', () => {
  const race = (over: Record<string, unknown>) =>
    pkg('Species', 'Beastkin - Racial Group Reference', {
      kind: 'race',
      name: 'Qilin',
      descriptor: undefined,
      referenceType: undefined,
      ...over,
    });

  it('a race in its racial group: “<Race> - Core Information”, Race Core Reference, CANON and Species', async () => {
    const r = await dry(race({}));
    expect(r.isError, r.text).toBe(false);
    const page = r.body.pages.find((p: { role: string }) => p.role === 'owner');
    expect(page.name).toBe('[BSRC] Qilin - Core Information');
    expect(page.parent).toBe('[BSRC] Beastkin - Racial Group Reference');
    expect(page.referenceType).toBe('Race Core Reference');
    expect(page.tags).toEqual(['CANON', 'Species']);
  });

  it('a race of no group sits in Races of Arkona itself', async () => {
    const r = await dry(race({ name: 'Titans', home: 'Races of Arkona' }));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.pages.at(-1).parent).toBe('[BSRC] Races of Arkona');
  });

  it('a racial group: “<Group> - Racial Group Reference” in Races of Arkona, tagged Racial Group', async () => {
    const r = await dry(race({ kind: 'racialGroup', name: 'Merfolk', home: 'Races of Arkona' }));
    expect(r.isError, r.text).toBe(false);
    const page = r.body.pages.find((p: { role: string }) => p.role === 'owner');
    expect(page.name).toBe('[BSRC] Merfolk - Racial Group Reference');
    expect(page.referenceType).toBe('Racial Group Reference');
    expect(page.tags).toEqual(['CANON', 'Species', 'Racial Group']);
  });

  it('a subrace under its race’s Core Information: “<Subrace> - Subrace Reference”', async () => {
    const r = await dry(
      race({
        kind: 'subrace',
        name: 'Low Humans',
        home: 'Humans - Core Information',
        referenceType: 'Subrace Reference',
      }),
    );
    expect(r.isError, r.text).toBe(false);
    const page = r.body.pages.find((p: { role: string }) => p.role === 'owner');
    expect(page.name).toBe('[BSRC] Low Humans - Subrace Reference');
    expect(page.parent).toBe('[BSRC] Humans - Core Information');
    expect(page.tags).toEqual(['CANON', 'Species']);
  });

  it('a non-race species and a creature go to the Bestiary; the roster refuses them', async () => {
    const species = await dry(pkg('Species', 'Bestiary', { name: 'Glass Moth' }));
    expect(species.isError, species.text).toBe(false);
    expect(species.body.pages[0].parent).toBe('[INDEX] Bestiary');
    expect(species.body.pages[0].tags).toEqual(['CANON', 'Species']);
    const creature = await dry(pkg('Creature', 'Bestiary', { name: 'Dune Wyrm' }));
    expect(creature.body.pages[0].parent).toBe('[INDEX] Bestiary');
    expect(creature.body.pages[0].tags).toEqual(['CANON', 'Creature']);
    for (const home of ['Races of Arkona', 'Beastkin - Racial Group Reference']) {
      const r = await dry(pkg('Species', home, { name: 'Glass Moth' }));
      expect(r.body.error.code, home).toBe('HOME_NOT_ALLOWED');
    }
    const raceInBestiary = await dry(race({ home: 'Bestiary' }));
    expect(raceInBestiary.body.error.code).toBe('HOME_NOT_ALLOWED');
    expect(raceInBestiary.body.error.suggestions.map((s: { name: string }) => s.name)).toContain(
      '[BSRC] Beastkin - Racial Group Reference',
    );
    const kindForPolity = await dry(pkg('Polity', 'Salahad Polities', { kind: 'race' }));
    expect(kindForPolity.body.error.code).toBe('KIND_NOT_FOR_TYPE');
  });

  it('fixes a race’s Reference Type and name: another is refused', async () => {
    const rt = await dry(race({ referenceType: 'Species Reference' }));
    expect(rt.body.error.code).toBe('REFERENCE_TYPE_FIXED');
    const d = await dry(race({ descriptor: 'People' }));
    expect(d.body.error.code).toBe('DESCRIPTOR_FIXED');
  });

  it('warns that a new race has no character navigation, and makes it only when named', async () => {
    const warned = await dry(race({}));
    const nav = warned.body.warnings.find((x: { code: string }) => x.code === 'CHARACTER_NAVIGATION_MISSING');
    expect(nav.path).toBe('Characters / Beastkin / Qilin');
    expect(warned.body.pages).toHaveLength(1);
    const made = await dry(race({ createCharacterNavigation: true }));
    expect(made.isError, made.text).toBe(false);
    const index = made.body.pages.find((p: { name: string }) => p.name === '[INDEX] Qilin');
    expect(index.parent).toBe('[INDEX] Beastkin');
    expect(index.notes.join(' ')).toMatch(/character navigation \(createCharacterNavigation\)/);
    // A racial group's navigation is directly under Characters; an existing race's is not made again.
    const group = await dry(
      race({
        kind: 'racialGroup',
        name: 'Merfolk',
        home: 'Races of Arkona',
        createCharacterNavigation: true,
      }),
    );
    expect(group.body.pages.find((p: { name: string }) => p.name === '[INDEX] Merfolk').parent).toBe(
      '[INDEX] Characters',
    );
    const subrace = await dry(
      race({
        kind: 'subrace',
        name: 'Low Humans',
        home: 'Humans - Core Information',
        referenceType: 'Subrace Reference',
        createCharacterNavigation: true,
      }),
    );
    expect(subrace.body.error.code).toBe('NAVIGATION_NOT_FOR_KIND');
  });

  it('a race with its navigation, approved: the character tool can then place a character in it', async () => {
    const made = await dry(race({ createCharacterNavigation: true }));
    const p = await call(race({ createCharacterNavigation: true }));
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const nav = pageNamed('[INDEX] Qilin')!;
    expect(w.repo.res.get(nav.parentId!)!.name).toBe('[INDEX] Beastkin');
    expect(w.repo.res.get(pageNamed('[BSRC] Qilin - Core Information')!.parentId!)!.name).toBe(
      '[BSRC] Beastkin - Racial Group Reference',
    );
    // The navigation index is in the Character taxonomy; its singular was a guess, which the owner checks first.
    const reg = w.stack.runtime.registry.forProject(PROJECT);
    const entry = reg.store.entryBySource(nav.id)!;
    expect(entry).toMatchObject({ plural: 'Qilin', status: 'needs_review' });
    expect(made.body.warnings.map((x: { code: string }) => x.code)).toContain('TAXONOMY_SINGULAR_GUESS');
    reg.commands.updateEntry('owner', entry.id, { singular: 'Qilin' });
    const ch = await w.call('arkona_create_character', {
      name: 'Shen Lu',
      depth: 'compact',
      status: 'authoritative',
      identity: {
        givenName: 'Lu',
        surname: 'Shen',
        race: 'Qilin',
        namingCulture: 'Menkheti',
        lifeState: 'Alive',
        temporalScope: '5A 931',
      },
      pages: [{ role: 'compact', scope: 'A Qilin scholar', markdown: ownerText('Shen Lu.') }],
      dryRun: true,
      project: 'test',
    });
    expect(ch.isError, ch.text).toBe(false);
    expect(ch.body.tree[0].parent).toBe('[INDEX] Qilin');
  });
});

describe('name, facts, text and links (design 1.4)', () => {
  it('requires Reference Type, Scope and Temporal Scope: ask the owner, never invent', async () => {
    const r = await dry(pkg('Polity', 'Salahad Polities', { scope: undefined, temporalScope: 'TBD' }));
    expect(r.body.error.code).toBe('OWNER_FACTS_INCOMPLETE');
    expect(r.body.error.fields).toEqual(['Scope', 'Temporal Scope']);
    expect(r.body.error.message).toMatch(/ask the owner/);
  });

  it('takes Unestablished only with a reason, which goes into Unresolved Material', async () => {
    const bare = await dry(pkg('Polity', 'Salahad Polities', { temporalScope: 'Unestablished' }));
    expect(bare.body.error.code).toBe('UNESTABLISHED_NEEDS_REASON');
    const p = await call(
      pkg('Polity', 'Salahad Polities', {
        name: 'Unestablished Polity',
        temporalScope: { value: 'Unestablished', reason: 'The owner has not dated its founding.' },
      }),
    );
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const page = pageNamed('[BSRC] Unestablished Polity - Polity Reference')!;
    const main = w.repo.liveDocs(page).find((d) => d.name === 'Main')!;
    const text = JSON.stringify(w.repo.blocks.get(main.id)!.blocks);
    expect(text).toContain('Temporal Scope: Unestablished. The owner has not dated its founding.');
  });

  it('names “<Subject> - <descriptor>” (the Reference Type by default), dashes replaced, CANON and dates refused', async () => {
    const byRt = await dry(
      pkg('Polity', 'Salahad Polities', { name: 'Kingdom of Ophir', descriptor: undefined }),
    );
    expect(byRt.body.pages[0].name).toBe('[BSRC] Kingdom of Ophir - Polity Reference');
    const split = await dry(
      pkg('Polity', 'Salahad Polities', {
        name: 'Kingdom of Ophir — Old Polity Reference',
        descriptor: undefined,
      }),
    );
    expect(split.body.pages[0].name).toBe('[BSRC] Kingdom of Ophir - Old Polity Reference');
    expect(split.body.replacements.length).toBeGreaterThan(0);
    const canon = await dry(pkg('Polity', 'Salahad Polities', { name: 'CANON Kingdom' }));
    expect(canon.body.error.code).toBe('NAME_HAS_FORBIDDEN_WORD');
    const dated = await dry(pkg('Polity', 'Salahad Polities', { name: 'Kingdom of 4A 100' }));
    expect(dated.body.error.code).toBe('NAME_HAS_DATE');
  });

  it('refuses a sibling of the same name', async () => {
    const r = await dry(
      pkg('Polity', 'Salahad Polities', {
        name: 'Sultanate of Tarim',
        descriptor: 'Historical Polity Reference',
      }),
    );
    expect(r.body.error.code).toBe('OWNER_EXISTS');
    expect(r.body.error.existing.id).toBe(O.tarim);
  });

  it('text: Purpose first, no empty or placeholder section', async () => {
    const r = await dry(pkg('Polity', 'Salahad Polities', { markdown: '## Overview\n\nA kingdom.\n' }));
    expect(r.body.error.code).toBe('PURPOSE_NOT_FIRST');
    const empty = await dry(
      pkg('Polity', 'Salahad Polities', { markdown: '## Purpose\n\nA kingdom.\n\n## Military\n\n' }),
    );
    expect(empty.body.error.code).toBe('EMPTY_SECTION');
    const none = await dry(pkg('Polity', 'Salahad Polities', { markdown: undefined }));
    expect(none.body.error.code).toBe('BODY_REQUIRED');
  });

  it('removes the template’s placeholder headings the package does not fill', async () => {
    const p = await call(
      pkg('Polity', 'Salahad Polities', {
        name: 'Placeholder Polity',
        markdown: ownerText('A kingdom.', '## Government\n\nA council.\n\n'),
      }),
    );
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const page = pageNamed('[BSRC] Placeholder Polity - Polity Reference')!;
    const main = w.repo.liveDocs(page).find((d) => d.name === 'Main')!;
    const headings = (w.repo.blocks.get(main.id)!.blocks as { kind: string; content?: { text: string }[] }[])
      .filter((b) => b.kind === 'heading')
      .map((b) => b.content![0]!.text);
    expect(headings).toEqual(['Purpose', 'Government', 'Source Boundaries', 'Unresolved Material']);
    const step = done.job!.steps.find((s) => s.opId === 'replaceDocumentBlocks')!;
    const filled = w.stack.runtime.engine
      .stepResults(done.job!.projectId, done.job!.id)!
      .find((s) => s.stepNo === step.stepNo)!;
    expect(JSON.stringify(filled.value)).toMatch(/droppedHeadings.*Overview.*Military.*Economy/);
  });

  it('Dependencies name current Authoritative owners only; a Working page or an index is refused', async () => {
    const ok = await dry(pkg('Institution', 'Menkhet', { dependencies: ['Menkhet - Polity Reference'] }));
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.body.pages[0].dependencies).toEqual(['[BSRC] Menkhet - Polity Reference']);
    const working = await dry(pkg('Institution', 'Menkhet', { dependencies: [C.draft] }));
    expect(working.body.error.code).toBe('DEPENDENCY_NOT_AUTHORITATIVE');
    expect(working.body.error.message).toMatch(/Working page/);
    const index = await dry(pkg('Institution', 'Menkhet', { dependencies: ['Salahad Polities'] }));
    expect(index.body.error.code).toBe('DEPENDENCY_NOT_AUTHORITATIVE');
    // Even a Working owner depends on Authoritative owners only.
    const wk = await dry(pkg('Institution', 'Menkhet', { status: 'working', dependencies: [C.draft] }));
    expect(wk.body.error.code).toBe('DEPENDENCY_NOT_AUTHORITATIVE');
    // Related Sources follow F3a's rule: a Working page may relate to a Working one.
    const rel = await dry(pkg('Institution', 'Menkhet', { status: 'working', related: [C.draft] }));
    expect(rel.isError, rel.text).toBe(false);
  });
});

describe('the lifecycle and the AU rule (design 1.4, 1.5)', () => {
  it('Working by default: [BWRK] under [INDEX] Working, Working and the primary tag, the specialist held', async () => {
    const r = await dry({ ...compactPolity(), specialistTag: 'Government' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.lifecycleStatus).toBe('working');
    expect(r.body.tree[0]).toMatchObject({
      page: '[BWRK] Kingdom of Saba - Historical Polity Reference',
      parent: '[INDEX] Working',
    });
    expect(r.body.pages[0].tags).toEqual(['Working', 'Polity']);
    expect(r.body.heldTags).toEqual([expect.objectContaining({ value: 'Government', slot: 'working' })]);
    expect(r.body.notes.join(' ')).toMatch(/promote_page \(destination: \[INDEX\] Salahad Polities\)/);
    expect(r.body.pages[0].facts).toContainEqual({ key: 'Status', value: 'Working' });
  });

  it('an AU owner carries AU in place of CANON; a Working AU owner leads with Working and carries neither', async () => {
    const au = await dry(pkg('Polity', 'Salahad Polities', { continuity: 'Shattered Sky' }));
    expect(au.body.pages[0].tags).toEqual(['AU', 'Polity']);
    expect(au.body.pages[0].facts).toEqual(
      expect.arrayContaining([
        { key: 'Continuity Type', value: 'AU' },
        { key: 'Continuity', value: 'Shattered Sky' },
      ]),
    );
    const wk = await dry(
      pkg('Polity', 'Salahad Polities', { continuity: 'Shattered Sky', status: 'working' }),
    );
    expect(wk.body.pages[0].tags).toEqual(['Working', 'Polity']);
    expect(wk.body.pages[0].facts).toContainEqual({ key: 'Continuity Type', value: 'AU' });
    const main = await dry(pkg('Polity', 'Salahad Polities', { continuity: 'Main' }));
    expect(main.body.pages[0].tags).toEqual(['CANON', 'Polity']);
  });

  it('an AU character’s Working page leads with Working (the character tool, the same rule)', async () => {
    const r = await w.call('arkona_create_character', {
      name: 'ignored',
      target: 'Kaito of the Shattered Sky',
      status: 'working',
      pages: [
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'His life',
          markdown: '## Purpose\n\nHis life.\n\n## Early Life\n\nA sky-sailor.\n',
        },
      ],
      dryRun: true,
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.pages[0].tags).toEqual(['Working', 'Character', 'Biography']);
    expect(r.body.pages[0].facts).toContainEqual({ key: 'Continuity Type', value: 'AU' });
  });

  it('records the AU ruling, with its date, in the pack data as an owner ruling', () => {
    const rules = w.stack.runtime.packs.get('arkona')!.rules;
    expect(rules.tags.au).toEqual({ continuityType: 'AU', tag: 'AU' });
    expect(rules.rulings).toEqual([
      expect.objectContaining({ key: 'au-status-tag', date: '2026-11-16', by: 'owner' }),
    ]);
  });
});
