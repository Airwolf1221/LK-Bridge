/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7c (ADR 0075, Z5, Z6) with CR-2026-11-R3's memory rule: an archive's lifetime and pinning, and memory.
 *
 * - A held entry an art proposal waits for is pinned: past the staging expiry, its archive keeps its server copy and
 *   the entry stays held; an unreferenced archive past it loses its copy (its unfinished entries discarded).
 * - Discarding an archive removes its server copy and discards its unfinished entries; staged images stay staged.
 * - Repeated archives (listed, staged, discarded) return the heap to its baseline.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownersWorld, PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { drain, uploadZip } from './helpers.js';
import { tinyImage, zip } from './zip.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const DAY = 86_400_000;
const archives = () => w.stack.runtime.images.archives;
const pngs = async (names: readonly string[]) =>
  zip(await Promise.all(names.map(async (name) => ({ name, data: await tinyImage('png') }))));
const age = (archiveId: string, days: number) =>
  w.stack.db
    .prepare('UPDATE image_archives SET last_activity_at = ? WHERE id = ?')
    .run(Date.now() - days * DAY, archiveId);

describe('Z5, Z6: pinning, expiry and discard', () => {
  it('a held entry an art proposal waits for never expires; an unreferenced archive does', async () => {
    const svc = w.stack.runtime.images;
    const settings = svc.settings.images as { stagedMaxBytes: number };
    const cap = settings.stagedMaxBytes;
    settings.stagedMaxBytes = svc.stagingRoom().used;
    try {
      const pinned = await uploadZip(w, w.call, await pngs(['pin.png']));
      const loose = await uploadZip(w, w.call, await pngs(['loose.png']));
      const p = await w.call('arkona_add_character_art', {
        character: 'Nadira al-Khalid',
        project: 'test',
        images: [
          {
            archive: { id: pinned.body.archive_id, entry: 'pin.png' },
            label: 'Primary Reference - Pinned',
            interpretation: 'What the pinned image establishes.',
          },
        ],
      });
      expect(p.body.status, p.text).toBe('proposal_captured');
      await drain(w);
      expect(archives().store.entries(pinned.body.archive_id)[0]!.status).toBe('held');
      const days = svc.stagingMaxDays(PROJECT) + 5;
      age(pinned.body.archive_id, days);
      age(loose.body.archive_id, days);
      await archives().sweep();
      const a = archives().store.archive(pinned.body.archive_id)!;
      expect(a.serverFile).not.toBeNull();
      expect(existsSync(join(archives().dir, a.serverFile!))).toBe(true);
      expect(archives().store.entries(a.id)[0]!.status).toBe('held');
      const b = archives().store.archive(loose.body.archive_id)!;
      expect(b.state).toBe('expired');
      expect(b.serverFile).toBeNull();
      expect(archives().store.entries(b.id)[0]!).toMatchObject({
        status: 'discarded',
        reasonCode: 'ARCHIVE_EXPIRED',
      });
      // Once the proposal is rejected, nothing waits for the entry: it may expire too.
      w.stack.runtime.policy.commands.reject('owner', String(p.body.proposalId), 'test');
      await archives().sweep();
      expect(archives().store.archive(a.id)!.state).toBe('expired');
    } finally {
      settings.stagedMaxBytes = cap;
    }
  });

  it('discarding an archive removes its copy and its unfinished entries; staged images stay', async () => {
    const bytes = await pngs(['s1.png', 's2.png']);
    const r = await uploadZip(w, w.call, bytes);
    archives().request(r.body.archive_id, [archives().store.entries(r.body.archive_id)[0]!.seq]);
    await drain(w);
    const [s1, s2] = archives().store.entries(r.body.archive_id);
    expect(s1!.status).toBe('staged');
    expect(s2!.status).toBe('listed');
    const file = archives().store.archive(r.body.archive_id)!.serverFile!;
    await archives().discard(r.body.archive_id, 'owner');
    expect(existsSync(join(archives().dir, file))).toBe(false);
    expect(archives().store.entries(r.body.archive_id)[1]!.status).toBe('discarded');
    expect(w.stack.runtime.images.store.upload(PROJECT, s1!.stagedId!)!.staged).toBe(true);
    // Uploading the same zip again brings it back under the same id: the discarded entry is listed again.
    const again = await uploadZip(w, w.call, bytes);
    expect(again.body.archive_id).toBe(r.body.archive_id);
    expect(again.body.state).toBe('open');
    expect(
      archives()
        .store.entries(r.body.archive_id)
        .map((e) => e.status),
    ).toEqual(['staged', 'listed']);
  });
});

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapMb = async (): Promise<number> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / 1048576;
};

describe('memory', () => {
  it('repeated archives (listed, staged, discarded) return to their baseline', async () => {
    const round = async (i: number) => {
      const bytes = zip(
        await Promise.all(
          Array.from({ length: 12 }, async (_, k) => ({
            name: `m${i}/img-${k}.png`,
            data: await tinyImage('png', 96),
          })),
        ),
      );
      const r = await uploadZip(w, w.call, bytes, { stageAll: true });
      expect(r.isError, r.text).toBe(false);
      await drain(w);
      const svc = w.stack.runtime.images;
      for (const e of archives().store.entries(r.body.archive_id)) {
        const row = svc.store.upload(PROJECT, e.stagedId!)!;
        await svc.discard({ projectId: PROJECT, row, origin: { kind: 'ui', tool: 'test' }, by: 'owner' });
      }
      await archives().discard(r.body.archive_id, 'owner');
    };
    for (let i = 0; i < 2; i++) await round(i);
    const base = await heapMb();
    for (let i = 2; i < 12; i++) await round(i);
    const after = await heapMb();
    console.info(
      `[F7c] archives: heap ${base.toFixed(1)} MB after 2 rounds, ${after.toFixed(1)} MB after 12`,
    );
    expect(after - base).toBeLessThan(8);
  });
});
