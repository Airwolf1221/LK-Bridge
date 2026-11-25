/**
 * R4.1 (the owner's run of 21 November 2026: consistency-f4b hung for its whole 30-minute timeout with no output, and its
 * probe pages were left on the test world because its clean-up never ran). Proved on the mock LegendKeeper, through the
 * same runtime and harness as the owner's run:
 *
 * - every step prints a line as it starts and as it finishes; a step that NEVER resolves fails at its own timeout, with
 *   an error naming it, and the check goes on to its clean-up (the probe is gone, well inside the test's time);
 * - when the test itself would time out first (a step's timeout longer than the test's), the clean-up the test file runs
 *   in its `afterAll` deletes the probe while the check is still stuck;
 * - the harness itself: each clean-up action once, newest first, each with its own timeout; a failing one named;
 * - all 19 sandbox checks run through it (each test file has the step frame and the `afterAll`; v3 F5a added tagging-f5a, v3 F5b automation-f5b, v3 F5c identity-f5c).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runConsistencyCheck } from '../sandbox/consistency-f4b.js';
import { cleanupAfterAll, sandboxRun, StepTimeoutError, type SandboxRun } from '../sandbox/steps.js';
import { f4bWorld, type F4bWorld } from '../consistency/world.js';
import { makeFaithful } from './faithful.js';
import { sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const probesLeft = (w: F4bWorld) =>
  [...w.repo.res.values()]
    .filter((r) => r.deletedAt === null && /^lk-bridge f4b /.test(r.name))
    .map((r) => r.name);

/** Each step that started has a line saying how it finished (done, failed or timed out). */
function everyStartFinished(run: SandboxRun): string[] {
  const started = run.lines.flatMap((l) => /\] start (\S+):/.exec(l)?.[1] ?? []);
  return started.filter(
    (id) =>
      !run.lines.some((l) =>
        new RegExp(`\\] (done|failed|timed out) ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l),
      ),
  );
}

describe('a sandbox check whose step never resolves (consistency-f4b on the mock, its F3 stalled)', () => {
  let w: F4bWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await f4bWorld());
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('F3 fails at its own timeout, naming it; the later steps do not run; the clean-up runs; every line is printed', async () => {
    const out: string[] = [];
    const run = sandboxRun({
      name: 'consistency-f4b',
      out: (l) => out.push(l),
      stall: ['F3'],
      stepTimeoutMs: 1_500,
    });
    const t0 = Date.now();
    const items = await runConsistencyCheck(on.sb, on.raw, { bridgeDbPath: on.bridgeDbPath, run });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(items.map((i) => `${i.id} ${i.verdict}`)).toEqual(['F1 pass', 'F2 pass', 'F3 fail']);
    expect(items[2]!.detail).toContain('step F3 (a snapshot of the probe’s pages only');
    expect(items[2]!.detail).toContain('did not finish within its timeout of 1.5 s');
    // Printed as it went: each step's start and finish, then the clean-up's.
    expect(out).toEqual(run.lines);
    expect(everyStartFinished(run)).toEqual([]);
    expect(
      run.lines.some((l) => /\] start F3: a snapshot of the probe’s pages only.*\(timeout 1\.5 s\)/.test(l)),
    ).toBe(true);
    expect(run.lines.some((l) => /\] timed out F3 after/.test(l))).toBe(true);
    expect(run.lines.some((l) => /\] start F4/.test(l))).toBe(false);
    expect(run.lines.filter((l) => /clean-up (start|done)/.test(l))).toHaveLength(2);
    expect(probesLeft(w)).toEqual([]);
    // The test file's afterAll finds nothing left to do (each action runs once).
    await cleanupAfterAll(run);
    expect(run.lines.filter((l) => /clean-up start/.test(l))).toHaveLength(1);
  });

  it('when the test would time out first, the afterAll clean-up deletes the probe while the check is still stuck', async () => {
    const run = sandboxRun({
      name: 'consistency-f4b',
      out: () => undefined,
      stall: ['F3'],
      stepTimeoutMs: 3_600_000,
    });
    let settled = false;
    void runConsistencyCheck(on.sb, on.raw, { bridgeDbPath: on.bridgeDbPath, run }).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 600 && !run.lines.some((l) => /\] start F3/.test(l)); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(probesLeft(w).length).toBeGreaterThan(0); // the probe is there, F3 stuck on it
    // What the test file's afterAll does when the test has timed out:
    await cleanupAfterAll(run);
    expect(settled).toBe(false);
    expect(probesLeft(w)).toEqual([]);
    expect(run.lines.some((l) => /clean-up done in .*: the throwaway index deleted/.test(l))).toBe(true);
  });
});

describe('the harness (test/sandbox/steps.ts)', () => {
  it('a step’s result and error pass through; a timeout names the step; lines for each', async () => {
    const run = sandboxRun({ name: 'unit', out: () => undefined, stepTimeoutMs: 50 });
    expect(await run.step('A', 'answers', () => 7)).toBe(7);
    await expect(
      run.step('B', 'throws', () => Promise.reject(new Error('refused\nsecond line'))),
    ).rejects.toThrow('refused');
    const e = await run
      .step('C', 'never answers', () => new Promise(() => undefined))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepTimeoutError);
    expect((e as StepTimeoutError).stepId).toBe('C');
    expect((e as Error).message).toMatch(
      /^step C \(never answers\) did not finish within its timeout of 0\.1 s/,
    );
    // A step's own timeout over the run's default.
    await expect(
      run.step('D', 'slow but allowed', () => new Promise((r) => setTimeout(() => r('late'), 120)), {
        timeoutMs: 1_000,
      }),
    ).resolves.toBe('late');
    expect(run.lines.map((l) => l.replace(/ (in|after) \d+\.\d s/, ' $1 T'))).toEqual([
      '[unit] start A: answers (timeout 0.1 s)',
      '[unit] done A in T',
      '[unit] start B: throws (timeout 0.1 s)',
      '[unit] failed B after T: refused',
      '[unit] start C: never answers (timeout 0.1 s)',
      '[unit] timed out C after T: never answers',
      '[unit] start D: slow but allowed (timeout 1.0 s)',
      '[unit] done D in T',
    ]);
  });

  it('the clean-up: newest first, each once, each with its own timeout; afterAll names what did not finish', async () => {
    const run = sandboxRun({ name: 'unit', out: () => undefined, cleanupTimeoutMs: 50 });
    const did: string[] = [];
    run.defer('first made', () => {
      did.push('first');
    });
    run.defer('stuck', () => new Promise(() => undefined));
    run.defer('refused', () => Promise.reject(new Error('403 WRONG_PROJECT')));
    run.defer('last made', () => {
      did.push('last');
    });
    expect(run.pending).toBe(4);
    const r = await run.cleanup();
    expect(r.map((x) => `${x.label} ${x.outcome}`)).toEqual([
      'last made done',
      'refused failed',
      'stuck timed out',
      'first made done',
    ]);
    expect(did).toEqual(['last', 'first']);
    expect(run.pending).toBe(0);
    await expect(cleanupAfterAll(run)).rejects.toThrow(
      /the clean-up did not finish: refused \(failed: 403 WRONG_PROJECT\); stuck \(timed out: the clean-up “stuck” did not finish within 0\.1 s\)\. Delete what it names by hand\./,
    );
    expect(did).toEqual(['last', 'first']); // not run twice
    expect(run.hookTimeoutMs).toBeGreaterThan(run.cleanupTimeoutMs);
  });
});

describe('all 24 sandbox checks run through the harness', () => {
  const dir = join(import.meta.dirname, '..', 'sandbox');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));

  it('there are 29 (v3 F7c: f7c-archive; v3 F6a: f6a-reftypes; v3 F7d: f7d-art-set; v3 F10: f10-chronology; v3 F6b: f6b-nav), and each has the step frame and an afterAll that runs what is left of the clean-up', () => {
    expect(files).toHaveLength(29);
    for (const f of files) {
      const s = readFileSync(join(dir, f), 'utf8');
      expect(s, f).toMatch(/sandboxRun\(\{ name: '[a-z0-9-]+'/);
      expect(s, f).toMatch(/afterAll\(/);
      expect(s, f).toMatch(/cleanupAfterAll\(steps\)/);
      expect(s, f).toMatch(/steps\.hookTimeoutMs\)/);
      expect(s, f).toMatch(/steps\.step\(/);
    }
  });

  it('each runner routes its steps through the run and its clean-up through `defer`', () => {
    // The 18 runner modules (v3 F5b added automation-f5b) (soak-runtime-readonly.test.ts runs no LegendKeeper check of its own).
    const runners = [
      'assign-block-ids.ts',
      'automation-f5b.ts',
      'assumptions-r2.ts',
      'assumptions-r3.ts',
      'assumptions-r4.ts',
      'assumptions-r5.ts',
      'assumptions.ts',
      'audits.ts',
      'chronology.ts',
      'concurrency.ts',
      'consistency-f4b.ts',
      'images.ts',
      'maps.ts',
      'narrative-f4c.ts',
      'smoke.ts',
      'snapshots.ts',
      'split-ids.ts',
      'tagging-f5a.ts',
      'f7d-art-set.ts', // v3 F7d (ADR 0077)
    ];
    expect(runners.every((f) => files.includes(f.replace(/\.ts$/, '.test.ts')))).toBe(true);
    for (const f of runners) {
      const s = readFileSync(join(dir, f), 'utf8');
      expect(s, f).toMatch(/steps\.step\(/);
      // The read-only chronology check has nothing to clean up.
      if (f !== 'chronology.ts') {
        expect(s, f).toMatch(/steps\.defer\(/);
        expect(s, f).toMatch(/await steps\.cleanup\(\)/);
      }
    }
  });
});
