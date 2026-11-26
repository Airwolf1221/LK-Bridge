/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- parsed JSON */
/**
 * v3 F4b (ADR 0064; design D5, D6): the nightly audit's `consistency` category and "Pick the right value", against the
 * REAL stack on the mock LegendKeeper (test/consistency/world.ts, plus eleven pages restating Leila Darvish's birth):
 *
 * - only Contradictory pairs become findings, with stable codes, and they clear when the pages agree;
 * - the pick needs the step-up; it plans one item per disagreeing page and never touches the side picked, and (v3 F12,
 *   ADR 0081) runs at once as ONE job, with no proposal, a pick of more than 10 pages included; a typed value edits the
 *   identity page too; an agent's suggestion is shown and applies nothing; Revert works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../../src/audits/types.js';
import { C, f4bWorld, K, ownerClient, PROJECT, type F4bWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

const LEILA_NOTES = Array.from({ length: 11 }, (_, i) => `leilnt${String(i).padStart(2, '0')}`);

let w: F4bWorld;
beforeAll(async () => {
  w = await f4bWorld({
    seed: (world) => {
      for (const [i, id] of LEILA_NOTES.entries())
        world.repo.seed({
          id,
          name: `[BSRC] Leila Darvish Note ${i + 1}`,
          parentId: C.humans,
          tags: ['CANON'],
        });
    },
  });
  for (const id of LEILA_NOTES)
    w.setBody(id, [
      {
        id: `${id}p`,
        kind: 'paragraph',
        content: [{ text: 'Leila Darvish was born in 4A 700, the note says.' }],
      },
    ]);
  w.rebuildTree();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const audits = () => w.stack.runtime.audits;
const consistency = (): Finding[] =>
  audits().list(PROJECT, { category: ['consistency'], acknowledged: 'include', limit: 500 }).findings;
const findingOf = (subject: string, code: string) =>
  consistency().find((f) => f.code === code && f.evidence.subject === subject && f.state === 'open')!;
const textOf = (pageId: string) => JSON.stringify(w.repo.blocks.get(w.mainOf(pageId))!.blocks);
const temporalScope = (pageId: string) =>
  (w.sidebars.pages.get(pageId)!.props[0]!.rows ?? [])
    .find((r: any) => r.key === 'Temporal Scope')!
    .content.map((c: any) => c.text ?? '')
    .join('');
const proposals = () => w.stack.runtime.policy.proposals.list({ project: PROJECT, limit: 500 }).length;
/** v3 F12 (ADR 0081): the owner's confirmed pick runs at once as ONE job (no proposal); waits for it. */
async function ran(json: Record<string, any>) {
  expect(typeof json.jobId, JSON.stringify(json)).toBe('string');
  expect(json.proposalId).toBeUndefined();
  for (let i = 0; i < 1000; i++) {
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(json.jobId));
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return { job, jobId: job.id };
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the pick’s job did not finish');
}

describe('the audits’ consistency category (D5)', () => {
  it('reports only Contradictory pairs (Authoritative against Authoritative), with the four stable codes', () => {
    const run = audits().store.latestRun(PROJECT)!;
    expect(run.counts!.byCategory.consistency).toBeDefined();
    const open = consistency().filter((f) => f.state === 'open');
    expect(new Set(open.map((f) => f.code))).toEqual(
      new Set(['consistency_birth', 'consistency_identity', 'consistency_chronology']),
    );
    for (const f of open) {
      expect(f).toMatchObject({ category: 'consistency', severity: 'warning' });
      expect(String(f.evidence.consistencyId)).toMatch(/^cf_[0-9a-f]{20}$/);
      expect(f.evidence.label).toBe('Contradictory');
    }
    // Never a Working proposal, a gap, an unreadable date or historical material.
    const text = JSON.stringify(open);
    expect(text).not.toMatch(/4A 110|5A 400|Camue 51st|4A 120/);
    expect(open.map((f) => f.evidence.subject)).not.toContain('Kamigawa Haru');
  });

  it('a finding keeps its id and code from one run to the next', async () => {
    const before = findingOf('Katsuragi Yamato', 'consistency_birth');
    await audits().run(PROJECT, 'manual');
    const after = findingOf('Katsuragi Yamato', 'consistency_birth');
    expect(after.id).toBe(before.id);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.evidence.consistencyId).toBe(before.evidence.consistencyId);
  });

  it('arkona_brief carries a consistency line listing the open contradictions on the subject', async () => {
    const r = await w.call('arkona_brief', { project: 'test', subject: 'Yasmin al-Naim' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.consistency.open).toBeGreaterThanOrEqual(2);
    expect(r.body.consistency.contradictions.map((c: any) => c.code)).toContain('consistency_birth');
    expect(r.body.consistency.note).toMatch(/owner picks/);
  });
});

describe('“Pick the right value” (D6)', () => {
  it('shows both values side by side; the pick needs the step-up, and nothing is proposed without it', async () => {
    const f = findingOf('Katsuragi Yamato', 'consistency_birth');
    const o = ownerClient(w);
    const v = await o.get(`/audits/findings/${f.id}/consistency?project=test`);
    expect(v.status).toBe(200);
    expect(v.json.values.map((x: any) => x.value)).toEqual(['Isar 3rd, 4A 300', '4A 305']);
    expect(v.json.values[0].page.id).toBe(K.katsu);
    const before = proposals();
    const refused = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      side: v.json.values[0].key,
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    expect(proposals()).toBe(before);
  });

  it('an agent’s suggestion is recorded and shown to the owner; it applies and proposes nothing', async () => {
    const f = findingOf('Katsuragi Yamato', 'consistency_birth');
    const before = proposals();
    const s = await w.call('arkona_consistency_suggest', {
      project: 'test',
      findingId: f.evidence.consistencyId,
      value: 'Isar 3rd, 4A 300',
      reason: 'The Core’s Temporal Scope is the identity page’s value.',
    });
    expect(s.isError, s.text).toBe(false);
    expect(s.body.status).toBe('suggested');
    expect(proposals()).toBe(before);
    const v = await ownerClient(w).get(`/audits/findings/${f.id}/consistency?project=test`);
    expect(v.json.suggestions).toEqual([
      expect.objectContaining({ value: 'Isar 3rd, 4A 300', reason: expect.stringMatching(/identity page/) }),
    ]);
    // No tool lets an agent pick.
    const tools = await w.stack.connect().then((c) => c.listTools());
    expect(tools.tools.map((t) => t.name).filter((n) => /pick/.test(n))).toEqual([]);
  });

  let katsuJob: string;
  it('picking the identity page’s value: ONE job (v3 F12), one item for the page that disagrees, the side picked untouched; it edits only the date; the finding clears', async () => {
    const f = findingOf('Katsuragi Yamato', 'consistency_birth');
    const o = ownerClient(w);
    const v = await o.get(`/audits/findings/${f.id}/consistency?project=test`);
    o.reauth();
    const coreBefore = temporalScope(K.katsu);
    const r = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      side: v.json.values[0].key,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ id: `page:${K.nation}`, page: { id: K.nation } });
    expect(r.json.untouched).toEqual([
      expect.objectContaining({ value: 'Isar 3rd, 4A 300', why: 'the side picked' }),
    ]);
    const before = proposals();
    const done = await ran(r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(proposals()).toBe(before);
    katsuJob = done.jobId;
    expect(textOf(K.nation)).toContain('Rita von Katzen was born in Isar 3rd, 4A 300, in the river quarter.');
    // The other line of the page is as it was; the Core is untouched.
    expect(textOf(K.nation)).toContain(
      'Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in the palace.',
    );
    expect(temporalScope(K.katsu)).toBe(coreBefore);
    // The pick is audited and recorded.
    const picks = w.stack.db.prepare('SELECT * FROM consistency_picks WHERE job_id = ?').all(r.json.jobId);
    expect(picks).toHaveLength(1);
    // The next snapshot holds the edit: the pages agree, and the finding clears.
    await w.stack.runtime.snapshots.settled();
    await audits().run(PROJECT, 'manual');
    expect(audits().store.get(PROJECT, f.id)!.state).toBe('gone');
  });

  it('Revert puts the restated date back', async () => {
    const r = await w.stack.runtime.reverts.revert('owner', PROJECT, katsuJob, {});
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    const id = (r as { revertJobId: string }).revertJobId;
    for (let i = 0; i < 500; i++) {
      const job = w.stack.runtime.engine.queries.getJob(PROJECT, id);
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        expect(job.status, JSON.stringify(job.lastError ?? null)).toBe('succeeded');
        break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(textOf(K.nation)).toContain('Rita von Katzen was born in 4A 305, in the river quarter.');
  });

  it('a typed value: every page that disagrees is edited, the identity page’s Temporal Scope included (only the date)', async () => {
    const f = findingOf('Yasmin al-Naim', 'consistency_birth');
    const o = ownerClient(w);
    o.reauth();
    const bad = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      value: 'Camue 51st, 4A 100',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALUE_UNREADABLE');
    const r = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      value: 'Camue 2nd, 4A 100',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items.map((i: any) => i.page.id).sort()).toEqual([K.yasminBio, K.yasmin].sort());
    const done = await ran(r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(temporalScope(K.yasmin)).toBe('Born Camue 2nd, 4A 100');
    expect(textOf(K.yasminBio)).toContain('Yasmin was born on Camue 2nd, 4A 100 in the old quarter.');
    // The pronoun sentence and the other sentences are as they were.
    expect(textOf(K.yasminBio)).toContain('She was born in 4A 90 by another count.');
  });

  it('a pick of more than 10 pages runs at once as ONE job editing all of them (v3 F12: no bulk rail, no proposal)', async () => {
    const f = findingOf('Leila Darvish', 'consistency_birth');
    expect((f.evidence.restatements as unknown[]).length).toBe(11);
    const o = ownerClient(w);
    const v = await o.get(`/audits/findings/${f.id}/consistency?project=test`);
    o.reauth();
    const before = proposals();
    const r = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      side: v.json.values[0].key,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items).toHaveLength(11);
    const done = await ran(r.json);
    expect(done.job.status, JSON.stringify(done.job.lastError ?? null)).toBe('succeeded');
    expect(proposals()).toBe(before);
    // Every note was edited by the one job (none still gives the old date).
    for (const id of LEILA_NOTES) expect(textOf(id)).not.toContain('born in 4A 700');
  });
});
