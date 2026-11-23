/**
 * v3 F7b (ADR 0071, D6): the art cache. Content-addressed (asset id + URL + size parameters: a changed URL is another
 * entry), bounded, the least recently used entries evicted first at the cap; a hit touches its entry; the directory
 * defaults beside the database.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtCache, artCacheDir, cacheKey } from '../../src/art/view/cache.js';

const meta = (assetId: string, url: string) => ({
  assetId,
  url,
  format: 'webp' as const,
  mimeType: 'image/webp' as const,
  width: 10,
  height: 10,
  quality: 82,
  source: { format: 'webp', width: 10, height: 10, bytes: 100, hasAlpha: false },
  overTarget: false,
});

const fresh = (max: number) => {
  let t = 1_700_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'lkb-art-cache-test-'));
  const clock = { now: () => t, tick: (ms = 1000) => (t += ms) };
  return { cache: new ArtCache(dir, max, () => clock.now()), dir, clock };
};

describe('the art cache', () => {
  it('stores and returns a derivative by asset id and URL; another URL is another key', async () => {
    const { cache } = fresh(10_000);
    expect(await cache.get('a1', 'https://assets.legendkeeper.com/x.webp')).toBeNull();
    expect(await cache.put(meta('a1', 'https://assets.legendkeeper.com/x.webp'), Buffer.alloc(50, 1))).toBe(
      true,
    );
    const hit = await cache.get('a1', 'https://assets.legendkeeper.com/x.webp');
    expect(hit?.bytes.length).toBe(50);
    expect(hit?.meta).toMatchObject({ assetId: 'a1', bytes: 50, format: 'webp' });
    // A changed URL (the asset's file replaced) is not served the old derivative.
    expect(await cache.get('a1', 'https://assets.legendkeeper.com/y.webp')).toBeNull();
    expect(cacheKey('a1', 'https://assets.legendkeeper.com/x.webp')).not.toBe(
      cacheKey('a1', 'https://assets.legendkeeper.com/y.webp'),
    );
    expect(cacheKey('a1', 'u')).not.toBe(cacheKey('a2', 'u'));
  });

  it('evicts the least recently used entries once the cap is passed (a hit counts as a use)', async () => {
    const { cache, clock, dir } = fresh(250);
    for (const id of ['a', 'b', 'c']) {
      await cache.put(meta(id, `u-${id}`), Buffer.alloc(100, 2));
      clock.tick();
    }
    // a: 300 > 250 after c, so the oldest (a) went.
    expect(await cache.get('a', 'u-a')).toBeNull();
    expect(await cache.size()).toBe(200);
    // b is used now; d arrives: c (now the least recently used) goes, b stays.
    clock.tick();
    expect(await cache.get('b', 'u-b')).not.toBeNull();
    clock.tick();
    await cache.put(meta('d', 'u-d'), Buffer.alloc(100, 3));
    expect(await cache.get('c', 'u-c')).toBeNull();
    expect(await cache.get('b', 'u-b')).not.toBeNull();
    expect(await cache.get('d', 'u-d')).not.toBeNull();
    expect(await cache.size()).toBeLessThanOrEqual(250);
    // Each entry is its bytes and its description; no temporary file is left behind.
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.endsWith('.bin'))).toHaveLength(2);
  });

  it('never stores a derivative larger than the whole cap, and a write that cannot be made is not an error', async () => {
    const { cache } = fresh(10);
    expect(await cache.put(meta('big', 'u'), Buffer.alloc(11))).toBe(false);
    const file = join(mkdtempSync(join(tmpdir(), 'lkb-art-cache-file-')), 'a-file');
    writeFileSync(file, 'not a directory');
    const bad = new ArtCache(join(file, 'art'), 1000);
    expect(await bad.put(meta('x', 'u'), Buffer.alloc(5))).toBe(false);
    expect(await bad.get('x', 'u')).toBeNull();
  });

  it('lives in ART_CACHE_DIR, else art-cache beside the database, else a private temporary directory', () => {
    expect(artCacheDir('/srv/art', '/var/lib/lk-bridge/bridge.db')).toBe('/srv/art');
    expect(artCacheDir(null, '/var/lib/lk-bridge/bridge.db')).toBe('/var/lib/lk-bridge/art-cache');
    const a = artCacheDir(null, ':memory:');
    const b = artCacheDir(null, ':memory:');
    expect(a).not.toBe(b);
  });
});
