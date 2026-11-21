/**
 * R4.1 (the owner's run of 21 November 2026: consistency-f4b hung for its whole 30-minute timeout on a full snapshot of
 * the test world, about 1,500 pages at the governor's rate). A sandbox check that reads through the snapshots (the
 * consistency check, the chapter tools, the audits) snapshots only the pages it made, never the test world.
 *
 * The readers are built on a full snapshot with change snapshots laid over it (the appraisal index, the audits' model),
 * so the check's TEMPORARY database (`createSoakRuntime`'s, never the bridge's) gets an EMPTY base first (no page;
 * written only while it holds no full snapshot at all), then one change snapshot of the given pages
 * (`SnapshotService.capturePages`, every piece of each, read now), which the readers lay over it.
 */
import type { SoakRuntime } from './soak.js';

export async function snapshotPagesOnly(
  sb: SoakRuntime,
  pageIds: readonly string[],
  check: string,
): Promise<string> {
  const rt = sb.runtime;
  const pid = sb.projectId;
  const snaps = rt.snapshots;
  const started = Date.now();
  if (snaps.index.snapshots(pid, { kind: 'full', limit: 1 }).length === 0) {
    const base = snaps.buildManifest({
      projectId: pid,
      kind: 'full',
      startedAt: started,
      rootId: rt.tree.queries.root(pid).data?.id ?? null,
      trigger: {
        check,
        note: 'an empty base for the check’s own pages (no page; the temporary database only)',
      },
      pages: [],
      library: null,
      counts: { reads: 0, downloads: 0, newObjects: 0, newBytes: 0 },
    });
    await snaps.writeSnapshot(base);
    // The change snapshot must be taken after its base (the readers lay changes over a base by time).
    while (Date.now() <= started) await new Promise((r) => setTimeout(r, 2));
  }
  const r = await snaps.capturePages(pid, pageIds, { trigger: { check, note: 'the check’s own pages' } });
  if (!r.snapshotId) throw new Error(`the check’s pages were not snapshotted: ${r.summary}`);
  return r.summary;
}
