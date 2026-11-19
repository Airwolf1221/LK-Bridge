/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): phase 2 and selective approval (ADR 0059 decisions 3 "Items", 4 and D6), and the
 * universal assignment (D3). Each test asserts the SAFE behaviour: a pass means the attempt HELD, a failure is a bypass.
 *
 * - SP-35: a retiring split approved without one remapped Dependency: no phase 2, and the page keeps its Dependency.
 * - SP-36: the monolith split approved without the destination its universal material's application text goes to:
 *   the universal block stays with the rest of its section (nothing deleted).
 * - SP-37: an image (an Appearance reference image) assigned to a universal destination: the visual audit refuses it,
 *   or the image is still on a page after phase 1.
 * - SP-38: the proposal tells the owner, in an item, the text of the universal material phase 1 deletes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit, zahraSplit } from '../../packs/split-inputs.js';
import { approveSplit, bodyOf, linksOf, recordOf, split, type Obj } from '../../packs/split-helpers.js';
import { holders, propose, PROJECT, S } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('SP-35: a retiring split approved without one remapped Dependency', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-35 phase 2 is withheld and the page keeps depending on the source', async () => {
    const p = await propose(w, statutesSplit());
    expect(p.items).toContain(`dep:${S.assizes}`);
    const done = await approveSplit(
      w,
      p.proposalId,
      p.items.filter((x) => x !== `dep:${S.assizes}`),
    );
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const rec = await recordOf(w, done.jobId, (x) => x.state !== 'running');
    expect({ state: rec.state, phase2: rec.phase2.proposalId ?? null, dep: linksOf(w, S.assizes) }).toEqual({
      state: 'verified',
      phase2: null,
      dep: [S.statutes],
    });
  });
});

describe('SP-36: the monolith split without the destination its universal text goes to', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-36 the universal block stays in the source with the rest of its section; nothing is lost', async () => {
    const p = await propose(w, zahraSplit());
    const kept = p.items.filter((x) => x !== 'dest:powers');
    const closed = w.stack.runtime.policy.proposals.detail(p.proposalId)!.itemPlan!;
    // Leaving the Powers page out takes with it what needs it (closed selection).
    const needs = (closed.items as any[])
      .filter((i) => i.dependsOn.includes('dest:powers'))
      .map((i) => i.id as string);
    const done = await approveSplit(
      w,
      p.proposalId,
      kept.filter((x) => !needs.includes(x)),
    );
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const src = bodyOf(w, S.zahra).map((b) => b.id);
    expect(['zh8', 'zw4', 'zw5', 'zw6', 'zu1', 'zu2'].filter((id) => !src.includes(id))).toEqual([]);
  });
});

describe('SP-37: an image assigned to universal material', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-37 an image assigned to a universal destination is refused by the visual audit, or survives phase 1', async () => {
    const base = zahraSplit();
    const input = {
      ...base,
      destinations: [
        ...(base.destinations as Obj[]),
        {
          key: 'portrait',
          kind: 'universal',
          owner: S.sorcery,
          text: 'Her looks follow no rule of sorcery.',
        },
      ],
      map: (base.map as Obj[]).map((e) =>
        e.section === 'Appearance'
          ? {
              section: 'Appearance',
              blocks: [
                {
                  ids: ['zh4', 'za1', 'za2', 'zaimg2', 'za3', 'zaimg3', 'za4'],
                  to: 'looks',
                  summary: 'How she looks, with her reference images.',
                },
                { ids: ['zaimg1'], to: 'portrait' },
              ],
            }
          : e,
      ),
    };
    const dry = await split(w, { ...input, dryRun: true });
    const refused = dry.isError === true && JSON.stringify(dry.body).includes('SPLIT_VISUAL');
    let after: string[] = ['(not run)'];
    let state = '-';
    if (!refused) {
      const p = await propose(w, input);
      const done = await approveSplit(w, p.proposalId);
      state = `${done.job.status}`;
      if (done.job.status === 'succeeded')
        state += ` / ${(await recordOf(w, done.jobId, (x) => x.state !== 'running')).state}`;
      after = holders(w, 'zaimg1').map((h) => h.name);
    }
    expect(
      { refused: refused || after.length > 0 },
      `visual audit: ${refused ? 'refused' : 'passed'}; job ${state}; zaimg1 held by: ${after.join(', ') || 'no page'}`,
    ).toEqual({ refused: true });
    void PROJECT;
  });
});

describe('SP-38: what the owner is shown of universal material', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-38 an item of the proposal shows the owner the universal text phase 1 removes', async () => {
    const p = await propose(w, zahraSplit());
    // zw5: "As [Salahad Sorcery] requires of every practitioner, all sorcery is drawn through a focus stone, and the
    // stone cracks when it is overdrawn." Phase 1 deletes it (universal; its application text goes to the Powers page).
    const items = w.stack.runtime.policy.proposals.detail(p.proposalId)!.itemPlan!.items as any[];
    const shown = items.filter((i) => JSON.stringify(i).includes('the stone cracks when it is overdrawn'));
    const powers = items.find((i) => i.id === 'dest:powers');
    expect(
      shown.map((i) => i.id),
      `dest:powers: ${String(powers?.label)} | diff: ${JSON.stringify(powers?.diff ?? null).slice(0, 400)}`,
    ).not.toEqual([]);
  });
});
