/**
 * R2-PACKS ATK-09: a pack's Working page created under an index that is no longer in the Working area.
 *
 * A package for a Working character places its new pages under the character's own index, which the plan believes is
 * inside [INDEX] Working (src/packs/engine/plan.ts:576 and :812-813, from the repository tree). The job's marker
 * declares each page `to: 'working'`, so the lifecycle guard allows its `[BWRK]` create (guard.ts:579-590 judges the
 * prefix, not where the page lands; the parent's area at entry is the TREE's, guard.ts:335-342 / :748-751), and inside
 * the lock a template copy that carries a name is not judged at all (guard.ts:1016-1031: only a copy without a name, or
 * with its children). Nothing in the pack's own `pack.absent` check looks at the parent's area either.
 *
 * So when the set has left the Working area (the owner promoted it by hand in LegendKeeper), either before the plan
 * (the tree has not seen it yet: CR-13's "a stale tree", fixed for moves only) or between the job's check and its first
 * write, the job makes a `[BWRK]` page with Status Working and the tag Working inside canon, without any approval.
 *
 * Safe behaviour asserted: no `[BWRK]` page is made outside the Working area.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../../images/world.js';
import { C, LIFECYCLE, packWorld, type PackWorld } from '../../packs/world.js';
import { liveNamed, settle, writeAgent } from './helpers.js';

const inWorkingArea = (w: PackWorld, id: string | null): boolean => {
  for (let cur = id, i = 0; cur && i < 20; i++) {
    if (cur === LIFECYCLE.working) return true;
    cur = w.repo.res.get(cur)?.parentId ?? null;
  }
  return false;
};

/** The owner promotes Tamsin Reed's Working set by hand in LegendKeeper (the bridge's tree has not read it yet). */
function promoteTamsinInTheApp(w: PackWorld): void {
  w.repo.outside.move(C.workingIndex, C.humans);
  w.repo.outside.rename(C.workingIndex, '[INDEX] Tamsin Reed');
  w.repo.outside.rename(C.working, '[BSRC] Tamsin Reed - Character Core');
  w.repo.outside.setTags(C.working, ['CANON', 'Character', 'Human']);
}

describe('ATK-09: the art tool (follows the scope) for a Working character whose set was promoted in the app', () => {
  let w: PackWorld;
  let agent: Awaited<ReturnType<typeof writeAgent>>;
  beforeAll(async () => {
    w = await packWorld({ toolModes: 'seed' });
    agent = await writeAgent(w);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('its [BWRK] Art page must not be made under the (now canon) index', async () => {
    const up = await agent('upload_image', {
      data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([77, 1])]).toString('base64'),
      name: 'r2 tamsin',
      stage: true,
      project: 'test',
    });
    expect(up.isError, up.text).toBe(false);
    promoteTamsinInTheApp(w);
    expect(inWorkingArea(w, C.workingIndex)).toBe(false);
    const r = await agent('arkona_add_character_art', {
      character: 'Tamsin Reed',
      images: [
        {
          staged_id: String(up.body.staged_id),
          label: 'Primary Reference - Portrait',
          interpretation: 'Her face.',
        },
      ],
      project: 'test',
    });
    if (typeof r.body.jobId === 'string') await settle(w, String(r.body.jobId));
    const made = liveNamed(w, '[BWRK] Tamsin Reed - Character Art').map((p) => ({
      name: p.name,
      parent: w.repo.res.get(p.parentId!)?.name ?? null,
      inWorkingArea: inWorkingArea(w, p.parentId),
    }));
    // Safe: nothing made, or (if made) only inside the Working area.
    expect(made.filter((p) => !p.inWorkingArea)).toEqual([]);
  });
});
