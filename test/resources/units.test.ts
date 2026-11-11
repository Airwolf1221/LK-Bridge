/**
 * Unit tests of v2 C2b's pure parts: the create planner (anchors, call order, parents first, neighbours), factsVersion
 * (stable across endpoints' row orders, changed by any edit), the copy matcher, request hashing, the request registry
 * (operation ids and claims), the delete rule, and the page-level summary's label.
 */
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';
import { assessDelete, canonicalRulesSchema, DEFAULT_CANONICAL_RULES } from '../../src/facts/index.js';
import { factsDifferences, factsVersionFrom } from '../../src/facts/version.js';
import { matchCopy } from '../../src/jobs/step-exec.js';
import { buildPageSummary } from '../../src/policy/page-summary.js';
import { CreatePlanError, SiblingSim, planCreates, type CreateItem } from '../../src/resources/plan.js';
import { PLANNING_TTL_MS, RequestRegistry, requestHash } from '../../src/resources/requests.js';

const sib = (id: string, name: string, kind: 'index' | 'bsrc' = 'bsrc') => ({ id, displayName: name, kind });
const item = (
  key: string,
  name: string,
  parent: CreateItem['parent'],
  o: { kind?: 'index' | 'bsrc'; template?: string } = {},
): CreateItem => ({
  key,
  id: `id_${key}`,
  rawName: `${o.kind === 'index' ? '[INDEX]' : '[BSRC]'} ${name}`,
  displayName: name,
  kind: o.kind ?? 'bsrc',
  parent,
  templateId: o.template ?? null,
});

describe('planCreates', () => {
  const existing = () =>
    new SiblingSim((p) => (p === 'P' ? [sib('a', 'Alder'), sib('m', 'Maple'), sib('z', 'Zelkova')] : []));

  it('one page: after the greatest sibling at or before it, else before the least after it; neighbours simulated', () => {
    const sim = existing();
    const plan = planCreates([item('x', 'Birch', { existing: 'P' })], sim, { batch: false });
    expect(plan.steps).toEqual([expect.objectContaining({ kind: 'single', slot: { after: 'a' } })]);
    expect(plan.placement.get('id_x')).toEqual({ parentId: 'P', after: 'a', before: 'm' });
    const first = planCreates([item('y', 'Aardvark', { existing: 'P' })], existing(), { batch: false });
    expect(first.steps[0]).toMatchObject({ slot: { before: 'a' } });
  });

  it('a batch: pages sharing an `after` anchor are sent in reverse so they end alphabetical; neighbours exact', () => {
    const items = ['Beech', 'Birch', 'Box'].map((n, i) => item(`b${i}`, n, { existing: 'P' }));
    const plan = planCreates(items, existing(), { batch: true });
    expect(plan.steps).toHaveLength(1);
    const batch = plan.steps[0] as Extract<(typeof plan.steps)[number], { kind: 'batch' }>;
    expect(batch.items.map((x) => [x.item.displayName, x.slot])).toEqual([
      ['Box', { after: 'a' }],
      ['Birch', { after: 'a' }],
      ['Beech', { after: 'a' }],
    ]);
    expect(plan.placement.get('id_b0')).toEqual({ parentId: 'P', after: 'a', before: 'id_b1' });
    expect(plan.placement.get('id_b2')).toEqual({ parentId: 'P', after: 'id_b1', before: 'm' });
  });

  it('pages under a parent made in the same call have no anchor and are sent sorted, parents first', () => {
    const items = [
      item('c2', 'Zed', { item: 'root' }),
      item('c1', 'Abel', { item: 'root' }),
      item('root', 'Root', { existing: 'P' }, { kind: 'index' }),
      item('g', 'Grand', { item: 'c1' }),
    ];
    const plan = planCreates(items, existing(), { batch: true });
    const batch = plan.steps[0] as Extract<(typeof plan.steps)[number], { kind: 'batch' }>;
    expect(batch.items.map((x) => [x.item.key, x.slot])).toEqual([
      ['root', { before: 'a' }],
      ['c1', {}],
      ['g', {}],
      ['c2', {}],
    ]);
  });

  it('a template page is its own write; plain pages it needs are sent first; later ones may anchor to it', () => {
    const items = [
      item('idx', 'Group', { existing: 'P' }, { kind: 'index' }),
      item('t', 'Templated', { item: 'idx' }, { template: 'tpl' }),
      item('leaf', 'Leaf', { item: 't' }),
      item('b', 'Apple', { item: 'idx' }),
    ];
    const plan = planCreates(items, existing(), { batch: true });
    expect(plan.steps.map((s) => (s.kind === 'batch' ? s.items.map((x) => x.item.key) : s.item.key))).toEqual(
      [['idx', 'b'], 't', ['leaf']],
    );
    // Apple was created before Templated; Templated anchors after it.
    expect(plan.steps[1]).toMatchObject({ kind: 'template', slot: { after: 'id_b' } });
  });

  it('refuses an unknown parent key and a loop', () => {
    expect(() => planCreates([item('a', 'A', { item: 'nope' })], existing(), { batch: true })).toThrow(
      CreatePlanError,
    );
    expect(() =>
      planCreates([item('a', 'A', { item: 'b' }), item('b', 'B', { item: 'a' })], existing(), {
        batch: true,
      }),
    ).toThrow(/loop/);
  });
});

describe('factsVersion', () => {
  const props = (rows: { id: string; rank: string; key: string; text: string }[], items = ['p1']) => [
    {
      id: 'kv',
      kind: 'keyValue',
      title: 'PROPERTIES',
      rows: rows.map((r) => ({ ...r, content: [{ text: r.text }] })),
    },
    {
      id: 'dep',
      kind: 'resourceCollection',
      title: 'Dependencies',
      items: items.map((i, n) => ({ id: `i${n}`, resourceId: i })),
      filter: null,
    },
    { id: 'tags', kind: 'unsupported', title: 'TAGS' },
  ];
  const rows = [
    { id: 'r1', rank: 'b', key: 'Status', text: 'Working' },
    { id: 'r2', rank: 'a', key: 'Subject', text: 'Ren' },
  ];

  it('is the same from listProperties (stored order) and getResource and listPropertyRows orders; property order too', () => {
    const a = factsVersionFrom('page0001', { data: props(rows) }).version;
    const b = factsVersionFrom('page0001', { properties: [...props([...rows].reverse())].reverse() }).version;
    expect(a).toMatch(/^fv2_[0-9a-f]{24}$/);
    expect(b).toBe(a);
  });

  it('C2d: belongs to one page: two copies of one template with the same ids and values get different versions', () => {
    // LegendKeeper reuses a template's property and row ids in every copy (ADR 0037), so the facts alone are equal.
    const a = factsVersionFrom('copy0001', { data: props(rows) }).version;
    const b = factsVersionFrom('copy0002', { data: props(rows) }).version;
    expect(a).not.toBe(b);
    expect(factsVersionFrom('copy0001', { data: props(rows) }).version).toBe(a);
  });

  it('changes with a value, a key, a rank, a row added or removed, an item, a filter; not with a TAGS property', () => {
    const base = factsVersionFrom('page0001', { data: props(rows) }).version;
    const changed = [
      props([{ ...rows[0]!, text: 'Archived' }, rows[1]!]),
      props([{ ...rows[0]!, key: 'State' }, rows[1]!]),
      props([{ ...rows[0]!, rank: '0' }, rows[1]!]),
      props([rows[0]!]),
      props(rows, ['p1', 'p2']),
      props(rows).map((p) => (p.id === 'dep' ? { ...p, filter: { tag: 'x' } } : p)),
    ];
    for (const c of changed) expect(factsVersionFrom('page0001', { data: c }).version).not.toBe(base);
    const tags = props(rows).map((p) => (p.id === 'tags' ? { ...p, title: 'Tags (renamed)' } : p));
    expect(factsVersionFrom('page0001', { data: tags }).version).toBe(base);
  });

  it('says which rows or collections changed', () => {
    const a = factsVersionFrom('page0001', { data: props(rows) }).state;
    const b = factsVersionFrom('page0001', {
      data: props([{ ...rows[0]!, text: 'Archived' }, rows[1]!], ['p2']),
    }).state;
    const d = factsDifferences(a, b).map((x) => x.path);
    expect(d.some((p) => p.includes('Status'))).toBe(true);
    expect(d.some((p) => p.includes('Dependencies'))).toBe(true);
  });
});

describe('matchCopy', () => {
  const template = [
    {
      id: 'tp',
      kind: 'keyValue',
      title: 'PROPERTIES',
      rows: [
        { id: 'tr1', key: 'Reference Type', content: [] },
        { id: 'tr2', key: 'Status', content: [] },
      ],
    },
    { id: 'tc', kind: 'resourceCollection', title: 'Dependencies', items: [] },
  ];
  it('maps each template id to the copy’s', () => {
    const copy = {
      data: [
        { id: 'cc', kind: 'resourceCollection', title: 'Dependencies', items: [] },
        {
          id: 'cp',
          kind: 'keyValue',
          title: 'properties',
          rows: [
            { id: 'cr2', rank: 'b', key: 'Status', content: [] },
            { id: 'cr1', rank: 'a', key: 'Reference Type', content: [] },
          ],
        },
      ],
    };
    expect(matchCopy('x', template, copy)).toEqual({
      ids: { tp: 'cp', tr1: 'cr1', tr2: 'cr2', tc: 'cc' },
      differences: [],
    });
  });
  it('a copy that is not the template’s layout is a difference (nothing bound)', () => {
    const copy = {
      data: [
        {
          id: 'cp',
          kind: 'keyValue',
          title: 'PROPERTIES',
          rows: [{ id: 'c1', rank: 'a', key: 'Status', content: [] }],
        },
      ],
    };
    const m = matchCopy('x', template, copy);
    expect(m.differences.length).toBe(2);
  });
});

describe('requestHash and the request registry', () => {
  it('ignores spacing, key order, operation_id, project and dryRun; not the values', () => {
    const a = requestHash('t', { name: 'A  B', parent: 'P', operation_id: '1', project: 'x' });
    expect(requestHash('t', { parent: ' P ', name: 'A B', dryRun: false })).toBe(a);
    expect(requestHash('t', { name: 'A C', parent: 'P' })).not.toBe(a);
    expect(requestHash('u', { name: 'A  B', parent: 'P' })).not.toBe(a);
  });

  const registry = () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    new ProjectStore(db, () => 1).insert({ id: 'p', name: 'p', displayName: null, verifiedAt: 1 });
    let now = 1_000_000;
    const r = new RequestRegistry(db, () => now, 30 * 86_400_000);
    return { r, db, tick: (ms: number) => (now += ms) };
  };

  it('operation ids: new, in progress, repeat, reused; a release frees the id', () => {
    const { r } = registry();
    expect(r.begin('p', 'a', 'op1', 'create_resource', 'h1').kind).toBe('new');
    expect(r.begin('p', 'a', 'op1', 'create_resource', 'h1').kind).toBe('in_progress');
    r.settle('p', 'a', 'op1', { jobId: 'j1', result: { body: { status: 'written' } } });
    expect(r.begin('p', 'a', 'op1', 'create_resource', 'h1')).toMatchObject({
      kind: 'repeat',
      row: { jobId: 'j1' },
    });
    expect(r.begin('p', 'a', 'op1', 'create_resource', 'h2').kind).toBe('reused');
    expect(r.begin('p', 'b', 'op1', 'create_resource', 'h2').kind).toBe('new'); // another principal
    r.releaseOperation('p', 'b', 'op1');
    expect(r.begin('p', 'b', 'op1', 'create_resource', 'h3').kind).toBe('new');
  });

  it('claims: a planning claim holds for a while; a finished job’s claim does not', () => {
    const { r, db, tick } = registry();
    const c1 = r.claim('p', 'character:ren', 'a', 'create_character', 'Ren');
    expect(c1.ok).toBe(true);
    const c2 = r.claim('p', 'character:ren', 'b', 'create_character', 'Ren');
    expect(c2).toMatchObject({ ok: false, holder: { principalId: 'a' } });
    // Bound to a job: active while the job is; not once it has finished.
    db.prepare(
      `INSERT INTO jobs (id, project_id, kind, title, origin, origin_kind, principal_id, profile, priority, status, on_error, steps_total, created_at, updated_at)
       VALUES ('j1', 'p', 'batch_ops', 't', '{}', 'mcp', 'a', 'x', 'P1', 'running', 'stop', 1, 0, 0)`,
    ).run();
    r.bind('p', 'character:ren', (c1 as { token: number }).token, { jobId: 'j1' });
    expect(r.claim('p', 'character:ren', 'b', 'create_character', 'Ren').ok).toBe(false);
    db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE id = 'j1'`).run();
    expect(r.claim('p', 'character:ren', 'b', 'create_character', 'Ren').ok).toBe(true);
    // An abandoned planning claim stops counting.
    const c3 = r.claim('p', 'character:kai', 'a', 'create_character', 'Kai');
    expect(c3.ok).toBe(true);
    tick(PLANNING_TTL_MS + 1);
    expect(r.claim('p', 'character:kai', 'b', 'create_character', 'Kai').ok).toBe(true);
  });
});

describe('the delete rule and the summary label', () => {
  it('assessDelete protects a page holding a delete rule’s value; the rule kind validates', () => {
    const facts = [{ key: 'status', content: [{ text: 'authoritative' }] }];
    expect(assessDelete(DEFAULT_CANONICAL_RULES, facts, 'Inae')).toEqual([
      expect.objectContaining({ ruleId: 'delete-authoritative', direction: 'delete', page: 'Inae' }),
    ]);
    expect(
      assessDelete(DEFAULT_CANONICAL_RULES, [{ key: 'Status', content: [{ text: 'Working' }] }], 'X'),
    ).toEqual([]);
    expect(
      canonicalRulesSchema.safeParse([{ id: 'd', key: 'Status', kind: 'delete', values: ['Canon'] }]).success,
    ).toBe(true);
    expect(
      canonicalRulesSchema.safeParse([{ id: 'd', key: 'Status', kind: 'delete', values: [] }]).success,
    ).toBe(false);
  });

  it('a high-level operation can give the page-level summary’s label', () => {
    const s = buildPageSummary(
      [],
      [
        {
          page: { id: 'n1', name: '[BSRC] X' },
          isNew: true,
          pageParts: ['under [INDEX] Y'],
          summaryLabel: 'New page [BSRC] X under [INDEX] Y: 6 facts',
        },
      ],
      () => null,
    );
    expect(s[0]!.label).toBe('New page [BSRC] X under [INDEX] Y: 6 facts');
  });
});
