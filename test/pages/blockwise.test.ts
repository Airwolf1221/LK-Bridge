/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v2 E4 (ADR 0046 decision 1; PLAN-v2 E4, backlog 1): write_page on a page LegendKeeper's API cannot take back whole (an
 * inline icon) is written block by block (`insertBlock`, `replaceBlock`, `deleteBlock`), with the in-lock check, chained
 * versions (a delete's ETag), the verify of the whole page, and the undo of a write that stops part-way. An edit to the
 * icon paragraph itself stays refused.
 *
 * First the planner on its own (properties over random trees), then end to end: the REAL server, runtime, policy and job
 * engine, the official MCP SDK client, and the mock LegendKeeper holding B1's rich page (an inline icon, an `unsupported`
 * block, a callout with a paragraph inside).
 */
import type { Client } from '@modelcontextprotocol/client';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { richPage } from '../markdown/fixtures.js';
import { toMarkdown, type LkBlock } from '../../src/markdown/index.js';
import { applyBlockOps, planBlockwise, type BlockOp } from '../../src/pages/blockwise.js';
import { FIXTURE_PAGES, pagesWorld, type PagesWorld } from './world.js';

type Obj = Record<string, any>;
const para = (id: string, text: string): Obj => ({ id, kind: 'paragraph', content: [{ text }] });

describe('planBlockwise: the plan replays to exactly the result, inserts first, deletes last', () => {
  /** A random tree: paragraphs and callouts (containers) holding paragraphs, unique ids. */
  const tree = (n: number, seed: number): Obj[] => {
    let id = 0;
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 1000) / 1000;
    const out: Obj[] = [];
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.3) {
        const kids = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => para(`k${id++}`, `kid ${id}`));
        out.push({ id: `c${id++}`, kind: 'callout', tone: 'info', children: kids });
      } else out.push(para(`p${id++}`, `text ${id}`));
    }
    return out;
  };
  /** A random edit of a tree: some blocks changed, some removed, some new ones added; no moves. */
  const edit = (t: Obj[], seed: number): Obj[] => {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 1000) / 1000;
    let fresh = 0;
    const walk = (list: Obj[]): Obj[] => {
      const out: Obj[] = [];
      for (const b of list) {
        const r = rnd();
        if (r < 0.15) continue; // removed
        if (rnd() < 0.15) out.push(para(`n${seed}x${fresh++}`, 'new before'));
        const c = structuredClone(b);
        if (r > 0.8 && c.kind === 'paragraph') c.content = [{ text: `changed ${seed}` }];
        if (r > 0.9 && c.kind === 'callout') c.tone = 'warning';
        if (Array.isArray(c.children)) c.children = walk(c.children);
        out.push(c);
      }
      if (rnd() < 0.2) out.push(para(`n${seed}y${fresh++}`, 'new at end'));
      return out;
    };
    return walk(t);
  };

  it('for 500 random trees and edits: replaying the plan on the page gives the result, in the safe order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 1, max: 1e6 }), (n, seed) => {
        const before = tree(n, seed);
        const after = edit(before, seed + 7);
        const plan = planBlockwise(before, after, { maxWrites: 1000 });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(applyBlockOps(before, plan.ops)).toEqual(after);
        // Inserts, then replaces, then deletes: a stop part-way never loses text.
        const order = plan.ops.map((o) => ({ insertBlock: 0, replaceBlock: 1, deleteBlock: 2 })[o.op]);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
      }),
      { numRuns: 500 },
    );
  });

  it('an unchanged page plans nothing', () => {
    const t = tree(8, 3);
    expect(planBlockwise(t, structuredClone(t))).toEqual({ ok: true, ops: [], empty: true });
  });

  it('never changes, removes or re-sends a block the write format cannot take back (the icon paragraph)', () => {
    const before = [para('a', 'one'), para('icon', 'with icon'), para('b', 'two')];
    const changeIcon = planBlockwise(before, [before[0]!, para('icon', 'edited'), before[2]!], {
      unwritable: new Set(['icon']),
    });
    expect(changeIcon).toMatchObject({
      ok: false,
      refusal: { reason: 'unwritable', blocks: [{ id: 'icon' }] },
    });
    const removeIcon = planBlockwise(before, [before[0]!, before[2]!], { unwritable: new Set(['icon']) });
    expect(removeIcon).toMatchObject({ ok: false, refusal: { reason: 'unwritable' } });
    // Inside a container whose own fields change, it would be re-sent: refused too.
    const inCallout = [{ id: 'c', kind: 'callout', tone: 'info', children: [para('icon', 'x')] }];
    expect(
      planBlockwise(inCallout, [{ ...inCallout[0], tone: 'warning' }], { unwritable: new Set(['icon']) }),
    ).toMatchObject({ ok: false, refusal: { reason: 'unwritable' } });
    // Beside it, everything works.
    const beside = planBlockwise(before, [before[0]!, before[1]!, para('b', 'two!'), para('n', 'new')], {
      unwritable: new Set(['icon']),
    });
    expect(beside.ok).toBe(true);
  });

  it('refuses moves, a deleted unsupported block, missing or repeated ids, and too many writes', () => {
    const before = [para('a', '1'), para('b', '2'), { id: 'u', kind: 'unsupported' }];
    expect(planBlockwise(before, [before[1]!, before[0]!, before[2]!])).toMatchObject({
      ok: false,
      refusal: { reason: 'moved' },
    });
    expect(planBlockwise(before, [before[0]!, before[1]!])).toMatchObject({
      ok: false,
      refusal: { reason: 'unsupported', blocks: [{ id: 'u' }] },
    });
    expect(planBlockwise([{ kind: 'paragraph', content: [] }], [])).toMatchObject({
      ok: false,
      refusal: { reason: 'ids' },
    });
    expect(planBlockwise([para('a', '1'), para('a', '2')], [])).toMatchObject({
      ok: false,
      refusal: { reason: 'ids' },
    });
    const many = Array.from({ length: 5 }, (_, i) => para(`m${i}`, 'x'));
    expect(planBlockwise([], many, { maxWrites: 4 })).toMatchObject({
      ok: false,
      refusal: { reason: 'too_many' },
    });
  });

  it('places a new block before the rest when nothing earlier survives, and inside a container when it is emptied', () => {
    const before = [para('old', 'gone'), para('keep', 'stays')];
    const plan = planBlockwise(before, [para('new', 'first'), para('keep', 'stays')]);
    expect(plan).toMatchObject({
      ok: true,
      ops: [
        { op: 'insertBlock', id: 'new', before: 'keep' },
        { op: 'deleteBlock', id: 'old' },
      ],
    });
    const box = [{ id: 'c', kind: 'callout', tone: 'info', children: [para('k', 'gone')] }];
    const p2 = planBlockwise(box, [{ ...box[0], children: [para('k2', 'new')] }]);
    expect(p2).toMatchObject({
      ok: true,
      ops: [
        { op: 'insertBlock', id: 'k2', before: 'k' },
        { op: 'deleteBlock', id: 'k' },
      ],
    });
    const empty = [{ id: 'c', kind: 'callout', tone: 'info', children: [] }];
    const p3 = planBlockwise(empty, [{ ...empty[0], children: [para('k3', 'new')] }]);
    expect(p3).toMatchObject({ ok: true, ops: [{ op: 'insertBlock', id: 'k3', parent: 'c' }] });
    const ops = (p3 as unknown as { ops: BlockOp[] }).ops;
    expect(applyBlockOps(empty, ops)).toEqual([{ ...empty[0], children: [para('k3', 'new')] }]);
  });
});

// ================================================================================================= end to end

let w: PagesWorld;
let c: Client;
const RICH = FIXTURE_PAGES.rich;
const call = (args: Record<string, unknown>, client = c) =>
  w.stack.call(client, 'write_page', { project: 'test', page: RICH, ...args });
const mutations = (since: number) =>
  w.repo.mutations
    .slice(since)
    .map((m) => m.op)
    .filter((op) => /Block/.test(op));
const ICON = 'richp002';

/** The Customs section of the rich page as Markdown (its keep regions as the converter renders them). */
const customs = (blocks: LkBlock[]) => {
  const md = toMarkdown(blocks).markdown;
  return md.slice(md.indexOf('## Customs'));
};

beforeAll(async () => {
  w = await pagesWorld();
  c = await w.stack.connect();
});
afterAll(() => w.close());
beforeEach(() => {
  w.setPage(RICH, richPage(), 1);
  for (const re of [...w.overrides.keys()]) if (re.source.includes('E4TEST')) w.overrides.delete(re);
});

/** Answers the single-block requests that match with `res` (a refusal), once each, as LegendKeeper would. */
function failBlock(
  method: string,
  blockId: string,
  res: { status: number; body?: unknown },
  after?: () => void,
) {
  w.overrides.set(new RegExp(`/blocks/${blockId}/?$|E4TEST`), (req) => {
    if (
      req.method !== method ||
      !/\/blocks\/[^/]+\/?$/.test(req.path) ||
      !req.path.includes(`/blocks/${blockId}`)
    )
      return undefined;
    after?.();
    return res;
  });
}

describe('write_page block by block, beside an inline icon', () => {
  it('a dry run says it will write block by block, and sends nothing', async () => {
    const since = w.repo.mutations.length;
    const r = await call({
      mode: 'append_to_section',
      section: 'Customs',
      markdown: 'A new custom.',
      dryRun: true,
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({
      status: 'dry_run',
      blockwise: { writes: 1, inserts: 1, replaces: 0, deletes: 0 },
    });
    expect(mutations(since)).toEqual([]);
  });

  it('append_to_section: one insert after the section, the icon paragraph and the unsupported block untouched, verified, with the new version', async () => {
    const before = richPage();
    const since = w.repo.mutations.length;
    const r = await call({
      mode: 'append_to_section',
      section: 'Customs',
      markdown: 'A new custom.',
      baseVersion: 'v1',
    });
    expect(r.body).toMatchObject({ status: 'written', verified: true, blockwise: { writes: 1 } });
    expect(mutations(since)).toEqual(['insertBlock']);
    const after = w.stored(RICH);
    expect(r.body.version).toBe(after.version);
    for (const id of [ICON, 'unsup001', 'infobx01', 'coll0001', 'calt0001'])
      expect(after.blocks.find((b) => b.id === id)).toEqual(before.find((b) => b.id === id));
    expect(after.blocks.at(-1)).toMatchObject({ kind: 'paragraph', content: [{ text: 'A new custom.' }] });
    // The version it answered works as the next baseVersion (no conflict).
    const again = await call({
      mode: 'append_to_section',
      section: 'Customs',
      markdown: 'Another.',
      baseVersion: r.body.version,
    });
    expect(again.body).toMatchObject({ status: 'written', verified: true });
  });

  it('replace_section changing one paragraph: one replaceBlock, chained from the in-lock check’s version', async () => {
    const since = w.repo.mutations.length;
    const md = customs(richPage()).replace('Offerings are left at dawn.', 'Offerings are left at dusk.');
    const r = await call({ mode: 'replace_section', section: 'Customs', markdown: md });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      blockwise: { replaces: 1, writes: 1 },
    });
    expect(mutations(since)).toEqual(['replaceBlock']);
    const stored = w.stored(RICH).blocks;
    expect(stored.find((b) => b.id === 'richp003')).toMatchObject({
      content: [{ text: 'Offerings are left at dusk.' }],
    });
    expect(stored.find((b) => b.id === ICON)).toEqual(richPage().find((b) => b.id === ICON));
  });

  it('an insert, a replace and a delete in one edit: in that order, each If-Match from the write before (the delete’s ETag too)', async () => {
    const since = w.repo.mutations.length;
    // The callout's paragraph changes, "Offerings…" goes, a new paragraph comes after the callout.
    const md = customs(richPage())
      .replace('Offerings are left at dawn.\n\n', '')
      .replace('Never enter a shrine after dusk.', 'Never enter a shrine at night.')
      .concat('\nA closing line.\n');
    const r = await call({ mode: 'replace_section', section: 'Customs', markdown: md });
    expect(r.body).toMatchObject({ status: 'written', verified: true, blockwise: { writes: 3 } });
    expect(mutations(since)).toEqual(['insertBlock', 'replaceBlock', 'deleteBlock']);
    const job = w.stack.runtime.engine.queries.getJob('proj_mock', r.body.jobId)!;
    const steps = w.stack.runtime.engine.stepPlans('proj_mock', job.id)!;
    // check v1 → insert (If-Match v1) → replace (v2) → delete (v3).
    expect(steps.filter((s) => /Block$/.test(s.opId)).map((s) => s.params.ifMatch)).toEqual([
      'v1',
      'v2',
      'v3',
    ]);
    expect(r.body.version).toBe('v4');
  });

  it('an edit that would re-send the icon paragraph stays refused: PAGE_NOT_WRITABLE, nothing sent', async () => {
    // The icon paragraph inside a callout: changing the callout's tone would replace the callout with its whole
    // subtree, icon paragraph included, which the write format cannot take back.
    const page = richPage()
      .map((b) =>
        b.id === 'calt0001'
          ? { ...b, children: [...(b.children as LkBlock[]), richPage().find((x) => x.id === ICON)!] }
          : b,
      )
      .filter((b, i, all) => !(b.id === ICON && all.indexOf(b) === i && i < 8));
    w.setPage(RICH, page, 1);
    const md = customs(page);
    expect(md).toContain('[!warning]');
    const since = w.repo.mutations.length;
    const r = await call({
      mode: 'replace_section',
      section: 'Customs',
      markdown: md.replace('[!warning]', '[!note]'),
    });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'PAGE_NOT_WRITABLE', reason: 'unwritable' });
    // Named by the block the write format refuses: the icon paragraph, or the callout holding it.
    const named = (r.body.error.blocks as { id: string }[]).map((b) => b.id);
    expect(named.some((id) => id === ICON || id === 'calt0001')).toBe(true);
    expect(mutations(since)).toEqual([]);
  });

  it('removing the icon paragraph on purpose (dropRegions) is C1’s deliberate deletion: the page is then written whole', async () => {
    // Not an edit of the icon paragraph: the agent names the keep region to delete, and without it the page can be
    // written back whole (C1, ADR 0031). Kept as it was; the journal holds the page as it was before.
    const md = customs(richPage()).replace(/<!-- lk:keep id="richp002"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    const since = w.repo.mutations.length;
    const r = await call({ mode: 'replace_section', section: 'Customs', markdown: md, dropRegions: [ICON] });
    expect(r.body).toMatchObject({ status: 'written', counts: { regionsDropped: 1 } });
    expect(mutations(since)).toEqual(['replaceDocumentBlocks']);
  });

  it('an outside edit between the plan and the lock is caught by the in-lock check: a conflict, nothing written', async () => {
    const since = w.repo.mutations.length;
    // Right after write_page's plan read, someone edits the page in the app.
    w.after(RICH, 'GET', 0, () =>
      w.outsideEdit(RICH, (b) => {
        (b.find((x) => x.id === 'richp001') as Obj).content = [{ text: 'Edited in the app.' }];
      }),
    );
    const r = await call({ mode: 'append_to_section', section: 'Customs', markdown: 'Late line.' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('VERSION_CONFLICT');
    expect(r.body.error.written).toEqual([]);
    expect(mutations(since)).toEqual([]);
    expect(w.stored(RICH).blocks.find((b) => b.id === 'richp001')).toMatchObject({
      content: [{ text: 'Edited in the app.' }],
    });
  });

  it('a write that stops part-way is undone from its record: the page is as it was before, and the answer says so', async () => {
    const before = w.stored(RICH);
    const md = customs(richPage())
      .replace('Offerings are left at dawn.\n\n', '')
      .concat('\nA closing line.\n');
    // The delete of "Offerings…" is refused (after the insert went in).
    failBlock('DELETE', 'richp003', { status: 500, body: { code: 'INTERNAL', message: 'boom (test)' } });
    const r = await call({ mode: 'replace_section', section: 'Customs', markdown: md });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ undo: { status: 'succeeded' } });
    expect(['WRITTEN_IN_PART', 'OUTCOME_UNKNOWN']).toContain(r.body.error.code);
    const now = w.stored(RICH);
    expect(now.blocks).toEqual(before.blocks);
    // The undo's own writes are journalled like any other (the insert it took back, with its pre-image).
    const undoJob = r.body.error.undo.jobId as string;
    const j = w.stack.runtime.engine.queries.journalLookup('proj_mock', {
      jobId: undoJob,
      includePreImage: true,
    });
    expect(j.map((e) => e.opId)).toEqual(['deleteBlock']);
    expect(j[0]!.preImage).toMatchObject({ kind: 'paragraph', content: [{ text: 'A closing line.' }] });
  });

  it('a stopped write whose page then changed is NOT undone (an undo never reverts another edit), and says so', async () => {
    const md = customs(richPage())
      .replace('Offerings are left at dawn.\n\n', '')
      .concat('\nA closing line.\n');
    failBlock('DELETE', 'richp003', { status: 500, body: { code: 'INTERNAL', message: 'boom (test)' } }, () =>
      w.outsideEdit(RICH, (b) => {
        (b.find((x) => x.id === 'richp001') as Obj).content = [{ text: 'Edited in the app meanwhile.' }];
      }),
    );
    const r = await call({ mode: 'replace_section', section: 'Customs', markdown: md });
    expect(r.isError).toBe(true);
    expect(r.body.error.undo).toMatchObject({ status: 'stale' });
    const now = w.stored(RICH).blocks;
    expect(now.find((b) => b.id === 'richp001')).toMatchObject({
      content: [{ text: 'Edited in the app meanwhile.' }],
    });
    expect(now.at(-1)).toMatchObject({ content: [{ text: 'A closing line.' }] }); // left as it stopped, reported
  });

  it('at scope propose: one proposal; approved, it runs block by block and is verified', async () => {
    const pc = await w.stack.connect(w.stack.newToken('pages-e4-propose', 'propose').token);
    const r = await call({ mode: 'append_to_section', section: 'Customs', markdown: 'Proposed line.' }, pc);
    expect(r.body.status).toBe('proposal_captured');
    const since = w.repo.mutations.length;
    const commands = w.stack.runtime.policy.commands;
    await commands.approve('owner', r.body.proposalId);
    let d: any;
    for (let i = 0; i < 200; i++) {
      d = commands.getProposal('owner', r.body.proposalId);
      if (['executed', 'failed', 'conflicted'].includes(d.state)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(d.state).toBe('executed');
    expect(mutations(since)).toEqual(['insertBlock']);
    expect(w.stored(RICH).blocks.at(-1)).toMatchObject({ content: [{ text: 'Proposed line.' }] });
  });
});
