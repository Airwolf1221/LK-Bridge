/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): "never by hand" (ADR 0059 decision 5.2): on a pack project, an edit that takes
 * `splits.guardWords` (120) words or more off a pack page is refused with USE_ARKONA_SPLIT. Each test asserts the SAFE
 * behaviour on one route (refused, or at least never a direct write that takes the material off): a pass means the
 * attempt HELD, a failure is a bypass (a finding). ADR 0059 departure 9 documents that `lk_api_write` is not guarded
 * for splits; ADR 0057 decision 4's deletes rail makes a low-level removal a proposal. Both are tried.
 *
 * - SP-28: write_page `replace` of the whole page without two sections.
 * - SP-29: the same material taken off in edits of under 120 words each (the owner's decision, ADR 0061 part B
 *   decision 2 (a): the guard is per edit, so this one asserts that each edit is written and on the Review page).
 * - SP-30: a key-value block holding ~300 words dropped with write_page (`dropRegions`).
 * - SP-31: lk_api_write replaceDocumentBlocks without the Biography's blocks.
 * - SP-32: lk_api_write replaceDocumentBlocks with every id kept and the Biography's text emptied (a proposal since
 *   ADR 0061 part B decision 1 (b): the deletes rail counts text taken off a pack page).
 * - SP-33: lk_api_batch updateBlock on each Biography paragraph (its text emptied; the same).
 * - SP-34: lk_api_write deleteBlock on a Biography paragraph.
 * - SP-43: update_document on a pack page's page document.
 *
 * Every call is made by an agent profile at scope write with the default rails (deletes on), as a new profile has.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, zahraBody, type SplitWorld } from '../../packs/split-world.js';
import { bodyOf, settle, type Obj } from '../../packs/split-helpers.js';
import { para, PROJECT, S, setBody } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const BIO = ['zb2', 'zb3', 'zb4', 'zb5', 'zb6', 'zb7', 'zb8', 'zb9'];
const words = (s: string) => s.split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
const textOfBlock = (b: Obj): string =>
  ((b.content as Obj[] | undefined) ?? []).map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
/** The words of a page's main document's paragraphs and headings (and key-value rows), as the mock holds them. */
const pageWords = (w: SplitWorld, pageId: string): number =>
  bodyOf(w, pageId).reduce(
    (n, b) =>
      n +
      words(textOfBlock(b)) +
      ((b.rows as Obj[] | undefined) ?? []).reduce(
        (k, r) => k + words(`${String(r.key)} ${typeof r.text === 'string' ? r.text : ''}`),
        0,
      ),
    0,
  );

describe('USE_ARKONA_SPLIT on every route', () => {
  let w: SplitWorld;
  /** An agent at scope write with the DEFAULT rails (the world's own token has them off, a test convenience). */
  let agent: Awaited<ReturnType<SplitWorld['stack']['connect']>>;
  const call = (name: string, args: Obj) => w.stack.call(agent, name, { project: 'test', ...args });
  const version = async (page: string) =>
    String(((await call('read_document', { resource: page })).body as any).version);
  /** Waits for a job a call started, if it started one. */
  const after = async (r: { body: any }) => {
    if (typeof r.body?.jobId === 'string') await settle(w, r.body.jobId);
  };
  beforeAll(async () => {
    w = await splitWorld();
    agent = await w.stack.connect(w.stack.newToken('r3-split-agent', 'write').token);
  });
  afterAll(() => w?.close());

  it('SP-28 write_page replace of the whole page without Biography and Appearance is refused', async () => {
    const before = pageWords(w, S.zahra);
    const md = String(((await call('read_document', { resource: S.zahra })).body as any).markdown ?? '');
    expect(md).toContain('## Biography');
    const cut = md.replace(/## Biography[\s\S]*?(?=## Personality)/, '');
    const r = await call('write_page', {
      page: S.zahra,
      mode: 'replace',
      markdown: cut,
      baseVersion: await version(S.zahra),
    });
    await after(r);
    expect({ code: (r.body as any).error?.code ?? null, lost: before - pageWords(w, S.zahra) }).toEqual({
      code: 'USE_ARKONA_SPLIT',
      lost: 0,
    });
  });

  // CR-2026-11-R3 (R3-52), decided (ADR 0061 part B decision 2, the owner's (a)): the guard is per edit. It steers agents
  // away from a split by hand and is not a security boundary: edits under the threshold are each written, and each is on
  // the Review page, where the owner sees it and can revert it (ADR 0055).
  it('SP-29 edits of under 120 words each are each written (the guard is per edit), each on the Review page', async () => {
    // A statute of ~260 words, cut by 100 words per edit (each edit under the threshold).
    const law = (statutesBody() as Obj[]).filter((b) =>
      ['sh3', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6'].includes(b.id as string),
    );
    const sl1 = textOfBlock(law[1]!).split(' ');
    const before = pageWords(w, S.statutes);
    const jobs: string[] = [];
    for (const keep of [sl1.length - 100, sl1.length - 200]) {
      const md = [
        '## Law and Courts',
        sl1.slice(0, keep).join(' '),
        ...law.slice(2).map((b) => textOfBlock(b)),
      ].join('\n\n');
      const r = await call('write_page', {
        page: S.statutes,
        mode: 'replace_section',
        section: 'Law and Courts',
        markdown: `${md}\n`,
        baseVersion: await version(S.statutes),
      });
      await after(r);
      expect((r.body as any).error?.code ?? null, r.text.slice(0, 300)).toBeNull();
      expect(typeof (r.body as any).jobId, r.text.slice(0, 300)).toBe('string');
      jobs.push((r.body as any).jobId as string);
    }
    // Each edit was under the threshold, so each went through; together they took about 200 words off.
    expect(before - pageWords(w, S.statutes)).toBeGreaterThanOrEqual(190);
    const review = w.stack.runtime.review.list(PROJECT, { state: 'all' });
    for (const jobId of jobs) {
      const item = review.find((i) => i.jobId === jobId);
      expect(item, `job ${jobId} on the Review page`).toBeDefined();
      expect(item!.tool).toBe('write_page');
      expect(item!.pages.map((p) => p.id)).toContain(S.statutes);
    }
  });

  it('SP-30 a key-value block of ~300 words dropped with write_page is refused (USE_ARKONA_SPLIT)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `okvr${i}`,
      rank: `a${i}`,
      key: `Statute ${i + 1}`,
      content: [
        {
          text: 'The assize hears the dispute in the open square and three magistrates seal the verdict in wax before the bell.',
        },
      ],
      text: 'The assize hears the dispute in the open square and three magistrates seal the verdict in wax before the bell.',
    }));
    const body = statutesBody() as Obj[];
    body.splice(body.findIndex((b) => b.id === 'so1') + 1, 0, {
      id: 'okv',
      kind: 'keyValue',
      display: 'list',
      title: 'The statutes in brief',
      rows,
    });
    setBody(w, S.statutes, body);
    const before = pageWords(w, S.statutes);
    const so1 = textOfBlock(body.find((b) => b.id === 'so1')!);
    const r = await call('write_page', {
      page: S.statutes,
      mode: 'replace_section',
      section: 'Overview',
      markdown: `## Overview\n\n${so1}\n`,
      dropRegions: ['okv'],
      baseVersion: await version(S.statutes),
    });
    await after(r);
    const lost = before - pageWords(w, S.statutes);
    expect(
      { code: (r.body as any).error?.code ?? null, lost },
      `${String((r.body as any).status ?? '')} ${r.text.slice(0, 300)}`,
    ).toEqual({ code: 'USE_ARKONA_SPLIT', lost: 0 });
  });

  it('SP-31 lk_api_write replaceDocumentBlocks without the Biography is never a direct write', async () => {
    setBody(
      w,
      S.zahra,
      zahraBody((id) => `https://assets.test:${w.port}/a/${id}.webp`),
    );
    const doc = w.repo.blocks.get(w.mainOf(S.zahra))!;
    const blocks = (doc.blocks as Obj[]).filter((b) => !BIO.includes(b.id as string));
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: S.zahra, documentId: w.mainOf(S.zahra) },
        ifMatch: `v${doc.version}`,
        body: { blocks },
      },
    });
    await after(r);
    const still = BIO.filter((id) => bodyOf(w, S.zahra).some((b) => b.id === id));
    expect({ status: (r.body as any).status ?? (r.body as any).error?.code, still: still.length }).toEqual({
      status: expect.stringMatching(/proposal_captured|USE_ARKONA_SPLIT/),
      still: BIO.length,
    });
  });

  // CR-2026-11-R3 (R3-53), decided (ADR 0061 part B decision 1, the owner's (b)): the deletes rail counts a low-level write
  // that takes the pack's guardWords words or more off a pack page as a removal, so this is a proposal.
  it('SP-32 lk_api_write replaceDocumentBlocks keeping every id but emptying the Biography is never a direct write', async () => {
    setBody(
      w,
      S.zahra,
      zahraBody((id) => `https://assets.test:${w.port}/a/${id}.webp`),
    );
    const doc = w.repo.blocks.get(w.mainOf(S.zahra))!;
    const before = pageWords(w, S.zahra);
    const blocks = (doc.blocks as Obj[]).map((b) =>
      BIO.includes(b.id as string) ? { ...b, content: [{ text: '.' }] } : b,
    );
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: S.zahra, documentId: w.mainOf(S.zahra) },
        ifMatch: `v${doc.version}`,
        body: { blocks },
      },
    });
    await after(r);
    const lost = before - pageWords(w, S.zahra);
    expect(
      { lost },
      `${String((r.body as any).status ?? (r.body as any).error?.code)}: ${lost} words taken off directly`,
    ).toEqual({
      lost: 0,
    });
    // Held as a proposal by the deletes rail, which says why.
    expect((r.body as any).status, r.text.slice(0, 400)).toBe('proposal_captured');
    expect(r.text).toMatch(
      /text removal \(\d+ words off “[^”]+”, a page of a character’s set; the pack's threshold is 120\)/,
    );
  });

  // CR-2026-11-R3 (R3-53), decided (ADR 0061 part B decision 1, the owner's (b)): the deletes rail counts a low-level write
  // that takes the pack's guardWords words or more off a pack page as a removal, so this is a proposal.
  it('SP-33 lk_api_batch updateBlock emptying each Biography paragraph is never a direct write', async () => {
    setBody(
      w,
      S.zahra,
      zahraBody((id) => `https://assets.test:${w.port}/a/${id}.webp`),
    );
    const before = pageWords(w, S.zahra);
    const r = await call('lk_api_batch', {
      calls: BIO.map((id) => ({
        operationId: 'updateBlock',
        params: {
          path: { resourceId: S.zahra, documentId: w.mainOf(S.zahra), blockId: id },
          body: { content: [{ text: '.' }] },
        },
      })),
    });
    await after(r);
    const lost = before - pageWords(w, S.zahra);
    expect(
      { lost },
      `${String((r.body as any).status ?? (r.body as any).error?.code)}: ${lost} words taken off directly`,
    ).toEqual({
      lost: 0,
    });
    // Held as a proposal by the deletes rail, which says why.
    expect((r.body as any).status, r.text.slice(0, 400)).toBe('proposal_captured');
    expect(r.text).toMatch(
      /text removal \(\d+ words off “[^”]+”, a page of a character’s set; the pack's threshold is 120\)/,
    );
  });

  it('SP-34 lk_api_write deleteBlock on a Biography paragraph is never a direct write', async () => {
    setBody(
      w,
      S.zahra,
      zahraBody((id) => `https://assets.test:${w.port}/a/${id}.webp`),
    );
    const doc = w.repo.blocks.get(w.mainOf(S.zahra))!;
    const r = await call('lk_api_write', {
      operationId: 'deleteBlock',
      params: {
        path: { resourceId: S.zahra, documentId: w.mainOf(S.zahra), blockId: 'zb3' },
        ifMatch: `v${doc.version}`,
      },
    });
    await after(r);
    expect({
      status: (r.body as any).status ?? (r.body as any).error?.code,
      zb3: bodyOf(w, S.zahra).some((b) => b.id === 'zb3'),
    }).toEqual({ status: expect.stringMatching(/proposal_captured|USE_ARKONA_SPLIT/), zb3: true });
    void para;
    void PROJECT;
  });

  it('SP-43 update_document cannot change a pack page’s page document (its text is write_page’s)', async () => {
    setBody(
      w,
      S.zahra,
      zahraBody((id) => `https://assets.test:${w.port}/a/${id}.webp`),
    );
    const before = pageWords(w, S.zahra);
    const r = await call('update_document', { page: S.zahra, document: 'Main', name: 'Notes', hidden: true });
    await after(r);
    expect({ code: (r.body as any).error?.code ?? null, lost: before - pageWords(w, S.zahra) }).toEqual({
      code: 'DOCUMENT_IS_PAGE',
      lost: 0,
    });
  });
});
