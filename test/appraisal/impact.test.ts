/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c, A3 (ADR 0054): `arkona_change_impact`. A planned rename shows the mentions and chronology rows whose text will
 * no longer match as proven breakage, and the restatements as candidates only; a pending proposal's targets are
 * analysed; everything comes from the snapshots (free) unless live: true re-reads the subject.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appraisalWorld, C, O, P, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AppraisalWorld;
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const impact = (args: Record<string, unknown>) =>
  w.call('arkona_change_impact', { limit: 200, detail: 'full', project: 'test', ...args });
const of = (r: any, check: string) => (r.body.findings as any[]).filter((f) => f.check === check);

describe('a planned rename', () => {
  let r: any;
  beforeAll(async () => {
    const before = w.requests();
    r = await impact({ page: C.nadira, renameTo: 'Nadira al-Qasim - Character Core' });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests()).toEqual(before); // free: the snapshots and the index only
  });

  it('the mentions whose displayed text will no longer match are proven breakage, with page, section and snippet', () => {
    const m = of(r, 'mention_label_mismatch');
    const tarim = m.find((f) => f.page.id === O.tarim);
    expect(tarim).toMatchObject({ group: 'proven', evidence: 'Confirmed deterministic defect' });
    expect(tarim.details).toMatchObject({ label: 'Nadira al-Khalid', section: 'Archives', block: 'tr4' });
    expect(tarim.details.snippet).toBe('Its archive was kept by Nadira al-Khalid.');
    // A mention showing another label ("the archivist") does not depend on the name: a review candidate.
    const other = of(r, 'incoming_mention').find((f) => f.details.block === 'tr5');
    expect(other).toMatchObject({ group: 'candidates', page: { id: O.tarim } });
    expect(other.details.label).toBe('the archivist');
  });

  it('the chronology rows naming the subject are proven breakage: the row with a mention and the row in plain text', () => {
    const rows = of(r, 'chronology_row_mismatch');
    expect(rows.map((f) => f.block).sort()).toEqual(['farow1', 'farow2']);
    expect(rows.every((f) => f.group === 'proven' && f.page.id === P.fourthAge)).toBe(true);
    expect(rows.find((f) => f.block === 'farow2').details.snippet).toContain(
      '«Nadira al-Khalid» opens the reading room',
    );
  });

  it('the incoming Dependencies and Related Sources are review candidates while the subject stays current', () => {
    const links = of(r, 'incoming_link');
    const from = links.map((f) => `${f.page.id}:${f.details.property}`).sort();
    expect(from).toEqual(
      [
        `${P.gap}:Related Sources`,
        `${P.heavy}:Related Sources`,
        `${P.nadiraBio}:Related Sources`,
        `${P.relationship}:Dependencies`,
        `${P.relationship}:Related Sources`,
      ].sort(),
    );
    expect(links.every((f) => f.group === 'candidates')).toBe(true);
    expect(of(r, 'link_to_noncurrent')).toEqual([]);
  });

  it('textual restatements are found through the full-text index, and are only ever candidates', () => {
    const re = of(r, 'restatement');
    const qasr = re.find((f) => f.page.id === O.qasr);
    expect(qasr).toMatchObject({ group: 'candidates', evidence: 'Potential Maintenance Issue' });
    expect(qasr.details.snippet).toContain('«Nadira al-Khalid» catalogued');
    expect(qasr.rule).toMatch(/a resource change is not proof every document changed substantively/);
    expect(
      (r.body.findings as any[]).filter((f) => f.check === 'restatement' && f.group !== 'candidates'),
    ).toEqual([]);
    // Text that already links to her (a mention) is listed as the mention, not again as a restatement.
    expect(re.find((f) => f.page.id === O.tarim && f.details.block === 'tr4')).toBeUndefined();
    // Her own page is never its own restatement.
    expect(re.find((f) => f.page.id === C.nadira)).toBeUndefined();
  });

  it('the report names the subject and the rename', () => {
    expect(r.body.inspected.subjects).toEqual([
      {
        id: C.nadira,
        name: '[BSRC] Nadira al-Khalid - Character Core',
        renameTo: 'Nadira al-Qasim - Character Core',
      },
    ]);
    expect(r.body.scope).toMatchObject({ page: C.nadira, renameTo: 'Nadira al-Qasim - Character Core' });
  });
});

describe('a page as it is', () => {
  it('without a rename, mentions and chronology rows are review candidates', async () => {
    const r = await impact({ page: C.nadira });
    expect(of(r, 'mention_label_mismatch')).toEqual([]);
    expect(of(r, 'chronology_row_mismatch')).toEqual([]);
    expect(
      of(r, 'chronology_row')
        .map((f) => f.block)
        .sort(),
    ).toEqual(['farow1', 'farow2']);
    expect(of(r, 'incoming_mention').length).toBeGreaterThanOrEqual(2);
  });

  it('an Archived subject: an Authoritative page’s Related Sources pointing at it is proven breakage', async () => {
    const r = await impact({ page: C.archived });
    const proven = of(r, 'link_to_noncurrent');
    expect(proven.map((f) => f.page.id)).toEqual([P.archivedRelated]);
    expect(proven[0].message).toMatch(/is archived/);
  });

  it('live: true re-reads the subject (one read) and nothing else', async () => {
    const before = w.requests();
    const r = await impact({ page: C.nadira, renameTo: 'Nadira al-Qasim', live: true });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests().all - before.all).toBe(1); // the subject's settings: its name and aliases
    expect(w.requests().writes).toBe(before.writes);
    expect(r.body.source.live).toMatchObject({ reads: 1 });
  });
});

describe('a pending proposal', () => {
  it('each page it changes is analysed: archiving the Biography breaks the Core’s Related Sources', async () => {
    const p = await w.call('archive_page', { page: P.nadiraBio, project: 'test' });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const r = await impact({ proposal: p.body.proposalId });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.inspected.subjects).toEqual([
      expect.objectContaining({ id: P.nadiraBio, becomes: 'Archived' }),
    ]);
    const proven = of(r, 'link_to_noncurrent');
    expect(proven.map((f) => f.page.id)).toEqual([C.nadira]);
    expect(proven[0].message).toMatch(/will be archived/);
    // Nothing was decided: the proposal is still pending.
    expect(w.stack.runtime.policy.proposals.get(p.body.proposalId)!.state).toBe('pending');
  });

  it('a proposal that is no longer pending is refused', async () => {
    const r = await impact({ proposal: 'prop_doesnotexist' });
    expect(r.body.error.code).toBe('PROPOSAL_NOT_FOUND');
  });

  it('a page or a proposal, not both; renameTo needs its page', async () => {
    expect((await impact({ page: C.nadira, proposal: 'prop_x' })).body.error.code).toBe('INVALID_PARAMS');
    expect((await impact({ renameTo: 'X', proposal: 'prop_x' })).body.error.code).toBe('INVALID_PARAMS');
  });
});
