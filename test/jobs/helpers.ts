/**
 * Harness for the job-engine tests: SQLite in a temp file, chunk 1's FakeClock and mock LK (with the stateful
 * `LkModel` plugged in), and a transport per engine instance that tests can gate (hold requests) or kill (simulate
 * the process dying right after LK committed a write).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultJobsSettings, type JobsSettings } from '../../src/config/jobs.js';
import { defaultGovernorSettings, type GovernorSettings } from '../../src/config/lk.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import {
  createJobEngine,
  type CreateJobEngineOptions,
  type JobEngine,
  type SubmitRequest,
  type SubmitResult,
} from '../../src/jobs/index.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { FakeClock, flushMicrotasks } from '../../src/lk/governor/clock.js';
import { MockLk, type SeenCall } from '../contract/mock-lk.js';
import { LkModel } from './lk-model.js';

export const API_KEY = 'mock-key-not-real';
export const PROJECT = 'proj_mock';

const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Wire {
  readonly method: string;
  readonly url: string;
}

export interface EngineHandle {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly db: Db;
  /** Requests this instance sent (reached or not). */
  readonly sent: Wire[];
  /** Holds every request matching `match` until the returned function is called. */
  hold(match: (w: Wire) => boolean): () => void;
  /** After the next request matching `match` has been answered by LK, this "process" dies: nothing more leaves it. */
  killAfter(match: (w: Wire) => boolean): Promise<void>;
  readonly killed: () => boolean;
  /** Abandons the instance like a crashed process: no clean shutdown; its database handle is closed. */
  crash(): void;
}

export interface Harness {
  readonly clock: FakeClock;
  readonly mock: MockLk;
  readonly model: LkModel;
  readonly dbPath: string;
  readonly engines: EngineHandle[];
  newEngine(o?: {
    settings?: Partial<JobsSettings>;
    governor?: Partial<GovernorSettings>;
    policyGate?: CreateJobEngineOptions['policyGate'];
    proposalSink?: CreateJobEngineOptions['proposalSink'];
  }): EngineHandle;
  /** Moves fake time only when no request of `h` is in flight (zero-latency network), until `done()`. */
  drive(h: EngineHandle, done: () => boolean, maxVirtualMs?: number): Promise<void>;
  /** Waits in real time (fake time frozen) until `done()`. */
  until(done: () => boolean, realMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const clock = new FakeClock();
  const model = new LkModel(() => clock.now());
  const mock = new MockLk({ clock, apiKey: API_KEY, respond: model.respond });
  const baseUrl = await mock.start();
  const dir = mkdtempSync(join(tmpdir(), 'lkb-jobs-'));
  const dbPath = join(dir, 'bridge.db');
  const engines: EngineHandle[] = [];

  const newEngine: Harness['newEngine'] = (o = {}) => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    const sent: Wire[] = [];
    const holds: { match: (w: Wire) => boolean; gate: Promise<void> }[] = [];
    let killed = false;
    let killMatch: ((w: Wire) => boolean) | null = null;
    let onKilled: () => void = () => {};
    const never = () => new Promise<never>(() => {});
    const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const w: Wire = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: input instanceof Request ? input.url : input.toString(),
      };
      if (killed) return never();
      sent.push(w);
      for (const h of holds) if (h.match(w)) await h.gate;
      if (killed) return never();
      const response = await fetch(input, init);
      if (killMatch?.(w)) {
        killed = true;
        killMatch = null;
        await response.arrayBuffer().catch(() => undefined);
        onKilled();
        return never();
      }
      return response;
    };
    const lk = createLkClient({
      apiKey: API_KEY,
      projectId: PROJECT,
      baseUrl,
      clock,
      random: () => 0.5,
      transport,
      governor: defaultGovernorSettings({ requestTimeoutMs: 10_000, ...o.governor }),
    });
    const engine = createJobEngine({
      db,
      lk,
      clock,
      settings: defaultJobsSettings({ readOnly: false, ...o.settings }),
      ...(o.policyGate ? { policyGate: o.policyGate } : {}),
      ...(o.proposalSink ? { proposalSink: o.proposalSink } : {}),
    });
    const handle: EngineHandle = {
      engine,
      lk,
      db,
      sent,
      hold(match) {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => (release = r));
        const h = { match, gate };
        holds.push(h);
        return () => {
          holds.splice(holds.indexOf(h), 1);
          release();
        };
      },
      killAfter(match) {
        killMatch = match;
        return new Promise<void>((r) => (onKilled = r));
      },
      killed: () => killed,
      crash() {
        killed = true;
        try {
          db.close();
        } catch {
          // already closed
        }
      },
    };
    engines.push(handle);
    return handle;
  };

  const until: Harness['until'] = async (done, realMs = 3000) => {
    const start = performance.now();
    while (!done()) {
      if (performance.now() - start > realMs) throw new Error('until: condition not met in time');
      await realDelay(2);
      await flushMicrotasks();
    }
  };

  const drive: Harness['drive'] = async (h, done, maxVirtualMs = 24 * 3600_000) => {
    const limit = clock.now() + maxVirtualMs;
    let idle = 0;
    for (;;) {
      if (done()) return;
      // Let real I/O settle: nothing of this instance in flight for a few turns.
      const start = performance.now();
      let quiet = 0;
      while (quiet < 3 && performance.now() - start < 2000) {
        await flushMicrotasks();
        if (done()) return;
        if (h.lk.governor.snapshot().inFlight === 0) quiet++;
        else {
          quiet = 0;
          await realDelay(1);
        }
      }
      if (done()) return;
      const next = clock.nextTimerAt();
      if (next === undefined) {
        if (++idle > 300) throw new Error('drive: nothing scheduled and work not done');
        await realDelay(3);
        continue;
      }
      idle = 0;
      if (next > limit) throw new Error('drive: virtual time limit reached');
      await clock.runNext();
    }
  };

  return {
    clock,
    mock,
    model,
    dbPath,
    engines,
    newEngine,
    drive,
    until,
    async close() {
      for (const e of engines) {
        if (!e.killed()) {
          await Promise.race([e.engine.stop(), realDelay(200)]);
        }
        e.lk.governor.close();
        try {
          e.db.close();
        } catch {
          // closed by crash()
        }
      }
      await mock.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Requests the mock saw for a method and path pattern. */
export function seen(mock: MockLk, method: string, path: RegExp): SeenCall[] {
  return mock.calls.filter((c) => c.method === method && path.test(c.path.replace(/\/$/, '')));
}

export const origin = { kind: 'test' as const, client: 'vitest' };

/** Settles a promise while driving the clock. */
export async function settle<T>(
  h: Harness,
  e: EngineHandle,
  p: Promise<T>,
): Promise<{ value?: T; error?: unknown }> {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  await h.drive(e, () => state.done);
  return state;
}

/** `engine.submit` for tests that expect a job (not a proposal). */
export async function queue(engine: JobEngine, req: SubmitRequest): Promise<SubmitResult> {
  const r = await engine.submit(req);
  if (!('jobId' in r)) throw new Error(`expected a job, got ${r.status}`);
  return r;
}
