/**
 * The Markdown round-trip script (scripts/markdown-roundtrip-core.ts) run against the mock LegendKeeper, through the
 * real job engine and governor: the project guard, the subtree filter, read-only traffic at P3, the report, and the
 * reproduction file written for a failing page. Plus the page check itself (src/markdown/check.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { checkRoundTrip, firstDifference, minimalRepro } from '../../src/markdown/check.js';
import type { LkBlock } from '../../src/markdown/types.js';
import {
  formatRoundTripReport,
  runRoundTrip,
  writeRoundTripReport,
} from '../../scripts/markdown-roundtrip-core.js';
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';
import { bsrcPage, fourthAgeTablePage, mainChronologyPage, richPage } from './fixtures.js';

interface Res {
  id: string;
  name: string;
  parentId: string | null;
  docs: { id: string; name: string; type: string; blocks?: LkBlock[] }[];
}

const WORLD: Res[] = [
  {
    id: 'fsbn0b7w',
    name: 'AI REPOSITORY',
    parentId: null,
    docs: [{ id: 'd0000001', name: 'Main', type: 'page', blocks: [] }],
  },
  {
    id: 'kq3v8a2m',
    name: '[BSRC] Asagiri Miyabi',
    parentId: 'fsbn0b7w',
    docs: [{ id: 'd0000002', name: 'Main', type: 'page', blocks: bsrcPage() }],
  },
  {
    id: 'h0gczxh7',
    name: '[BSRC] Universal Chronology',
    parentId: 'fsbn0b7w',
    docs: [
      { id: 'k6wkpozi', name: 'Main', type: 'page', blocks: mainChronologyPage() },
      { id: 'bt0bm3pc', name: 'Fourth Arkonan Age - Table', type: 'page', blocks: fourthAgeTablePage(120) },
      { id: 'g2lm1d0v', name: 'Fourth Arkonan Age - Timeline', type: 'time' },
    ],
  },
  {
    id: 'qishen01',
    name: '[BSRC] Qishen',
    parentId: 'kq3v8a2m',
    docs: [{ id: 'd0000003', name: 'Main', type: 'page', blocks: richPage() }],
  },
  {
    id: 'legacy01',
    name: '[BSRC] Legacy page',
    parentId: 'fsbn0b7w',
    docs: [{ id: 'd0000004', name: 'Main', type: 'page' }],
  },
  {
    id: 'outside1',
    name: 'Outside the root',
    parentId: null,
    docs: [
      { id: 'd0000005', name: 'Main', type: 'page', blocks: [] },
      { id: 'd0000006', name: 'Map', type: 'map' },
    ],
  },
];

function respond(req: MockRequest): MockResponse | undefined {
  const p = req.path.replace(/\/$/, '');
  if (req.method !== 'GET')
    return {
      status: 500,
      body: { code: 'INTERNAL', message: 'the round trip must not write', requestId: 'x' },
    };
  if (p === '/api/v3/projects')
    return {
      status: 200,
      body: { data: [{ id: PROJECT, name: 'Test world' }], hasMore: false, nextCursor: null },
    };
  if (/^\/api\/v3\/projects\/[^/]+\/resources$/.test(p)) {
    const limit = Number(req.query.limit ?? 50);
    const start = Number(req.query.cursor ?? 0);
    const items = WORLD.slice(start, start + limit).map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      rank: 'a0',
      tags: [],
      aliases: [],
      documents: r.docs.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    }));
    const more = start + limit < WORLD.length;
    return {
      status: 200,
      body: { data: items, hasMore: more, nextCursor: more ? String(start + limit) : null },
    };
  }
  const m = /^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p);
  if (m) {
    const doc = WORLD.find((r) => r.id === m[1])?.docs.find((d) => d.id === m[2]);
    if (!doc?.blocks)
      return { status: 409, body: { code: 'AMBIGUOUS', message: 'legacy document', requestId: 'x' } };
    return { status: 200, body: { id: doc.id, version: 'v1', schema: 1, text: '', blocks: doc.blocks } };
  }
  return undefined;
}

let mock: MockLk;
let soak: SoakRuntime;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-roundtrip-'));
  mock = new MockLk({ clock: systemClock, apiKey: API_KEY, respond, limits: { 'write-min': 120 } });
  const url = await mock.start();
  // v2 A1: the runtime serves one named project and proves its key's project at start-up.
  soak = await createSoakRuntime({ apiKey: API_KEY, project: 'sandbox', baseUrl: url, writersMax: 1 });
  expect(soak.projectId).toBe(PROJECT);
});
afterAll(async () => {
  await soak.close();
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mock.calls.length = 0;
});

const target = () => ({
  engine: soak.runtime.engine,
  lk: soak.lk,
  projectId: soak.projectId,
  counters: soak.counters,
});

describe('the round-trip script (dry run against the mock)', () => {
  it('checks every page of the project with reads only, and passes', async () => {
    const out = await runRoundTrip(target(), PROJECT, {
      outDir: dir,
      stamp: 'test-pass',
      sleep: () => Promise.resolve(),
    });
    expect(out.resources).toBe(WORLD.length);
    expect(out.otherDocuments).toBe(2);
    const checked = out.pages.filter((x) => x.result);
    expect(checked).toHaveLength(6);
    expect(checked.every((x) => x.result!.ok)).toBe(true);
    expect(out.pages.find((x) => x.resourceId === 'legacy01')?.readError).toMatch(/legacy|AMBIGUOUS/i);
    expect(mock.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(mock.calls.length).toBe(1 + 1 + 7); // projects, one listing page, one read per page document
    const report = formatRoundTripReport(out, {
      generatedAt: '2026-11-09T00:00:00.000Z',
      projectId: PROJECT,
      requests: { total: 9, reads: 9, writes: 0 },
      budgetFooter: 'budget: …',
    });
    expect(report).toContain('Pages checked: 6; passed: 6; failed: 0; could not be read: 1.');
    expect(report).toContain('**Verdict: INCOMPLETE.**');
    expect(report).toContain('- infobox (an infobox): 1');
    expect(report).toContain('- unsupported (content the API cannot show): 1');
    expect(report).toContain('## Pages that could not be read');
    const file = writeRoundTripReport(dir, 'test-pass', report);
    expect(readFileSync(file, 'utf8')).toBe(report);
  });

  it('limits itself to a subtree and to --max-pages', async () => {
    const sub = await runRoundTrip(target(), PROJECT, {
      outDir: dir,
      stamp: 'test-sub',
      root: 'kq3v8a2m',
      sleep: () => Promise.resolve(),
    });
    expect(sub.pages.map((x) => x.resourceId)).toEqual(['kq3v8a2m', 'qishen01']);
    const few = await runRoundTrip(target(), PROJECT, {
      outDir: dir,
      stamp: 'test-few',
      maxPages: 2,
      sleep: () => Promise.resolve(),
    });
    expect(few.pages).toHaveLength(2);
    expect(few.truncated).toBe(true);
  });

  it('writes a minimal reproduction for a failing page, and the report names it with its first difference', async () => {
    const failing = (blocks: readonly LkBlock[]) => {
      const r = checkRoundTrip(blocks);
      return blocks.some((b) => b.id === 'img00001')
        ? {
            ...r,
            ok: false,
            failure: {
              stage: 'identity' as const,
              message: 'simulated',
              path: '[2].alt',
              expected: 'a',
              actual: 'b',
            },
          }
        : r;
    };
    const out = await runRoundTrip(target(), PROJECT, {
      outDir: dir,
      stamp: 'test-fail',
      check: failing,
      sleep: () => Promise.resolve(),
    });
    const bad = out.pages.filter((x) => x.result && !x.result.ok);
    expect(bad.map((x) => x.resourceId)).toEqual(['kq3v8a2m']);
    const repro = JSON.parse(readFileSync(bad[0]!.repro!, 'utf8')) as {
      reproduction: { blocks: LkBlock[]; note: string };
      resource: { name: string };
    };
    expect(repro.resource.name).toBe('[BSRC] Asagiri Miyabi');
    expect(repro.reproduction.blocks.map((b) => b.id)).toEqual(['img00001']);
    expect(repro.reproduction.note).toMatch(/first top-level block/);
    const report = formatRoundTripReport(out, {
      generatedAt: 'now',
      projectId: PROJECT,
      requests: { total: 0, reads: 0, writes: 0 },
      budgetFooter: '',
    });
    expect(report).toContain('**Verdict: FAIL.**');
    expect(report).toContain('First difference at `[2].alt`');
    expect(report).toContain(bad[0]!.repro!);
  });

  it('refuses when the key’s own project is not the registered one, before reading anything else', async () => {
    // The registered sandbox project is proj_other; the key proves proj_mock.
    await expect(runRoundTrip(target(), 'proj_other', { outDir: dir, stamp: 'x' })).rejects.toBeInstanceOf(
      SandboxGuardError,
    );
    expect(mock.calls.map((c) => c.path.replace(/\/$/, ''))).toEqual(['/api/v3/projects']);
  });

  it('stops after the current page when interrupted', async () => {
    const abort = new AbortController();
    abort.abort();
    const out = await runRoundTrip(target(), PROJECT, {
      outDir: dir,
      stamp: 'test-int',
      signal: abort.signal,
    });
    expect(out.interrupted).toBe(true);
    expect(out.pages).toEqual([]);
    expect(existsSync(join(dir, 'roundtrip-test-int'))).toBe(false);
  });
});

describe('the page check', () => {
  it('passes the fixtures and reports keep regions and timing', () => {
    for (const page of [bsrcPage(), richPage(), mainChronologyPage()])
      expect(checkRoundTrip(page).ok).toBe(true);
    const r = checkRoundTrip(richPage());
    expect(r.regions.map((x) => x.kind)).toEqual([
      'infobox',
      'resourceCollection',
      'paragraph',
      'unsupported',
    ]);
    expect(r.blocks).toBe(10);
  });
  it('finds the first difference, field order included', () => {
    expect(firstDifference([{ a: 1, b: [1, 2] }], [{ a: 1, b: [1, 3] }])).toEqual({
      path: '[0].b[1]',
      expected: 2,
      actual: 3,
    });
    expect(firstDifference({ a: 1, b: 2 }, { b: 2, a: 1 })?.path).toBe('a');
    expect(firstDifference([1], [1, 2])).toEqual({ path: '[1]', expected: undefined, actual: 2 });
    expect(firstDifference({ x: [{ y: 'same' }] }, { x: [{ y: 'same' }] })).toBeNull();
  });
  it('reduces a failure to the first top-level block that fails on its own', () => {
    const blocks: LkBlock[] = [
      { id: 'a', kind: 'rule' },
      { id: 'b', kind: 'paragraph', content: [] },
    ];
    const fake = (bs: readonly LkBlock[]) => ({ ...checkRoundTrip(bs), ok: !bs.some((x) => x.id === 'b') });
    expect(minimalRepro(blocks, fake).map((x) => x.id)).toEqual(['b']);
    expect(minimalRepro(blocks, () => ({ ...checkRoundTrip([]), ok: false })).map((x) => x.id)).toEqual([
      'a',
    ]);
  });
  it('turns a converter error into a failure of the page, never a crash', () => {
    const r = checkRoundTrip([{ id: 'x', kind: 'paragraph', content: 'not runs' }]);
    expect(r.ok).toBe(true); // shown as a keep region, restored exactly
    expect(r.regions).toHaveLength(1);
  });
});
