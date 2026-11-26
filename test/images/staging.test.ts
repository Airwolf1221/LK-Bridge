/**
 * Staging (v2 D3, ADR 0041; PLAN-v2 10.2's D3 note): stage, place (move, unhide, rename, read back), discard (bytes
 * kept first), the dashboard's Staging API (upload, place, discard, allow a delete without bytes), and placing a staged
 * image at scope `propose`.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { PROJECT, PUBLIC_URL } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function call(world: ImagesWorld, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

function owner(world: ImagesWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const request = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(raw
          ? { 'content-type': 'application/octet-stream' }
          : body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
      },
      ...(raw ? { body: new Uint8Array(raw) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  };
  return {
    session,
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
    upload: (path: string, raw: Buffer) => request('POST', path, undefined, raw),
    reauth: () => {
      const hash = s.sessionHash(session);
      world.stack.db
        .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
        .run(Math.floor(Date.now() / 1000), hash);
    },
  };
}

describe('staging through upload_image (v3 F2: on the bridge’s server)', () => {
  it('stage → kept on the bridge’s server, nothing sent to LegendKeeper; place uploads it into its final folder with its final name, verified', async () => {
    w = await imagesWorld();
    const lkBefore = w.stack.mock.calls.length;
    const assetsBefore = w.assets.assets.size;
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Draft.png',
      stage: true,
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
    });
    expect(r.body).toMatchObject({
      status: 'staged',
      staging: true,
      onServer: true,
      intendedDestination: 'Characters / Beastkin / Foxians / Asagiri Miyabi',
    });
    expect(r.body.asset).toBeUndefined();
    // v3 F2 (ADR 0049 decision 10): nothing at all was sent to LegendKeeper.
    expect(w.stack.mock.calls.slice(lkBefore)).toEqual([]);
    expect(w.assets.assets.size).toBe(assetsBefore);
    const stagedId = String(r.body.staged_id);
    const row = w.stack.runtime.images.staged(PROJECT, stagedId)!;
    expect(row).toMatchObject({ staged: true, assetId: null, name: 'Draft', state: 'uploaded' });
    expect(row.serverSha256).toBe(row.webp.sha256);
    const kept = await w.stack.runtime.images.stagedImage(PROJECT, stagedId);
    expect(kept && sha(kept)).toBe(row.webp.sha256);
    // Place it (its intended destination), renamed: one upload, straight into the final folder, verified.
    const p = await call(w, { staged_id: stagedId, name: 'Miyabi at the shrine.png' });
    expect(p.isError, JSON.stringify(p.body)).toBe(false);
    expect(p.body).toMatchObject({ status: 'placed', placementVerified: true });
    const folder = w.assets.at('Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi');
    const placed = w.stack.runtime.images.staged(PROJECT, stagedId)!;
    expect(placed).toMatchObject({
      staged: false,
      folderId: folder,
      name: 'Miyabi at the shrine',
      storedVerified: true,
      serverSha256: null,
    });
    expect(w.assets.assets.get(placed.assetId!)).toMatchObject({
      folderId: folder,
      isHidden: false,
      name: 'Miyabi at the shrine',
    });
    // No hide-and-move: the asset was created in its folder, never updated.
    expect(w.stack.mock.calls.slice(lkBefore).filter((c) => c.method === 'PATCH')).toEqual([]);
    // The server copy is gone once the image is placed.
    expect(await w.stack.runtime.images.stagedImage(PROJECT, stagedId)).toBeNull();
    const again = await call(w, { staged_id: stagedId });
    expect((again.body.error as { code: string }).code).toBe('ALREADY_PLACED');
  });

  it('a name already in the folder is numbered; no display name carries an extension', async () => {
    w = await imagesWorld();
    const first = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Portrait.webp',
      destination: { folder: 'Characters / Humans' },
    });
    expect(first.body).toMatchObject({ status: 'uploaded' });
    expect((first.body.asset as { name: string }).name).toBe('Portrait');
    const r = await call(w, {
      data_base64: fixture('already.webp').toString('base64'),
      name: 'Portrait.jpeg',
      stage: true,
    });
    const p = await call(w, {
      staged_id: String(r.body.staged_id),
      destination: { folder: 'Characters / Humans' },
    });
    expect(p.body).toMatchObject({ status: 'placed', placementVerified: true });
    const names = [...w.assets.assets.values()]
      .filter((a) => a.folderId === w!.assets.at('Characters', 'Humans'))
      .map((a) => a.name)
      .filter((n) => n.startsWith('Portrait'))
      .sort();
    expect(names).toEqual(['Portrait', 'Portrait (2)']);
    expect(names.every((n) => !/\.(png|jpe?g|gif|webp)$/i.test(n))).toBe(true);
  });

  it('discard removes the server copy; expiry warns, then removes a week later; a low disk refuses staging', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Gone',
      stage: true,
    });
    const id = String(r.body.staged_id);
    const o = owner(w);
    const d = await o.post(`/staging/${id}/discard?project=test`, { confirm: true });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(svc.store.upload(PROJECT, id)).toMatchObject({ state: 'discarded', serverSha256: null });
    expect(await svc.stagedImage(PROJECT, id)).toBeNull();

    const old = await call(w, {
      data_base64: fixture('already.webp').toString('base64'),
      name: 'Old',
      stage: true,
    });
    const oldId = String(old.body.staged_id);
    w.stack.db
      .prepare('UPDATE image_uploads SET created_at = ? WHERE id = ?')
      .run(Date.now() - 91 * 86_400_000, oldId);
    expect(await svc.expireStaged([PROJECT])).toEqual({ warned: 1, removed: 0 });
    const listed = (await o.get('/staging?project=test')).json.staged as {
      stagedId: string;
      removedAfter?: number;
    }[];
    expect(listed.find((x) => x.stagedId === oldId)!.removedAfter).toBeGreaterThan(Date.now());
    expect(await svc.expireStaged([PROJECT])).toEqual({ warned: 0, removed: 0 });
    w.stack.db
      .prepare('UPDATE image_uploads SET expiry_warned_at = ? WHERE id = ?')
      .run(Date.now() - 8 * 86_400_000, oldId);
    expect(await svc.expireStaged([PROJECT])).toEqual({ warned: 0, removed: 1 });
    expect(svc.store.upload(PROJECT, oldId)).toMatchObject({ state: 'discarded', staged: false });
    expect(await svc.stagedImage(PROJECT, oldId)).toBeNull();

    svc.freeBytes = () => Promise.resolve(1024);
    (svc.settings.images as { stagingMinFreeBytes: number }).stagingMinFreeBytes = 5 * 1_073_741_824;
    const low = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Low',
      stage: true,
    });
    expect((low.body.error as { code: string }).code).toBe('STAGING_DISK_LOW');
  });

  it('a staged image with no intended destination needs one', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Loose',
      stage: true,
    });
    const p = await call(w, { staged_id: String(r.body.staged_id) });
    expect((p.body.error as { code: string }).code).toBe('DESTINATION_REQUIRED');
    const ok = await call(w, {
      staged_id: String(r.body.staged_id),
      destination: { folder: 'Characters / Humans' },
    });
    expect(ok.body).toMatchObject({ status: 'placed', placementVerified: true });
  });

  it('at scope propose, placing a staged id is a proposal; nothing is in LegendKeeper until approval uploads it', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Owner staged',
      stage: true,
    });
    const stagedId = String(r.body.staged_id);
    const { token } = w.stack.newToken('proposer', 'propose');
    const before = w.assets.assets.size;
    const p = await call(w, { staged_id: stagedId, destination: { folder: 'Characters / Dwarves' } }, token);
    expect(p.body).toMatchObject({ status: 'proposal_captured' });
    expect(w.assets.assets.size).toBe(before);
    const id = String(p.body.proposalId);
    await w.stack.runtime.policy.commands.approve('owner', id);
    const proposals = w.stack.runtime.policy.proposals;
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals.get(id)!.state).toBe('executed');
    const row = w.stack.runtime.images.staged(PROJECT, stagedId)!;
    expect(row.staged).toBe(false);
    expect(w.assets.assets.get(row.assetId!)).toMatchObject({
      folderId: w.assets.at('Characters', 'Dwarves'),
      isHidden: false,
      name: 'Owner staged',
    });
  });
});

describe('the dashboard’s Staging API', () => {
  it('upload (staged on the server, deduplicated), list with the bridge’s own thumbnail, place, discard, and audit', async () => {
    w = await imagesWorld();
    const o = owner(w);
    const up = await o.upload('/staging/upload?project=test&name=Shrine.jpg', fixture('orientation-6.jpg'));
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const img = up.json.image as Record<string, unknown>;
    expect(img).toMatchObject({
      staged: true,
      name: 'Shrine',
      onServer: true,
      width: 20,
      height: 30,
      source: 'dashboard',
    });
    expect(String(img.stagedId)).toMatch(/^img_/);
    const dup = await o.upload('/staging/upload?project=test&name=Again', fixture('orientation-6.jpg'));
    expect(dup.json).toMatchObject({ deduplicated: true, image: { stagedId: img.stagedId } });
    const bad = await o.upload('/staging/upload?project=test&name=Bomb', fixture('bomb.png'));
    expect(bad.status).toBe(422);
    expect((bad.json.error as { code: string }).code).toBe('IMAGE_TOO_MANY_PIXELS');

    const second = await o.upload('/staging/upload?project=test&name=Other', fixture('alpha.png'));
    const list = await o.get('/staging?project=test');
    expect(list.status).toBe(200);
    const staged = list.json.staged as { stagedId: string; url: string | null; thumbnail?: string }[];
    expect(staged).toHaveLength(2);
    expect(staged[0]!.url).toBeNull();
    // The thumbnail is the bridge's own copy, behind the owner's session.
    const thumb = staged.find((x) => x.stagedId === img.stagedId)!.thumbnail!;
    const t = await fetch(`${w.stack.base}${thumb}`, {
      headers: { cookie: `${w.stack.services.owner.sessionCookie}=${o.session}`, origin: PUBLIC_URL },
    });
    expect(t.status).toBe(200);
    expect(t.headers.get('content-type')).toBe('image/webp');
    expect((await fetch(`${w.stack.base}${thumb}`)).status).toBe(401);

    const place = await o.post(`/staging/${String(img.stagedId)}/place?project=test`, {
      destination: { for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' } },
    });
    expect(place.status, JSON.stringify(place.json)).toBe(200);
    expect(place.json).toMatchObject({ status: 'succeeded', verified: true, image: { staged: false } });

    const otherImg = second.json.image as { stagedId: string };
    const discard = await o.post(`/staging/${otherImg.stagedId}/discard?project=test`, { confirm: true });
    expect(discard.status, JSON.stringify(discard.json)).toBe(200);
    expect(w.stack.runtime.images.store.upload(PROJECT, otherImg.stagedId)!.state).toBe('discarded');

    const actions = (
      w.stack.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'staging.%'").all() as {
        action: string;
      }[]
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['staging.upload', 'staging.place', 'staging.discard']));
    expect((await o.get('/staging?project=test')).json.staged).toEqual([]);
  });

  it('old staged images are reported, never removed', async () => {
    w = await imagesWorld();
    const o = owner(w);
    const up = await o.upload('/staging/upload?project=test&name=Old', fixture('alpha.png'));
    const id = (up.json.image as { stagedId: string }).stagedId;
    w.stack.db
      .prepare('UPDATE image_uploads SET created_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 86_400_000, id);
    const list = await o.get('/staging?project=test');
    expect(list.json.old).toBe(1);
    expect(w.stack.runtime.images.oldStaged(PROJECT).map((r) => r.id)).toEqual([id]);
    await w.stack.runtime.images.sweep();
    expect(w.stack.runtime.images.staged(PROJECT, id)!.staged).toBe(true);
  });

  it('needs the owner session and CSRF; allowing a delete without bytes needs no fresh code (ADR 0081)', async () => {
    w = await imagesWorld();
    const anon = await fetch(`${w.stack.base}/api/admin/staging?project=test`);
    expect(anon.status).toBe(401);
    const o = owner(w);
    const noCsrf = await fetch(`${w.stack.base}/api/admin/staging/upload?project=test&name=x`, {
      method: 'POST',
      headers: {
        cookie: `${w.stack.services.owner.sessionCookie}=${o.session}`,
        origin: PUBLIC_URL,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(fixture('alpha.png')),
    });
    expect(noCsrf.status).toBe(403);
    const ok = await o.post('/staging/allow-delete?project=test', { assetId: 'a1', confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(w.stack.runtime.images.store.overrides(PROJECT)[0]).toMatchObject({ assetId: 'a1', usedAt: null });
  });
});
