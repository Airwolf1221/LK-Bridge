/**
 * v3 F3d (renames), ADR 0058 (the owner-approved design docs/design/F3d-renames.md, section 3, decision D6): resuming a
 * package (or a rename, or a recreate) that stopped part-way.
 *
 * - **The record.** A job that can be resumed (its options say so: `resumable`) and stops part-way (failed, or
 *   cancelled) records where (`job_stops`): its last VERIFIED step (every step up to it succeeded, and none of them was
 *   read back different from its plan), the step it stopped at, and why. The Jobs and Review pages show **Resume**.
 * - **Resume.** A package or a rename continues in the same job (`engine.controls.resumeStopped`): the job's own checks
 *   run again first, inside the job and its locks (its preconditions judged again: a refusal stops it again, with its
 *   reason, before anything is written), then every step that did not succeed, each re-reading its target and checking
 *   it inside the lock as the original would have. A step that succeeded is never repeated, and a create that may have
 *   reached LegendKeeper is verified by its id before anything is sent, so no second page or document is ever made.
 * - **A recreate** (F2's "Finish", ADR 0049 decision 6) resumes the way F2 finishes it: the same restore proposed again,
 *   planning only what the page it made still lacks (a proposal for the owner, as before).
 * - **No fresh approval** for an approved plan (decision D6): the job keeps the owner's approval; the proposal goes back
 *   from `failed` to `executing` and follows the job again. Every resume is audited (`job.resume`).
 * - **An agent** resumes only its own direct jobs, at its own scope (`bridge_job_resume`): a job the owner approved is
 *   the owner's to resume, as it is the owner's to cancel.
 * - **Revert** (ADR 0055) stays the alternative for a direct job: once reverted (or while a revert runs) a job is never
 *   resumed, and a job resumed is reverted, like any other, once it has finished.
 */
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/engine.js';
import { RESUMABLE_OPTION } from '../jobs/engine.js';
import {
  TERMINAL_JOB_STATUSES,
  type JobOrigin,
  type JobView,
  type JobWithSteps,
  type ResumableShape,
  type StepView,
} from '../jobs/types.js';

type Obj = Record<string, unknown>;

export class ResumeError extends Error {
  override readonly name = 'ResumeError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Where a job stopped (its row in `job_stops`). */
export interface JobStop {
  readonly projectId: string;
  readonly jobId: string;
  readonly kind: ResumableShape['kind'];
  /** Every step up to this one succeeded and none was read back different from its plan (0: none). */
  readonly lastVerifiedStep: number;
  readonly lastVerifiedLabel: string | null;
  readonly stoppedStep: number | null;
  readonly stoppedLabel: string | null;
  readonly reason: string | null;
  readonly status: 'failed' | 'cancelled';
  readonly stoppedAt: number;
  readonly resumes: number;
  readonly lastResumedAt: number | null;
  readonly lastResumedBy: string | null;
}

/** What Resume would do for a job now. */
export interface ResumeView {
  readonly resumable: boolean;
  /** Why not, when it cannot be resumed (a code and words). */
  readonly reason: { readonly code: string; readonly message: string } | null;
  readonly kind: ResumableShape['kind'] | null;
  readonly stop: JobStop | null;
  /** The steps it would run again or continue with (a recreate: planned afresh, so none listed). */
  readonly left: readonly { readonly stepNo: number; readonly op: string; readonly status: string }[];
  /** The job's own checks it runs again first. */
  readonly recheck: readonly number[];
  readonly approvedBy: string | null;
}

export type ResumeResult =
  | {
      readonly status: 'resumed';
      readonly jobId: string;
      readonly from: number;
      readonly rechecked: readonly number[];
      readonly job: JobView;
    }
  | {
      readonly status: 'proposal_captured';
      readonly jobId: string;
      readonly proposalId: string;
      readonly summary: string | null;
    }
  | { readonly status: 'nothing_to_do'; readonly jobId: string; readonly summary: string };

/** Who resumes: the owner (the dashboard), or an agent (its principal, at its own scope). */
export type ResumeActor =
  | { readonly kind: 'owner' }
  | { readonly kind: 'agent'; readonly principalId: string; readonly scope: string | undefined };

export interface ResumeDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'events' | 'queries' | 'controls' | 'jobOptions' | 'recheckSteps'>;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  /** The proposal service: the proposal an approved job ran from goes back to `executing` when it is resumed. */
  readonly proposals: {
    byJob(projectId: string, jobId: string): { readonly id: string; readonly state: string } | null;
    jobResumed(projectId: string, jobId: string): boolean;
  };
  /** F2's finish of a recreate (ADR 0049 decision 6): the same restore proposed again, only what is missing. */
  readonly finishRecreate?: (
    projectId: string,
    restoreId: string,
    origin: JobOrigin,
    by: string,
  ) => Promise<
    | { readonly status: 'nothing_to_do'; readonly summary: string }
    | { readonly status: 'proposal_captured'; readonly proposalId: string; readonly summary: string | null }
  >;
  /** Whether a job has been reverted (or a revert of it is running): it is never resumed then. */
  readonly revertState?: (projectId: string, jobId: string) => 'submitted' | 'succeeded' | 'stopped' | null;
  /** A step's label for people (the job's own), when known. */
  readonly now: () => number;
  readonly log?: { warn(o: unknown, m: string): void };
}

interface StopRow {
  project_id: string;
  job_id: string;
  kind: string;
  last_verified_step: number;
  stopped_step: number | null;
  stopped_label: string | null;
  reason: string | null;
  status: string;
  stopped_at: number;
  resumes: number;
  last_resumed_at: number | null;
  last_resumed_by: string | null;
}

/** The last step of the verified prefix: succeeded, and not read back different from its plan. */
export function lastVerifiedStep(steps: readonly StepView[]): number {
  let n = 0;
  for (const s of [...steps].sort((a, b) => a.stepNo - b.stepNo)) {
    if (s.status !== 'succeeded') break;
    const r = (s.resultSummary ?? {}) as { verification?: { status?: unknown } };
    if (r.verification?.status === 'mismatch') break;
    n = s.stepNo;
  }
  return n;
}

/** A step in words: its journal's page and write when it has them, else its operation. */
export function stepWords(s: StepView | undefined): string | null {
  if (!s) return null;
  const j = (s.options.journalOperation ?? {}) as Obj;
  const page = (j.page ?? {}) as Obj;
  const name = typeof page.name === 'string' ? page.name : null;
  const write = typeof j.write === 'string' ? j.write : null;
  if (name && write) return `${name}: ${write}`;
  if (name) return `${s.opId} on ${name}`;
  return write ?? s.opId;
}

export class ResumeService {
  private offs: (() => void)[] = [];

  constructor(private readonly d: ResumeDeps) {}

  /** Records where each resumable job stops. Returns a detach. */
  start(): () => void {
    this.offs.push(
      this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
        try {
          this.onJob(e.job);
        } catch (err) {
          this.d.log?.warn({ err, jobId: e.job.id }, 'where a job stopped could not be recorded');
        }
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private resumableOf(projectId: string, jobId: string): ResumableShape | null {
    const r = this.d.engine.jobOptions(projectId, jobId)[RESUMABLE_OPTION] as ResumableShape | undefined;
    return r &&
      (r.kind === 'package' ||
        r.kind === 'rename' ||
        r.kind === 'recreate' ||
        r.kind === 'split' ||
        r.kind === 'retag')
      ? r
      : null;
  }

  private onJob(job: JobView): void {
    if (!TERMINAL_JOB_STATUSES.has(job.status)) return;
    const r = this.resumableOf(job.projectId, job.id);
    if (!r) return;
    if (job.status === 'succeeded') {
      // Finished: nothing to resume (the audit keeps every resume).
      this.d.db
        .prepare('DELETE FROM job_stops WHERE project_id = ? AND job_id = ?')
        .run(job.projectId, job.id);
      return;
    }
    const full = this.d.engine.queries.getJob(job.projectId, job.id);
    if (!full) return;
    this.record(full, r.kind);
  }

  private record(job: JobWithSteps, kind: ResumableShape['kind']): void {
    const verified = lastVerifiedStep(job.steps);
    const stopped = job.steps.find((s) => s.status !== 'succeeded') ?? null;
    const reason =
      job.status === 'cancelled'
        ? 'cancelled'
        : typeof job.lastError?.message === 'string'
          ? job.lastError.message.slice(0, 1000)
          : null;
    this.d.db
      .prepare(
        `INSERT INTO job_stops (project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status,
           stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, job_id) DO UPDATE SET last_verified_step = excluded.last_verified_step,
           stopped_step = excluded.stopped_step, stopped_label = excluded.stopped_label, reason = excluded.reason,
           status = excluded.status, stopped_at = excluded.stopped_at`,
      )
      .run(
        job.projectId,
        job.id,
        kind,
        verified,
        stopped?.stepNo ?? null,
        stepWords(stopped ?? undefined)?.slice(0, 500) ?? null,
        reason,
        job.status === 'cancelled' ? 'cancelled' : 'failed',
        this.d.now(),
      );
  }

  /** Where a job stopped, or null (it has not, or it cannot be resumed). */
  stopOf(projectId: string, jobId: string): JobStop | null {
    const r = this.d.db
      .prepare('SELECT * FROM job_stops WHERE project_id = ? AND job_id = ?')
      .get(projectId, jobId) as StopRow | undefined;
    if (!r) return null;
    const job = this.d.engine.queries.getJob(projectId, jobId);
    const verifiedStep = job?.steps.find((s) => s.stepNo === r.last_verified_step);
    return {
      projectId: r.project_id,
      jobId: r.job_id,
      kind: r.kind as JobStop['kind'],
      lastVerifiedStep: r.last_verified_step,
      lastVerifiedLabel: stepWords(verifiedStep),
      stoppedStep: r.stopped_step,
      stoppedLabel: r.stopped_label,
      reason: r.reason,
      status: r.status as JobStop['status'],
      stoppedAt: r.stopped_at,
      resumes: r.resumes,
      lastResumedAt: r.last_resumed_at,
      lastResumedBy: r.last_resumed_by,
    };
  }

  /** What Resume would do now, or why it cannot. Nothing is read from LegendKeeper. */
  view(projectId: string, jobId: string, actor: ResumeActor = { kind: 'owner' }): ResumeView {
    const job = this.d.engine.queries.getJob(projectId, jobId);
    const r = job ? this.resumableOf(projectId, jobId) : null;
    const no = (code: string, message: string): ResumeView => ({
      resumable: false,
      reason: { code, message },
      kind: r?.kind ?? null,
      stop: job ? this.stopOf(projectId, jobId) : null,
      left: [],
      recheck: [],
      approvedBy: job?.approvedBy ?? null,
    });
    if (!job) return no('JOB_NOT_FOUND', `There is no job ${jobId} in this project.`);
    if (actor.kind === 'agent' && job.principalId !== actor.principalId)
      return no('JOB_NOT_FOUND', `There is no job ${jobId} of yours in this project.`);
    if (!r)
      return no(
        'NOT_RESUMABLE',
        `Job ${jobId} is not a package, a rename or a recreate: it is not resumed (a failed step of it can be retried on the Jobs page).`,
      );
    if (!TERMINAL_JOB_STATUSES.has(job.status))
      return no('JOB_RUNNING', `Job ${jobId} is still ${job.status}: it is resumed once it has stopped.`);
    if (job.status === 'succeeded')
      return no('NOTHING_LEFT', `Job ${jobId} has finished: nothing is left to do.`);
    if (actor.kind === 'agent') {
      if (job.approvedBy !== null)
        return no(
          'OWNER_APPROVED_JOB',
          `Job ${jobId} runs work the owner approved; only the owner resumes it (Resume on the dashboard's Jobs page).`,
        );
      if (actor.scope !== 'write')
        return no(
          'SCOPE',
          `Your connection's scope is ${actor.scope ?? 'unknown'} now: a job is resumed at scope write only. Ask the owner to resume it on the dashboard's Jobs page.`,
        );
    }
    const revert = this.d.revertState?.(projectId, jobId) ?? null;
    if (revert)
      return no(
        revert === 'succeeded' ? 'REVERTED' : revert === 'stopped' ? 'REVERT_STOPPED' : 'REVERT_RUNNING',
        revert === 'succeeded'
          ? `Job ${jobId} has been reverted: what it did was undone, so it is not resumed. Plan the work again.`
          : revert === 'stopped'
            ? // CR-2026-11-R3 (R3-45): a revert that failed or was cancelled may have put some of it back already.
              `A revert of job ${jobId} stopped part-way, so some of what it did may be undone already: it is not resumed. Look at the revert on the Review page.`
            : `A revert of job ${jobId} is running: it is not resumed.`,
      );
    const proposal = this.d.proposals.byJob(projectId, jobId);
    if (proposal && proposal.state === 'conflicted')
      return no(
        'PROPOSAL_CONFLICTED',
        `Proposal ${proposal.id} is conflicted: what it was planned on changed before anything was written. Reject it and plan again.`,
      );
    // CR-2026-11-R3 (R3-13): an approved job continues only while its approval stands: its proposal failed part-way (or
    // is still executing). A proposal the owner rejected (a conflicted one, say), or one that expired, approves nothing
    // any more: its job is never resumed under the old approval.
    if (proposal && proposal.state !== 'failed' && proposal.state !== 'executing')
      return no(
        'PROPOSAL_NOT_APPROVED',
        `Proposal ${proposal.id} is ${proposal.state}: its approval no longer stands, so its job is not resumed. Plan the work again.`,
      );
    const left =
      r.kind === 'recreate'
        ? []
        : job.steps
            .filter((s) => s.status !== 'succeeded')
            .map((s) => ({ stepNo: s.stepNo, op: s.opId, status: s.status }));
    if (r.kind !== 'recreate' && left.length === 0)
      return no('NOTHING_LEFT', `Every step of job ${jobId} has succeeded: nothing is left to do.`);
    if (r.kind === 'recreate' && (!r.ref || !this.d.finishRecreate))
      return no(
        'NOT_RESUMABLE',
        `The recreate of job ${jobId} cannot be finished here (its restore is not known).`,
      );
    const first = left[0]?.stepNo ?? Number.POSITIVE_INFINITY;
    return {
      resumable: true,
      reason: null,
      kind: r.kind,
      stop: this.stopOf(projectId, jobId),
      left,
      // CR-2026-11-R3 (R3-22): what the resume runs again first, as the engine will (numbered, and named checkers).
      recheck:
        r.kind === 'recreate' ? [] : this.d.engine.recheckSteps(projectId, jobId).filter((n) => n < first),
      approvedBy: job.approvedBy,
    };
  }

  /**
   * Resumes a job that stopped part-way (see the module comment). Throws `ResumeError` with the reason when it cannot.
   * `origin` is who asked (the dashboard's, or the agent's MCP origin): a recreate's new proposal is made with it.
   */
  async resume(
    projectId: string,
    jobId: string,
    actor: ResumeActor,
    origin: JobOrigin,
  ): Promise<ResumeResult> {
    const v = this.view(projectId, jobId, actor);
    if (!v.resumable || !v.kind)
      throw new ResumeError(v.reason?.code ?? 'NOT_RESUMABLE', v.reason?.message ?? 'It cannot be resumed.');
    const by = actor.kind === 'owner' ? 'owner' : actor.principalId;
    const stop = v.stop;
    const auditAfter = {
      kind: v.kind,
      lastVerifiedStep: stop?.lastVerifiedStep ?? null,
      stoppedStep: stop?.stoppedStep ?? null,
      approvedBy: v.approvedBy,
    };
    if (v.kind === 'recreate') {
      const r = this.resumableOf(projectId, jobId)!;
      const out = await this.d.finishRecreate!(projectId, r.ref!, origin, by);
      this.counted(projectId, jobId, by);
      this.d.audit(by, 'job.resume', jobId, undefined, {
        ...auditAfter,
        restoreId: r.ref,
        outcome: out.status,
        ...(out.status === 'proposal_captured' ? { proposalId: out.proposalId } : {}),
      });
      return out.status === 'nothing_to_do'
        ? { status: 'nothing_to_do', jobId, summary: out.summary }
        : { status: 'proposal_captured', jobId, proposalId: out.proposalId, summary: out.summary };
    }
    let done;
    try {
      done = this.d.engine.controls.resumeStopped(projectId, jobId);
    } catch (e) {
      throw new ResumeError('NOT_RESUMABLE', e instanceof Error ? e.message : String(e));
    }
    this.counted(projectId, jobId, by);
    const proposal = this.d.proposals.byJob(projectId, jobId);
    const reopened = proposal ? this.d.proposals.jobResumed(projectId, jobId) : false;
    this.d.audit(by, 'job.resume', jobId, undefined, {
      ...auditAfter,
      from: done.from,
      rechecked: done.rechecked,
      ...(proposal ? { proposalId: proposal.id, proposalReopened: reopened } : {}),
    });
    return { status: 'resumed', jobId, from: done.from, rechecked: done.rechecked, job: done.job };
  }

  private counted(projectId: string, jobId: string, by: string): void {
    this.d.db
      .prepare(
        `UPDATE job_stops SET resumes = resumes + 1, last_resumed_at = ?, last_resumed_by = ?
         WHERE project_id = ? AND job_id = ?`,
      )
      .run(this.d.now(), by, projectId, jobId);
  }
}
