import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatReport, runSmoke, SandboxGuardError, type SmokeTarget } from '../sandbox/smoke.js';
import { expectEveryItemPasses, type OnMock } from '../sandbox-mock/harness.js';
import { sandboxOnMockWithHosts } from '../sandbox-mock/hosts.js';
import { sandboxWorld, type SandboxWorld } from '../sandbox-mock/world.js';
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

  // CR-2026-11-R4 (the owner's request S): the run that counts is the strict one below, on the faithful mock through the
  // sandbox runtime; this spec-driven mock (generated bodies) only exercises the guard and the waits.
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

/**
 * CR-2026-11-R4 (the owner's request S): the smoke script run as the owner runs it (`createSoakRuntime` against the mock,
 * test/sandbox-mock/harness.ts with the world's asset and upload hosts) on the faithful mock world (every entity family
 * modelled as LegendKeeper answers it, test/sandbox-mock/), and every item must pass: (c) alone is SKIPPED, by design and
 * with its reason; anything else not PASS fails the build with the whole report printed.
 */
describe('sandbox smoke script, on the faithful mock through the sandbox runtime', () => {
  let w: SandboxWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = await sandboxWorld();
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: w.assetHosts });
  }, 120_000);
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every check and family passes, (c) is skipped with its reason, and the throwaway root is gone', async () => {
    // The real run's target (test/sandbox/smoke.test.ts): the sandbox runtime's engine, client, base URL and key.
    const findings = await runSmoke(
      {
        engine: on.sb.runtime.engine,
        lk: on.sb.lk,
        projectId: on.sb.projectId,
        baseUrl: on.sb.runtime.config.lk.baseUrl,
        apiKey: API_KEY,
      },
      PROJECT,
    );
    const report = formatReport(findings);
    // (c) is never run (it cannot be tested safely), on the real API too: SKIPPED, with exactly this reason.
    const c = findings.find((f) => f.id === 'c');
    expect(c, report).toMatchObject({
      verdict: 'skipped',
      detail:
        'Not safely testable against a real project. The engine verifies every minted id after an ambiguous outcome and re-sends only the missing items (ADR 0010; test/jobs/batch-recovery.test.ts). LK’s own guide says the call is not atomic.',
    });
    expectEveryItemPasses(
      findings.filter((f) => f.id !== 'c'),
      report,
    );
    expect(
      findings.map((f) => f.id),
      report,
    ).toEqual([
      'a',
      'b',
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
      'd.reads',
      'e',
      'f',
      'cleanup',
      'c',
    ]);
    expect(w.liveNamed(/^lk-bridge smoke /), report).toEqual([]);
  }, 300_000);
});
