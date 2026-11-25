/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * The 25 November 2026 Snapshots freeze (ADR 0042 amendment 2, ADR 0061 amendment 2), at Arkona's scale, against the
 * mock LegendKeeper (never fetched; nothing live).
 *
 * The owner's Arkona on 25 November 2026: about 1,500 pages, a nightly full snapshot and several hundred change
 * snapshots a day. This world is F6a.1's (`test/f6a1/world.ts`: 1,500 Authoritative pages under 20 categories, each with
 * a real-sized sidebar and Main document), its full snapshot taken through the real snapshot service, then `changes`
 * change snapshots (default 300) of one to three pages each, every one taken through the real service after an edit to
 * the pages' Main document in the mock (so each stores new objects, as an edit does), and, optionally, `extraFulls`
 * more nightly full snapshots (the full snapshot's manifest written again a day apart: what the retention keeps, about
 * 30 of them in steady state).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { scaleWorld, type ScaleWorld } from '../f6a1/world.js';
import { PROJECT } from '../tools/helpers.js';
import type { Manifest } from '../../src/snapshots/manifest.js';

export { gc, measure, type Sample } from '../f6a1/world.js';
export { PROJECT };

export interface SnapScaleWorld extends ScaleWorld {
  /** The pages, in the order seeded (ids `scp00000`…). */
  readonly pageIds: readonly string[];
  /** The change snapshots taken (ids). */
  readonly changeIds: readonly string[];
  /** The full snapshot's id. */
  readonly fullId: string;
}

const DAY = 86_400_000;

export async function snapScaleWorld(
  o: { readonly pages?: number; readonly changes?: number; readonly extraFulls?: number } = {},
): Promise<SnapScaleWorld> {
  const pages = o.pages ?? 1500;
  const s = await scaleWorld({ pages });
  const svc = s.w.stack.runtime.snapshots;
  const pageIds = Array.from({ length: pages }, (_, n) => `scp${n.toString(36).padStart(5, '0')}`);
  const full = svc.index.snapshots(PROJECT, { kind: 'full', limit: 1 })[0]!;
  const repo = s.w.repo;
  const changeIds: string[] = [];
  for (let i = 0; i < (o.changes ?? 300); i++) {
    const touched = [
      ...new Set([0, 1, 2].slice(0, 1 + (i % 3)).map((k) => pageIds[(i * 37 + k * 11) % pages]!)),
    ];
    for (const id of touched) {
      const main = repo.liveDocs(repo.live(id)!).find((d: any) => d.name === 'Main')!.id;
      const b = repo.blocks.get(main)!;
      (b.blocks[1] as any).content = [{ text: `Edit ${i} of ${id}: the tide gate opened at dawn.` }];
      b.version++;
    }
    const r = await svc.capturePages(PROJECT, touched, {
      trigger: { tool: 'write_page', principal: 'scale-test', job: `job_${i}` },
    });
    if (r.snapshotId) changeIds.push(r.snapshotId);
  }
  // The nightly full snapshots the retention keeps: the full manifest written again, a day apart, older than it.
  if (o.extraFulls) {
    const m = (await svc.manifest(full.id))!;
    for (let k = 1; k <= o.extraFulls; k++) {
      const at = (t: string) => new Date(Date.parse(t) - k * DAY).toISOString();
      const stamp = at(m.takenAt)
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const clone: Manifest = {
        ...m,
        id: `${stamp}-full-${(0xf00000 + k).toString(16)}`,
        takenAt: at(m.takenAt),
        startedAt: at(m.startedAt),
        pages: m.pages.map((p) => ({ ...p, ...(p.capturedAt ? { capturedAt: at(p.capturedAt) } : {}) })),
      };
      await svc.writeSnapshot(clone);
      await sleep(0);
    }
  }
  return { ...s, pageIds, changeIds, fullId: full.id };
}
