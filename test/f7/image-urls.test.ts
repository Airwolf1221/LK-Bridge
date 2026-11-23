/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F7 (ADR 0070, G11): a new image's URL in Markdown is checked against the project's image assets (the asset
 * tree), matched on the asset's exact `url`, in both forms LegendKeeper has used; a miss is looked up live ONCE
 * (G9) before it is refused with IMAGE_URL_REFUSED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C, packWorld, type PackWorld } from '../packs/world.js';
import { assetIdsFromUrl } from '../../src/assets/service.js';
import { markdownImageUrls } from '../../src/pages/index.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
});
afterAll(async () => {
  await w?.close();
});

const getAssetCalls = () => w.seen.filter((l) => /^GET \/assets\/[^/?]+$/.test(l));
const append = (url: string) =>
  w.call('write_page', {
    page: C.nadira,
    mode: 'append',
    markdown: `![A portrait](${url})\n`,
    project: 'test',
    dryRun: true,
  });

describe('G11: the image URL check', () => {
  it('helpers: the URL forms and the Markdown image syntax', () => {
    expect(assetIdsFromUrl('https://assets.legendkeeper.com/proj1_0b6f7f0e-uuid.webp')).toEqual([
      '0b6f7f0e-uuid',
      'proj1_0b6f7f0e-uuid',
    ]);
    expect(assetIdsFromUrl('https://assets.legendkeeper.com/0b6f7f0e-uuid.webp')).toEqual(['0b6f7f0e-uuid']);
    expect(assetIdsFromUrl('http://assets.legendkeeper.com/x.webp')).toEqual([]);
    expect(
      markdownImageUrls('Text ![a](https://x/1.webp) and ![b c](<https://x/2.webp>) ![a](https://x/1.webp)'),
    ).toEqual(['https://x/1.webp', 'https://x/2.webp']);
  });

  it('both URL forms of a project asset are accepted (looked up live once, then from the tree)', async () => {
    const newer = w.assets.image('F7 newer form', null, {
      id: 'f7uuid0000000001',
      url: 'https://assets.legendkeeper.com/proj_mock_f7uuid0000000001.webp',
    });
    const older = w.assets.image('F7 older form', null, {
      id: 'f7uuid0000000002',
      url: 'https://assets.legendkeeper.com/f7uuid0000000002.webp',
    });
    for (const id of [newer, older]) {
      const url = w.assets.assets.get(id)!.url!;
      const before = getAssetCalls().length;
      const r = await append(url);
      expect(r.isError, r.text).toBe(false);
      expect(JSON.stringify(r.body)).not.toContain('IMAGE_URL_UNCHECKED');
      expect(getAssetCalls().length).toBeGreaterThan(before); // the tree did not hold it: one live look-up
      const again = getAssetCalls().length;
      const r2 = await append(url);
      expect(r2.isError, r2.text).toBe(false);
      expect(getAssetCalls().length).toBe(again); // now in the tree: no request
    }
  });

  it('a stale tree plus a fresh upload: accepted after the one live look-up', async () => {
    // Uploaded in LegendKeeper after the tree was last read: the tree has never seen it.
    const id = w.assets.image('F7 fresh upload', null, { id: 'f7fresh000000001' });
    const r = await append(w.assets.assets.get(id)!.url!);
    expect(r.isError, r.text).toBe(false);
  });

  it('a foreign URL is refused after one refresh, IMAGE_URL_REFUSED', async () => {
    const before = getAssetCalls().length;
    const r = await append('https://assets.legendkeeper.com/otherproject_f7foreign0000001.webp');
    expect(r.isError).toBe(true);
    expect(r.body.error?.code ?? r.body.code, r.text).toBe('IMAGE_URL_REFUSED');
    const made = getAssetCalls().length - before;
    expect(made).toBeGreaterThan(0); // looked up live once (each id the URL may name) …
    expect(made).toBeLessThanOrEqual(2); // … and no more
    const elsewhere = await append('https://images.example.org/portrait.webp');
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.body.error?.code ?? elsewhere.body.code).toBe('IMAGE_URL_REFUSED');
  });
});
