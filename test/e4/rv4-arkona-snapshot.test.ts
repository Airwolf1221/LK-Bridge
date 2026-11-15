/**
 * RV4, budgets: the REAL full snapshot (SnapshotService, the engine, the governor, the MCP server) on an Arkona-sized
 * mock: about 1,500 pages under the AI REPOSITORY and about 3,500 resources overall. Minute limits are raised so the
 * run takes seconds on the real clock (the floors' arithmetic at the published limits is rv4-budget-night.test.ts).
 * While it runs, an agent makes MCP calls (P1); each call's time is measured, and the snapshot must give way to them.
 * Then the maintenance floor: the project's hour tier is set so P3 has room for only part of the run; the snapshot stops
 * there (a budget wait), and continues where it stopped once the budget is back. This measures; it passes.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 600_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const BIG = {
  'key-min': 20000,
  'write-min': 2000,
  'key-hour': 600000,
  'project-hour': 600000,
  'key-day': 6000000,
};

async function arkona(limits: Record<string, number> = BIG) {
  const world = await snapshotsWorld({
    bulk: 1440,
    // The governor's limits; the mock itself never refuses (its limits stay raised).
    env: { LK_TIER_LIMITS: JSON.stringify(limits) },
    limits: BIG,
    seed: (x) => {
      // Resources outside the AI REPOSITORY (the rest of Arkona's 3,500): never read by the snapshot.
      for (let i = 0; i < 2000; i++)
        x.repo.seed({ id: `ox${i.toString(36).padStart(6, '0')}`, name: `Outside ${i}`, parentId: null });
    },
  });
  return world;
}

it('Arkona-sized: the full snapshot’s cost, and agents’ MCP calls served while it runs', async () => {
  w = await arkona();
  const c: Client = await w.stack.connect();
  const under = w.repo.subtree('airepo01').length;
  const overall = [...w.repo.res.values()].filter((r) => r.deletedAt === null).length;
  const snaps = w.stack.runtime.snapshots;
  let yields = 0;
  const sleep0 = (snaps.o as { sleep?: (ms: number) => Promise<void> }).sleep;
  (snaps.o as { sleep?: unknown }).sleep = (ms: number) => {
    yields++;
    return sleep0 ? sleep0(ms) : new Promise((r) => setTimeout(r, ms));
  };
  const t0 = Date.now();
  const run = snaps.full(PROJECT, 'manual');
  // The agent: get_resource on pages of the set, one after another, while the snapshot runs.
  const times: number[] = [];
  let snapDone = false;
  void run.finally(() => (snapDone = true));
  const ids = w.repo.subtree('airepo01').map((r) => r.id);
  for (let i = 0; !snapDone && i < 400; i++) {
    const a = Date.now();
    const r = await w.stack.call(c, 'get_resource', {
      project: 'test',
      resource: ids[(i * 37) % ids.length],
    });
    times.push(Date.now() - a);
    expect(r.isError, r.text).toBe(false);
    await new Promise((res) => setTimeout(res, 20));
  }
  const r = await run;
  const ms = Date.now() - t0;
  expect(r.changed, r.summary).toBe(true);
  const m = (await snaps.manifest(r.snapshotId!))!;
  // An unloaded baseline for the same call.
  const base: number[] = [];
  for (let i = 0; i < 30; i++) {
    const a = Date.now();
    await w.stack.call(c, 'get_resource', { project: 'test', resource: ids[(i * 37) % ids.length] });
    base.push(Date.now() - a);
  }
  const q = (xs: number[], p: number) =>
    [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  process.stdout.write(
    [
      `Arkona-sized mock: ${under} pages under the root, ${overall} resources overall`,
      `  full snapshot: ${m.pages.length} pages, ${m.counts.reads} reads (${(m.counts.reads / m.pages.length).toFixed(2)} a page), ${(ms / 1000).toFixed(1)} s on the raised limits; ${yields} waits`,
      `  agent get_resource during it: n=${times.length} median ${q(times, 0.5)} ms, p95 ${q(times, 0.95)} ms, max ${Math.max(...times)} ms; unloaded median ${q(base, 0.5)} ms, max ${Math.max(...base)} ms`,
    ].join('\n') + '\n',
  );
  expect(under).toBeGreaterThanOrEqual(1450);
  expect(overall).toBeGreaterThanOrEqual(3450);
  expect(m.pages.length).toBe(under);
  expect(times.length).toBeGreaterThan(5);
  // (P1 calls are dispatched at once when there is room, so they are never "queued" and the snapshot need not wait.)
  // Served promptly: no agent call waited behind the snapshot for long.
  expect(q(times, 0.95)).toBeLessThan(1000);
});

it('Arkona-sized: the snapshot stops at the maintenance floor and continues where it stopped', async () => {
  // The hour tier (as the governor is configured) leaves P3, half of it, room for part of the run.
  const HOUR = 4000;
  const limits = { ...BIG, 'key-hour': HOUR };
  w = await arkona(limits);
  const snaps = w.stack.runtime.snapshots;
  const gov = w.stack.runtime.projects.client(PROJECT)!.governor;
  const waits: number[] = [];
  let usedAtStop = -1;
  (snaps.o as { sleep?: unknown }).sleep = async (ms: number) => {
    if (ms >= 1000) {
      // A budget wait (the agents' waits are 250 ms): where did it stop? Then let the hour pass, as it would.
      waits.push(ms);
      if (usedAtStop < 0) usedAtStop = gov.snapshot().tiers['key-hour'].used;
      gov.setReserveFloors({ P1: 0, P2: 0, P3: 0 });
    }
    await new Promise((r) => setTimeout(r, 5));
  };
  const r = await snaps.full(PROJECT, 'manual');
  expect(r.changed, r.summary).toBe(true);
  const m = (await snaps.manifest(r.snapshotId!))!;
  process.stdout.write(
    `  floor: ${waits.length} budget wait(s) of ${waits.map((x) => Math.round(x / 1000)).join(', ')} s; key-hour used when it stopped ${usedAtStop} of ${HOUR} (P3 cap ${HOUR / 2}); ${m.counts.reads} reads in all, ${m.pages.length} pages\n`,
  );
  expect(waits.length).toBeGreaterThan(0);
  expect(usedAtStop).toBeLessThanOrEqual(HOUR / 2);
  expect(usedAtStop).toBeGreaterThan(HOUR / 2 - 20);
  expect(m.pages.length).toBe(w.repo.subtree('airepo01').length);
});
