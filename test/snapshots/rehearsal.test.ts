/**
 * v2 E1a (ADR 0042): the restore rehearsal: a snapshot of another project restored into a throwaway root of a sandbox
 * project, compared, then deleted. Sampled and full; exact comparisons; differences explained; never a write outside its
 * root; refused into the project the snapshot came from, and into a project that is not a sandbox.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import type { Manifest } from '../../src/snapshots/index.js';
import { choosePages } from '../../src/snapshots/rehearsal.js';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const SOURCE = 'proj_arkona';

/** As the owner marks a project as a sandbox (Projects page): the stored flag, then the registry reads it again. */
function sandbox(on: boolean): void {
  new ProjectStore(w!.stack.db).setSandbox(PROJECT, on);
  (w!.stack.runtime.projects as unknown as { reload(): void }).reload();
}

/**
 * A full snapshot of the world, copied as a snapshot of another registered project (`arkona`), and the test project
 * marked as a sandbox: the rehearsal goes from the one into the other, as Arkona's will go into the test world.
 */
async function setup(): Promise<{ snapshotId: string; manifest: Manifest }> {
  w = await snapshotsWorld();
  const snaps = w.stack.runtime.snapshots;
  const r = await snaps.full(PROJECT, 'manual');
  const m = (await snaps.manifest(r.snapshotId!))!;
  w.stack.db
    .prepare(
      `INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at, updated_at, verified_at)
       VALUES (?, 'arkona', 'Arkona', 0, 0, 1, '{}', ?, ?, ?)`,
    )
    .run(SOURCE, Date.now(), Date.now(), Date.now());
  const copy: Manifest = {
    ...m,
    id: m.id.replace(/-full-/, '-full-0'),
    project: { id: SOURCE, name: 'arkona' },
  };
  await snaps.writeSnapshot(copy);
  sandbox(true);
  return { snapshotId: copy.id, manifest: copy };
}

describe('the rehearsal', () => {
  it('sampled: chooses pages covering every document type, block kind, images, keep regions and links', async () => {
    const { snapshotId } = await setup();
    const { plan } = await w!.stack.runtime.rehearsals.plan({
      targetProject: 'test',
      snapshotId,
      mode: 'sampled',
      max: 8,
    });
    expect(plan.pages.length).toBeLessThanOrEqual(8);
    expect(plan.pages).toContain(S.atlas); // the one page with a map, a timeline and a board
    for (const f of [
      'doc:map',
      'doc:time',
      'doc:board',
      'doc:blank',
      'images',
      'keep-region',
      'block:unsupported',
      'sidebar-links',
    ])
      expect(plan.coverage[f]?.length, f).toBeGreaterThan(0);
    expect(plan.estimate.writes).toBeGreaterThan(plan.pages.length);
    expect(plan.estimate.wallClockMs).not.toBeNull();
  });

  it('restores the sample into a throwaway root, compares it exactly, then deletes the root; nothing outside it is touched', async () => {
    const { snapshotId } = await setup();
    const before = new Map(
      [...w!.repo.res.values()].map((r) => [
        r.id,
        { name: r.name, parentId: r.parentId, deletedAt: r.deletedAt },
      ]),
    );
    const blocksBefore = JSON.stringify([...w!.repo.blocks.entries()]);
    const rh = w!.stack.runtime.rehearsals;
    const row = await rh.start({
      targetProject: 'test',
      snapshotId,
      mode: 'sampled',
      keep: false,
      by: 'owner',
      max: 10,
    });
    const done = (await rh.settled(row.id))!;
    expect(done.state, done.error ?? '').toBe('succeeded');
    const res = done.result as {
      pagesCompared: number;
      exact: number;
      differences: unknown[];
      cannotRestore: { reason: string }[];
      images: { uploaded: number };
      changedForRehearsal: { names: number; guardedValues: number };
    };
    expect(res.pagesCompared).toBe(10);
    expect(res.differences, JSON.stringify(res.differences, null, 1)).toEqual([]);
    expect(res.exact).toBe(10);
    expect(res.images.uploaded).toBeGreaterThan(0);
    expect(res.cannotRestore.some((c) => /unsupported/.test(c.reason))).toBe(true);
    expect(res.changedForRehearsal.guardedValues).toBeGreaterThan(0); // Status values written inert
    // The root was created at the top level, everything went under it, and it was deleted at the end.
    expect(done.rootId).toBeTruthy();
    expect(done.rootState).toBe('deleted');
    const root = w!.repo.res.get(done.rootId!)!;
    expect(root.name).toMatch(/^lk-bridge rehearsal /);
    expect(root.parentId).toBeNull();
    expect(root.deletedAt).not.toBeNull();
    for (const r of w!.repo.res.values()) {
      const was = before.get(r.id);
      if (was) {
        expect({ name: r.name, parentId: r.parentId, deletedAt: r.deletedAt }, r.id).toEqual(was);
        continue;
      }
      // New: the root or under it.
      let c: string | null = r.id;
      for (let i = 0; c && c !== done.rootId && i < 50; i++) c = w!.repo.res.get(c)?.parentId ?? null;
      expect(c, `${r.id} (${r.name}) is outside the rehearsal's root`).toBe(done.rootId);
      expect(r.name).toMatch(/^rehearsal: |^lk-bridge rehearsal /);
    }
    // No page that existed before had its content touched.
    for (const [doc, b] of JSON.parse(blocksBefore) as [string, unknown][])
      expect(w!.repo.blocks.get(doc)).toEqual(b);
  });

  it('writes the guarded signals inert: no [BSRC] page, no Authoritative Status and no CANON tag appear in the sandbox', async () => {
    const { snapshotId } = await setup();
    const rh = w!.stack.runtime.rehearsals;
    const row = await rh.start({
      targetProject: 'test',
      snapshotId,
      mode: 'sampled',
      keep: true,
      by: 'owner',
      max: 6,
    });
    const done = (await rh.settled(row.id))!;
    expect(done.state).toBe('succeeded');
    expect(done.rootState).toBe('kept');
    const under = [...w!.repo.res.values()].filter((r) => {
      let c: string | null = r.parentId;
      for (let i = 0; c && i < 50; i++) {
        if (c === done.rootId) return true;
        c = w!.repo.res.get(c)?.parentId ?? null;
      }
      return false;
    });
    expect(under.length).toBe(6);
    for (const r of under) {
      expect(r.name.startsWith('rehearsal: ')).toBe(true);
      expect(r.tags.map((t) => t.toLowerCase())).not.toContain('canon');
      if (!w!.sidebars.pages.has(r.id)) continue; // a page the snapshot had no sidebar for
      for (const row2 of w!.sidebars.rows(r.id))
        if (row2.key === 'Status') expect(row2.text).toMatch(/^rehearsal: /);
    }
    // Kept to inspect; the owner deletes it from the dashboard.
    const after = await rh.deleteRoot(row.id);
    expect(after.rootState).toBe('deleted');
  });

  it('full: every page of the snapshot, with its estimate first', async () => {
    const { snapshotId, manifest } = await setup();
    const rh = w!.stack.runtime.rehearsals;
    const { plan } = await rh.plan({ targetProject: 'test', snapshotId, mode: 'full' });
    expect(plan.pages.length).toBe(manifest.pages.length);
    const row = await rh.start({ targetProject: 'test', snapshotId, mode: 'full', keep: false, by: 'owner' });
    const done = (await rh.settled(row.id))!;
    const res = done.result as {
      pagesCompared: number;
      exact: number;
      differences: unknown[];
      cost: { writes: number; reads: number };
      ms: number;
    };
    expect(done.state).toBe('succeeded');
    expect(res.pagesCompared).toBe(manifest.pages.length);
    expect(res.differences, JSON.stringify(res.differences).slice(0, 2000)).toEqual([]);
    process.stdout.write(
      `rehearsal (mock, full): ${res.pagesCompared} pages, ${res.cost.writes} writes, ${res.cost.reads} compare reads, ${res.ms} ms; estimate ${plan.estimate.writes} writes, ${plan.estimate.reads} reads\n`,
    );
  });

  it('a difference is reported with its reason (LegendKeeper stores a page other than as written)', async () => {
    const { snapshotId } = await setup();
    // The target "mangles" one paragraph on write.
    const rest = [...w!.overrides];
    w!.overrides.clear();
    w!.overrides.set(/\/docs\/[^/]+\/blocks$/, (req) => {
      if (req.method !== 'PUT') return undefined;
      const body = req.body as { blocks: { content?: { text?: string }[] }[] };
      const hit = body.blocks.find((b) => b.content?.some((r) => r.text === 'First notes.'));
      if (hit) hit.content = [{ text: 'First notes, changed by the server.' }];
      return w!.repo.respond({ ...req, body });
    });
    for (const [k, v] of rest) w!.overrides.set(k, v);
    const rh = w!.stack.runtime.rehearsals;
    const row = await rh.start({
      targetProject: 'test',
      snapshotId,
      mode: 'sampled',
      keep: false,
      by: 'owner',
      max: 4,
    });
    const done = (await rh.settled(row.id))!;
    const res = done.result as {
      exact: number;
      pagesCompared: number;
      differences: { page: string; reason: string }[];
    };
    expect(res.differences).toEqual([
      expect.objectContaining({
        page: '[BSRC] Atlas of Snapshots',
        reason: 'its Markdown differs',
      }) as unknown,
    ]);
    expect(res.exact).toBe(res.pagesCompared - 1);
  });

  it('is refused into the project the snapshot came from, and into a project that is not a sandbox', async () => {
    await setup();
    const own = w!.stack.runtime.snapshots.index.snapshots(PROJECT, { kind: 'full' })[0]!.id;
    await expect(
      w!.stack.runtime.rehearsals.plan({ targetProject: 'test', snapshotId: own, mode: 'sampled' }),
    ).rejects.toMatchObject({ code: 'REHEARSAL_SAME_PROJECT' });
    sandbox(false);
    const copy = w!.stack.runtime.snapshots.index.snapshots(SOURCE)[0]!.id;
    await expect(
      w!.stack.runtime.rehearsals.plan({ targetProject: 'test', snapshotId: copy, mode: 'sampled' }),
    ).rejects.toMatchObject({ code: 'REHEARSAL_NOT_SANDBOX' });
  });
});

describe('choosing the sample', () => {
  it('covers every feature before spreading the rest, deterministically', () => {
    const page = (id: string, features: string[]) => ({
      entry: { id, parentId: null, rank: null, name: id, kind: 'bsrc' },
      resource: null,
      sidebar: null,
      documents: [],
      features,
    });
    const pages = [
      page('a', ['doc:page']),
      page('b', ['doc:page', 'doc:map']),
      page('c', ['doc:time']),
      page('d', ['doc:page']),
      page('e', ['images', 'doc:page']),
    ];
    const r1 = choosePages(pages, 3);
    expect(r1.ids.slice(0, 3).sort()).toEqual(['b', 'c', 'e']);
    expect(choosePages(pages, 5).ids).toEqual(choosePages(pages, 5).ids);
  });
});
