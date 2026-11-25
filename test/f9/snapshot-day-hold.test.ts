/**
 * v3 F9 amendment 1 (ADR 0074): a full snapshot held by the daily tier's floor, on the mock LegendKeeper.
 *
 * Mid-run, the bulk day floor is raised past what the day has spent (as RESERVE_FLOOR_BULK's 70% did on a busy day):
 * the run's next read waits in the governor (bulk is patient), the Snapshots card says why and since when, one warning is
 * logged, and once the tier frees (the floor back to its default) the run goes on from the page it reached and finishes
 * complete, having read each page once: the same requests as a run that was never held.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';
import { PROJECT } from '../tools/helpers.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

it('waits for the daily tier, says so on the card, warns once, and goes on from where it was', async () => {
  w = await snapshotsWorld();
  const rt = w.stack.runtime;
  const gov = rt.projects.client(PROJECT)!.governor;
  const reads = () => w!.stack.mock.calls.filter((c) => c.method === 'GET').length;

  // A run that is never held, for the count of requests a full snapshot makes.
  let before = reads();
  const plain = await rt.snapshots.full(PROJECT, 'manual');
  expect(plain.changed, plain.summary).toBe(true);
  const plainReads = reads() - before;
  expect(plainReads).toBeGreaterThan(20);

  const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
  const o = rt.snapshots.o as {
    log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined;
    afterPage?: unknown;
  };
  const realLog = o.log;
  o.log = {
    ...realLog,
    warn: (obj: Record<string, unknown>, msg: string) => {
      warnings.push({ obj, msg });
      realLog?.warn(obj, msg);
    },
  };
  let pages = 0;
  let card: Record<string, unknown> | null = null;
  const seenHeld = new Promise<void>((resolve) => {
    o.afterPage = () => {
      pages++;
      if (pages !== 2) return;
      // The day floor for bulk (and, by the order, the others) raised past what the day has spent: held.
      gov.setDayReserveFloors({ P1: 0.9999, P2: 0.9999, P3: 0.9999, P4: 0.9999 });
      const look = async () => {
        for (let i = 0; i < 200 && gov.waitOf('P4')?.row !== 'day'; i++)
          await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 200));
        card = await rt.snapshots.overview(PROJECT);
        // The tier frees.
        gov.setDayReserveFloors({ P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 });
        resolve();
      };
      void look();
    };
  });
  before = reads();
  const pagesBefore = pages;
  const held = await rt.snapshots.full(PROJECT, 'manual');
  await seenHeld;
  o.afterPage = undefined;
  o.log = realLog;

  // It finished, complete, with the same requests as the run that was never held: nothing read twice.
  expect(held.changed, held.summary).toBe(true);
  const m = (await rt.snapshots.manifest(held.snapshotId!))!;
  expect(m.complete).toBe(true);
  expect(m.pages.length).toBe(w.repo.subtree('airepo01').length);
  expect(reads() - before).toBe(plainReads);
  expect(pages - pagesBefore).toBe(m.pages.length);

  // While held: the card named the daily tier, its floor and when it frees, and since when.
  expect(card).not.toBeNull();
  const c = card as unknown as {
    bulkWait: string | null;
    dayHold: { runId: string; holding: boolean; text: string; sinceMs: number } | null;
  };
  expect(c.bulkWait).toMatch(
    /^bulk waiting: the daily tier is at [\d.]+% and bulk may use it up to 0% \(frees in /,
  );
  expect(c.dayHold).toMatchObject({ runId: held.runId, holding: true });
  expect(c.dayHold!.text).toMatch(/the daily tier/);
  // After: the hold is over, and kept for the card as the last run's.
  expect(rt.snapshots.dayHold(PROJECT)).toMatchObject({ runId: held.runId, holding: false });
  expect(rt.snapshots.dayHold(PROJECT)!.endedAtMs).not.toBeNull();
  expect((await rt.snapshots.overview(PROJECT)).bulkWait).toBeNull();

  // One warning for the run, naming the tier and the floor.
  const dayWarnings = warnings.filter((x) => /held by the daily tier/.test(x.msg));
  expect(dayWarnings).toHaveLength(1);
  expect(dayWarnings[0]!.obj).toMatchObject({ runId: held.runId, tier: 'key-day', floor: 0.9999 });
  expect(dayWarnings[0]!.msg).toMatch(/bulk waiting: the daily tier is at/);
});

it('logs once a run however often the hold comes and goes (the day is a rolling window)', async () => {
  w = await snapshotsWorld();
  const rt = w.stack.runtime;
  const warnings: string[] = [];
  const o = rt.snapshots.o as {
    log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined;
  };
  const realLog = o.log;
  o.log = { ...realLog, warn: (_obj, msg) => warnings.push(msg) };
  const wait = (row: 'day' | 'minute-hour') => ({
    priority: 'P4' as const,
    queued: 1,
    cause: 'tier' as const,
    tier: row === 'day' ? ('key-day' as const) : ('key-hour' as const),
    row,
    floor: row === 'day' ? 0.15 : 0.7,
    used: row === 'day' ? 51_000 : 1_800,
    limit: row === 'day' ? 60_000 : 6_000,
    freesAtMs: Date.now() + 60_000,
    text:
      row === 'day'
        ? 'bulk waiting: the daily tier is at 85.0% …'
        : 'bulk waiting: the hourly tier is at 30.0% …',
  });
  for (let i = 0; i < 5; i++) {
    rt.snapshots.noteBulkWait(PROJECT, 'run-a', wait('day'));
    expect(rt.snapshots.dayHold(PROJECT)).toMatchObject({ holding: true });
    rt.snapshots.noteBulkWait(PROJECT, 'run-a', null);
    expect(rt.snapshots.dayHold(PROJECT)).toMatchObject({ holding: false });
  }
  // An hourly wait is no day hold.
  rt.snapshots.noteBulkWait(PROJECT, 'run-a', wait('minute-hour'));
  expect(rt.snapshots.dayHold(PROJECT)).toMatchObject({ holding: false, runId: 'run-a' });
  expect(warnings.filter((m) => /daily tier/.test(m))).toHaveLength(1);
  // The next run warns again (once).
  rt.snapshots.noteBulkWait(PROJECT, 'run-b', wait('day'));
  rt.snapshots.noteBulkWait(PROJECT, 'run-b', wait('day'));
  expect(warnings.filter((m) => /daily tier/.test(m))).toHaveLength(2);
  o.log = realLog;
});
