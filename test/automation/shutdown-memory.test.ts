/* eslint-disable @typescript-eslint/no-unsafe-assignment -- runtime introspection */
/**
 * v3 F5b (ADR 0068, H5) with CR-2026-11-R3's rules for scheduled tasks:
 *
 * - SIGTERM (the bridge stopped exactly as SIGTERM stops it, `stack.restart()`) stops a run at a step boundary: no job is
 *   left part-way, the run is recorded as stopped, and the next run (on the new bridge) carries on with what is left,
 *   writing no page twice;
 * - a run logs its start and finish with the memory (R3-65's task log);
 * - repeated runs come back to their baseline (what a run keeps once done).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TERMINAL_JOB_STATUSES } from '../../src/jobs/index.js';
import { loggedTask } from '../../src/maintenance/task-log.js';
import { automationWorld, PROJECT, type AutomationWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapMb = async (): Promise<number> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / 1048576;
};

let w: AutomationWorld;
beforeAll(async () => {
  w = await automationWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

describe('SIGTERM stops a run at a step boundary; the next run resumes', () => {
  it('stops between pages, leaves no job part-way, and the next run finishes the rest, each page once', async () => {
    const a0 = w.stack.runtime.automation;
    await a0.setMode('owner', PROJECT, 'retag_correction', 'apply');
    const running = a0.run(PROJECT, 'manual');
    // The restart arrives once the first page is written.
    await vi.waitFor(
      () => {
        const run = a0.store.runs(PROJECT, { limit: 1 })[0]!;
        expect(a0.store.items(run.id).some((i) => i.outcome === 'applied')).toBe(true);
      },
      { timeout: 60_000, interval: 2 },
    );
    const report = await w.stack.restart();
    expect(report.stillRunning).toEqual([]);
    // The old bridge's run finished (stopped) before its database was closed; the new bridge reads its record.
    const { id: runId } = await running;
    const a1 = w.stack.runtime.automation;
    const stopped = a1.store.run(runId)!;
    expect(stopped.state, stopped.summary ?? '').toBe('stopped');
    expect(stopped.stopReason).toMatch(/stopping|draining|is queued/);
    const first = a1.store.items(stopped.id);
    // Every job the run started is finished, or parked whole at a step boundary for the next start: none running.
    for (const i of first.filter((x) => x.jobId)) {
      const job = w.stack.runtime.engine.queries.getJob(PROJECT, i.jobId!)!;
      expect(
        TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'queued',
        `${i.jobId}: ${job.status}`,
      ).toBe(true);
    }
    // The new bridge: a job parked at a step boundary continues by itself; then the next run carries on with the rest.
    for (const i of first.filter((x) => x.jobId))
      await w.stack.runtime.engine.wait(PROJECT, i.jobId!, 20_000).catch(() => undefined);
    await w.snapshot();
    const next = await a1.run(PROJECT, 'manual');
    expect(next.state, next.summary ?? '').toBe('succeeded');
    const applied = [...first, ...a1.store.items(next.id)]
      .filter((i) => i.outcome === 'applied')
      .map((i) => i.pageId);
    expect(new Set(applied).size).toBe(applied.length);
    expect(a1.store.items(next.id).filter((i) => i.outcome === 'applied').length).toBeGreaterThan(0);
    // Nothing is left to do: a third run finds every page corrected.
    await w.snapshot();
    const third = await a1.run(PROJECT, 'manual');
    expect(a1.store.items(third.id).filter((i) => i.outcome === 'applied')).toEqual([]);
    await a1.setMode('owner', PROJECT, 'retag_correction', 'off');
  });
});

describe('memory', () => {
  it('a run logs its start and finish with the memory (R3-65)', async () => {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    await loggedTask(
      { info: (obj, msg) => lines.push({ obj, msg }) },
      'automation:run',
      { project: PROJECT },
      () => w.stack.runtime.automation.run(PROJECT, 'manual'),
    );
    expect(lines.map((l) => l.msg)).toEqual(['task started', 'task finished']);
    expect(lines[1]!.obj).toMatchObject({
      task: 'automation:run',
      memory: { heapUsedMb: expect.any(Number) },
    });
  });

  it('repeated runs return to their baseline', async () => {
    const a = w.stack.runtime.automation;
    // Codes whose findings are read (the appraisal's report, the audits' findings, the retag audit) on every run.
    for (const code of [
      'em_dash_text',
      'blank_paragraphs',
      'heading_links',
      'related_noncurrent',
      'retag_correction',
    ])
      await a.setMode('owner', PROJECT, code, 'apply');
    for (let i = 0; i < 2; i++) await a.run(PROJECT, 'manual');
    const base = await heapMb();
    for (let i = 0; i < 8; i++) await a.run(PROJECT, 'manual');
    const after = await heapMb();
    console.info(
      `[F5b] automation runs: heap ${base.toFixed(1)} MB after 2 runs, ${after.toFixed(1)} MB after 10`,
    );
    expect(after - base).toBeLessThan(8);
  });
});
