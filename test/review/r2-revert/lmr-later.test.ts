/**
 * R2-revert, attack (h): Last Major Revision put back wrongly.
 *
 * ADR 0055 B7: the revert "restores the page's previous value if the job changed it ..., and only while the row is still
 * what the job wrote; otherwise it leaves it alone". The row's TEXT is all that is compared. Two ways that is not enough:
 *
 * 1. A later job's major revision on the same day leaves the row alone ("already says today", src/jobs/step-exec.ts
 *    decideLmr), so the row still reads exactly what the first job wrote. Reverting the first job then dates the page
 *    back to before both, although the later job's major revision still stands (and the later job's own facts target
 *    now differs from what it left, so it cannot be reverted cleanly either).
 * 2. With a partial revert, the date is put back although the job's own major text edit is NOT reverted.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { londonDate } from '../../../src/jobs/internal-steps.js';
import { factsWorld, RHEASHIRA, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-lmr-agent')).client;
  // As revert.test.ts does: the tree knows Rheashira's PROPERTIES with its Last Major Revision row.
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: RHEASHIRA.property,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ key: 'Last Major Revision', text: '9 November 2026' }],
      },
    ]),
    PROJECT,
    RHEASHIRA.page,
  );
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const docOf = (page: string) => w.repo.liveDocs(w.repo.live(page)!).find((d) => d.name === 'Main')!.id;
const lmrRow = () =>
  w.sidebars.pages.get(RHEASHIRA.page)!.props[0]!.rows!.find((x) => x.key === 'Last Major Revision')!;
const lmr = () =>
  lmrRow()
    .content.map((c) => String((c as { text?: string }).text ?? ''))
    .join('');
const scope = () => w.sidebars.rows(RHEASHIRA.page).find((r) => r.key === 'Scope')!.text;
const resetPage = (lmrText: string) => {
  w.repo.blocks.set(docOf(RHEASHIRA.page), {
    version: 11,
    blocks: [{ id: 'rhpara01', kind: 'paragraph', content: [{ text: 'An envoy of the Hollow Court.' }] }],
  });
  w.sidebars.outside(RHEASHIRA.page, () => {
    lmrRow().content = [{ text: lmrText }];
  });
};
/** The bridge.lmr decision of a job, from its steps. */
const lmrDecision = (jobId: string) => {
  const steps = rt().engine.stepRecords(PROJECT, jobId) ?? [];
  const s = steps.find((x) => x.opId === 'bridge.lmr');
  return s ? (s.result as Record<string, unknown>) : null;
};

describe('Last Major Revision after a revert', () => {
  it('a later major revision the same day keeps the date: reverting the earlier job must not date the page back', async () => {
    resetPage('9 November 2026');
    const today = londonDate(Date.now());
    // Job 1: a major text edit sets the date.
    const a = await call('write_page', {
      page: RHEASHIRA.page,
      mode: 'append',
      markdown: 'She crossed the northern marches twice and returned with the treaty sealed in silver.',
    });
    expect(a.body.status, a.text).toBe('written');
    const job1 = jobOf(a);
    await rt().engine.wait(PROJECT, job1, 25_000);
    expect(lmr()).toBe(today);
    // Job 2: a major fact change the same day. Its decision leaves the row alone: it already says today.
    const b = await call('set_facts', {
      page: RHEASHIRA.page,
      facts: {
        Scope: 'Moon elf envoy, treaty-bearer of the northern marches and first voice of the eastern courts',
      },
    });
    expect(b.body.status, b.text).toBe('written');
    const job2 = jobOf(b);
    await rt().engine.wait(PROJECT, job2, 25_000);
    const d2 = lmrDecision(job2);
    expect(typeof d2?.skip === 'string' ? d2.skip : '', JSON.stringify(d2)).toMatch(/already says/);

    // The owner reverts job 1 only (job 2's change is wanted).
    const { r, job } = await revertAndWait(w.stack, job1);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    expect(job!.status).toBe('succeeded');
    expect(scope()).toMatch(/treaty-bearer/); // job 2's major revision still stands …
    // … so the page's Last Major Revision must still be today (or the revert must leave the row alone).
    expect(lmr(), 'Last Major Revision after reverting job 1 while job 2 stands').toBe(today);
  });

  // CR-2026-11-R2 (R2-18 b): the decision records the row's runs as read (`previousContent`, src/jobs/step-exec.ts
  // decideLmr), and Revert puts them back exactly (src/review/targets.ts); an empty plain value is never written blind.
  it('the value before the job is put back as it was, not as its plain text (a linked date; a mention)', async () => {
    const today = londonDate(Date.now());
    const cases: { label: string; content: Record<string, unknown>[] }[] = [
      {
        label: 'a linked date',
        content: [{ text: '9 November 2026', link: 'https://example.com/revision-log' }],
      },
      {
        label: 'a mention',
        content: [{ mention: { resourceId: 'kaede001', text: 'Revision of Kaede’s arc' } }],
      },
    ];
    const out: Record<string, unknown> = {};
    for (const c of cases) {
      resetPage('placeholder');
      w.sidebars.outside(RHEASHIRA.page, () => {
        lmrRow().content = structuredClone(c.content);
      });
      const a = await call('write_page', {
        page: RHEASHIRA.page,
        mode: 'append',
        markdown: `For ${c.label}: she crossed the northern marches twice and returned with the treaty sealed in silver.`,
      });
      expect(a.body.status, a.text).toBe('written');
      const jobId = jobOf(a);
      await rt().engine.wait(PROJECT, jobId, 25_000);
      expect(lmr()).toBe(today);
      const { job } = await revertAndWait(w.stack, jobId);
      expect(job?.status).toBe('succeeded');
      out[c.label] = structuredClone(lmrRow().content);
    }
    expect(out).toEqual(Object.fromEntries(cases.map((c) => [c.label, c.content])));
  });

  it('a partial revert puts the date back although the job’s own major text edit stays', async () => {
    resetPage('9 November 2026');
    const today = londonDate(Date.now());
    const a = await call('write_page', {
      page: RHEASHIRA.page,
      mode: 'append',
      markdown: 'In the winter of that year she was named first envoy to the eastern courts and the isles.',
    });
    expect(a.body.status, a.text).toBe('written');
    const jobId = jobOf(a);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(lmr()).toBe(today);
    // The owner fixes a typo elsewhere on the page in the app: the page text is no longer as the job left it.
    const doc = w.repo.blocks.get(docOf(RHEASHIRA.page))!;
    doc.blocks = JSON.parse(
      JSON.stringify(doc.blocks).replace('An envoy of the Hollow Court.', 'An envoy of the Hollow Court!'),
    ) as never;
    doc.version++;
    const refused = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(refused).toMatchObject({ status: 'refused', code: 'PARTIAL_REVERT_NEEDS_CONFIRMATION' });
    const states = refused.targets.map((t) => `${t.kind}:${t.state}`);
    // The major edit that justified the date is not revertible; the date alone is offered as "ready".
    expect(states.sort()).toEqual(['lmr:ready', 'text:changed']);
    const { job } = await revertAndWait(w.stack, jobId, true);
    expect(job?.status).toBe('succeeded');
    expect(JSON.stringify(w.repo.blocks.get(docOf(RHEASHIRA.page))!.blocks)).toContain('first envoy');
    // The job's major revision is still on the page: its date must not be taken off it.
    expect(lmr(), 'Last Major Revision while the job’s major edit stays').toBe(today);
  });
});
