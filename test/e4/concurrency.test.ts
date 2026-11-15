/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * PLAN-v2 10.6, E4's concurrency acceptance tests against the mock (docs/reviews/E4-2026-11.md, section 4). The
 * write_page-only half of test 1 was built in C1 (test/pages/concurrency.test.ts); this file adds:
 *
 * 1. many simultaneous bridge writes to ONE page through MIXED tools (write_page, set_facts, update_resource,
 *    create_map_feature, lk_api_write on the board), from several connections at once: every answer is either written
 *    (and then its change is there at the end) or an explicit conflict; nothing is lost silently;
 * 3. an outside write landing between the bridge's read and its write, for every write family (blocks, sidebar, map
 *    features, board, resource; events are in the chronology world below): the in-lock check refuses it, or the verify
 *    step reports it, and the outside edit survives.
 *
 * Test 2 (simultaneous same-version writes sent straight to LegendKeeper) is a sandbox test: test/sandbox/concurrency.ts.
 * Everything here runs the REAL server, runtime, policy and engine with the official MCP SDK client.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../contract/mock-lk.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

let w: SnapshotsWorld;
const clients: Client[] = [];
const call = (i: number, tool: string, args: Record<string, unknown>) =>
  w.stack.call(clients[i % clients.length]!, tool, { project: 'test', ...args });

const CONFLICTS = new Set([
  'VERSION_CONFLICT',
  'CONFLICT',
  'MAP_CHANGED',
  'MAP_CONFLICT',
  'SNAPSHOT_MAP_CHECK',
  'FACTS_CONFLICT',
]);

/** An answer is honest: written (verified), or refused with a conflict code. Never anything else. */
function outcome(r: { isError: boolean; body: any; text: string }): 'written' | 'conflict' {
  if (!r.isError && r.body.status === 'written') {
    expect(r.body.verified, r.text).not.toBe(false);
    return 'written';
  }
  const code = r.body.error?.code ?? r.body.code;
  expect(CONFLICTS.has(code) || /CONFLICT|CHANGED/.test(String(code)), r.text).toBe(true);
  // A conflict never claims to have written anything.
  expect(r.body.error?.written ?? [], r.text).toEqual([]);
  return 'conflict';
}

/** The body replaceBoardContent takes, from what getBoardContent answered (its version left out). */
const boardBody = (c: any) => {
  const { version: _v, schema: _s, pages: _p, ...rest } = c ?? {};
  return rest;
};

const textOfMain = () =>
  ((w.repo.blocks.get(w.d.main)?.blocks ?? []) as any[])
    .map((b) => (b.content ?? []).map((x: any) => x.text ?? '').join(''))
    .join('\n');

/** Runs `fn` once, on the n-th request (0-based) that matches, before it is answered (so it sees the change). */
function onRequest(match: (req: MockRequest) => boolean, n: number, fn: () => void): () => void {
  let seen = 0;
  let done = false;
  const re = /.*/;
  const key = new RegExp(`${re.source}|E4CONC${Math.random()}`);
  const hook = (req: MockRequest) => {
    if (!done && match(req) && seen++ === n) {
      done = true;
      fn();
    }
    return undefined;
  };
  // First in the map, so it runs before the world's own answers (which stop the search).
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(key, hook);
  for (const [k, v] of rest) w.overrides.set(k, v);
  return () => w.overrides.delete(key);
}

beforeAll(async () => {
  w = await snapshotsWorld();
  for (let i = 0; i < 4; i++) clients.push(await w.stack.connect());
}, 60_000);
afterAll(() => w.close());

describe('10.6 test 1: many simultaneous writes to one page through mixed tools', () => {
  it('every answer is written or an explicit conflict, and every written change is there at the end', async () => {
    const page = S.atlas;
    const lines = [0, 1, 2, 3, 4].map((i) => `Concurrent line ${i}.`);
    const facts = [0, 1, 2].map((i) => [`E4 Fact ${i}`, `value ${i}`] as const);
    const tags = [0, 1, 2].map((i) => `e4-tag-${i}`);
    const pins = [0, 1].map((i) => `E4 Pin ${i}`);
    const board = (await call(0, 'lk_api_read', {
      operationId: 'getBoardContent',
      params: { path: { resourceId: page, documentId: w.d.plot } },
      detail: 'full',
    })) as any;
    const boardVersion = board.body?.result?.version ?? board.body?.version;
    const calls: { kind: string; key: string; p: Promise<any> }[] = [
      ...lines.map((l, i) => ({
        kind: 'line',
        key: l,
        p: call(i, 'write_page', { page, mode: 'append', markdown: l }),
      })),
      ...facts.map(([k, v], i) => ({
        kind: 'fact',
        key: k,
        p: call(i + 1, 'set_facts', { page, facts: { [k]: v } }),
      })),
      ...tags.map((t, i) => ({
        kind: 'tag',
        key: t,
        p: call(i + 2, 'update_resource', { page, tags: { add: [t] } }),
      })),
      ...pins.map((n, i) => ({
        kind: 'pin',
        key: n,
        p: call(i + 3, 'create_map_feature', {
          page,
          document: 'Map',
          type: 'pin',
          name: n,
          latlng: [-5 - i, 5 + i],
        }),
      })),
      ...(typeof boardVersion === 'string'
        ? [0, 1].map((i) => ({
            kind: 'board',
            key: `board ${i}`,
            p: call(i, 'lk_api_write', {
              operationId: 'replaceBoardContent',
              params: {
                path: { resourceId: page, documentId: w.d.plot },
                ifMatch: boardVersion,
                body: boardBody(board.body?.result ?? board.body),
              },
            }),
          }))
        : []),
    ];
    const answers = await Promise.all(calls.map((c) => c.p));
    const tally = { written: 0, conflict: 0 };
    const written: { kind: string; key: string }[] = [];
    answers.forEach((r, i) => {
      // A low-level write may be queued; it is then waited for below by its job.
      if (!r.isError && (r.body.status === 'queued' || r.body.status === 'waiting_budget')) return;
      if (calls[i]!.kind === 'board') {
        // Two writes with ONE version: the bridge's own compare-and-swap lets exactly one through.
        if (!r.isError) written.push(calls[i]!);
        return;
      }
      const o = outcome(r);
      tally[o]++;
      if (o === 'written') written.push(calls[i]!);
    });
    // Nothing is lost: every written change is in LegendKeeper (the mock) at the end.
    const main = textOfMain();
    const rows = w.sidebars.rows(page).map((x: any) => `${x.key}=${x.text}`);
    const nowTags = w.repo.live(page)!.tags;
    const pinNames = (w.features.get(w.d.map) ?? []).map((f) => f.name);
    for (const c of written) {
      if (c.kind === 'line') expect(main, c.key).toContain(c.key);
      if (c.kind === 'fact') expect(rows.join('|'), c.key).toContain(c.key);
      if (c.kind === 'tag') expect(nowTags, c.key).toContain(c.key);
      if (c.kind === 'pin') expect(pinNames, c.key).toContain(c.key);
    }
    // The board: one version, two writes: never both.
    expect(written.filter((c) => c.kind === 'board').length).toBeLessThanOrEqual(1);
    // At least one of each goes in, and every other one says it conflicted: facts and tags are compared inside the
    // lock with what the plan read (a fact row or tag added meanwhile is a conflict, never overwritten); map pins are
    // placed between the real neighbours inside the lock, so both go in; text appends from one read may conflict.
    expect(written.filter((c) => c.kind === 'fact').length).toBeGreaterThanOrEqual(1);
    // Tags replace the whole list and LegendKeeper does not version a resource: two at once, one is written and the
    // other reports a conflict (E4-01: before the fix both said "written" and one tag was lost).
    expect(written.filter((c) => c.kind === 'tag').length).toBeGreaterThanOrEqual(1);
    expect(written.filter((c) => c.kind === 'pin').length).toBe(pins.length);
    expect(written.filter((c) => c.kind === 'line').length).toBeGreaterThanOrEqual(1);
    expect(tally.written + tally.conflict).toBe(answers.length - (typeof boardVersion === 'string' ? 2 : 0));
  }, 120_000);
});

describe('10.6 test 3: an outside write between the bridge’s read and its write, for every family', () => {
  it('blocks (write_page): caught by the in-lock compare-and-swap; the outside edit survives', async () => {
    const off = onRequest(
      (r) => r.method === 'GET' && r.path.includes(`/docs/${w.d.main}/blocks`),
      1, // the plan read is 0; the in-lock read is 1
      () => {
        const b = w.repo.blocks.get(w.d.main)!;
        (b.blocks as any[]).push({
          id: 'outs0001',
          kind: 'paragraph',
          content: [{ text: 'Written in the app.' }],
        });
        b.version++;
      },
    );
    const r = await call(0, 'write_page', { page: S.atlas, mode: 'append', markdown: 'Bridge line.' });
    off();
    expect(r.isError, r.text).toBe(true);
    expect(r.body.error.code).toBe('VERSION_CONFLICT');
    expect(textOfMain()).toContain('Written in the app.');
    expect(textOfMain()).not.toContain('Bridge line.');
  });

  it('sidebar (set_facts): caught inside the lock; the outside edit survives', async () => {
    const before = w.sidebars.rows(S.atlas).length;
    let edited = false;
    const g = await call(0, 'get_resource', { page: S.atlas });
    const off = onRequest(
      (r) => r.method === 'GET' && /\/resources\/[^/]+\/properties\/[^/]+\/rows\/?$/.test(r.path),
      0,
      () => {
        // The app changes a fact after set_facts' plan read, before its in-lock read.
        const sb = w.sidebars.pages.get(S.atlas) as any;
        const kv = sb.props.find((p: any) => p.kind === 'keyValue');
        const scope = kv.rows.find((x: any) => x.key === 'Scope');
        scope.content = [{ text: 'Changed in the app' }];
        sb.version++;
        edited = true;
      },
    );
    const r = await call(0, 'set_facts', {
      page: S.atlas,
      facts: { 'E4 Late': 'late' },
      ...(g.body.factsVersion ? { baseFactsVersion: g.body.factsVersion } : {}),
    });
    off();
    expect(edited).toBe(true);
    const rows = w.sidebars.rows(S.atlas).map((x: any) => `${x.key}=${x.text}`);
    // With baseFactsVersion from the read before the edit: refused as a conflict; the app's change survives.
    expect(r.isError, r.text).toBe(true);
    expect(String(r.body.error.code)).toMatch(/CONFLICT/);
    expect(rows).toContain('Scope=Changed in the app');
    expect(rows.some((x) => x.startsWith('E4 Late'))).toBe(false);
    expect(rows.length).toBeGreaterThanOrEqual(before);
  });

  it('map features (update_map_feature): caught by the map check inside the lock; the outside move survives', async () => {
    const off = onRequest(
      (r) => r.method === 'GET' && r.path.includes(`/docs/${w.d.map}/features`),
      1,
      () => {
        const f = (w.features.get(w.d.map) ?? []).find((x) => x.id === 'pin00002')!;
        f.pos = [-41, 61];
        f.name = 'Isar (moved in the app)';
      },
    );
    const r = await call(0, 'update_map_feature', {
      page: S.atlas,
      document: 'Map',
      feature: 'pin00002',
      latlng: [-30, 50],
    });
    off();
    const f = (w.features.get(w.d.map) ?? []).find((x) => x.id === 'pin00002')!;
    if (!r.isError) {
      // Written: then the app's rename must still be there (the plan was redone on the map as it was).
      expect(f.name).toBe('Isar (moved in the app)');
    } else {
      expect(String(r.body.error.code), r.text).toMatch(/CONFLICT|CHANGED|STALE/);
      expect(f.pos).toEqual([-41, 61]);
    }
  });

  it('board (lk_api_write replaceBoardContent with the version read): the bridge’s compare-and-swap refuses it', async () => {
    const read = (await call(0, 'lk_api_read', {
      operationId: 'getBoardContent',
      params: { path: { resourceId: S.atlas, documentId: w.d.plot } },
      detail: 'full',
    })) as any;
    const content = read.body?.result ?? read.body;
    const version = content.version as string;
    // The app changes the board after the agent's read.
    const b = w.boards.get(w.d.plot)!;
    b.version++;
    (b.content as any).outside = true;
    const r = await call(0, 'lk_api_write', {
      operationId: 'replaceBoardContent',
      params: {
        path: { resourceId: S.atlas, documentId: w.d.plot },
        ifMatch: version,
        body: boardBody(content),
      },
    });
    expect(r.isError, r.text).toBe(true);
    expect(String(r.body.error.code), r.text.slice(0, 900)).toMatch(/CONFLICT|VERSION/);
    expect((w.boards.get(w.d.plot)!.content as any).outside).toBe(true);
  });

  it('resource (update_resource tags): an outside tag edit while it plans is never overwritten', async () => {
    const off = onRequest(
      (r) => r.method === 'GET' && new RegExp(`/resources/${S.atlas}/?$`).test(r.path),
      0,
      () => {
        const res = w.repo.live(S.atlas)!;
        res.tags = [...res.tags, 'added-in-the-app'];
      },
    );
    const r = await call(0, 'update_resource', { page: S.atlas, tags: { add: ['e4-late-tag'] } });
    off();
    const tags = w.repo.live(S.atlas)!.tags;
    expect(tags, r.text).toContain('added-in-the-app');
    if (!r.isError) expect(tags).toContain('e4-late-tag');
  });
});
