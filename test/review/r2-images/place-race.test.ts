/**
 * CR2 images, attack E1 (find-or-create and placement under concurrency): ONE staged image placed by two calls at once.
 *
 * `placeStaged` (src/mcp/tools/images.ts) reads the staged record, awaits the destination plan, and `ImageService.place`
 * (src/images/service.ts) refuses a busy image by looking at that record as it was READ, not as it is now; the placement
 * job's id is only written back after `engine.submit` has resolved. Two calls (two parallel tool calls, a retry, or an
 * agent and the owner's Staging page) can both pass the check and both submit a placement whenever the plan between the
 * read and the check waits for I/O (a `for_page` whose race the tree does not hold costs one live read). The safe
 * behaviour: the second is refused (STAGED_BUSY) and exactly ONE asset is made from one staged image.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { T } from '../../resources/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function call(world: ImagesWorld, tool: string, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, tool, { project: 'test', ...args });
}

const createdAssets = (world: ImagesWorld) =>
  world.lkUploads.filter((u) => (u as { op: string }).op === 'createImageAsset');

const codeOf = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code ?? String(r.body.status);

/** A Working character with an Art page whose race the tree does not hold yet: planning it costs one live read. */
async function characterWithArt(world: ImagesWorld, name: string) {
  const made = await call(world, 'create_character', { kind: 'core', name, race: 'Foxian' });
  expect(made.body, made.text).toMatchObject({ status: 'written' });
  const pages = made.body.pages as { id: string; name: string }[];
  const index = pages.find((p) => p.name.startsWith('[INDEX]'))!.id;
  const core = pages.find((p) => p.name.includes('Character Core'))!.id;
  const art = await call(world, 'create_resource', {
    name: `${name} - Art`,
    template: T.general,
    parent: index,
  });
  expect(art.body, art.text).toMatchObject({ status: 'written' });
  const artId = String((art.body.pages as { id: string }[])[0]!.id);
  await world.stack.runtime.tree.sweep(PROJECT);
  // The tree has not read the Core's sidebar yet (as after a restart or a fresh build): planning reads it live, once.
  world.stack.db.prepare('UPDATE tree_nodes SET sidebar = NULL WHERE id = ?').run(core);
  return { core, artId };
}

describe('E1: one staged image, two placements at once', () => {
  it('HELD when the plan needs no I/O: two parallel calls with a folder destination give one job and STAGED_BUSY', async () => {
    w = await imagesWorld();
    const staged = await call(w, 'upload_image', {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Racer',
      stage: true,
    });
    expect(staged.body.status, staged.text).toBe('staged');
    const id = String(staged.body.staged_id);
    const engine = w.stack.runtime.engine;
    engine.controls.pauseWrites('test');
    const dest = { folder: 'Characters / Humans' };
    const [a, b] = await Promise.all([
      call(w, 'upload_image', { staged_id: id, destination: dest, waitSeconds: 0 }),
      call(w, 'upload_image', { staged_id: id, destination: dest, waitSeconds: 0 }),
    ]);
    engine.controls.resumeWrites('test');
    for (const r of [a, b])
      if (typeof r.body.jobId === 'string') await engine.wait(PROJECT, r.body.jobId, 20_000);
    expect([codeOf(a), codeOf(b)].sort(), `${a.text}\n${b.text}`).toEqual(['STAGED_BUSY', 'queued']);
    expect(createdAssets(w)).toHaveLength(1);
  });

  it('two parallel placements for_page (the race read live) make ONE asset: the second must be STAGED_BUSY', async () => {
    w = await imagesWorld();
    const { core, artId } = await characterWithArt(w, 'Race Twin');

    const staged = await call(w, 'upload_image', {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Race Twin portrait',
      stage: true,
    });
    const id = String(staged.body.staged_id);
    const engine = w.stack.runtime.engine;
    engine.controls.pauseWrites('test');
    // Two connections ready first, so the two tool calls leave together (as an assistant's parallel tool calls do).
    const [c1, c2] = await Promise.all([w.stack.connect(), w.stack.connect()]);
    const before = w.stack.mock.calls.length;
    const args = { project: 'test', staged_id: id, destination: { for_page: artId }, waitSeconds: 0 };
    const [a, b] = await Promise.all([
      w.stack.call(c1, 'upload_image', args),
      w.stack.call(c2, 'upload_image', args),
    ]);
    const liveReads = w.stack.mock.calls
      .slice(before)
      .filter((c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${core}`)).length;
    engine.controls.resumeWrites('test');
    for (const r of [a, b])
      if (typeof r.body.jobId === 'string') await engine.wait(PROJECT, r.body.jobId, 25_000);
    const row = w.stack.runtime.images.staged(PROJECT, id)!;
    const assets = createdAssets(w).length;
    const inLk = [...w.assets.assets.values()].filter(
      (x) => x.type === 'IMAGE' && String(x.name).startsWith('Race Twin portrait'),
    );
    const detail = JSON.stringify({
      liveReads,
      a: codeOf(a),
      b: codeOf(b),
      createImageAsset: assets,
      inLk: inLk.map((x) => x.id),
      recorded: row.assetId,
    });
    expect([codeOf(a), codeOf(b)].sort(), detail).toEqual(['STAGED_BUSY', 'queued']);
    expect(assets, detail).toBe(1);
    expect(
      inLk.map((x) => x.id),
      detail,
    ).toEqual([row.assetId]);
  });
  it('at scope propose: two proposals for one staged image; approving one and rejecting the other leaves the record saying “staged” while its asset is in the library', async () => {
    w = await imagesWorld();
    const { artId } = await characterWithArt(w, 'Race Triplet');
    const staged = await call(w, 'upload_image', {
      data_base64: fixture('already.webp').toString('base64'),
      name: 'Race Triplet portrait',
      stage: true,
    });
    const id = String(staged.body.staged_id);
    const { token } = w.stack.newToken('proposer', 'propose');
    const [c1, c2] = await Promise.all([w.stack.connect(token), w.stack.connect(token)]);
    const args = { project: 'test', staged_id: id, destination: { for_page: artId } };
    const [a, b] = await Promise.all([
      w.stack.call(c1, 'upload_image', args),
      w.stack.call(c2, 'upload_image', args),
    ]);
    const proposals = [a, b]
      .map((r): unknown => r.body.proposalId)
      .filter((p): p is string => typeof p === 'string');
    const pol = w.stack.runtime.policy;
    if (proposals.length === 2) {
      // The owner approves the first and rejects the second (a duplicate, as it looks on the Proposals page).
      await pol.commands.approve('owner', proposals[0]!);
      for (
        let i = 0;
        i < 300 && !['executed', 'failed'].includes(pol.proposals.get(proposals[0]!)!.state);
        i++
      )
        await new Promise((r) => setTimeout(r, 20));
      pol.commands.reject('owner', proposals[1]!, 'duplicate');
    }
    const row = w.stack.runtime.images.staged(PROJECT, id)!;
    const inLk = [...w.assets.assets.values()].filter(
      (x) => x.type === 'IMAGE' && String(x.name).startsWith('Race Triplet portrait'),
    );
    const detail = JSON.stringify({
      proposals: proposals.length,
      record: {
        staged: row.staged,
        assetId: row.assetId,
        onServer: row.serverSha256 !== null,
        error: row.error,
      },
      inLk: inLk.map((x) => x.id),
    });
    // Safe: one proposal; and whatever was approved, the record names the asset that is in the library.
    expect(proposals.length, detail).toBe(1);
    expect({ staged: row.staged, assetId: row.assetId }, detail).toEqual({
      staged: false,
      assetId: inLk[0]?.id ?? null,
    });
  });
});
