/**
 * RV3-7: "the state at a snapshot" (src/snapshots/restore.ts stateAt/documentsAt) falls back to the newest earlier row
 * when the snapshot has none, which is right for a change snapshot ("not taken") but wrong for a full one, whose
 * manifest lists every document the page had: a document missing from a full snapshot did not exist then. A page
 * restore (and a recreate) to that full snapshot brings back, or overwrites, a document from an OLDER snapshot.
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

it('RV3-7: a document absent from a full snapshot is left alone by a page restore to it', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snaps = w.stack.runtime.snapshots;
  await snaps.full(PROJECT, 'nightly'); // F1: the Atlas has Notes
  const notes = w.repo.docs.get(w.d.notes)! as unknown as { deletedAt: string | null; name: string };
  notes.deletedAt = new Date().toISOString(); // deleted in the app
  await new Promise((r) => setTimeout(r, 15));
  const f2 = (await snaps.full(PROJECT, 'nightly')).snapshotId!; // F2: no Notes
  const m2 = (await snaps.manifest(f2))!;
  expect(m2.pages.find((p) => p.id === S.atlas)!.documents!.map((d) => d.id)).not.toContain(w.d.notes);
  // Later the owner brings Notes back in the app and renames it.
  notes.deletedAt = null;
  notes.name = 'Field notes';
  const dry = await call('restore_snapshot', { page: S.atlas, snapshot: f2, scope: 'page', dryRun: true });
  // Safe: at F2 the page had no such document, so the restore leaves it as it is (it does not rename it to "Notes").
  expect(JSON.stringify(dry.body.changes ?? [])).not.toMatch(/Notes \(blank\)/);
  expect(dry.body.status, JSON.stringify(dry.body)).toBe('nothing_to_do');
});
