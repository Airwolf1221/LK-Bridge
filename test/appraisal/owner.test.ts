/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c, A2 (ADR 0054): `arkona_appraise_owner`. Every check of the design's table fires on its own defect page and
 * stays silent on the clean page, in its group with its evidence class and its rule; the audits' findings are gathered,
 * never duplicated; branches page; the non-current areas are left out unless asked for; live: true reads the pages.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appraisalWorld, C, P, PROJECT, type AppraisalWorld } from './world.js';
import { ROOT } from '../discover/world.js';
import { buildModels } from '../discover/world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AppraisalWorld;
let desk: any[];
let qishen: any[];
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
  const d = await w.call('arkona_appraise_owner', {
    under: P.desk,
    limit: 200,
    detail: 'full',
    project: 'test',
  });
  expect(d.isError, d.text).toBe(false);
  desk = d.body.findings;
  // v3 F3f: read a page at a time (the Qishen branch's report, with its routing-line findings, is over the inline size).
  const first = await w.call('arkona_appraise_owner', {
    under: C.qishen,
    limit: 20,
    detail: 'full',
    project: 'test',
  });
  expect(first.isError, first.text).toBe(false);
  qishen = [...first.body.findings];
  for (let offset = first.body.nextOffset; offset !== null;) {
    const q = await w.call('arkona_appraise_owner', {
      runId: first.body.runId,
      offset,
      limit: 20,
      detail: 'full',
      project: 'test',
    });
    expect(q.isError, q.text).toBe(false);
    qishen.push(...q.body.findings);
    offset = q.body.nextOffset;
  }
});
afterAll(async () => w?.close());

const on = (list: any[], pageId: string) => list.filter((f) => f.page?.id === pageId);
const checks = (list: any[], pageId: string) =>
  on(list, pageId)
    .map((f) => f.check as string)
    .sort();

describe('each check on its own page', () => {
  const SF = 'Source Formatting';
  const cases: [string, string, string, string, string, 'fix' | 'judgement'][] = [
    [
      P.noPurpose,
      'purpose_first',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Body Structure`,
      'judgement',
    ],
    [
      P.title,
      'title_repeated',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Body Structure`,
      'judgement',
    ],
    [
      P.headingLink,
      'heading_links',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Body Structure`,
      'fix',
    ],
    [
      P.markdown,
      'literal_markdown',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Body Structure`,
      'judgement',
    ],
    [
      P.blanks,
      'blank_paragraphs',
      'polish',
      'Confirmed deterministic defect',
      `${SF} › Body Structure`,
      'fix',
    ],
    [
      P.dashName,
      'em_dash_name',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Page Names and Templates`,
      'fix',
    ],
    [
      P.dashText,
      'em_dash_text',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Page Names and Templates`,
      'fix',
    ],
    [
      P.extraField,
      'field_improvised',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Sidebar Metadata`,
      'judgement',
    ],
    [
      P.noBoundaries,
      'boundaries_missing',
      'polish',
      'Potential Maintenance Issue',
      `${SF} › Body Structure › where applicable`,
      'judgement',
    ],
    [
      P.workingDep,
      'dependency_noncurrent',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Links, Dependencies and Tags`,
      'judgement',
    ],
    [
      P.archivedRelated,
      'related_noncurrent',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Links, Dependencies and Tags › Related Sources`,
      'fix',
    ],
    [
      P.emptyRelated,
      'related_empty',
      'polish',
      'Potential Maintenance Issue',
      `${SF} › Links, Dependencies and Tags › Related Sources (acceptable after an actual review)`,
      'judgement',
    ],
    [
      P.bareIndex,
      'index_incomplete',
      'required',
      'Confirmed deterministic defect',
      `${SF} › Indexes`,
      'judgement',
    ],
  ];
  it.each(cases)('%s: %s (%s, %s)', (pageId, check, group, evidence, rule, follow) => {
    const f = on(desk, pageId).find((x) => x.check === check);
    expect(f, `${check} on ${pageId}: ${JSON.stringify(on(desk, pageId))}`).toBeDefined();
    expect(f).toMatchObject({ group, evidence, rule });
    expect(f.followUp.kind).toBe(follow);
    expect(f.source).toMatchObject({ kind: 'snapshot' });
    expect(f.page.path).toMatch(/^AI REPOSITORY \/ Appraisal Desk/);
    if (follow === 'fix')
      expect(f.followUp).toMatchObject({ tool: 'arkona_appraisal_fix', args: { findingId: f.id } });
    else expect(typeof f.followUp.decide).toBe('string');
  });

  it('each defect page holds its own defect and nothing else; the clean page holds nothing', () => {
    expect(checks(desk, P.clean)).toEqual([]);
    for (const [pageId, check] of cases) {
      const own = checks(desk, pageId).filter((c) => c !== 'sibling_order');
      expect(own, pageId).toEqual([check]);
    }
  });

  it('the details say what was found', () => {
    const dash = on(desk, P.dashText).find((f) => f.check === 'em_dash_text');
    expect(dash.details.total).toBe(2);
    expect(dash.details.blocks.map((b: any) => b.id)).toEqual(['dh1', 'dp1']);
    const blanks = on(desk, P.blanks).find((f) => f.check === 'blank_paragraphs');
    expect(blanks.details.blocks).toEqual(['bl1', 'bl2']);
    const extra = on(desk, P.extraField)[0];
    expect(extra.details.improvised).toEqual(['Mood']);
    const index = on(desk, P.bareIndex).find((f) => f.check === 'index_incomplete');
    expect(index.details.lacking).toHaveLength(3);
    const md = on(desk, P.markdown)[0];
    expect(md.details.blocks[0].found).toEqual(['“**” bold markers']);
  });

  it('characters: the completion gate (Core and Compact only), reciprocal links, and architectural candidates', () => {
    const gate = on(qishen, P.gap).find((f) => f.check === 'completion_gate');
    expect(gate).toMatchObject({ group: 'required', rule: 'Source Formatting › Sidebar Metadata' });
    expect(gate.details.fields.map((x: any) => [x.field, x.why])).toEqual([
      ['Naming Culture', 'blank'],
      ['Life State', 'an untouched placeholder'],
    ]);
    // Nadira's gate is met (and "Unestablished" is accepted: Heavy Saga's surname is "Saga", Gate Warden's "Warden").
    expect(checks(qishen, C.nadira)).not.toContain('completion_gate');
    // The gate is never asked of a page that is not a Core or a Compact Reference.
    expect(checks(qishen, P.nadiraBio)).not.toContain('completion_gate');
    // Nadira's Core lists her Art, which does not list it back: the Art page's finding.
    const recip = on(qishen, P.nadiraArt).find((f) => f.check === 'related_not_reciprocal');
    expect(recip).toMatchObject({ group: 'polish', evidence: 'Potential Maintenance Issue' });
    expect(recip.details.from.id).toBe(C.nadira);
    expect(checks(qishen, P.nadiraBio)).not.toContain('related_not_reciprocal'); // it links back
    const arch = on(qishen, P.heavy).filter((f) => f.group === 'architectural');
    expect(arch.map((f) => f.check).sort()).toEqual(['core_holds_specialist', 'scope_overload']);
    expect(arch.every((f) => f.evidence === 'Potential Maintenance Issue')).toBe(true);
    expect(arch[0].rule).toMatch(/^Character Architecture/);
    expect(arch[0].message).toMatch(/A6/);
  });
});

describe('the audits, gathered and never duplicated', () => {
  it('sibling order and the tag grammar are the audits’ findings, with the audits’ own fix handed over', () => {
    const order = on(desk, P.zebra).find((f) => f.check === 'sibling_order');
    expect(order).toMatchObject({
      group: 'required',
      rule: 'Source Formatting › Indexes › Sibling Ordering',
      source: { kind: 'audit' },
      followUp: { kind: 'fix', via: 'audit' },
    });
    expect(order.details.audit.code).toBe('out_of_order');
    const tag = on(desk, P.untagged).find((f) => f.check === 'tag_grammar');
    expect(tag).toMatchObject({
      group: 'required',
      rule: 'Controlled Native Tagging Standard › Exact Tag Grammar',
      source: { kind: 'audit' },
      followUp: { kind: 'fix', via: 'audit' },
    });
    expect(tag.details.audit.code).toBe('missing_required_tags');
  });

  it('a template row the audit already reports is its finding alone (no second finding)', () => {
    const missing = on(desk, P.missingField);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      check: 'template_field_missing',
      group: 'required',
      source: { kind: 'audit' },
    });
    expect(missing[0].details.audit.code).toBe('property_row_missing');
    expect(missing[0].details.evidence.expected).toBe('Temporal Scope');
  });

  it('an Authoritative page linking an Archived one: the Related Sources finding, not the audit’s as well', () => {
    const audit = w.stack.runtime.audits.list(PROJECT, { pageId: P.archivedRelated, limit: 50 }).findings;
    expect(audit.map((f) => f.code)).toContain('canon_refers_to_archived');
    expect(on(desk, P.archivedRelated).map((f) => f.check)).toEqual(['related_noncurrent']);
  });

  it('the audits’ tooling notices (collection blocks) are not page defects', () => {
    const audit = w.stack.runtime.audits.list(PROJECT, { pageId: P.desk, limit: 50 }).findings;
    expect(audit.map((f) => f.code)).toContain('collection_blocks');
    expect(on(desk, P.desk)).toEqual([]);
  });

  it('the report names the audit run it gathered from', async () => {
    const r = await w.call('arkona_appraise_owner', { page: P.clean, project: 'test' });
    const run = w.stack.runtime.audits.store.latestRun(PROJECT)!;
    expect(r.body.source.audit.snapshotId).toBe(run.snapshotId);
    expect(r.body.couldNotCheck).toEqual([]);
  });
});

describe('scope and paging', () => {
  it('a branch pages: limit, offset and nextOffset; runId reads the stored run again', async () => {
    const a = await w.call('arkona_appraise_owner', { under: P.desk, limit: 5, project: 'test' });
    expect(a.body.findings).toHaveLength(5);
    expect(a.body.nextOffset).toBe(5);
    const total = a.body.total;
    const b = await w.call('arkona_appraise_owner', {
      runId: a.body.runId,
      offset: 5,
      limit: 5,
      project: 'test',
    });
    expect(b.body.runId).toBe(a.body.runId);
    expect(b.body.offset).toBe(5);
    expect(b.body.total).toBe(total);
    expect(b.body.findings.map((f: any) => f.id)).not.toEqual(a.body.findings.map((f: any) => f.id));
    const g = await w.call('arkona_appraise_owner', {
      runId: a.body.runId,
      group: 'polish',
      project: 'test',
    });
    expect(g.body.findings.every((f: any) => f.group === 'polish')).toBe(true);
    expect(g.body.groups).toMatchObject({
      required: { label: 'Required defects' },
      polish: { label: 'Optional polish' },
    });
  });

  it('a second run of the same scope is compared with the first', async () => {
    const r = await w.call('arkona_appraise_owner', { under: P.desk, project: 'test' });
    expect(r.body.comparedWithLastRun).toMatchObject({ new: 0, gone: 0 });
    expect(r.body.comparedWithLastRun.still).toBe(r.body.total);
  });

  it('everything leaves the non-current areas and the Archived pages out unless asked for, and says so', async () => {
    const all = await w.call('arkona_appraise_owner', { all: true, limit: 10, project: 'test' });
    expect(all.isError, all.text).toBe(false);
    const stored = (r: any) => w.stack.runtime.appraisal.store.report(PROJECT, r.body.runId)!;
    const pages = new Set(stored(all).findings.map((f) => f.page?.id));
    expect(pages.has(P.legacyPage)).toBe(false);
    expect(pages.has(C.archived)).toBe(false);
    expect(all.body.nextOffset).toBe(10);
    expect(all.body.couldNotCheck.join(' ')).toMatch(/left out; include: \["legacy", "design", "archived"\]/);
    const inc = await w.call('arkona_appraise_owner', {
      all: true,
      include: ['legacy', 'design', 'archived'],
      limit: 10,
      project: 'test',
    });
    const more = new Set(stored(inc).findings.map((f) => f.page?.id));
    expect(more.has(P.legacyPage)).toBe(true);
    expect(inc.body.inspected.pages).toBeGreaterThan(all.body.inspected.pages);
  });

  it('exactly one of page, under or all', async () => {
    const r = await w.call('arkona_appraise_owner', { page: P.clean, under: P.desk, project: 'test' });
    expect(r.body.error.code).toBe('INVALID_PARAMS');
  });
});

describe('blocked cases and live: true', () => {
  it('a page made in the app since the snapshot is blocked (Incomplete); live: true reads and appraises it (2 reads)', async () => {
    w.repo.seed({ id: 'apnewpg1', name: '[BSRC] Quill Harbour - Polity Reference', parentId: P.desk });
    w.repo.blocks.set(w.repo.liveDocs(w.repo.live('apnewpg1')!).find((d) => d.name === 'Main')!.id, {
      version: 1,
      blocks: [{ id: 'qh1', kind: 'heading', level: 2, content: [{ text: 'Overview' }] }],
    });
    buildModels(w.stack, w.repo, w.assets, PROJECT, ROOT);
    const r = await w.call('arkona_appraise_owner', { page: 'apnewpg1', project: 'test' });
    expect(r.body.findings).toHaveLength(1);
    expect(r.body.findings[0]).toMatchObject({
      check: 'not_in_snapshots',
      group: 'blocked',
      evidence: 'Incomplete',
    });
    const before = w.requests();
    const live = await w.call('arkona_appraise_owner', { page: 'apnewpg1', live: true, project: 'test' });
    expect(live.isError, live.text).toBe(false);
    expect(w.requests().all - before.all).toBe(2);
    expect(w.requests().writes).toBe(before.writes);
    expect(live.body.source.live.reads).toBe(2);
    expect(live.body.cost).toBe('2 read(s) (live)');
    const purpose = live.body.findings.find((f: any) => f.check === 'purpose_first');
    expect(purpose.source.kind).toBe('live');
  });

  it('live: true refuses a scope larger than 25 pages, reading nothing', async () => {
    const before = w.requests();
    const r = await w.call('arkona_appraise_owner', { all: true, live: true, project: 'test' });
    expect(r.body.error.code).toBe('LIVE_TOO_MANY');
    expect(w.requests()).toEqual(before);
  });
});
