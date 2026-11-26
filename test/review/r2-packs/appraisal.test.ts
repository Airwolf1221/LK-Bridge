/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * R2-PACKS on the appraisal (ADR 0054; ADR 0055 decision D; ADR 0081): the four reports must be read-only;
 * `arkona_appraisal_fix` follows the agent's scope (v3 F12 removed the pack's per-tool switches, and ATK-17 and ATK-18,
 * which tested them, went with them); at scope `write` it must re-check what it fixes before it writes.
 *
 * - ATK-12: every report (live where it can be) writes nothing to LegendKeeper and proposes nothing;
 * - ATK-19: the audits' fixes it hands over (tags) run as the agent: one direct job at scope write, on Review;
 * - ATK-13: the asset-extension fix renames from the name it read, with no check in the job (src/appraisal/fixes.ts:
 *   442-451: no expectCurrent, no job-level lock): an owner's rename between the fix's read and its write is lost;
 * - ATK-14: the name fix of an Authoritative page at scope write is one direct job (v3 F12; it was a canonical proposal
 *   under ADR 0057 decision 5), on Review; ATK-15: the body fix (block-by-block check) refuses a race;
 * - ATK-16: the Related Sources fix judges the LINKED page's state from the repository tree only
 *   (fixes.ts:478-480), so a page the owner has unarchived in the app (the tree not yet re-read) is unlinked from an
 *   Authoritative page's Related Sources at scope write.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appraisalWorld, A, C, P, PROJECT, type AppraisalWorld } from '../../appraisal/world.js';
import type { ToolCall } from '../../tools/helpers.js';
import { writeAgent } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AppraisalWorld;
let agent: Awaited<ReturnType<typeof writeAgent>>;
let findings: any[];
beforeAll(async () => {
  w = await appraisalWorld({ toolModes: 'seed' });
  agent = await writeAgent(w);
  await w.snapshot();
  const d = await w.call('arkona_appraise_owner', { under: P.desk, limit: 200, project: 'test' });
  const v = await w.call('arkona_visual_hygiene', { limit: 200, project: 'test' });
  findings = [...d.body.findings, ...v.body.findings];
}, 180_000);
afterAll(async () => {
  w?.stack.runtime.engine.controls.resumeWrites('test');
  await w?.close();
});

const packs = () => w.stack.runtime.packs;
const engine = () => w.stack.runtime.engine;
const proposalsCount = () =>
  (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
const finding = (check: string, pageId?: string) => {
  const f = findings.find((x) => x.check === check && (pageId === undefined || x.page?.id === pageId));
  if (!f) throw new Error(`no ${check} finding`);
  return f;
};
const fix = (findingId: string) => agent('arkona_appraisal_fix', { findingId, project: 'test' });
const until = async (fn: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms / 10 && !fn(); t++) await new Promise((r) => setTimeout(r, 10));
};

/** Calls the fix with writes paused (its read runs; its job is held), returning the job id and the pending call. */
async function heldFix(findingId: string): Promise<{ jobId: string; call: Promise<ToolCall> }> {
  const known = new Set(
    engine()
      .queries.listJobs(PROJECT, { limit: 500 })
      .map((j) => j.id),
  );
  engine().controls.pauseWrites('test');
  const call = fix(findingId);
  let jobId = '';
  await until(() => {
    const j = engine()
      .queries.listJobs(PROJECT, { limit: 50 })
      .find((x) => !known.has(x.id) && x.kind === 'batch_ops');
    if (j) jobId = j.id;
    return !!j;
  });
  expect(jobId, 'the fix was submitted as a direct job (switch: follow the scope)').not.toBe('');
  return { jobId, call };
}

describe('ATK-12: the reports are read-only', () => {
  it('appraise (live), change impact (live), working digest and visual hygiene write nothing and propose nothing', async () => {
    const before = w.requests();
    const p0 = proposalsCount();
    const calls: [string, Record<string, unknown>][] = [
      ['arkona_appraise_owner', { page: P.dashName, live: true }],
      ['arkona_appraise_owner', { under: P.desk, live: false }],
      ['arkona_change_impact', { page: C.nadira, renameTo: 'Nadira of the Tides', live: true }],
      ['arkona_working_digest', {}],
      ['arkona_visual_hygiene', {}],
      // ATK-27: the brief is read-only too, live included.
      ['arkona_character_brief', { character: 'Nadira al-Khalid', live: true }],
    ];
    for (const [name, args] of calls) {
      const r = await agent(name, { ...args, project: 'test' });
      expect(r.isError, `${name}: ${r.text.slice(0, 500)}`).toBe(false);
    }
    expect({ writes: w.requests().writes - before.writes, proposals: proposalsCount() - p0 }).toEqual({
      writes: 0,
      proposals: 0,
    });
  });

  it('ATK-26: arkona_appraisal_fix is refused at scope read (nothing written or proposed)', async () => {
    const before = w.requests();
    const p0 = proposalsCount();
    const r = await w.callRead('arkona_appraisal_fix', {
      findingId: finding('blank_paragraphs', P.blanks).id,
      project: 'test',
    });
    expect(r.isError, r.text).toBe(true);
    expect({ writes: w.requests().writes - before.writes, proposals: proposalsCount() - p0 }).toEqual({
      writes: 0,
      proposals: 0,
    });
  });
});

const onReview = (jobId: string) =>
  w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === jobId);

describe('the audits’ fixes handed over', () => {
  it('ATK-19: an audit fix handed over (tags) runs as the agent: one direct job at scope write, on Review', async () => {
    const p0 = proposalsCount();
    const r = await fix(finding('tag_grammar', P.untagged).id);
    expect(r.body.status, r.text).toBe('written');
    const job = await engine().wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect({ proposals: proposalsCount() - p0, onReview: onReview(job.id) }).toEqual({ proposals: 0, onReview: true });
  });
});

describe('a fix at scope write re-checks what it fixes before it writes', () => {
  it('ATK-13: the asset is renamed by the owner between the fix’s read and its write: the owner’s name must survive', async () => {
    const f = finding('asset_extension');
    const { jobId, call } = await heldFix(f.id);
    // The owner renames the image in the LegendKeeper app while the fix's job waits.
    w.assets.outsideRename(A.portraitPng, 'Nadira al-Khalid - Primary Reference - Portrait (owner).png');
    engine().controls.resumeWrites('test');
    const job = await engine().wait(PROJECT, jobId, 30_000);
    await call;
    expect({ name: w.assets.assets.get(A.portraitPng)!.name, status: job.status }).toEqual({
      name: 'Nadira al-Khalid - Primary Reference - Portrait (owner).png',
      status: 'failed',
    });
  });

  // v3 F12 (ADR 0081): renaming an Authoritative page at scope write is direct, the pack tools' fixes included (under
  // ADR 0057 decision 5 it was a canonical proposal); the job is on the owner's Review page, with Revert.
  it('ATK-14: the name fix of an Authoritative page at scope write is one direct job, on Review', async () => {
    const f = finding('em_dash_name', P.dashName);
    const r = await fix(f.id);
    expect(r.body.status, r.text).toBe('written');
    const job = await engine().wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.repo.res.get(P.dashName)!.name).toBe('[BSRC] Gata - Lund - Polity Reference');
    expect(onReview(job.id)).toBe(true);
  });

  it('ATK-15: the paragraph is edited between the body fix’s read and its write: refused (HELD expected)', async () => {
    const f = finding('em_dash_text', P.dashText);
    const { jobId, call } = await heldFix(f.id);
    const doc = w.repo.blocks.get(w.mainOf(P.dashText))!;
    doc.version++;
    doc.blocks = (doc.blocks as any[]).map((b) =>
      b.id === 'dp1'
        ? { ...b, content: [{ text: 'The owner’s new sentence — with a dash kept on purpose.' }] }
        : b,
    );
    engine().controls.resumeWrites('test');
    const job = await engine().wait(PROJECT, jobId, 30_000);
    await call;
    const dp1 = (w.repo.blocks.get(w.mainOf(P.dashText))!.blocks as any[]).find((b) => b.id === 'dp1');
    expect({ text: dp1.content[0].text, status: job.status }).toEqual({
      text: 'The owner’s new sentence — with a dash kept on purpose.',
      status: 'failed',
    });
  });

  it('ATK-16: the linked page was unarchived in the app (tree not re-read): the fix must not unlink a now-current page', async () => {
    const f = finding('related_noncurrent', P.archivedRelated);
    // The owner unarchives Seren Vale by hand: back under the Humans race index, [BSRC], CANON.
    w.repo.outside.move(C.archived, C.humans);
    w.repo.outside.rename(C.archived, '[BSRC] Seren Vale - Character Core');
    w.repo.outside.setTags(C.archived, ['CANON', 'Character']);
    const r = await fix(f.id);
    const rel = w.sidebars.pages.get(P.archivedRelated)!.props.find((p) => p.title === 'Related Sources')!;
    expect({ linked: rel.items!.map((i) => i.resourceId) }, `fix answered: ${r.text.slice(0, 400)}`).toEqual({
      linked: [C.archived],
    });
  });
});

describe('ATK-28: the appraisal applies the CURRENT (unapproved) pack rules, and its fix writes at scope write', () => {
  it('a pending version (not approved) must not drive a direct fix: a Dependency on a Working page stays (a judgement)', async () => {
    // A pending version, as the owner's edit or a new seed offered at start leaves one until approved. Here it names
    // the link collection "Dependencies" as the pack's Related Sources (a data mistake the owner has not approved).
    const p = packs().get('arkona')!;
    packs().commands.replaceRules(
      'owner',
      'arkona',
      { ...p.rules, sidebar: { ...p.rules.sidebar, related: 'Dependencies' } },
      'r2: a pending version',
    );
    expect(packs().get('arkona')!.approved?.version).not.toBe(packs().get('arkona')!.version);
    expect((await packs().governance('arkona')).state).toBe('rules_changed');
    const report = await agent('arkona_appraise_owner', { page: P.workingDep, project: 'test' });
    const f = (report.body.findings as any[]).find((x) => x.check === 'related_noncurrent');
    const r = f ? await fix(f.id) : null;
    const deps = w.sidebars.pages.get(P.workingDep)!.props.find((x) => x.title === 'Dependencies')!;
    const linked = deps.items!.map((i) => i.resourceId);
    // Back to the approved rules.
    packs().commands.replaceRules('owner', 'arkona', p.rules, 'r2: back');
    await packs().commands.approve('owner', 'arkona');
    expect(
      { fixOffered: !!f, status: r?.body.status ?? null, dependencies: linked },
      r?.text.slice(0, 300),
    ).toEqual({ fixOffered: false, status: null, dependencies: [C.draft] });
  });
});
