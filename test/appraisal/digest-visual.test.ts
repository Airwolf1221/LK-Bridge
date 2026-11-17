/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c, A4 and A5 (ADR 0054): `arkona_working_digest` (Working pages, open proposals, approved-but-unpromoted sets,
 * declared contradictions; age shown, never judged; a `since` window) and `arkona_visual_hygiene` (every candidate of
 * the design, never a defect repaired automatically).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve, compactPackage } from '../packs/world.js';
import { buildModels } from '../discover/world.js';
import { appraisalWorld, A, C, P, PROJECT, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AppraisalWorld;
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const of = (r: any, check: string) => (r.body.findings as any[]).filter((f) => f.check === check);

describe('the Working digest (A4)', () => {
  it('every Working page with its Status, Scope and age, and each declared contradiction', async () => {
    const before = w.requests();
    const r = await w.call('arkona_working_digest', { limit: 200, detail: 'full', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests()).toEqual(before); // free
    const pages = of(r, 'working_page');
    expect(pages.map((f) => f.page.id).sort()).toEqual([C.draft, C.working, P.hollowWorking].sort());
    const hollow = pages.find((f) => f.page.id === P.hollowWorking);
    expect(hollow).toMatchObject({ group: 'working', evidence: 'Review signal' });
    expect(hollow.details).toMatchObject({ status: 'Working', scope: 'A draft about the Hollow Court' });
    expect(typeof hollow.details.age).toBe('string');
    expect(typeof hollow.details.lastChange).toBe('string');
    expect(hollow.rule).toMatch(/Age alone is a review signal/);
    // Age is shown, never judged: no stale group, no threshold.
    expect(r.body.groups.stale).toBeUndefined();
    const c = of(r, 'declared_contradiction');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      group: 'contradictions',
      evidence: 'Explicitly Unresolved',
      page: { id: P.hollowWorking },
    });
    expect(c[0].details.words).toEqual(['contradicts']);
  });

  it('pending and conflicted proposals, labelled', async () => {
    const pending = await w.call('archive_page', { page: P.nadiraBio, project: 'test' });
    expect(pending.body.status, pending.text).toBe('proposal_captured');
    const other = await w.call('archive_page', { page: P.relationship, project: 'test' });
    expect(other.body.status, other.text).toBe('proposal_captured');
    // A proposal whose target changed before approval ends "conflicted".
    w.stack.db.prepare(`UPDATE proposals SET state = 'conflicted' WHERE id = ?`).run(other.body.proposalId);
    const r = await w.call('arkona_working_digest', { limit: 200, detail: 'full', project: 'test' });
    const open = of(r, 'proposal_open');
    expect(open.map((f) => [f.details.proposalId, f.details.state]).sort()).toEqual(
      [
        [pending.body.proposalId, 'pending'],
        [other.body.proposalId, 'conflicted'],
      ].sort(),
    );
    expect(open.every((f) => f.group === 'proposals')).toBe(true);
  });

  it('a Working set whose package was approved but whose pages are still [BWRK]', async () => {
    const r0 = await w.call('arkona_create_character', compactPackage());
    expect(r0.body.status, r0.text).toBe('proposal_captured');
    const done = await approve(w, r0.body.proposalId);
    expect(done.state).toBe('executed');
    const r = await w.call('arkona_working_digest', { limit: 200, detail: 'full', project: 'test' });
    const u = of(r, 'approved_not_promoted');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ group: 'unpromoted', evidence: 'Potential Maintenance Issue' });
    expect(u[0].details.proposalId).toBe(r0.body.proposalId);
    expect(u[0].details.pages.map((p: any) => p.name)).toEqual(['[BWRK] Asagiri Ren - Character Reference']);
    // The new Working page is in the digest too, found from the job's change snapshot.
    expect(of(r, 'working_page').map((f) => f.page.name)).toContain(
      '[BWRK] Asagiri Ren - Character Reference',
    );
  });

  it('ordered by the most recent change, and `since` keeps only what changed in the window', async () => {
    // Draft Notes last changed ten days ago (as the snapshots record it).
    w.stack.db
      .prepare('UPDATE snapshot_pieces SET taken_at = taken_at - ? WHERE project_id = ? AND page_id = ?')
      .run(10 * 86_400_000, PROJECT, C.draft);
    const all = await w.call('arkona_working_digest', { limit: 200, detail: 'full', project: 'test' });
    const order = of(all, 'working_page').map((f) => f.page.id);
    expect(order[order.length - 1]).toBe(C.draft);
    expect(of(all, 'working_page').find((f) => f.page.id === C.draft).details.lastChangeAge).toMatch(/days/);
    const week = await w.call('arkona_working_digest', {
      since: '7d',
      limit: 200,
      detail: 'full',
      project: 'test',
    });
    expect(of(week, 'working_page').map((f) => f.page.id)).not.toContain(C.draft);
    expect(of(week, 'working_page').map((f) => f.page.id)).toContain(P.hollowWorking);
    expect(week.body.scope).toEqual({ sinceMs: 7 * 86_400_000 });
    expect((await w.call('arkona_working_digest', { since: 'soon', project: 'test' })).body.error.code).toBe(
      'INVALID_PARAMS',
    );
  });
});

describe('visual hygiene (A5)', () => {
  let r: any;
  beforeAll(async () => {
    const before = w.requests();
    r = await w.call('arkona_visual_hygiene', { limit: 200, detail: 'full', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests()).toEqual(before); // free: the asset tree and the snapshots
  });

  it('every candidate of the design, each a candidate (never a defect), labelled', () => {
    const want: [string, string | null][] = [
      ['asset_extension', null],
      ['asset_not_webp', null],
      ['asset_orphan', null],
      ['image_broken', P.nadiraArt],
      ['asset_misplaced', P.nadiraArt],
      ['art_uninterpreted', P.nadiraArt],
      ['primary_conflict', P.nadiraArt],
    ];
    for (const [check, page] of want) {
      const f = of(r, check);
      expect(f, check).toHaveLength(1);
      expect(f[0].group, check).toBe('candidates');
      expect(f[0].evidence, check).toBe('Potential Maintenance Issue');
      expect(f[0].page?.id ?? null, check).toBe(page);
    }
    expect((r.body.findings as any[]).every((f) => f.group === 'candidates')).toBe(true);
  });

  it('the details name the asset, the folder expected and the images in conflict', () => {
    expect(of(r, 'asset_extension')[0].details).toMatchObject({
      asset: { id: A.portraitPng },
      rename: 'Nadira al-Khalid - Primary Reference - Portrait',
    });
    expect(of(r, 'asset_extension')[0].followUp).toMatchObject({ kind: 'fix', tool: 'arkona_appraisal_fix' });
    expect(of(r, 'asset_not_webp')[0].details).toMatchObject({ asset: { id: A.portraitPng }, format: 'png' });
    expect(of(r, 'asset_orphan')[0].details.asset.id).toBe(A.orphan);
    expect(of(r, 'asset_orphan')[0].followUp.kind).toBe('none');
    const mis = of(r, 'asset_misplaced')[0];
    expect(mis.details).toMatchObject({
      asset: { id: A.sketch, path: ['Characters', 'Beastkin', 'Qishen', 'Mehrana I al-Khalid'] },
      expected: ['Characters', 'Beastkin', 'Qishen', 'Nadira al-Khalid'],
    });
    expect(of(r, 'art_uninterpreted')[0].details.label).toBe('Detail - Sketch');
    expect(of(r, 'image_broken')[0].details.label).toBe('Detail - Lost Plate');
    expect(of(r, 'primary_conflict')[0].details.images).toHaveLength(2);
    // The full figure in Forms is inside her folder: no misplaced finding for it.
    expect((r.body.findings as any[]).filter((f) => f.details.asset?.id === A.fullFigure)).toEqual([]);
  });

  it('a page’s scope: only the images it shows, and orphans are said to need the whole library', async () => {
    const p = await w.call('arkona_visual_hygiene', { page: P.nadiraArt, limit: 200, project: 'test' });
    expect(of(p, 'asset_orphan')).toEqual([]);
    expect(of(p, 'asset_misplaced')).toHaveLength(1);
    expect(p.body.couldNotCheck.join(' ')).toMatch(/whole-library run/);
  });

  it('an asset whose bytes the snapshots do not hold yet is a blocked case (Incomplete), never guessed', async () => {
    w.assets.image('Late Arrival', A.unused, { id: 'imglate1', width: 8, height: 4 });
    buildModels(w.stack, w.repo, w.assets);
    const v = await w.call('arkona_visual_hygiene', { limit: 200, project: 'test' });
    const late = of(v, 'format_unknown').filter((f) => f.message.includes('Late Arrival'));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ group: 'blocked', evidence: 'Incomplete' });
    expect(
      of(v, 'asset_not_webp')
        .map((f) => f.message)
        .join(' '),
    ).not.toMatch(/Late Arrival/);
  });
});
