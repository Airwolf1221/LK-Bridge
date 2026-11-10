/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
/**
 * Concurrency for write_page (PLAN-v2 10.6; part of E4's acceptance, built here): many simultaneous write_page calls on
 * one document are fully serialised, nothing is lost and every conflict is reported; an outside write between the plan
 * and the write is caught by the compare-and-swap; one between the write and the verify read is caught by verify. All
 * through the real server and the official MCP SDK client, several connections at once.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LkBlock } from '../../src/markdown/index.js';
import { pagesWorld, textOf, type PagesWorld } from './world.js';

let w: PagesWorld;
const clients: Client[] = [];
const PAGE = 'kumi0001';
const SECTIONS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];

const h = (id: string, level: number, text: string): LkBlock => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const p = (id: string, text: string): LkBlock => ({ id, kind: 'paragraph', content: [{ text }] });
function page(): LkBlock[] {
  return [
    h('top', 1, 'Kumi the Elder'),
    { id: 'unsupK', kind: 'unsupported' },
    ...SECTIONS.flatMap((s, i) => [h(`s${i}`, 2, s), p(`s${i}p`, `${s} as it was.`)]),
  ];
}
const call = (i: number, args: Record<string, unknown>) =>
  w.stack.call(clients[i % clients.length]!, 'write_page', { project: 'test', page: PAGE, ...args });

/** Each write job's requests (in-lock read, write, verify read) must come together, never interleaved with another's. */
function assertSerialised(since: number): string[] {
  const reqs = w.blockRequests(PAGE).slice(since);
  const jobOf = (id: string) => /^lkb\.(j[0-9a-z]+)\./.exec(id)?.[1] ?? null;
  const order: string[] = [];
  let current: string | null = null;
  for (const r of reqs) {
    const job = jobOf(r.requestId);
    if (job === null) continue; // a plan read (inline, before the job): may come at any time
    if (job !== current) {
      expect(order, `job ${job} came back after another job's write`).not.toContain(job);
      order.push(job);
      current = job;
    }
  }
  return order;
}

beforeAll(async () => {
  w = await pagesWorld();
  for (let i = 0; i < 4; i++)
    clients.push(await w.stack.connect(w.stack.newToken(`pages-writer-${i}`, 'write').token));
});
afterAll(() => w.close());
beforeEach(() => {
  w.setPage(PAGE, page(), 1);
});

describe('many simultaneous write_page calls on one document', () => {
  it('section edits of different sections: all written, one at a time, nothing lost', async () => {
    const since = w.blockRequests(PAGE).length;
    const results = await Promise.all(
      SECTIONS.map((s, i) =>
        call(i, { mode: 'append_to_section', section: s, markdown: `${s} addition.`, baseVersion: 'v1' }),
      ),
    );
    for (const r of results) expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    // Most of them were planned on v1 and re-planned inside the lock on the version the previous one made.
    expect(
      results.filter((r) => /inside the lock/.test(String(r.body.note ?? ''))).length,
    ).toBeGreaterThanOrEqual(SECTIONS.length - 1);
    expect(new Set(results.map((r) => r.body.version)).size).toBe(SECTIONS.length);
    const jobs = assertSerialised(since);
    expect(jobs).toHaveLength(SECTIONS.length);
    expect(
      w
        .blockRequests(PAGE)
        .slice(since)
        .filter((r) => r.method === 'PUT'),
    ).toHaveLength(SECTIONS.length);
    // Nothing lost: every addition is in its own section, every original block is still there, in order.
    const s = w.stored(PAGE);
    expect(s.version).toBe(`v${1 + SECTIONS.length}`);
    SECTIONS.forEach((name, i) => {
      const at = s.blocks.findIndex((b) => b.id === `s${i}p`);
      expect(textOf(s.blocks[at + 1]), name).toBe(`${name} addition.`);
    });
    const original = new Set(page().map((b) => b.id));
    expect(s.blocks.filter((b) => original.has(b.id)).map((b) => b.id)).toEqual(page().map((b) => b.id));
    expect(s.blocks).toHaveLength(page().length + SECTIONS.length);
    expect(s.blocks[1]).toEqual({ id: 'unsupK', kind: 'unsupported' });
  });
  it('the same section, the same base: exactly one is written, every other one reports a conflict, nothing silently lost', async () => {
    const since = w.blockRequests(PAGE).length;
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        call(i, {
          mode: 'replace_section',
          section: 'Delta',
          markdown: `Delta by writer ${i}.`,
          baseVersion: 'v1',
        }),
      ),
    );
    const written = results.filter((r) => r.body.status === 'written');
    const conflicts = results.filter((r) => r.body.error?.code === 'VERSION_CONFLICT');
    expect(written).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    for (const r of conflicts) {
      expect(r.body.error).toMatchObject({ reason: 'section_changed', currentVersion: 'v2' });
      expect(r.body.error.currentSection).toBe(
        `## Delta\n\n${textOf(w.stored(PAGE).blocks.find((b) => b.id === 's3p'))}\n`,
      );
    }
    expect(
      w
        .blockRequests(PAGE)
        .slice(since)
        .filter((r) => r.method === 'PUT'),
    ).toHaveLength(1);
    assertSerialised(since);
  });
  it('whole-page appends with no base: one is written, the others conflict (each told the page changed meanwhile)', async () => {
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => call(i, { mode: 'append', markdown: `Appendix ${i}.` })),
    );
    expect(results.filter((r) => r.body.status === 'written')).toHaveLength(1);
    const conflicts = results.filter((r) => r.body.error?.code === 'VERSION_CONFLICT');
    expect(conflicts).toHaveLength(3);
    for (const r of conflicts) expect(r.body.error.reason).toBe('changed_while_waiting');
    expect(w.stored(PAGE).blocks.filter((b) => textOf(b).startsWith('Appendix'))).toHaveLength(1);
  });
});

describe('outside writes', () => {
  it('between the plan and the write: caught by the compare-and-swap (nothing sent)', async () => {
    const edit = (id: string, text: string) => (b: LkBlock[]) =>
      (b[b.findIndex((x) => x.id === id)] = p(id, text));
    w.after(PAGE, 'GET', 0, () => w.outsideEdit(PAGE, edit('s0p', 'Alpha edited in the app.')));
    const since = w.blockRequests(PAGE).length;
    const r = await call(0, { mode: 'replace_section', section: 'Alpha', markdown: 'Alpha by the agent.' });
    expect(r.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'section_changed',
      currentVersion: 'v2',
    });
    expect(
      w
        .blockRequests(PAGE)
        .slice(since)
        .map((x) => x.method),
    ).toEqual(['GET', 'GET']);
    expect(textOf(w.stored(PAGE).blocks.find((b) => b.id === 's0p'))).toBe('Alpha edited in the app.');
  });
  it('between the write and the verify read: caught by verify ("written but not as planned"), never retried', async () => {
    w.after(PAGE, 'PUT', 0, () =>
      w.outsideEdit(
        PAGE,
        (b) => (b[b.findIndex((x) => x.id === 's1p')] = p('s1p', 'Bravo edited in the app.')),
      ),
    );
    const since = w.blockRequests(PAGE).length;
    const r = await call(1, { mode: 'append_to_section', section: 'Alpha', markdown: 'Alpha addition.' });
    expect(r.body).toMatchObject({ status: 'written', verified: false, version: 'v3' });
    expect(r.body.warning).toMatch(/^written but not as planned/);
    expect(r.body.verification.differences[0]).toMatchObject({
      expected: 'Bravo as it was.',
      actual: 'Bravo edited in the app.',
    });
    expect(
      w
        .blockRequests(PAGE)
        .slice(since)
        .map((x) => x.method),
    ).toEqual(['GET', 'GET', 'PUT', 'GET']);
  });
});
