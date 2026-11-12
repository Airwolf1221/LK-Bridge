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

describe('staging through upload_image', () => {
  it('stage → hidden in the staging folder (created), verified, with its intended destination; place moves, unhides, renames, reads back', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Draft',
      stage: true,
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
    });
    expect(r.body).toMatchObject({
      status: 'staged',
      staging: true,
      storedBytesVerified: true,
      intendedDestination: 'Characters / Beastkin / Foxians / Asagiri Miyabi',
      destination: { path: ['LK-Bridge staging'], createsFolders: ['LK-Bridge staging'] },
    });
    const stagedId = String(r.body.staged_id);
    const assetId = (r.body.asset as { id: string }).id;
    const staging = w.assets.at('LK-Bridge staging');
    expect(w.assets.assets.get(assetId)).toMatchObject({ folderId: staging, isHidden: true });
    const row = w.stack.runtime.images.staged(PROJECT, stagedId)!;
    expect(row).toMatchObject({
      staged: true,
      principalId: expect.any(String) as unknown,
      webp: { bytes: expect.any(Number) as unknown },
    });
    // A second staged image reuses the staging folder.
    const r2 = await call(w, {
      data_base64: fixture('already.webp').toString('base64'),
      name: 'Second',
      stage: true,
    });
    expect(r2.body).toMatchObject({ status: 'staged', destination: { createsFolders: [] } });
    // Place it (the intended destination), renamed.
    const p = await call(w, { staged_id: stagedId, name: 'Miyabi at the shrine.png' });
    expect(p.isError, JSON.stringify(p.body)).toBe(false);
    expect(p.body).toMatchObject({ status: 'placed', placementVerified: true, name: 'Miyabi at the shrine' });
    const folder = w.assets.at('Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi');
    expect(w.assets.assets.get(assetId)).toMatchObject({
      folderId: folder,
      isHidden: false,
      name: 'Miyabi at the shrine',
    });
    expect(w.stack.runtime.images.staged(PROJECT, stagedId)).toMatchObject({
      staged: false,
      folderId: folder,
      name: 'Miyabi at the shrine',
    });
    const again = await call(w, { staged_id: stagedId });
    expect((again.body.error as { code: string }).code).toBe('ALREADY_PLACED');
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

  it('at scope propose, placing a staged id is a proposal; approval places it', async () => {
    w = await imagesWorld();
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Owner staged',
      stage: true,
    });
    const stagedId = String(r.body.staged_id);
    const assetId = (r.body.asset as { id: string }).id;
    const { token } = w.stack.newToken('proposer', 'propose');
    const p = await call(w, { staged_id: stagedId, destination: { folder: 'Characters / Dwarves' } }, token);
    expect(p.body).toMatchObject({ status: 'proposal_captured' });
    expect(w.assets.assets.get(assetId)!.isHidden).toBe(true);
    const id = String(p.body.proposalId);
    await w.stack.runtime.policy.commands.approve('owner', id);
    const proposals = w.stack.runtime.policy.proposals;
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals.get(id)!.state).toBe('executed');
    expect(w.assets.assets.get(assetId)).toMatchObject({
      folderId: w.assets.at('Characters', 'Dwarves'),
      isHidden: false,
    });
    expect(w.stack.runtime.images.staged(PROJECT, stagedId)!.staged).toBe(false);
  });
});

describe('the dashboard’s Staging API', () => {
  it('upload (staged, verified, deduplicated), list, place, discard (bytes kept first), and audit', async () => {
    w = await imagesWorld();
    const o = owner(w);
    const up = await o.upload('/staging/upload?project=test&name=Shrine.jpg', fixture('orientation-6.jpg'));
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const img = up.json.image as Record<string, unknown>;
    expect(img).toMatchObject({
      staged: true,
      name: 'Shrine',
      storedVerified: true,
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
    expect(list.json).toMatchObject({ folder: 'LK-Bridge staging', reportDays: 30, old: 0 });
    expect((list.json.staged as unknown[]).length).toBe(2);
    expect((list.json.staged as { url: string | null }[])[0]!.url).toMatch(/^https:\/\/assets\.test:/);

    const place = await o.post(`/staging/${String(img.stagedId)}/place?project=test`, {
      destination: { for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' } },
    });
    expect(place.status, JSON.stringify(place.json)).toBe(200);
    expect(place.json).toMatchObject({ status: 'succeeded', verified: true, image: { staged: false } });

    const otherImg = second.json.image as { stagedId: string; assetId: string };
    const stored = w.served.get(otherImg.assetId)!;
    const discard = await o.post(`/staging/${otherImg.stagedId}/discard?project=test`, { confirm: true });
    expect(discard.status, JSON.stringify(discard.json)).toBe(200);
    expect(discard.json).toMatchObject({ status: 'succeeded', image: { state: 'discarded' } });
    expect(w.assets.assets.has(otherImg.assetId)).toBe(false);
    const pre = w.stack.runtime.engine.queries
      .journalLookup(PROJECT, { includePreImage: true, limit: 50 })
      .find((e) => e.opId === 'deleteAsset' && e.targetId === otherImg.assetId)!;
    expect((pre.preImage as { keptBytes: { sha256: string } }).keptBytes.sha256).toBe(sha(stored));

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

  it('needs the owner session and CSRF; allowing a delete without bytes needs re-authentication', async () => {
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
    const refused = await o.post('/staging/allow-delete?project=test', { assetId: 'a1', confirm: true });
    expect(refused.status).toBe(403);
    expect((refused.json.error as { code: string }).code).toBe('REAUTH_REQUIRED');
    o.reauth();
    const ok = await o.post('/staging/allow-delete?project=test', { assetId: 'a1', confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(w.stack.runtime.images.store.overrides(PROJECT)[0]).toMatchObject({ assetId: 'a1', usedAt: null });
  });
});
