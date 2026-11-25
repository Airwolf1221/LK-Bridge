/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed JSON replies in tests */
/**
 * v3 F9 amendment 1 (ADR 0074): the day floors where the owner sees and sets them, and the waiting reason wherever the
 * bridge shows a class waiting for budget.
 *
 * - a job held by the daily tier: its status names the tier, the row, the floor and when it frees (`bridge_job_status`);
 * - `bridge_budget` lists what holds each waiting class, in words;
 * - the dashboard: `GET /budgets` and `/overview` carry the waits; `/budgets` the day floors' row; the Reserve floors
 *   action for the day (`PUT /budgets/reserve-day-floors`) saves, refuses out of order and resets; the Settings page's
 *   four entries (group "Governor and budgets", applying now) save through it, the order checked at save; a stored value
 *   is applied at the next start.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStoredSettings } from '../../src/admin/index.js';
import { registryEntry } from '../../src/config/registry.js';
import type { Governor } from '../../src/lk/governor/governor.js';
import { budgetBody, jobBody } from '../../src/mcp/tools/bridge.js';
import { PROJECT, startAdminStack, type AdminStack } from '../admin/helpers.js';
import { harness, origin, queue, type Harness } from '../jobs/helpers.js';
import { setup, track } from '../unit/governor-helpers.js';

describe('a job held by the daily tier', () => {
  let h: Harness | undefined;
  afterAll(async () => h?.close());

  it('its status names the tier, the day row, the floor and when it frees', async () => {
    h = await harness();
    // A small day (100) so the job meets its day floor (5%: 95 requests) quickly; the mock's own day is the published one.
    const e = h.newEngine({
      governor: { tierLimits: { 'key-day': 100 } as never, maxQueueWaitMs: 30_000 },
    });
    const { jobId } = await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: Array.from({ length: 120 }, (_, i) => ({
        op: 'createResource',
        params: { body: { name: `R${i}` } },
      })),
    });
    await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.status === 'waiting_budget');
    const job = e.engine.queries.getJob(PROJECT, jobId)!;
    expect(job.waitReason).toMatchObject({
      tier: 'key-day',
      opId: 'createResource',
      cause: 'tier',
      row: 'day',
      floor: 0.05,
    });
    // The day's first units leave it 24 hours after they were spent (a few seconds of the fake clock ago).
    expect(job.waitReason!.text).toMatch(
      /^jobs waiting: the daily tier is at 95\.0% and jobs may use it up to 95% \(frees in (24 h|23 h 59 min)\)$/,
    );
    // bridge_job_status shows it as it is stored.
    expect(jobBody(job, 'summary').waitReason).toMatchObject({ row: 'day', text: job.waitReason!.text });
  });
});

describe('bridge_budget', () => {
  it('lists what holds each waiting class: the tier, its floor, when it frees, in words', async () => {
    const env = setup({ dayReserveFloors: { P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.7 } });
    // The live case: the day at 18,009 of 60,000 before the amendment.
    env.setResponder(
      () =>
        new Response('{}', {
          status: 200,
          headers: {
            'x-ratelimit-limit': '60000',
            'x-ratelimit-remaining': String(60_000 - 18_009),
            'x-ratelimit-reset': String(Math.ceil((env.clock.now() + 1_195_000) / 1000)),
          },
        }),
    );
    await env.call({ priority: 'P0' });
    const held = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    const body = budgetBody(env.governor.snapshot());
    expect(body.waiting).toEqual([
      {
        class: 'P4',
        queued: 1,
        cause: 'tier',
        tier: 'key-day',
        row: 'day',
        floor: 0.7,
        freesInSeconds: 1195,
        text: 'bulk waiting: the daily tier is at 30.0% and bulk may use it up to 30% (frees in 20 min)',
      },
    ]);
    expect(body.note).toMatch(/daily tier has small floors of its own/);
    await env.clock.advance(1_200_000);
    expect(held.done).toBe(true);
    // Nothing waits: no `waiting` key.
    expect(budgetBody(env.governor.snapshot())).not.toHaveProperty('waiting');
  });
});

describe('the dashboard', () => {
  let s: AdminStack;
  beforeAll(async () => {
    s = await startAdminStack();
    await s.runtime.ready;
  });
  afterAll(async () => s?.close());
  const gov = (): Governor => s.runtime.projects.client(PROJECT)!.governor;
  const read = (priority: 'P0' | 'P4') =>
    s.runtime.engine.internalRead(PROJECT, 'listProjects', {}, { priority });

  it('GET /budgets and /overview name the tier and floor holding a class, and when it frees', async () => {
    for (let i = 0; i < 10; i++) await read('P0');
    // Bulk's day floor raised so far that it is already reached (the order needs the others as high).
    gov().setDayReserveFloors({ P1: 0.9999, P2: 0.9999, P3: 0.9999, P4: 0.9999 });
    const held = read('P4');
    try {
      const b = (await s.get('/api/admin/budgets')).json;
      const w = b.snapshot.waits.find((x: any) => x.priority === 'P4');
      expect(w).toMatchObject({ cause: 'tier', tier: 'key-day', row: 'day', floor: 0.9999 });
      expect(w.text).toMatch(
        /^bulk waiting: the daily tier is at 0\.0% and bulk may use it up to 0% \(frees in 2\d h/,
      );
      const o = (await s.get('/api/admin/overview')).json;
      expect(o.budget.waits.map((x: any) => x.text)).toContain(w.text);
    } finally {
      gov().setDayReserveFloors({ P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 });
    }
    await held;
    expect((await s.get('/api/admin/budgets')).json.snapshot.waits).toEqual([]);
  });

  it('shows the day floors as a second row, and saves, refuses and resets them (PUT /budgets/reserve-day-floors)', async () => {
    const before = (await s.get('/api/admin/budgets')).json;
    expect(before.dayReserveFloors).toEqual({
      current: { interactive: 0.02, job: 0.05, maintenance: 0.1, bulk: 0.15 },
      environment: { interactive: 0.02, job: 0.05, maintenance: 0.1, bulk: 0.15 },
      stored: null,
    });
    // The minute and hour row is unchanged beside it.
    expect(before.reserveFloors.current).toEqual({
      interactive: 0.1,
      job: 0.25,
      maintenance: 0.5,
      bulk: 0.7,
    });
    const ok = await s.put('/api/admin/budgets/reserve-day-floors', {
      interactive: 0.03,
      job: 0.06,
      maintenance: 0.12,
      bulk: 0.2,
      confirm: true,
    });
    expect(ok.status, ok.text).toBe(200);
    expect(gov().settings.dayReserveFloors).toEqual({ P0: 0, P1: 0.03, P2: 0.06, P3: 0.12, P4: 0.2 });
    expect(gov().settings.reserveFloors.P4).toBe(0.7);
    expect((await s.get('/api/admin/budgets')).json.dayReserveFloors.stored).toEqual({
      interactive: 0.03,
      job: 0.06,
      maintenance: 0.12,
      bulk: 0.2,
    });
    expect(s.audit('budget.set_day_reserve_floors').length).toBeGreaterThan(0);
    // A start applies the stored value.
    expect(applyStoredSettings(s.runtime.envConfig, s.db).governor.dayReserveFloors).toEqual({
      interactive: 0.03,
      job: 0.06,
      maintenance: 0.12,
      bulk: 0.2,
    });
    // Out of order: refused with the pair named, nothing changed.
    const bad = await s.put('/api/admin/budgets/reserve-day-floors', {
      interactive: 0.02,
      job: 0.05,
      maintenance: 0.2,
      bulk: 0.15,
      confirm: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/day floor for bulk \(15%\) is below the day floor for maintenance \(20%\)/);
    expect(gov().settings.dayReserveFloors.P4).toBe(0.2);
    const r = await s.put('/api/admin/budgets/reserve-day-floors', { reset: true, confirm: true });
    expect(r.status, r.text).toBe(200);
    expect(gov().settings.dayReserveFloors).toEqual({ P0: 0, P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 });
    expect((await s.get('/api/admin/budgets')).json.dayReserveFloors.stored).toBeNull();
  });

  it('the Settings page: four entries in "Governor and budgets", applying now, the order checked at save', async () => {
    const view = (await s.get('/api/admin/settings/config')).json;
    const keys = [
      'RESERVE_DAY_FLOOR_INTERACTIVE',
      'RESERVE_DAY_FLOOR_JOB',
      'RESERVE_DAY_FLOOR_MAINTENANCE',
      'RESERVE_DAY_FLOOR_BULK',
    ];
    const defaults = [0.02, 0.05, 0.1, 0.15];
    keys.forEach((k, i) => {
      const e = view.entries.find((x: any) => x.key === k);
      expect(e, k).toMatchObject({
        group: 'governor',
        applies: 'now',
        editable: true,
        secret: false,
        value: defaults[i],
        source: 'default',
        unit: { display: '%' },
      });
      expect(registryEntry(k)?.legacy).toBe('dayReserveFloors');
      expect(e.description).toMatch(/day/);
    });
    const put = (k: string, body: Record<string, unknown>) =>
      s.put(`/api/admin/settings/config/${k}`, { ...body, confirm: true });
    const set = await put('RESERVE_DAY_FLOOR_BULK', { amount: 25, unit: '%' });
    expect(set.status, set.text).toBe(200);
    expect(gov().settings.dayReserveFloors.P4).toBe(0.25);
    expect(set.json.entry).toMatchObject({ value: 0.25, source: 'dashboard', running: 0.25 });
    // Saved together under their own key.
    expect(
      JSON.parse(
        (
          s.db.prepare("SELECT value FROM runtime_settings WHERE key = 'dash.reserve_day_floors'").get() as {
            value: string;
          }
        ).value,
      ),
    ).toEqual({ interactive: 0.02, job: 0.05, maintenance: 0.1, bulk: 0.25 });
    // The order, at save: maintenance above bulk is refused.
    const bad = await put('RESERVE_DAY_FLOOR_MAINTENANCE', { amount: 30, unit: '%' });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/day floor for bulk \(25%\) is below the day floor for maintenance \(30%\)/);
    expect(gov().settings.dayReserveFloors.P3).toBe(0.1);
    // Reset: back to the environment's (the default), and the stored value goes once all four are as the environment's.
    const r = await s.post('/api/admin/settings/config/RESERVE_DAY_FLOOR_BULK/reset', { confirm: true });
    expect(r.status, r.text).toBe(200);
    expect(gov().settings.dayReserveFloors.P4).toBe(0.15);
    expect(
      s.db.prepare("SELECT value FROM runtime_settings WHERE key = 'dash.reserve_day_floors'").get(),
    ).toBeUndefined();
  });
});
