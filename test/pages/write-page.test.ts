/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * write_page end to end (v2 C1): the REAL server, runtime, policy and job engine, the official MCP SDK client at scope
 * `write` (and `read`), and the mock LegendKeeper holding B1's real-page fixtures. Every mode, every refusal, the empty
 * plan, the baseVersion rules, the compare-and-swap inside the lock, the verify read, unsupported blocks, the journal,
 * dry runs, twins, and the cost of a write. Proposals (scope `propose`) are in proposals.test.ts; concurrency in
 * concurrency.test.ts.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMarkdown, type LkBlock } from '../../src/markdown/index.js';
import { sha256 } from '../../src/pages/index.js';
import { FIXTURE_PAGES, pagesWorld, textOf, type PagesWorld } from './world.js';

let w: PagesWorld;
let c: Client;
const call = (args: Record<string, unknown>, client = c) =>
  w.stack.call(client, 'write_page', { project: 'test', ...args });
const read = (args: Record<string, unknown>) => w.stack.call(c, 'read_document', args);
const methods = (page: string, since: number) =>
  w
    .blockRequests(page)
    .slice(since)
    .map((r) => r.method);
const puts = (page: string, since = 0) =>
  w
    .blockRequests(page)
    .slice(since)
    .filter((r) => r.method === 'PUT');

const h = (id: string, level: number, text: string): LkBlock => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const p = (id: string, text: string): LkBlock => ({ id, kind: 'paragraph', content: [{ text }] });
/** Miyabi's page as the discover world seeds it (Biography and Relations, each with a Notes; an unsupported block). */
function miyabi(): LkBlock[] {
  return [
    h('mh1', 1, 'Asagiri Miyabi'),
    p('mp1', 'A Foxian shrine maiden.'),
    h('mh2', 2, 'Biography'),
    h('mh3', 3, 'Early Life'),
    p('mp2', 'Born on Kumikas 1st, 4A 881.'),
    h('mh4', 3, 'Notes'),
    p('mp3', 'First notes.'),
    h('mh5', 2, 'Relations'),
    h('mh6', 3, 'Notes'),
    p('mp4', 'Second notes.'),
    { id: 'unsup1', kind: 'unsupported' },
  ];
}

beforeAll(async () => {
  w = await pagesWorld();
  c = await w.stack.connect();
});
afterAll(() => w.close());
beforeEach(() => {
  w.setPage('miyabi', miyabi(), 3);
});

describe('the tool', () => {
  it('is a write tool with honest annotations: seen at write and propose, hidden and refused at read', async () => {
    const tools = await c.listTools();
    const t = tools.tools.find((x) => x.name === 'write_page')!;
    expect(t.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(t.description).toContain('baseVersion');
    const propose = await w.stack.connect(w.stack.newToken('pages-propose-list', 'propose').token);
    expect((await propose.listTools()).tools.map((x) => x.name)).toContain('write_page');
    const reader = await w.stack.connect(w.stack.newToken('pages-read', 'read').token);
    expect((await reader.listTools()).tools.map((x) => x.name)).not.toContain('write_page');
    const before = w.blockRequests('miyabi').length;
    const refused = await call({ page: 'miyabi01', mode: 'append', markdown: 'x' }, reader);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/read-only/);
    expect(w.blockRequests('miyabi').length).toBe(before); // nothing read or written
  });
  it('names the project (required for writes when several are served; one here) and ends with its budget line', async () => {
    const r = await w.stack.call(c, 'write_page', { page: 'miyabi01', mode: 'append', markdown: 'Plain.' });
    expect(r.body.project).toBe('test');
    expect(r.footer).toMatch(/^budget \(test\)/);
  });
});

describe('every mode, end to end', () => {
  it('append: 2 reads and 1 write, plus the verify read; the result says what changed and that it was verified', async () => {
    const before = w.blockRequests('miyabi').length;
    // "Asagiri Miyabi" names both her index and her page; the prefix tells them apart (A3's resolver).
    expect((await call({ page: 'Asagiri Miyabi', mode: 'append', markdown: 'x' })).body.error.code).toBe(
      'AMBIGUOUS',
    );
    const r = await call({
      page: '[BSRC] Asagiri Miyabi',
      mode: 'append',
      markdown: 'Appended at the end.',
      baseVersion: 'v3',
    });
    expect(r.isError, r.text).toBe(false);
    expect(methods('miyabi', before)).toEqual(['GET', 'GET', 'PUT', 'GET']); // plan, lock, write, verify
    expect(puts('miyabi', before)[0]!.ifMatch).toBe('v3');
    expect(r.body).toMatchObject({
      status: 'written',
      mode: 'append',
      version: 'v4',
      previousVersion: 'v3',
      verified: true,
      counts: { kept: 11, changed: 0, added: 1, removed: 0, regionsKept: 1, regionsDropped: 0 },
      page: { id: 'miyabi01', name: 'Asagiri Miyabi' },
      document: { id: w.doc('miyabi'), name: 'Main' },
    });
    expect(r.body.jobId).toMatch(/^j/);
    expect(r.body.diff).toBeUndefined(); // only with detail: "full"
    expect(r.body.diffLines).toEqual({ added: 2, removed: 0 });
    expect(textOf(w.stored('miyabi').blocks.at(-1))).toBe('Appended at the end.');
  });
  it('prepend, replace, replace_section and append_to_section', async () => {
    let r = await call({ page: 'miyabi01', mode: 'prepend', markdown: '> Epigraph.' });
    expect(r.body.status).toBe('written');
    expect(w.stored('miyabi').blocks[0]!.kind).toBe('quote');

    w.setPage('miyabi', miyabi(), 3);
    const md = toMarkdown(miyabi()).markdown.replace(
      'A Foxian shrine maiden.',
      'A Foxian shrine maiden of the Hollow Court.',
    );
    r = await call({ page: 'miyabi01', mode: 'replace', markdown: md, baseVersion: 'v3' });
    expect(r.body).toMatchObject({ status: 'written', counts: { changed: 1, added: 0, removed: 0 } });
    expect(w.stored('miyabi').blocks[1]).toEqual({
      id: 'mp1',
      kind: 'paragraph',
      content: [{ text: 'A Foxian shrine maiden of the Hollow Court.' }],
    });

    w.setPage('miyabi', miyabi(), 3);
    r = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Biography > Notes',
      markdown: 'New notes.',
      detail: 'full',
    });
    expect(r.body).toMatchObject({
      status: 'written',
      section: 'Asagiri Miyabi > Biography > Notes',
      counts: { changed: 1 },
    });
    expect(r.body.diff).toContain('-First notes.');
    expect(r.body.diff).toContain('+New notes.');
    expect(w.stored('miyabi').blocks.find((b) => b.id === 'mp3')).toMatchObject({
      content: [{ text: 'New notes.' }],
    });
    expect(w.stored('miyabi').blocks.find((b) => b.id === 'mp4')).toMatchObject({
      content: [{ text: 'Second notes.' }],
    });

    w.setPage('miyabi', miyabi(), 3);
    r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Early Life',
      markdown: '- Trained at the shrine.',
    });
    expect(r.body.status).toBe('written');
    const s = w.stored('miyabi').blocks;
    const at = s.findIndex((b) => b.kind === 'bulletList');
    expect(s[at - 1]!.id).toBe('mp2');
    expect(s[at + 1]!.id).toBe('mh4');
  });
  it('an edit that changes nothing writes nothing: no job, no PUT, "no_change"', async () => {
    const before = w.blockRequests('miyabi').length;
    const r = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Early Life',
      markdown: '### Early Life\n\nBorn on Kumikas 1st, 4A 881.',
    });
    expect(r.body).toMatchObject({ status: 'no_change', version: 'v3' });
    expect(r.body.jobId).toBeUndefined();
    expect(methods('miyabi', before)).toEqual(['GET']);
  });
});

describe('every refusal is typed, and nothing is written', () => {
  const refused = async (args: Record<string, unknown>) => {
    const before = puts('miyabi').length + puts(FIXTURE_PAGES.rich).length;
    const r = await call(args);
    expect(r.isError, r.text).toBe(true);
    expect(puts('miyabi').length + puts(FIXTURE_PAGES.rich).length).toBe(before);
    return r.body.error;
  };
  it('keep regions missing (with the ids); dropping an unsupported block is never allowed', async () => {
    const md = toMarkdown(miyabi()).markdown.replace(/<!-- lk:keep[\s\S]*<!-- \/lk:keep -->\n/, '');
    expect(await refused({ page: 'miyabi01', mode: 'replace', markdown: md })).toMatchObject({
      code: 'KEEP_REGIONS_MISSING',
      ids: ['unsup1'],
    });
    expect(
      await refused({ page: 'miyabi01', mode: 'replace', markdown: md, dropRegions: ['unsup1'] }),
    ).toMatchObject({
      code: 'UNSUPPORTED_BLOCK_LOSS',
      blockIds: ['unsup1'],
    });
  });
  it('mentions: not found, ambiguous (with the candidates and their paths)', async () => {
    expect(
      (await refused({ page: 'miyabi01', mode: 'append', markdown: 'See [[Nobody At All]].' })).code,
    ).toBe('MENTION_NOT_FOUND');
    const amb = await refused({ page: 'miyabi01', mode: 'append', markdown: 'See [[Ashgate]].' });
    expect(amb.code).toBe('MENTION_AMBIGUOUS');
    expect(JSON.stringify(amb.problems)).toContain('ashg0001');
    expect(JSON.stringify(amb.problems)).toContain('ashg0002');
    // A unique name resolves through A3's resolver (inside the AI REPOSITORY).
    const ok = await call({ page: 'miyabi01', mode: 'append', markdown: 'Her sister is [[Asagiri Kaede]].' });
    expect(ok.body.status).toBe('written');
    expect(JSON.stringify(w.stored('miyabi').blocks.at(-1))).toContain('"resourceId":"kaede001"');
  });
  it('editor limits and field limits', async () => {
    const e = await refused({
      page: 'miyabi01',
      mode: 'append',
      markdown:
        '```lk-block\n{ "kind": "callout", "tone": "info", "color": "#7A3E9D", "children": [{ "kind": "paragraph", "content": [{ "text": "x" }] }] }\n```',
    });
    expect(e).toMatchObject({ code: 'EDITOR_LIMIT', rule: 'callout.color' });
    expect((await refused({ page: 'miyabi01', mode: 'append', markdown: 'y'.repeat(100_001) })).code).toBe(
      'FIELD_LIMIT',
    );
  });
  it('a missing section (with the headings), a duplicate one (with the options), a mode without its section', async () => {
    const nf = await refused({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Childhood',
      markdown: 'x',
    });
    expect(nf.code).toBe('SECTION_NOT_FOUND');
    expect(nf.available.map((a: any) => a.path)).toContain('Asagiri Miyabi > Biography > Early Life');
    const amb = await refused({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'x',
    });
    expect(amb.code).toBe('SECTION_AMBIGUOUS');
    expect(amb.options.map((o: any) => o.choose)).toEqual([
      'Asagiri Miyabi > Biography > Notes [1]',
      'Asagiri Miyabi > Relations > Notes [2]',
    ]);
    expect((await refused({ page: 'miyabi01', mode: 'replace_section', markdown: 'x' })).code).toBe(
      'INVALID_PARAMS',
    );
    expect((await refused({ page: 'miyabi01', mode: 'append', section: 'Notes', markdown: 'x' })).code).toBe(
      'INVALID_PARAMS',
    );
  });
  it('maps, timelines and boards point to the right tool; pages outside the root and unknown documents are refused', async () => {
    const map = await refused({ page: 'maps0001', document: 'Arkona map', mode: 'append', markdown: 'x' });
    expect(map).toMatchObject({ code: 'WRONG_TOOL_FOR_DOCUMENT' });
    expect(map.message).toMatch(/map.*create_map_feature.*update_map_feature.*delete_map_feature/); // v2 D2
    expect(
      (await refused({ page: 'age4tl01', document: 'Fourth Age - Timeline', mode: 'append', markdown: 'x' }))
        .message,
    ).toMatch(/timeline.*createEvent/);
    expect(
      (await refused({ page: 'board001', document: 'Plot board', mode: 'append', markdown: 'x' })).message,
    ).toMatch(/board.*createBoardShapes/);
    expect((await refused({ page: 'outside1', mode: 'append', markdown: 'x' })).code).toBe(
      'NOT_IN_REPOSITORY',
    );
    expect((await refused({ page: 'miyabi01', document: 'Nope', mode: 'append', markdown: 'x' })).code).toBe(
      'DOCUMENT_NOT_FOUND',
    );
    expect((await refused({ page: 'Ashgate', mode: 'append', markdown: 'x' })).code).toBe('AMBIGUOUS');
  });
});

describe('baseVersion', () => {
  it('the version read_document returned: the write goes ahead', async () => {
    const r0 = await read({ resource: 'miyabi01' });
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'x', baseVersion: r0.body.version });
    expect(r.body.status).toBe('written');
  });
  it('a section mode from an older read: goes ahead when that section is unchanged, refuses when it changed', async () => {
    const r0 = await read({ resource: 'miyabi01' }); // v3, remembered by the bridge
    w.outsideEdit('miyabi', (b) => (b[1] = p('mp1', 'Edited elsewhere on the page.'))); // v4, another section
    const ok = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Early Life',
      markdown: 'Fine.',
      baseVersion: r0.body.version,
    });
    expect(ok.body).toMatchObject({ status: 'written', previousVersion: 'v4', version: 'v5' });
    expect(ok.body.note).toMatch(/section is unchanged/);
    expect(w.stored('miyabi').blocks[1]).toMatchObject({
      content: [{ text: 'Edited elsewhere on the page.' }],
    }); // kept

    w.setPage('miyabi', miyabi(), 3);
    const r1 = await read({ resource: 'miyabi01' });
    w.outsideEdit('miyabi', (b) => (b[4] = p('mp2', 'Born in winter.'))); // inside Early Life
    const before = puts('miyabi').length;
    const no = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Early Life',
      markdown: 'Mine.',
      baseVersion: r1.body.version,
    });
    expect(no.isError).toBe(true);
    expect(no.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'section_changed',
      baseVersion: 'v3',
      currentVersion: 'v4',
      section: 'Asagiri Miyabi > Biography > Early Life',
      currentSection: '### Early Life\n\nBorn in winter.\n',
    });
    expect(no.body.error.hint).toMatch(/Do not retry/);
    expect(puts('miyabi').length).toBe(before);
  });
  it('a whole-page mode from an older version: a conflict with the current version, nothing written', async () => {
    w.outsideEdit('miyabi', (b) => b.push(p('x1', 'Added in the app.'))); // v4
    for (const mode of ['append', 'prepend', 'replace'] as const) {
      const r = await call({ page: 'miyabi01', mode, markdown: 'x', baseVersion: 'v3' });
      expect(r.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        reason: 'version_changed',
        currentVersion: 'v4',
      });
    }
  });
  it('a version the bridge never saw: a section edit is refused with the current section text', async () => {
    w.setPage('miyabi', miyabi(), 40);
    const r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Early Life',
      markdown: 'x',
      baseVersion: 'v39',
    });
    expect(r.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'base_unknown',
      currentVersion: 'v40',
    });
    expect(r.body.error.currentSection).toBe('### Early Life\n\nBorn on Kumikas 1st, 4A 881.\n');
  });
});

describe('the compare-and-swap inside the lock (an outside write between the plan and the write)', () => {
  it('a section edit whose section is unchanged is re-planned on the new version, and the outside edit is kept', async () => {
    w.after('miyabi', 'GET', 0, () =>
      w.outsideEdit('miyabi', (b) => (b[9] = p('mp4', 'Relations edited in the app.'))),
    );
    const before = w.blockRequests('miyabi').length;
    const r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Early Life',
      markdown: 'Re-planned.',
    });
    expect(methods('miyabi', before)).toEqual(['GET', 'GET', 'PUT', 'GET']); // still one write, re-planned in the lock
    expect(r.body).toMatchObject({ status: 'written', verified: true, version: 'v5' });
    expect(r.body.note).toMatch(/inside the lock/);
    expect(puts('miyabi', before)[0]!.ifMatch).toBe('v4');
    const s = w.stored('miyabi').blocks;
    expect(s.find((b) => b.id === 'mp4')).toMatchObject({
      content: [{ text: 'Relations edited in the app.' }],
    });
    expect(s.some((b) => textOf(b) === 'Re-planned.')).toBe(true);
    // The journal records that the write was re-planned inside the lock.
    const j = await w.stack.call(c, 'bridge_journal_lookup', { jobId: r.body.jobId });
    expect(j.body.entries[0].operation).toMatchObject({
      replannedInLock: { from: 'v3', to: 'v4', sectionUnchanged: true },
    });
  });
  it('a section edit whose section changed: a conflict with the section as it is now, nothing written', async () => {
    w.after('miyabi', 'GET', 0, () => w.outsideEdit('miyabi', (b) => (b[4] = p('mp2', 'Born at dawn.'))));
    const before = w.blockRequests('miyabi').length;
    const r = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Early Life',
      markdown: 'Mine.',
    });
    expect(methods('miyabi', before)).toEqual(['GET', 'GET']);
    expect(r.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'section_changed',
      currentVersion: 'v4',
      currentSection: '### Early Life\n\nBorn at dawn.\n',
    });
  });
  it('a whole-page edit: a conflict, nothing written', async () => {
    w.after('miyabi', 'GET', 0, () => w.outsideEdit('miyabi', (b) => b.push(p('x2', 'App.'))));
    const before = w.blockRequests('miyabi').length;
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Mine.' });
    expect(methods('miyabi', before)).toEqual(['GET', 'GET']);
    expect(r.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'changed_while_waiting',
      currentVersion: 'v4',
    });
    expect(r.body.error.jobId).toMatch(/^j/);
  });
});

describe('verify (the read after the write)', () => {
  it('a write that landed as planned is verified', async () => {
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'Checked.' });
    expect(r.body.verified).toBe(true);
    const job = await w.stack.call(c, 'bridge_job_status', { jobId: r.body.jobId });
    expect(job.body.job?.result ?? job.body.result).toMatchObject({
      verified: true,
      verification: { status: 'verified' },
    });
  });
  it('a stored result that differs (mangled by the mock): "written but not as planned", recorded, never retried', async () => {
    // LegendKeeper (the mock) stores something else than what was sent, without a new version.
    w.after('miyabi', 'PUT', 0, () => {
      const b = w.stack && (w.repo.blocks.get(w.doc('miyabi'))!.blocks as LkBlock[]);
      (b.at(-1) as any).content = [{ text: 'Mangled.' }];
    });
    const before = w.blockRequests('miyabi').length;
    const r = await call({ page: 'miyabi01', mode: 'append', markdown: 'As planned.' });
    expect(methods('miyabi', before)).toEqual(['GET', 'GET', 'PUT', 'GET']); // one PUT: not retried
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ status: 'written', verified: false });
    expect(r.body.warning).toMatch(/^written but not as planned: .*1 difference.*journal entry \d+/);
    expect(r.body.verification).toMatchObject({ status: 'mismatch', differenceCount: 1 });
    expect(r.body.verification.differences[0]).toMatchObject({ expected: 'As planned.', actual: 'Mangled.' });
    expect(r.body.verification.ignored).toHaveLength(5);
    // On the job, and in the errors table (the dashboard's Errors page).
    const job = w.stack.runtime.engine.queries.getJob('proj_mock', r.body.jobId)!;
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
    const errs = await w.stack.call(c, 'bridge_errors_recent', { grouped: false, jobId: r.body.jobId });
    expect(JSON.stringify(errs.body)).toContain('VERIFY_MISMATCH');
    // The journal reference holds the page as it was before.
    const j = await w.stack.call(c, 'bridge_journal_lookup', { jobId: r.body.jobId, includePreImage: true });
    expect(j.body.entries[0].id).toBe(r.body.verification.journalId);
  });
});

describe('what is sent and recorded', () => {
  it('every unsupported block is echoed by id, and the journal keeps the pre-image and the high-level operation', async () => {
    const before = w.blockRequests('miyabi').length;
    const markdown = 'Echo check.';
    const r = await call({
      page: 'miyabi01',
      mode: 'append_to_section',
      section: 'Biography > Notes',
      markdown,
      baseVersion: 'v3',
    });
    const sent = puts('miyabi', before)[0]!.body as { blocks: LkBlock[] };
    expect(sent.blocks).toContainEqual({ id: 'unsup1', kind: 'unsupported' });
    const j = await w.stack.call(c, 'bridge_journal_lookup', { jobId: r.body.jobId, includePreImage: true });
    const e = j.body.entries[0];
    expect(e).toMatchObject({ op: 'replaceDocumentBlocks', outcome: 'applied', version: 'v3' });
    expect(e.operation).toEqual({
      tool: 'write_page',
      mode: 'append_to_section',
      section: 'Asagiri Miyabi > Biography > Notes',
      markdownSha256: sha256(markdown),
      markdownChars: markdown.length,
      plannedOn: 'v3',
      baseVersion: 'v3',
    });
    const journal = w.stack.runtime.engine.queries.journalLookup('proj_mock', {
      jobId: r.body.jobId,
      includePreImage: true,
    });
    expect((journal[0]!.preImage as { blocks: unknown }).blocks).toEqual(miyabi());
  });
  it('the rich page: an inline icon LegendKeeper would not take back means block by block (E4), a dry run sends nothing', async () => {
    const { richPage } = await import('../markdown/fixtures.js');
    w.setPage(FIXTURE_PAGES.rich, richPage(), 1);
    const before = w.blockRequests(FIXTURE_PAGES.rich).length;
    const r = await call({
      page: 'qishen01',
      mode: 'append_to_section',
      section: 'Customs',
      markdown: 'x',
      dryRun: true,
    });
    // C1 refused this page as PAGE_NOT_WRITABLE; v2 E4 (ADR 0046) writes only the blocks the edit changes, one by one
    // (test/pages/blockwise.test.ts). An edit to the icon paragraph itself is still refused there.
    expect(r.body).toMatchObject({ status: 'dry_run', blockwise: { writes: 1, inserts: 1 } });
    expect(methods(FIXTURE_PAGES.rich, before)).toEqual(['GET']);
  });
  it('the infobox / collection / unsupported page: an edit keeps every keep region exactly, and echoes the unsupported block', async () => {
    const { richPage } = await import('../markdown/fixtures.js');
    const page = richPage().filter((b) => b.id !== 'richp002'); // without the inline icon (above)
    w.setPage(FIXTURE_PAGES.rich, page, 1);
    const md = toMarkdown(page).markdown;
    const customs = md
      .slice(md.indexOf('## Customs'))
      .replace('Offerings are left at dawn.', 'Offerings are left at dusk.');
    const since = w.blockRequests(FIXTURE_PAGES.rich).length;
    const r = await call({
      page: 'qishen01',
      mode: 'replace_section',
      section: 'Customs',
      markdown: customs,
    });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      counts: { changed: 1, regionsKept: 3 },
    });
    expect((puts(FIXTURE_PAGES.rich, since)[0]!.body as { blocks: LkBlock[] }).blocks).toContainEqual({
      id: 'unsup001',
      kind: 'unsupported',
    });
    const after = w.stored(FIXTURE_PAGES.rich).blocks;
    for (const id of ['infobx01', 'coll0001', 'unsup001', 'calt0001'])
      expect(after.find((b) => b.id === id)).toEqual(page.find((b) => b.id === id));
  });
  it('the [BSRC] article: append_to_section leaves every existing block as it was', async () => {
    const before = w.stored(FIXTURE_PAGES.article).blocks;
    const r = await call({
      page: 'Asagiri Kaede',
      mode: 'append_to_section',
      section: 'Biography',
      markdown: 'A new line.',
    });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      counts: { added: 1, changed: 0, removed: 0 },
    });
    expect(w.stored(FIXTURE_PAGES.article).blocks.filter((b) => textOf(b) !== 'A new line.')).toEqual(before);
  });
  it('the Fourth Age page: an append_to_section on a later heading leaves the 335-row table byte-identical', async () => {
    const before = w.stored(FIXTURE_PAGES.fourthAge);
    const table = JSON.stringify(before.blocks.find((b) => b.id === 't4age001'));
    expect((before.blocks.find((b) => b.id === 't4age001')!.children as unknown[]).length).toBe(336);
    const r = await call({
      page: 'Fourth Age - Table',
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'Checked against the archives in 4A 900.',
    });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      counts: { added: 1, changed: 0, removed: 0, moved: 0 },
    });
    expect(JSON.stringify(w.stored(FIXTURE_PAGES.fourthAge).blocks.find((b) => b.id === 't4age001'))).toBe(
      table,
    );
  });
  it('twins: an edit of the middle of three identical paragraphs lands on that block', async () => {
    w.setPage('mehran01', [
      h('tw0', 2, 'Litany'),
      p('tw1', 'Praise the dawn.'),
      p('tw2', 'Praise the dawn.'),
      p('tw3', 'Praise the dawn.'),
      h('tw4', 2, 'After'),
    ]);
    const r = await call({
      page: 'mehran01',
      mode: 'replace_section',
      section: 'Litany',
      markdown: 'Praise the dawn.\n\nPraise the dusk.\n\nPraise the dawn.',
    });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      counts: { changed: 1, added: 0, removed: 0 },
    });
    expect(w.stored('mehran01').blocks.map((b) => [b.id, textOf(b)])).toEqual([
      ['tw0', 'Litany'],
      ['tw1', 'Praise the dawn.'],
      ['tw2', 'Praise the dusk.'],
      ['tw3', 'Praise the dawn.'],
      ['tw4', 'After'],
    ]);
  });
});

describe('dry run', () => {
  it('returns the plan and the Markdown diff, and reads once; nothing is written, queued or proposed', async () => {
    const before = w.blockRequests('miyabi').length;
    const jobs = w.stack.runtime.engine.queries.listJobs('proj_mock', {}).length;
    const r = await call({
      page: 'miyabi01',
      mode: 'replace_section',
      section: 'Early Life',
      markdown: 'Dry.',
      dryRun: true,
    });
    expect(r.body).toMatchObject({ status: 'dry_run', plannedOn: 'v3', counts: { changed: 1 } });
    expect(r.body.diff).toContain('-Born on Kumikas 1st, 4A 881.');
    expect(r.body.diff).toContain('+Dry.');
    expect(methods('miyabi', before)).toEqual(['GET']);
    expect(w.stack.runtime.engine.queries.listJobs('proj_mock', {}).length).toBe(jobs);
    const propose = await w.stack.connect(w.stack.newToken('pages-propose-dry', 'propose').token);
    const pr = await call({ page: 'miyabi01', mode: 'append', markdown: 'Dry.', dryRun: true }, propose);
    expect(pr.body.status).toBe('dry_run');
    expect(w.stack.runtime.policy.proposals.list({ project: 'proj_mock' })).toHaveLength(0);
  });
});
