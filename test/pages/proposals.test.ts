/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * write_page at scope `propose` (v2 C1, PLAN-v2 10.2), through the real server and the official MCP SDK client: the
 * proposal holds the HIGH-LEVEL operation and its planned expansion; the dashboard shows the Markdown diff beside the
 * block diff; approval executes exactly the stored expansion through the same lock, compare-and-swap and verify path,
 * with approvedBy recorded; a version change since capture (or between the approval's check and the write) ends
 * conflicted, never re-planned.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LkBlock } from '../../src/markdown/index.js';
import { pagesWorld, textOf, type PagesWorld } from './world.js';

let w: PagesWorld;
let c: Client;
const PROJECT_ID = 'proj_mock';
const call = (args: Record<string, unknown>) => w.stack.call(c, 'write_page', { project: 'test', ...args });
const methods = (since: number) =>
  w
    .blockRequests('miyabi')
    .slice(since)
    .map((r) => r.method);
const commands = () => w.stack.runtime.policy.commands;

const h = (id: string, level: number, text: string): LkBlock => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const p = (id: string, text: string): LkBlock => ({ id, kind: 'paragraph', content: [{ text }] });
const page = (): LkBlock[] => [
  h('mh1', 1, 'Asagiri Miyabi'),
  p('mp1', 'A Foxian shrine maiden.'),
  h('mh2', 2, 'Biography'),
  p('mp2', 'Born on Kumikas 1st, 4A 881.'),
  { id: 'infobx9', kind: 'infobox', layout: 'wrapRight', width: 40, rows: [] },
  h('mh5', 2, 'Relations'),
  p('mp4', 'Sister of Kaede.'),
  { id: 'unsup1', kind: 'unsupported' },
];

async function waitFor(id: string, states: string[]) {
  for (let i = 0; i < 100; i++) {
    const s = commands().getProposal('owner', id).state;
    if (states.includes(s)) return commands().getProposal('owner', id);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`proposal ${id} never reached ${states.join('/')}`);
}

beforeAll(async () => {
  w = await pagesWorld();
  c = await w.stack.connect(w.stack.newToken('pages-chatgpt', 'propose').token);
});
afterAll(() => w.close());
beforeEach(() => {
  w.setPage('miyabi', page(), 3);
});

describe('capture', () => {
  it('stores the high-level operation and its expansion, after one read; nothing is written', async () => {
    const before = w.blockRequests('miyabi').length;
    const r = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Biography',
      markdown:
        '<!-- lk:keep id="infobx9" kind="infobox" -->\n<!-- /lk:keep -->\n\nBorn at dawn on Kumikas 1st, 4A 881.',
      baseVersion: 'v3',
      detail: 'full',
    });
    expect(r.isError, r.text).toBe(false);
    expect(methods(before)).toEqual(['GET']); // the plan read, reused by the capture
    expect(r.body).toMatchObject({
      status: 'proposal_captured',
      plannedOn: 'v3',
      counts: { changed: 1, moved: 1 },
    });
    expect(r.body.hint).toMatch(/NOT made.*conflicted/);
    expect(r.body.diff).toContain('+Born at dawn on Kumikas 1st, 4A 881.');
    const d = commands().getProposal('owner', r.body.proposalId) as any;
    expect(d.state).toBe('pending');
    expect(d.summary).toMatch(
      /^write_page replace_section “Asagiri Miyabi > Biography” on “Asagiri Miyabi” \(Main\): /,
    );
    // The high-level operation (for display and later re-validation)…
    expect(d.operationDetail).toMatchObject({
      tool: 'write_page',
      page: { id: 'miyabi01', name: 'Asagiri Miyabi' },
      document: { id: w.doc('miyabi'), name: 'Main' },
      mode: 'replace_section',
      section: 'Asagiri Miyabi > Biography',
      plannedOn: 'v3',
      baseVersion: 'v3',
    });
    expect(d.operationDetail.markdown).toContain('Born at dawn');
    // …and its planned expansion: the new block tree, on the version it was built on.
    expect(d.ops).toHaveLength(1);
    expect(d.ops[0]).toMatchObject({ op: 'replaceDocumentBlocks', version: 'v3' });
    expect(d.ops[0].params.ifMatch).toBe('v3');
    expect(d.ops[0].params.body.blocks).toContainEqual({ id: 'unsup1', kind: 'unsupported' });
    // The Markdown diff (keep regions as labelled placeholders), beside the existing block-level diff.
    const lines = d.markdownDiff.hunks.flatMap((x: any) => x.lines);
    expect(lines).toContainEqual({ kind: 'del', text: 'Born on Kumikas 1st, 4A 881.' });
    expect(lines).toContainEqual({ kind: 'add', text: 'Born at dawn on Kumikas 1st, 4A 881.' });
    expect(lines.some((l: any) => l.text === '[keep region: infobox infobx9]')).toBe(true);
    expect(d.ops[0].changes.length).toBeGreaterThan(0);
    // The agent sees its own proposal, briefly.
    const st = await w.stack.call(c, 'bridge_proposal_status', {
      proposalId: r.body.proposalId,
      project: 'test',
    });
    expect(st.body.proposal ?? st.body).toMatchObject({ state: 'pending' });
    expect(JSON.stringify(st.body)).toContain('"mode":"replace_section"');
    expect(JSON.stringify(st.body)).not.toContain('Born at dawn'); // not the Markdown
  });
  it('the dashboard API returns the Markdown diff with the proposal', async () => {
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Dashboard check.' });
    const api = w.stack.runtime.policy.commands.getProposal('owner', r.body.proposalId) as any;
    expect(api.markdownDiff).toMatchObject({ added: 2, removed: 0 });
  });
});

describe('approval', () => {
  it('executes exactly the stored expansion through the lock, the compare-and-swap and the verify read, approvedBy owner', async () => {
    const r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Relations',
      markdown: 'Approved line.',
    });
    const planned = (commands().getProposal('owner', r.body.proposalId) as any).ops[0].params.body.blocks;
    const before = w.blockRequests('miyabi').length;
    await commands().approve('owner', r.body.proposalId);
    const d = (await waitFor(r.body.proposalId, ['executed', 'failed', 'conflicted'])) as any;
    expect(d.state).toBe('executed');
    // The approval's re-read, then the job's read inside the lock, the write, and the verify read.
    expect(methods(before)).toEqual(['GET', 'GET', 'PUT', 'GET']);
    expect(w.blockRequests('miyabi').at(-2)!.ifMatch).toBe('v3');
    expect(w.stored('miyabi').blocks).toEqual(planned);
    expect(d.execution).toMatchObject({
      verified: true,
      verification: { status: 'verified', version: 'v4' },
    });
    const job = w.stack.runtime.engine.queries.getJob(PROJECT_ID, d.jobId)!;
    expect(job).toMatchObject({ approvedBy: 'owner', status: 'succeeded' });
    const journal = w.stack.runtime.engine.queries.journalLookup(PROJECT_ID, { jobId: d.jobId });
    expect(journal[0]).toMatchObject({
      approvedBy: 'owner',
      operation: { tool: 'write_page', mode: 'append_to_section' },
    });
    // The step was never re-planned (approval stores no planner).
    expect(
      w.stack.runtime.engine.queries.getJob(PROJECT_ID, d.jobId)!.steps[0]!.options.replan,
    ).toBeUndefined();
  });
  it('a version change since capture: conflicted, nothing written, no re-planning (even for an unchanged section)', async () => {
    const r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Relations',
      markdown: 'Too late.',
    });
    w.outsideEdit('miyabi', (b) => (b[1] = p('mp1', 'Edited in the app, elsewhere.')));
    const before = w.blockRequests('miyabi').length;
    const d = (await commands().approve('owner', r.body.proposalId)) as any;
    expect(d.state).toBe('conflicted');
    expect(d.conflict).toMatchObject({ capturedVersion: 'v3', currentVersion: 'v4' });
    expect(methods(before)).toEqual(['GET']);
    expect(w.stored('miyabi').blocks.some((b) => textOf(b) === 'Too late.')).toBe(false);
  });
  it('a change between the approval’s check and the write: the compare-and-swap in the lock catches it, conflicted', async () => {
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Raced.' });
    // Right after the approval's own re-read, someone edits the page.
    w.after('miyabi', 'GET', 0, () => w.outsideEdit('miyabi', (b) => b.push(p('race', 'App edit.'))));
    const before = w.blockRequests('miyabi').length;
    await commands().approve('owner', r.body.proposalId);
    const d = (await waitFor(r.body.proposalId, ['executed', 'failed', 'conflicted'])) as any;
    expect(d.state).toBe('conflicted');
    expect(d.conflict.reason).toMatch(/inside the page’s lock\); nothing was written/);
    expect(methods(before)).toEqual(['GET', 'GET']); // the re-read and the in-lock read; no PUT
    expect(w.stored('miyabi').blocks.at(-1)).toMatchObject({ id: 'race' });
  });
  it('a proposal conflicted at execution (executing → conflicted) can be rejected, with its conflict details kept', async () => {
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Raced again.' });
    w.after('miyabi', 'GET', 0, () => w.outsideEdit('miyabi', (b) => b.push(p('race2', 'App edit.'))));
    await commands().approve('owner', r.body.proposalId);
    const d = (await waitFor(r.body.proposalId, ['executed', 'failed', 'conflicted'])) as any;
    expect(d.state).toBe('conflicted');
    const rejected = commands().reject('owner', r.body.proposalId, 'The page moved on') as any;
    expect(rejected).toMatchObject({
      state: 'rejected',
      rejectReason: 'The page moved on',
      decidedBy: 'owner',
    });
    expect(rejected.conflict.reason).toMatch(/inside the page’s lock/);
    const audit = commands()
      .listAudit('owner', { action: 'proposal.reject' })
      .find((a: any) => a.target === r.body.proposalId);
    expect(audit).toMatchObject({ before: { state: 'conflicted' } });
  });
  it('an outside write between the approved write and its verify read is caught by verify, and shown on the proposal', async () => {
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Verified?' });
    w.after('miyabi', 'PUT', 0, () => w.outsideEdit('miyabi', (b) => b.push(p('late', 'Right after.'))));
    await commands().approve('owner', r.body.proposalId);
    const d = (await waitFor(r.body.proposalId, ['executed', 'failed', 'conflicted'])) as any;
    expect(d.state).toBe('executed');
    expect(d.execution).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
  });
});
