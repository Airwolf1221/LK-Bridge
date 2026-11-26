/**
 * CR-2026-11 round 2 (write scope): deletes by an agent at scope `write` (sidebar properties, board shapes, a board
 * emptied, an infobox property, a calendar replaced, content removed through the low-level tools).
 *
 * The deletes rail (ADR 0055 decision C) was removed with the other safety rails (v3 F12, ADR 0081): each of these now
 * runs directly, is one job on the owner's Review page, and Revert can put it back (ADR 0081: the `entity` target).
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, writeCallsSince, type Agent } from './helpers.js';

let w: FactsWorld;
let a: Agent;

/** A board LegendKeeper would hold: shapes, bindings, a version (replaceBoardContent replaces them all). */
const board = {
  version: 1,
  shapes: [
    {
      id: 'shape:1',
      type: 'geo',
      parentId: 'page:1',
      index: 'a1',
      props: { geo: 'rectangle', text: 'Miyabi' },
    },
    { id: 'shape:2', type: 'geo', parentId: 'page:1', index: 'a2', props: { geo: 'ellipse', text: 'Kaede' } },
    { id: 'shape:3', type: 'arrow', parentId: 'page:1', index: 'a3', props: { text: 'sisters' } },
  ] as unknown[],
  bindings: [
    { id: 'b1', type: 'arrow', fromId: 'shape:3', toId: 'shape:1', props: { terminal: 'start' } },
    { id: 'b2', type: 'arrow', fromId: 'shape:3', toId: 'shape:2', props: { terminal: 'end' } },
  ] as unknown[],
};
const boardView = () => ({
  version: `bv${board.version}`,
  pages: [{ id: 'page:1', name: 'Plot', index: 'a1' }],
  shapes: structuredClone(board.shapes),
  bindings: structuredClone(board.bindings),
});

/** An infobox block on Miyabi's Main with one key-value property (an infobox property LegendKeeper keeps). */
const infobox = {
  deleted: false,
  version: 1,
  property: {
    id: 'ibxprop1',
    kind: 'keyValue',
    title: 'Vital statistics',
    rows: [
      { id: 'ir1', rank: 'a', key: 'Height', text: '5 ft 2', content: [{ text: '5 ft 2' }] },
      { id: 'ir2', rank: 'b', key: 'Eyes', text: 'Amber', content: [{ text: 'Amber' }] },
      { id: 'ir3', rank: 'c', key: 'Title', text: 'Shrine maiden', content: [{ text: 'Shrine maiden' }] },
    ],
  },
};

/** The project's custom calendar (as B2's world serves it), with a version that moves on a replace. */
const calendar = { version: 1, months: 5, eras: 1, name: 'Kumikan Epochal' };

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-deletes-agent');
  const boardPath = new RegExp(`/resources/board001/docs/${w.docs.board}/board$`);
  w.overrides.set(boardPath, (req: MockRequest): MockResponse | undefined => {
    if (req.method === 'GET')
      return { status: 200, body: boardView(), headers: { etag: `"bv${board.version}"` } };
    if (req.method === 'PUT') {
      if (req.headers['if-match'] !== `bv${board.version}`)
        return { status: 412, body: { code: 'VERSION_MISMATCH', message: 'stale' } };
      const b = req.body as { shapes: unknown[]; bindings?: unknown[] };
      board.shapes = b.shapes;
      board.bindings = b.bindings ?? [];
      board.version++;
      return { status: 200, body: boardView() };
    }
    return undefined;
  });
  // The board's shape routes (deleteBoardShapes, createBoardShapes) on the same board.
  w.overrides.set(new RegExp(`/resources/board001/docs/${w.docs.board}/board/shapes(/delete)?$`), (req) => {
    if (req.method !== 'POST') return undefined;
    if (/\/shapes\/delete/.test(req.path)) {
      const ids = new Set((req.body as { ids: string[] }).ids);
      board.shapes = board.shapes.filter((x) => !ids.has((x as { id: string }).id));
      board.version++;
      return { status: 200, body: { deleted: [...ids], version: `bv${board.version}` } };
    }
    const made = (req.body as { shapes: unknown[] }).shapes;
    board.shapes = [...board.shapes, ...made];
    board.version++;
    return { status: 201, body: { shapes: made, version: `bv${board.version}` } };
  });
  const ibxPath = new RegExp(
    `/resources/miyabi01/docs/${w.docs.miyabiMain}/blocks/infobox1/properties/ibxprop1$`,
  );
  w.overrides.set(ibxPath, (req: MockRequest): MockResponse | undefined => {
    if (infobox.deleted) return { status: 404, body: { code: 'NOT_FOUND', message: 'gone' } };
    if (req.method === 'GET')
      return { status: 200, body: { ...structuredClone(infobox.property), version: `iv${infobox.version}` } };
    if (req.method === 'DELETE') {
      infobox.deleted = true;
      infobox.version++;
      return { status: 204 };
    }
    return undefined;
  });
  w.overrides.set(/\/calendars\/rp86pkdr$/, (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'PUT') return undefined;
    const b = req.body as { months?: unknown[]; positiveEras?: unknown[]; name?: string };
    calendar.months = b.months?.length ?? 0;
    calendar.eras = b.positiveEras?.length ?? 0;
    calendar.name = b.name ?? calendar.name;
    calendar.version++;
    return { status: 200, body: { id: 'rp86pkdr', ...b, version: `cv${calendar.version}` } };
  });
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const sent = (n: number) => writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`);

/** A direct job's outcome: settled, on the owner's Review page, and every target ready for Revert. */
async function directThenRevertible(r: { body: Record<string, any>; text: string }) {
  if (typeof r.body.jobId !== 'string') return { status: String(r.body.status ?? r.body.error?.code), text: r.text };
  const jobId = r.body.jobId;
  const job = await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000);
  const onReview = w.stack.runtime.review
    .list(PROJECT, { state: 'all', limit: 500 })
    .some((i) => i.jobId === jobId);
  const preview = await w.stack.runtime.reverts.preview(PROJECT, jobId);
  return {
    status: job.status,
    onReview,
    revertible: preview.eligible.ok && preview.notReverted === 0 && preview.ready > 0,
    targets: preview.targets.map((t) => `${t.kind}:${t.state}: ${t.detail}`),
  };
}
const DIRECT = { status: 'succeeded', onReview: true, revertible: true };

describe('deletes of what LegendKeeper keeps beside pages', () => {
  it('A0: deleteProperty (a sidebar link collection) through lk_api_write runs directly; Revert can put it back', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'deleteProperty',
      params: { path: { resourceId: P.miyabi, propertyId: 'relmiya1' } },
    });
    const out = await directThenRevertible(r);
    expect(out, `${r.text}\n${JSON.stringify(out)}`).toMatchObject(DIRECT);
    expect(sent(n)).toContain(`DELETE /resources/${P.miyabi}/properties/relmiya1`);
  });

  it('A0b: deleteBoardShapes (all three shapes) through lk_api_write runs directly; Revert can put them back', async () => {
    const r = await call('lk_api_write', {
      operationId: 'deleteBoardShapes',
      params: {
        path: { resourceId: 'board001', documentId: w.docs.board },
        body: { ids: ['shape:1', 'shape:2', 'shape:3'] },
      },
    });
    const out = await directThenRevertible(r);
    expect(out, `${r.text}\n${JSON.stringify(out)}`).toMatchObject(DIRECT);
  });
});

describe('deletes that are replacements', () => {
  it('A1: replaceBoardContent with no shapes (deletes every shape and binding) runs directly; Revert can put it back', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'replaceBoardContent',
      params: {
        path: { resourceId: 'board001', documentId: w.docs.board },
        ifMatch: `bv${board.version}`,
        body: { shapes: [], bindings: [] },
      },
    });
    const out = await directThenRevertible(r);
    expect(
      { ...out, shapesLeft: board.shapes.length, bindingsLeft: board.bindings.length },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}\n${JSON.stringify(out)}`,
    ).toMatchObject({ ...DIRECT, shapesLeft: 0, bindingsLeft: 0 });
  });

  it('A2: deleteBlockProperty (an infobox property and its rows) runs directly; Revert can put it back', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'deleteBlockProperty',
      params: {
        path: {
          resourceId: P.miyabi,
          documentId: w.docs.miyabiMain,
          blockId: 'infobox1',
          propertyId: 'ibxprop1',
        },
      },
    });
    const out = await directThenRevertible(r);
    expect(
      { ...out, deleted: infobox.deleted },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}\n${JSON.stringify(out)}`,
    ).toMatchObject({ ...DIRECT, deleted: true });
  });

  it('A3: updateCalendar replacing the project calendar with a one-month stub runs directly; Revert can put it back', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'updateCalendar',
      params: {
        path: { calendarId: 'rp86pkdr' },
        body: {
          name: 'Kumikan Epochal',
          hasZeroYear: false,
          maxMinutes: 1000000,
          leapDays: [],
          epochWeekday: 0,
          months: [{ id: 'm0', name: 'Only', length: 1, isIntercalary: false, interval: 1, offset: 0 }],
          weekdays: [{ id: 'w1', name: 'Day' }],
          hoursInDay: 1,
          minutesInHour: 1,
          positiveEras: [{ id: 'e1', name: 'Era', abbr: 'E', startsAt: 0, resetMode: 'none' }],
        },
      },
    });
    const out = await directThenRevertible(r);
    expect(
      { ...out, months: calendar.months },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}\n${JSON.stringify(out)}`,
    ).toMatchObject({ ...DIRECT, months: 1 });
  });
});

describe('the two deletes together, through lk_api_batch', () => {
  it('A4: a batch emptying the board, then deleting an infobox property, runs directly as one job; Revert can put both back', async () => {
    // Reset the models.
    board.version++;
    board.shapes = [{ id: 'shape:9', type: 'geo', parentId: 'page:1', index: 'a9', props: { geo: 'rectangle' } }];
    infobox.deleted = false;
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'replaceBoardContent',
          params: {
            path: { resourceId: 'board001', documentId: w.docs.board },
            body: { shapes: [] },
          },
        },
        {
          operationId: 'deleteBlockProperty',
          params: {
            path: {
              resourceId: P.miyabi,
              documentId: w.docs.miyabiMain,
              blockId: 'infobox1',
              propertyId: 'ibxprop1',
            },
          },
        },
      ],
    });
    const out = await directThenRevertible(r);
    expect(
      { ...out, shapesLeft: board.shapes.length, deleted: infobox.deleted },
      `${r.text}\n${JSON.stringify(out)}`,
    ).toMatchObject({ ...DIRECT, shapesLeft: 0, deleted: true });
  });
});

/**
 * Found as design gaps (R2-52: ADR 0055 C1 kept blocks and fact rows out of the deletes rail as edits; B3 listed raw
 * sidebar-row and block writes as not revertible). ADR 0057 decision 4 made them proposals through the deletes rail;
 * v3 F12 (ADR 0081) removed the rail and gave every such write a Revert path: direct, on Review, revertible.
 */
describe('content removed through the low-level tools (ADR 0057 decision 4, ADR 0081)', () => {
  it('A5: updateProperty emptying a link collection (Dependencies, two items) runs directly and is revertible', async () => {
    const r = await call('lk_api_write', {
      operationId: 'updateProperty',
      params: { path: { resourceId: P.miyabi, propertyId: 'depmiya1' }, body: { items: [] } },
    });
    const out = await directThenRevertible(r);
    expect(out, `${r.text}\n${JSON.stringify(out)}`).toMatchObject(DIRECT);
  });

  it('A6: deleteBlock of the Fourth Age table (the whole 20-row table block) runs directly and is revertible', async () => {
    const ver = await w.stack.call(a.client, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: 'age40001', documentId: w.docs.ageMain } },
    });
    const r = await call('lk_api_write', {
      operationId: 'deleteBlock',
      params: {
        path: { resourceId: 'age40001', documentId: w.docs.ageMain, blockId: 'tbl1' },
        ifMatch: String(ver.body.result?.version ?? ver.body.version ?? 'v7'),
      },
    });
    const out = await directThenRevertible(r);
    expect(out, `${r.text}\n${JSON.stringify(out)}`).toMatchObject(DIRECT);
  });
});
