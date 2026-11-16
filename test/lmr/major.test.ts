/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3c (ADR 0051 decision 1): Last Major Revision only for real revisions (the owner, 16 November 2026: "Tiny edits
 * like this aren't enough for a major revision"), end to end through the real server, the MCP client, the policy layer
 * and the engine, against the facts world's faithful sidebars:
 *
 * - the two Arkona cases are skipped: a Subject trimmed to a prefix of itself, and one KCY cell fixed in a table row;
 * - Nezrin's seven-fact identity rewrite sets it;
 * - each boundary behaves as stated: 7 and 8 words, a typo and a real word change, a punctuation-only fact;
 * - the override works both ways (`set` on a typo, `skip` on a real revision), and the answer and the proposal say
 *   which applied and why.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, RHEASHIRA, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let writer: Client;
let proposer: Client;
const LMR_ROW = 'rhea0013';
const OLD = '9 November 2026';
const sb = () => w.sidebars;
const lmr = () =>
  sb()
    .rows(RHEASHIRA.page)
    .find((r) => r.key === 'Last Major Revision')!.text;
const today = () => londonDate(Date.now());

/** Sets a sidebar row's text directly in the model (as the owner's edits in the app would). */
const setRow = (rowId: string, text: string) => {
  const row = sb()
    .pages.get(RHEASHIRA.page)!
    .props[0]!.rows!.find((r) => r.id === rowId)!;
  row.content = [{ text }];
};

const doc = () => w.repo.liveDocs(w.repo.live(RHEASHIRA.page)!)[0]!;

beforeAll(async () => {
  w = await factsWorld();
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('lmr-major-proposer', 'propose').token);
  // As the tree would know the page: its PROPERTIES with a Last Major Revision row (the planner reads nothing).
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: RHEASHIRA.property,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { key: 'Status', text: '' },
          { key: 'Last Major Revision', text: '' },
        ],
      },
    ]),
    PROJECT,
    RHEASHIRA.page,
  );
});
afterAll(async () => w.close());
beforeEach(() => {
  setRow(LMR_ROW, OLD);
  setRow('rhea0012', 'Moon elf envoy to the Hollow Court');
});

const facts = (client: Client, f: Record<string, string>, extra: Record<string, unknown> = {}) =>
  w.stack.call(client, 'set_facts', { page: RHEASHIRA.page, facts: f, ...extra });
const append = (text: string, extra: Record<string, unknown> = {}, client = writer) =>
  w.stack.call(client, 'write_page', { page: RHEASHIRA.page, mode: 'append', markdown: text, ...extra });

describe('the Arkona cases (16 November 2026) are not major revisions', () => {
  it('a Subject trimmed to a prefix of itself: not set, and the answer says why', async () => {
    setRow('rhea0005', 'Mehrana al-Khalid — one character across two successive incarnations');
    const r = await facts(writer, { Subject: 'Mehrana al-Khalid' });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(r.body.lastMajorRevision).toBe(
      'Last Major Revision skipped: Subject: a trimmed value, not a major revision',
    );
  });

  it('the same trim proposed: the proposal says the date is skipped, and why', async () => {
    setRow('rhea0005', 'Mehrana al-Khalid — one character across two successive incarnations');
    const r = await facts(proposer, { Subject: 'Mehrana al-Khalid' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!.summary).toContain(
      'Last Major Revision skipped: Subject: a trimmed value, not a major revision',
    );
  });

  it('one KCY cell fixed in a table row (a block write, measured when it runs): not set', async () => {
    const cell = (t: string) => ({
      kind: 'tableCell',
      children: [{ kind: 'paragraph', content: [{ text: t }] }],
    });
    const row = (kcy: string) => ({
      id: 'lmrrow01',
      kind: 'tableRow',
      children: [cell('The Menkhet charter is sealed'), cell('c. 4A 563; exact date unresolved'), cell(kcy)],
    });
    w.repo.blocks.set(doc().id, {
      version: 7,
      blocks: [{ id: 'lmrtab01', kind: 'table', children: [row('1,250,870')] }],
    });
    const read = await w.stack.call(writer, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: RHEASHIRA.page, documentId: doc().id } },
      detail: 'full',
    });
    const r = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'replaceBlock',
      params: {
        path: { resourceId: RHEASHIRA.page, documentId: doc().id, blockId: 'lmrrow01' },
        ifMatch: String(read.body.result?.version ?? ''),
        body: row('1,250,872'),
      },
    });
    expect(r.body.status, r.text).toBe('succeeded');
    expect(lmr()).toBe(OLD);
    expect(r.body.lastMajorRevision).toBe(
      'Last Major Revision not set: 1 word of page text changed (fewer than 8), not a major revision',
    );
  });
});

describe('real revisions set it', () => {
  it('Nezrin’s seven-fact identity rewrite sets it', async () => {
    const r = await facts(writer, {
      Subject: 'Nezrin Aydın',
      'Canonical Display Name': 'Nezrin Aydın',
      'Family / Surname': 'Aydın',
      'Personal / Given Name': 'Nezrin',
      'Naming Culture': 'Menkheti',
      Aliases: 'the Quiet Envoy',
      Scope: 'Menkheti envoy to the Divan',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(today());
    expect(r.body.lastMajorRevision).toBe(
      `Last Major Revision set to ${today()} (auto: Subject: a fact changed)`,
    );
  });
});

describe('the boundaries', () => {
  it('7 words of new text: not set; 8 words: set', async () => {
    const seven = await append('One two three four five six seven.');
    expect(seven.body.status, seven.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(seven.body.lastMajorRevision).toBe(
      'Last Major Revision skipped: 7 words of page text changed (fewer than 8), not a major revision',
    );
    const eight = await append('One two three four five six seven eight.');
    expect(eight.body.status, eight.text).toBe('written');
    expect(lmr()).toBe(today());
  });

  it('a typo fix in a fact: not set; a real word change: set', async () => {
    const typo = await facts(writer, { Scope: 'Moon elf envoy to the Holow Court' });
    expect(typo.body.status, typo.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(typo.body.lastMajorRevision).toContain('Scope: a typo fix, not a major revision');
    const real = await facts(writer, { Scope: 'Moon elf envoy to the Silver Court' });
    expect(real.body.status, real.text).toBe('written');
    expect(lmr()).toBe(today());
  });

  it('a punctuation-only fact: not set', async () => {
    const r = await facts(writer, { Scope: 'Moon-elf envoy to the Hollow Court.' });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(r.body.lastMajorRevision).toBe(
      'Last Major Revision skipped: Scope: only punctuation, dashes, whitespace or capitalisation changed, not a major revision',
    );
  });
});

describe('the override works both ways', () => {
  it('lastMajorRevision "set" sets it on a typo fix', async () => {
    const r = await facts(
      writer,
      { Scope: 'Moon elf envoy to the Holow Court' },
      { lastMajorRevision: 'set' },
    );
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(today());
    expect(r.body.lastMajorRevision).toBe(
      `Last Major Revision set to ${today()} (set: lastMajorRevision "set" was asked)`,
    );
  });

  it('lastMajorRevision "skip" leaves it on a real revision', async () => {
    const r = await append('Eight words of new text about the envoy here.', { lastMajorRevision: 'skip' });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(r.body.lastMajorRevision).toBe('Last Major Revision skipped: lastMajorRevision "skip" was asked');
  });

  it('a proposal says which applied and why', async () => {
    const set = await facts(
      proposer,
      { Scope: 'Moon elf envoy to the Holow Court' },
      { lastMajorRevision: 'set' },
    );
    expect(w.stack.runtime.policy.proposals.get(String(set.body.proposalId))!.summary).toContain(
      '+ Last Major Revision → date of approval (set: lastMajorRevision "set" was asked)',
    );
    const skip = await append(
      'Eight words of new text about the envoy here.',
      { lastMajorRevision: 'skip' },
      proposer,
    );
    expect(w.stack.runtime.policy.proposals.get(String(skip.body.proposalId))!.summary).toContain(
      'Last Major Revision skipped: lastMajorRevision "skip" was asked',
    );
  });

  it('refuses another value', async () => {
    const r = await facts(writer, { Scope: 'x' }, { lastMajorRevision: 'always' });
    expect(r.isError).toBe(true);
    expect(lmr()).toBe(OLD);
  });
});
