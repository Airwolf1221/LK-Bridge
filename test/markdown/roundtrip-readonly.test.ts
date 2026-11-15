/**
 * v2 E5 hotfix (ADR 0046): the Markdown round trip runs on any registered project, Arkona included, so its runtime is
 * read-only by construction (`createReadOnlyRuntime`, test/sandbox/soak.ts). Against the mock LegendKeeper:
 *
 * - a write through the engine is refused (LK_READ_ONLY=true, which no extra environment lifts), and a write sent
 *   straight to the governor is refused by its allow-list: neither reaches LegendKeeper;
 * - a read that is not on the allow-list is refused too, before a request;
 * - the reads-only transport refuses any method but GET, should anything get that far;
 * - the round trip itself still runs, and its report's header says whether the project is a sandbox and that the run
 *   was read-only, with the allow-list;
 * - the soak's own runtime is unchanged: writes allowed, no allow-list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BridgeLkError, systemClock } from '../../src/lk/index.js';
import { ROUNDTRIP_OPS, formatRoundTripReport, runRoundTrip } from '../../scripts/markdown-roundtrip-core.js';
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import {
  createReadOnlyRuntime,
  createSoakRuntime,
  readsOnlyTransport,
  type SoakRuntime,
} from '../sandbox/soak.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';

function respond(req: MockRequest): MockResponse | undefined {
  const p = req.path.replace(/\/$/, '');
  if (req.method !== 'GET')
    return { status: 500, body: { code: 'INTERNAL', message: 'must not write', requestId: 'x' } };
  if (p === '/api/v3/projects')
    return {
      status: 200,
      body: { data: [{ id: PROJECT, name: 'Arkona' }], hasMore: false, nextCursor: null },
    };
  if (/^\/api\/v3\/projects\/[^/]+\/resources$/.test(p))
    return {
      status: 200,
      body: {
        data: [
          {
            id: 'page0001',
            name: 'A page',
            parentId: null,
            rank: 'a0',
            tags: [],
            aliases: [],
            documents: [{ id: 'doc00001', name: 'Main', type: 'page' }],
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
    };
  if (/\/docs\/doc00001\/blocks$/.test(p))
    return {
      status: 200,
      body: {
        id: 'doc00001',
        version: 'v1',
        schema: 1,
        text: '',
        blocks: [{ id: 'p0000001', kind: 'paragraph', content: [{ text: 'Hello.' }] }],
      },
    };
  return undefined;
}

let mock: MockLk;
let url: string;
let ro: SoakRuntime;
beforeAll(async () => {
  mock = new MockLk({ clock: systemClock, apiKey: API_KEY, respond });
  url = await mock.start();
  ro = await createReadOnlyRuntime({
    apiKey: API_KEY,
    project: 'arkona',
    allowedOperations: ROUNDTRIP_OPS,
    baseUrl: url,
    // An extra environment cannot lift read-only.
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0', LK_READ_ONLY: 'false' },
  });
});
afterAll(async () => {
  await ro.close();
  await mock.stop();
});
beforeEach(() => {
  mock.calls.length = 0;
});

const origin = { kind: 'test' as const };

describe('the round trip’s read-only runtime', () => {
  it('is read-only and allows only the round trip’s reads', () => {
    expect(ro.projectId).toBe(PROJECT);
    expect(ro.runtime.engine.queries.controls(ro.projectId).readOnly).toBe(true);
    expect([...ROUNDTRIP_OPS].sort()).toEqual(['getDocumentBlocks', 'listProjects', 'listResources']);
  });

  it('refuses a write through the engine, without a request', async () => {
    await expect(
      ro.runtime.engine.run(
        'updateResource',
        { path: { resourceId: 'page0001' }, body: { name: 'Renamed' } },
        { project: ro.projectId, origin },
      ),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(mock.calls).toEqual([]);
    expect(ro.counters.writes).toBe(0);
  });

  it('refuses a write sent straight to the governor (the allow-list), without a request', async () => {
    let error: unknown;
    try {
      await ro.lk.call({
        operationId: 'deleteResource',
        priority: 'P0',
        run: (sdk, signal) =>
          sdk.request({
            method: 'DELETE',
            path: `/api/v3/projects/${PROJECT}/resources/page0001`,
            signal,
          } as never),
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BridgeLkError);
    expect(error).toMatchObject({ code: 'OPERATION_NOT_ALLOWED', retryable: false });
    expect((error as Error).message).toMatch(/deleteResource is not on this governor's allow-list/);
    expect(mock.calls).toEqual([]);
  });

  it('refuses a read that is not on the allow-list, through the engine and straight to the governor', async () => {
    await expect(
      ro.runtime.engine.run(
        'getResource',
        { path: { resourceId: 'page0001' } },
        { project: ro.projectId, origin },
      ),
    ).rejects.toMatchObject({ lkCode: 'OPERATION_NOT_ALLOWED' });
    await expect(
      ro.lk.call({
        operationId: 'listCalendars',
        priority: 'P0',
        run: () => Promise.reject(new Error('must not run')),
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(mock.calls).toEqual([]);
  });

  it('the reads-only transport refuses any method but GET', async () => {
    const sent: string[] = [];
    const t = readsOnlyTransport((input, init) => {
      sent.push(init?.method ?? 'GET');
      return Promise.resolve(new Response('{}'));
    });
    await expect(t('https://lk.invalid/x', { method: 'POST' })).rejects.toBeInstanceOf(SandboxGuardError);
    await expect(t('https://lk.invalid/x', { method: 'delete' })).rejects.toThrow(/read-only/);
    await t('https://lk.invalid/x', { method: 'GET' });
    expect(sent).toEqual(['GET']);
  });

  it('runs the round trip with reads only, and its header says “not a sandbox, read-only” with the allow-list', async () => {
    const out = await runRoundTrip(
      { engine: ro.runtime.engine, lk: ro.lk, projectId: ro.projectId, counters: ro.counters },
      PROJECT,
      { outDir: '/nonexistent-not-written', stamp: 'ro', sleep: () => Promise.resolve() },
    );
    expect(out.pages.filter((p) => p.result?.ok)).toHaveLength(1);
    expect(mock.calls.every((c) => c.method === 'GET')).toBe(true);
    const report = formatRoundTripReport(out, {
      generatedAt: '2026-11-15T00:00:00.000Z',
      projectId: `arkona (${PROJECT})`,
      access: {
        isSandbox: false,
        readOnly: ro.runtime.engine.queries.controls(ro.projectId).readOnly,
        allowedOperations: [...ROUNDTRIP_OPS],
      },
      requests: { total: 3, reads: 3, writes: 0 },
      budgetFooter: 'budget: …',
    });
    expect(report).toContain(
      '- **Project: not a sandbox, read-only.** The run’s governor allowed only `listProjects`, `listResources`, `getDocumentBlocks`'.replace(
        '’',
        "'",
      ),
    );
    const sandbox = formatRoundTripReport(out, {
      generatedAt: '2026-11-15T00:00:00.000Z',
      projectId: 'test',
      access: { isSandbox: true, readOnly: true, allowedOperations: ['listProjects'] },
      requests: { total: 0, reads: 0, writes: 0 },
      budgetFooter: '',
    });
    expect(sandbox).toContain('**Project: a sandbox, read-only.**');
  });
});

describe('the soak’s own runtime is unchanged', () => {
  it('allows writes and has no allow-list', async () => {
    const soak = await createSoakRuntime({
      apiKey: API_KEY,
      project: 'sandbox',
      baseUrl: url,
      env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
    });
    try {
      expect(soak.runtime.engine.queries.controls(soak.projectId).readOnly).toBe(false);
      mock.calls.length = 0;
      // A read the round trip may not send goes through here (the mock answers 404: it was sent).
      await soak.lk
        .call({
          operationId: 'listCalendars',
          priority: 'P0',
          run: (sdk, signal) =>
            sdk.request({ method: 'GET', path: `/api/v3/projects/${PROJECT}/calendars`, signal } as never),
        })
        .catch(() => undefined);
      expect(mock.calls.length).toBeGreaterThan(0);
    } finally {
      await soak.close();
    }
  });
});
