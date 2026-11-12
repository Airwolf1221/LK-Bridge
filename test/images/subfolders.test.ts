/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON answers and tool results */
/**
 * The subfolder of a character or page destination (v2 D3.2, the owner's addendum of 12 November 2026): one path written like
 * the folder chain (`Wardrobe`, `Wardrobe / Qipao`), split on `/` with each part trimmed, an empty part, `.` and `..` refused,
 * passed on as the existing `subfolders` list so the folder rules stay as they are. Also as one string in `upload_image`, and
 * the dashboard's dry-run preview of the full resolved path with the new folders marked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { parseSubfolders } from '../../src/images/destination.js';
import { buildModels } from '../discover/world.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const b64 = (name: string) => fixture(name).toString('base64');
const CHAR = ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi'];
const MIYABI = { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } };

async function upload(world: ImagesWorld, args: Record<string, unknown>) {
  const c = await world.stack.connect();
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

function owner(world: ImagesWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  return async (path: string, body: unknown) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

describe('the subfolder path', () => {
  it('splits on / and trims each part: one level, two levels, a list as it is', () => {
    expect(parseSubfolders('Wardrobe')).toEqual({ ok: true, names: ['Wardrobe'] });
    expect(parseSubfolders('Wardrobe / Qipao')).toEqual({ ok: true, names: ['Wardrobe', 'Qipao'] });
    expect(parseSubfolders('  Wardrobe/Qipao  ')).toEqual({ ok: true, names: ['Wardrobe', 'Qipao'] });
    expect(parseSubfolders(['Wardrobe', ' Qipao '])).toEqual({ ok: true, names: ['Wardrobe', 'Qipao'] });
    expect(parseSubfolders(undefined)).toEqual({ ok: true, names: [] });
    expect(parseSubfolders([])).toEqual({ ok: true, names: [] });
  });

  it.each([
    ['a slash at the start', '/Wardrobe', /empty part/],
    ['a slash at the end', 'Wardrobe /', /empty part/],
    ['two slashes in a row', 'Wardrobe // Qipao', /empty part/],
    ['a lone slash', '/', /empty part/],
    ['only spaces', '   ', /subfolder is empty/],
    ['an empty list name', ['Wardrobe', '  '], /empty part/],
    ['a single dot', '.', /not a folder name/],
    ['two dots', 'Wardrobe / ..', /“\.\.” is not a folder name/],
    ['a dot in a list', ['Wardrobe', '.'], /not a folder name/],
    ['too many levels', 'a/b/c/d/e/f/g/h/i/j/k', /At most 10/],
  ])('refuses %s, with a message that says how to write it', (_what, input, message) => {
    const r = parseSubfolders(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_SUBFOLDER');
      expect(r.error.message).toMatch(message);
    }
  });
});

describe('upload_image with a subfolder path', () => {
  it('the string form works for one level and two; the list form is the same', async () => {
    w = await imagesWorld();
    const one = await upload(w, {
      data_base64: b64('alpha.png'),
      name: 'One',
      destination: { ...MIYABI, subfolders: 'Wardrobe' },
    });
    expect(one.body, JSON.stringify(one.body)).toMatchObject({
      status: 'uploaded',
      destination: { path: [...CHAR, 'Wardrobe'] },
    });
    const two = await upload(w, {
      data_base64: b64('animated.gif'),
      name: 'Two',
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao' },
    });
    expect(two.body).toMatchObject({
      status: 'uploaded',
      destination: { path: [...CHAR, 'Wardrobe', 'Qipao'] },
    });
    const qipao = w.assets.at(...CHAR, 'Wardrobe', 'Qipao');
    expect((two.body.asset as { folderId: string }).folderId).toBe(qipao);
    // the list form lands in the same place (a dry run: nothing more is written)
    const list = await upload(w, {
      data_base64: b64('already.webp'),
      name: 'List',
      destination: { ...MIYABI, subfolders: ['Wardrobe', 'Qipao'] },
      dryRun: true,
    });
    expect(list.body).toMatchObject({ destination: { folderId: qipao, createsFolders: [] } });
  });

  it('reuses what exists and creates what is missing, in order', async () => {
    w = await imagesWorld();
    await upload(w, {
      data_base64: b64('alpha.png'),
      name: 'First',
      destination: { ...MIYABI, subfolders: 'Wardrobe' },
    });
    const wardrobe = w.assets.at(...CHAR, 'Wardrobe');
    const dry = await upload(w, {
      data_base64: b64('animated.gif'),
      name: 'Deeper',
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao / Spring' },
      dryRun: true,
    });
    // Wardrobe exists and is reused; Qipao and Spring are new, in that order
    expect(dry.body.destination).toMatchObject({
      path: [...CHAR, 'Wardrobe', 'Qipao', 'Spring'],
      createsFolders: [
        [...CHAR, 'Wardrobe', 'Qipao'].join(' / '),
        [...CHAR, 'Wardrobe', 'Qipao', 'Spring'].join(' / '),
      ],
    });
    const done = await upload(w, {
      data_base64: b64('animated.gif'),
      name: 'Deeper',
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao / Spring' },
    });
    expect(done.body.status).toBe('uploaded');
    expect(w.assets.at(...CHAR, 'Wardrobe')).toBe(wardrobe); // reused, not made again
    expect(w.assets.at(...CHAR, 'Wardrobe', 'Qipao', 'Spring')).toBeTruthy();
  });

  it('a non-folder with a needed folder’s name is a conflict, and nothing is written', async () => {
    w = await imagesWorld();
    await upload(w, { data_base64: b64('alpha.png'), name: 'Seed', destination: MIYABI });
    w.assets.image('Wardrobe', w.assets.at(...CHAR));
    buildModels(w.stack, w.repo, w.assets);
    const before = w.lkUploads.length;
    const r = await upload(w, {
      data_base64: b64('animated.gif'),
      name: 'Clash',
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao' },
    });
    expect(r.body.error).toMatchObject({ code: 'ASSET_NAME_CONFLICT' });
    expect(w.lkUploads).toHaveLength(before);
  });

  it('a bad path is refused before anything is sent, with the reason', async () => {
    w = await imagesWorld();
    for (const [subfolders, message] of [
      ['Wardrobe //Qipao', /empty part/],
      ['..', /not a folder name/],
      ['Wardrobe / .', /not a folder name/],
      ['/', /empty part/],
    ] as const) {
      const r = await upload(w, {
        data_base64: b64('alpha.png'),
        name: 'Bad',
        destination: { ...MIYABI, subfolders },
      });
      expect(r.body.error, subfolders).toMatchObject({ code: 'INVALID_SUBFOLDER' });
      expect(String(r.body.error.message)).toMatch(message);
    }
    expect(w.lkUploads).toHaveLength(0);
  });

  it('works with for_page and a folder id too, and is kept as written on a staged image’s intended destination', async () => {
    w = await imagesWorld();
    const page = await upload(w, {
      data_base64: b64('alpha.png'),
      name: 'Page',
      destination: { for_page: 'miyabi01', subfolders: 'Wardrobe / Qipao' },
      dryRun: true,
    });
    expect(page.body.destination).toMatchObject({ path: [...CHAR, 'Wardrobe', 'Qipao'] });
    const staged = await upload(w, {
      data_base64: b64('animated.gif'),
      name: 'Later',
      stage: true,
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao' },
    });
    expect(staged.body, JSON.stringify(staged.body)).toMatchObject({ status: 'staged' });
    const placed = await upload(w, { staged_id: String(staged.body.staged_id) });
    expect(placed.body).toMatchObject({ destination: { path: [...CHAR, 'Wardrobe', 'Qipao'] } });
  });
});

describe('the dashboard’s preview (a dry run)', () => {
  it('gives the full path with the new folders marked and counted, and writes nothing', async () => {
    w = await imagesWorld();
    await upload(w, {
      data_base64: b64('alpha.png'),
      name: 'Seed',
      destination: { ...MIYABI, subfolders: 'Wardrobe' },
    });
    const post = owner(w);
    const writes = () => w!.seen.filter((l) => !l.startsWith('GET')).length;
    const before = writes();
    const none = await post('/staging/preview?project=test', { destination: MIYABI });
    expect(none.json).toMatchObject({ path: CHAR.join(' / '), newFolders: 0, exists: true, dryRun: true });
    const one = await post('/staging/preview?project=test', {
      destination: { ...MIYABI, subfolders: 'Wardrobe' },
    });
    expect(one.json).toMatchObject({ path: [...CHAR, 'Wardrobe'].join(' / '), newFolders: 0 });
    const two = await post('/staging/preview?project=test', {
      destination: { ...MIYABI, subfolders: 'Wardrobe / Qipao' },
    });
    expect(two.json).toMatchObject({
      path: [...CHAR, 'Wardrobe', 'Qipao'].join(' / '),
      newFolders: 1,
      exists: false,
    });
    expect(two.json.segments.map((s: { new: boolean }) => s.new)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    const fresh = await post('/staging/preview?project=test', {
      destination: {
        for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' },
        subfolders: 'Wardrobe / Qipao',
      },
    });
    expect(fresh.json).toMatchObject({
      path: 'Characters / Beastkin / Qishen / Mehrana al-Khalid / Wardrobe / Qipao',
      newFolders: 2, // the character's folder exists in the model; Wardrobe and Qipao are new (the owner's own example)
    });
    expect(fresh.json.segments.slice(-2).every((s: { new: boolean }) => s.new)).toBe(true);
    expect(writes()).toBe(before);
  });

  it('refuses a bad path (400), a conflict (409) and a missing destination, with the same words as placing', async () => {
    w = await imagesWorld();
    const post = owner(w);
    const bad = await post('/staging/preview?project=test', {
      destination: { ...MIYABI, subfolders: 'A // B' },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: 'INVALID_SUBFOLDER' });
    expect(bad.json.error.message).toMatch(/empty part/);
    const dots = await post('/staging/preview?project=test', {
      destination: { ...MIYABI, subfolders: 'A / ..' },
    });
    expect(dots.json.error.message).toMatch(/not a folder name/);
    await upload(w, { data_base64: b64('alpha.png'), name: 'Seed', destination: MIYABI });
    w.assets.image('Wardrobe', w.assets.at(...CHAR));
    buildModels(w.stack, w.repo, w.assets);
    const clash = await post('/staging/preview?project=test', {
      destination: { ...MIYABI, subfolders: 'Wardrobe' },
    });
    expect(clash.status).toBe(409);
    expect(clash.json.error).toMatchObject({ code: 'ASSET_NAME_CONFLICT' });
    const none = await post('/staging/preview?project=test', {});
    expect(none.status).toBe(400);
    expect(none.json.error).toMatchObject({ code: 'DESTINATION_REQUIRED' });
  });

  it('placing a staged image with a subfolder lands where the preview said, and a bad one is refused before any write', async () => {
    w = await imagesWorld();
    const staged = await upload(w, { data_base64: b64('alpha.png'), name: 'To place', stage: true });
    const stagedId = String(staged.body.staged_id);
    const post = owner(w);
    const dest = { ...MIYABI, subfolders: 'Wardrobe / Qipao' };
    const preview = await post('/staging/preview?project=test', { destination: dest });
    const writes = () => w!.seen.filter((l) => !l.startsWith('GET')).length;
    const before = writes();
    const bad = await post(`/staging/${stagedId}/place?project=test`, {
      destination: { ...MIYABI, subfolders: 'x//y' },
    });
    expect(bad.status).toBe(400);
    expect(writes()).toBe(before);
    const placed = await post(`/staging/${stagedId}/place?project=test`, { destination: dest });
    expect(placed.status, JSON.stringify(placed.json)).toBe(200);
    expect(placed.json).toMatchObject({ status: 'succeeded', verified: true });
    const folder = w.assets.at(...CHAR, 'Wardrobe', 'Qipao');
    expect(folder).toBeTruthy();
    expect(String(preview.json.path)).toBe([...CHAR, 'Wardrobe', 'Qipao'].join(' / '));
  });
});
