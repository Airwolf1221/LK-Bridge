/**
 * RV3-1: a full snapshot's pieces are indexed at the moment the RUN finished (the manifest's takenAt), not when each page
 * was read. A bridge write made to a page after the run read it, but before the run finished, is then "older" than the
 * full snapshot's stale copy, so the state at any later snapshot is taken from the stale copy, and a restore to that
 * later snapshot silently reverts the write.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('RV3-1: a write made while a full snapshot runs is not reverted by a restore to a later snapshot', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snaps = w.stack.runtime.snapshots;
  let wrote = false;
  // The nightly run reads the Atlas, then (later pages still to go) an agent rewrites its Main document.
  (snaps.o as { afterPage?: unknown }).afterPage = async (_run: string, pageId: string) => {
    if (pageId !== S.atlas || wrote) return;
    wrote = true;
    const r = await call('write_page', {
      page: S.atlas,
      mode: 'append',
      markdown: 'Written during the run.',
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    await snaps.settled();
    await sleep(20);
  };
  const full = await snaps.full(PROJECT, 'nightly');
  (snaps.o as { afterPage?: unknown }).afterPage = undefined;
  expect(wrote).toBe(true);
  expect(full.snapshotId).toBeDefined();
  await sleep(20);
  // Later, a sidebar-only change: its change snapshot takes the sidebar, not the Main document.
  const f = await call('set_facts', {
    page: S.atlas,
    facts: { Scope: 'Every document type, and a little more' },
  });
  expect(f.isError, JSON.stringify(f.body)).toBe(false);
  await snaps.settled();
  const later = snaps.index.snapshots(PROJECT, { kind: 'change', limit: 5 })[0]!;
  expect(later.takenAt).toBeGreaterThan(snaps.index.snapshot(full.snapshotId!)!.takenAt);

  // At `later`, Main held "Written during the run." (it is still there now): restoring Main to `later` changes nothing.
  const dry = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: later.id,
    scope: 'document',
    document: 'Main',
    dryRun: true,
  });
  expect(JSON.stringify(dry.body.changes ?? dry.body)).not.toMatch(/-\s*Written during the run\./);
  expect(dry.body.status, JSON.stringify(dry.body)).toBe('nothing_to_do');
});
