/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * ADR 0059 amendment 1 (the owner's tests, 19 November 2026): a split's new owners are complete.
 *
 * - Source Boundaries and Unresolved Material: when the source has either, each new owner addresses it, by items moved
 *   from it (they go under the section's own heading), by the agent's text, or as not applicable with a reason the
 *   proposal shows the owner; otherwise SPLIT_SECTIONS_UNADDRESSED. The bridge never writes these sections itself.
 * - Dependencies: the source's own are suggested as each new owner's starting list; an empty list needs an explicit
 *   none with a reason (SPLIT_DEPENDENCIES_UNADDRESSED).
 * - What is still owed is listed under nextSteps, each with its tool, in the plan and in the split's report.
 * - A split's new owner passes the appraisal's boundaries_missing rule; one whose sections were "not applicable" is
 *   still flagged (the rule is a judgement the owner keeps).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveSplit, bodyOf, refusal, split, textOf } from '../../packs/split-helpers.js';
import { NO_DEPENDENCIES, NOT_APPLICABLE, statutesSplit, zahraSplit } from '../../packs/split-inputs.js';
import { S, splitWorld, type SplitWorld } from '../../packs/split-world.js';

type Obj = Record<string, any>;

const SORCERY = { id: S.sorcery, name: '[BSRC] Salahad Sorcery - Magic Reference' };

/** Zahra's split with the destination `key` changed by `patch` (a key set to undefined is removed). */
function zahraWith(key: string, patch: Obj) {
  const base = zahraSplit();
  return {
    ...base,
    destinations: (base.destinations as Obj[]).map((d) => {
      if (d.key !== key) return d;
      const out: Obj = { ...d, ...patch };
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete out[k];
      return out;
    }),
  };
}

describe('the plan refuses a new owner that leaves a section or its Dependencies unaddressed', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  // CR-2026-11-R4 (the owner's request): the sections are asked only of the kinds of page the pack expects to carry them
  // (splits.sections), so SC-1 asks the relationship owner (its role expects both); a specialist page such as the
  // Biography is no longer asked (test/review/r4-owner/split-sections.test.ts).
  it('SC-1 a new owner that does not address Source Boundaries or Unresolved Material: SPLIT_SECTIONS_UNADDRESSED', async () => {
    const writes = w.requests().writes;
    const r = await split(w, { ...zahraWith('rel', { notApplicable: undefined }), dryRun: true });
    const hit = refusal(r, 'SPLIT_SECTIONS_UNADDRESSED');
    expect(hit.unaddressed).toEqual([
      { destination: 'rel', section: 'Source Boundaries' },
      { destination: 'rel', section: 'Unresolved Material' },
    ]);
    expect(hit.fields).toEqual({
      'Source Boundaries': 'sourceBoundaries',
      'Unresolved Material': 'unresolvedMaterial',
    });
    expect(hit.message).toContain('notApplicable');
    expect(hit.message).toContain('never writes these sections itself');
    // One section answered, the other not: only the other is listed.
    const half = await split(w, {
      ...zahraWith('rel', { notApplicable: { unresolvedMaterial: NOT_APPLICABLE.unresolvedMaterial } }),
      dryRun: true,
    });
    expect(refusal(half, 'SPLIT_SECTIONS_UNADDRESSED').unaddressed).toEqual([
      { destination: 'rel', section: 'Source Boundaries' },
    ]);
    expect(w.requests().writes).toBe(writes);
  });

  it('SC-2 a new owner with no Dependencies and no reason: SPLIT_DEPENDENCIES_UNADDRESSED, suggesting the source’s own', async () => {
    const r = await split(w, { ...zahraWith('bio', { noDependencies: undefined }), dryRun: true });
    const hit = refusal(r, 'SPLIT_DEPENDENCIES_UNADDRESSED');
    expect(hit.destinations).toEqual(['bio']);
    expect(hit.suggested).toEqual([SORCERY]);
    expect(hit.message).toContain('[BSRC] Salahad Sorcery - Magic Reference');
    expect(r.body.error.preview.suggestedDependencies).toEqual([SORCERY]);
    // The suggestion taken (the agent kept it): planned.
    const kept = await split(w, {
      ...zahraWith('bio', { noDependencies: undefined, dependencies: [S.sorcery] }),
      dryRun: true,
    });
    expect(kept.isError, kept.text).toBe(false);
    expect(kept.body.completeness.owners.find((o: Obj) => o.key === 'bio').dependencies).toEqual({
      count: 1,
    });
  });

  it('SC-3 an answer and "not applicable" for the same thing: SPLIT_COMPLETENESS_CONFLICT', async () => {
    const r = await split(w, {
      ...zahraWith('bio', {
        sourceBoundaries: 'Drawn from her caravan ledgers only.',
        dependencies: [S.sorcery],
      }),
      dryRun: true,
    });
    const hit = refusal(r, 'SPLIT_COMPLETENESS_CONFLICT');
    expect(hit.conflicts).toEqual([
      'bio: “Source Boundaries” is marked not applicable but its text is given',
      'bio: Dependencies are listed and also said to be none (noDependencies)',
    ]);
    // Items moved from the section and "not applicable" for it conflict too.
    const moved = await split(w, {
      ...zahraWith('powers', { notApplicable: { unresolvedMaterial: 'None.' } }),
      dryRun: true,
    });
    expect(refusal(moved, 'SPLIT_COMPLETENESS_CONFLICT').conflicts).toEqual([
      'powers: “Unresolved Material” is marked not applicable but items of it move there',
    ]);
  });

  it('SC-4 the plan says how each new owner is addressed, shows every reason, and lists what is still owed', async () => {
    const r = await split(w, { ...zahraSplit(), dryRun: true });
    expect(r.isError, r.text).toBe(false);
    const c = r.body.completeness;
    expect(c.suggestedDependencies).toEqual([SORCERY]);
    const of = (key: string) => c.owners.find((o: Obj) => o.key === key);
    expect(of('bio')).toMatchObject({
      sections: [
        { section: 'Source Boundaries', by: 'not applicable', reason: NOT_APPLICABLE.sourceBoundaries },
        { section: 'Unresolved Material', by: 'not applicable', reason: NOT_APPLICABLE.unresolvedMaterial },
      ],
      dependencies: { none: NO_DEPENDENCIES.reason },
    });
    expect(of('wardrobe').sections).toContainEqual({ section: 'Unresolved Material', by: 'moved' });
    // The universal owner whose application text goes to Powers is its Dependency.
    expect(of('powers').dependencies).toEqual({ count: 1 });
    // The owner reads the reasons on the item itself.
    const bio = (r.body.items.list as Obj[]).find((i) => i.id === 'dest:bio')!;
    expect(bio.label).toContain(`“Source Boundaries” not applicable: “${NOT_APPLICABLE.sourceBoundaries}”`);
    expect(bio.label).toContain(`no Dependencies: “${NO_DEPENDENCIES.reason}”`);
    // Still owed: the surviving source's pages that depend on it (set_facts), each new owner's answers to revisit.
    const steps = r.body.nextSteps as Obj[];
    expect(steps).toContainEqual(
      expect.objectContaining({
        page: { id: expect.any(String), name: '[BSRC] Sultanate of Tarim - Historical Polity Reference' },
        tool: 'set_facts',
      }),
    );
    expect(
      steps.filter((s) => s.tool === 'write_page' && /no “Source Boundaries”/.test(s.what)),
    ).toHaveLength(6);
    expect(steps.filter((s) => s.tool === 'set_facts' && /has no Dependencies/.test(s.what))).toHaveLength(5);
  });
});

describe('a split’s new owner passes the appraisal’s boundaries_missing rule', () => {
  let w: SplitWorld;
  let lawId: string;
  let proposal: Obj;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const base = statutesSplit();
    const r = await split(w, {
      ...base,
      destinations: (base.destinations as Obj[]).map((d) =>
        d.key === 'law'
          ? {
              ...d,
              notApplicable: undefined,
              noDependencies: undefined,
              // Supplied: the agent's text (the source's own stays with the retired source's record).
              sourceBoundaries: 'The statutes as the charter states them; the assize rolls are not drawn on.',
              dependencies: [S.ostrandPolity],
            }
          : d,
      ),
      // Moved: the open question about the assize goes with the Law owner (its heading is added there).
      map: (base.map as Obj[]).map((e) =>
        e.section === 'Unresolved Material'
          ? {
              section: 'Unresolved Material',
              blocks: [
                { ids: ['sh6'], to: 'stays' },
                { ids: ['su1'], to: 'law' },
              ],
            }
          : e,
      ),
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    proposal = r.body;
    lawId = (proposal.destinations as Obj[]).find((d) => d.key === 'law')!.page.id;
  });
  afterAll(() => w?.close());

  it('SC-5 the proposal records how the Law owner is addressed; phase 1 writes both sections there', async () => {
    expect(proposal.completeness.owners).toEqual([
      {
        key: 'law',
        page: { id: lawId, name: expect.stringContaining('Ostrand Statutes') },
        sections: [
          { section: 'Source Boundaries', by: 'supplied' },
          { section: 'Unresolved Material', by: 'moved' },
        ],
        dependencies: { count: 1 },
      },
    ]);
    const done = await approveSplit(w, String(proposal.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const body = bodyOf(w, lawId);
    const headings = body.filter((b) => b.kind === 'heading').map(textOf);
    expect(headings).toEqual(expect.arrayContaining(['Source Boundaries', 'Unresolved Material']));
    const at = (t: string) => body.findIndex((b) => b.kind === 'heading' && textOf(b) === t);
    // The moved item under its section's heading; the agent's text under its own.
    expect(body[at('Unresolved Material') + 1]!.id).toBe('su1');
    expect(textOf(body[at('Source Boundaries') + 1]!)).toContain('the assize rolls are not drawn on');
  });

  it('SC-6 the appraisal (live) finds no boundaries_missing on the new owner', async () => {
    const r = await w.call('arkona_appraise_owner', { page: lawId, live: true, project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect((r.body.findings as Obj[]).map((f) => f.check)).not.toContain('boundaries_missing');
  });
});

describe('a new owner whose sections were "not applicable" is still a judgement for the appraisal', () => {
  let w: SplitWorld;
  let lawId: string;
  let splitId: string;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    lawId = (r.body.destinations as Obj[]).find((d) => d.key === 'law')!.page.id;
    splitId = String(r.body.split);
    const done = await approveSplit(w, String(r.body.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
  });
  afterAll(() => w?.close());

  it('SC-7 the appraisal flags boundaries_missing (the control), and the split’s report lists it under nextSteps', async () => {
    const a = await w.call('arkona_appraise_owner', { page: lawId, live: true, project: 'test' });
    expect(a.isError, a.text).toBe(false);
    expect((a.body.findings as Obj[]).map((f) => f.check)).toContain('boundaries_missing');
    const rep = await split(w, { report: splitId });
    expect(rep.isError, rep.text).toBe(false);
    const steps = rep.body.nextSteps as Obj[];
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: { id: lawId, name: expect.any(String) },
          tool: 'write_page',
          what: expect.stringContaining(
            `no “Source Boundaries” (not applicable: “${NOT_APPLICABLE.sourceBoundaries}”)`,
          ),
        }),
        expect.objectContaining({
          page: { id: lawId, name: expect.any(String) },
          tool: 'set_facts',
          what: expect.stringContaining('has no Dependencies'),
        }),
      ]),
    );
  });
});
