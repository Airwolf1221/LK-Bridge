/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H10): a write whose outcome is unknown
 * is always reconciled. An unknown outcome on a destructive write must never sit unreconciled.
 *
 * When the journal records an entry as `unknown` (a connection that broke after the request was sent, a verification
 * that could not complete), and at start-up for every one left from before, the reconciler settles it:
 *
 * 1. **superseded**: later writes to the same target (the same document; else the same entity of the same page; else
 *    the same page) were applied. The question can no longer be answered by reading, and no longer matters. Free: the
 *    journal alone says so.
 * 2. Otherwise it reads the target back (through the governor, at P2) and compares by WHAT THE JOB SENT (the step's own
 *    stored params, not the journal's 16 KB copy), as R4 compared a new chapter's read-back with what was sent:
 *    - **applied**: the target holds what was sent (a replace's whole block list, a patch's fields, a create's page
 *      under its client id, a delete's entity gone);
 *    - **not_applied**: the version is the one the write was based on (its If-Match), or, for an entity without a
 *      version, it still holds its pre-image's values and not the write's; or a create's id is not there;
 *    - otherwise it cannot tell yet, and it reads again with back-off (about five minutes in all).
 * 3. **unknown** stays only when none of these could be decided: the reconciliation is `unresolved`, and the audits'
 *    `writes` category shows it to the owner with the pre-image and the intended change (`write_outcome_unknown`).
 *
 * The job's own recovery may settle the entry first (its in-step verify, a Resume): the reconciler never overwrites an
 * outcome that is no longer `unknown`, and records who settled it.
 */
import type { Db } from '../db/open.js';
import type { Clock, TimerHandle } from '../lk/governor/clock.js';
import { matchesIntent } from './compare.js';
import type { WriteJournal } from './journal.js';
import { isNotFound } from './lk-call.js';
import { OP_META, READERS } from './op-meta.js';
import type { OpParams } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export type ReconciledOutcome = 'applied' | 'not_applied' | 'superseded' | 'unknown';

/** The back-off between read-backs, in milliseconds: about five minutes in all. */
export const RECONCILE_DELAYS_MS: readonly number[] = [5_000, 15_000, 40_000, 90_000, 150_000];

export interface ReconcileDeps {
  readonly db: Db;
  readonly journal: Pick<WriteJournal, 'onUnknown' | 'settleUnknown'>;
  /** One governed read (the engine's `internalRead`, P2); a 404 must throw a not-found error. */
  readonly read: (projectId: string, opId: string, params: OpParams) => Promise<unknown>;
  /** The params a job's step sent (its stored params), or null when the job or step is gone. */
  readonly stepParams: (projectId: string, jobId: string, stepNo: number) => OpParams | null;
  readonly clock: Clock;
  readonly delaysMs?: readonly number[];
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Told when a reconciliation ends (settled or unresolved): the dashboard's live stream. */
  readonly onSettled?: (r: Reconciliation) => void;
}

export interface Reconciliation {
  readonly journalId: number;
  readonly projectId: string;
  readonly state: 'pending' | 'settled' | 'unresolved';
  readonly outcome: ReconciledOutcome | null;
  readonly attempts: number;
  readonly firstAt: number;
  readonly nextAt: number | null;
  readonly settledAt: number | null;
  readonly settledBy: string | null;
  readonly reason: string | null;
  readonly evidence: Obj | null;
}

interface EntryRow {
  id: number;
  project_id: string;
  at: number;
  job_id: string | null;
  step_no: number | null;
  op_id: string;
  target_kind: string;
  target_id: string | null;
  resource_id: string | null;
  document_id: string | null;
  version: string | null;
  params: string | null;
  pre_image: string | null;
  outcome: string;
  operation: string | null;
  principal_id: string;
  profile: string;
}

interface RecRow {
  journal_id: number;
  project_id: string;
  state: Reconciliation['state'];
  outcome: ReconciledOutcome | null;
  attempts: number;
  first_at: number;
  next_at: number | null;
  settled_at: number | null;
  settled_by: string | null;
  reason: string | null;
  evidence: string | null;
}

const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

const toView = (r: RecRow): Reconciliation => ({
  journalId: r.journal_id,
  projectId: r.project_id,
  state: r.state,
  outcome: r.outcome,
  attempts: r.attempts,
  firstAt: r.first_at,
  nextAt: r.next_at,
  settledAt: r.settled_at,
  settledBy: r.settled_by,
  reason: r.reason,
  evidence: isObj(parse(r.evidence)) ? (parse(r.evidence) as Obj) : null,
});

/** One read-back's answer: settled, or not yet (read again later). */
export type Judgement =
  | {
      readonly outcome: 'applied' | 'not_applied' | 'superseded';
      readonly reason: string;
      readonly evidence?: Obj;
    }
  | { readonly outcome: null; readonly reason: string; readonly evidence?: Obj };

/** An unresolved write, as the audits' `writes` category shows it (with the pre-image and the intended change). */
export interface UnknownWriteItem {
  readonly journalId: number;
  readonly at: number;
  readonly opId: string;
  readonly jobId: string | null;
  readonly stepNo: number | null;
  readonly principalId: string;
  readonly profile: string;
  readonly resourceId: string | null;
  readonly documentId: string | null;
  readonly targetId: string | null;
  readonly version: string | null;
  readonly attempts: number;
  readonly reason: string | null;
  /** The high-level operation (write_page: mode, section), when the journal has one. */
  readonly operation: unknown;
  /** The write's intended change, as sent (capped as the journal caps it). */
  readonly intended: unknown;
  /** What was there before (destructive writes keep one), or null. */
  readonly preImage: unknown;
}

export class OutcomeReconciler {
  private readonly timers = new Map<number, TimerHandle>();
  private readonly running = new Set<number>();
  private off: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly d: ReconcileDeps) {}

  private get delays(): readonly number[] {
    return this.d.delaysMs ?? RECONCILE_DELAYS_MS;
  }

  /** Follows the journal's unknown outcomes and sweeps those left from before (start-up). Returns a stop. */
  start(): () => void {
    this.stopped = false;
    this.off = this.d.journal.onUnknown((e) => this.enqueue(e.id, e.projectId, 'bridge'));
    this.sweep();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
    for (const t of this.timers.values()) this.d.clock.clearTimeout(t);
    this.timers.clear();
  }

  /**
   * The start-up sweep: every entry still `unknown` gets a reconciliation (a pending one continues where it was; one
   * already unresolved is tried once more, since the target may be readable now). Returns how many were queued.
   */
  sweep(): number {
    const rows = this.d.db
      .prepare(
        `SELECT w.id, w.project_id, r.state FROM write_journal w
           LEFT JOIN write_reconciliations r ON r.journal_id = w.id
          WHERE w.outcome = 'unknown' ORDER BY w.id`,
      )
      .all() as { id: number; project_id: string; state: string | null }[];
    for (const r of rows) {
      if (r.state === 'unresolved') {
        this.d.db
          .prepare(
            "UPDATE write_reconciliations SET state = 'pending', attempts = 0, next_at = ? WHERE journal_id = ?",
          )
          .run(this.d.clock.now(), r.id);
      }
      this.enqueue(r.id, r.project_id, 'start-up', 0);
    }
    return rows.length;
  }

  /** Starts (or continues) the reconciliation of one entry. */
  enqueue(journalId: number, projectId: string, by: string, delayMs?: number): void {
    if (this.stopped) return;
    const now = this.d.clock.now();
    const had = this.get(journalId);
    if (!had)
      this.d.db
        .prepare(
          `INSERT INTO write_reconciliations (journal_id, project_id, state, attempts, first_at, next_at, settled_by)
           VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(journalId, projectId, now, now + (delayMs ?? this.delays[0] ?? 0), by);
    else if (had.state === 'settled') return;
    this.schedule(journalId, delayMs ?? this.delays[had?.attempts ?? 0] ?? 0);
  }

  private schedule(journalId: number, ms: number): void {
    if (this.stopped || this.timers.has(journalId)) return;
    const t = this.d.clock.setTimeout(() => {
      this.timers.delete(journalId);
      void this.attempt(journalId);
    }, ms);
    this.timers.set(journalId, t);
  }

  get(journalId: number): Reconciliation | null {
    const r = this.d.db.prepare('SELECT * FROM write_reconciliations WHERE journal_id = ?').get(journalId) as
      RecRow | undefined;
    return r ? toView(r) : null;
  }

  /** The reconciliations of a project, newest first (`state` filters). */
  list(projectId: string, o: { state?: Reconciliation['state']; limit?: number } = {}): Reconciliation[] {
    const rows = this.d.db
      .prepare(
        `SELECT * FROM write_reconciliations WHERE project_id = ? ${o.state ? 'AND state = ?' : ''}
          ORDER BY journal_id DESC LIMIT ?`,
      )
      .all(...[projectId, ...(o.state ? [o.state] : []), Math.min(o.limit ?? 100, 1000)]) as RecRow[];
    return rows.map(toView);
  }

  /** The writes the reconciler could not settle, for the audits' `writes` category. */
  unresolved(projectId: string): UnknownWriteItem[] {
    const rows = this.d.db
      .prepare(
        `SELECT w.*, r.attempts AS r_attempts, r.reason AS r_reason FROM write_reconciliations r
           JOIN write_journal w ON w.id = r.journal_id
          WHERE r.project_id = ? AND r.state = 'unresolved' AND w.outcome = 'unknown'
          ORDER BY w.id LIMIT 1000`,
      )
      .all(projectId) as (EntryRow & { r_attempts: number; r_reason: string | null })[];
    return rows.map((w) => ({
      journalId: w.id,
      at: w.at,
      opId: w.op_id,
      jobId: w.job_id,
      stepNo: w.step_no,
      principalId: w.principal_id,
      profile: w.profile,
      resourceId: w.resource_id,
      documentId: w.document_id,
      targetId: w.target_id,
      version: w.version,
      attempts: w.r_attempts,
      reason: w.r_reason,
      operation: parse(w.operation),
      intended: parse(w.params),
      preImage: parse(w.pre_image),
    }));
  }

  /** One attempt: settle it, or read again later, or (after the last) leave it unresolved. */
  async attempt(journalId: number): Promise<Reconciliation | null> {
    if (this.running.has(journalId)) return this.get(journalId);
    this.running.add(journalId);
    try {
      const entry = this.d.db.prepare('SELECT * FROM write_journal WHERE id = ?').get(journalId) as
        EntryRow | undefined;
      const rec = this.get(journalId);
      if (!entry || !rec || rec.state === 'settled') return rec;
      const now = this.d.clock.now();
      if (entry.outcome !== 'unknown') {
        // The job's own recovery (or a Resume) settled it meanwhile.
        const settled: ReconciledOutcome =
          entry.outcome === 'applied' || entry.outcome === 'not_applied' || entry.outcome === 'superseded'
            ? entry.outcome
            : 'unknown';
        return this.finish(journalId, 'settled', settled, 'job', {
          reason: `settled by the job itself: ${entry.outcome}`,
        });
      }
      let j: Judgement;
      try {
        j = await this.judge(entry);
      } catch (e) {
        j = {
          outcome: null,
          reason: `the target could not be read back (${e instanceof Error ? e.message : String(e)})`,
        };
      }
      const attempts = rec.attempts + 1;
      if (j.outcome !== null) {
        const changed = this.d.journal.settleUnknown(journalId, j.outcome);
        this.d.db
          .prepare('UPDATE write_reconciliations SET attempts = ? WHERE journal_id = ?')
          .run(attempts, journalId);
        if (!changed) {
          // The job settled it between the read and now: its answer stands.
          const now2 = this.d.db.prepare('SELECT outcome FROM write_journal WHERE id = ?').get(journalId) as
            { outcome: string } | undefined;
          const o = now2?.outcome;
          return this.finish(
            journalId,
            'settled',
            o === 'applied' || o === 'not_applied' || o === 'superseded' ? o : 'unknown',
            'job',
            { reason: `settled by the job itself: ${o ?? 'gone'}` },
          );
        }
        return this.finish(journalId, 'settled', j.outcome, 'bridge', j);
      }
      const next = this.delays[attempts];
      if (next === undefined) {
        this.d.db
          .prepare('UPDATE write_reconciliations SET attempts = ? WHERE journal_id = ?')
          .run(attempts, journalId);
        return this.finish(journalId, 'unresolved', 'unknown', 'bridge', j);
      }
      this.d.db
        .prepare(
          'UPDATE write_reconciliations SET attempts = ?, next_at = ?, reason = ?, evidence = ? WHERE journal_id = ?',
        )
        .run(attempts, now + next, j.reason, j.evidence ? JSON.stringify(j.evidence) : null, journalId);
      this.schedule(journalId, next);
      return this.get(journalId);
    } catch (e) {
      this.d.log?.warn({ err: e, journalId }, 'a write outcome could not be reconciled');
      return this.get(journalId);
    } finally {
      this.running.delete(journalId);
    }
  }

  private finish(
    journalId: number,
    state: 'settled' | 'unresolved',
    outcome: ReconciledOutcome,
    by: string,
    j: { reason: string; evidence?: Obj },
  ): Reconciliation | null {
    this.d.db
      .prepare(
        `UPDATE write_reconciliations SET state = ?, outcome = ?, settled_at = ?, settled_by = ?, next_at = NULL,
           reason = ?, evidence = ? WHERE journal_id = ?`,
      )
      .run(
        state,
        outcome,
        this.d.clock.now(),
        by,
        j.reason.slice(0, 2000),
        j.evidence ? JSON.stringify(j.evidence).slice(0, 32_000) : null,
        journalId,
      );
    const r = this.get(journalId);
    if (r)
      try {
        this.d.onSettled?.(r);
      } catch {
        // a listener never breaks a reconciliation
      }
    return r;
  }

  // ============================================================================================ the judgement

  /** Later applied writes to the same target (the same document; else the same entity of the page; else the page). */
  supersededBy(e: EntryRow): number[] {
    const where =
      e.document_id !== null
        ? { sql: 'document_id = ?', vals: [e.document_id] }
        : e.target_id !== null
          ? {
              sql: 'target_id = ? AND resource_id IS ?',
              vals: [e.target_id, e.resource_id],
            }
          : e.resource_id !== null
            ? { sql: 'resource_id = ?', vals: [e.resource_id] }
            : null;
    if (!where) return [];
    const rows = this.d.db
      .prepare(
        `SELECT id FROM write_journal WHERE project_id = ? AND id > ? AND outcome = 'applied' AND ${where.sql}
          ORDER BY id LIMIT 50`,
      )
      .all(e.project_id, e.id, ...where.vals) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** What the write sent: the job step's own params, else the journal's copy (unless its body was left out). */
  private sentParams(e: EntryRow): OpParams | null {
    if (e.job_id !== null && e.step_no !== null) {
      const p = this.d.stepParams(e.project_id, e.job_id, e.step_no);
      if (p) return p;
    }
    const j = parse(e.params);
    if (!isObj(j) || j.bodyOmitted === true) return null;
    return j as OpParams;
  }

  async judge(e: EntryRow): Promise<Judgement> {
    const later = this.supersededBy(e);
    if (later.length > 0)
      return {
        outcome: 'superseded',
        reason: `later writes to the same ${e.document_id !== null ? 'document' : 'target'} were applied (journal ${later.slice(0, 5).join(', ')}${later.length > 5 ? ', …' : ''}): whether this one applied can no longer be told, and no longer matters`,
        evidence: { later },
      };
    const meta = OP_META[e.op_id];
    const params = this.sentParams(e);
    if (!meta || !meta.reader) return { outcome: null, reason: `${e.op_id} has no way to be read back` };
    if (!params)
      return { outcome: null, reason: 'what the write sent is no longer stored (its job is gone)' };
    const reader = READERS[meta.reader];
    const path: Record<string, string> = {};
    const id = e.target_id ?? undefined;
    for (const [k, v] of Object.entries(params.path ?? {})) if (typeof v === 'string') path[k] = v;
    if (meta.verify === 'client-id' && reader.idParam && id) path[reader.idParam] = id;
    let body: unknown;
    let exists = true;
    try {
      body = await this.d.read(e.project_id, reader.op, { path });
    } catch (err) {
      const lk = isObj(err) && 'lk' in err ? (err as { lk: unknown }).lk : err;
      if (!isNotFound(lk)) throw err;
      exists = false;
    }
    let entity: unknown = body;
    if (reader.list) {
      const data = isObj(body) ? body.data : undefined;
      const want = reader.selectBy ? params.path?.[reader.selectBy] : undefined;
      entity =
        want !== undefined && Array.isArray(data)
          ? (data as Obj[]).find((x) => x?.id === want)
          : reader.selectBy
            ? undefined
            : body;
      if (entity === undefined) exists = false;
    }
    const version = exists ? reader.version?.(body, entity) : undefined;
    const evidence: Obj = {
      read: reader.op,
      exists,
      ...(version !== undefined ? { version } : {}),
      ...(e.version !== null ? { basedOn: e.version } : {}),
    };
    if (meta.verify === 'gone')
      return exists
        ? { outcome: 'not_applied', reason: 'the entity the delete named is still there', evidence }
        : { outcome: 'applied', reason: 'the entity the delete named is gone', evidence };
    if (meta.verify === 'client-id')
      return exists
        ? { outcome: 'applied', reason: `the entity it created (${id ?? 'its id'}) is there`, evidence }
        : {
            outcome: 'not_applied',
            reason: `no entity under the id it would have created (${id ?? '?'})`,
            evidence,
          };
    if (!exists)
      return {
        outcome: null,
        reason: 'the target is gone: whether the write applied first cannot be told',
        evidence,
      };
    const intent = meta.intent ? meta.intent(params) : params.body;
    const actual = meta.actual ? meta.actual(body, entity) : (entity ?? body);
    if (intent !== undefined && matchesIntent(intent, actual, meta.compare ?? 'patch'))
      return {
        outcome: 'applied',
        reason:
          e.version !== null && version !== undefined && version !== e.version
            ? `the version moved (${e.version} → ${version}) and the content matches what the job sent`
            : 'the target holds what the job sent',
        evidence: { ...evidence, compared: 'what the job sent' },
      };
    if (e.version !== null && version !== undefined && version === e.version)
      return {
        outcome: 'not_applied',
        reason: `the version is still ${e.version}, the one the write was based on`,
        evidence,
      };
    // An entity without a version: still its pre-image's values (for every field the write named) means not applied.
    const pre = parse(e.pre_image);
    if (version === undefined && isObj(intent) && isObj(pre)) {
      const named = Object.fromEntries(Object.keys(intent).map((k) => [k, pre[k]]));
      if (matchesIntent(named, actual, 'patch'))
        return {
          outcome: 'not_applied',
          reason: 'the target still holds what it held before the write, not what the write sent',
          evidence: { ...evidence, compared: 'the pre-image' },
        };
    }
    return {
      outcome: null,
      reason:
        version !== undefined && e.version !== null
          ? `the version moved (${e.version} → ${version}) but the content does not match what the job sent (an edit outside the bridge?)`
          : 'the target matches neither what the write sent nor what was there before',
      evidence,
    };
  }
}
