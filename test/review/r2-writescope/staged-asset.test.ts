/**
 * CR-2026-11 round 2 (write scope): the asset rail's staged-placement exemption (ADR 0055 C4: "the placement of a staged
 * image (marked by bridge code, never by an agent) is not an asset move"; F5: placing an image staged the old way, in
 * the project's staging folder in LegendKeeper, moves the asset out of it).
 *
 * The SAFE behaviour asserted: the exemption covers moving a staged image OUT OF THE STAGING FOLDER. An asset that is no
 * longer there (the owner filed it in the app since it was staged) is an ordinary asset, and moving it is the asset
 * rail's: a proposal, nothing sent.
 *
 * Set-up: a staged record of the old kind (before v3 F2: its asset in LegendKeeper), as the bridge keeps them, whose
 * asset the owner has since moved by hand into a curated folder.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from '../../discover/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, writeCallsSince, type Agent } from './helpers.js';

let w: DiscoverWorld;
let a: Agent;
let asset = '';
let curated = '';
let elsewhere = '';

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-staged-agent');
  const all = [...w.assets.assets.values()];
  const img = all.find((x) => x.type !== 'FOLDER' && x.folderId !== null)!;
  asset = img.id;
  curated = img.folderId!;
  elsewhere = all.find((x) => x.type === 'FOLDER' && x.id !== curated && x.folderId === null)!.id;
  // The old kind of staged record (its asset in LegendKeeper), as the bridge kept it before v3 F2.
  const store = w.stack.runtime.images.store;
  const sha = 'a'.repeat(64);
  store.insertUpload({
    projectId: PROJECT,
    id: 'stglgcy1',
    jobId: null,
    name: img.name,
    description: null,
    folderId: null,
    folderPath: null,
    staged: true,
    intended: null,
    source: 'url',
    principalId: 'someone',
    original: { format: 'webp', sha256: sha, bytes: 100, orientation: null },
    webp: { sha256: sha, bytes: 100 },
    width: 10,
    height: 10,
    frames: 1,
    hasAlpha: false,
    conversionMode: 'webp_passthrough',
    quality: null,
    convertMs: null,
  });
  store.updateUpload(PROJECT, 'stglgcy1', { state: 'uploaded', assetId: asset });
}, 60_000);
afterAll(async () => w?.close());

describe('the staged-placement exemption', () => {
  it('F1: “placing” a staged record whose asset now sits in a curated folder moves it only by proposal', async () => {
    const before = w.assets.assets.get(asset)!.folderId;
    expect(before).toBe(curated);
    const n = w.stack.mock.calls.length;
    const r = await w.stack.call(a.client, 'upload_image', {
      staged_id: 'stglgcy1',
      destination: { folder: elsewhere },
    });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    const moved = writeCallsSince(w, n).filter(
      (c) => c.method === 'PATCH' && c.path.includes(`/assets/${asset}`),
    );
    expect({ status: r.body.status, moves: moved.length }, r.text).toEqual({
      status: 'proposal_captured',
      moves: 0,
    });
  });
});
