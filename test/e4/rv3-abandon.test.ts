/**
 * RV3-8: "Abandon" on the dashboard (SnapshotService.abandonRun) marks a run stopped and deletes its page rows, but a run
 * that is still going in this process does not notice: it reads the rest of the pages, takes the library, finds no page
 * entries (they were deleted) and writes a FULL manifest with no pages, indexed `complete`, and the run ends `succeeded`.
 * That empty snapshot is then "the newest complete full snapshot" (the one retention always keeps, the one a rehearsal or
 * an audit reads), and older full snapshots past 30 days lose that protection.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

it('RV3-8: abandoning a run in progress never yields a full snapshot (least of all an empty, complete one)', async () => {
  w = await snapshotsWorld();
  const snaps = w.stack.runtime.snapshots;
  const before = snaps.index.snapshots(PROJECT, { kind: 'full', limit: 10 }).length;
  let abandoned = false;
  (snaps.o as { afterPage?: unknown }).afterPage = (runId: string) => {
    if (abandoned) return;
    abandoned = true;
    // The owner presses "Abandon" on the Snapshots page while the nightly run is part-way.
    expect(snaps.abandonRun(runId)).toBe(true);
  };
  let outcome: unknown;
  try {
    outcome = await snaps.full(PROJECT, 'nightly');
  } catch (e) {
    outcome = e;
  }
  (snaps.o as { afterPage?: unknown }).afterPage = undefined;
  expect(abandoned).toBe(true);
  const fulls = snaps.index.snapshots(PROJECT, { kind: 'full', limit: 10 });
  // Safe: nothing was indexed as a full snapshot by the abandoned run.
  expect(
    fulls.map((f) => ({ id: f.id, state: f.state, pages: f.pages })),
    JSON.stringify(outcome),
  ).toHaveLength(before);
});
