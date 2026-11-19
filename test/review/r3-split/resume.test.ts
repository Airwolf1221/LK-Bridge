/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): a phase 1 that stops part-way: Resume, items skipped when it ran, and "propose these
 * again". Each test asserts the SAFE behaviour: a pass means the attempt HELD, a failure is a bypass (a finding).
 *
 * Claims under attack: "Resume ... its first check runs again, no succeeded step runs again ... and it continues from
 * where it stopped" and "a check that every destination holds what it receives BEFORE anything leaves the source"
 * (ADR 0059 3.4, 6.1); "every original block's text in exactly one place" (3.10); "Propose those items again, then retire
 * it" (the phase 2 reason the service records).
 *
 * - SP-24: phase 1 stopped at its first source edit (another writer kept changing the source: three 412s); while it
 *   was stopped, its new page lost a moved block; then the owner resumes it.
 * - SP-25 (control): phase 1 stopped at its second source edit; resumed with nothing changed: nothing twice.
 * - SP-26: an existing owner's second append (a second heading) skipped after three conflicts, the first already made.
 * - SP-27: "propose these again" for a destination the owner left out.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import {
  approveSplit,
  intercept,
  OWNER_ORIGIN,
  recordOf,
  settle,
  type Obj,
} from '../../packs/split-helpers.js';
import { editBody, holders, propose, PROJECT, S } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ALL = statutesBody().map((b) => b.id);
const CONFLICT = { status: 412, body: { message: 'model VERSION_MISMATCH', code: 'VERSION_MISMATCH' } };
const SOURCE_DOC = new RegExp(`/resources/${S.statutes}/docs/[^/]+/blocks$`);
const RITE_DOC = new RegExp(`/resources/${S.sunRite}/docs/[^/]+/blocks$`);

/** Where each block is, among the pages this split touches (the fixtures reuse a few short ids elsewhere). */
const where = (w: SplitWorld, pages: readonly string[]) =>
  Object.fromEntries(
    ALL.map((id) => [
      id,
      holders(w, id)
        .map((h) => h.pageId)
        .filter((x) => pages.includes(x)),
    ]),
  );

describe('SP-24: Resume after a destination lost a moved block while phase 1 was stopped', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-24 a resumed phase 1 never takes a block out of the source that its destination no longer holds', async () => {
    const p = await propose(w, statutesSplit());
    const lawId = p.pages.get('law')!.id;
    // Another writer keeps changing the source just as its first edit is sent: three conflicts stop the job there,
    // after the destinations check passed and before anything left the source.
    const busy = intercept(w, 'PUT', SOURCE_DOC, (n) => (n < 3 ? CONFLICT : undefined));
    const done = await approveSplit(w, p.proposalId);
    busy.off();
    expect(done.job.status).toBe('failed');
    expect(w.stack.runtime.resume.view(PROJECT, done.jobId).resumable).toBe(true);
    expect(where(w, [S.statutes]).sl2).toEqual([S.statutes]);
    // While it is stopped, the new Law page loses a statute (an edit in the app).
    editBody(w, lawId, (b) => {
      b.splice(
        b.findIndex((x) => x.id === 'sl2'),
        1,
      );
    });
    const out = await w.stack.runtime.resume.resume(PROJECT, done.jobId, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status, JSON.stringify(out)).toBe('resumed');
    const job = await settle(w, done.jobId);
    // SAFE: sl2 is still somewhere (the source keeps what its destination no longer holds).
    expect(
      { sl2: holders(w, 'sl2').map((h) => h.pageId) },
      `resumed job ${job.status} (${job.lastError?.code ?? '-'})`,
    ).toEqual({ sl2: [S.statutes] });
  });
});

describe('SP-25 (control): Resume with nothing changed meanwhile', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-25 a phase 1 stopped between its two source edits resumes: nothing moved or removed twice', async () => {
    const p = await propose(w, statutesSplit());
    const lawId = p.pages.get('law')!.id;
    // The first source edit (Law) goes through; the second (the rite) meets three conflicts.
    const busy = intercept(w, 'PUT', SOURCE_DOC, (n) => (n >= 1 && n <= 3 ? CONFLICT : undefined));
    const done = await approveSplit(w, p.proposalId);
    busy.off();
    expect(done.job.status).toBe('failed');
    const out = await w.stack.runtime.resume.resume(PROJECT, done.jobId, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status, JSON.stringify(out)).toBe('resumed');
    const job = await settle(w, done.jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    const at = where(w, [S.statutes, S.sunRite, lawId]);
    expect(ALL.filter((id) => at[id]!.length !== 1)).toEqual([]);
    const rite = w.repo.blocks.get(w.mainOf(S.sunRite))!.blocks as Obj[];
    expect(rite.filter((b) => b.id === 'sf1').length).toBe(1);
    await recordOf(w, done.jobId, (x) => x.state === 'retiring');
  });
});

describe('SP-26: an existing owner’s second append skipped after three conflicts', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-26 a job that reports verified holds every block in exactly one place', async () => {
    const p = await propose(
      w,
      statutesSplit({
        map: (statutesSplit().map as Obj[]).map((e) =>
          e.section === 'Faith and Worship'
            ? {
                section: 'Faith and Worship',
                blocks: [
                  { ids: ['sh4', 'sf1', 'sf2', 'sf3'], to: 'rite' },
                  { ids: ['sf4', 'sf5', 'sf6'], to: 'rite', under: 'Further Rites' },
                ],
              }
            : e,
        ),
      }),
    );
    const lawId = p.pages.get('law')!.id;
    // The first append (under the destination's heading) goes through; the second meets three conflicts.
    const busy = intercept(w, 'PUT', RITE_DOC, (n) => (n >= 1 && n <= 3 ? CONFLICT : undefined));
    const done = await approveSplit(w, p.proposalId);
    busy.off();
    const rec =
      done.job.status === 'succeeded' ? await recordOf(w, done.jobId, (x) => x.state !== 'running') : null;
    const at = where(w, [S.statutes, S.sunRite, lawId]);
    const twice = ALL.filter((id) => at[id]!.length > 1);
    const verifyStep = (w.stack.runtime.engine.stepRecords(PROJECT, done.jobId) ?? []).at(-1);
    if (done.job.status !== 'succeeded') {
      // CR-2026-11-R3 (R3-23, fixed): the later append is core, so the job stops there (resumable) instead of skipping
      // the destination part-way and verifying; on the reviewed code it succeeded with sh4 and sf1-sf3 in two places.
      expect(done.job.lastError?.code, JSON.stringify(done.job.lastError)).toBe('VERSION_CONFLICT');
      expect(w.stack.runtime.resume.view(PROJECT, done.jobId).resumable).toBe(true);
      const out = await w.stack.runtime.resume.resume(PROJECT, done.jobId, { kind: 'owner' }, OWNER_ORIGIN);
      expect(out.status, JSON.stringify(out)).toBe('resumed');
      const after = await settle(w, done.jobId);
      expect(after.status, JSON.stringify(after.lastError)).toBe('succeeded');
      const now = where(w, [S.statutes, S.sunRite, lawId]);
      expect(ALL.filter((id) => now[id]!.length !== 1)).toEqual([]);
      return;
    }
    // SAFE: if the job reports success (its verification passed), no block is in two places.
    expect(
      { status: done.job.status, twice },
      `job ${done.job.status}; split ${rec?.state ?? '-'} (${rec?.phase2?.reason ?? ''}); last step ${JSON.stringify(verifyStep?.result ?? null).slice(0, 200)}`,
    ).toEqual({ status: done.job.status, twice: [] });
  });
});

describe('SP-27: "propose these again" for a destination the owner left out', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-27 the left-out destination, proposed again and approved, completes the split', async () => {
    const p = await propose(w, statutesSplit());
    const first = await approveSplit(
      w,
      p.proposalId,
      p.items.filter((x) => x !== 'dest:rite'),
    );
    expect(first.job.status, JSON.stringify(first.job.lastError)).toBe('succeeded');
    const rec1 = await recordOf(w, first.jobId, (x) => x.state === 'verified');
    // CR-2026-11-R3 (R3-15, fixed): the way on is a new split of what is left, never "propose these again" from the old
    // plan (its source edits and its verification name the blocks the first job moved). On the reviewed code the
    // message said "Propose those items again", which was then refused with REPROPOSE_FAILED.
    expect(rec1.phase2.reason).toContain('Split what is left as a new split');
    const writes = w.requests().writes;
    await expect(
      w.stack.runtime.policy.commands.reproposeOmitted('owner', p.proposalId, {
        kind: 'ui',
        client: 'owner',
        tool: 'proposal.repropose',
        detail: `repropose:${p.proposalId}`,
      } as never),
    ).rejects.toMatchObject({ code: 'REPROPOSE_REFUSED' });
    expect(w.requests().writes).toBe(writes);
    // What is left (the Faith and Worship section), split on the source as it is now.
    const lawId = p.pages.get('law')!.id;
    const rest = await propose(w, {
      source: S.statutes,
      retire: false,
      destinations: [{ key: 'rite', kind: 'existing', page: S.sunRite, under: 'Worship under the Statutes' }],
      map: [
        { section: 'Purpose', to: 'stays' },
        { section: 'Overview', to: 'stays' },
        { section: 'Faith and Worship', to: 'rite', summary: 'The rite is told with the Sun Rite.' },
        { section: 'Source Boundaries', to: 'stays' },
        { section: 'Unresolved Material', to: 'stays' },
      ],
    });
    const second = await approveSplit(w, rest.proposalId);
    const at = where(w, [S.statutes, S.sunRite, lawId]);
    // SAFE (and the documented way on): the second job verifies, every block in exactly one place.
    expect(
      { status: second.job.status, misplaced: ALL.filter((id) => at[id]!.length !== 1) },
      `second job: ${second.job.lastError?.code ?? '-'} ${String(second.job.lastError?.message ?? '').slice(0, 300)}`,
    ).toEqual({ status: 'succeeded', misplaced: [] });
  });
});
