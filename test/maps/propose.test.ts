/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * The map-feature tools at scope `propose`, and conflicts (v2 D2, ADR 0040): each call becomes one proposal and writes
 * nothing; approved, it runs with the bridge's own compare-and-swap inside the lock, which refuses what changed since the
 * plan (the feature, the folder, the image the pixels were chosen on, a cascade's contents) and sends nothing. And canon
 * (ADR 0036 decision 6, option (a)): feature edits on an Authoritative page go straight through at scope `write`; only
 * deleting the whole map document is canonical.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { mapsWorld, type MapsWorld } from './world.js';

let w: MapsWorld;
let writer: Client;
let proposer: Client;
const ARKONA = { page: 'Atlas of Arkona', document: 'Arkona map' };
const as = (c: Client) => (tool: string, args: Record<string, unknown>) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const write = (tool: string, args: Record<string, unknown>) => as(writer)(tool, args);
const propose = (tool: string, args: Record<string, unknown>) => as(proposer)(tool, { ...ARKONA, ...args });
const stored = (id: string, doc = w.md.map) => w.features(doc).find((f) => f.id === id);
const named = (name: string, doc = w.md.map) => w.features(doc).filter((f) => f.name === name);
const mapWrites = () => w.sent.length;

const approve = async (id: string) => {
  const proposals = w.stack.runtime.policy.proposals;
  await w.stack.runtime.policy.commands.approve('owner', id);
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  return proposals.get(id)!;
};

beforeAll(async () => {
  w = await mapsWorld();
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('maps-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('propose scope', () => {
  it('captures one proposal per call and writes nothing; approved, it lands, verified', async () => {
    const before = mapWrites();
    const r = await propose('create_map_feature', {
      type: 'pin',
      name: 'Proposed',
      pixel: { x: 512, y: 256 },
    });
    expect(r.body, r.text).toMatchObject({
      status: 'proposal_captured',
      feature: { name: 'Proposed', pixel: { x: 512, y: 256 } },
    });
    expect(mapWrites()).toBe(before);
    expect(named('Proposed')).toHaveLength(0);
    const p = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
    expect(JSON.stringify(p)).toContain('create_map_feature');
    const done = await approve(String(r.body.proposalId));
    expect(done.state).toBe('executed');
    expect(named('Proposed')).toHaveLength(1);
    expect(named('Proposed')[0]!.pos).toEqual([-32, 64]);
  });

  it('a dry run at propose scope captures nothing', async () => {
    const count = () => w.stack.runtime.policy.proposals.list({ project: PROJECT }).length;
    const before = count();
    const r = await propose('create_map_feature', {
      type: 'pin',
      name: 'Dry',
      pixel: { x: 1, y: 1 },
      dryRun: true,
    });
    expect(r.body.status, r.text).toBe('dry_run');
    expect(count()).toBe(before);
  });

  it('two proposals for the same gap both land, each between its real neighbours at the time it runs', async () => {
    const a = await propose('create_map_feature', {
      type: 'pin',
      name: 'Gap A',
      pixel: { x: 1, y: 1 },
      folder: 'Shrines',
      after: 'Torii Gate',
    });
    const b = await propose('create_map_feature', {
      type: 'pin',
      name: 'Gap B',
      pixel: { x: 1, y: 1 },
      folder: 'Shrines',
      after: 'Torii Gate',
    });
    expect(a.body.status).toBe('proposal_captured');
    expect(b.body.status).toBe('proposal_captured');
    for (const x of [a, b]) expect((await approve(String(x.body.proposalId))).state).toBe('executed');
    const names = w
      .features(w.md.map)
      .filter((f) => f.parentId === w.f.Shrines)
      .sort((x, y) => (String(x.rank) < String(y.rank) ? -1 : 1))
      .map((f) => f.name);
    expect(names.slice(0, 4)).toEqual(['Torii Gate', 'Gap B', 'Gap A', 'Hollow Shrine']);
  });

  it('an update and a delete are proposals too, and a read-only scope is refused', async () => {
    const u = await propose('update_map_feature', { feature: 'Isar Harbour', name: 'Isar Port' });
    expect(u.body.status, u.text).toBe('proposal_captured');
    expect(stored(w.f['Isar Harbour']!)!.name).toBe('Isar Harbour');
    expect((await approve(String(u.body.proposalId))).state).toBe('executed');
    expect(stored(w.f['Isar Harbour']!)!.name).toBe('Isar Port');
    const d = await propose('delete_map_feature', { feature: 'Secret', confirm: true });
    expect(d.body.status, d.text).toBe('proposal_captured');
    expect(stored(w.f.Secret!)).toBeDefined();
    expect((await approve(String(d.body.proposalId))).state).toBe('executed');
    expect(stored(w.f.Secret!)).toBeUndefined();
    const reader = await w.stack.connect(w.stack.newToken('maps-reader', 'read').token);
    const r = await w.stack.call(reader, 'create_map_feature', {
      project: 'test',
      ...ARKONA,
      type: 'pin',
      name: 'x',
      latlng: [0, 0],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read-only/);
  });
});

describe('conflicts: what changed since the plan is refused inside the lock, and nothing is sent', () => {
  /**
   * Approves, and answers why it ended `conflicted` with nothing written: the proposal's own reason, and the job's
   * differences when the bridge's check inside the lock refused it (the code of the plan's refusal is in the path).
   */
  const conflicted = async (id: string) => {
    const p = await approve(id);
    expect(p.state, JSON.stringify(p)).toBe('conflicted');
    const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
    return JSON.stringify({ conflict: p.conflict, error: job?.lastError ?? null });
  };

  it('a feature edited in the app after the update was planned', async () => {
    const r = await propose('update_map_feature', { feature: 'Hollow Shrine', name: 'Hollow Changed' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.liveFeatures(w.md.map).find((f) => f.id === w.f['Hollow Shrine'])!.iconShape = 'flag'; // an outside edit
    const before = mapWrites();
    const why = await conflicted(String(r.body.proposalId));
    expect(why).toMatch(/target changed after the proposal|FEATURE_CHANGED/);
    expect(mapWrites()).toBe(before);
    expect(stored(w.f['Hollow Shrine']!)!.name).toBe('Hollow Shrine');
  });

  it('the image replaced after pixel coordinates were chosen', async () => {
    const r = await propose('create_map_feature', {
      type: 'pin',
      name: 'Stale Pixels',
      pixel: { x: 100, y: 100 },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const swap = await write('update_document', {
      page: 'Atlas of Arkona',
      document: 'Arkona map',
      mapImage: 'Square 1024',
    });
    expect(swap.body.status, swap.text).toBe('written');
    const before = mapWrites();
    const why = await conflicted(String(r.body.proposalId));
    expect(why).toMatch(/FRAME_CHANGED/);
    expect(mapWrites()).toBe(before);
    expect(named('Stale Pixels')).toHaveLength(0);
    // put the 2048×1024 image back for the tests that follow
    const back = await write('update_document', {
      page: 'Atlas of Arkona',
      document: 'Arkona map',
      mapImage: 'Arkona 2048x1024',
    });
    expect(back.body.status, back.text).toBe('written');
  });

  it('a folder deleted in the app after a feature was planned into it', async () => {
    const r = await propose('create_map_feature', {
      type: 'pin',
      name: 'Orphaned',
      pixel: { x: 5, y: 5 },
      folder: 'North',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const list = w.liveFeatures(w.md.map);
    list.splice(
      list.findIndex((f) => f.name === 'North'),
      1,
    );
    const before = mapWrites();
    const why = await conflicted(String(r.body.proposalId));
    expect(why).toMatch(/FOLDER_NOT_FOUND/);
    expect(mapWrites()).toBe(before);
  });

  it('a sibling that is gone when a feature was to be placed beside it', async () => {
    const r = await propose('create_map_feature', {
      type: 'pin',
      name: 'Beside Gone',
      pixel: { x: 5, y: 5 },
      folder: 'Shrines',
      after: 'Hollow Shrine',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const list = w.liveFeatures(w.md.map);
    list.splice(
      list.findIndex((f) => f.id === w.f['Hollow Shrine']),
      1,
    );
    const why = await conflicted(String(r.body.proposalId));
    expect(why).toMatch(/SIBLING_NOT_FOUND/);
    expect(named('Beside Gone')).toHaveLength(0);
  });

  it('a feature added under a folder after a cascade was approved: the approval covers only what it listed', async () => {
    const r = await propose('delete_map_feature', { feature: 'Cities', cascade: true, confirm: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.removedCount).toBeGreaterThan(1);
    w.liveFeatures(w.md.map).push({
      id: 'late0001',
      type: 'pin',
      name: 'Late Arrival',
      pos: [-5, 5],
      parentId: w.f.Cities,
      rank: 'a9',
    });
    const before = mapWrites();
    const why = await conflicted(String(r.body.proposalId));
    expect(why).toMatch(/FOLDER_CHANGED/);
    expect(mapWrites()).toBe(before);
    expect(stored(w.f.Cities!)).toBeDefined();
    expect(stored('late0001')).toBeDefined();
  });

  it('a feature of a cascade edited after it was approved', async () => {
    const s = await propose('delete_map_feature', { feature: 'Cities', cascade: true, confirm: true });
    expect(s.body.status, s.text).toBe('proposal_captured');
    w.liveFeatures(w.md.map).find((f) => f.id === w.f.Ashgate)!.name = 'Ashgate (renamed)';
    const why = await conflicted(String(s.body.proposalId));
    expect(why).toMatch(/target changed after the proposal|FEATURE_CHANGED/);
    expect(stored(w.f.Ashgate!)).toBeDefined();
  });
});

describe('a direct write: an edit made between its plan and its check inside the lock', () => {
  // The bridge plans (listFeatures #0), then reads the map again inside the lock (listFeatures #1): the app edits the
  // map as that second read arrives, so the check sees what the plan did not.
  it('an update of a feature edited in the app in between sends nothing and says what changed', async () => {
    w.hook('listFeatures', 1, () => {
      w.liveFeatures(w.md.map).find((f) => f.id === w.f['Old Road'])!.color = '#123456';
    });
    const sent = w.sent.length;
    const r = await write('update_map_feature', { ...ARKONA, feature: 'Old Road', name: 'Old Road 2' });
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error.differences[0].path).toMatch(/FEATURE_CHANGED/);
    expect(r.body.error.written).toEqual([]);
    expect(w.sent.length).toBe(sent);
    expect(stored(w.f['Old Road']!)!.name).toBe('Old Road');
    // asking again, on what the map holds now, works
    const again = await write('update_map_feature', { ...ARKONA, feature: 'Old Road', name: 'Old Road 2' });
    expect(again.body.status, again.text).toBe('written');
  });

  it('a create into a folder removed in between sends nothing', async () => {
    w.hook('listFeatures', 1, () => {
      const list = w.liveFeatures(w.md.map);
      list.splice(
        list.findIndex((f) => f.id === w.f.Shrines),
        1,
      );
    });
    const sent = w.sent.length;
    const r = await write('create_map_feature', {
      ...ARKONA,
      type: 'pin',
      name: 'Too Late',
      pixel: { x: 5, y: 5 },
      folder: 'Shrines',
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error.differences[0].path).toMatch(/FOLDER_NOT_FOUND/);
    expect(w.sent.length).toBe(sent);
  });

  it('pixel coordinates chosen on an image that was replaced in between are refused', async () => {
    // plan: getDocument #0; the check inside the lock: getDocument #1, by which time the app has replaced the image
    w.hook('getDocument', 1, () => w.setImage(w.md.map, 'Wide 4096x1024'));
    const sent = w.sent.length;
    const r = await write('create_map_feature', {
      ...ARKONA,
      type: 'pin',
      name: 'Wrong Pixels',
      pixel: { x: 100, y: 100 },
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error.differences[0].path).toMatch(/FRAME_CHANGED/);
    expect(r.body.error.differences[0].actual).toMatch(/4096×1024/);
    expect(w.sent.length).toBe(sent);
    expect(named('Wrong Pixels')).toHaveLength(0);
    w.setImage(w.md.map, 'Arkona 2048x1024');
    // latlng does not depend on the image's pixels: the same change does not stop it
    w.hook('getDocument', 1, () => w.setImage(w.md.map, 'Wide 4096x1024'));
    const ll = await write('create_map_feature', {
      ...ARKONA,
      type: 'pin',
      name: 'By LatLng',
      latlng: [-5, 5],
      allowOutside: true,
    });
    expect(ll.body.status, ll.text).toBe('written');
    w.setImage(w.md.map, 'Arkona 2048x1024');
  });
});

describe('canon: feature edits are ordinary edits (ADR 0036 decision 6, option (a))', () => {
  const CANON = { page: 'Canon Atlas', document: 'Canon map' };
  it('on an Authoritative page, adding, changing and deleting features go straight through at scope write', async () => {
    const a = await write('create_map_feature', { ...CANON, type: 'folder', name: 'Realms' });
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(a.body.status).not.toBe('proposal_captured');
    const b = await write('create_map_feature', {
      ...CANON,
      type: 'pin',
      name: 'Capital',
      pixel: { x: 750, y: 350 },
      folder: 'Realms',
    });
    expect(b.body.status, b.text).toBe('written');
    const c = await write('update_map_feature', {
      ...CANON,
      feature: 'Capital',
      name: 'The Capital',
      link: M_MIYABI,
    });
    expect(c.body.status, c.text).toBe('written');
    const d = await write('delete_map_feature', {
      ...CANON,
      feature: 'Realms',
      cascade: true,
      confirm: true,
    });
    expect(d.body, d.text).toMatchObject({ status: 'written', removedCount: 2 });
    expect(w.features(w.md.canonMap)).toHaveLength(0);
  });

  it('deleting the whole map document of an Authoritative page is canonical: a proposal only the owner can accept as canon', async () => {
    const r = await write('delete_document', { page: 'Canon Atlas', document: 'Canon map', confirm: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    // nothing was deleted
    expect(w.docType(w.md.canonMap)).toBe('map');
  });
});

const M_MIYABI = 'miyabi01';
