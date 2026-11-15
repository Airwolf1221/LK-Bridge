/**
 * v2 E5.2: a refused step that bridge code planned names what it writes (the page, the document, the feature with its name
 * and id), so the owner can find it; the index alone ("steps[1]") is not enough.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { describeStep } from '../../src/jobs/engine.js';
import { InvalidParamsError } from '../../src/jobs/index.js';
import { harness, origin, type Harness, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('naming a refused step (E5.2)', () => {
  it('describeStep names the page, the document and the feature', () => {
    expect(
      describeStep({
        tool: 'restore_snapshot',
        page: { id: 'bwrldgeo', name: 'Arkona' },
        document: { id: 'd1', name: 'Arkona Map' },
        feature: { id: 'f1', name: 'Old Port' },
        write: 'create feature “Old Port” (f1)',
      }),
    ).toBe('page “Arkona” (bwrldgeo), document “Arkona Map” (d1), feature “Old Port” (f1)');
    expect(describeStep({ page: { id: 'p1', name: 'A' }, write: 'the page' })).toBe(
      'page “A” (p1), writing the page',
    );
    expect(describeStep(undefined)).toBeNull();
    expect(describeStep({ tool: 'x' })).toBeNull();
  });

  it('a refused step of a batch carries its description in the error', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const err = await e.engine
      .submit({
        project: PROJECT,
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'getResource', params: { path: { resourceId: 'r1' } } },
          {
            op: 'createFeature',
            params: {
              path: { resourceId: 'r1', documentId: 'd1' },
              body: { id: 'f0000001', type: 'label', name: 'Old Port', pos: [0, 0], labelSize: 'small' },
            },
            journalOperation: {
              page: { id: 'r1', name: 'Arkona' },
              document: { id: 'd1', name: 'Arkona Map' },
              feature: { id: 'f0000001', name: 'Old Port' },
            },
          },
        ],
      })
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(InvalidParamsError);
    const m = (err as Error).message;
    expect(m).toMatch(/steps\[1\]\.body\.labelSize/);
    expect(m).toContain(
      '(step 2: page “Arkona” (r1), document “Arkona Map” (d1), feature “Old Port” (f0000001))',
    );
  });
});
