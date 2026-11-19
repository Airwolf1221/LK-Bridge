/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 2.3 at unit level (src/jobs/items.ts): the filter that turns a
 * proposal's steps into the steps of the approved items. The attempts: an If-Match chain whose root belongs only to an
 * item left out (the kept write must keep a version to send, or the filter must refuse); a dependency cycle; a binding
 * to an item's step that the items do not declare; a placement anchored on a page no longer made.
 */
import { describe, expect, it } from 'vitest';
import {
  closeSelection,
  filterSteps,
  validateItems,
  withStepDependencies,
  type PlanItem,
} from '../../../src/jobs/items.js';
import type { StepSpec } from '../../../src/jobs/types.js';

const item = (id: string, dependsOn: string[] = []): PlanItem => ({
  id,
  kind: 'restatement',
  group: 'Textual restatements',
  label: id,
  dependsOn,
  selected: true,
});

describe('filterSteps', () => {
  it('AP-60 a write chained only through a left-out item keeps a version to send (or is refused)', () => {
    // Two writes to one document, each its own item; the second is chained from the first (its version).
    const steps: StepSpec[] = [
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: 'pagex001', documentId: 'docx0001' },
          body: { blocks: [] },
          ifMatch: 'v1',
        },
        items: ['a'],
      },
      {
        op: 'replaceDocumentBlocks',
        params: { path: { resourceId: 'pagex001', documentId: 'docx0001' }, body: { blocks: [] } },
        ifMatchFrom: { step: 1 },
        items: ['b'],
      },
    ] as StepSpec[];
    const items = withStepDependencies([item('a'), item('b')], steps);
    // The chain is not a dependency (the filter re-chains it), so b alone is a closed selection.
    expect(closeSelection(items, ['b']).kept).toEqual(['b']);
    let out: StepSpec[] | null = null;
    let refused: string | null = null;
    try {
      out = filterSteps(steps, ['b']).steps;
    } catch (e) {
      refused = (e as { code?: string }).code ?? 'refused';
    }
    if (refused === null) {
      const kept = out![0]!;
      // SAFE: the write still names the version it was planned on (a chain or a pinned If-Match).
      expect(
        kept.ifMatchFrom !== undefined || kept.params?.ifMatch !== undefined,
        `the kept write lost its If-Match: ${JSON.stringify(kept)}`,
      ).toBe(true);
    }
  });

  it('AP-61 items depending on each other in a circle are refused at capture', () => {
    expect(() => validateItems([item('a', ['b']), item('b', ['c']), item('c', ['a'])])).toThrow(/circle/);
  });

  it('AP-62 a binding to another item’s step is a dependency; leaving it out drops the dependant', () => {
    const steps: StepSpec[] = [
      {
        op: 'createResourceFromTemplate',
        params: { body: { templateId: 't', id: 'newpage1', name: 'N' } },
        items: ['a'],
      },
      {
        op: 'replaceDocumentBlocks',
        params: { path: { resourceId: 'newpage1', documentId: 'pending' }, body: { blocks: [] } },
        bindFrom: { step: 1, to: 'path.documentId', from: 'documents.main.id' },
        items: ['b'],
      },
    ] as StepSpec[];
    const items = withStepDependencies([item('a'), item('b')], steps);
    expect(items.find((i) => i.id === 'b')!.dependsOn).toContain('a');
    expect(closeSelection(items, ['b'])).toMatchObject({ kept: [], dropped: [{ id: 'b', because: ['a'] }] });
    // Asked to filter anyway (a selection that is not closed), the filter refuses rather than run an unbound write.
    expect(() => filterSteps(steps, ['b'])).toThrow(/needs step 1/);
  });

  it('AP-63 a page placed after a page no longer made takes its place; its read-back expects the same', () => {
    const steps: StepSpec[] = [
      {
        op: 'createResourceFromTemplate',
        params: { body: { templateId: 't', id: 'pagea001', name: 'A', parentId: 'ix', after: 'old00001' } },
        items: ['a'],
      },
      {
        op: 'createResourceFromTemplate',
        params: { body: { templateId: 't', id: 'pageb001', name: 'B', parentId: 'ix', after: 'pagea001' } },
        items: ['b'],
      },
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
                placement: { parentId: 'ix', after: 'old00001', before: 'pageb001' },
              },
              {
                kind: 'resource',
                label: 'B',
                resourceId: 'pageb001',
                fields: {},
                placement: { parentId: 'ix', after: 'pagea001', before: null },
              },
            ],
          },
        },
        itemParts: [{ path: 'body.targets', items: [['a'], ['b']] }],
      },
    ] as StepSpec[];
    const f = filterSteps(steps, ['b']);
    const create = f.steps.find((s) => s.op === 'createResourceFromTemplate')!;
    expect((create.params!.body as Record<string, unknown>).after).toBe('old00001');
    const verify = f.steps.find((s) => s.op === 'bridge.verify')!;
    const targets = (verify.params!.body as { targets: { placement: unknown }[] }).targets;
    expect(targets).toHaveLength(1);
    expect(targets[0]!.placement).toMatchObject({ after: 'old00001', before: null });
  });
});
