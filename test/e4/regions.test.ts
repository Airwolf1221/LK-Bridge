/**
 * v2 E4 (backlog 4; the D2 sandbox's M6d, INCONCLUSIVE): LegendKeeper keeps a region's `polygon` beside `polygons`.
 * Until the sandbox probe M6e says how to clear it, read_document and the snapshots say when a region carries both, and
 * the bridge writes one consistent form (polygon = the first of polygons; the map dry run's M6d checks the write).
 */
import { describe, expect, it } from 'vitest';
import { bothFormsNote, holds, regionsWithBothForms } from '../../src/maps/features.js';

const tri = (d: number): [number, number][] => [
  [d, d],
  [d, d + 1],
  [d + 1, d + 1],
];

describe('regions with both geometry fields', () => {
  it('are found and named; a region with one field, or a pin, is not', () => {
    const features = [
      { id: 'r1', type: 'region', name: 'Both', polygon: tri(0), polygons: [tri(5), tri(9)] },
      { id: 'r2', type: 'region', name: 'One', polygons: [tri(1)] },
      { id: 'r3', type: 'region', name: 'Single', polygon: tri(2), polygons: [] },
      { id: 'p1', type: 'pin', name: 'Pin', pos: [1, 1] },
    ];
    expect(regionsWithBothForms(features)).toEqual([
      { id: 'r1', name: 'Both', polygonPoints: 3, polygons: 2 },
    ]);
    expect(bothFormsNote(features)).toMatch(
      /1 region\(s\) carry both.*“Both”: polygon of 3 points, 2 polygon\(s\)/,
    );
    expect(bothFormsNote(features.slice(1))).toBeNull();
  });

  it('the verify compares a mirrored polygon as it is, beside the polygons', () => {
    const stored = { type: 'region', polygon: tri(5), polygons: [tri(5), tri(9)] };
    expect(holds(stored, { polygons: [tri(5), tri(9)], polygon: tri(5) })).toEqual([]);
    expect(holds(stored, { polygons: [tri(5), tri(9)], polygon: tri(0) })).toHaveLength(1);
  });
});
