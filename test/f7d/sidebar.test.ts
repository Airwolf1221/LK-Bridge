/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F7d (ADR 0077, A8, A9): the Art page's sidebar filled by the bridge: the identity copies (only empty rows; a
 * differing value left alone and reported), the agent's fields (artPage), Temporal Scope and Visual State / Period
 * never copied (listed as still to fill), and Dependencies always gaining the identity page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../packs/world.js';
import type { OwnersWorld } from '../packs/owners-world.js';
import { approveItems, f7dWorld, img, linksOf, pageNamed, rowOf, setRowOf, stage } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await f7dWorld();
});
afterAll(async () => {
  await w?.close();
});

const call = (character: string, args: Record<string, unknown>) =>
  w.call('arkona_add_character_art', { character, project: 'test', ...args });
const run = async (character: string, args: Record<string, unknown>) => {
  const p = await call(character, args);
  expect(p.body.status, p.text).toBe('proposal_captured');
  const done = await approveItems(w, String(p.body.proposalId));
  expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
  expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(true);
  return { p, done };
};

describe('A8, A9: a new Art page', () => {
  it('copies the identity fields, takes the agent’s Visual State, leaves Temporal Scope empty (still to fill), depends on the Core', async () => {
    const id = await stage(w);
    const dry = await call('Mehrana II al-Khalid', {
      groups: [{ images: [img(id, 'Primary Reference - Character Portrait')] }],
      artPage: { visualState: 'Her court years' },
      dryRun: true,
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.sidebar.stillToFill).toEqual(['Temporal Scope']);
    expect(JSON.stringify(dry.body.notes)).toMatch(/Still to fill on the Art page: Temporal Scope/);
    await run('Mehrana II al-Khalid', {
      groups: [{ images: [img(id, 'Primary Reference - Character Portrait')] }],
      artPage: { visualState: 'Her court years' },
    });
    const art = pageNamed(w, '[BSRC] Mehrana II al-Khalid - Character Art')!;
    expect(rowOf(w, art.id, 'Subject')).toBe('Mehrana II al-Khalid');
    expect(rowOf(w, art.id, 'Canonical Display Name')).toBe('Mehrana II al-Khalid');
    expect(rowOf(w, art.id, 'Personal / Given Name')).toBe('Mehrana');
    expect(rowOf(w, art.id, 'Family / Surname')).toBe('al-Khalid');
    expect(rowOf(w, art.id, 'Naming Culture')).toBe('Menkheti');
    expect(rowOf(w, art.id, 'Aliases')).toBe('Mehrana al-Khalid');
    expect(rowOf(w, art.id, 'Visual State / Period')).toBe('Her court years');
    // Never the Core's Temporal Scope ("5A 900 - 5A 931") in its place.
    expect(rowOf(w, art.id, 'Temporal Scope')).toBe('');
    expect(linksOf(w, art.id, 'Dependencies')).toEqual([C.mehrana2]);
  });
});

describe('A8, A9: an existing Art page', () => {
  it('fills only empty rows; a differing value is left alone and reported; artPage applied to empty rows; Dependencies gain the Core', async () => {
    const first = await stage(w);
    await run('Nadira al-Khalid', {
      groups: [{ images: [img(first, 'Primary Reference - Character Portrait')] }],
    });
    const art = pageNamed(w, '[BSRC] Nadira al-Khalid - Character Art')!;
    // As an Art page made before F7d: its copies empty, one of them typed by hand differently, no Dependencies.
    for (const k of ['Canonical Display Name', 'Personal / Given Name', 'Naming Culture', 'Temporal Scope'])
      setRowOf(w, art.id, k, '');
    setRowOf(w, art.id, 'Family / Surname', 'al-Qalid');
    const sb = w.sidebars.pages.get(art.id)!;
    (sb.props.find((p) => p.title === 'Dependencies') as { items: unknown[] }).items = [];
    const id = await stage(w);
    const args = {
      groups: [{ outfit: 'Silk Robe', images: [img(id, 'Outfit Reference - Front')] }],
      artPage: {
        temporalScope: '5A 900 - 5A 931',
        scope: 'Something else',
        related: ['Mehrana I al-Khalid - Character Core'],
      },
    };
    const dry = await call('Nadira al-Khalid', { ...args, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.sidebar.differs).toEqual([
      { key: 'Family / Surname', artPage: 'al-Qalid', identityPage: 'al-Khalid' },
    ]);
    expect(dry.body.sidebar.leftAlone[0]).toMatchObject({ key: 'Scope', given: 'Something else' });
    expect(JSON.stringify(dry.body.warnings)).toMatch(/IDENTITY_COPY_DIFFERS/);
    await run('Nadira al-Khalid', args);
    expect(rowOf(w, art.id, 'Canonical Display Name')).toBe('Nadira al-Khalid');
    expect(rowOf(w, art.id, 'Personal / Given Name')).toBe('Nadira');
    expect(rowOf(w, art.id, 'Naming Culture')).toBe('Menkheti');
    expect(rowOf(w, art.id, 'Family / Surname')).toBe('al-Qalid');
    expect(rowOf(w, art.id, 'Temporal Scope')).toBe('5A 900 - 5A 931');
    expect(rowOf(w, art.id, 'Scope')).not.toBe('Something else');
    expect(linksOf(w, art.id, 'Dependencies')).toEqual([C.nadira]);
    expect(linksOf(w, art.id, 'Related Sources')).toEqual([C.mehrana1]);
  });

  it('the identity page changed after the plan: the sidebar is withdrawn (with why), the images still placed', async () => {
    const art = pageNamed(w, '[BSRC] Nadira al-Khalid - Character Art')!;
    setRowOf(w, art.id, 'Canonical Display Name', '');
    const id = await stage(w);
    const p = await call('Nadira al-Khalid', {
      groups: [{ images: [img(id, 'Primary Reference - Side View')] }],
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    setRowOf(w, C.nadira, 'Aliases', 'Nadi');
    const done = await approveItems(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(w.assets.byName('Nadira al-Khalid - Primary Reference - Side View')).toHaveLength(1);
    expect(rowOf(w, art.id, 'Canonical Display Name')).toBe('');
    const withdrawn =
      (done.job?.result as { withdrawn?: { keys: string[]; reason: string }[] }).withdrawn ?? [];
    expect(withdrawn.some((x) => x.keys.includes('sidebar'))).toBe(true);
  });
});

describe('review: the single-target form is a one-group call of the same planner', () => {
  it('a new Art page: the identity copies, the Core in Dependencies, artPage taken; its answer as before (placement, no groups)', async () => {
    const id = await stage(w);
    const args = {
      outfit: 'Riding Leathers',
      images: [img(id, 'Outfit Reference - Front')],
      artPage: { temporalScope: '5A 920 - 5A 931' },
    };
    const dry = await call('Mehrana I al-Khalid', { ...args, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.placement).toMatchObject({ kind: 'outfit', outfit: 'Riding Leathers', into: 'Wardrobe' });
    expect(dry.body.groups).toBeUndefined();
    expect(dry.body.sidebar.stillToFill).toEqual(['Visual State / Period']);
    await run('Mehrana I al-Khalid', args);
    const art = pageNamed(w, '[BSRC] Mehrana I al-Khalid - Character Art')!;
    expect(rowOf(w, art.id, 'Canonical Display Name')).toBe('Mehrana I al-Khalid');
    expect(rowOf(w, art.id, 'Aliases')).toBe('Mehrana al-Khalid');
    // Her Core leaves Naming Culture blank: nothing to copy.
    expect(rowOf(w, art.id, 'Naming Culture')).toBe('');
    expect(rowOf(w, art.id, 'Temporal Scope')).toBe('5A 920 - 5A 931');
    expect(rowOf(w, art.id, 'Visual State / Period')).toBe('');
    expect(linksOf(w, art.id, 'Dependencies')).toEqual([C.mehrana1]);
  });

  it('an existing Art page: its empty copies filled after the images; a field given twice is refused', async () => {
    const art = pageNamed(w, '[BSRC] Mehrana I al-Khalid - Character Art')!;
    setRowOf(w, art.id, 'Personal / Given Name', '');
    const id = await stage(w);
    await run('Mehrana I al-Khalid', { images: [img(id, 'Primary Reference - Character Portrait')] });
    expect(rowOf(w, art.id, 'Personal / Given Name')).toBe('Mehrana');
    const twice = await call('Mehrana I al-Khalid', {
      images: [img(await stage(w), 'Primary Reference - Profile')],
      scope: 'One',
      artPage: { scope: 'Two' },
    });
    expect(twice.body.error.code).toBe('ART_PAGE_FIELD_TWICE');
  });
});
