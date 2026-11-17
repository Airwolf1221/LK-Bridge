/**
 * CR-2026-11 round 2 (write scope): the asset rail (ADR 0055 decision C: "Asset deletes and asset moves | on |
 * deleteAsset; updateAsset to another folder; not the placement of a staged image").
 *
 * Every test asserts the SAFE behaviour: an agent at scope `write` with the DEFAULT rails cannot delete or move an asset
 * directly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from '../../discover/world.js';
import { writeAgent, writeCallsSince, type Agent } from './helpers.js';

let w: DiscoverWorld;
let a: Agent;
let image = '';
let folder = '';
let otherFolder = '';

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-assets-agent');
  const all = [...w.assets.assets.values()];
  const img = all.find((x) => x.type !== 'FOLDER' && x.folderId !== null)!;
  image = img.id;
  folder = img.folderId!;
  otherFolder = all.find((x) => x.type === 'FOLDER' && x.id !== folder)!.id;
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const sent = (n: number) => writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`);

describe('asset deletes and moves (controls)', () => {
  it('F0a: updateAsset to another folder is a proposal (asset rail), nothing sent', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'updateAsset',
      params: { path: { assetId: image }, body: { folderId: otherFolder } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toMatch(/asset move/);
    expect(sent(n)).toEqual([]);
  });

  it('F0b: updateAsset to the library root (folderId null) is a proposal', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'updateAsset',
      params: { path: { assetId: image }, body: { folderId: null } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(sent(n)).toEqual([]);
  });

  it('F0c: deleteAsset of a folder is a proposal (deletes and asset rails)', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'deleteAsset',
      params: { path: { assetId: folder } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toMatch(/asset delete/);
    expect(sent(n)).toEqual([]);
  });

  it('F0d: a batch renaming an asset and moving another hides no move: a proposal', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_batch', {
      calls: [
        { operationId: 'updateAsset', params: { path: { assetId: image }, body: { name: 'Renamed only' } } },
        {
          operationId: 'updateAsset',
          params: { path: { assetId: folder }, body: { folderId: otherFolder } },
        },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(sent(n)).toEqual([]);
  });
});
