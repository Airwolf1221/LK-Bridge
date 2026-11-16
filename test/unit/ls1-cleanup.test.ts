/**
 * v3 F2 (ADR 0049 decision 7): LS1's clean-up. LegendKeeper also refuses deleteFeature on a map holding the label it
 * cannot list; the feature then goes with its throwaway page in the run's clean-up, which is a pass with a note.
 */
import { describe, expect, it } from 'vitest';
import { ls1Cleanup } from '../sandbox/assumptions.js';

describe('LS1 clean-up', () => {
  it('a refused deleteFeature is a clean-up by the throwaway page: no failure, with a note', () => {
    const r = ls1Cleanup({ status: 400, code: 'VALIDATION_ERROR' }, null);
    expect(r.fail).toBe(false);
    expect(r.detail).toMatch(/deleteFeature was refused on this map too \(400 VALIDATION_ERROR\)/);
    expect(r.detail).toMatch(/removed with its throwaway page/);
  });
  it('a delete after which the map still cannot be listed fails', () => {
    expect(ls1Cleanup({ status: 204 }, { status: 400, code: 'VALIDATION_ERROR' }).fail).toBe(true);
  });
  it('a delete that makes the map listable again passes', () => {
    expect(ls1Cleanup({ status: 204 }, { status: 200 })).toEqual({
      fail: false,
      detail: '; the feature was deleted and listFeatures answers 200 again',
    });
  });
});
