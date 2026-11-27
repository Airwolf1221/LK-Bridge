/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): the rest of the attempts. Each test asserts the SAFE behaviour: a pass means the
 * attempt HELD, a failure is a bypass (a finding).
 *
 * - SP-39 (modelled): an inline icon (a run LegendKeeper's write format has no form for) in a block that STAYS in the
 *   source: the source edits write the whole document back, which LegendKeeper refuses. Is it refused at the plan,
 *   before pages are made and material copied?
 * - SP-40: retiring a source while part of a divided section (and the preamble) stays: the owner is warned that it is
 *   archived with the source (SPLIT_RETIRED_CONTENT).
 * - SP-41: phase 2 no longer waits as a proposal (v3 F12, ADR 0081: one job at once, the owner's confirmed follow-up
 *   of an approved phase 1): the source is archived, and a Revert of phase 1 is then refused whole (the archive note
 *   changed the source), nothing reverted.
 * - SP-42 (control): a second split of the same source while the first is pending is refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import { approveSplit, intercept, recordOf, settle, split, type Obj } from '../../packs/split-helpers.js';
import { ownerRevert, para, propose, S, setBody } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('SP-39 (modelled): an inline icon in a block that stays', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-39 a source LegendKeeper cannot take back whole is refused before any page is made', async () => {
    // The Overview's paragraph holds an inline icon (a run the write format has no form for: read, never writable).
    const body = statutesBody() as Obj[];
    body.find((b) => b.id === 'so1')!.content = [
      { text: 'Ostrand keeps its laws ' },
      { icon: 'fas fa-scale-balanced', text: '⚖' },
      { text: ' in one charter.' },
    ];
    setBody(w, S.statutes, body);
    // LegendKeeper refuses a whole-document write holding a run its schema does not allow (400 VALIDATION_ERROR).
    const lk = intercept(w, 'PUT', /\/docs\/[^/]+\/blocks$/, (_n, req) =>
      JSON.stringify(req.body).includes('"icon"')
        ? {
            status: 400,
            body: { code: 'VALIDATION_ERROR', message: 'model: blocks[3].content[1] is not a run' },
          }
        : undefined,
    );
    const writes = w.requests().writes;
    const r = await split(w, statutesSplit());
    let made = 'nothing proposed';
    if (r.body.status === 'proposal_captured') {
      const done = await approveSplit(w, String(r.body.proposalId));
      const lawId = (r.body.destinations as any[]).find((d) => d.key === 'law').page.id as string;
      made = `job ${done.job.status} (${done.job.lastError?.code ?? '-'}): Law page ${w.repo.live(lawId) ? 'made' : 'not made'}, ${w.requests().writes - writes} writes`;
    }
    lk.off();
    // SAFE: refused when planned (the page cannot be written back whole), nothing made.
    expect({ refused: r.isError === true }, `${made}; ${r.text.slice(0, 200)}`).toEqual({ refused: true });
  });
});

describe('SP-40: what stays in a source that is retired', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-40 every block that stays in a retired source is named in the SPLIT_RETIRED_CONTENT warning', async () => {
    const body = statutesBody() as Obj[];
    body.unshift(para('pre1', 'A line before any heading, about the charter’s seal.'));
    setBody(w, S.statutes, body);
    const r = await split(w, {
      ...statutesSplit({
        map: [
          { section: '(preamble)', to: 'stays' },
          ...(statutesSplit().map as Obj[]).map((e) =>
            e.section === 'Law and Courts'
              ? {
                  section: 'Law and Courts',
                  blocks: [
                    { ids: ['sh3', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5'], to: 'law' },
                    { ids: ['sl6'], to: 'stays' },
                  ],
                }
              : e,
          ),
        ],
      }),
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    const warn = ((r.body.warnings ?? []) as any[]).find((x) => x.code === 'SPLIT_RETIRED_CONTENT');
    const named = JSON.stringify(warn ?? {});
    // The pre-heading line and the statute that stays (sl6) are archived with the source too: the owner should see them.
    expect(
      {
        preamble: named.includes('preamble') || named.includes('pre1'),
        sl6: named.includes('Law and Courts'),
      },
      named,
    ).toEqual({
      preamble: true,
      sl6: true,
    });
  });
});

describe('SP-41: phase 2 at once, then phase 1 reverted', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-41 phase 2 archives the source as one job (no proposal); a Revert of phase 1 is then refused whole', async () => {
    const p = await propose(w, statutesSplit());
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const rec = await recordOf(w, done.jobId, (x) => x.state === 'retiring');
    expect(rec.phase2.proposalId).toBeUndefined();
    const phase2 = await settle(w, String(rec.phase2.jobId));
    expect(phase2.status, JSON.stringify(phase2.lastError)).toBe('succeeded');
    expect(phase2.origin.ownerConfirmed).toBe(true);
    expect(w.repo.live(S.statutes)!.name).toMatch(/^\[BARC\]/);
    // The owner reverts phase 1: refused whole (the archive note changed the source), nothing reverted.
    const writes = w.requests().writes;
    const out = await ownerRevert(w, done.jobId);
    expect(out.rv, JSON.stringify(out.rv).slice(0, 600)).toMatchObject({
      status: 'refused',
      code: 'SPLIT_REVERT_NOT_WHOLE',
    });
    expect((out.rv as { message: string }).message).toMatch(/unarchive it first/);
    expect(w.requests().writes).toBe(writes);
    expect(w.repo.live(S.statutes)!.name).toMatch(/^\[BARC\]/);
  });
});

describe('SP-42 (control): a second split of a source with one pending', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-42 is refused while the first is pending', async () => {
    await propose(w, statutesSplit());
    const second = await split(w, {
      ...statutesSplit(),
      destinations: (statutesSplit().destinations as Obj[]).map((d) =>
        d.key === 'law' ? { ...d, name: 'Ostrand Assize Law' } : d,
      ),
    });
    expect(second.isError, second.text).toBe(true);
    expect((second.body as any).error.code).toBe('DUPLICATE_REQUEST');
  });
});
