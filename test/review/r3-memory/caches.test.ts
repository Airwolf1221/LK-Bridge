/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- introspection of private maps */
/**
 * CR-2026-11-R3, R3-65 (with the per-request retention, the two caches found growing without a bound in a long-running
 * bridge):
 *
 * - the snapshot store's `recent` objects (the collector's evidence that an object was just referred to) held an entry
 *   for every object put since the last collection: every piece of every full and change snapshot, unchanged ones
 *   included, for a day;
 * - the appraisal's asset-library cache kept every version of the asset library a snapshot took (one map per library
 *   hash, never emptied).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECENT_KEEP_MS, SnapshotStore } from '../../../src/snapshots/store.js';
import { appraisalWorld, type AppraisalWorld } from '../../appraisal/world.js';
import { PROJECT } from '../../tools/helpers.js';

let dir: string | null = null;
let w: AppraisalWorld | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
  await w?.close();
  w = null;
});

describe('R3-65: the snapshot store remembers recent puts for a bounded time', () => {
  it('a day of puts leaves only the last two hours in memory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lkb-r365-'));
    const store = new SnapshotStore(dir);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // A day of snapshots: 24 hours, 50 objects an hour.
    for (let h = 0; h < 24; h++)
      for (let i = 0; i < 50; i++) {
        await store.putBytes(Buffer.from(`hour ${h} object ${i}`), { compress: 'text' });
        now += 72_000;
      }
    const size = (store as any).recent.size as number;
    // On the reviewed code: 1,200 (every object put since the process started, until a collection asked).
    expect(size).toBeLessThanOrEqual(Math.ceil((RECENT_KEEP_MS + 120_000) / 72_000));
    // What the collector needs is still known: an object put within the hour.
    expect(store.recentlyPut(sha('hour 23 object 49'), 3_600_000, now)).toBe(true);
  });
});

/** The object name the store gives a text (its SHA-256), as putBytes computes it. */
const sha = (text: string): string => createHash('sha256').update(Buffer.from(text)).digest('hex');

describe('R3-65: the asset-library cache keeps the newest library of each project', () => {
  it('three versions of the library leave one in memory', async () => {
    w = await appraisalWorld();
    await w.snapshot();
    const rt: any = w.stack.runtime;
    const db = rt.appraisal.index.d.db;
    for (let v = 0; v < 3; v++) {
      const { sha256: sha } = await rt.snapshots.store.putBytes(
        Buffer.from(JSON.stringify({ assets: [{ id: `asset${v}`, sha256: `${v}`.repeat(64) }] })),
        { compress: 'text' },
      );
      db.prepare('UPDATE appraisal_index_state SET library_sha = ? WHERE project_id = ?').run(sha, PROJECT);
      await rt.appraisal.loadLibrary(PROJECT);
    }
    // On the reviewed code: 3 (one per library hash, never emptied).
    expect(rt.appraisal.libraryCache.size).toBe(1);
  });
});
