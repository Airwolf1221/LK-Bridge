/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * R2-PACKS on the appraisal (ADR 0054; ADR 0055 decision D): the four reports must be read-only; `arkona_appraisal_fix`
 * follows its switch from the APPROVED pack version; at scope `write` (the seed's switch: "follow the scope") it must
 * re-check what it fixes before it writes.
 *
 * - ATK-12: every report (live where it can be) writes nothing to LegendKeeper and proposes nothing;
 * - ATK-17: a pending version that loosens the switch ("always propose" → "follow the scope") does not apply;
 * - ATK-18: a pending version that TIGHTENS it ("follow the scope" → "always propose", the owner re-authenticated on
 *   the Packs page) does not apply either until approved (ADR 0055 D1 by design: reported as a design gap);
 * - ATK-19: the audits' fixes it hands over (tags) stay proposals at scope write;
 * - ATK-13: the asset-extension fix renames from the name it read, with no check in the job (src/appraisal/fixes.ts:
 *   442-451: no expectCurrent, no job-level lock): an owner's rename between the fix's read and its write is lost;
 * - ATK-14, ATK-15: the name fix (expectCurrent) and the body fix (block-by-block check) refuse such a race;
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

describe('the switch read from the approved version', () => {
  it('ATK-17: approved "always propose", pending "follow the scope": the fix is still ONE proposal', async () => {
    packs().commands.setToolModes('owner', 'arkona', { arkona_appraisal_fix: 'propose' });
    await packs().commands.approve('owner', 'arkona');
    packs().commands.setToolModes('owner', 'arkona', { arkona_appraisal_fix: 'scope' });
    const r = await fix(finding('blank_paragraphs', P.blanks).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
    await packs().commands.approve('owner', 'arkona'); // back to the seed's "follow the scope", approved
  });

  it('ATK-19: an audit fix handed over (tags) stays a proposal at scope write', async () => {
    const r = await fix(finding('tag_grammar', P.untagged).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
  });

  it('ATK-18 (design gap): approved "follow the scope", the owner switches it to "always propose" (pending): the fix should propose', async () => {
    packs().commands.setToolModes('owner', 'arkona', { arkona_appraisal_fix: 'propose' });
    const r = await fix(finding('blank_paragraphs', P.blanks).id);
    const status = r.body.status;
    if (status === 'proposal_captured')
      w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
    packs().commands.setToolModes('owner', 'arkona', { arkona_appraisal_fix: 'scope' });
    await packs().commands.approve('owner', 'arkona');
    expect(status, r.text).toBe('proposal_captured');
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

  it('ATK-14: the page is renamed between the name fix’s read and its write: refused (HELD expected)', async () => {
    const f = finding('em_dash_name', P.dashName);
    const { jobId, call } = await heldFix(f.id);
    w.repo.outside.rename(P.dashName, '[BSRC] Gata—Lund Reach - Polity Reference');
    engine().controls.resumeWrites('test');
    const job = await engine().wait(PROJECT, jobId, 30_000);
    await call;
    expect({ name: w.repo.res.get(P.dashName)!.name, status: job.status }).toEqual({
      name: '[BSRC] Gata—Lund Reach - Polity Reference',
      status: 'failed',
    });
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
