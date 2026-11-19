/**
 * CR-2026-11-R3, fix A (the owner's clean shutdown). On 18 November a deploy's SIGTERM did not end the bridge within
 * systemd's stop timeout (45 s) while a maintenance job ran, and systemd killed it. These tests stop the REAL bridge
 * exactly as SIGTERM does (`stopBridgeForRestart`, through `Stack.restart`), then start a new bridge on the same
 * database file and the same mock LegendKeeper, and check:
 *
 * - the stop is quick (well under 20 s) and refuses new work with a clear "the bridge is restarting";
 * - a long job is stopped at its next step boundary, never part-way through a write (a request in flight finishes),
 *   recorded as queued for the restart, and continues afterwards with nothing sent twice;
 * - a wait ends at once: a retry's back-off after a 429, and a job parked for budget keeps its time and resumes;
 * - a job waiting for a pack version keeps waiting across the restart and runs once the owner approves the version
 *   (in rename-world.test below: `arkona_rename` of a culture).
 *
 * Every test runs against the mock LegendKeeper; nothing touches a live system.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/open.js';
import type { JobView } from '../../../src/jobs/index.js';
import { LkModel } from '../../jobs/lk-model.js';
import { PROJECT, startStack, type Stack } from '../../tools/helpers.js';

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const PAGES = 12;
const pageId = (i: number) => `rpage${String(i).padStart(3, '0')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(transport?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const model = new LkModel(() => Date.now());
  for (let i = 1; i <= PAGES; i++) model.seedResource(pageId(i), { name: `Page ${i}` });
  return { model, transport };
}

async function renameAll(s: Stack): Promise<string> {
  await s.runtime.ready;
  const r = await s.runtime.engine.submit({
    kind: 'batch_ops',
    project: PROJECT,
    origin: { kind: 'test' },
    priority: 'P2',
    onError: 'stop',
    title: 'a long job: twelve renames',
    steps: Array.from({ length: PAGES }, (_, k) => ({
      op: 'updateResource',
      params: { path: { resourceId: pageId(k + 1) }, body: { name: `Renamed ${k + 1}` } },
    })),
  });
  if (!('jobId' in r)) throw new Error('expected a job');
  return r.jobId;
}

async function settle(s: Stack, jobId: string, ms = 30_000): Promise<JobView> {
  const until = Date.now() + ms;
  for (;;) {
    const j = s.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status) || Date.now() > until) return j;
    await sleep(20);
  }
}

/** The job and its steps as the database holds them between the two bridges (the database is closed then). */
function stored(s: Stack, jobId: string) {
  const db = openDatabase(s.dbPath);
  try {
    const job = db.prepare('SELECT status, wait_reason, current_step FROM jobs WHERE id = ?').get(jobId) as {
      status: string;
      wait_reason: string | null;
      current_step: number | null;
    };
    const steps = db
      .prepare('SELECT step_no, status, maybe_sent FROM steps WHERE job_id = ? ORDER BY step_no')
      .all(jobId) as { step_no: number; status: string; maybe_sent: number }[];
    return {
      job,
      steps,
      waitReason: job.wait_reason ? (JSON.parse(job.wait_reason) as Record<string, unknown>) : null,
    };
  } finally {
    db.close();
  }
}

const patchesOf = (s: Stack, id: string) =>
  s.mock.calls.filter((c) => c.method === 'PATCH' && c.path.replace(/\/$/, '').endsWith(`/resources/${id}`));

/**
 * Test only: time passes between the two bridges. LegendKeeper's 429 has expired (the mock's block, and the counters the
 * stopping bridge saved, which the new one would otherwise honour).
 */
function timePasses(s: Stack): void {
  (s.mock as unknown as { blockedUntil: Map<string, number> }).blockedUntil.clear();
  const db = openDatabase(s.dbPath);
  try {
    db.prepare('DELETE FROM governor_counters').run();
  } finally {
    db.close();
  }
}

describe('CR-2026-11-R3 fix A: a restart (SIGTERM) stops quickly and every job continues afterwards', () => {
  it('a long job mid-run: the write in flight finishes, the job stops at the next step boundary and finishes after the restart, nothing sent twice', async () => {
    let patches = 0;
    let reached: () => void = () => {};
    const inFlight = new Promise<void>((r) => (reached = r));
    const w = world(async (input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && ++patches === 4) {
        reached();
        await sleep(1_500); // the fourth write is in flight when the stop begins
      }
      return fetch(input, init);
    });
    stack = await startStack({ respond: w.model.respond, lkTransport: w.transport });
    const jobId = await renameAll(stack);
    await inFlight;

    const during: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const report = await stack.restart({
      duringStop: async (base) => {
        const mcp = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${stack!.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        during.mcp = { status: mcp.status, body: (await mcp.json()) as Record<string, unknown> };
        const action = await fetch(`${base}/api/admin/writes/pause`, { method: 'POST' });
        during.action = { status: action.status, body: (await action.json()) as Record<string, unknown> };
        const health = await fetch(`${base}/healthz`);
        during.health = { status: health.status, body: (await health.json()) as Record<string, unknown> };
      },
      beforeStart: () => {
        const db = stored(stack!, jobId);
        // Recorded as resumable: queued for the next start, stopped between two steps.
        expect(db.job.status).toBe('queued');
        expect(db.waitReason).toMatchObject({ restart: expect.stringContaining('step boundary') as unknown });
        expect(db.steps.map((x) => x.status)).toEqual([
          ...Array<string>(4).fill('succeeded'),
          ...Array<string>(PAGES - 4).fill('pending'),
        ]);
        expect(db.steps.every((x) => x.maybe_sent === 0)).toBe(true);
      },
    });

    // The measured stop (the owner asked for well under 20 s): it waited only for the write in flight.
    expect(report.ms).toBeLessThan(20_000);
    expect(report.ms).toBeLessThan(5_000);
    expect(report.parked).toContain(jobId);
    expect(report.stillRunning).toEqual([]);
    expect(report.overran).toEqual([]);
    // New work was refused plainly while it stopped.
    expect(during.mcp!.status).toBe(503);
    expect(during.mcp!.body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        data: { code: 'BRIDGE_RESTARTING' },
        message: expect.stringContaining('restarting') as unknown,
      },
    });
    expect(during.action!.status).toBe(503);
    expect(during.action!.body).toMatchObject({ error: { code: 'BRIDGE_RESTARTING' } });
    expect(during.health!.status).toBe(503);
    expect(during.health!.body).toMatchObject({ ok: false, restarting: true });

    // After the restart the job continues by itself and finishes; each page renamed once, no write sent twice.
    const done = await settle(stack, jobId);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    for (let i = 1; i <= PAGES; i++) {
      expect(w.model.resources.get(pageId(i))!.name).toBe(`Renamed ${i}`);
      expect(patchesOf(stack, pageId(i)), pageId(i)).toHaveLength(1);
    }
    console.info(`[R3 fix A] stop with a write in flight: ${report.ms} ms`);
  }, 60_000);

  it("a retry's back-off (a 429 for 3 s) ends at once: the stop does not wait for it, and the job finishes after the restart", async () => {
    const w = world();
    stack = await startStack({ respond: w.model.respond });
    let n = 0;
    stack.mock.inject((c) => c.method === 'PATCH' && ++n === 3, {
      kind: 'rate-limit',
      tier: 'write-min',
      retryAfterS: 3,
    });
    const jobId = await renameAll(stack);
    for (let i = 0; i < 300 && !stack.mock.calls.some((c) => c.outcome === 'injected-429'); i++)
      await sleep(10);
    expect(stack.mock.calls.some((c) => c.outcome === 'injected-429')).toBe(true);
    const report = await stack.restart({
      beforeStart: () => {
        const db = stored(stack!, jobId);
        expect(db.job.status).toBe('queued');
        expect(db.waitReason).toMatchObject({ restart: expect.any(String) as unknown });
        // The refused write is pending again (a 429 applies nothing), not failed.
        expect(db.steps[2]).toMatchObject({ status: 'pending', maybe_sent: 0 });
        expect(db.steps.some((x) => x.status === 'failed' || x.status === 'running')).toBe(false);
        timePasses(stack!);
      },
    });
    expect(report.ms).toBeLessThan(1_500); // the 3-second wait was ended, not sat out
    expect(report.parked).toContain(jobId);
    const done = await settle(stack, jobId);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    for (let i = 1; i <= PAGES; i++) expect(w.model.resources.get(pageId(i))!.name).toBe(`Renamed ${i}`);
    console.info(`[R3 fix A] stop during a retry's back-off: ${report.ms} ms`);
  }, 60_000);

  it('a job parked for budget keeps its time across the restart and resumes by itself when it is due', async () => {
    const w = world();
    stack = await startStack({ respond: w.model.respond });
    let n = 0;
    // A Retry-After longer than the bridge waits in place (30 s): the job is parked `waiting_budget`.
    stack.mock.inject((c) => c.method === 'PATCH' && ++n === 3, {
      kind: 'rate-limit',
      tier: 'write-min',
      retryAfterS: 45,
    });
    const jobId = await renameAll(stack);
    for (let i = 0; i < 500; i++) {
      if (stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status === 'waiting_budget') break;
      await sleep(10);
    }
    const parked = stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(parked.status).toBe('waiting_budget');
    const resumeAt = parked.resumeAt!;
    const report = await stack.restart({
      beforeStart: () => {
        const db = openDatabase(stack!.dbPath);
        try {
          const row = db.prepare('SELECT status, resume_at FROM jobs WHERE id = ?').get(jobId) as {
            status: string;
            resume_at: number;
          };
          // Kept as it was: parked for budget, with its time.
          expect(row).toEqual({ status: 'waiting_budget', resume_at: resumeAt });
          // Time passes (test only): the job is due in a moment, and LegendKeeper's 429 has expired.
          db.prepare('UPDATE jobs SET resume_at = ? WHERE id = ?').run(Date.now() + 500, jobId);
        } finally {
          db.close();
        }
        timePasses(stack!);
      },
    });
    expect(report.ms).toBeLessThan(2_000);
    const done = await settle(stack, jobId);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    for (let i = 1; i <= PAGES; i++) {
      expect(w.model.resources.get(pageId(i))!.name).toBe(`Renamed ${i}`);
      expect(
        patchesOf(stack, pageId(i)).filter((c) => c.outcome === 'ok'),
        pageId(i),
      ).toHaveLength(1);
    }
  }, 60_000);

  it('a lock wait ends at once: a job waiting for a page another job holds is parked, and both finish after the restart', async () => {
    let hold: () => void = () => {};
    let reached: () => void = () => {};
    const inFlight = new Promise<void>((r) => (reached = r));
    let first = true;
    const w = world(async (input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && first) {
        first = false;
        reached();
        await new Promise<void>((r) => (hold = r));
      }
      return fetch(input, init);
    });
    stack = await startStack({ respond: w.model.respond, lkTransport: w.transport });
    await stack.runtime.ready;
    const submit = async (title: string) => {
      const r = await stack!.runtime.engine.submit({
        kind: 'batch_ops',
        project: PROJECT,
        origin: { kind: 'test' },
        priority: 'P2',
        onError: 'stop',
        title,
        steps: [{ op: 'updateResource', params: { path: { resourceId: pageId(1) }, body: { name: title } } }],
      });
      return (r as { jobId: string }).jobId;
    };
    const a = await submit('Held by A');
    await inFlight; // A holds page 1's lock, its write in flight
    const b = await submit('Then B');
    for (let i = 0; i < 300; i++) {
      if (stack.runtime.engine.queries.getJob(PROJECT, b)!.status === 'waiting_lock') break;
      await sleep(10);
    }
    expect(stack.runtime.engine.queries.getJob(PROJECT, b)!.status).toBe('waiting_lock');
    setTimeout(() => hold(), 800);
    const report = await stack.restart({
      beforeStart: () => {
        expect(stored(stack!, a).job.status).toBe('succeeded'); // its write finished
        const sb = stored(stack!, b);
        expect(sb.job.status).toBe('queued');
        expect(sb.steps.map((x) => x.status)).toEqual(['pending']);
      },
    });
    expect(report.ms).toBeLessThan(5_000);
    expect((await settle(stack, b)).status).toBe('succeeded');
    expect(w.model.resources.get(pageId(1))!.name).toBe('Then B');
  }, 60_000);
});

describe('CR-2026-11-R3 fix A: the 18 November case, a maintenance run in flight', () => {
  it('a SIGTERM while the block-id sweep runs (each assignBlockIds slow) ends in seconds; the sweep carries on at its next run', async () => {
    const { blockIdsWorld } = await import('../../blockids/world.js');
    let slow = true;
    let posting: () => void = () => {};
    const inFlight = new Promise<void>((r) => (posting = r));
    const w = await blockIdsWorld({
      lkTransport: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (slow && (init?.method ?? 'GET') === 'POST' && /\/block-ids\/?$/.test(url)) {
          posting();
          await sleep(4_000);
        }
        return fetch(input, init);
      },
    });
    try {
      await w.snapshot();
      const sweep = w.stack.runtime.maintenance.blockIds!;
      sweep.store.recordSandboxCheck({
        bridgeVersion: sweep.prerequisite().version,
        project: 'test',
        verdict: 'PASS',
      });
      const ID = 'assign-block-ids-sweep';
      const { done } = w.stack.runtime.maintenance.commands.runNow('owner', ID, {
        id: PROJECT,
        name: 'test',
      });
      void done.catch(() => undefined);
      // The first document's assignBlockIds is in flight (4 s each; five documents: about 20 s of work at least).
      await inFlight;
      const report = await w.stack.restart();
      console.info(`[R3 fix A] stop with the block-id sweep running: ${report.ms} ms`);
      expect(report.ms).toBeGreaterThan(3_000); // the request in flight was let finish ...
      expect(report.ms).toBeLessThan(10_000); // ... and nothing more: not the rest of the run
      expect(report.stillRunning).toEqual([]);
      // Exactly one assignBlockIds was sent before the stop; nothing was cut part-way (its job ended or is parked).
      const assignsBefore = [...w.assigns.values()].reduce((a, b) => a + b, 0);
      expect(assignsBefore).toBe(1);
      const jobs = w.stack.runtime.engine.queries
        .listJobs(PROJECT, { originKind: 'maintenance', limit: 50 })
        .filter((j) => j.kind === 'batch_ops');
      for (const j of jobs) expect(['succeeded', 'queued', 'running']).toContain(j.status);
      // After the restart the sweep's next run does the rest, each document once.
      slow = false;
      for (const j of jobs) {
        const end = await settle(w.stack, j.id);
        expect(end.status, JSON.stringify(end.lastError)).toBe('succeeded');
      }
      const again = w.stack.runtime.maintenance.commands.runNow('owner', ID, { id: PROJECT, name: 'test' });
      const run = (await again.done)!;
      expect(run.outcome, run.detail ?? '').toBe('succeeded');
      for (const n of w.assigns.values()) expect(n).toBe(1);
    } finally {
      await w.close();
    }
  }, 90_000);
});
