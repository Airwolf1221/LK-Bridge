import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { formatReport, runSmoke, SandboxGuardError, type SmokeTarget } from '../sandbox/smoke.js';
import { API_KEY, PROJECT, startStack, type Stack } from './helpers.js';
import { specRespond } from './spec-mock.js';

/** The sandbox script's own logic, run against the spec-driven mock (no real LegendKeeper involved). */
let stack: Stack;
const target = (): SmokeTarget => ({
  engine: stack.runtime.engine,
  lk: stack.runtime.projects.client(PROJECT)!,
  projectId: PROJECT,
  baseUrl: stack.mock.url,
  apiKey: API_KEY,
});

beforeAll(async () => {
  // listProjects must answer the sandbox project, as the real key's project would.
  stack = await startStack({
    respond: specRespond({
      listProjects: () => ({
        status: 200,
        body: { data: [{ id: PROJECT, name: 'Sandbox' }], hasMore: false, nextCursor: null },
      }),
    }),
    uploadGuard: {
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      allowAddress: (a) => a === '127.0.0.1',
    },
  });
});
afterAll(() => stack.close());

describe('sandbox smoke script (dry run)', () => {
  it('refuses to run against any project other than the one it was given', async () => {
    await expect(runSmoke(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(SandboxGuardError);
    expect(stack.mock.calls.filter((c) => c.method !== 'GET')).toHaveLength(0); // nothing was written
  });

  it('refuses when the key can see a different project', async () => {
    const other = await startStack({
      respond: specRespond({
        listProjects: () => ({
          status: 200,
          body: { data: [{ id: 'proj_other' }], hasMore: false, nextCursor: null },
        }),
      }),
    });
    try {
      // v2 A1: the bridge's own start-up check already refuses the key (it belongs to another project than
      // LK_PROJECT_ID), so the project is stopped and the smoke script cannot reach it at all.
      expect(other.runtime.projects.find('test')).toMatchObject({ status: 'stopped' });
      expect(other.runtime.projects.find('test')!.reason).toContain('proj_other');
      await expect(
        runSmoke(
          {
            ...target(),
            engine: other.runtime.engine,
            lk: other.runtime.projects.anyClient(PROJECT)!,
            baseUrl: other.mock.url,
          },
          PROJECT,
        ),
      ).rejects.toThrow();
      expect(other.mock.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('runs every check and family to completion, and reports each', async () => {
    const findings = await runSmoke(target(), PROJECT);
    const ids = findings.map((f) => f.id);
    for (const id of [
      'a',
      'b',
      'c',
      'd.resources',
      'd.documents',
      'd.blocks',
      'd.infobox',
      'd.properties',
      'd.timeline',
      'd.map',
      'd.board',
      'd.assets',
      'd.calendars',
      'e',
      'f',
      'cleanup',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(findings.find((f) => f.id === 'c')!.verdict).toBe('skipped');
    // The mock does not echo x-request-id, so check (a) must say so rather than pass.
    expect(findings.find((f) => f.id === 'a')!.verdict).toBe('fail');
    expect(findings.find((f) => f.id === 'cleanup')!.verdict).toBe('pass');
    const failed = findings.filter((f) => f.verdict === 'fail').map((f) => `${f.id}: ${f.detail}`);
    writeFileSync('/tmp/dry.txt', formatReport(findings));
    // Checks that need real LK data or semantics (an echoed request id, block ids and versions, a real signed URL)
    // cannot pass against generated bodies; every other family must run clean.
    // v2 D3 (ADR 0041): an asset delete keeps the file first, and the spec's example asset has no file on an asset host,
    // so d.assets' delete is refused here (against LegendKeeper the file is on its asset host).
    const needsRealLk = ['a:', 'b:', 'd.blocks:', 'd.infobox:', 'd.assets:', 'e:'];
    expect(failed.filter((f) => !needsRealLk.some((p) => f.startsWith(p)))).toEqual([]);
  });

  // The owner's sandbox run of 12 November 2026: writes parked for budget were reported as failures and the throwaway
  // root was left behind. Here LegendKeeper throttles the first write and the clean-up for longer than the governor waits
  // inline (Retry-After 31 s), so both are PARKED (`waiting_budget`); the script must wait for them, not fail.
  it('waits for a parked write instead of failing, the clean-up included', async () => {
    const parked = new Set<string>();
    const off = stack.runtime.engine.events.on('job', (e) => {
      if (e.job.status === 'waiting_budget') parked.add(e.job.id);
    });
    const throttle = { kind: 'rate-limit' as const, tier: 'write-min' as const, retryAfterS: 31 };
    stack.mock.inject((c) => c.method === 'POST' && /\/resources\/?$/.test(c.path), throttle, 1);
    // The clean-up's cascade delete is throttled too: armed just before the script sends it.
    const engine = stack.runtime.engine;
    const wrapped = Object.create(engine) as typeof engine;
    wrapped.run = (op, params, opts) => {
      if (op === 'deleteResource' && (params?.query as { cascade?: unknown } | undefined)?.cascade === true) {
        stack.mock.inject((c) => c.method === 'DELETE', throttle, 1);
      }
      return engine.run(op, params, opts);
    };
    try {
      const findings = await runSmoke({ ...target(), engine: wrapped }, PROJECT, {
        waitMs: 5_000,
        maxWaits: 30,
      });
      expect(parked.size).toBeGreaterThanOrEqual(2);
      expect(findings.find((f) => f.id === 'cleanup')).toMatchObject({ verdict: 'pass' });
      expect(findings.find((f) => f.id === 'd.resources')).toMatchObject({ verdict: 'pass' });
      expect(findings.filter((f) => /did not complete|waiting_budget/.test(f.detail))).toEqual([]);
    } finally {
      off();
    }
  }, 180_000);
});
