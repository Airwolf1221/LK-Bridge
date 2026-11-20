/**
 * v3 F4b (ADR 0064), the owner's sandbox run of consistency-f4b (20 November 2026): its probe's Authoritative
 * `[BSRC] … - Character Core` must never be created through the bridge's governed route (the canon guard rightly refuses
 * it as the system principal). The probe's helper (test/sandbox/f4b-probe.ts) makes the probe's pages, and deletes them,
 * with the sandbox runtime's RAW client: against the mock LegendKeeper, every request reaches LegendKeeper through the
 * governor while the job engine is never asked to create anything, and the sandbox check itself makes no governed create.
 */
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { MockLk, type MockRequest } from '../contract/mock-lk.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import { createProbePages, deleteProbe, rawLk } from '../sandbox/f4b-probe.js';

const KEY = 'mock-key-not-real';
const seen: MockRequest[] = [];
let n = 0;
const mock = new MockLk({
  clock: systemClock,
  apiKey: KEY,
  respond: (req) => {
    if (!req.path.includes('/resources')) return undefined;
    seen.push(req);
    if (req.method === 'POST' && /\/resources\/?$/.test(req.path)) {
      n++;
      const body = req.body as { name: string; parentId?: string };
      return {
        status: 201,
        body: {
          id: `probe${n}aa`,
          name: body.name,
          parentId: body.parentId ?? null,
          documents: [{ id: `doc${n}aaaa`, name: 'Main', type: 'page' }],
        },
      };
    }
    if (req.method === 'POST' && req.path.endsWith('/properties'))
      return { status: 201, body: { id: 'prop1aaa' } };
    if (req.method === 'GET' && req.path.endsWith('/blocks'))
      return { status: 200, body: { version: 'v1', blocks: [] } };
    if (req.method === 'PUT' && req.path.endsWith('/blocks'))
      return { status: 200, body: { version: 'v2', blocks: [] } };
    if (req.method === 'DELETE') return { status: 204 };
    return undefined;
  },
});
let sb: SoakRuntime;
const quiet = new Writable({
  write(_c: Buffer, _e, done) {
    done();
  },
});

beforeAll(async () => {
  const url = await mock.start();
  sb = await createSoakRuntime({
    apiKey: KEY,
    project: 'test',
    baseUrl: url,
    logStream: quiet,
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
  });
}, 60_000);
afterAll(async () => {
  await sb?.close();
  await mock.stop();
});

describe('the consistency-f4b sandbox probe (the owner’s sandbox run)', () => {
  it('makes the [BSRC] Core and the restating page with the raw client, never through the governed route, and deletes them the same way', async () => {
    const run = vi.spyOn(sb.runtime.engine, 'run');
    const submit = vi.spyOn(sb.runtime.engine, 'submit');
    const raw = rawLk({ lk: sb.lk, projectId: sb.projectId, apiKey: KEY, baseUrl: mock.url });
    let index = '';
    const probe = await createProbePages(raw, {
      rootId: 'rootaaaa',
      stamp: 'T1',
      subject: 'F4b Probe T1',
      made: (id) => {
        index = id;
      },
    });
    await deleteProbe(raw, probe.index);

    // Nothing went through the job engine: no job, no proposal, no guard involved.
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // LegendKeeper received the Core's create (the raw route), under the throwaway index.
    const creates = seen.filter((r) => r.method === 'POST' && /\/resources\/?$/.test(r.path));
    const names = creates.map((r) => (r.body as { name: string }).name);
    expect(names).toEqual([
      'lk-bridge f4b check T1',
      '[BSRC] F4b Probe T1 - Character Core',
      'lk-bridge f4b restatement T1',
    ]);
    expect((creates[1]!.body as { parentId: string }).parentId).toBe(index);
    expect(
      seen.some((r) => r.method === 'POST' && r.path.endsWith(`/resources/${probe.core}/properties`)),
    ).toBe(true);
    const put = seen.find((r) => r.method === 'PUT' && r.path.endsWith(`/docs/${probe.pageDoc}/blocks`))!;
    expect(put.headers['if-match']).toBe('v1');
    const del = seen.find((r) => r.method === 'DELETE')!;
    expect(del.path).toMatch(new RegExp(`/resources/${probe.index}$`));
    expect(del.query.cascade).toBe('true');
    // The governor still paced and counted every one of them.
    expect(sb.counters.requests).toBeGreaterThanOrEqual(6);
  });

  it('the sandbox check makes no create, and no [BSRC] page, through the governed route', () => {
    const src = readFileSync(new URL('../sandbox/consistency-f4b.test.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/run\(\s*['"]create(?:Many)?Resources?(?:FromTemplate)?['"]/);
    expect(src).not.toMatch(/run\(\s*['"]deleteResource['"]/);
    expect(src).toMatch(/createProbePages\(raw,/);
    expect(src).toMatch(/deleteProbe\(raw,/);
  });
});
