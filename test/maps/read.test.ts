/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * read_document on a map (v2 D2, ADR 0040): each feature's type, name, position and link as before, and when the map has
 * an image the map's width, height and bounds in the header and every position in pixels beside its lat/lng (a region's
 * and path's points too: listed when short, summarised when long unless detail "full"); a legacy tiled map and a map with
 * no image say so and give no pixels. The pixel positions are the ones create_map_feature takes.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapsWorld, type MapsWorld } from './world.js';

let w: MapsWorld;
let client: Client;
const read = (document: string, more: Record<string, unknown> = {}) =>
  w.stack.call(client, 'read_document', { project: 'test', resource: 'Atlas of Arkona', document, ...more });
const line = (md: string, name: string) => md.split('\n').find((l) => l.includes(`**${name}**`))!;

beforeAll(async () => {
  w = await mapsWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('a map with an image', () => {
  it('shows the frame in the header and every position in pixels beside its lat/lng', async () => {
    const before = w.seen.length;
    const r = await read('Arkona map');
    expect(r.isError, r.text).toBe(false);
    expect(w.seen.slice(before).filter((l) => l.startsWith('GET'))).toHaveLength(2); // the document's settings, the features
    expect(r.body.map).toEqual({
      image: 'single',
      width: 2048,
      height: 1024,
      bounds: [
        [-128, 0],
        [0, 256],
      ],
      assetId: w.assetIds['Arkona 2048x1024'],
    });
    const md = r.body.markdown as string;
    expect(md).toContain('# Map: Arkona map');
    expect(md).toContain(
      'Image: 2048×1024 pixels; bounds [[-128, 0], [0, 256]] as [[south, west], [north, east]].',
    );
    expect(md).toContain('top-left corner');
    // a pin: type, name, position in both systems and its link
    expect(line(md, 'Torii Gate')).toBe(
      `  - **Torii Gate** (pin) at (-32, 64), pixel (512, 256) → [link](lk://resources/miyabi01)`,
    );
    expect(line(md, 'Arkona')).toContain('(label) at (-6.25, 128), pixel (1024, 50)');
    expect(line(md, 'Secret')).toContain('(hidden)');
    // folders nest
    expect(md).toContain('- **Shrines** (folder)');
    expect(md).toContain('    - **Frost Altar** (pin)');
  });

  it('lists a short region’s or path’s points in pixels, and summarises a long one', async () => {
    const md = (await read('Arkona map')).body.markdown as string;
    expect(line(md, 'Qishen lands')).toBe(
      '- **Qishen lands** (region) around (-43.75, 50), 4 points: pixels (200, 200) (600, 200) (600, 500) (200, 500)',
    );
    // 7 points: the pixel box, and how to see them all
    expect(line(md, 'Old Road')).toContain(
      '7 points, pixel box (100, 100) to (2000, 900) (detail "full" lists every point)',
    );
    expect(line(md, 'Old Road')).not.toContain('pixels (');
    // two polygons, 7 points in all
    expect(line(md, 'Weeping Sea')).toContain('pixel box (1200, 100) to (1800, 900)');
  });

  it('lists every point with detail "full"', async () => {
    const md = (await read('Arkona map', { detail: 'full' })).body.markdown as string;
    expect(line(md, 'Old Road')).toContain(
      'pixels (100, 900) (400, 700) (800, 650) (1200, 600) (1600, 300) (1900, 200) (2000, 100)',
    );
    expect(line(md, 'Weeping Sea')).toContain(
      '[(1200, 100) (1800, 100) (1800, 300)] [(1200, 700) (1800, 700) (1500, 900) (1300, 900)]',
    );
  });

  it('gives positions create_map_feature takes back exactly (a round trip through the tools)', async () => {
    const made = await w.stack.call(client, 'create_map_feature', {
      project: 'test',
      page: 'Atlas of Arkona',
      document: 'Arkona map',
      type: 'pin',
      name: 'Round Trip',
      pixel: { x: 777, y: 333 },
    });
    expect(made.body.status, made.text).toBe('written');
    expect(line((await read('Arkona map')).body.markdown, 'Round Trip')).toContain('pixel (777, 333)');
  });

  it('keeps the JSON form as it was (the features), with the frame in the header', async () => {
    const r = await read('Arkona map', { format: 'json' });
    expect(r.body.format).toBe('json');
    expect(Array.isArray(r.body.content.data)).toBe(true);
    expect(r.body.map.width).toBe(2048);
  });
});

describe('a feature moved to the top level', () => {
  it('reads with parentId "" (the real API’s answer after a move) as at the top level, never under a folder', async () => {
    const live = w.liveFeatures(w.md.map);
    live.find((f) => f.id === w.f['Frost Altar'])!.parentId = ''; // as LegendKeeper reads one back after a move
    const r = await read('Arkona map');
    expect(r.isError, r.text).toBe(false);
    const md = r.body.markdown as string;
    expect(line(md, 'Frost Altar').startsWith('- **Frost Altar**')).toBe(true);
    // it is no longer listed under North, and North still lists nothing else
    const north = md.split('\n').findIndex((l) => l.includes('**North**'));
    expect(md.split('\n')[north + 1] ?? '').not.toContain('Frost Altar');
    // a feature created at the top level (no field) is listed alongside it
    expect(line(md, 'Qishen lands').startsWith('- **Qishen lands**')).toBe(true);
  });
});

describe('legacy tiled maps and maps with no image', () => {
  it('say so, and show lat/lng only', async () => {
    const legacy = await read('Old tiled map');
    expect(legacy.body.map.image).toMatch(/legacy tiled map/);
    expect(legacy.body.map.width).toBeUndefined();
    expect(legacy.body.markdown).toContain(
      'Legacy tiled map: no single image, so no pixel positions; use lat/lng.',
    );
    expect(legacy.body.markdown).not.toContain('pixel (');
    const framed = await read('Tiled with a frame'); // a legacy map that still reports a frame: still no pixels
    expect(framed.body.markdown).not.toContain('pixel (');
    const none = await read('Unpainted map');
    expect(none.body.map).toEqual({ image: 'none' });
    expect(none.body.markdown).toContain('The map has no image yet, so no pixel positions.');
  });

  it('shows lat/lng for a feature on a legacy map as before', async () => {
    const c = await w.stack.call(client, 'create_map_feature', {
      project: 'test',
      page: 'Atlas of Arkona',
      document: 'Old tiled map',
      type: 'pin',
      name: 'Tiled',
      latlng: [10, 20],
    });
    expect(c.body.status, c.text).toBe('written');
    expect(line((await read('Old tiled map')).body.markdown, 'Tiled')).toBe('- **Tiled** (pin) at (10, 20)');
  });
});

describe('detail on other documents', () => {
  it('is ignored for a page', async () => {
    const r = await read('Main', { detail: 'full' });
    expect(r.isError, r.text).toBe(false);
  });
});
