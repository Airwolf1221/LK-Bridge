/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * Map images through update_document (v2 D2, ADR 0040): an image asset by id or by name (ambiguity refused), set or
 * replaced; a blank document given one becomes a map; a replacement with a different pixel size answers with a warning
 * listing how many features will now sit over different pixels, and moves nothing.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appFrame, mapsWorld, type MapsWorld } from './world.js';

let w: MapsWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const setImage = (document: string, mapImage: unknown, more: Record<string, unknown> = {}) =>
  call('update_document', { page: 'Atlas of Arkona', document, mapImage, ...more });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const costs: Record<string, { reads: number; writes: number }> = {};

beforeAll(async () => {
  w = await mapsWorld();
  client = await w.stack.connect();
});
afterAll(async () => {
  console.log('MAP IMAGE COSTS', JSON.stringify(costs));
  await w.close();
});

describe('setting a map’s image', () => {
  it('by asset name on a map with no image: written, verified, and the frame follows the image', async () => {
    const done = w.mark();
    const r = await setImage('Unpainted map', 'Square 1024');
    costs.set_image = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      mapImage: { asset: { name: 'Square 1024', width: 1024, height: 1024 } },
    });
    expect(r.body.warnings).toBeUndefined(); // there was no image to compare with
    expect(w.image(w.md.noImage)).toMatchObject({
      assetId: w.assetIds['Square 1024'],
      ...appFrame(1024, 1024),
    });
    expect(w.image(w.md.noImage)!.bounds).toEqual([
      [-256, 0],
      [0, 256],
    ]);
    // the PATCH carried the asset id
    expect(w.sent.filter((s) => s.method === 'PATCH').at(-1)!.body).toEqual({
      mapImage: { assetId: w.assetIds['Square 1024'] },
    });
  });

  it('by asset id, and in the { assetId } form older callers used', async () => {
    const byId = await setImage('Old tiled map', w.assetIds['Canon 1500x700']);
    expect(byId.body.status, byId.text).toBe('written');
    expect(w.image(w.md.legacy)).toMatchObject({
      assetId: w.assetIds['Canon 1500x700'],
      ...appFrame(1500, 700),
    });
    const obj = await setImage('Tiled with a frame', { assetId: w.assetIds['Wide 4096x1024'] });
    expect(obj.body.status, obj.text).toBe('written');
    expect(w.image(w.md.legacyFrame)).toMatchObject({
      assetId: w.assetIds['Wide 4096x1024'],
      ...appFrame(4096, 1024),
    });
  });

  it('refuses a name that matches several assets (each with where it is), a missing asset, and a non-map document', async () => {
    const before = writes().length;
    const amb = await setImage('Unpainted map', 'Twin');
    expect(amb.body.error?.code, amb.text).toBe('ASSET_AMBIGUOUS');
    expect(amb.body.error.candidates.map((c: { folder: string }) => c.folder).sort()).toEqual([
      '(library top)',
      'Duplicates',
    ]);
    const ok = await setImage('Unpainted map', w.assetIds['Twin (2)']);
    expect(ok.body.status, ok.text).toBe('written');
    const missing = await setImage('Unpainted map', 'No Such Image');
    expect(missing.body.error?.code).toBe('ASSET_NOT_FOUND');
    const page = await setImage('Main', 'Square 1024');
    expect(page.body.error?.code).toBe('DOCUMENT_IS_PAGE');
    expect(writes().length).toBe(before + 1);
  });
});

describe('a blank document', () => {
  it('becomes a map when given an image, and takes features straight away', async () => {
    expect(w.docType(w.md.blank)).toBe('blank');
    const r = await setImage('Sketch', 'Arkona 2048x1024');
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      mapImage: { becomes: 'a map' },
    });
    expect(w.docType(w.md.blank)).toBe('map');
    // the tree may still say blank: the live type decides
    const f = await call('create_map_feature', {
      page: 'Atlas of Arkona',
      document: 'Sketch',
      type: 'pin',
      name: 'First',
      pixel: { x: 800, y: 400 },
    });
    expect(f.body, f.text).toMatchObject({ status: 'written', verified: true });
    expect(w.features(w.md.blank)[0]!.pos).toEqual([-50, 100]);
    // and it reads as a map at once (the tree learned the new type after the write)
    const r2 = await call('read_document', { resource: 'Atlas of Arkona', document: 'Sketch' });
    expect(r2.isError, r2.text).toBe(false);
    expect(r2.body.document.type).toBe('map');
    expect(r2.body.markdown).toContain('**First** (pin) at (-50, 100), pixel (800, 400)');
  });

  it('is still refused without an image: settings of a blank document are not update_document’s', async () => {
    const w2 = await mapsWorld();
    try {
      const c2 = await w2.stack.connect();
      const r = await w2.stack.call(c2, 'update_document', {
        project: 'test',
        page: 'Atlas of Arkona',
        document: 'Sketch',
        name: 'Renamed',
      });
      expect(r.body.error?.code).toBe('DOCUMENT_IS_PAGE');
      expect(r.body.error.message).toMatch(/blank.*image/);
    } finally {
      await w2.close();
    }
  });
});

describe('replacing an image', () => {
  it('with another pixel size is REFUSED without confirm when the map has features: the count and sizes, nothing written', async () => {
    const before = JSON.stringify(w.features(w.md.map));
    const sent = writes().length;
    const r = await setImage('Arkona map', 'Square 1024');
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      features: 12, // pins, labels, regions and paths; the folders hold no position
      old: { width: 2048, height: 1024 },
      new: { width: 1024, height: 1024 },
    });
    expect(r.body.error.message).toMatch(
      /12 feature\(s\).*2048×1024.*1024×1024.*NOTHING was written.*confirm: true/s,
    );
    expect(writes().length).toBe(sent);
    expect(JSON.stringify(w.features(w.md.map))).toBe(before);
    expect(w.image(w.md.map)).toMatchObject(appFrame(2048, 1024));
  });

  it('with confirm: true goes ahead, the warning stays in the result, and nothing is moved', async () => {
    const before = JSON.stringify(w.features(w.md.map));
    const r = await setImage('Arkona map', 'Square 1024', { confirm: true });
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings[0]).toMatchObject({
      code: 'FEATURES_OVER_DIFFERENT_PIXELS',
      features: 12,
      old: { width: 2048, height: 1024 },
      new: { width: 1024, height: 1024 },
    });
    expect(r.body.warnings[0].message).toMatch(
      /12 feature\(s\) will now sit over different pixels.*Nothing is moved/s,
    );
    expect(JSON.stringify(w.features(w.md.map))).toBe(before);
    expect(w.image(w.md.map)).toMatchObject(appFrame(1024, 1024));
  });

  it('a map with no features needs no confirmation (and no warning)', async () => {
    // "Unpainted map" has an image now (set above) and no features
    expect(w.features(w.md.noImage)).toHaveLength(0);
    const r = await setImage('Unpainted map', 'Canon 1500x700');
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.warnings).toBeUndefined();
    expect(w.image(w.md.noImage)).toMatchObject(appFrame(1500, 700));
    // a map holding only a folder has nothing to shift either
    const f = await call('create_map_feature', {
      page: 'Atlas of Arkona',
      document: 'Unpainted map',
      type: 'folder',
      name: 'Only a folder',
    });
    expect(f.body.status, f.text).toBe('written');
    const r2 = await setImage('Unpainted map', 'Wide 4096x1024');
    expect(r2.body.status, r2.text).toBe('written');
    expect(r2.body.warnings).toBeUndefined();
  });

  it('with an image of the same size warns of nothing; with the same image sends nothing', async () => {
    w.setImage(w.md.map, 'Arkona 2048x1024');
    const same = await setImage('Arkona map', 'Arkona alt 2048x1024');
    expect(same.body.status, same.text).toBe('written');
    expect(same.body.warnings).toBeUndefined();
    const before = writes().length;
    const again = await setImage('Arkona map', 'Arkona alt 2048x1024');
    expect(again.body.status, again.text).toBe('no_change');
    expect(writes().length).toBe(before);
  });

  it('a legacy tiled map replaced by an image warns that its features’ pixels cannot be compared', async () => {
    const fresh = await mapsWorld(); // the legacy maps of this world have not been given images yet
    try {
      const c = await fresh.stack.connect();
      for (const doc of ['Tiled with a frame', 'Old tiled map']) {
        const r = await fresh.stack.call(c, 'update_document', {
          project: 'test',
          page: 'Atlas of Arkona',
          document: doc,
          mapImage: 'Arkona 2048x1024',
        });
        expect(r.body.status, r.text).toBe('written');
        expect(r.body.warnings.map((x: { code: string }) => x.code)).toEqual(['LEGACY_MAP_REPLACED']);
      }
      expect(fresh.image(fresh.md.legacyFrame)).toMatchObject({
        assetId: fresh.assetIds['Arkona 2048x1024'],
        ...appFrame(2048, 1024),
      });
    } finally {
      await fresh.close();
    }
  });

  it('a dry run shows the warning and writes nothing', async () => {
    const before = writes().length;
    const r = await setImage('Arkona map', 'Wide 4096x1024', { dryRun: true });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run', confirmation: 'required: pass confirm: true' });
    expect(r.body.warnings[0].code).toBe('FEATURES_OVER_DIFFERENT_PIXELS');
    expect(writes().length).toBe(before);
    expect(w.image(w.md.map)).toMatchObject(appFrame(2048, 1024));
  });
});

describe('under propose scope', () => {
  it('the proposal shows the count, and approving it is the confirmation', async () => {
    const proposer = await w.stack.connect(w.stack.newToken('image-proposer', 'propose').token);
    const before = JSON.stringify(w.features(w.md.map));
    const sent = writes().length;
    const r = await w.stack.call(proposer, 'update_document', {
      project: 'test',
      page: 'Atlas of Arkona',
      document: 'Arkona map',
      mapImage: 'Wide 4096x1024',
    });
    // not refused for want of confirm: captured, with the count, and nothing written yet
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured' });
    expect(r.body.warnings[0]).toMatchObject({ code: 'FEATURES_OVER_DIFFERENT_PIXELS', features: 12 });
    expect(writes().length).toBe(sent);
    expect(w.image(w.md.map)).toMatchObject(appFrame(2048, 1024));
    const proposals = w.stack.runtime.policy.proposals;
    const id = String(r.body.proposalId);
    const view = proposals.get(id)!;
    expect(view.summary).toMatch(
      /2048×1024 → 4096×1024.*12 feature\(s\) will sit over different pixels.*approving confirms it/,
    );
    expect(JSON.stringify(view)).toContain('12 feature(s) will sit over different pixels');
    // approved: it runs with no further confirmation, and moves nothing
    await w.stack.runtime.policy.commands.approve('owner', id);
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals.get(id)!.state).toBe('executed');
    expect(w.image(w.md.map)).toMatchObject(appFrame(4096, 1024));
    expect(JSON.stringify(w.features(w.md.map))).toBe(before);
    // the same size needs no proposal's worth of ceremony either way
    w.setImage(w.md.map, 'Arkona 2048x1024');
  });
});

describe('measured costs', () => {
  it('setting an image reads the document, the asset and the document again to verify, and writes once', () => {
    // plan: getDocument + getAsset; write: the journal's read of the document; verify: listDocuments + getDocument; and the
    // repository tree's re-read of the page after the write (the document's type may have changed)
    expect(costs.set_image).toEqual({ reads: 7, writes: 1 });
  });
});
