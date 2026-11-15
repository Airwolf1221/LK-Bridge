/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * upload_image destinations for pages outside the Characters index (v2 E3b, ADR 0045). The owner's evaluation (scenario 21)
 * got FOLDER_REQUIRED and then PAGE_NOT_UNDER_CHARACTERS for a Working character's pages. Now a character's page (its Core
 * or Reference, its index, a specialist page `{name} - …`), Working or Archived, leads to the character, and the race is
 * its Race / Species fact: from the repository tree, else one live read. Only when neither works does it refuse, and the
 * message says exactly what to pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { LIFECYCLE, SidebarModel, T } from '../resources/world.js';
import { imagesWorld, fixture, type ImagesWorld } from './world.js';

let w: ImagesWorld;
const b64 = fixture('alpha.png').toString('base64');
const FOXIANS = ['Characters', 'Beastkin', 'Foxians', 'E3 Eval Ren'];

async function upload(destination: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const c = await w.stack.connect();
  return w.stack.call(c, 'upload_image', {
    project: 'test',
    data_base64: b64,
    name: 'Probe',
    dryRun: true,
    destination,
    ...extra,
  });
}
const tool = async (name: string, args: Record<string, unknown>) =>
  w.stack.call(await w.stack.connect(), name, { project: 'test', ...args });

/** A character seeded by hand into the mock (an Archived one, or one whose pages are made unusual). */
async function seedCharacter(o: {
  parent: string;
  prefix: '[BARC]' | '[BWRK]';
  name: string;
  race: string | null;
  tag: string;
  idBase: string;
}): Promise<{ index: string; core: string }> {
  const index = `${o.idBase}i`;
  const core = `${o.idBase}c`;
  w.repo.seed({ id: index, name: `[INDEX] ${o.name}`, parentId: o.parent });
  w.sidebars.page(index, [
    SidebarModel.kv(`kvi${o.idBase}`, 'PROPERTIES', [
      ['Reference Type', 'Index'],
      ['Status', 'Active'],
    ]),
  ]);
  w.repo.seed({ id: core, name: `${o.prefix} ${o.name} - Character Core`, parentId: index, tags: [o.tag] });
  w.sidebars.page(core, [
    SidebarModel.kv(`kvc${o.idBase}`, 'PROPERTIES', [
      ['Reference Type', 'Character Core'],
      ['Subject', o.name],
      ['Race / Species', o.race ?? ''],
      ['Status', o.tag],
    ]),
  ]);
  await w.stack.runtime.tree.sweep(PROJECT);
  return { index, core };
}

let renIndex: string;
let renCore: string;
let renArt: string;

beforeAll(async () => {
  w = await imagesWorld();
  const made = await tool('create_character', { kind: 'core', name: 'E3 Eval Ren', race: 'Foxian' });
  expect(made.body, made.text).toMatchObject({ status: 'written' });
  const pages = made.body.pages as { id: string; name: string }[];
  renIndex = pages.find((p) => p.name.startsWith('[INDEX]'))!.id;
  renCore = pages.find((p) => p.name.includes('Character Core'))!.id;
  const art = await tool('create_resource', {
    name: 'E3 Eval Ren - Art',
    template: T.general,
    parent: renIndex,
  });
  expect(art.body, art.text).toMatchObject({ status: 'written' });
  renArt = art.body.pages[0].id;
  await w.stack.runtime.tree.sweep(PROJECT);
});
afterAll(async () => w.close());

describe('a Working character (the owner’s failure cases)', () => {
  it('its Core: PAGE_NOT_UNDER_CHARACTERS no more; the race is its Race / Species fact', async () => {
    const r = await upload({ for_page: renCore });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.destination).toMatchObject({ path: FOXIANS });
    expect(JSON.stringify(r.body)).toContain('Foxian');
  });

  it('its [INDEX]: FOLDER_REQUIRED no more', async () => {
    const r = await upload({ for_page: renIndex });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.destination).toMatchObject({ path: FOXIANS });
  });

  it('a specialist page ({name} - Art), by id or by name, leads to the character through its subject', async () => {
    for (const page of [renArt, 'E3 Eval Ren - Art']) {
      const r = await upload({ for_page: page });
      expect(r.isError, `${page}: ${r.text}`).toBe(false);
      expect(r.body.destination, page).toMatchObject({ path: FOXIANS });
    }
  });

  it('keeps the subfolders: Wardrobe / Qipao (scenario 21), without a live read when the tree has the race', async () => {
    const before = w.stack.mock.calls.length;
    const r = await upload({ for_page: 'E3 Eval Ren - Art', subfolders: 'Wardrobe / Qipao' });
    expect(r.body.destination).toMatchObject({ path: [...FOXIANS, 'Wardrobe', 'Qipao'] });
    expect(r.body.destination.createsFolders.length).toBeGreaterThan(0);
    const reads = w.stack.mock.calls.slice(before).filter((c) => /resources\/\w+\/?$/.test(c.path));
    expect(reads).toEqual([]);
  });

  it('reads the race live, once, when the tree holds none; and writes nothing', async () => {
    w.stack.db.prepare('UPDATE tree_nodes SET sidebar = NULL WHERE id = ?').run(renCore);
    const before = w.stack.mock.calls.length;
    const r = await upload({ for_page: renArt });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.destination).toMatchObject({ path: FOXIANS });
    const fresh = w.stack.mock.calls.slice(before);
    expect(
      fresh.filter((c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${renCore}`)),
    ).toHaveLength(1);
    expect(fresh.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('an unestablished race goes to Undetermined / Unknown; a race that does not resolve fails and is never guessed', async () => {
    const unknown = await tool('create_character', { kind: 'core', name: 'E3 Eval Nameless' });
    expect(unknown.body, unknown.text).toMatchObject({ status: 'written' });
    await w.stack.runtime.tree.sweep(PROJECT);
    const u = await upload({ for_page: 'E3 Eval Nameless - Character Core' });
    expect(u.isError, u.text).toBe(false);
    expect(u.body.destination.path.slice(0, 2)).toEqual(['Characters', 'Undetermined / Unknown']);

    const odd = await seedCharacter({
      parent: LIFECYCLE.working,
      prefix: '[BWRK]',
      name: 'Zork Vale',
      race: 'Zorblax',
      tag: 'Working',
      idBase: 'zv00001',
    });
    const bad = await upload({ for_page: odd.core });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.body.error)).toContain('Zorblax');
    expect(bad.body.error.message).toContain('for_character { name: "Zork Vale", race }');
  });
});

describe('an Archived character', () => {
  it('its Core, its index and its specialist page lead to the character, the race read from its Core', async () => {
    const old = await seedCharacter({
      parent: LIFECYCLE.archived,
      prefix: '[BARC]',
      name: 'Old Hero',
      race: 'Qishen',
      tag: 'Archived',
      idBase: 'oh00001',
    });
    w.repo.seed({ id: 'oh0000s', name: '[BARC] Old Hero - Art', parentId: old.index });
    w.sidebars.page('oh0000s', [
      SidebarModel.kv('kvohs', 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Archived'],
      ]),
    ]);
    await w.stack.runtime.tree.sweep(PROJECT);
    for (const page of [old.core, old.index, 'oh0000s']) {
      const r = await upload({ for_page: page });
      expect(r.isError, `${page}: ${r.text}`).toBe(false);
      expect(r.body.destination, page).toMatchObject({
        path: ['Characters', 'Beastkin', 'Qishen', 'Old Hero'],
      });
    }
  });
});

describe('what it still refuses, and what it says to pass', () => {
  it('a specialist page whose character has no Core or Reference: for_character with the name and race, or a folder', async () => {
    w.repo.seed({ id: 'nb00001', name: '[BWRK] Nobody Here - Notes', parentId: LIFECYCLE.working });
    w.sidebars.page('nb00001', [
      SidebarModel.kv('kvnb', 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Working'],
      ]),
    ]);
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await upload({ for_page: 'nb00001' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('FOLDER_REQUIRED');
    expect(r.body.error.message).toContain('for_character { name: "Nobody Here", race }');
    expect(r.body.error.message).toMatch(/or a folder/);
  });

  it('a page that is no character’s at all (the Characters index): FOLDER_REQUIRED, as before', async () => {
    const r = await upload({ for_page: 'Characters' });
    expect(r.body.error.code).toBe('FOLDER_REQUIRED');
    expect(r.body.error.message).toMatch(/for_character/);
  });

  it('two Cores of one subject in one state are never chosen between', async () => {
    const a = await seedCharacter({
      parent: LIFECYCLE.working,
      prefix: '[BWRK]',
      name: 'Twin Name',
      race: 'Foxian',
      tag: 'Working',
      idBase: 'tw00001',
    });
    const b = await seedCharacter({
      parent: LIFECYCLE.working,
      prefix: '[BWRK]',
      name: 'Twin Name',
      race: 'Qishen',
      tag: 'Working',
      idBase: 'tw00002',
    });
    w.repo.seed({ id: 'tw0000s', name: '[BWRK] Twin Name - Art', parentId: LIFECYCLE.working });
    w.sidebars.page('tw0000s', [
      SidebarModel.kv('kvtws', 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Working'],
      ]),
    ]);
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await upload({ for_page: 'tw0000s' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('CHARACTER_AMBIGUOUS');
    expect(r.body.error.message).toContain(a.core);
    expect(r.body.error.message).toContain(b.core);
    expect(r.body.error.message).toContain('for_character { name: "Twin Name", race }');
  });

  it('a Core with no Race / Species to read: says what to pass (an unknown race is Undetermined / Unknown)', async () => {
    const c = await seedCharacter({
      parent: LIFECYCLE.working,
      prefix: '[BWRK]',
      name: 'Blank Race',
      race: null,
      tag: 'Working',
      idBase: 'br00001',
    });
    const r = await upload({ for_page: c.core });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('RACE_NOT_FOUND');
    expect(r.body.error.message).toContain('for_character { name: "Blank Race", race }');
  });

  it('a folder or for_character given as well still decides; the old way still works', async () => {
    const f = await upload({ for_page: 'E3 Eval Ren - Art', folder: 'Characters / Beastkin / Foxians' });
    expect(f.isError, f.text).toBe(false);
    expect(f.body.destination.path).toEqual(['Characters', 'Beastkin', 'Foxians']);
    const m = await upload({ for_page: 'miyabi01' });
    expect(m.body.destination).toMatchObject({
      path: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi'],
    });
  });
});
