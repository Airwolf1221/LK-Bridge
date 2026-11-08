/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies and loosely typed test data */
import { afterEach, describe, expect, it } from 'vitest';
import type { MappingError } from '../../src/mappings/index.js';
import { parseImport, EXPORT_SCHEMA } from '../../src/mappings/index.js';
import { settle } from '../jobs/helpers.js';
import {
  FIELD_BLOCK_ID,
  FIELD_HEADING,
  FIELD_INFOBOX,
  FIELD_SIDEBAR,
  SET,
  SUBTREE_RULE,
  TAG_RULE,
  mappingRig,
  type MappingRig,
} from './helpers.js';

let r: MappingRig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as MappingError).code;
  }
  return 'no error';
};
const audits = () => r!.rig.policy.commands.listAudit('owner', { limit: 500 }).map((a) => a.action);

describe('sets', () => {
  it('create, read, update and delete, with timestamps, notes and an audit row for each change', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    expect(set).toMatchObject({
      name: 'Baisheng taxonomy',
      description: 'The main repository',
      notes: 'First draft',
      active: false,
    });
    expect(set.createdAt).toBe(set.updatedAt);
    await r.rig.h.clock.advance(5_000);
    const updated = c.updateSet('owner', set.id, { ...SET, name: 'Baisheng v2', notes: 'Second draft' });
    expect(updated).toMatchObject({ name: 'Baisheng v2', notes: 'Second draft', createdAt: set.createdAt });
    expect(updated.updatedAt).toBeGreaterThan(set.updatedAt);
    expect(c.listSets('owner')).toMatchObject([{ id: set.id, ruleCount: 0, fieldCount: 0 }]);
    c.deleteSet('owner', set.id);
    expect(c.listSets('owner')).toEqual([]);
    expect(audits()).toEqual(
      expect.arrayContaining(['mapping.set_create', 'mapping.set_update', 'mapping.set_delete']),
    );
  });

  it('refuses duplicate names (any case), empty names and over-long text', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    c.createSet('owner', SET);
    expect(code(() => c.createSet('owner', { ...SET, name: 'BAISHENG TAXONOMY' }))).toBe('NAME_TAKEN');
    expect(code(() => c.createSet('owner', { ...SET, name: '   ' }))).toBe('INVALID_INPUT');
    expect(code(() => c.createSet('owner', { ...SET, notes: 'x'.repeat(5001) }))).toBe('INVALID_INPUT');
    expect(code(() => c.createSet('owner', { ...SET, name: 'bad\u0000name' }))).toBe('INVALID_INPUT');
    expect(c.listSets('owner')).toHaveLength(1);
  });

  it('at most one set is active: activating one deactivates the other', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const a = c.createSet('owner', { ...SET, name: 'A' });
    const b = c.createSet('owner', { ...SET, name: 'B' });
    c.activateSet('owner', a.id);
    expect(
      c
        .listSets('owner')
        .filter((s) => s.active)
        .map((s) => s.name),
    ).toEqual(['A']);
    c.activateSet('owner', b.id);
    expect(
      c
        .listSets('owner')
        .filter((s) => s.active)
        .map((s) => s.name),
    ).toEqual(['B']);
    c.deactivateSet('owner', b.id);
    expect(c.listSets('owner').filter((s) => s.active)).toEqual([]);
    // The database itself enforces it, not only the command.
    r.rig.db.prepare('UPDATE mapping_sets SET active = 1 WHERE id = ?').run(a.id);
    expect(() => r!.rig.db.prepare('UPDATE mapping_sets SET active = 1 WHERE id = ?').run(b.id)).toThrow();
  });

  it('unknown ids are not found', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    expect(code(() => c.getSet('owner', 'nope'))).toBe('NOT_FOUND');
    expect(code(() => c.updateSet('owner', 'nope', SET))).toBe('NOT_FOUND');
    expect(code(() => c.createRule('owner', 'nope', SUBTREE_RULE))).toBe('NOT_FOUND');
    expect(code(() => c.updateRule('owner', 'nope', SUBTREE_RULE))).toBe('NOT_FOUND');
    expect(code(() => c.deleteField('owner', 'nope'))).toBe('NOT_FOUND');
  });

  it('is owner-only', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    expect(code(() => c.createSet('agent' as never, SET))).toBe('NOT_OWNER');
    expect(code(() => c.listSets('agent' as never))).toBe('NOT_OWNER');
  });
});

describe('type rules', () => {
  it('map a subtree (with or without descendants), a template or a tag to a semantic type with a priority', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    const sub = c.createRule('owner', set.id, SUBTREE_RULE);
    const only = c.createRule('owner', set.id, {
      selector: { kind: 'subtree', resourceId: 'rkingdom', descendants: false },
      semanticType: 'Nation',
      priority: 5,
    });
    const tpl = c.createRule('owner', set.id, {
      selector: { kind: 'template', templateId: 'tspecies' },
      semanticType: 'Species',
    });
    const tag = c.createRule('owner', set.id, TAG_RULE);
    expect(sub).toMatchObject({
      selector: { kind: 'subtree', resourceId: 'rcharact', descendants: true },
      semanticType: 'Character',
      priority: 10,
      notes: 'Everything under Characters',
    });
    expect(only.selector).toEqual({ kind: 'subtree', resourceId: 'rkingdom', descendants: false });
    expect(tpl).toMatchObject({
      selector: { kind: 'template', templateId: 'tspecies' },
      priority: 0,
      notes: '',
    });
    expect(tag.selector).toEqual({ kind: 'tag', tag: 'nation' });
    // Listed by priority, highest first.
    expect(c.getSet('owner', set.id).rules.map((x) => x.semanticType)).toEqual([
      'Nation',
      'Character',
      'Nation',
      'Species',
    ]);
  });

  it('update and delete, with before and after in the audit log', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    const rule = c.createRule('owner', set.id, SUBTREE_RULE);
    await r.rig.h.clock.advance(1000);
    const upd = c.updateRule('owner', rule.id, { ...SUBTREE_RULE, semanticType: 'Person', priority: 99 });
    expect(upd).toMatchObject({ semanticType: 'Person', priority: 99, createdAt: rule.createdAt });
    expect(upd.updatedAt).toBeGreaterThan(rule.updatedAt);
    const row = r.rig.policy.commands.listAudit('owner', { action: 'mapping.rule_update' })[0]!;
    expect(row.before).toMatchObject({ semanticType: 'Character' });
    expect(row.after).toMatchObject({ semanticType: 'Person' });
    c.deleteRule('owner', rule.id);
    expect(c.getSet('owner', set.id).rules).toEqual([]);
  });

  it('validate the selector and priority', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    for (const bad of [
      { ...SUBTREE_RULE, selector: { kind: 'subtree' } },
      { ...SUBTREE_RULE, selector: { kind: 'path', path: '/x' } },
      { ...SUBTREE_RULE, selector: { kind: 'tag', tag: '' } },
      { ...SUBTREE_RULE, semanticType: '' },
      { ...SUBTREE_RULE, priority: 1.5 },
      { ...SUBTREE_RULE, priority: 5000 },
    ]) {
      expect(
        code(() => c.createRule('owner', set.id, bad)),
        JSON.stringify(bad),
      ).toBe('INVALID_INPUT');
    }
    expect(c.getSet('owner', set.id).rules).toEqual([]);
  });
});

describe('field maps', () => {
  it('locate a field at a sidebar property, an infobox row, a heading or a block id, with an expected kind', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    const made = [FIELD_SIDEBAR, FIELD_INFOBOX, FIELD_HEADING, FIELD_BLOCK_ID].map((f) =>
      c.createField('owner', set.id, f),
    );
    expect(made.map((f) => f.location)).toEqual([
      FIELD_SIDEBAR.location,
      FIELD_INFOBOX.location,
      FIELD_HEADING.location,
      FIELD_BLOCK_ID.location,
    ]);
    expect(made.map((f) => f.expectedKind)).toEqual(['resource_link', 'date', 'text', 'text']);
    expect(c.getSet('owner', set.id).fields).toHaveLength(4);
  });

  it('update and delete; a type cannot have the same field twice', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    const f = c.createField('owner', set.id, FIELD_SIDEBAR);
    expect(code(() => c.createField('owner', set.id, { ...FIELD_SIDEBAR, fieldName: 'species' }))).toBe(
      'DUPLICATE_FIELD',
    );
    const other = c.createField('owner', set.id, FIELD_INFOBOX);
    expect(code(() => c.updateField('owner', other.id, { ...FIELD_INFOBOX, fieldName: 'Species' }))).toBe(
      'DUPLICATE_FIELD',
    );
    const upd = c.updateField('owner', f.id, {
      ...FIELD_SIDEBAR,
      expectedKind: 'text',
      location: { kind: 'sidebar_property', title: 'Race' },
    });
    expect(upd).toMatchObject({ expectedKind: 'text', location: { title: 'Race' } });
    c.deleteField('owner', f.id);
    expect(c.getSet('owner', set.id).fields.map((x) => x.id)).toEqual([other.id]);
  });

  it('refuse a location that is incomplete or ambiguous, and an unknown expected kind', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    for (const bad of [
      { ...FIELD_SIDEBAR, location: { kind: 'sidebar_property' } },
      { ...FIELD_INFOBOX, location: { kind: 'infobox_row', infoboxTitle: 'Vitals' } },
      { ...FIELD_HEADING, location: { kind: 'block' } },
      { ...FIELD_HEADING, location: { kind: 'block', heading: 'H', blockId: 'b' } },
      { ...FIELD_SIDEBAR, expectedKind: 'colour' },
      { ...FIELD_SIDEBAR, location: { kind: 'somewhere' } },
    ]) {
      expect(
        code(() => c.createField('owner', set.id, bad)),
        JSON.stringify(bad),
      ).toBe('INVALID_INPUT');
    }
  });

  it('are deleted with their set', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    c.createRule('owner', set.id, SUBTREE_RULE);
    c.createField('owner', set.id, FIELD_SIDEBAR);
    c.deleteSet('owner', set.id);
    expect(r.rig.db.prepare('SELECT COUNT(*) AS n FROM mapping_type_rules').get()).toEqual({ n: 0 });
    expect(r.rig.db.prepare('SELECT COUNT(*) AS n FROM mapping_field_maps').get()).toEqual({ n: 0 });
  });
});

describe('the readable summary', () => {
  it('describes each type’s rules and fields in plain British English, and warns about gaps and clashes', async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    c.createRule('owner', set.id, SUBTREE_RULE);
    c.createRule('owner', set.id, TAG_RULE);
    c.createRule('owner', set.id, { ...TAG_RULE, semanticType: 'Institution' }); // same selector and priority, another type
    c.createField('owner', set.id, FIELD_SIDEBAR);
    c.createField('owner', set.id, FIELD_INFOBOX);
    c.createField('owner', set.id, FIELD_HEADING);
    c.createField('owner', set.id, { ...FIELD_BLOCK_ID, semanticType: 'Colony' });
    const { summary } = c.getSet('owner', set.id);
    expect(summary.headline).toBe(
      'Inactive set “Baisheng taxonomy”: 3 type rules, 4 field maps, 4 semantic types.',
    );
    const character = summary.types.find((t) => t.semanticType === 'Character')!;
    expect(character.rules).toEqual(['Resource rcharact and everything below it (priority 10)']);
    expect(character.fields).toEqual(
      expect.arrayContaining([
        'Species: Sidebar property “Species”, expected a resource link',
        'Born: Infobox “Vitals”, row “Born”, expected a date',
        'Biography: Block under the heading “Biography”, expected text',
      ]),
    );
    expect(summary.types.find((t) => t.semanticType === 'Nation')!.rules).toEqual([
      'Resources tagged “nation” (priority 20)',
    ]);
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        'Colony has field maps but no type rule selects it.',
        'Nation has type rules but no field maps yet.',
        'Resources tagged “nation” is claimed by both Nation and Institution at priority 20.',
      ]),
    );
  });
});

describe('export and import', () => {
  const build = async () => {
    r = await mappingRig();
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    c.createRule('owner', set.id, SUBTREE_RULE);
    c.createRule('owner', set.id, {
      selector: { kind: 'template', templateId: 'tspecies' },
      semanticType: 'Species',
    });
    c.createRule('owner', set.id, TAG_RULE);
    for (const f of [FIELD_SIDEBAR, FIELD_INFOBOX, FIELD_HEADING, FIELD_BLOCK_ID])
      c.createField('owner', set.id, f);
    c.activateSet('owner', set.id);
    return { c, set };
  };

  it('round-trips a whole set: export, import under another name, the same rules and fields, never active', async () => {
    const { c, set } = await build();
    const doc = c.exportSet('owner', set.id);
    expect(doc).toMatchObject({ schema: EXPORT_SCHEMA, version: 1 });
    expect(JSON.stringify(doc)).not.toContain(set.id); // no internal ids in the file
    const text = JSON.stringify(doc);
    const imported = c.importSet('owner', text, 'Copy of Baisheng');
    expect(imported.set).toMatchObject({
      name: 'Copy of Baisheng',
      active: false,
      description: SET.description,
      notes: SET.notes,
    });
    const strip = <T extends { id: string; setId: string; createdAt: number; updatedAt: number }>(x: T[]) =>
      x.map(({ id: _i, setId: _s, createdAt: _c, updatedAt: _u, ...rest }) => rest);
    const original = c.getSet('owner', set.id);
    expect(strip(imported.rules)).toEqual(strip(original.rules));
    expect(strip(imported.fields)).toEqual(strip(original.fields));
    // The original is untouched and still the one active set.
    expect(
      c
        .listSets('owner')
        .filter((s) => s.active)
        .map((s) => s.id),
    ).toEqual([set.id]);
    // Exporting the copy gives the same document (apart from the name and time).
    const again = c.exportSet('owner', imported.set.id);
    expect({ ...again, exportedAt: 0, set: { ...again.set, name: '' } }).toEqual({
      ...doc,
      exportedAt: 0,
      set: { ...doc.set, name: '' },
    });
    expect(audits()).toContain('mapping.set_import');
  });

  it('refuses to import over an existing name, and says so', async () => {
    const { c, set } = await build();
    const doc = c.exportSet('owner', set.id);
    expect(code(() => c.importSet('owner', doc))).toBe('NAME_TAKEN');
    expect(c.listSets('owner')).toHaveLength(1);
  });

  it('refuses an invalid import and writes nothing', async () => {
    const { c, set } = await build();
    const good = c.exportSet('owner', set.id);
    const before = c.listSets('owner').length;
    const cases: [string, unknown][] = [
      ['not JSON', '{nope'],
      ['not an object', '[]'],
      ['wrong schema', { ...good, schema: 'something-else' }],
      ['future version', { ...good, version: 2 }],
      ['missing set', { ...good, set: undefined }],
      ['unknown top-level key', { ...good, extra: 1 }],
      [
        'rule with bad selector',
        {
          ...good,
          set: { ...good.set, name: 'X' },
          typeRules: [{ selector: { kind: 'subtree' }, semanticType: 'T' }],
        },
      ],
      [
        'field with both heading and block id',
        {
          ...good,
          set: { ...good.set, name: 'X' },
          fieldMaps: [{ ...FIELD_HEADING, location: { kind: 'block', heading: 'a', blockId: 'b' } }],
        },
      ],
      [
        'duplicate field',
        {
          ...good,
          set: { ...good.set, name: 'X' },
          fieldMaps: [FIELD_SIDEBAR, { ...FIELD_SIDEBAR, fieldName: 'SPECIES' }],
        },
      ],
      ['empty name', { ...good, set: { ...good.set, name: '' } }],
    ];
    for (const [label, doc] of cases) {
      expect(
        code(() => c.importSet('owner', typeof doc === 'string' ? doc : JSON.stringify(doc))),
        label,
      ).toBe('INVALID_IMPORT');
    }
    expect(() => parseImport('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(/larger than 2 MB/);
    expect(c.listSets('owner')).toHaveLength(before);
    expect(r!.rig.db.prepare('SELECT COUNT(*) AS n FROM mapping_type_rules').get()).toEqual({ n: 3 });
  });

  it('a failure part-way through an import leaves nothing behind (one transaction)', async () => {
    const { c, set } = await build();
    const doc = c.exportSet('owner', set.id);
    r!.rig.db.exec(
      "CREATE TRIGGER fail_rule BEFORE INSERT ON mapping_type_rules BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(() => c.importSet('owner', doc, 'Half')).toThrow();
    r!.rig.db.exec('DROP TRIGGER fail_rule');
    expect(c.listSets('owner').map((s) => s.name)).toEqual(['Baisheng taxonomy']);
  });
});

describe('preview (read-only)', () => {
  /** characters (rcharact) > nobles (rnobles) > the Duke (rduke, tag "ruler"); the Crown (rcrown) has tag "nation". */
  async function seeded() {
    r = await mappingRig();
    const m = r.rig.h.model;
    m.seedResource('rcharact', { name: 'Characters' });
    m.seedResource('rnobles', { name: 'Nobles', parentId: 'rcharact' });
    m.seedResource('rduke', { name: 'The Duke', parentId: 'rnobles' });
    m.seedResource('rcrown', { name: 'The Crown', parentId: 'rcharact' });
    m.seedResource('rother', { name: 'Elsewhere' });
    m.resources.get('rduke')!.tags = ['ruler'];
    m.resources.get('rcrown')!.tags = ['nation'];
    const c = r.mappings.commands;
    const set = c.createSet('owner', SET);
    return { c, set, preview: (id: string) => settle(r!.rig.h, r!.rig.e, c.preview('owner', set.id, id)) };
  }

  it('reports the matching rules and the resulting type, reading through the governor at P0, and writes nothing', async () => {
    const { c, set, preview } = await seeded();
    c.createRule('owner', set.id, SUBTREE_RULE); // Characters and below -> Character (10)
    c.createRule('owner', set.id, TAG_RULE); // tag nation -> Nation (20)
    c.createRule('owner', set.id, {
      selector: { kind: 'tag', tag: 'ruler' },
      semanticType: 'Noble',
      priority: 30,
    });
    c.createField('owner', set.id, FIELD_SIDEBAR);
    const auditBefore = audits().length;

    const duke = (await preview('rduke')).value as any;
    expect(duke.semanticType).toBe('Noble'); // priority 30 beats 10
    expect(duke.matches.map((x: any) => [x.semanticType, x.via])).toEqual([
      ['Noble', 'its tags'],
      ['Character', 'an ancestor (2 levels up)'],
    ]);
    expect(duke.ancestors.map((a: any) => a.id)).toEqual(['rnobles', 'rcharact']);
    expect(duke.readsMade).toBe(3);

    const crown = (await preview('rcrown')).value as any;
    expect(crown.semanticType).toBe('Nation');
    const nobles = (await preview('rnobles')).value as any;
    expect(nobles.semanticType).toBe('Character');
    expect(nobles.fields.map((f: any) => f.fieldName)).toEqual(['Species']); // the type's field maps
    const other = (await preview('rother')).value as any;
    expect(other).toMatchObject({ semanticType: null, matches: [], winner: null });

    // Reads only: no write reached LegendKeeper, no job record, no audit row, nothing changed in the set.
    expect(r!.rig.h.mock.calls.length).toBeGreaterThan(0);
    expect(r!.rig.h.mock.calls.filter((x) => x.method !== 'GET')).toEqual([]);
    expect(r!.rig.h.model.mutations).toEqual([]);
    expect(audits().length).toBe(auditBefore);
    expect(r!.rig.e.engine.queries.listJobs({}).length).toBe(0);
  });

  it('the resource itself beats an ancestor at equal priority; "without descendants" matches only the resource', async () => {
    const { c, set, preview } = await seeded();
    c.createRule('owner', set.id, {
      selector: { kind: 'subtree', resourceId: 'rcharact', descendants: true },
      semanticType: 'Character',
      priority: 5,
    });
    c.createRule('owner', set.id, {
      selector: { kind: 'subtree', resourceId: 'rnobles', descendants: false },
      semanticType: 'Noble House',
      priority: 5,
    });
    expect(((await preview('rnobles')).value as any).semanticType).toBe('Noble House');
    expect(((await preview('rduke')).value as any).semanticType).toBe('Character'); // not below rnobles for that rule
  });

  it('flags a tie between different types, and reports template rules as not evaluable instead of guessing', async () => {
    const { c, set, preview } = await seeded();
    c.createRule('owner', set.id, {
      selector: { kind: 'tag', tag: 'ruler' },
      semanticType: 'Noble',
      priority: 1,
    });
    c.createRule('owner', set.id, {
      selector: { kind: 'tag', tag: 'ruler' },
      semanticType: 'Person',
      priority: 1,
    });
    c.createRule('owner', set.id, {
      selector: { kind: 'template', templateId: 'tchar' },
      semanticType: 'Character',
      priority: 99,
    });
    const p = (await preview('rduke')).value as any;
    expect(p.tie).toBe(true);
    expect(p.semanticType).toBe('Noble'); // the first listed
    expect(p.notEvaluable).toHaveLength(1);
    expect(p.notEvaluable[0].reason).toMatch(/does not record which template/);
  });

  it('does not walk the tree when no rule needs ancestors', async () => {
    const { c, set, preview } = await seeded();
    c.createRule('owner', set.id, TAG_RULE);
    expect(((await preview('rduke')).value as any).readsMade).toBe(1);
  });

  it('a resource LegendKeeper does not have is a clear error, and still writes nothing', async () => {
    const { c, set, preview } = await seeded();
    c.createRule('owner', set.id, TAG_RULE);
    const out = await preview('rmissing');
    expect(out.error).toBeDefined();
    expect(r!.rig.h.mock.calls.filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('an unknown set is not found, before any read', async () => {
    const { c } = await seeded();
    await expect(c.preview('owner', 'nope', 'rduke')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(r!.rig.h.mock.calls).toEqual([]);
  });
});
