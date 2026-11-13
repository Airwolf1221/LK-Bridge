/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.* matchers are typed any */
/**
 * v2 E2 (ADR 0044): rules, template checks and tag rules (src/audits/checks/rules.ts). Every old-bridge code keeps its
 * meaning; overlapping and ambiguous rules, a duplicate ancestor or template name and an unmatched page are findings,
 * never guesses; templates are compared for structure, never values.
 */
import { describe, expect, it } from 'vitest';
import { defaultRules, type AuditRule } from '../../src/audits/config.js';
import { compareWithTemplate, parseTagDefinition, rulesCheck } from '../../src/audits/checks/rules.js';
import { characterType, codes, context, kv, model, page, prop, ROOT, scan } from './helpers.js';

const rule = (id: string, selectors: AuditRule['selectors'], template: AuditRule['template']): AuditRule => ({
  id,
  name: id,
  enabled: true,
  selectors,
  template,
});

const CORE_TEMPLATE = page({
  id: 'tpl-core',
  name: '[BSRC] AI Character Core',
  parent: 'templates',
  facts: { 'Reference Type': '', Subject: '', 'Race / Species': '' },
  props: [
    prop('Dependencies', 'resourceCollection'),
    prop('Related Sources', 'resourceCollection'),
    prop('TAGS', 'unsupported', { isTitleHidden: true }),
  ],
  docs: [
    { id: 'td1', name: 'Main', type: 'blank' },
    { id: 'td2', name: 'Chronicle', type: 'time' },
  ],
});

const corePage = (o: Partial<Parameters<typeof page>[0]> = {}) =>
  page({
    id: 'p1',
    name: '[BSRC] Mira - Character Core',
    parent: 'chars',
    facts: { 'Reference Type': 'Character Core', Subject: 'Mira', 'Race / Species': 'Human' },
    props: [
      prop('Dependencies', 'resourceCollection'),
      prop('Related Sources', 'resourceCollection'),
      prop('TAGS', 'unsupported', { isTitleHidden: true }),
    ],
    docs: [
      { id: 'd1', name: 'Main', type: 'page' },
      { id: 'd2', name: 'Chronicle', type: 'time' },
    ],
    tags: ['CANON'],
    ...o,
  });

const coreRule = rule(
  'core',
  { referenceType: 'Character Core' },
  { templateName: '[BSRC] AI Character Core' },
);

describe('selecting pages', () => {
  it('matches by Reference Type, name prefix and ancestor name, all of them together', () => {
    const chars = page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' });
    const m = model([ROOT, chars, corePage()], { templates: [CORE_TEMPLATE] });
    const hit = rule(
      'r',
      { referenceType: 'character core', namePrefix: '[BSRC] ', ancestorName: 'Characters' },
      { templateName: 'AI Character Core' },
    );
    const forP1 = (r: AuditRule) =>
      codes(rulesCheck(context(m, { rules: [r] })).filter((d) => d.pageId === 'p1'));
    expect(forP1(hit)).toEqual([]);
    const miss = rule(
      'r',
      { referenceType: 'Character Core', ancestorName: 'Locations' },
      { templateName: 'AI Character Core' },
    );
    expect(forP1(miss)).toEqual(['no_matching_rule']);
    const prefix = rule(
      'r',
      { referenceType: 'Character Core', namePrefix: '[INDEX] ' },
      { templateName: 'AI Character Core' },
    );
    expect(forP1(prefix)).toEqual(['no_matching_rule']);
  });

  it('no_matching_rule: a page no rule matches is reported (and can be switched off), never guessed', () => {
    const m = model([ROOT, corePage()], { templates: [CORE_TEMPLATE] });
    expect(codes(rulesCheck(context(m, { rules: [] })))).toEqual(['no_matching_rule']);
    expect(rulesCheck(context(m, { rules: [], settings: { reportUnmatched: false } }))).toEqual([]);
  });

  it('ambiguous_owner_rule: two rules matching one page apply neither (overlapping rules)', () => {
    const m = model([ROOT, corePage({ props: [] })], { templates: [CORE_TEMPLATE] });
    const a = rule('a', { referenceType: 'Character Core' }, { templateName: 'AI Character Core' });
    const b = rule('b', { namePrefix: '[BSRC] ' }, { templateName: 'AI Character Core' });
    const out = rulesCheck(context(m, { rules: [a, b] }));
    expect(codes(out)).toEqual(['ambiguous_owner_rule']);
    expect(out[0]!.evidence).toEqual({ rules: ['a', 'b'] });
  });

  it('a disabled rule matches nothing', () => {
    const m = model([ROOT, corePage()], { templates: [CORE_TEMPLATE] });
    const off = { ...coreRule, enabled: false };
    expect(codes(rulesCheck(context(m, { rules: [off] })))).toEqual(['no_matching_rule']);
  });

  it('ambiguous_ancestor: a duplicate ancestor name is a finding, not a guess', () => {
    const outer = page({ id: 'o', name: '[INDEX] Humans', parent: 'root' });
    const inner = page({ id: 'i', name: '[INDEX] Humans', parent: 'o' });
    const leaf = corePage({ parent: 'i' });
    const m = model([ROOT, outer, inner, leaf], { templates: [CORE_TEMPLATE] });
    const r = rule(
      'r',
      { ancestorName: 'Humans', referenceType: 'Character Core' },
      { templateName: 'AI Character Core' },
    );
    expect(codes(rulesCheck(context(m, { rules: [r] })).filter((d) => d.pageId === 'p1'))).toEqual([
      'ambiguous_ancestor',
    ]);
  });

  it('incomplete_owner_ancestry: a parent chain that does not reach the root', () => {
    const orphan = corePage({ parent: 'gone' });
    const m = model([ROOT, orphan], { templates: [CORE_TEMPLATE] });
    const r = rule('r', { ancestorName: 'Characters' }, { templateName: 'AI Character Core' });
    expect(codes(rulesCheck(context(m, { rules: [r] })))).toEqual(['incomplete_owner_ancestry']);
  });

  it('selects by registry type and role, and by kind', () => {
    const chars = page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' });
    const compact = page({
      id: 'c1',
      name: '[BSRC] Zed - Character Reference',
      parent: 'chars',
      facts: { 'Reference Type': 'Compact Character Reference' },
    });
    const m = model([ROOT, chars, corePage(), compact], { templates: [CORE_TEMPLATE] });
    const types = [characterType()];
    const rules = defaultRules(types);
    expect(rules.map((r) => r.id)).toEqual(['character-core', 'character-compact', 'index']);
    const out = rulesCheck(context(m, { rules, types }));
    // The Compact template and the index template are not in the snapshot: reported once each; the core page is checked.
    expect(codes(out).filter((c) => c === 'template_not_found')).toHaveLength(2);
    expect(out.filter((d) => d.pageId === 'p1')).toEqual([]);
  });

  it('rule_selector_unknown: a registry type or role the registry does not know', () => {
    const m = model([ROOT, corePage()], { templates: [CORE_TEMPLATE] });
    const r1 = rule('r1', { registryType: 'Weapon' }, { templateName: 'x' });
    const r2 = rule('r2', { registryType: 'Character', role: 'villain' }, { templateName: 'x' });
    const out = rulesCheck(context(m, { rules: [r1, r2], types: [characterType()] }));
    expect(codes(out).filter((c) => c === 'rule_selector_unknown')).toHaveLength(2);
  });
});

describe('templates', () => {
  it('resolves a template through the registry role, by name (ignoring the word Template) and by id', () => {
    const m = model([ROOT, corePage()], { templates: [CORE_TEMPLATE] });
    const byRole = rule(
      'a',
      { referenceType: 'Character Core' },
      { registry: { type: 'Character', role: 'core' } },
    );
    const byName = rule(
      'b',
      { referenceType: 'Character Core' },
      { templateName: '[BSRC] AI Character Core Template' },
    );
    const byId = rule('c', { referenceType: 'Character Core' }, { templateId: 'tpl-core' });
    for (const r of [byRole, byName, byId])
      expect(rulesCheck(context(m, { rules: [r], types: [characterType()] }))).toEqual([]);
  });

  it('ambiguous_template and template_not_found: a duplicate or missing template name', () => {
    const twin = page({ ...{ id: 'tpl-core2', name: '[BSRC] AI Character Core', parent: 'templates' } });
    const m = model([ROOT, corePage()], { templates: [CORE_TEMPLATE, twin] });
    const out = rulesCheck(context(m, { rules: [coreRule] }));
    expect(codes(out)).toEqual(['ambiguous_template']);
    const none = rule('n', { referenceType: 'Character Core' }, { templateName: 'AI Nothing' });
    expect(
      codes(
        rulesCheck(context(model([ROOT, corePage()], { templates: [CORE_TEMPLATE] }), { rules: [none] })),
      ),
    ).toEqual(['template_not_found']);
  });

  it('templates_unavailable: a snapshot without templates skips the template checks and says so once', () => {
    const m = model([ROOT, corePage(), corePage({ id: 'p2', name: '[BSRC] Zed - Character Core' })], {
      templates: null,
    });
    const out = rulesCheck(context(m, { rules: [coreRule] }));
    expect(codes(out)).toEqual(['templates_unavailable']);
    expect(out[0]!.sourceKind).toBe('bridge');
  });

  it('a page that follows its template has no findings; extra owner fields and tabs are not errors', () => {
    const extra = corePage({
      facts: {
        'Reference Type': 'Character Core',
        Subject: 'Mira',
        'Race / Species': 'Human',
        'Favourite food': 'rice',
      },
      props: [
        prop('Notes', 'textField'),
        prop('Dependencies', 'resourceCollection'),
        prop('Related Sources', 'resourceCollection'),
        prop('TAGS', 'unsupported', { isTitleHidden: true }),
      ],
      docs: [
        { id: 'd0', name: 'Scratch', type: 'blank' },
        { id: 'd1', name: 'Main', type: 'page' },
        { id: 'd2', name: 'Chronicle', type: 'time' },
      ],
    });
    expect(compareWithTemplate(extra, CORE_TEMPLATE, coreRule)).toEqual([]);
  });

  it('property_kind_mismatch, property_missing, property_order_mismatch', () => {
    const p = corePage({
      props: [prop('Related Sources', 'resourceCollection'), prop('Dependencies', 'keyValue', { rows: [] })],
    });
    const out = compareWithTemplate(p, CORE_TEMPLATE, coreRule);
    expect(codes(out)).toEqual(
      ['property_kind_mismatch', 'property_missing', 'property_order_mismatch'].sort(),
    );
    expect(out.find((d) => d.code === 'property_kind_mismatch')!.evidence).toMatchObject({
      expected: 'resourceCollection',
      found: 'keyValue',
    });
    expect(out.find((d) => d.code === 'property_missing')!.evidence).toMatchObject({
      expected: { title: 'TAGS', kind: 'unsupported' },
    });
  });

  it('property_presentation_mismatch: visibility, title flag and display', () => {
    const tpl = page({
      id: 't',
      name: '[BSRC] T',
      parent: 'templates',
      props: [prop('Notes', 'textField', { isTitleHidden: true, display: null })],
    });
    const p = page({
      id: 'x',
      name: '[BSRC] X',
      props: [prop('Notes', 'textField', { isHidden: true })],
      docs: [],
    });
    const out = compareWithTemplate(p, { ...tpl, documents: [] }, coreRule);
    expect(codes(out)).toEqual(['property_presentation_mismatch']);
    expect(Object.keys((out[0]!.evidence as { differences: object }).differences).sort()).toEqual([
      'isHidden',
      'isTitleHidden',
    ]);
  });

  it('property_row_missing and property_row_order_mismatch: keys and their order, never values', () => {
    const tpl = page({
      id: 't',
      name: '[BSRC] T',
      parent: 'templates',
      facts: { A: '', B: '', C: '' },
      docs: [],
    });
    const same = page({ id: 'x', name: '[BSRC] X', facts: { A: 'one', B: 'two', C: 'three' }, docs: [] });
    expect(compareWithTemplate(same, tpl, coreRule)).toEqual([]);
    const reordered = page({ id: 'y', name: '[BSRC] Y', facts: { C: 'c', A: 'a', B: 'b' }, docs: [] });
    expect(codes(compareWithTemplate(reordered, tpl, coreRule))).toEqual(['property_row_order_mismatch']);
    const lacking = page({ id: 'z', name: '[BSRC] Z', facts: { A: 'a', C: 'c' }, docs: [] });
    expect(codes(compareWithTemplate(lacking, tpl, coreRule))).toEqual(['property_row_missing']);
  });

  it('document_type_mismatch, document_missing, document_order_mismatch; a blank template tab may become a page', () => {
    const p = corePage({
      docs: [
        { id: 'd2', name: 'Chronicle', type: 'page' },
        { id: 'd1', name: 'Main', type: 'page' },
      ],
    });
    const out = compareWithTemplate(p, CORE_TEMPLATE, coreRule);
    expect(codes(out)).toEqual(['document_order_mismatch', 'document_type_mismatch']);
    const lacking = corePage({ docs: [{ id: 'd1', name: 'Main', type: 'page' }] });
    expect(codes(compareWithTemplate(lacking, CORE_TEMPLATE, coreRule))).toEqual(['document_missing']);
  });
});

describe('tag rules', () => {
  const block = (text: string, language = 'json') => ({ blockId: 'cb', language, text });
  const def = (o: object) =>
    JSON.stringify({ schema: 1, rules: [{ id: 'core', required_tags: ['CANON'], ...o }] });

  it('parses exactly one json block holding the schema', () => {
    expect(parseTagDefinition([block(def({}))])).toMatchObject({ ok: true });
    expect(parseTagDefinition([])).toMatchObject({
      ok: false,
      error: expect.stringContaining('no `json` code block'),
    });
    expect(parseTagDefinition([block(def({})), block(def({}))])).toMatchObject({
      ok: false,
      error: expect.stringContaining('2 `json` code blocks'),
    });
    expect(parseTagDefinition([block('{ not json')])).toMatchObject({
      ok: false,
      error: expect.stringContaining('not valid JSON'),
    });
    expect(parseTagDefinition([block(def({ extra: 1 }))])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unrecognized'),
    });
    expect(parseTagDefinition([block(JSON.stringify({ schema: 2, rules: [] }))])).toMatchObject({
      ok: false,
    });
    const dup = JSON.stringify({
      schema: 1,
      rules: [
        { id: 'a', required_tags: [] },
        { id: 'a', required_tags: [] },
      ],
    });
    expect(parseTagDefinition([block(dup)])).toMatchObject({
      ok: false,
      error: expect.stringContaining('repeats the rule id a'),
    });
    // A block in another language does not count.
    expect(parseTagDefinition([block(def({}), 'text')])).toMatchObject({ ok: false });
  });

  const withTags = (json: string, tags: string[]) => {
    const source = page({
      id: 'def',
      name: '[BSRC] Tag definitions',
      scans: [scan('dd', { codeBlocks: [block(json)] })],
      docs: [{ id: 'dd', name: 'Main', type: 'page' }],
    });
    const m = model([ROOT, source, corePage({ tags })], { templates: [CORE_TEMPLATE] });
    return rulesCheck(
      context(m, { rules: [coreRule], tagSource: { pageId: 'def', documentId: 'dd' } }),
    ).filter((d) => d.pageId === 'p1');
  };

  it('missing_required_tags has an additive fix; tags_outside_definition has none; duplicate_tags', () => {
    const out = withTags(def({ allowed_tags: ['port'] }), ['port', 'Port', 'secret']);
    expect(codes(out)).toEqual(['duplicate_tags', 'missing_required_tags', 'tags_outside_definition']);
    const missing = out.find((d) => d.code === 'missing_required_tags')!;
    expect(missing.fix).toMatchObject({ kind: 'add_tags', args: { pageId: 'p1', add: ['CANON'] } });
    expect(out.find((d) => d.code === 'tags_outside_definition')!.fix).toBeUndefined();
    expect(out.find((d) => d.code === 'tags_outside_definition')!.evidence).toMatchObject({
      outside: ['secret'],
    });
    expect(out.find((d) => d.code === 'duplicate_tags')!.fix).toBeUndefined();
  });

  it('a required tag is allowed even when allowed_tags does not list it; no findings when all is well', () => {
    expect(withTags(def({ allowed_tags: ['port'] }), ['CANON', 'port'])).toEqual([]);
    expect(withTags(def({}), ['canon', 'anything'])).toEqual([]);
  });

  it('tag_definition_invalid: a bad definition skips the tag rules and is one finding', () => {
    const out = withTags('{ nope', []);
    expect(codes(out)).toEqual([]);
    const source = page({
      id: 'def',
      name: '[BSRC] Tag definitions',
      scans: [scan('dd', { codeBlocks: [] })],
      docs: [{ id: 'dd', name: 'Main', type: 'page' }],
    });
    const m = model([ROOT, source, corePage()], { templates: [CORE_TEMPLATE] });
    const all = rulesCheck(
      context(m, {
        rules: [coreRule],
        tagSource: { pageId: 'def', documentId: 'dd' },
        settings: { reportUnmatched: false },
      }),
    );
    expect(codes(all)).toEqual(['tag_definition_invalid']);
    expect(all[0]).toMatchObject({ pageId: 'def', documentId: 'dd' });
  });

  it('tag_rule_unknown: a tag rule whose id no audit rule has', () => {
    const json = JSON.stringify({ schema: 1, rules: [{ id: 'ghost', required_tags: [] }] });
    const source = page({
      id: 'def',
      name: '[BSRC] Tag definitions',
      scans: [scan('dd', { codeBlocks: [block(json)] })],
      docs: [{ id: 'dd', name: 'Main', type: 'page' }],
    });
    const m = model([ROOT, source, corePage()], { templates: [CORE_TEMPLATE] });
    const all = rulesCheck(
      context(m, {
        rules: [coreRule],
        tagSource: { pageId: 'def', documentId: 'dd' },
        settings: { reportUnmatched: false },
      }),
    );
    expect(codes(all)).toEqual(['tag_rule_unknown']);
  });

  void kv;
});
