/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R4, the owner's queued request: a split's new owners address Source Boundaries and Unresolved Material
 * (ADR 0059 amendment 1) only where the pack expects them. Art and specialist pages had to answer "not applicable" every
 * time. The expectation is pack data (`splits.sections`): by the new owner's Reference Type, else its role in a
 * character's set, else its owner type, else `otherwise`. A version without it keeps amendment 1's rule (every new
 * owner addresses both).
 *
 * - OW-01: Zahra's split with no answers on the specialist and art pages is planned; each records the sections as not
 *   expected, and nothing is owed for them.
 * - OW-02: the relationship owner (its role expects both) still answers: SPLIT_SECTIONS_UNADDRESSED for it alone.
 * - OW-03: the owner names a Reference Type in the pack data (Character Biography): that specialist answers again.
 * - OW-04: a version without `splits.sections` (as before): every new owner answers, as amendment 1 built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PackRules } from '../../../src/packs/types.js';
import { refusal, split } from '../../packs/split-helpers.js';
import { zahraSplit } from '../../packs/split-inputs.js';
import { splitWorld, type SplitWorld } from '../../packs/split-world.js';

type Obj = Record<string, any>;

/** Zahra's split with these destinations' section answers removed (their Dependencies answers kept). */
function zahraUnanswered(keys: readonly string[]) {
  const base = zahraSplit();
  return {
    ...base,
    destinations: (base.destinations as Obj[]).map((d) => {
      if (!keys.includes(d.key)) return d;
      const { notApplicable: _na, ...rest } = d;
      return rest;
    }),
  };
}

const SPECIALISTS_AND_ART = ['bio', 'looks', 'art', 'wardrobe', 'powers'];

describe('the split sections a new owner answers for are pack data (the owner’s request)', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  /** The owner's command: a new version with `patch` applied to the splits rules, approved. */
  async function withSections(sections: unknown): Promise<() => Promise<void>> {
    const packs = w.stack.runtime.packs;
    const before = packs.get('arkona')!.rules;
    const next = { ...before, splits: { ...before.splits!, sections } } as PackRules;
    if (sections === undefined) delete (next.splits as Obj).sections;
    packs.commands.replaceRules('owner', 'arkona', next, 'R4: the split sections');
    await packs.commands.approve('owner', 'arkona');
    return async () => {
      packs.commands.replaceRules('owner', 'arkona', before, 'R4: restored');
      await packs.commands.approve('owner', 'arkona');
    };
  }

  it('OW-01: the specialist and art pages need no answer; each records the sections as not expected, owing nothing', async () => {
    const r = await split(w, { ...zahraUnanswered(SPECIALISTS_AND_ART), dryRun: true });
    expect(r.isError, r.text.slice(0, 600)).toBe(false);
    const of = (key: string) => r.body.completeness.owners.find((o: Obj) => o.key === key);
    for (const key of ['bio', 'looks', 'art'])
      expect(of(key).sections, key).toEqual([
        expect.objectContaining({ section: 'Source Boundaries', by: 'not expected' }),
        expect.objectContaining({ section: 'Unresolved Material', by: 'not expected' }),
      ]);
    const owed = JSON.stringify(r.body.nextSteps ?? []);
    expect(owed).not.toMatch(/not expected/);
  });

  it('OW-02: the relationship owner (its role expects both) still answers: SPLIT_SECTIONS_UNADDRESSED for it alone', async () => {
    const r = await split(w, { ...zahraUnanswered([...SPECIALISTS_AND_ART, 'rel']), dryRun: true });
    expect(refusal(r, 'SPLIT_SECTIONS_UNADDRESSED').unaddressed).toEqual([
      { destination: 'rel', section: 'Source Boundaries' },
      { destination: 'rel', section: 'Unresolved Material' },
    ]);
  });

  it('OW-03: a Reference Type the pack names (Character Biography) answers again', async () => {
    const restore = await withSections({
      ...w.stack.runtime.packs.get('arkona')!.rules.splits!.sections,
      referenceTypes: { 'character biography': ['sourceBoundaries', 'unresolvedMaterial'] },
    });
    try {
      const r = await split(w, { ...zahraUnanswered(SPECIALISTS_AND_ART), dryRun: true });
      expect(refusal(r, 'SPLIT_SECTIONS_UNADDRESSED').unaddressed).toEqual([
        { destination: 'bio', section: 'Source Boundaries' },
        { destination: 'bio', section: 'Unresolved Material' },
      ]);
    } finally {
      await restore();
    }
  });

  it('OW-04: a version without the pack data keeps amendment 1’s rule: every new owner answers', async () => {
    const restore = await withSections(undefined);
    try {
      const r = await split(w, { ...zahraUnanswered(['bio']), dryRun: true });
      expect(refusal(r, 'SPLIT_SECTIONS_UNADDRESSED').unaddressed).toEqual([
        { destination: 'bio', section: 'Source Boundaries' },
        { destination: 'bio', section: 'Unresolved Material' },
      ]);
    } finally {
      await restore();
    }
  });
});
