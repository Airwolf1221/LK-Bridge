 
/**
 * v3 F7 (ADR 0070, G11): a new image's URL in Markdown is checked against the project's image assets (the asset tree),
 * matched on the asset's exact `url`, in both forms LegendKeeper uses. An asset's id cannot be derived from its URL (the
 * review's live evidence, 23 November 2026; the mock's URLs are as unrelated): on a miss the project's whole asset
 * listing is read LIVE once, at most once every five minutes per project; within that window the refusal says when it
 * was read and when to retry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C, packWorld, type PackWorld } from '../packs/world.js';
import { PROJECT } from '../tools/helpers.js';
import { URL_REFRESH_MS } from '../../src/assets/service.js';
import { markdownImageUrls } from '../../src/pages/index.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
});
afterAll(async () => {
  await w?.close();
});

/** The listings the mock answered (the full live listing walks every folder, a page at a time). */
const listings = () => w.seen.filter((l) => /^GET \/assets(\?|$)/.test(l)).length;
const append = (url: string) =>
  w.call('write_page', {
    page: C.nadira,
    mode: 'append',
    markdown: `![A portrait](${url})\n`,
    project: 'test',
    dryRun: true,
  });
/** The throttle as if its window had passed (the service's clock is the system's). */
const expireThrottle = () =>
  (w.stack.runtime.assets as unknown as { urlListedAt: Map<string, number> }).urlListedAt.set(
    PROJECT,
    Date.now() - URL_REFRESH_MS - 1,
  );
const codeOf = (r: { body: Record<string, unknown> }): unknown =>
  (r.body.error as { code?: unknown } | undefined)?.code ?? r.body.code;

describe('G11: the image URL check', () => {
  it('the Markdown image syntax', () => {
    expect(
      markdownImageUrls('Text ![a](https://x/1.webp) and ![b c](<https://x/2.webp>) ![a](https://x/1.webp)'),
    ).toEqual(['https://x/1.webp', 'https://x/2.webp']);
  });

  it('both URL forms, whose uuid is not the asset id: a miss, one full live listing, then accepted (then from the tree)', async () => {
    const folder = w.assets.folder('F7 url probe');
    // The two assets of the review's evidence: ids that appear nowhere in their URLs.
    w.assets.image('Older form', folder, {
      id: 'pr796386prg9780dhbcvhyyd',
      url: 'https://assets.legendkeeper.com/64b8054d-5986-4027-bfb2-8acc55c23035.webp',
    });
    w.assets.image('Newer form', folder, {
      id: 'rzgwr8y9yan0dxmmzbnjttv6',
      url: 'https://assets.legendkeeper.com/cmretrj150aph43prgyxsdbsn_5aa52e7d-b052-48b2-a5f6-566a113b391f.webp',
    });
    const before = listings();
    const older = await append('https://assets.legendkeeper.com/64b8054d-5986-4027-bfb2-8acc55c23035.webp');
    expect(older.isError, older.text).toBe(false);
    expect(JSON.stringify(older.body)).not.toContain('IMAGE_URL_UNCHECKED');
    expect(listings()).toBeGreaterThan(before); // the whole listing, read live
    const after = listings();
    // The newer form was found by the same listing: from the tree now, nothing read.
    const newer = await append(
      'https://assets.legendkeeper.com/cmretrj150aph43prgyxsdbsn_5aa52e7d-b052-48b2-a5f6-566a113b391f.webp',
    );
    expect(newer.isError, newer.text).toBe(false);
    expect(listings()).toBe(after);
    // No getAsset by a guessed id was ever sent.
    expect(w.seen.some((l) => /GET \/assets\/(64b8054d|5aa52e7d|cmretrj)/.test(l))).toBe(false);
  });

  it('within five minutes a miss is refused at once, saying when the listing was read and when to retry', async () => {
    const before = listings();
    const r = await append('https://assets.legendkeeper.com/9f0e8d7c-0000-4000-8000-000000000001.webp');
    expect(r.isError).toBe(true);
    expect(codeOf(r), r.text).toBe('IMAGE_URL_REFUSED');
    expect(r.text).toMatch(
      /asset listing was read live at \d{4}-\d\d-\d\dT[^;]+; .*retry after \d{4}-\d\d-\d\dT/,
    );
    expect(listings()).toBe(before); // nothing read
  });

  it('a stale tree plus a fresh upload: after the window, the miss reads the listing again and is accepted', async () => {
    const id = w.assets.image('F7 fresh upload', null);
    const url = w.assets.assets.get(id)!.url!;
    expect(url).not.toContain(id);
    expireThrottle();
    const before = listings();
    const r = await append(url);
    expect(r.isError, r.text).toBe(false);
    expect(listings()).toBeGreaterThan(before);
  });

  it('still missing after the live listing: refused, IMAGE_URL_REFUSED', async () => {
    expireThrottle();
    const before = listings();
    const r = await append(
      'https://assets.legendkeeper.com/otherproject_9f0e8d7c-0000-4000-8000-000000000002.webp',
    );
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('IMAGE_URL_REFUSED');
    expect(r.text).toMatch(/read live just now/);
    expect(listings()).toBeGreaterThan(before);
    // A URL off LegendKeeper's hosts is refused the same way.
    const elsewhere = await append('https://images.example.org/portrait.webp');
    expect(codeOf(elsewhere)).toBe('IMAGE_URL_REFUSED');
  });
});
