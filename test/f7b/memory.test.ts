/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F7b (ADR 0071, D6) with CR-2026-11-R3's memory rule, as F5c's memory test: repeated `arkona_get_art` calls (inline
 * from the cache, fresh downloads that fill it, links, a character's live folder read) come back to their baseline. The
 * cache keeps derivatives on disk, never in memory: nothing a call makes is kept beyond the call.
 */
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { artWorld, CHARACTER, noise, type ArtWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapMb = async (): Promise<number> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / 1048576;
};

let w: ArtWorld;
beforeAll(async () => {
  w = await artWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

describe('memory', () => {
  it('repeated inline, cached and link calls return to their baseline', async () => {
    const big = await noise(1200, 900, 77);
    const round = async (i: number) => {
      // A fresh image each round: downloaded, resized and cached (about 1 MB of pixels decoded each time).
      const fresh = w.addImage(`Memory ${i}`, null, big, `f7b-mem-${i}-${randomUUID()}`);
      await w.syncTree();
      const a = await w.getArt({ asset: [fresh.id], delivery: 'inline' });
      expect(a.isError, a.text).toBe(false);
      expect(a.body.images[0].inline.ok).toBe(true);
      const b = await w.getArt({ asset: [fresh.id, w.ids.design, w.ids.robeBack], delivery: 'both' });
      expect(b.body.images[0].inline.cached).toBe(true);
      const c = await w.getArt({ character: CHARACTER, delivery: 'link' });
      expect(c.isError, c.text).toBe(false);
    };
    for (let i = 0; i < 2; i++) await round(i);
    const base = await heapMb();
    for (let i = 2; i < 12; i++) await round(i);
    const after = await heapMb();
    console.info(
      `[F7b] get_art inline, cached and link: heap ${base.toFixed(1)} MB after 2 rounds, ${after.toFixed(1)} MB after 12`,
    );
    expect(after - base).toBeLessThan(8);
  });
});
