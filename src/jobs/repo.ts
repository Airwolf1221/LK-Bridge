/**
 * SQLite repository for the job engine (migration 0200_jobs_init.sql). Synchronous (better-sqlite3), so every
 * state change is durable before the engine acts on it — in particular, client ids and the "running" marker are
 * on disk before a request is sent.
 *
 * The read-only query functions at the bottom (`createJobQueries`) are what chunk 5's admin API uses.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { BudgetSnapshot } from '../lk/governor/types.js';
import type { ErrorClassification } from '../lk/errors.js';
import { idempotencyKeyFor } from '../lk/idempotency.js';
import { newArtifactId } from './ids.js';
import type {
  ArtifactView,
  JobError,
  JobFilter,
  JobKind,
  JobOrigin,
  JobStatus,
  JobView,
  JobWithSteps,
  OnError,
  OpParams,
  PriorityClass,
  StepOptions,
  StepStatus,
  StepView,
} from './types.js';
import type { OperationKind } from '../lk/registry-types.js';

// ------------------------------------------------------------------------------------------------ helpers

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function json(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const PRIORITY_ORDER = "CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END";

// ------------------------------------------------------------------------------------------------ rows

interface JobRow {
  id: string;
  kind: JobKind;
  title: string;
  origin: string;
  origin_kind: string;
  priority: PriorityClass;
  status: JobStatus;
  on_error: OnError;
  steps_total: number;
  steps_done: number;
  steps_failed: number;
  current_step: number | null;
  resume_at: number | null;
  wait_reason: string | null;
  pause_requested: number;
  cancel_requested: number;
  uncertain: number;
  last_error: string | null;
  result: string | null;
  options: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface StepRow {
  job_id: string;
  step_no: number;
  op_id: string;
  op_kind: OperationKind;
  params: string | null;
  params_artifact_id: string | null;
  params_hash: string;
  options: string | null;
  attempt0: number;
  idempotency_key: string | null;
  client_ids: string | null;
  if_match: string | null;
  status: StepStatus;
  attempts: number;
  maybe_sent: number;
  request_ids: string;
  result_summary: string | null;
  result_artifact_id: string | null;
  error: string | null;
  first_sent_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

interface ArtifactRow {
  id: string;
  job_id: string;
  step_no: number | null;
  kind: ArtifactView['kind'];
  data: string | null;
  item_count: number;
  bytes: number;
  truncated: number;
  truncated_reason: string | null;
  created_at: number;
  updated_at: number;
}

function toJob(r: JobRow): JobView {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    origin: parse<JobOrigin>(r.origin, { kind: 'system' }),
    priority: r.priority,
    status: r.status,
    onError: r.on_error,
    progress: { stepsDone: r.steps_done, stepsTotal: r.steps_total, stepsFailed: r.steps_failed },
    currentStep: r.current_step,
    resumeAt: r.resume_at,
    waitReason: parse<Record<string, unknown> | null>(r.wait_reason, null),
    pauseRequested: r.pause_requested === 1,
    cancelRequested: r.cancel_requested === 1,
    uncertain: r.uncertain === 1,
    lastError: parse<JobError | null>(r.last_error, null),
    result: parse<Record<string, unknown> | null>(r.result, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toStep(r: StepRow): StepView {
  return {
    jobId: r.job_id,
    stepNo: r.step_no,
    opId: r.op_id,
    opKind: r.op_kind,
    params: parse<OpParams | null>(r.params, null),
    paramsArtifactId: r.params_artifact_id,
    paramsHash: r.params_hash,
    options: parse<StepOptions>(r.options, {}),
    attempt0: r.attempt0,
    idempotencyKey: r.idempotency_key,
    clientIds: parse<string[]>(r.client_ids, []),
    ifMatch: r.if_match,
    status: r.status,
    attempts: r.attempts,
    maybeSent: r.maybe_sent === 1,
    requestIds: parse<string[]>(r.request_ids, []),
    resultSummary: parse<unknown>(r.result_summary, null),
    resultArtifactId: r.result_artifact_id,
    error: parse<JobError | null>(r.error, null),
    firstSentAt: r.first_sent_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toArtifact(r: ArtifactRow): ArtifactView {
  return {
    id: r.id,
    jobId: r.job_id,
    stepNo: r.step_no,
    kind: r.kind,
    itemCount: r.item_count,
    bytes: r.bytes,
    truncated: r.truncated === 1,
    truncatedReason: r.truncated_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ------------------------------------------------------------------------------------------------ inputs

export interface NewStep {
  readonly opId: string;
  readonly opKind: OperationKind;
  readonly params: OpParams;
  readonly options: StepOptions;
  readonly clientIds: readonly string[];
  /** POST operations get the deterministic key `lkb.{jobId}.{stepNo}.{attempt0}` (PLAN §5.3). */
  readonly post: boolean;
}

export interface NewJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly origin: JobOrigin;
  readonly priority: PriorityClass;
  readonly status: JobStatus;
  readonly onError: OnError;
  readonly options?: Record<string, unknown>;
  readonly steps: readonly NewStep[];
}

export interface JobPatch {
  status?: JobStatus;
  stepsTotal?: number;
  stepsDone?: number;
  stepsFailed?: number;
  currentStep?: number | null;
  resumeAt?: number | null;
  waitReason?: Record<string, unknown> | null;
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  uncertain?: boolean;
  lastError?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface StepPatch {
  status?: StepStatus;
  attempts?: number;
  attempt0?: number;
  idempotencyKey?: string | null;
  ifMatch?: string | null;
  maybeSent?: boolean;
  requestIds?: readonly string[];
  resultSummary?: unknown;
  resultArtifactId?: string | null;
  error?: Record<string, unknown> | null;
  firstSentAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface ErrorInput {
  readonly opId: string;
  readonly jobId?: string | undefined;
  readonly stepNo?: number | undefined;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly message: string;
  readonly issues?: readonly { path: string; message: string }[] | undefined;
  readonly requestId?: string | undefined;
  readonly retryable: boolean;
  readonly classification: ErrorClassification;
  readonly detail?: Record<string, unknown> | undefined;
}

export interface ErrorRecordView {
  readonly id: number;
  readonly at: number;
  readonly opId: string;
  readonly jobId: string | null;
  readonly stepNo: number | null;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly { path: string; message: string }[];
  readonly path: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly classification: string;
  readonly fingerprint: string;
  readonly detail: Record<string, unknown> | null;
  readonly resolvedAt: number | null;
}

export interface ErrorGroupView {
  readonly fingerprint: string;
  readonly opId: string;
  readonly code: string | null;
  readonly path: string;
  readonly classification: string;
  readonly count: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** True when every occurrence has been marked resolved (a new one reopens the group). */
  readonly resolved: boolean;
  readonly lastMessage: string;
  readonly lastRequestId: string | null;
  readonly lastJobId: string | null;
}

interface ErrorRow {
  id: number;
  at: number;
  op_id: string;
  job_id: string | null;
  step_no: number | null;
  http_status: number | null;
  code: string | null;
  message: string;
  issues: string;
  path: string;
  request_id: string | null;
  retryable: number;
  classification: string;
  fingerprint: string;
  detail: string | null;
  resolved_at: number | null;
}

function toError(r: ErrorRow): ErrorRecordView {
  return {
    id: r.id,
    at: r.at,
    opId: r.op_id,
    jobId: r.job_id,
    stepNo: r.step_no,
    status: r.http_status,
    code: r.code,
    message: r.message,
    issues: parse(r.issues, []),
    path: r.path,
    requestId: r.request_id,
    retryable: r.retryable === 1,
    classification: r.classification,
    fingerprint: r.fingerprint,
    detail: parse(r.detail, null),
    resolvedAt: r.resolved_at,
  };
}

/** op + code + first error path (PLAN §6.3). */
export function errorFingerprint(opId: string, code: string | undefined, path: string): string {
  return `${opId}|${code ?? '-'}|${path}`;
}

export interface BudgetSampleView {
  readonly at: number;
  readonly tiers: Record<
    string,
    { used: number; limit: number | null; remaining: number | null; blocked: boolean; drift: number | null }
  >;
  readonly queues: Record<string, number>;
  readonly inFlight: number;
}

// ------------------------------------------------------------------------------------------------ repository

export class JobsRepo {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
    private readonly largeParamsBytes: number,
  ) {}

  // -------------------------------------------------------------------------------- jobs

  insertJob(job: NewJob): JobView {
    const at = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO jobs (id, kind, title, origin, origin_kind, priority, status, on_error, steps_total,
             options, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.kind,
          job.title,
          JSON.stringify(job.origin),
          job.origin.kind,
          job.priority,
          job.status,
          job.onError,
          job.steps.length,
          json(job.options),
          at,
          at,
        );
      job.steps.forEach((s, i) => this.insertStepRow(job.id, i + 1, s, at));
    })();
    return this.job(job.id)!;
  }

  /** Adds one step at the end (paginate_all grows its job page by page). */
  appendStep(jobId: string, step: NewStep): number {
    const at = this.now();
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(step_no), 0) AS n FROM steps WHERE job_id = ?')
        .get(jobId) as { n: number };
      const stepNo = row.n + 1;
      this.insertStepRow(jobId, stepNo, step, at);
      this.db
        .prepare('UPDATE jobs SET steps_total = steps_total + 1, updated_at = ? WHERE id = ?')
        .run(at, jobId);
      return stepNo;
    })();
  }

  private insertStepRow(jobId: string, stepNo: number, s: NewStep, at: number): void {
    const paramsJson = JSON.stringify(s.params);
    let inline: string | null = paramsJson;
    let artifactId: string | null = null;
    if (Buffer.byteLength(paramsJson) > this.largeParamsBytes) {
      artifactId = this.createArtifact(jobId, stepNo, 'params', paramsJson, at);
      inline = null;
    }
    const key = s.post ? idempotencyKeyFor(jobId, stepNo, 0) : null;
    this.db
      .prepare(
        `INSERT INTO steps (job_id, step_no, op_id, op_kind, params, params_artifact_id, params_hash, options,
           idempotency_key, client_ids, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        jobId,
        stepNo,
        s.opId,
        s.opKind,
        inline,
        artifactId,
        sha256(paramsJson),
        JSON.stringify(s.options),
        key,
        s.clientIds.length > 0 ? JSON.stringify(s.clientIds) : null,
      );
  }

  job(id: string): JobView | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? toJob(r) : undefined;
  }

  jobOptions(id: string): Record<string, unknown> {
    const r = this.db.prepare('SELECT options FROM jobs WHERE id = ?').get(id) as { options: string | null } | undefined;
    return parse<Record<string, unknown>>(r?.options, {});
  }

  setJobOptions(id: string, options: Record<string, unknown>): void {
    this.db.prepare('UPDATE jobs SET options = ?, updated_at = ? WHERE id = ? ').run(JSON.stringify(options), this.now(), id);
  }

  updateJob(id: string, p: JobPatch): JobView | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.status !== undefined) add('status', p.status);
    if (p.stepsTotal !== undefined) add('steps_total', p.stepsTotal);
    if (p.stepsDone !== undefined) add('steps_done', p.stepsDone);
    if (p.stepsFailed !== undefined) add('steps_failed', p.stepsFailed);
    if (p.currentStep !== undefined) add('current_step', p.currentStep);
    if (p.resumeAt !== undefined) add('resume_at', p.resumeAt);
    if (p.waitReason !== undefined) add('wait_reason', p.waitReason === null ? null : json(p.waitReason));
    if (p.pauseRequested !== undefined) add('pause_requested', p.pauseRequested ? 1 : 0);
    if (p.cancelRequested !== undefined) add('cancel_requested', p.cancelRequested ? 1 : 0);
    if (p.uncertain !== undefined) add('uncertain', p.uncertain ? 1 : 0);
    if (p.lastError !== undefined) add('last_error', p.lastError === null ? null : json(p.lastError));
    if (p.result !== undefined) add('result', p.result === null ? null : json(p.result));
    if (p.startedAt !== undefined) add('started_at', p.startedAt);
    if (p.finishedAt !== undefined) add('finished_at', p.finishedAt);
    add('updated_at', this.now());
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.job(id);
  }

  /** Queued jobs in scheduling order: priority class, then age. */
  queuedJobs(limit: number): JobView[] {
    return (
      this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY ${PRIORITY_ORDER}, created_at, id LIMIT ?`)
        .all(limit) as JobRow[]
    ).map(toJob);
  }

  jobsWithStatus(statuses: readonly JobStatus[]): JobView[] {
    const marks = statuses.map(() => '?').join(', ');
    return (
      this.db
        .prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY created_at, id`)
        .all(...statuses) as JobRow[]
    ).map(toJob);
  }

  /** Counts steps by status for a job (progress). */
  stepCounts(jobId: string): Record<StepStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM steps WHERE job_id = ? GROUP BY status')
      .all(jobId) as { status: StepStatus; n: number }[];
    const out: Record<StepStatus, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      uncertain: 0,
      cancelled: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // -------------------------------------------------------------------------------- steps

  step(jobId: string, stepNo: number): StepView | undefined {
    const r = this.db.prepare('SELECT * FROM steps WHERE job_id = ? AND step_no = ?').get(jobId, stepNo) as
      | StepRow
      | undefined;
    return r ? toStep(r) : undefined;
  }

  steps(jobId: string): StepView[] {
    return (
      this.db.prepare('SELECT * FROM steps WHERE job_id = ? ORDER BY step_no').all(jobId) as StepRow[]
    ).map(toStep);
  }

  /** The next step to run: the first that is pending or was running (a restart left it in flight). */
  nextStep(jobId: string): StepView | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM steps WHERE job_id = ? AND status IN ('pending', 'running') ORDER BY step_no LIMIT 1`,
      )
      .get(jobId) as StepRow | undefined;
    return r ? toStep(r) : undefined;
  }

  updateStep(jobId: string, stepNo: number, p: StepPatch): StepView | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.status !== undefined) add('status', p.status);
    if (p.attempts !== undefined) add('attempts', p.attempts);
    if (p.attempt0 !== undefined) add('attempt0', p.attempt0);
    if (p.idempotencyKey !== undefined) add('idempotency_key', p.idempotencyKey);
    if (p.ifMatch !== undefined) add('if_match', p.ifMatch);
    if (p.maybeSent !== undefined) add('maybe_sent', p.maybeSent ? 1 : 0);
    if (p.requestIds !== undefined) add('request_ids', JSON.stringify(p.requestIds));
    if (p.resultSummary !== undefined) add('result_summary', json(p.resultSummary));
    if (p.resultArtifactId !== undefined) add('result_artifact_id', p.resultArtifactId);
    if (p.error !== undefined) add('error', p.error === null ? null : json(p.error));
    if (p.firstSentAt !== undefined) add('first_sent_at', p.firstSentAt);
    if (p.startedAt !== undefined) add('started_at', p.startedAt);
    if (p.finishedAt !== undefined) add('finished_at', p.finishedAt);
    if (sets.length === 0) return this.step(jobId, stepNo);
    this.db.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE job_id = ? AND step_no = ?`).run(...vals, jobId, stepNo);
    return this.step(jobId, stepNo);
  }

  /** Marks every not-yet-final step of a job (used by cancel). */
  cancelOpenSteps(jobId: string): void {
    this.db
      .prepare(
        `UPDATE steps SET status = 'cancelled', finished_at = ? WHERE job_id = ? AND status IN ('pending', 'running')`,
      )
      .run(this.now(), jobId);
  }

  /** The params of a step, from the row or its artefact. */
  stepParams(step: StepView): OpParams {
    if (step.params) return step.params;
    if (step.paramsArtifactId) {
      const a = this.db.prepare('SELECT data FROM job_artifacts WHERE id = ?').get(step.paramsArtifactId) as
        | { data: string | null }
        | undefined;
      return parse<OpParams>(a?.data, {});
    }
    return {};
  }

  // -------------------------------------------------------------------------------- artefacts

  createArtifact(
    jobId: string,
    stepNo: number | null,
    kind: ArtifactView['kind'],
    data: string | null,
    at = this.now(),
  ): string {
    const id = newArtifactId();
    this.db
      .prepare(
        `INSERT INTO job_artifacts (id, job_id, step_no, kind, data, bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, jobId, stepNo, kind, data, data === null ? 0 : Buffer.byteLength(data), at, at);
    return id;
  }

  /** Appends list items to an `items` artefact. Returns the new totals. */
  appendItems(artifactId: string, items: readonly unknown[]): { itemCount: number; bytes: number } {
    return this.db.transaction(() => {
      const a = this.db.prepare('SELECT item_count, bytes FROM job_artifacts WHERE id = ?').get(artifactId) as {
        item_count: number;
        bytes: number;
      };
      const insert = this.db.prepare('INSERT INTO job_artifact_items (artifact_id, idx, data) VALUES (?, ?, ?)');
      let bytes = a.bytes;
      let idx = a.item_count;
      for (const item of items) {
        const text = JSON.stringify(item);
        bytes += Buffer.byteLength(text);
        insert.run(artifactId, idx++, text);
      }
      this.db
        .prepare('UPDATE job_artifacts SET item_count = ?, bytes = ?, updated_at = ? WHERE id = ?')
        .run(idx, bytes, this.now(), artifactId);
      return { itemCount: idx, bytes };
    })();
  }

  markTruncated(artifactId: string, reason: string): void {
    this.db
      .prepare('UPDATE job_artifacts SET truncated = 1, truncated_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason, this.now(), artifactId);
  }

  artifact(id: string): ArtifactView | undefined {
    const r = this.db.prepare('SELECT * FROM job_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return r ? toArtifact(r) : undefined;
  }

  // -------------------------------------------------------------------------------- errors

  recordError(e: ErrorInput): ErrorRecordView {
    const path = e.issues?.[0]?.path ?? '';
    const fingerprint = errorFingerprint(e.opId, e.code, path);
    const info = this.db
      .prepare(
        `INSERT INTO errors (at, op_id, job_id, step_no, http_status, code, message, issues, path, request_id,
           retryable, classification, fingerprint, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        e.opId,
        e.jobId ?? null,
        e.stepNo ?? null,
        e.status ?? null,
        e.code ?? null,
        e.message.slice(0, 2000),
        JSON.stringify(e.issues ?? []),
        path,
        e.requestId ?? null,
        e.retryable ? 1 : 0,
        e.classification,
        fingerprint,
        json(e.detail),
      );
    const row = this.db.prepare('SELECT * FROM errors WHERE id = ?').get(info.lastInsertRowid) as ErrorRow;
    return toError(row);
  }

  // -------------------------------------------------------------------------------- budget samples

  recordBudgetSample(s: BudgetSnapshot): void {
    const tiers: BudgetSampleView['tiers'] = {};
    for (const [id, t] of Object.entries(s.tiers)) {
      tiers[id] = {
        used: t.used,
        limit: t.limit,
        remaining: t.remaining,
        blocked: t.blockedUntilMs !== null,
        drift: t.drift?.delta ?? null,
      };
    }
    this.db
      .prepare('INSERT INTO budget_samples (at, data) VALUES (?, ?)')
      .run(s.atMs, JSON.stringify({ tiers, queues: s.queues, inFlight: s.inFlight }));
  }

  pruneBudgetSamples(beforeMs: number): number {
    return this.db.prepare('DELETE FROM budget_samples WHERE at < ?').run(beforeMs).changes;
  }

  // -------------------------------------------------------------------------------- runtime settings

  getSetting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r ? parse<T | undefined>(r.value, undefined) : undefined;
  }

  setSetting(key: string, value: unknown, by?: string): void {
    if (value === undefined || value === null) {
      this.db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(key, JSON.stringify(value), this.now(), by ?? null);
  }
}

// ------------------------------------------------------------------------------------------------ queries

export interface RuntimeSettingView {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
  readonly updatedBy: string | null;
}

export interface ErrorGroupFilter {
  readonly resolved?: boolean;
  readonly since?: number;
  readonly limit?: number;
}

export interface ErrorFilter {
  readonly fingerprint?: string;
  readonly jobId?: string;
  readonly since?: number;
  readonly limit?: number;
}

/** Read-only queries over the job tables (for chunk 5's admin API and the MCP awareness tools). */
export function createJobQueries(db: Db) {
  return {
    listJobs(filter: JobFilter = {}): JobView[] {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (filter.status !== undefined) {
        const list: readonly JobStatus[] = Array.isArray(filter.status)
          ? (filter.status as readonly JobStatus[])
          : [filter.status as JobStatus];
        where.push(`status IN (${list.map(() => '?').join(', ')})`);
        vals.push(...list);
      }
      if (filter.originKind) {
        where.push('origin_kind = ?');
        vals.push(filter.originKind);
      }
      if (filter.kind) {
        where.push('kind = ?');
        vals.push(filter.kind);
      }
      if (filter.before !== undefined) {
        where.push('created_at < ?');
        vals.push(filter.before);
      }
      const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      return (db.prepare(sql).all(...vals, Math.min(filter.limit ?? 50, 500)) as JobRow[]).map(toJob);
    },

    getJob(id: string): JobWithSteps | undefined {
      const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      if (!r) return undefined;
      const steps = (db.prepare('SELECT * FROM steps WHERE job_id = ? ORDER BY step_no').all(id) as StepRow[]).map(
        toStep,
      );
      const artifacts = (
        db.prepare('SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY created_at, id').all(id) as ArtifactRow[]
      ).map(toArtifact);
      return { ...toJob(r), steps, artifacts };
    },

    /** Items of an `items` artefact (paginate_all results), or the JSON of a params/result artefact. */
    readArtifact(
      id: string,
      page: { offset?: number; limit?: number } = {},
    ): { artifact: ArtifactView; items?: unknown[]; data?: unknown; nextOffset: number | null } | undefined {
      const r = db.prepare('SELECT * FROM job_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
      if (!r) return undefined;
      const artifact = toArtifact(r);
      if (r.kind !== 'items') return { artifact, data: parse<unknown>(r.data, null), nextOffset: null };
      const offset = Math.max(0, page.offset ?? 0);
      const limit = Math.min(Math.max(1, page.limit ?? 100), 1000);
      const rows = db
        .prepare('SELECT data FROM job_artifact_items WHERE artifact_id = ? AND idx >= ? ORDER BY idx LIMIT ?')
        .all(id, offset, limit) as { data: string }[];
      const items = rows.map((x) => parse<unknown>(x.data, null));
      const next = offset + items.length;
      return { artifact, items, nextOffset: next < r.item_count ? next : null };
    },

    listErrorGroups(filter: ErrorGroupFilter = {}): ErrorGroupView[] {
      const having: string[] = [];
      if (filter.resolved === true) having.push('SUM(resolved_at IS NULL) = 0');
      if (filter.resolved === false) having.push('SUM(resolved_at IS NULL) > 0');
      const where = filter.since !== undefined ? 'WHERE at >= ?' : '';
      const vals: unknown[] = filter.since !== undefined ? [filter.since] : [];
      const rows = db
        .prepare(
          `SELECT fingerprint, op_id, code, path, COUNT(*) AS count, MIN(at) AS first_seen, MAX(at) AS last_seen,
             SUM(resolved_at IS NULL) AS open, MAX(id) AS last_id
           FROM errors ${where} GROUP BY fingerprint
           ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
           ORDER BY last_seen DESC LIMIT ?`,
        )
        .all(...vals, Math.min(filter.limit ?? 100, 1000)) as {
        fingerprint: string;
        op_id: string;
        code: string | null;
        path: string;
        count: number;
        first_seen: number;
        last_seen: number;
        open: number;
        last_id: number;
      }[];
      const last = db.prepare('SELECT * FROM errors WHERE id = ?');
      return rows.map((g) => {
        const l = last.get(g.last_id) as ErrorRow;
        return {
          fingerprint: g.fingerprint,
          opId: g.op_id,
          code: g.code,
          path: g.path,
          classification: l.classification,
          count: g.count,
          firstSeen: g.first_seen,
          lastSeen: g.last_seen,
          resolved: g.open === 0,
          lastMessage: l.message,
          lastRequestId: l.request_id,
          lastJobId: l.job_id,
        };
      });
    },

    listErrors(filter: ErrorFilter = {}): ErrorRecordView[] {
      const where: string[] = [];
      const vals: unknown[] = [];
      if (filter.fingerprint !== undefined) {
        where.push('fingerprint = ?');
        vals.push(filter.fingerprint);
      }
      if (filter.jobId !== undefined) {
        where.push('job_id = ?');
        vals.push(filter.jobId);
      }
      if (filter.since !== undefined) {
        where.push('at >= ?');
        vals.push(filter.since);
      }
      return (
        db
          .prepare(
            `SELECT * FROM errors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
          )
          .all(...vals, Math.min(filter.limit ?? 100, 1000)) as ErrorRow[]
      ).map(toError);
    },

    /** Marks every current occurrence resolved. Returns how many rows changed. */
    resolveErrorGroup(fingerprint: string, atMs: number = Date.now()): number {
      return db
        .prepare('UPDATE errors SET resolved_at = ? WHERE fingerprint = ? AND resolved_at IS NULL')
        .run(atMs, fingerprint).changes;
    },

    listBudgetSamples(range: { since?: number; until?: number; limit?: number } = {}): BudgetSampleView[] {
      const rows = db
        .prepare('SELECT at, data FROM budget_samples WHERE at >= ? AND at <= ? ORDER BY at LIMIT ?')
        .all(range.since ?? 0, range.until ?? Number.MAX_SAFE_INTEGER, Math.min(range.limit ?? 10_000, 50_000)) as {
        at: number;
        data: string;
      }[];
      return rows.map((r) => ({ at: r.at, ...parse(r.data, { tiers: {}, queues: {}, inFlight: 0 }) }));
    },

    runtimeSettings(): RuntimeSettingView[] {
      return (
        db.prepare('SELECT * FROM runtime_settings ORDER BY key').all() as {
          key: string;
          value: string;
          updated_at: number;
          updated_by: string | null;
        }[]
      ).map((r) => ({ key: r.key, value: parse(r.value, null), updatedAt: r.updated_at, updatedBy: r.updated_by }));
    },
  };
}

export type JobQueries = ReturnType<typeof createJobQueries>;
