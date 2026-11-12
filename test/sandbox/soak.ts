/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * The sandbox soak (chunk 8, PLAN §10): about 1,000 writes and a matching mix of reads against a REAL LegendKeeper
 * sandbox project, through the real job engine and rate governor (never the raw SDK), to show that the pacing holds and
 * nothing gets a 429. Run it on the server with `deploy/soak-sandbox.sh` (or `npm run soak:sandbox`); see
 * docs/runbook-deploy.md, "Soak test".
 *
 * Safety, as for the smoke script: it refuses to run unless the API key's own project (from `listProjects`) is exactly
 * the sandbox project id given, and everything it creates lives under ONE throwaway root resource that is deleted
 * (cascade) at the end, whatever happens. It uses its own temporary database, never the bridge's.
 *
 * The same code runs as a dry run against the mock LegendKeeper in test/tools/soak-dryrun.test.ts.
 */
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TOOLS_SETTINGS, loadConfig, projectKeyVariable } from '../../src/config/index.js';
import { defaultMaintenanceSettings } from '../../src/config/maintenance.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import {
  TERMINAL_JOB_STATUSES,
  mintClientId,
  type JobEngine,
  type JobView,
  type StepSpec,
} from '../../src/jobs/index.js';
import { defaultTransport, type LkClient, type Transport } from '../../src/lk/index.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { SandboxGuardError } from './smoke.js';

type Obj = Record<string, any>;

/** What the LegendKeeper transport saw: every HTTP response, by status. Filled by {@link countingTransport}. */
export interface HttpCounters {
  requests: number;
  reads: number;
  writes: number;
  networkErrors: number;
  readonly byStatus: Map<number, number>;
  firstWriteAt: number | null;
  lastWriteAt: number | null;
}

export function newCounters(): HttpCounters {
  return {
    requests: 0,
    reads: 0,
    writes: 0,
    networkErrors: 0,
    byStatus: new Map(),
    firstWriteAt: null,
    lastWriteAt: null,
  };
}

/** Wraps the governor's transport and counts what really went over the wire (429s included, retries included). */
export function countingTransport(inner: Transport, c: HttpCounters): Transport {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const write = method !== 'GET' && method !== 'HEAD';
    if (write) c.firstWriteAt ??= Date.now();
    try {
      const res = await inner(input, init);
      c.requests++;
      if (write) {
        c.writes++;
        c.lastWriteAt = Date.now();
      } else c.reads++;
      c.byStatus.set(res.status, (c.byStatus.get(res.status) ?? 0) + 1);
      return res;
    } catch (e) {
      c.networkErrors++;
      throw e;
    }
  };
}

export interface SoakRuntime {
  readonly runtime: Runtime;
  readonly counters: HttpCounters;
  /** The project's LegendKeeper id, as its key proved it (the scripts compare it with the registered one). */
  readonly projectId: string;
  /** The project's governed client. */
  readonly lk: LkClient;
  close(): Promise<void>;
}

/**
 * A bridge runtime of its own for the soak, spike or smoke: a temporary database, one project (the sandbox's name and
 * key, in the multi-project form), writes allowed, the maintenance scheduler off, and the transport counted. Never the
 * bridge's own database. Resolves once the key has been checked; throws `SandboxGuardError` if it was refused.
 */
export async function createSoakRuntime(o: {
  readonly apiKey: string;
  /** The bridge's name for the sandbox project (default `sandbox`). */
  readonly project?: string;
  /** Only to point at a mock LegendKeeper (the dry run). */
  readonly baseUrl?: string;
  readonly writersMax?: number;
  /** Extra environment for the config (the dry run sets the pacing to zero). */
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: Transport;
  /** Where the runtime logs (tests capture it); default stdout. */
  readonly logStream?: Writable;
}): Promise<SoakRuntime> {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-soak-'));
  const db = openDatabase(join(dir, 'soak.db'));
  runMigrations(db);
  const secret = () => randomBytes(32).toString('base64url');
  const name = o.project ?? 'sandbox';
  const config = loadConfig({
    BRIDGE_PUBLIC_URL: 'https://soak.invalid',
    LK_PROJECTS: name,
    [projectKeyVariable(name)]: o.apiKey,
    LK_DEFAULT_PROJECT: name,
    LK_READ_ONLY: 'false',
    LOG_LEVEL: 'warn',
    WRITERS_MAX: String(o.writersMax ?? 2),
    SESSION_SECRET: secret(),
    JWT_SIGNING_KEY: secret(),
    ...(o.baseUrl ? { LK_BASE_URL: o.baseUrl } : {}),
    ...o.env,
  });
  const counters = newCounters();
  const runtime = createRuntime({
    config,
    // The owner's sandbox run of 12 November 2026: DEFAULT_TOOLS_SETTINGS has `images.dataDir: null` ("`images/` next to the
    // database"), which was resolved from the config's default path under the read-only app folder, so all five sandbox
    // files failed at `mkdir upload-tmp`. This runtime's image directory is inside its own temporary directory.
    toolsSettings: {
      ...DEFAULT_TOOLS_SETTINGS,
      images: { ...DEFAULT_TOOLS_SETTINGS.images, dataDir: join(dir, 'images') },
    },
    db,
    version: 'soak',
    lkTransport: countingTransport(o.transport ?? defaultTransport, counters),
    maintenanceSettings: defaultMaintenanceSettings({ enabled: false }),
    // C2d: a temporary database of its own that keeps no secrets; the key is handed over directly (target.ts opened
    // the bridge's store with the env file's master key), and the wrappers keep that master key out of every
    // environment, so its absence here is expected, not worth four warnings.
    secretStore: 'unused',
    ...(o.logStream ? { logStream: o.logStream } : {}),
  });
  const close = async () => {
    await runtime.shutdown(5_000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  await runtime.ready;
  const view = runtime.projects.byConfiguredName(name);
  const lk = view?.id ? runtime.projects.client(view.id) : undefined;
  if (!view?.id || !lk) {
    await close();
    throw new SandboxGuardError(
      `Refusing to run: the key of project "${name}" could not be verified (${view?.reason ?? 'unknown'}).`,
    );
  }
  return { runtime, counters, projectId: view.id, lk, close };
}

export interface SoakTarget {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface SoakOptions {
  /** About how many writes (default 1,000). Each page of the workload is 4 writes, plus the root's create and delete. */
  readonly writes?: number;
  /** Steps per batch job (default 99). */
  readonly batchSize?: number;
  /** Progress lines (the script prints them). */
  readonly log?: (line: string) => void;
}

export interface SoakReport {
  readonly pages: number;
  readonly totalMs: number;
  readonly writePhaseMs: number;
  readonly writesPerMinute: number;
  readonly http: {
    readonly requests: number;
    readonly reads: number;
    readonly writes: number;
    readonly byStatus: Record<string, number>;
    readonly networkErrors: number;
  };
  readonly status429: number;
  readonly retries: number;
  readonly budgetWaits: number;
  readonly jobsWaitingBudget: number;
  readonly steps: { readonly succeeded: number; readonly failed: number; readonly other: number };
  readonly failures: readonly string[];
  readonly peak: { readonly rssMb: number; readonly heapUsedMb: number; readonly externalMb: number };
  readonly cleanup: { readonly ok: boolean; readonly rootId: string | null; readonly detail: string };
  readonly passed: boolean;
}

const MB = 1024 * 1024;

/** Runs the soak. Throws {@link SandboxGuardError} (nothing written) if the key's project is not `expectedProjectId`. */
export async function runSoak(
  t: SoakTarget,
  expectedProjectId: string,
  o: SoakOptions = {},
): Promise<SoakReport> {
  const log = o.log ?? (() => undefined);
  const pages = Math.max(1, Math.round((o.writes ?? 1000) / 4));
  const batchSize = o.batchSize ?? 99;
  const origin = { kind: 'test' as const, client: 'sandbox-soak', tool: 'sandbox-soak' };
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> => {
    const r = await t.engine.run(op, params, { origin, priority: 'P1', project: t.projectId, ...extra });
    if (r.status !== 'succeeded') throw new Error(`${op} did not complete: ${r.status}`);
    return r.result;
  };

  // ---- guard: the key must belong to exactly the sandbox project (nothing is written before this) ----------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${ids.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  // ---- instruments --------------------------------------------------------------------------------------------------
  const started = Date.now();
  const peak = { rss: 0, heap: 0, external: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    peak.rss = Math.max(peak.rss, m.rss);
    peak.heap = Math.max(peak.heap, m.heapUsed);
    peak.external = Math.max(peak.external, m.external + m.arrayBuffers);
  };
  sample();
  const sampler = setInterval(sample, 500);
  sampler.unref();
  let budgetWaits = 0;
  const waitingBudget = new Set<string>();
  const offWait = t.lk.governor.on('budget-wait', () => {
    budgetWaits++;
  });
  const offJob = t.engine.events.on('job', (e) => {
    if (e.job.status === 'waiting_budget') waitingBudget.add(e.job.id);
  });
  const jobIds: string[] = [];
  const failures: string[] = [];

  const submitAll = async (steps: StepSpec[], label: string) => {
    for (let i = 0; i < steps.length; i += batchSize) {
      const r = await t.engine.submit({
        project: t.projectId,
        kind: 'batch_ops',
        steps: steps.slice(i, i + batchSize),
        onError: 'continue',
        origin,
        priority: 'P2',
        title: `soak: ${label} ${i / batchSize + 1}`,
      });
      if (!('jobId' in r)) throw new Error(`soak: ${label} was not queued (${r.status})`);
      jobIds.push(r.jobId);
    }
  };
  const settle = async () => {
    for (const id of jobIds) {
      let job: JobView | undefined;
      for (;;) {
        job = await t.engine.wait(t.projectId, id, 25_000);
        if (TERMINAL_JOB_STATUSES.has(job.status)) break;
        log(`  waiting for ${id}: ${job.status} ${job.progress.stepsDone}/${job.progress.stepsTotal}`);
      }
    }
  };

  let rootId: string | null = null;
  let cleanup = { ok: false, rootId: null as string | null, detail: 'not attempted' };
  try {
    // ---- the throwaway root ---------------------------------------------------------------------------------------
    const root = (await run('createResource', {
      body: { name: `lk-bridge soak ${new Date().toISOString()}` },
    })) as Obj;
    rootId = root.id as string;
    log(`Root ${rootId}. ${pages} pages, about ${pages * 4 + 2} writes.`);

    // ---- 1. create the pages (writes), as batch jobs at P2 ---------------------------------------------------------
    const pageIds = Array.from({ length: pages }, () => mintClientId());
    await submitAll(
      pageIds.map((id, i) => ({
        op: 'createResource',
        params: { body: { id, name: `soak page ${i + 1}`, parentId: rootId } },
      })),
      'create pages',
    );
    await settle();
    log(`Phase 1 done: ${t.counters.writes} write requests so far.`);

    // ---- 2. read each page to find its document (reads, inline at P1) --------------------------------------------
    const docs = new Map<string, string>();
    for (const id of pageIds) {
      try {
        const r = (await run('getResource', { path: { resourceId: id } })) as Obj;
        const doc: unknown = r.documents?.[0]?.id;
        if (typeof doc === 'string') docs.set(id, doc);
        else failures.push(`getResource ${id}: no document`);
      } catch (e) {
        failures.push(`getResource ${id}: ${(e as Error).message}`);
      }
    }
    log(`Phase 2 done: ${docs.size} documents found.`);

    // ---- 3. three writes per page (each versioned write also makes the engine read first) -----------------------
    const steps: StepSpec[] = [];
    let n = 0;
    for (const [resourceId, documentId] of docs) {
      n++;
      steps.push(
        {
          op: 'replaceDocumentBlocks',
          params: {
            path: { resourceId, documentId },
            body: {
              blocks: [
                { kind: 'heading', level: 2, content: [{ text: `Soak page ${n}` }] },
                { kind: 'paragraph', content: [{ text: 'Written by the LK-Bridge soak test.' }] },
              ],
            },
          },
        },
        {
          op: 'insertBlock',
          params: {
            path: { resourceId, documentId },
            body: {
              block: { kind: 'paragraph', content: [{ text: `Inserted ${new Date().toISOString()}` }] },
            },
          },
        },
        { op: 'updateResource', params: { path: { resourceId }, body: { name: `soak page ${n} (edited)` } } },
      );
    }
    await submitAll(steps, 'edit pages');
    await settle();
    log(`Phase 3 done: ${t.counters.writes} write requests so far.`);

    // ---- 4. read every page's blocks back (reads, inline at P1) ---------------------------------------------------
    for (const [resourceId, documentId] of docs) {
      try {
        await run('getDocumentBlocks', { path: { resourceId, documentId } });
      } catch (e) {
        failures.push(`getDocumentBlocks ${documentId}: ${(e as Error).message}`);
      }
    }
    log('Phase 4 done.');
  } catch (e) {
    failures.push(`soak aborted: ${(e as Error).message}`);
  } finally {
    // ---- clean up: the whole throwaway tree goes (cascade, confirmed), whatever happened ------------------------
    if (rootId) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: rootId }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
        cleanup = { ok: true, rootId, detail: 'deleted (cascade)' };
      } catch (e) {
        cleanup = {
          ok: false,
          rootId,
          detail: `${(e as Error).message}. Delete it by hand in LegendKeeper.`,
        };
      }
    }
    clearInterval(sampler);
    sample();
    offWait();
    offJob();
  }

  // ---- results ----------------------------------------------------------------------------------------------------
  let succeeded = 0;
  let failed = 0;
  let other = 0;
  let retries = 0;
  for (const id of jobIds) {
    const job = t.engine.queries.getJob(t.projectId, id);
    for (const s of job?.steps ?? []) {
      retries += Math.max(0, s.attempts - 1);
      if (s.status === 'succeeded') succeeded++;
      else if (s.status === 'failed' || s.status === 'uncertain') {
        failed++;
        if (failures.length < 20)
          failures.push(`${s.opId} (job ${id}, step ${s.stepNo}): ${s.error?.message ?? s.status}`);
      } else other++;
    }
  }
  const c = t.counters;
  const writePhaseMs = c.firstWriteAt !== null && c.lastWriteAt !== null ? c.lastWriteAt - c.firstWriteAt : 0;
  const status429 = c.byStatus.get(429) ?? 0;
  const report: SoakReport = {
    pages,
    totalMs: Date.now() - started,
    writePhaseMs,
    writesPerMinute: writePhaseMs > 0 ? Math.round((c.writes / writePhaseMs) * 60_000 * 10) / 10 : 0,
    http: {
      requests: c.requests,
      reads: c.reads,
      writes: c.writes,
      byStatus: Object.fromEntries([...c.byStatus].sort(([a], [b]) => a - b).map(([k, v]) => [String(k), v])),
      networkErrors: c.networkErrors,
    },
    status429,
    retries,
    budgetWaits,
    jobsWaitingBudget: waitingBudget.size,
    steps: { succeeded, failed, other },
    failures,
    peak: {
      rssMb: Math.round((peak.rss / MB) * 10) / 10,
      heapUsedMb: Math.round((peak.heap / MB) * 10) / 10,
      externalMb: Math.round((peak.external / MB) * 10) / 10,
    },
    cleanup,
    passed: status429 === 0 && failed === 0 && failures.length === 0 && cleanup.ok,
  };
  return report;
}

export function formatSoakReport(r: SoakReport): string {
  const s = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  return [
    '',
    'LK-Bridge sandbox soak report',
    '=============================',
    `Result:              ${r.passed ? 'PASS' : 'FAIL'}`,
    `Pages:               ${r.pages} (4 writes each, plus the root's create and delete)`,
    `Total time:          ${s(r.totalMs)}`,
    `Write phase:         ${s(r.writePhaseMs)} (first to last write request)`,
    `Writes per minute:   ${r.writesPerMinute} (LegendKeeper allows 120; the governor paces to 120, and to 50 while the hour is on course for 3,000)`,
    `HTTP requests:       ${r.http.requests} (${r.http.reads} reads, ${r.http.writes} writes), network errors ${r.http.networkErrors}`,
    `Responses by status: ${Object.entries(r.http.byStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}`,
    `429 responses:       ${r.status429} (target: 0)`,
    `Retries:             ${r.retries} (extra attempts across all job steps)`,
    `Budget waits:        ${r.budgetWaits} (governor), ${r.jobsWaitingBudget} job(s) parked waiting for budget`,
    `Job steps:           ${r.steps.succeeded} succeeded, ${r.steps.failed} failed, ${r.steps.other} other`,
    `Peak memory:         RSS ${r.peak.rssMb} MB, V8 heap ${r.peak.heapUsedMb} MB, buffers ${r.peak.externalMb} MB`,
    `Clean-up:            ${r.cleanup.ok ? 'OK' : 'FAILED'}: root ${r.cleanup.rootId ?? '(none)'}, ${r.cleanup.detail}`,
    ...(r.failures.length > 0 ? ['Failures:', ...r.failures.map((f) => `  - ${f}`)] : []),
    '',
  ].join('\n');
}
