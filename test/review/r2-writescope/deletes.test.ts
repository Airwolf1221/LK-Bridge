/**
 * CR-2026-11 round 2 (write scope), the deletes rail (ADR 0055 decision C: "Deletes | pages, documents, timeline events
 * and lanes, map features, assets, calendars, sidebar properties, board shapes", on by default).
 *
 * Every test asserts the SAFE behaviour: an agent at scope `write` with the DEFAULT rails that deletes one of those
 * things (or loses it in a way that amounts to a delete) gets ONE proposal, and nothing is sent to LegendKeeper.
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
    { id: 'b1', fromId: 'shape:3', toId: 'shape:1', props: { terminal: 'start' } },
    { id: 'b2', fromId: 'shape:3', toId: 'shape:2', props: { terminal: 'end' } },
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

describe('controls: deletes the rail names are proposed', () => {
  it('A0: deleteProperty (a sidebar link collection) through lk_api_write is a proposal', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'deleteProperty',
      params: { path: { resourceId: P.miyabi, propertyId: 'relmiya1' } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toMatch(/sidebar property/);
    expect(sent(n)).toEqual([]);
  });

  it('A0b: deleteBoardShapes (all three shapes) through lk_api_write is a proposal', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'deleteBoardShapes',
      params: {
        path: { resourceId: 'board001', documentId: w.docs.board },
        body: { ids: ['shape:1', 'shape:2', 'shape:3'] },
      },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toMatch(/board shapes/);
    expect(sent(n)).toEqual([]);
  });
});

describe('deletes the rail does not see', () => {
  it('A1: replaceBoardContent with no shapes (deletes every shape and binding) is a proposal', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'replaceBoardContent',
      params: {
        path: { resourceId: 'board001', documentId: w.docs.board },
        ifMatch: `bv${board.version}`,
        body: { shapes: [], bindings: [] },
      },
    });
    expect(
      { status: r.body.status, shapesLeft: board.shapes.length, bindingsLeft: board.bindings.length },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}`,
    ).toEqual({ status: 'proposal_captured', shapesLeft: 3, bindingsLeft: 2 });
  });

  it('A2: deleteBlockProperty (an infobox property and its rows) is a proposal', async () => {
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
    expect(
      { status: r.body.status, deleted: infobox.deleted },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}`,
    ).toEqual({ status: 'proposal_captured', deleted: false });
  });

  it('A3: updateCalendar replacing the project calendar with a one-month stub is a proposal', async () => {
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
    expect(
      { status: r.body.status, months: calendar.months },
      `${r.text}\nsent: ${JSON.stringify(sent(n))}`,
    ).toEqual({ status: 'proposal_captured', months: 5 });
  });
});

describe('the two deletes together, through lk_api_batch', () => {
  it('A4: a batch emptying the board, then deleting an infobox property, is a proposal', async () => {
    // Reset the models.
    board.version++;
    infobox.deleted = false;
    const n = w.stack.mock.calls.length;
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
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect({ status: r.body.status, sent: sent(n) }, r.text).toEqual({
      status: 'proposal_captured',
      sent: [],
    });
  });
});

/**
 * Design gaps (ADR 0055 C1 keeps blocks and fact rows out of the deletes rail as edits; B3 lists raw sidebar-row and
 * block writes as not revertible). The SAFE outcome asserted here: content removed through the low-level tools is
 * either proposed, or put back by Revert. Either failure mode means an agent can remove content the owner can only
 * restore by hand from the journal's pre-image.
 */
describe('content removed as an edit, outside the rail and outside Revert', () => {
  const directThenRevertible = async (r: { body: Record<string, any>; text: string }) => {
    if (r.body.status === 'proposal_captured') return { proposed: true, revertible: null };
    const jobId = String(r.body.jobId);
    await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000);
    const preview = await w.stack.runtime.reverts.preview(PROJECT, jobId);
    return {
      proposed: false,
      revertible: preview.eligible.ok && preview.notReverted === 0 && preview.ready > 0,
      preview: preview.targets.map((t) => ({ state: t.state, what: (t as { what?: string }).what })),
    };
  };

  it('A5: updateProperty emptying a link collection (Dependencies, two items) is proposed or revertible', async () => {
    const r = await call('lk_api_write', {
      operationId: 'updateProperty',
      params: { path: { resourceId: P.miyabi, propertyId: 'depmiya1' }, body: { items: [] } },
    });
    const out = await directThenRevertible(r);
    expect(out.proposed || out.revertible, `${r.text}\n${JSON.stringify(out)}`).toBe(true);
  });

  it('A6: deleteBlock of the Fourth Age table (the whole 20-row table block) is proposed or revertible', async () => {
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
    expect(out.proposed || out.revertible, `${r.text}\n${JSON.stringify(out)}`).toBe(true);
  });
});
