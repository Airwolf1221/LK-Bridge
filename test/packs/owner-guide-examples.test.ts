/**
 * v3 F3b (ADR 0052): the bridge guide's owner examples (docs/bridge-guide.md › Setting packs (Arkona) › Arkona owners)
 * are valid packages, because agents copy them: each, dry-run against the mock world exactly as the guide gives it, plans
 * with no refusal: a compact polity in its continent's Polities index, and an institution of a nation that is still a
 * compact Reference, the nation given its index in the same proposal (promoteNation).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSection } from '../../src/markdown/index.js';
import { ownersWorld, type OwnersWorld } from './owners-world.js';

const guide = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
const section = getSection(guide, 'Setting packs (Arkona) > Arkona owners').markdown;
const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
  (m) => JSON.parse(m[1]!) as Record<string, unknown>,
);

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('the bridge guide’s Arkona owner examples', () => {
  it('are a polity and an institution with promoteNation, each a dry run on the test project', () => {
    expect(examples.map((e) => [e.type, e.promoteNation ?? false])).toEqual([
      ['Polity', false],
      ['Institution', true],
    ]);
    for (const e of examples) expect(e).toMatchObject({ dryRun: true, project: 'test' });
  });

  it.each([
    [0, [['[BWRK] Kingdom of Saba - Historical Polity Reference', '[INDEX] Working']], []],
    [
      1,
      [
        ['[INDEX] Sultanate of Tarim', '[INDEX] Salahad Polities'],
        ['[BSRC] Diwan of Tarim - Institution Reference', '[INDEX] Sultanate of Tarim'],
      ],
      [
        {
          page: '[BSRC] Sultanate of Tarim - Historical Polity Reference',
          change: 'moved under [INDEX] Sultanate of Tarim (id kept)',
        },
      ],
    ],
  ])('example %i plans with no refusal', async (i, tree, existing) => {
    const r = await w.call('arkona_create_owner', structuredClone(examples[i]!));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status).toBe('dry_run');
    expect(r.body.refusals).toEqual([]);
    expect((r.body.tree as { page: string; parent: string }[]).map((t) => [t.page, t.parent])).toEqual(tree);
    expect(r.body.existing ?? []).toEqual(existing);
  });
});
