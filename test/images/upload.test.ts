/**
 * upload_image end to end against the mock (v2 D3, ADR 0041): the ways in, the WebP pipeline, verification,
 * deduplication and destinations.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { buildModels } from '../discover/world.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const b64 = (name: string) => fixture(name).toString('base64');

async function call(world: ImagesWorld, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

describe('upload_image: data_base64', () => {
  it('converts, uploads into the character’s folder (created), verifies the stored bytes and records it all', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: `data:image/png;base64,${b64('alpha.png')}`,
      name: 'Miyabi portrait.png',
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({
      status: 'uploaded',
      name: 'Miyabi portrait',
      storedBytesVerified: true,
      destination: {
        path: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi'],
        createsFolders: ['Characters / Beastkin / Foxians / Asagiri Miyabi'],
      },
      image: {
        originalFormat: 'png',
        width: 40,
        height: 24,
        frames: 1,
        hasAlpha: true,
        conversion: 'converted',
        quality: 90,
      },
    });
    const asset = r.body.asset as { id: string; folderId: string; url: string };
    const folder = w.assets.at('Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi');
    expect(asset.folderId).toBe(folder);
    const stored = w.served.get(asset.id)!;
    expect((await sharp(stored).metadata()).format).toBe('webp');
    expect(w.assets.assets.get(asset.id)).toMatchObject({
      name: 'Miyabi portrait',
      folderId: folder,
      isHidden: false,
    });
    const row = w.stack.runtime.images.store.uploadOfAsset(PROJECT, asset.id)!;
    expect(row).toMatchObject({
      state: 'uploaded',
      source: 'data_base64',
      original: { format: 'png', sha256: sha(fixture('alpha.png')) },
      webp: { sha256: sha(stored), bytes: stored.length },
      conversionMode: 'converted',
      storedVerified: true,
    });
    // The asset tree knows the new folder and the image (re-read after each write), with the hash once known.
    const item = w.stack.runtime.assets.queries.asset(PROJECT, asset.id).data!;
    expect(item.sha256).toBe(sha(stored));
    expect(w.stack.runtime.assets.queries.folder(PROJECT, folder).data?.name).toBe('Asagiri Miyabi');
  });
});

/** The bridge's asset tree learns what the model now holds (as a refresh would). */
function refreshTree(world: ImagesWorld): void {
  buildModels(world.stack, world.repo, world.assets);
}

async function waitFor(done: () => boolean, ms = 6000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('upload_image: conversion cases', () => {
  it('an animated GIF becomes an animated WebP with every frame', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('animated.gif'),
      name: 'Spinner.gif',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body).toMatchObject({
      status: 'uploaded',
      image: { originalFormat: 'gif', frames: 3, width: 16, height: 12 },
    });
    const stored = w.served.get((r.body.asset as { id: string }).id)!;
    const m = await sharp(stored, { animated: true }).metadata();
    expect(m).toMatchObject({ format: 'webp', pages: 3 });
  });

  it('a WebP is stored byte for byte', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('already.webp'),
      name: 'Plain',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body).toMatchObject({
      status: 'uploaded',
      storedBytesVerified: true,
      image: { conversion: 'webp_passthrough' },
    });
    expect(Buffer.compare(w.served.get((r.body.asset as { id: string }).id)!, fixture('already.webp'))).toBe(
      0,
    );
  });

  it('the file’s own bytes decide its type: a PNG named .jpg is converted as a PNG', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('png-named.jpg'),
      name: 'liar.jpg',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body).toMatchObject({ status: 'uploaded', name: 'liar', image: { originalFormat: 'png' } });
  });

  it('truncated files, decompression bombs and non-images are refused with precise codes; nothing is sent', async () => {
    w = await imagesWorld();
    const dest = { folder: 'Characters / Humans' };
    const t = await call(w, { data_base64: b64('truncated.jpg'), name: 'T', destination: dest });
    expect(t.body.error).toMatchObject({ code: 'IMAGE_TRUNCATED' });
    const b = await call(w, { data_base64: b64('bomb.png'), name: 'B', destination: dest });
    expect(b.body.error).toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS', width: 60000, height: 60000 });
    const n = await call(w, { data_base64: b64('not-an-image.png'), name: 'N', destination: dest });
    expect(n.body.error).toMatchObject({ code: 'UPLOAD_NOT_AN_IMAGE' });
    expect(w.lkUploads).toHaveLength(0);
  });

  it('the byte cap holds for base64', async () => {
    w = await imagesWorld({
      tools: {
        upload: { maxBytes: 100, allowUrlSource: true, fetchTimeoutMs: 5000, putTimeoutMs: 10_000 },
      },
    });
    const r = await call(w, {
      data_base64: b64('orientation-6.jpg'),
      name: 'Big',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body.error).toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
  });
});

describe('upload_image: url', () => {
  it('fetches a public https image through the guarded path', async () => {
    w = await imagesWorld();
    w.web.set('p.png', { type: 'image/png', body: fixture('alpha.png') });
    const r = await call(w, {
      url: `https://assets.test:${w.port}/img/p.png`,
      name: 'From the web',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body).toMatchObject({ status: 'uploaded', storedBytesVerified: true });
    expect(
      w.stack.runtime.images.store.uploadOfAsset(PROJECT, (r.body.asset as { id: string }).id)?.source,
    ).toBe('url');
  });

  it('respects UPLOAD_ALLOW_URL_SOURCE', async () => {
    w = await imagesWorld({
      tools: {
        upload: {
          maxBytes: 10 * 1024 * 1024,
          allowUrlSource: false,
          fetchTimeoutMs: 5000,
          putTimeoutMs: 10_000,
        },
      },
    });
    w.web.set('p.png', { type: 'image/png', body: fixture('alpha.png') });
    const r = await call(w, {
      url: `https://assets.test:${w.port}/img/p.png`,
      name: 'X',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body.error).toMatchObject({ code: 'UPLOAD_URL_SOURCE_DISABLED' });
  });
});

describe('upload_image: deduplication and verification', () => {
  it('the same original again returns the existing asset; deduplicate: false needs a new operation_id', async () => {
    w = await imagesWorld();
    const args = {
      data_base64: b64('alpha.png'),
      name: 'Once',
      destination: { folder: 'Characters / Humans' },
    };
    const first = await call(w, args);
    const id = (first.body.asset as { id: string }).id;
    const again = await call(w, { ...args, name: 'Twice', destination: { folder: 'Characters / Dwarves' } });
    expect(again.body).toMatchObject({ status: 'uploaded', deduplicated: true, asset: { id } });
    expect(w.lkUploads.filter((u) => (u as { op: string }).op === 'createImageUpload')).toHaveLength(1);
    const refused = await call(w, { ...args, deduplicate: false });
    expect(refused.body.error).toMatchObject({ code: 'INVALID_REQUEST' });
    const forced = await call(w, { ...args, deduplicate: false, operation_id: 'again-1' });
    expect(forced.body).toMatchObject({ status: 'uploaded' });
    expect((forced.body.asset as { id: string }).id).not.toBe(id);
    // The same operation_id again is that request's answer, not a third upload.
    const repeat = await call(w, { ...args, deduplicate: false, operation_id: 'again-1' });
    expect(repeat.body.repeated).toBe(true);
    expect(w.lkUploads.filter((u) => (u as { op: string }).op === 'createImageUpload')).toHaveLength(2);
  });

  it('a stored file that differs from the bytes sent is reported unverified, and the asset id is still returned', async () => {
    w = await imagesWorld();
    w.corruptNext = Buffer.from('not what was uploaded');
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'Mismatch',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ status: 'uploaded', storedBytesVerified: false });
    expect(String(r.body.unverifiedReason)).toMatch(/differs from the bytes uploaded/);
    expect((r.body.asset as { id: string }).id).toMatch(/^a/);
    const row = w.stack.runtime.images.store.uploadOfAsset(PROJECT, (r.body.asset as { id: string }).id)!;
    expect(row.storedVerified).toBe(false);
  });

  it('a download that fails is reported unverified too', async () => {
    w = await imagesWorld();
    const before = new Set(w.assets.assets.keys());
    // The next asset's id is not known yet: fail every download of a new asset.
    const orig = w.served.set.bind(w.served);
    w.served.set = (k: string, v: Buffer) => {
      if (!before.has(k)) w!.failDownload.set(k, 404);
      return orig(k, v);
    };
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'Gone',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body).toMatchObject({ status: 'uploaded', storedBytesVerified: false });
    expect(String(r.body.unverifiedReason)).toMatch(/could not be downloaded/);
  });
});

describe('upload_image: destinations (the old bridge’s rules)', () => {
  it('reuses a folder named after the character wherever it is', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'Inae',
      destination: { for_character: { name: 'inae mikumo', race: 'Foxian' } },
    });
    expect(r.body).toMatchObject({
      destination: { path: ['Characters', 'Elves', 'Moon Elves', 'Inae Mikumo'], createsFolders: [] },
    });
  });

  it('several folders with the character’s name are refused, listed', async () => {
    w = await imagesWorld();
    w.assets.folder('Inae Mikumo', w.assets.at('Characters', 'Humans'));
    refreshTree(w);
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'I',
      destination: { for_character: { name: 'Inae Mikumo' } },
    });
    expect(r.body.error).toMatchObject({ code: 'AMBIGUOUS_FOLDER' });
    expect((r.body.error as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('a race with no group: Characters / Race / Name', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'K',
      destination: { for_character: { name: 'Kumi Two', race: 'Human' } },
    });
    expect(r.body).toMatchObject({ destination: { path: ['Characters', 'Humans', 'Kumi Two'] } });
  });

  it('an unknown or omitted race goes to Undetermined / Unknown; a declared race that does not resolve fails', async () => {
    w = await imagesWorld();
    const u = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'U',
      destination: { for_character: { name: 'Nobody Known' } },
      dryRun: true,
    });
    expect(u.body).toMatchObject({
      status: 'dry_run',
      destination: { path: ['Characters', 'Undetermined / Unknown', 'Nobody Known'] },
    });
    const bad = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'D',
      destination: { for_character: { name: 'Draco', race: 'Dragonkin' } },
    });
    expect(bad.body.error).toMatchObject({ code: 'RACE_NOT_FOUND' });
    expect(w.lkUploads).toHaveLength(0);
  });

  it('a non-folder asset with a needed folder’s name is a conflict', async () => {
    w = await imagesWorld();
    w.assets.image('Zed', w.assets.at('Characters', 'Humans'));
    refreshTree(w);
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'Z',
      destination: { for_character: { name: 'Zed', race: 'Human' } },
    });
    expect(r.body.error).toMatchObject({ code: 'ASSET_NAME_CONFLICT' });
  });

  it('subfolders are appended and created in order; a folder id and a path work', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'Winter',
      destination: {
        for_character: { name: 'Asagiri Miyabi', race: 'Foxians' },
        subfolders: ['Outfits', 'Winter'],
      },
    });
    expect(r.body).toMatchObject({
      status: 'uploaded',
      destination: { path: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi', 'Outfits', 'Winter'] },
    });
    const winter = w.assets.at('Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi', 'Outfits', 'Winter');
    expect((r.body.asset as { folderId: string }).folderId).toBe(winter);
    const byId = await call(w, {
      data_base64: b64('already.webp'),
      name: 'ById',
      destination: { folder: winter },
      dryRun: true,
    });
    expect(byId.body).toMatchObject({ destination: { folderId: winter, createsFolders: [] } });
  });

  it('for_page: a character page gives its character’s folder; any other page needs a folder', async () => {
    w = await imagesWorld();
    const core = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'P',
      destination: { for_page: 'miyabi01' },
      dryRun: true,
    });
    expect(core.body).toMatchObject({
      destination: { path: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi'] },
    });
    const compact = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'P',
      destination: { for_page: 'Asagiri Kaede' },
      dryRun: true,
    });
    expect(compact.body).toMatchObject({
      destination: { path: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Kaede'] },
    });
    const other = await call(w, {
      data_base64: b64('alpha.png'),
      name: 'P',
      destination: { for_page: 'Characters' },
    });
    expect(other.body.error).toMatchObject({ code: 'FOLDER_REQUIRED' });
  });
});

describe('upload_image: scope propose', () => {
  it('stages the image (no bytes in the proposal) and proposes its placement; approval places it', async () => {
    w = await imagesWorld();
    const { token } = w.stack.newToken('proposer', 'propose');
    const r = await call(
      w,
      {
        data_base64: b64('alpha.png'),
        name: 'Proposed',
        destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
      },
      token,
    );
    expect(r.body).toMatchObject({ status: 'proposal_captured', staging: true, onServer: true });
    const stagedId = String(r.body.staged_id);
    // v3 F2 (ADR 0049 decision 10): staged on the bridge's server; nothing in LegendKeeper until approval.
    expect(w.lkUploads).toHaveLength(0);
    const proposalId = String(r.body.proposalId);
    const detail = JSON.stringify(w.stack.runtime.policy.proposals.detail(proposalId));
    expect(detail).not.toContain(b64('alpha.png').slice(0, 40));
    await w.stack.runtime.policy.commands.approve('owner', proposalId);
    const proposals = w.stack.runtime.policy.proposals;
    await waitFor(() => ['executed', 'failed', 'conflicted'].includes(proposals.get(proposalId)!.state));
    expect(proposals.get(proposalId)!.state).toBe('executed');
    const folder = w.assets.at('Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi');
    const row = w.stack.runtime.images.staged(PROJECT, stagedId)!;
    expect(w.assets.assets.get(row.assetId!)).toMatchObject({
      folderId: folder,
      isHidden: false,
      name: 'Proposed',
    });
    expect(row).toMatchObject({ staged: false, folderId: folder, storedVerified: true });
    expect(row.placedAt).not.toBeNull();
  });

  it('a read-only connection is refused before anything is converted or sent', async () => {
    w = await imagesWorld();
    const { token } = w.stack.newToken('reader', 'read');
    const r = await call(w, { data_base64: b64('alpha.png'), name: 'R', stage: true }, token);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read-only/);
    expect(w.lkUploads).toHaveLength(0);
  });
});

describe('reading uploads back', () => {
  it('list_assets shows the original format, dimensions, frames and verification; a staged image is not in LegendKeeper', async () => {
    w = await imagesWorld();
    const placed = await call(w, {
      data_base64: b64('animated.gif'),
      name: 'Spin',
      destination: { folder: 'Characters / Humans' },
    });
    const staged = await call(w, { data_base64: b64('alpha.png'), name: 'Later', stage: true });
    const c = await w.stack.connect();
    const list = await w.stack.call(c, 'list_assets', { project: 'test', folder: 'Characters / Humans' });
    const spin = (list.body.assets as { id: string; bridgeUpload?: unknown }[]).find(
      (a) => a.id === (placed.body.asset as { id: string }).id,
    );
    expect(spin?.bridgeUpload).toEqual({
      originalFormat: 'gif',
      width: 16,
      height: 12,
      frames: 3,
      conversion: 'converted',
      storedBytesVerified: true,
      staged: false,
    });
    // v3 F2 (ADR 0049 decision 10): a staged image is on the bridge's server, so no folder of LegendKeeper holds it.
    expect(staged.body).toMatchObject({ status: 'staged', onServer: true });
    expect(() => w!.assets.at('LK-Bridge staging')).toThrow();
  });
});
