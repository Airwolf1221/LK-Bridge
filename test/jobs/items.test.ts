/**
 * v3 F3d (renames), ADR 0058: the items of a proposal (src/jobs/items.ts). The selection is closed (an unticked item's
 * dependants drop with it), and the steps of a selection are exactly the kept items' steps with every reference
 * re-mapped: a binding re-numbered, an If-Match chain re-chained past a dropped write, a Last Major Revision step left
 * with only its kept writes and evidence (or dropped with its write), a new page placed where a dropped sibling stood,
 * and a read-back's neighbours worked out the same way. A reference the items do not explain is refused.
 */
import { describe, expect, it } from 'vitest';
import {
  closeSelection,
  defaultSelection,
  dependantsOf,
  filterSteps,
  ItemFilterError,
  validateItems,
  withStepDependencies,
  type PlanItem,
} from '../../src/jobs/items.js';
import type { StepSpec } from '../../src/jobs/types.js';

const item = (id: string, dependsOn: string[] = [], selected = true): PlanItem => ({
  id,
  kind: 'test',
  group: 'Test',
  label: id,
  dependsOn,
  selected,
});

describe('the items', () => {
  it('are checked: unique, known dependencies, no circle', () => {
    expect(() => validateItems([item('a'), item('a')])).toThrow(/twice/);
    expect(() => validateItems([item('a', ['b'])])).toThrow(/not an item/);
    expect(() => validateItems([item('a', ['b']), item('b', ['a'])])).toThrow(/circle/);
    expect(() => validateItems([item('a'), item('b', ['a'])])).not.toThrow();
  });

  it('unticking one drops everything that needs it, directly or through others, and says why', () => {
    const items = [item('name'), item('facts', ['name']), item('alias', ['name']), item('label', ['facts'])];
    expect(dependantsOf(items, 'name')).toEqual(['facts', 'alias', 'label']);
    const r = closeSelection(items, ['facts', 'alias', 'label']);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([
      { id: 'facts', because: ['name'] },
      { id: 'alias', because: ['name'] },
      { id: 'label', because: ['facts'] },
    ]);
    expect(closeSelection(items, ['name', 'alias', 'label']).kept).toEqual(['name', 'alias']);
  });

  it('start ticked as they say, an unticked item’s dependants unticked with it', () => {
    const items = [item('name'), item('text', ['name'], false), item('after', ['text'])];
    expect(defaultSelection(items)).toEqual(['name']);
  });
});

/** A small plan: a shared check, two pages (B under A), a page text chain, a Last Major Revision pair, a read-back. */
function plan(): { steps: StepSpec[]; items: PlanItem[] } {
  const steps: StepSpec[] = [
    // 1: the shared check (versions for the page text chain), its parts by item
    {
      op: 'bridge.expect',
      params: {
        body: {
          checks: [
            { label: 'doc:d1', kind: 'registered', checker: 't', input: {} },
            { label: 'other', kind: 'registered', checker: 't', input: { ops: [1, 2] } },
          ],
        },
      },
      itemParts: [
        { path: 'body.checks', items: [['text1', 'text2'], ['pageB']] },
        { path: 'body.checks.1.input.ops', items: [['pageB'], ['pageA']] },
      ],
    },
    // 2: page A
    {
      op: 'createResourceFromTemplate',
      params: { body: { templateId: 't1', id: 'pagea001', name: 'A', parentId: 'root0001' } },
      items: ['pageA'],
    },
    // 3: page B, placed after A
    {
      op: 'createResourceFromTemplate',
      params: {
        body: { templateId: 't1', id: 'pageb001', name: 'B', parentId: 'root0001', after: 'pagea001' },
      },
      items: ['pageB'],
    },
    // 4: page C, placed after B
    {
      op: 'createResourceFromTemplate',
      params: {
        body: { templateId: 't1', id: 'pagec001', name: 'C', parentId: 'root0001', after: 'pageb001' },
      },
      items: ['pageC'],
    },
    // 5: B's text, bound to B's create
    {
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: 'pageb001', documentId: 'pending' }, body: { blocks: [] } },
      bindFrom: { step: 3, to: 'path.documentId', from: 'documents.main.id' },
      items: ['pageB'],
    },
    // 6, 7: two text writes on one document, chained from the check
    {
      op: 'replaceBlock',
      params: { path: { resourceId: 'r1', documentId: 'd1', blockId: 'b1' }, body: { id: 'b1' } },
      ifMatchFrom: { step: 1, key: 'doc:d1' },
      items: ['text1'],
    },
    {
      op: 'replaceBlock',
      params: { path: { resourceId: 'r1', documentId: 'd1', blockId: 'b2' }, body: { id: 'b2' } },
      ifMatchFrom: { step: 6 },
      items: ['text2'],
    },
    // 8, 9: Last Major Revision of r1 after both writes
    {
      op: 'bridge.lmr',
      params: {
        body: {
          resourceId: 'r1',
          key: 'Last Major Revision',
          after: [6, 7],
          measure: { known: [{ kind: 'fact', key: 'Subject', before: 'a', after: 'b', item: 'text1' }] },
        },
      },
      items: ['text1', 'text2'],
    },
    {
      op: 'updatePropertyRow',
      params: { path: { resourceId: 'r1', propertyId: 'r1', rowId: 'r1' }, body: { content: [] } },
      decisionFrom: { step: 8 },
      ifMatchFrom: { step: 8, key: 'lmr' },
      items: ['text1', 'text2'],
    },
    // 10: the read-back, shared, its targets by item
    {
      op: 'bridge.verify',
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: 'A',
              resourceId: 'pagea001',
              fields: {},
              placement: { parentId: 'root0001', after: null, before: 'pageb001' },
            },
            {
              kind: 'resource',
              label: 'B',
              resourceId: 'pageb001',
              fields: {},
              placement: { parentId: 'root0001', after: 'pagea001', before: 'pagec001' },
            },
            {
              kind: 'resource',
              label: 'C',
              resourceId: 'pagec001',
              fields: {},
              placement: { parentId: 'root0001', after: 'pageb001', before: null },
            },
            {
              kind: 'registered',
              label: 'B text',
              checker: 'x',
              inputFrom: [{ step: 5, as: 'w' }],
              input: {},
            },
          ],
        },
      },
      itemParts: [{ path: 'body.targets', items: [['pageA'], ['pageB'], ['pageC'], ['pageB']] }],
    },
  ];
  const items = ['pageA', 'pageB', 'pageC', 'text1', 'text2'].map((i) => item(i));
  return { steps, items };
}

describe('the steps of a selection', () => {
  it('with everything kept, every step stays, in order, with its references', () => {
    const { steps } = plan();
    const f = filterSteps(steps, ['pageA', 'pageB', 'pageC', 'text1', 'text2']);
    expect(f.steps.map((s) => s.op)).toEqual(steps.map((s) => s.op));
    expect(f.from).toEqual(steps.map((_, i) => i + 1));
    expect(f.steps[6]!.ifMatchFrom).toEqual({ step: 6 });
    expect(f.steps[4]!.bindFrom).toMatchObject({ step: 3 });
  });

  it('a page left out: its steps go, a sibling placed beside it takes its place, the read-back’s neighbours follow', () => {
    const { steps } = plan();
    const f = filterSteps(steps, ['pageA', 'pageC', 'text1', 'text2']);
    expect(f.notCreated).toEqual(['pageb001']);
    expect(f.steps.map((s) => s.op)).toEqual([
      'bridge.expect',
      'createResourceFromTemplate',
      'createResourceFromTemplate',
      'replaceBlock',
      'replaceBlock',
      'bridge.lmr',
      'updatePropertyRow',
      'bridge.verify',
    ]);
    // C was planned after B; it now goes after A.
    expect((f.steps[2]!.params!.body as Record<string, unknown>).after).toBe('pagea001');
    // The check keeps only the kept items' checks and parts.
    const checks = (f.steps[0]!.params!.body as { checks: { label: string; input: { ops?: unknown[] } }[] })
      .checks;
    expect(checks.map((c) => c.label)).toEqual(['doc:d1']);
    // The read-back: B's targets gone, A and C now neighbours.
    const targets = (f.steps[7]!.params!.body as { targets: Record<string, unknown>[] }).targets;
    expect(targets.map((t) => t.label)).toEqual(['A', 'C']);
    expect(targets[0]!.placement).toMatchObject({ after: null, before: 'pagec001' });
    expect(targets[1]!.placement).toMatchObject({ after: 'pagea001', before: null });
    // The chain and the decision re-numbered.
    expect(f.steps[4]!.ifMatchFrom).toEqual({ step: 4 });
    expect(f.steps[6]!.decisionFrom).toEqual({ step: 6 });
    expect((f.steps[5]!.params!.body as { after: number[] }).after).toEqual([4, 5]);
  });

  it('a write left out of a chain: the next write chains from what came before it (the check’s version)', () => {
    const { steps } = plan();
    const f = filterSteps(steps, ['pageA', 'pageB', 'pageC', 'text2']);
    const w = f.steps.find((s) => s.op === 'replaceBlock')!;
    expect((w.params!.path as Record<string, string>).blockId).toBe('b2');
    expect(w.ifMatchFrom).toEqual({ step: 1, key: 'doc:d1' });
    // The Last Major Revision step follows only the kept write, and keeps only the kept items' evidence.
    const lmr = f.steps.find((s) => s.op === 'bridge.lmr')!;
    const body = lmr.params!.body as { after: number[]; measure: { known: unknown[] } };
    expect(body.after).toEqual([f.steps.indexOf(w) + 1]);
    expect(body.measure.known).toEqual([]);
  });

  it('a Last Major Revision step with none of its writes left goes, and the write it decides with it', () => {
    const { steps } = plan();
    const f = filterSteps(steps, ['pageA', 'pageB', 'pageC']);
    expect(f.steps.some((s) => s.op === 'bridge.lmr' || s.op === 'updatePropertyRow')).toBe(false);
    expect(f.steps.some((s) => s.op === 'replaceBlock')).toBe(false);
  });

  it('a shared check left with nothing to check goes too', () => {
    const { steps } = plan();
    const f = filterSteps(steps, ['pageA', 'pageC']);
    // The check had the text items' check and B's: none is kept.
    expect(f.steps[0]!.op).toBe('createResourceFromTemplate');
  });

  it('a reference the items do not explain is refused: nothing is approved', () => {
    const { steps } = plan();
    // B's text bound to B's create, but B's text given to another item.
    const bad = steps.map((s, i) => (i === 4 ? { ...s, items: ['text1'] } : s));
    expect(() => filterSteps(bad, ['pageA', 'pageC', 'text1'])).toThrow(ItemFilterError);
  });
});

describe('dependencies the steps imply', () => {
  const steps: StepSpec[] = [
    {
      op: 'createResourceFromTemplate',
      params: { body: { templateId: 't', id: 'index001', name: 'I', parentId: 'root0001' } },
      items: ['index'],
    },
    {
      op: 'createResourceFromTemplate',
      params: { body: { templateId: 't', id: 'core0001', name: 'C', parentId: 'index001' } },
      items: ['core'],
    },
    {
      op: 'createResourceFromTemplate',
      params: {
        body: { templateId: 't', id: 'bio00001', name: 'B', parentId: 'root0001', after: 'core0001' },
      },
      items: ['bio'],
    },
    {
      op: 'updateProperty',
      params: {
        path: { resourceId: 'partner1', propertyId: 'p' },
        body: { items: [{ resourceId: 'bio00001' }] },
      },
      items: ['partner'],
    },
    {
      op: 'updateProperty',
      params: {
        path: { resourceId: 'core0001', propertyId: 'p' },
        body: { items: [{ resourceId: 'bio00001' }] },
      },
      items: ['coreLinks'],
    },
  ];
  const deps = (o?: Parameters<typeof withStepDependencies>[2]) =>
    Object.fromEntries(
      withStepDependencies(
        ['index', 'core', 'bio', 'partner', 'coreLinks'].map((i) => item(i)),
        steps,
        o,
      ).map((i) => [i.id, [...i.dependsOn].sort()]),
    );

  it('hard: a page made under a new page, a write to another item’s page; a link, and a place among siblings, are not', () => {
    expect(deps()).toEqual({ index: [], core: ['index'], bio: [], partner: [], coreLinks: ['core'] });
  });

  it('with `all`, a change made for new pages needs every page it names (a link it adds)', () => {
    expect(deps({ all: (id) => id === 'partner' })).toMatchObject({ partner: ['bio'] });
  });
});

describe('soft references to a page left out', () => {
  it('a link to it goes, a routing line naming it goes, another mention of it keeps its text', () => {
    const steps: StepSpec[] = [
      {
        op: 'createResourceFromTemplate',
        params: { body: { templateId: 't', id: 'bio00001', name: 'B', parentId: 'root0001' } },
        items: ['bio'],
      },
      {
        op: 'updateProperty',
        params: {
          path: { resourceId: 'core0001', propertyId: 'p' },
          body: { items: [{ resourceId: 'bio00001' }, { resourceId: 'keep0001' }] },
        },
        items: ['core'],
      },
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: 'index001', documentId: 'd1' },
          body: {
            blocks: [
              {
                id: 'l1',
                kind: 'bulletList',
                children: [
                  {
                    id: 'i1',
                    kind: 'listItem',
                    children: [
                      {
                        id: 'p1',
                        kind: 'paragraph',
                        content: [
                          { mention: { resourceId: 'bio00001', text: 'Bio' } },
                          { text: ': its life' },
                        ],
                      },
                    ],
                  },
                  {
                    id: 'i2',
                    kind: 'listItem',
                    children: [
                      { id: 'p2', kind: 'paragraph', content: [{ mention: { resourceId: 'keep0001' } }] },
                    ],
                  },
                ],
              },
              {
                id: 'p3',
                kind: 'paragraph',
                content: [{ text: 'See ' }, { mention: { resourceId: 'bio00001', text: 'her life' } }],
              },
            ],
          },
        },
        items: ['core'],
      },
    ];
    const f = filterSteps(steps, ['core']);
    expect(f.notCreated).toEqual(['bio00001']);
    expect((f.steps[0]!.params!.body as { items: unknown[] }).items).toEqual([{ resourceId: 'keep0001' }]);
    const blocks = (f.steps[1]!.params!.body as { blocks: Record<string, unknown>[] }).blocks;
    expect((blocks[0]!.children as { id: string }[]).map((c) => c.id)).toEqual(['i2']);
    expect(blocks[1]!.content).toEqual([{ text: 'See ' }, { text: 'her life' }]);
  });
});
