/**
 * Asset deletes keep their bytes (v2 D3, ADR 0041; the CR-2026-11 open item), on every route: before deleteAsset is
 * sent, the file is downloaded and stored content-addressed, and the journal's pre-image refers to it. A file that cannot
 * be fetched refuses the delete unless the owner allowed it; a folder delete records its children.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function upload(world: ImagesWorld, file: string, folder = 'Characters / Humans'): Promise<string> {
  const c = await world.stack.connect();
  const r = await world.stack.call(c, 'upload_image', {
    project: 'test',
    data_base64: fixture(file).toString('base64'),
    name: file,
    destination: { folder },
    deduplicate: false,
    operation_id: `up-${file}-${folder.replace(/\W/g, '')}`,
  });
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return (r.body.asset as { id: string }).id;
}

function preImageOf(world: ImagesWorld, assetId: string): Record<string, unknown> {
  const e = world.stack.runtime.engine.queries
    .journalLookup(PROJECT, { includePreImage: true, limit: 200 })
    .find((x) => x.opId === 'deleteAsset' && x.targetId === assetId);
  expect(e, `a journal entry for deleting ${assetId}`).toBeDefined();
  return e!.preImage as Record<string, unknown>;
}

/** v2 E1a (ADR 0042): kept bytes are objects of the snapshot store (gzip, named by the bytes' SHA-256). */
function keptPath(world: ImagesWorld, hash: string): string {
  return world.stack.runtime.snapshots.store.objectPath(hash);
}

describe('asset deletes keep their bytes', () => {
  it('lk_api_write deleteAsset: the bytes are stored (0600) and the pre-image refers to them', async () => {
    w = await imagesWorld();
    const id = await upload(w, 'alpha.png');
    const stored = w.served.get(id)!;
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteAsset',
      params: { path: { assetId: id } },
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(w.assets.assets.has(id)).toBe(false);
    const pre = preImageOf(w, id);
    expect(pre).toMatchObject({
      id,
      type: 'IMAGE',
      keptBytes: { sha256: sha(stored), size: stored.length, store: 'snapshots' },
    });
    const path = keptPath(w, sha(stored));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await w.stack.runtime.images.bytes.get(sha(stored))).toEqual(stored);
    expect(w.stack.runtime.images.store.keptRefs(PROJECT, id)).toHaveLength(1);
  });

  it('lk_api_batch and a direct engine job keep the bytes too', async () => {
    w = await imagesWorld();
    const a = await upload(w, 'alpha.png');
    const b = await upload(w, 'already.webp');
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'lk_api_batch', {
      project: 'test',
      calls: [{ operationId: 'deleteAsset', params: { path: { assetId: a } } }],
    });
    await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 10_000);
    expect(preImageOf(w, a)).toMatchObject({ keptBytes: { sha256: expect.any(String) as unknown } });
    // The engine itself (what lk_op_* and every tool go through).
    const run = await w.stack.runtime.engine.run(
      'deleteAsset',
      { path: { assetId: b } },
      {
        project: PROJECT,
        origin: { kind: 'test' },
      },
    );
    expect(run.status).toBe('succeeded');
    expect(preImageOf(w, b)).toMatchObject({ keptBytes: { sha256: sha(fixture('already.webp')) } });
  });

  it('a file that cannot be fetched refuses the delete, unless the owner allows it once', async () => {
    w = await imagesWorld();
    const id = await upload(w, 'alpha.png');
    w.failDownload.set(id, 404);
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteAsset',
      params: { path: { assetId: id } },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('ASSET_BYTES_NOT_KEPT');
    expect(w.assets.assets.has(id)).toBe(true);
    w.stack.runtime.images.store.grantOverride(PROJECT, id, 'owner', 3_600_000);
    const ok = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteAsset',
      params: { path: { assetId: id } },
    });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    expect(w.assets.assets.has(id)).toBe(false);
    expect(preImageOf(w, id)).toMatchObject({ ownerOverride: true, keptBytes: null });
    // Used once.
    expect(w.stack.runtime.images.store.useOverride(PROJECT, id)).toBe(false);
  });

  it('a folder delete records its children (every depth) and keeps their bytes', async () => {
    w = await imagesWorld();
    const one = await upload(w, 'alpha.png', 'Trash / One');
    const two = await upload(w, 'already.webp', 'Trash / One / Two');
    const trash = w.assets.at('Trash');
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteAsset',
      params: { path: { assetId: trash } },
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const pre = preImageOf(w, trash);
    const kids = pre.children as { id: string; type: string; keptBytes?: { sha256: string } }[];
    expect(pre.childCount).toBe(4);
    expect(
      kids
        .filter((k) => k.type === 'FOLDER')
        .map((k) => k.id)
        .sort(),
    ).toEqual(
      [
        w.stack.runtime.images.store.uploadOfAsset(PROJECT, one)!.folderId,
        w.stack.runtime.images.store.uploadOfAsset(PROJECT, two)!.folderId,
      ].sort(),
    );
    expect(kids.find((k) => k.id === one)?.keptBytes?.sha256).toBe(sha(w.served.get(one)!));
    expect(kids.find((k) => k.id === two)?.keptBytes?.sha256).toBe(sha(fixture('already.webp')));
  });

  it('kept bytes expire after their retention', async () => {
    w = await imagesWorld();
    const id = await upload(w, 'alpha.png');
    const stored = w.served.get(id)!;
    const c = await w.stack.connect();
    await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteAsset',
      params: { path: { assetId: id } },
    });
    const svc = w.stack.runtime.images;
    expect(await svc.expireKept()).toBe(0);
    w.stack.db.prepare('UPDATE asset_kept_refs SET expires_at = ?').run(Date.now() - 1);
    expect(await svc.expireKept()).toBe(1);
    // v2 E1a (ADR 0042): the reference is gone, but the change snapshots of the library (after the upload) still hold
    // the image, so the collector keeps its bytes; once those snapshots pass their retention, the bytes go.
    const snaps = w.stack.runtime.snapshots;
    await snaps.settled();
    expect(snaps.index.referencedBySnapshots().has(sha(stored))).toBe(true);
    await snaps.gc({ graceMs: 0 });
    expect(existsSync(keptPath(w, sha(stored)))).toBe(true);
    w.stack.db.prepare('UPDATE snapshots SET taken_at = ?').run(Date.now() - 400 * 86_400_000);
    const pruned = await snaps.prune();
    expect(pruned.removed).toBeGreaterThan(0);
    await snaps.gc({ graceMs: 0 });
    expect(existsSync(keptPath(w, sha(stored)))).toBe(false);
  });
});
