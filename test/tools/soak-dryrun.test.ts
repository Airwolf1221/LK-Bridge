/**
 * The sandbox soak's own logic (chunk 8, required change B), run against the mock LegendKeeper: the mock enforces the
 * published rate limits and counts any 429 it really had to send, so this checks the guard, the workload, the clean-up
 * and the report without touching a real project.
 */
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { MockLk } from '../contract/mock-lk.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { createSoakRuntime, formatSoakReport, runSoak, type SoakRuntime } from '../sandbox/soak.js';
import { API_KEY, PROJECT } from './helpers.js';
import { specRespond } from './spec-mock.js';

let mock: MockLk | undefined;
let soak: SoakRuntime | undefined;
afterEach(async () => {
  await soak?.close();
  await mock?.stop();
  soak = undefined;
  mock = undefined;
});

async function start(projectSeen: string, logStream?: Writable) {
  mock = new MockLk({
    clock: systemClock,
    apiKey: API_KEY,
    respond: specRespond({
      listProjects: () => ({
        status: 200,
        body: { data: [{ id: projectSeen, name: 'Test world' }], hasMore: false, nextCursor: null },
      }),
    }),
  });
  const url = await mock.start();
  soak = await createSoakRuntime({
    apiKey: API_KEY,
    project: 'sandbox',
    baseUrl: url,
    // The real pacing would make this take minutes; the published limits are still enforced by the mock.
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
    ...(logStream ? { logStream } : {}),
  });
  return { mock, soak };
}

describe('sandbox soak (dry run)', () => {
  it('C2d: starts with no SECRETS_MASTER_KEY warning (the wrappers keep the master key out of the environment)', async () => {
    // The owner's run of 11 November 2026 printed four: the config's and the secret store's, from each of the smoke's
    // and the assumptions' runtimes. These runtimes keep no secrets (a temporary database; the key is handed over).
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    expect(process.env.SECRETS_MASTER_KEY).toBeUndefined();
    await start(PROJECT, sink);
    expect(lines.filter((l) => l.includes('SECRETS_MASTER_KEY'))).toEqual([]);
  });

  it('refuses, writing nothing, when the key belongs to another project', async () => {
    const { mock, soak } = await start('proj_somebody_else');
    await expect(
      runSoak(
        { engine: soak.runtime.engine, lk: soak.lk, projectId: soak.projectId, counters: soak.counters },
        PROJECT,
        { writes: 24 },
      ),
    ).rejects.toBeInstanceOf(SandboxGuardError);
    expect(mock.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('runs the workload through the engine and governor, cleans up, and reports zero 429s', async () => {
    const { mock, soak } = await start(PROJECT);
    const lines: string[] = [];
    const report = await runSoak(
      { engine: soak.runtime.engine, lk: soak.lk, projectId: soak.projectId, counters: soak.counters },
      PROJECT,
      { writes: 40, batchSize: 7, log: (l) => lines.push(l) },
    );
    const text = formatSoakReport(report);
    expect(report.failures, text).toEqual([]);
    expect(report.passed, text).toBe(true);
    expect(report.pages).toBe(10);
    // 10 creates + 30 edits + the root's create and delete, each sent once.
    expect(report.http.writes).toBe(42);
    expect(report.steps).toEqual({ succeeded: 40, failed: 0, other: 0 });
    expect(report.http.reads).toBeGreaterThanOrEqual(40); // engine pre-reads, page reads, read-backs
    expect(report.status429).toBe(0);
    expect(mock.stats.genuine429).toBe(0);
    expect(report.peak.rssMb).toBeGreaterThan(0);
    expect(report.cleanup.ok).toBe(true);
    // The clean-up is the cascade delete of the one root it created.
    const deletes = mock.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toContain(report.cleanup.rootId!);
    expect(text).toMatch(/429 responses: {7}0 \(target: 0\)/);
    expect(text).toMatch(/Writes per minute:/);
    expect(text).toMatch(/Peak memory:/);
    expect(lines.some((l) => l.startsWith('Phase 3 done'))).toBe(true);
  }, 60_000);
});
