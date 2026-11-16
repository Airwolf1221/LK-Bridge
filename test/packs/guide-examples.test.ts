/**
 * v3 F3a (ADR 0050): the bridge guide's Arkona examples (docs/bridge-guide.md › Setting packs (Arkona) › Arkona characters) are
 * valid packages, because agents copy them: each, dry-run against the mock world exactly as the guide gives it (only the
 * staged image's id swapped for a real one), plans with no refusal.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSection } from '../../src/markdown/index.js';
import { fixture } from '../images/world.js';
import { packWorld, type PackWorld } from './world.js';

const guide = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
const section = getSection(guide, 'Setting packs (Arkona) > Arkona characters').markdown;
type Example = Record<string, unknown> & {
  depth: string;
  pages: { images?: { staged_id: string }[] }[];
};
const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as Example);

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('the bridge guide’s Arkona examples', () => {
  it('are a compact and a developed character, each a dry run on the test project', () => {
    expect(examples.map((e) => e.depth)).toEqual(['compact', 'developed']);
    for (const e of examples) expect(e).toMatchObject({ dryRun: true, project: 'test' });
  });

  it.each([
    [0, ['[BWRK] Asagiri Ren - Character Reference']],
    [
      1,
      [
        // The bridge's sibling order: the index first, then by name (a hyphen sorts before “&”).
        '[INDEX] Kurosawa Aoi',
        '[BWRK] Kurosawa Aoi - Biography',
        '[BWRK] Kurosawa Aoi - Character Art',
        '[BWRK] Kurosawa Aoi - Character Core',
        '[BWRK] Kurosawa Aoi & Asagiri Miyabi - Relationship',
      ],
    ],
  ])('example %i plans with no refusal', async (i, pages) => {
    const pkg = structuredClone(examples[i]!);
    for (const p of pkg.pages)
      for (const im of p.images ?? []) {
        const s = await w.call('upload_image', {
          data_base64: fixture('alpha.png').toString('base64'),
          name: 'guide example',
          stage: true,
          project: 'test',
        });
        im.staged_id = String(s.body.staged_id);
      }
    const r = await w.call('arkona_create_character', pkg);
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status).toBe('dry_run');
    expect(r.body.refusals).toEqual([]);
    expect((r.body.tree as { page: string }[]).map((t) => t.page)).toEqual(pages);
  });
});
