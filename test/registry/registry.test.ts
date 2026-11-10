/**
 * v2 A3: the type registry and taxonomy (seeding, singular forms, owner edits), name resolution, character placement,
 * ordering, drift and project isolation, against a tree shaped like the test world (PLAN-v2 section 2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RegistryError,
  createRegistry,
  outOfOrderAmong,
  singularFor,
  slotAmong,
  type ProjectTypes,
  type TaxonomyEntry,
} from '../../src/registry/index.js';
import { ROOT, TEMPLATES, testWorld, world, type World } from './helpers.js';

let w: World;
let r: ProjectTypes;
const owner = 'owner' as const;

/** The error a call throws, as a RegistryError. */
function refused(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error('expected a RegistryError, but the call succeeded');
}

async function seeded(): Promise<{ typeId: string; entries: TaxonomyEntry[] }> {
  w.templates.alpha = TEMPLATES;
  const t = await r.commands.seedCharacterType(owner, {});
  r.commands.seedTaxonomy(owner, t.id);
  return { typeId: t.id, entries: r.store.entries(t.id) };
}

const entryOf = (typeId: string, plural: string) => r.store.entries(typeId).find((e) => e.plural === plural)!;
const review = (typeId: string, ...plurals: string[]) => {
  for (const p of plurals) r.commands.updateEntry(owner, entryOf(typeId, p).id, { reviewed: true });
};

beforeEach(() => {
  w = world(['alpha', 'beta']);
  w.add('alpha', testWorld());
  r = w.registry.forProject('alpha');
});
afterEach(() => w.close());

// ================================================================================================ singular forms

describe('singular forms', () => {
  it('come from the old bridge list first, without review', () => {
    for (const [p, s] of [
      ['Humans', 'Human'],
      ['High Humans', 'High Human'],
      ['Elves', 'Elf'],
      ['Moon Elves', 'Moon Elf'],
      ['Dwarves', 'Dwarf'],
      ['Faeries', 'Faerie'],
      ['True Dragons', 'True Dragon'],
      ['daemons', 'Daemon'],
    ]) {
      expect(singularFor(p!)).toEqual({ singular: s, source: 'list', rule: null });
    }
  });

  it('otherwise use simple rules, each a guess', () => {
    expect(singularFor('Foxians')).toMatchObject({ singular: 'Foxian', source: 'rule', rule: '-s removed' });
    expect(singularFor('Harpies')).toMatchObject({ singular: 'Harpy', source: 'rule', rule: '-ies → -y' });
    expect(singularFor('Beastkin')).toMatchObject({ singular: 'Beastkin', source: 'rule' });
    expect(singularFor('Saru')).toMatchObject({ singular: 'Saru', source: 'rule' });
    expect(singularFor('Qishen')).toMatchObject({ singular: 'Qishen', source: 'rule' });
    // -ves → -f only through the list
    expect(singularFor('Wolves')).toMatchObject({ singular: 'Wolve', source: 'rule' });
    expect(singularFor('Forest Dwarves')).toMatchObject({ singular: 'Forest Dwarf', source: 'rule' });
    expect(singularFor('Glass')).toMatchObject({ singular: 'Glass', source: 'rule' });
  });
});

// ================================================================================================ the type registry

describe('the Character type seed', () => {
  it('finds the root index directly under the root and the templates by name', async () => {
    w.templates.alpha = TEMPLATES;
    const t = await r.commands.seedCharacterType(owner, {});
    expect(t).toMatchObject({
      singular: 'Character',
      plural: 'Characters',
      rootIndexId: 'chars001',
      // "[INDEX] AI Index Template" is the template "[INDEX] AI Index" (copies drop the word Template)
      indexTemplateId: 'tplindex',
      pageTemplates: [
        { role: 'core', templateId: 'tplcore1' },
        { role: 'compact', templateId: 'tplcomp1' },
      ],
      assetRootFolder: 'Characters',
      placementKind: 'character',
      recipe: { version: 1 },
      status: 'ok',
      review: [],
      checks: [],
    });
    expect(t.placement?.unknownIndexName).toBe('Undetermined / Unknown');
    expect(w.audits.map((a) => a.action)).toEqual(['registry.type_seed']);
    expect(
      refused(() => r.commands.createType(owner, { singular: 'Character', plural: 'People' })).code,
    ).toBe('NAME_TAKEN');
    await expect(r.commands.seedCharacterType(owner, {})).rejects.toMatchObject({ code: 'TYPE_EXISTS' });
  });

  it('marks what it could not find as needing review', async () => {
    w.templates.alpha = [
      ...TEMPLATES.filter((x) => x.id !== 'tplcomp1'),
      { id: 'tplcore2', name: '[BSRC] AI Character Core Template', parentId: 'templates' },
    ];
    w.add('alpha', [{ id: 'chars002', name: '[INDEX] Characters', parent: ROOT }]);
    const t = await r.commands.seedCharacterType(owner, {});
    expect(t.status).toBe('needs_review');
    expect(t.rootIndexId).toBeNull();
    expect(t.pageTemplates).toEqual([
      { role: 'core', templateId: null },
      { role: 'compact', templateId: null },
    ]);
    expect(t.review.map((x) => x.code)).toEqual([
      'root_ambiguous',
      'template_not_found',
      'template_not_found',
    ]);
    expect(t.review[1]!.message).toContain('2 templates');
    // The owner fixes it and marks it reviewed.
    const fixed = r.commands.updateType(owner, t.id, {
      rootIndexId: 'chars001',
      pageTemplates: [
        { role: 'core', templateId: 'tplcore1' },
        { role: 'compact', templateId: 'tplindex' },
      ],
      reviewed: true,
    });
    expect(fixed).toMatchObject({ status: 'ok', review: [], rootIndexId: 'chars001' });
    expect(w.audits.at(-1)).toMatchObject({ action: 'registry.type_update', target: t.id });
  });

  it('refuses a root that is not an index, and flags templates and roots it cannot see', async () => {
    const t = r.commands.createType(owner, {
      singular: 'Item',
      plural: 'Equipment',
      rootIndexId: 'equip001',
      indexTemplateId: 'nosuchtp',
    });
    expect(t).toMatchObject({ placementKind: 'generic', assetRootFolder: 'Equipment', placement: null });
    expect(t.checks).toEqual([]); // templates never read: the id is not judged yet
    w.templates.alpha = TEMPLATES;
    await r.commands.refreshTemplates(owner);
    expect(r.commands.getType(owner, t.id).checks.map((c) => c.code)).toEqual(['template_unknown']);
    expect(refused(() => r.commands.updateType(owner, t.id, { rootIndexId: 'asagi002' })).code).toBe(
      'INVALID_INPUT',
    );
    expect(r.commands.updateType(owner, t.id, { rootIndexId: 'gonegone' }).checks[0]!.code).toBe(
      'root_not_in_tree',
    );
    expect(refused(() => r.commands.createType(owner, { singular: 'X' })).code).toBe('INVALID_INPUT');
    r.commands.deleteType(owner, t.id);
    expect(refused(() => r.commands.getType(owner, t.id)).code).toBe('NOT_FOUND');
  });

  it('stores placement settings as data, defaults filled in', () => {
    const t = r.commands.createType(owner, {
      singular: 'Creature',
      plural: 'Creatures',
      placementKind: 'character',
      placement: {
        unknownIndexName: 'Unknown Kinds',
        pageNames: { core: '{name} - Core', compact: '{name}' },
      },
    });
    expect(t.placement).toMatchObject({
      unknownIndexName: 'Unknown Kinds',
      unknownSpeciesValue: 'Unestablished',
      pageNames: { core: '{name} - Core', compact: '{name}' },
    });
    const u = r.commands.updateType(owner, t.id, { placement: { speciesRow: 'Kind' } });
    expect(u.placement).toMatchObject({ unknownIndexName: 'Unknown Kinds', speciesRow: 'Kind' });
  });
});

// ================================================================================================ taxonomy seeding

describe('seeding the taxonomy', () => {
  it('makes entries of the categories, not of character indexes or the unknown index', async () => {
    w.templates.alpha = TEMPLATES;
    const t = await r.commands.seedCharacterType(owner, {});
    const res = r.commands.seedTaxonomy(owner, t.id);
    const entries = r.store.entries(t.id);
    expect(entries.map((e) => e.plural).sort()).toEqual(
      [
        'Beastkin',
        'Daemons',
        'Dwarves',
        'Elves',
        'Faeries',
        'Foxians',
        'Goblins',
        'Greenskins',
        'High Humans',
        'Humans',
        'Moon Elves',
        'Outsiders',
        'Qishen',
        'Saru',
        'Tidekin',
        'True Dragons',
        'Wood Elves',
      ].sort(),
    );
    expect(res.characterIndexes.map((c) => c.displayName).sort()).toEqual(
      [
        'Aldric Vane',
        'Asagiri Miyabi',
        'Lyssa Dawn',
        'Mehrana al-Khalid',
        'Nobody Known',
        'Pell',
        'Thorin Ironhand',
      ].sort(),
    );
    expect(res.reserved.map((x) => x.id)).toEqual(['undet001']);
    const by = (p: string) => entries.find((e) => e.plural === p)!;
    // Parents follow the tree: Foxians under Beastkin, High Humans under Humans, Dwarves at the top.
    expect(by('Foxians').parentId).toBe(by('Beastkin').id);
    expect(by('High Humans').parentId).toBe(by('Humans').id);
    expect(by('Moon Elves').parentId).toBe(by('Wood Elves').id);
    expect(by('Dwarves').parentId).toBeNull();
    // Singulars, and what needs review (with the reasons).
    expect(by('Dwarves')).toMatchObject({ singular: 'Dwarf', singularSource: 'list', status: 'ok' });
    expect(by('High Humans')).toMatchObject({
      singular: 'High Human',
      status: 'ok',
      assetFolder: 'High Humans',
    });
    expect(by('Foxians')).toMatchObject({
      singular: 'Foxian',
      singularSource: 'rule',
      status: 'needs_review',
    });
    const reasons = (p: string) => by(p).review.map((x) => x.code);
    expect(reasons('Beastkin')).toEqual(['singular_guess']);
    expect(reasons('Saru')).toEqual(['singular_guess', 'empty']);
    expect(reasons('Tidekin')).toEqual(['singular_guess', 'empty']);
    expect(reasons('True Dragons')).toEqual(['empty']);
    expect(reasons('Moon Elves')).toEqual(['deep']);
    expect(
      entries
        .filter((e) => e.status === 'needs_review')
        .map((e) => e.plural)
        .sort(),
    ).toEqual(['Beastkin', 'Foxians', 'Moon Elves', 'Qishen', 'Saru', 'Tidekin', 'True Dragons'].sort());
    expect(res).toMatchObject({ needsReview: 7, unchanged: 0 });
    // The links the tree keeps for later sessions (ADR 0025).
    const links = w.db
      .prepare("SELECT COUNT(*) AS n FROM tree_node_links WHERE project_id = 'alpha' AND link = 'taxonomy'")
      .get() as { n: number };
    expect(links.n).toBe(17);
  });

  it('is done once; "add missing" creates entries for new indexes only and changes nothing else', async () => {
    const { typeId } = await seeded();
    expect(refused(() => r.commands.seedTaxonomy(owner, typeId)).code).toBe('ALREADY_SEEDED');
    r.commands.updateEntry(owner, entryOf(typeId, 'Foxians').id, { singular: 'Fox', notes: 'checked' });
    const before = r.store.entries(typeId);
    w.add('alpha', [
      { id: 'half0001', name: '[INDEX] Half-Elves', parent: 'elves001', referenceType: 'Index' },
      { id: 'half0002', name: '[BSRC] Half-Elf notes', parent: 'half0001' },
      { id: 'kit00001', name: '[INDEX] Kit Ren', parent: 'fox00001', referenceType: 'Index' },
      { id: 'kit00002', name: '[BSRC] Kit Ren', parent: 'kit00001', referenceType: 'Character Core' },
    ]);
    const res = r.commands.addMissing(owner, typeId);
    expect(res.created.map((e) => e.plural)).toEqual(['Half-Elves']);
    expect(res.created[0]).toMatchObject({ origin: 'add_missing', parentId: entryOf(typeId, 'Elves').id });
    expect(res.unchanged).toBe(17);
    for (const e of before) expect(r.store.entry(e.id)).toEqual(e);
    expect(entryOf(typeId, 'Foxians')).toMatchObject({
      singular: 'Fox',
      singularSource: 'owner',
      notes: 'checked',
    });
  });

  it('marks indexes whose pages have not been read, and two indexes with one name', async () => {
    w.add('alpha', [
      { id: 'mist0001', name: '[INDEX] Mistborn', parent: 'chars001', props: false },
      { id: 'mist0002', name: '[BSRC] Mistborn notes', parent: 'mist0001', props: false },
      { id: 'gobl0009', name: '[INDEX] Goblins', parent: 'chars001', referenceType: 'Index' },
      { id: 'gobl0008', name: '[BSRC] Goblin raids', parent: 'gobl0009' },
    ]);
    const { typeId } = await seeded();
    const mist = entryOf(typeId, 'Mistborn');
    expect(mist.review.map((x) => x.code)).toContain('unread');
    const gob = r.store.entries(typeId).filter((e) => e.plural === 'Goblins');
    expect(gob).toHaveLength(2);
    for (const g of gob) expect(g.review.map((x) => x.code)).toContain('duplicate_name');
  });

  it('refuses before the tree is built, or without a root index', () => {
    const b = w.registry.forProject('beta');
    const t = b.commands.createType(owner, {
      singular: 'Character',
      plural: 'Characters',
      placementKind: 'character',
    });
    expect(refused(() => b.commands.seedTaxonomy(owner, t.id)).code).toBe('TREE_NOT_READY');
    const a = r.commands.createType(owner, { singular: 'Place', plural: 'Places' });
    expect(refused(() => r.commands.seedTaxonomy(owner, a.id)).code).toBe('TYPE_ROOT_MISSING');
  });
});

// ================================================================================================ owner edits

describe('editing the taxonomy', () => {
  it('edits singular, aliases, asset folder, parent and notes; review is explicit', async () => {
    const { typeId } = await seeded();
    const fox = entryOf(typeId, 'Foxians');
    const e = r.commands.updateEntry(owner, fox.id, {
      singular: 'Foxian',
      aliases: ['Kitsune'],
      assetFolder: 'Foxfolk',
      notes: 'From the old list',
    });
    // The owner set the singular, so the guess is gone; nothing else was wrong, so it is reviewed.
    expect(e).toMatchObject({
      singularSource: 'owner',
      status: 'ok',
      review: [],
      aliases: ['Kitsune'],
      assetFolder: 'Foxfolk',
    });
    const saru = r.commands.updateEntry(owner, entryOf(typeId, 'Saru').id, { singular: 'Saru' });
    expect(saru.review.map((x) => x.code)).toEqual(['empty']);
    expect(r.commands.updateEntry(owner, saru.id, { reviewed: true }).status).toBe('ok');
    // Parent changes are checked (same type, no loops).
    const beast = entryOf(typeId, 'Beastkin');
    expect(refused(() => r.commands.updateEntry(owner, beast.id, { parentId: fox.id })).message).toContain(
      'itself',
    );
    expect(refused(() => r.commands.updateEntry(owner, beast.id, { parentId: 'tax_nope' })).code).toBe(
      'INVALID_INPUT',
    );
    // A name another entry answers to would make races ambiguous.
    expect(refused(() => r.commands.updateEntry(owner, beast.id, { aliases: ['kitsune'] })).code).toBe(
      'NAME_CLASH',
    );
    expect(refused(() => r.commands.deleteEntry(owner, beast.id)).code).toBe('HAS_CHILDREN');
    r.commands.deleteEntry(owner, entryOf(typeId, 'Tidekin').id);
    expect(r.store.entries(typeId).some((x) => x.plural === 'Tidekin')).toBe(false);
    expect(w.audits.map((a) => a.action)).toContain('registry.entry_delete');
    const view = r.commands.taxonomy(owner, typeId);
    expect(view.entries[0]!.parentId).toBeNull();
    expect(view.reviewQueue.every((x) => x.status === 'needs_review')).toBe(true);
    expect(view.entries.find((x) => x.plural === 'Humans')!.source?.path).toBe(
      'AI REPOSITORY / Characters / Humans',
    );
  });
});

// ================================================================================================ name resolution

describe('name resolution', () => {
  beforeEach(() => {
    w.add('alpha', [
      {
        id: 'faer0001',
        name: '[INDEX] Faeries',
        parent: 'chars001',
        referenceType: 'Index',
        aliases: ['Fae Folk'],
      },
      {
        id: 'asagi002',
        name: '[BSRC] Asagiri Miyabi',
        parent: 'asagi001',
        referenceType: 'Character Core',
        canonical: 'Lady Asagiri',
      },
    ]);
  });
  const ok = (q: string, o?: Parameters<ProjectTypes['resolve']>[1]) => {
    const x = r.resolve(q, o);
    if (x.status !== 'resolved') throw new Error(`${q}: ${x.status}`);
    return x;
  };

  it('accepts ids (and lk:// links) always', () => {
    expect(ok('asagi002')).toMatchObject({ matchedBy: 'id', node: { id: 'asagi002', kind: 'bsrc' } });
    expect(ok('lk://resources/asagi002').node.id).toBe('asagi002');
    expect(ok(ROOT).node.kind).toBe('root');
  });

  it('matches raw names, display names, aliases and the Canonical Display Name', () => {
    expect(ok('[INDEX] Humans')).toMatchObject({ matchedBy: 'raw', node: { id: 'human001' } });
    expect(ok('humans')).toMatchObject({ matchedBy: 'display', node: { id: 'human001' } });
    expect(ok('fae folk')).toMatchObject({ matchedBy: 'alias', node: { id: 'faer0001' } });
    expect(ok('Lady Asagiri')).toMatchObject({ matchedBy: 'canonical', node: { id: 'asagi002' } });
    expect(ok('Working notes').node).toMatchObject({ id: 'notes001', kind: 'unclassified' });
    expect(ok('Humans').node.path).toBe('AI REPOSITORY / Characters / Humans');
  });

  it('cleans stray prefixes, collapsing repeats, and uses them to tell matches apart', () => {
    expect(r.resolve('Asagiri Miyabi').status).toBe('ambiguous');
    expect(ok('[BSRC] Asagiri Miyabi').node.id).toBe('asagi002');
    expect(ok('[INDEX] [INDEX] Asagiri Miyabi').node.id).toBe('asagi001');
    expect(ok('  [index]   asagiri miyabi ').node.id).toBe('asagi001');
    expect(ok('[BSRC] Humans')).toMatchObject({ cleaned: 'Humans', node: { id: 'human001' } });
    expect(refused(() => r.resolve('[INDEX] ')).code).toBe('INVALID_INPUT');
  });

  it('refuses several matches with every candidate and its path', () => {
    const x = r.resolve('Asagiri Miyabi');
    expect(x.status).toBe('ambiguous');
    if (x.status !== 'ambiguous') return;
    expect(x.candidates.map((c) => [c.id, c.kind, c.rawName, c.path])).toEqual([
      [
        'asagi001',
        'index',
        '[INDEX] Asagiri Miyabi',
        'AI REPOSITORY / Characters / Beastkin / Foxians / Asagiri Miyabi',
      ],
      [
        'asagi002',
        'bsrc',
        '[BSRC] Asagiri Miyabi',
        'AI REPOSITORY / Characters / Beastkin / Foxians / Asagiri Miyabi / Asagiri Miyabi',
      ],
    ]);
    const e = refused(() => r.resolveOne('Asagiri Miyabi'));
    expect(e.code).toBe('AMBIGUOUS');
    expect((e.details.candidates as unknown[]).length).toBe(2);
  });

  it('scopes by kind, by node and by type', async () => {
    expect(ok('Asagiri Miyabi', { kinds: ['bsrc'] }).node.id).toBe('asagi002');
    expect(ok('Asagiri Miyabi', { scope: { under: 'asagi001' } }).node.id).toBe('asagi002'); // below, not itself
    expect(r.resolve('Humans', { scope: { under: 'beast001' } }).status).toBe('not_found');
    expect(refused(() => r.resolve('Humans', { scope: { under: 'nosuchid' } })).code).toBe('SCOPE_NOT_FOUND');
    expect(refused(() => r.resolve('Humans', { scope: { type: 'Character' } })).code).toBe('UNKNOWN_TYPE');
    await seeded();
    expect(ok('Humans', { scope: { type: 'characters' } }).node.id).toBe('human001');
    expect(r.resolve('Equipment', { scope: { type: 'Character' } }).status).toBe('not_found');
    expect(refused(() => r.resolve('equip001', { scope: { type: 'Character' } })).code).toBe('OUT_OF_SCOPE');
    expect(refused(() => r.resolve('asagi002', { kinds: ['index'] })).code).toBe('OUT_OF_SCOPE');
  });

  it('answers not found with near names as a hint only', () => {
    const x = r.resolve('Humanz');
    expect(x.status).toBe('not_found');
    if (x.status !== 'not_found') return;
    expect(x.near.map((n) => n.displayName)).toContain('Humans');
    expect(x.near.length).toBeLessThanOrEqual(10);
    expect(refused(() => r.resolveOne('Humanz')).code).toBe('NOT_FOUND');
  });

  it('refuses while the tree is not built', () => {
    expect(refused(() => w.registry.forProject('beta').resolve('Humans')).code).toBe('TREE_NOT_READY');
  });

  it('is the mention resolver B1 asks for', () => {
    const m = r.mentionResolver();
    expect(m('Humans')).toEqual({ status: 'resolved', resourceId: 'human001' });
    expect(m('Nobody At All')).toEqual({ status: 'not_found' });
    expect(m('Asagiri Miyabi')).toMatchObject({
      status: 'ambiguous',
      candidates: [
        { resourceId: 'asagi001', name: '[INDEX] Asagiri Miyabi' },
        { resourceId: 'asagi002', name: '[BSRC] Asagiri Miyabi' },
      ],
    });
  });
});

// ================================================================================================ character placement

describe('character placement', () => {
  let typeId: string;
  beforeEach(async () => {
    ({ typeId } = await seeded());
  });
  const plan = (characterName: string, race: string | null | undefined, kind: 'core' | 'compact') =>
    r.planCharacterPlacement({ characterName, race, kind });

  it('reuses an existing character index and returns an existing core', () => {
    review(typeId, 'Foxians');
    const p = plan('Asagiri Miyabi', 'Foxian', 'core');
    expect(p.raceIndex.id).toBe('fox00001');
    expect(p.race).toMatchObject({ given: 'Foxian', unknown: false, matchedBy: 'singular' });
    expect(p.characterIndex).toMatchObject({ action: 'reuse', node: { id: 'asagi001' } });
    expect(p.page).toMatchObject({ action: 'return_existing', node: { id: 'asagi002' } });
    expect(p.species).toEqual({ row: 'Race / Species', value: 'Foxian' });
    // The Subject row identifies a core whose name differs.
    const t = plan('Thorin Ironhand', 'Dwarf', 'core');
    expect(t.page).toMatchObject({ action: 'return_existing', node: { id: 'thor0002' } });
  });

  it('creates the character index and the core beneath it, in alphabetical place', () => {
    review(typeId, 'Foxians');
    const p = plan('Kitsune Ren', 'foxians', 'core');
    expect(p.characterIndex).toEqual({
      action: 'create',
      parentId: 'fox00001',
      rawName: '[INDEX] Kitsune Ren',
      displayName: 'Kitsune Ren',
      templateId: 'tplindex',
      slot: { after: 'asagi001' },
    });
    expect(p.page).toEqual({
      action: 'create',
      parentId: null,
      rawName: '[BSRC] Kitsune Ren',
      displayName: 'Kitsune Ren',
      templateRole: 'core',
      templateId: 'tplcore1',
      referenceType: 'Character Core',
      slot: {},
    });
    expect(p.species.value).toBe('foxians'); // never rewritten
  });

  it('puts a core under an existing index that has none yet', () => {
    w.add('alpha', [
      { id: 'wren0001', name: '[INDEX] Wren Hale', parent: 'dwarf001', referenceType: 'Index' },
      { id: 'wren0002', name: '[BSRC] Wren Hale - Art', parent: 'wren0001', referenceType: 'Character Art' },
    ]);
    const p = plan('Wren Hale', 'Dwarves', 'core');
    expect(p.characterIndex).toMatchObject({ action: 'reuse', node: { id: 'wren0001' } });
    expect(p.page).toMatchObject({ action: 'create', parentId: 'wren0001', slot: { before: 'wren0002' } });
  });

  it('places a compact reference directly under the race, or returns the existing one', () => {
    const p = plan('Oren Pike', 'Human', 'compact');
    expect(p.characterIndex).toBeNull();
    expect(p.page).toMatchObject({
      action: 'create',
      parentId: 'human001',
      rawName: '[BSRC] Oren Pike',
      templateId: 'tplcomp1',
      referenceType: 'Compact Character Reference',
      slot: { after: 'cora0001' },
    });
    expect(plan('Gimble Stonefoot', 'Dwarves', 'compact').page).toMatchObject({
      action: 'return_existing',
      node: { id: 'gimb0001' },
    });
    // "Bram Cooper - Compact Character Reference": the subject is the name before " - ".
    expect(plan('Bram Cooper', 'Humans', 'compact').page).toMatchObject({
      action: 'return_existing',
      node: { id: 'bram0001' },
    });
    const a = plan('Aldric Vane', 'Humans', 'compact');
    expect(a.warnings.join(' ')).toContain('already has a Character Core');
  });

  it('a race directly under the root (Dwarves) and a subrace (High Humans) both resolve', () => {
    expect(plan('Durin', 'Dwarf', 'compact').raceIndex.id).toBe('dwarf001');
    expect(plan('Sera', 'High Human', 'compact').raceIndex.id).toBe('hhum0001');
  });

  it('sends unknown or omitted races to the one unknown index, with Race / Species Unestablished', () => {
    for (const race of [
      null,
      undefined,
      '',
      '  ',
      'Unknown',
      'undetermined',
      'UNESTABLISHED',
      'Undetermined / Unknown',
    ]) {
      const p = plan('Nameless', race, 'compact');
      expect(p.raceIndex.id, String(race)).toBe('undet001');
      expect(p.race.unknown).toBe(true);
      expect(p.species).toEqual({ row: 'Race / Species', value: 'Unestablished' });
    }
    expect(plan('Nobody Known', 'Unknown', 'core').page).toMatchObject({
      action: 'return_existing',
      node: { id: 'nobo0002' },
    });
    w.add('alpha', [{ id: 'undet002', name: '[INDEX] Undetermined / Unknown', parent: 'chars001' }]);
    expect(refused(() => plan('Nameless', null, 'core')).code).toBe('UNKNOWN_INDEX_AMBIGUOUS');
    w.remove('alpha', 'undet002');
    w.remove('alpha', 'undet001');
    expect(refused(() => plan('Nameless', null, 'core')).code).toBe('UNKNOWN_INDEX_MISSING');
  });

  it('refuses a declared race that does not resolve, listing the labels', () => {
    const e = refused(() => plan('Kai', 'Atlanteans', 'core'));
    expect(e.code).toBe('RACE_NOT_FOUND');
    expect(e.details.available).toEqual(expect.arrayContaining(['Humans', 'Human', 'Dwarf', 'High Humans']));
    // Moon Elves is a great-grandchild of the root: outside the race search.
    expect(refused(() => plan('Kai', 'Moon Elves', 'core')).code).toBe('RACE_NOT_FOUND');
  });

  it('refuses an ambiguous race, and a race waiting for review', () => {
    w.add('alpha', [
      { id: 'gobl0009', name: '[INDEX] Goblins', parent: 'chars001', referenceType: 'Index' },
      { id: 'gobl0008', name: '[BSRC] Goblin raids', parent: 'gobl0009' },
    ]);
    r.commands.addMissing(owner, typeId);
    const e = refused(() => plan('Snik', 'Goblin', 'compact'));
    expect(e.code).toBe('RACE_AMBIGUOUS');
    expect((e.details.candidates as { id: string }[]).map((c) => c.id).sort()).toEqual([
      'gobl0001',
      'gobl0009',
    ]);
    const q = refused(() => plan('Snik', 'Qishen', 'compact'));
    expect(q.code).toBe('RACE_NEEDS_REVIEW');
  });

  it('refuses when the race index is gone or a template is missing', () => {
    w.remove('alpha', 'dwarf001');
    expect(refused(() => plan('Durin', 'Dwarf', 'compact')).code).toBe('RACE_SOURCE_MISSING');
    r.commands.updateType(owner, typeId, { pageTemplates: [{ role: 'core', templateId: 'tplcore1' }] });
    expect(refused(() => plan('Oren Pike', 'Human', 'compact')).code).toBe('TEMPLATE_NOT_CONFIGURED');
  });

  it('refuses two indexes with the character name under the race', () => {
    w.add('alpha', [{ id: 'aldr0009', name: '[INDEX] aldric vane', parent: 'human001' }]);
    expect(refused(() => plan('Aldric Vane', 'Humans', 'core')).code).toBe('CHARACTER_INDEX_AMBIGUOUS');
  });
});

// ================================================================================================ ordering

describe('ordering', () => {
  const s = (id: string, displayName: string, kind: 'index' | 'bsrc' | 'unclassified') => ({
    id,
    displayName,
    kind,
  });
  const kids = [
    s('i1', 'Alpha', 'index'),
    s('i2', 'Mid', 'index'),
    s('b1', 'Apple', 'bsrc'),
    s('b2', 'Zebra', 'bsrc'),
    s('u1', 'Loose', 'unclassified'),
  ];

  it('puts [INDEX] first, then [BSRC], then unclassified', () => {
    expect(slotAmong(kids, 'Zz last index', 'index')).toEqual({ after: 'i2' });
    expect(slotAmong(kids, 'Aardvark', 'bsrc')).toEqual({ after: 'i2' });
    expect(slotAmong(kids, 'Banana', 'bsrc')).toEqual({ after: 'b1' });
    expect(slotAmong(kids, 'A', 'unclassified')).toEqual({ after: 'b2' });
  });

  it('first and last positions, and an empty parent', () => {
    expect(slotAmong(kids, 'Aaa', 'index')).toEqual({ before: 'i1' });
    expect(slotAmong(kids, 'Zzz', 'unclassified')).toEqual({ after: 'u1' });
    expect(slotAmong([], 'Anything', 'bsrc')).toEqual({});
  });

  it('ignores case and accents, and compares numbers by value', () => {
    const l = [s('a', 'éclair', 'bsrc'), s('b', 'Age 2', 'bsrc'), s('c', 'Age 10', 'bsrc')];
    expect(slotAmong([s('a', 'apple', 'bsrc'), s('b', 'Cherry', 'bsrc')], 'Banana', 'bsrc')).toEqual({
      after: 'a',
    });
    expect(slotAmong([s('a', 'Eclair', 'bsrc')], 'éclair', 'bsrc')).toEqual({ after: 'a' }); // a tie goes after
    expect(slotAmong([s('b', 'Age 2', 'bsrc'), s('c', 'Age 10', 'bsrc')], 'Age 9', 'bsrc')).toEqual({
      after: 'b',
    });
    expect(outOfOrderAmong(l).map((x) => x.node.id)).toEqual(['a']); // éclair belongs after the ages
  });

  it('places next to the right neighbour even among out-of-order siblings', () => {
    const messy = [s('z', 'Zulfiqar', 'bsrc'), s('i', 'Sacred Blades', 'index'), s('a', 'Aegis', 'bsrc')];
    expect(slotAmong(messy, 'Bow', 'bsrc')).toEqual({ after: 'a' });
    expect(slotAmong(messy, 'Axe', 'index')).toEqual({ before: 'i' });
  });

  it('outOfOrder lists the fewest siblings that break the rule, with where each belongs', () => {
    const messy = [s('z', 'Zulfiqar', 'bsrc'), s('i', 'Sacred Blades', 'index'), s('a', 'Aegis', 'bsrc')];
    const bad = outOfOrderAmong(messy);
    expect(bad.map((x) => [x.node.id, x.belongsAfter?.id ?? null])).toEqual([['z', 'a']]);
    expect(outOfOrderAmong(kids)).toEqual([]);
  });

  it('works on the tree: parent checks, the moved page left out, and outOfOrder per parent', () => {
    w.add('alpha', [
      { id: 'eq000001', name: '[BSRC] Zulfiqar', parent: 'equip001', rank: 'a1' },
      { id: 'eq000002', name: '[INDEX] Sacred Blades', parent: 'equip001', rank: 'a2' },
      { id: 'eq000003', name: '[BSRC] Aegis', parent: 'equip001', rank: 'a3' },
    ]);
    expect(r.placementFor('equip001', 'Bow', 'bsrc')).toEqual({ after: 'eq000003' });
    expect(r.placementFor('equip001', 'Zulfiqar', 'bsrc', { excludeId: 'eq000001' })).toEqual({
      after: 'eq000003',
    });
    expect(r.placementFor('chars001', 'Aardvarks', 'index')).toEqual({ before: 'beast001' });
    expect(refused(() => r.placementFor('nosuchid', 'X', 'bsrc')).code).toBe('NOT_IN_TREE');
    const o = r.outOfOrder('equip001');
    expect(o).toHaveLength(1);
    expect(o[0]!.outOfOrder.map((x) => x.node.id)).toEqual(['eq000001']);
    expect(r.outOfOrder().map((x) => x.parent.id)).toContain('equip001');
  });
});

// ================================================================================================ drift

describe('drift', () => {
  it('reports unmapped indexes, renamed, moved and deleted sources, and wrong parents; fixes nothing', async () => {
    const { typeId } = await seeded();
    expect(w.registry.driftReport('alpha', 'owner', null).findings).toEqual([]);
    const before = r.store.entries(typeId);
    w.add('alpha', [
      { id: 'half0001', name: '[INDEX] Half-Elves', parent: 'elves001', referenceType: 'Index' },
      { id: 'half0002', name: '[BSRC] Half-Elf notes', parent: 'half0001' },
      { id: 'dwarf001', name: '[INDEX] Dwarfs', parent: 'chars001', referenceType: 'Index' },
      { id: 'wood0001', name: '[INDEX] Wood Elves', parent: 'chars001', referenceType: 'Index' },
    ]);
    w.remove('alpha', 'saru0001');
    const rep = r.commands.runDrift(owner);
    const codes = rep.findings.map((f) => `${f.code}:${f.entryName ?? f.nodePath}`).sort();
    expect(codes).toEqual(
      [
        'unmapped_index:AI REPOSITORY / Characters / Elves / Half-Elves',
        'source_renamed:Dwarves',
        'source_moved:Wood Elves',
        'parent_mismatch:Wood Elves',
        'source_deleted:Saru',
      ].sort(),
    );
    expect(rep.findings.find((f) => f.code === 'parent_mismatch')!.message).toContain('“Elves”');
    // Moon Elves moved with Wood Elves: its own parent (Wood Elves) still matches.
    expect(rep.findings.some((f) => f.entryName === 'Moon Elves')).toBe(false);
    expect(r.store.entries(typeId)).toEqual(before); // reported, never fixed
    expect(r.commands.drift(owner).latest?.id).toBe(rep.id);
  });

  it('reports a type root that left the tree, and says when the tree cannot be compared', async () => {
    const { typeId } = await seeded();
    w.remove('alpha', 'chars001');
    const rep = w.registry.driftReport('alpha', 'check', 'pass_1');
    expect(rep.findings).toEqual([
      expect.objectContaining({ code: 'type_root_missing', typeId, nodeId: 'chars001' }),
    ]);
    expect(rep).toMatchObject({ source: 'check', passId: 'pass_1' });
    const b = w.registry.driftReport('beta', 'check', null);
    expect(b).toMatchObject({ findings: [], treeStatus: 'not_built' });
    expect(b.note).toContain('not built');
  });

  it('follows the daily check (and only the check)', () => {
    let listener: ((p: never) => void) | null = null;
    const registry = createRegistry({
      db: w.db,
      tree: {
        queries: w.tree.queries,
        settings: (p: string) => w.tree.settings(p),
        onPassFinished: (fn: (p: never) => void) => {
          listener = fn;
          return () => (listener = null);
        },
      },
      audit: { audit: () => undefined },
      now: () => w.clock.now(),
    });
    const off = registry.attach();
    const pass = (kind: string) =>
      ({ kind, status: 'succeeded', projectId: 'alpha', id: `p_${kind}` }) as never;
    listener!(pass('sweep'));
    expect(registry.forProject('alpha').store.latestReport()).toBeUndefined();
    listener!(pass('check'));
    expect(registry.forProject('alpha').store.latestReport()).toMatchObject({
      source: 'check',
      passId: 'p_check',
    });
    off();
    expect(listener).toBeNull();
  });
});

// ================================================================================================ isolation

describe('two projects', () => {
  it('are fully isolated', async () => {
    w.add('beta', testWorld());
    const b = w.registry.forProject('beta');
    const { typeId } = await seeded();
    expect(b.commands.listTypes(owner)).toEqual([]);
    expect(refused(() => b.commands.getType(owner, typeId)).code).toBe('NOT_FOUND');
    expect(
      refused(() => b.commands.updateEntry(owner, r.store.entries(typeId)[0]!.id, { notes: 'x' })).code,
    ).toBe('NOT_FOUND');
    expect(
      refused(() => b.planCharacterPlacement({ characterName: 'X', race: null, kind: 'core' })).code,
    ).toBe('NO_CHARACTER_TYPE');
    // The same names and ids in both trees; each answers from its own.
    w.add('beta', [{ id: 'human001', name: '[INDEX] Mortals', parent: 'chars001' }]);
    expect(b.resolve('Humans').status).toBe('not_found');
    expect(r.resolveOne('Humans').id).toBe('human001');
    // Beta seeds its own Character type, with the same names, and its own taxonomy.
    w.templates.beta = TEMPLATES;
    const bt = await b.commands.seedCharacterType(owner, {});
    b.commands.seedTaxonomy(owner, bt.id);
    expect(b.store.entries(bt.id).some((e) => e.plural === 'Mortals')).toBe(true);
    expect(r.store.entries(typeId).some((e) => e.plural === 'Mortals')).toBe(false);
    r.commands.runDrift(owner);
    expect(b.store.latestReport()).toBeUndefined();
  });
});
