/**
 * RV3-3: verify marks every snapshot that uses a damaged object `partial`, permanently (resolveFindings never puts the
 * state back), and retention keeps a partial full snapshot only for the first 30 days and never protects it as "the
 * newest complete". Because of deduplication one bad object is shared by every full snapshot, so one damaged (or
 * later repaired) object makes retention delete all the weekly full snapshots, and, when the newest full is older than
 * 30 days, every full snapshot there is; the collector then removes their objects.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });
const DAY = 86_400_000;

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const age = (id: string, days: number) =>
  w!.stack.db.prepare('UPDATE snapshots SET taken_at = ? WHERE id = ?').run(Date.now() - days * DAY, id);

async function harbourResourceSha(snapshotId: string): Promise<string> {
  const m = (await w!.stack.runtime.snapshots.manifest(snapshotId))!;
  return m.pages.find((p) => p.id === S.harbour)!.resource!.sha256;
}

it('RV3-3a: a full snapshot whose shared object was damaged and then repaired is kept as a weekly snapshot', async () => {
  w = await snapshotsWorld();
  const snaps = w.stack.runtime.snapshots;
  const old = (await snaps.full(PROJECT, 'nightly')).snapshotId!;
  age(old, 45); // within the 8 weekly weeks: the only (so the latest) full snapshot of its ISO week
  const sha = await harbourResourceSha(old);
  writeFileSync(snaps.store.objectPath(sha), Buffer.from('bit rot'));
  await snaps.verify(); // the object is damaged: every snapshot using it becomes partial
  const fresh = (await snaps.full(PROJECT, 'nightly')).snapshotId!; // takes the same content: the object is repaired
  expect(await snaps.store.check(sha)).toBe('ok');
  const v = await snaps.verify();
  expect(v.missing + v.corrupt).toBe(0); // every piece checks out again
  expect(snaps.index.hasSnapshot(fresh)).toBe(true);
  await snaps.prune();
  // Safe: the 45-day-old weekly snapshot is whole again and must survive retention.
  expect(snaps.index.hasSnapshot(old)).toBe(true);
});

it('RV3-3b: one damaged object never makes retention delete every full snapshot', async () => {
  w = await snapshotsWorld();
  const snaps = w.stack.runtime.snapshots;
  // The only full snapshot, 40 days old (later nightly runs refused, say, for disk space).
  const only = (await snaps.full(PROJECT, 'nightly')).snapshotId!;
  age(only, 40);
  writeFileSync(snaps.store.objectPath(await harbourResourceSha(only)), Buffer.from('bit rot'));
  await snaps.verify();
  await snaps.prune();
  // Safe: the store still holds a full snapshot (1,499 good pages are better than none).
  expect(snaps.index.snapshots(PROJECT, { kind: 'full', limit: 10 }).length).toBeGreaterThan(0);
});
