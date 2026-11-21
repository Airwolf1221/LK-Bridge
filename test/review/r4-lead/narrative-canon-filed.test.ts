/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R4 (the lead; R4-06's fix and NA-43): canon filed under Narratives (the owner's approval of a move, or the
 * owner in the app) is canon still. R4-06's fix made `arkona_chapter_check` resolve a chapter's names against the pages
 * outside Narratives only, so that a name known only from fiction stays a new-lore candidate; a canon character whose
 * pages were all filed under Narratives was then listed as "Not in canon (candidate)": false. A page whose name carries
 * a lifecycle prefix counts as canon wherever it sits, as the facts index now reads it (NA-43). Asserts the SAFE
 * behaviour.
 *
 * - LD-10 (control first): "Ilyas Varga", named nowhere, is a candidate; his `[BSRC]` Core filed under Main CANON in the
 *   app, he is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { N, narrativeWorld, type NarrativeWorld } from '../../narrative/world.js';

const STORY = 'Quay Lights';
let w: NarrativeWorld;

beforeAll(async () => {
  w = await narrativeWorld();
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  expect(
    (await w.tool('arkona_chapter_plan', { story: STORY, number: 1, questionGate: 'closed' })).status,
  ).toBe('written');
  const saved = await w.tool('arkona_chapter_save', {
    story: STORY,
    number: 1,
    title: 'Lamps',
    inWorldDate: 'Camue 2nd, 4A 400',
    pov: 'Leila Darvish',
    charactersPresent: ['Leila Darvish'],
    locations: [],
    draftStatus: 'Draft',
    markdown: 'At dusk Ilyas Varga walked the quay. The lamps burned below.',
  });
  expect(saved.status, JSON.stringify(saved)).toBe('written');
  await w.snapshot();
}, 300_000);
afterAll(async () => w?.close());

const candidates = (b: any) =>
  ((b.items ?? []) as any[]).filter((i) => i.kind === 'name' && /Varga/.test(String(i.name ?? i.what)));

describe('canon filed under Narratives is canon still (LD-10)', () => {
  it('LD-10: a canon character whose pages are all under Narratives is never a new-lore candidate', async () => {
    const before = await w.tool('arkona_chapter_check', { story: STORY, number: 1 });
    expect(candidates(before), `control: ${JSON.stringify(before.items ?? before)}`).toHaveLength(1);
    // The owner files the character's canon Core under Main CANON (inside Narratives) in the app.
    w.repo.seed({ name: '[BSRC] Ilyas Varga - Character Core', parentId: N.main, tags: ['CANON'] });
    w.rebuildTree();
    await w.snapshot();
    const after = await w.tool('arkona_chapter_check', { story: STORY, number: 1 });
    expect(candidates(after), JSON.stringify(after.items ?? after)).toEqual([]);
  });
});
