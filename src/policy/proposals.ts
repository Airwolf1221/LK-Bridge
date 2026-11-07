/**
 * The proposal workflow (the real `ProposalSink`; docs/policy.md).
 *
 * Capture (an agent at scope `propose` asked for writes): params are validated with the registry schema, the guards
 * that do not write are dry-run (cascade confirmation, member admin, the unsupported-block guard), and for each
 * operation the target is READ through the engine (so through the governor, at the caller's priority) to record its
 * version, a fingerprint and the pre-state for a diff. The ordered operations are stored as ONE proposal. Nothing but
 * those reads is sent to LegendKeeper.
 *
 * States: pending → approved → executing → executed | failed; pending → rejected | expired; approved → conflicted.
 * Every transition is a compare-and-set on the current state, so a double click or a retry cannot act twice.
 *
 * Approve (owner only): refused while the bridge is read-only, writes are paused or it is draining (the proposal stays
 * pending). Every target is re-read and compared with what was captured; any change ends `conflicted`, naming the
 * operation, and nothing is executed. Otherwise the operations go to the engine as one `batch_ops` job (stop on error)
 * with the proposer as principal, `approvedBy: 'owner'` and an approval token (approval.ts) so the gate does not turn
 * them into a new proposal. Every guard runs again at execution.
 */
import { randomBytes } from 'node:crypto';
import type { PolicySettings } from '../config/policy.js';
import type { JobEngine } from '../jobs/engine.js';
import {
  DrainingError,
  InvalidParamsError,
  JobsError,
  LkOperationError,
  PolicyDeniedError,
  ReadOnlyError,
  UnknownOperationError,
} from '../jobs/errors.js';
import { assertNoUnsupportedLoss, checkSubmitGuards, unsupportedLoss } from '../jobs/guards.js';
import { READERS, opMeta } from '../jobs/op-meta.js';
import type { ProposalMeta, ProposalSink, ProposedOp } from '../jobs/policy.js';
import {
  TERMINAL_JOB_STATUSES,
  type JobOrigin,
  type JobView,
  type OpParams,
  type Principal,
  type StepOptions,
  type StepSpec,
} from '../jobs/types.js';
import { systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
import { getOperation, operationInputSchema, requireOperation } from '../lk/registry.js';
import type { OperationDef } from '../lk/registry-types.js';
import { canonicalJson, hashJson, issueApprovalToken } from './approval.js';
import { PolicyError } from './errors.js';
import type { PolicyStore } from './store.js';
import {
  FINAL_PROPOSAL_STATES,
  type CapturedTarget,
  type OwnerActor,
  type ProposalConflict,
  type ProposalFilter,
  type ProposalOpView,
  type ProposalState,
  type ProposalView,
} from './types.js';

/** Pre-state kept for the diff, per operation. Larger states keep only a prefix (the fingerprint is always whole). */
const PRE_STATE_MAX_BYTES = 512 * 1024;
const SUMMARY_MAX = 500;
const REASON_MAX = 1000;

type Row = Record<string, unknown>;

export interface ProposalServiceOptions {
  readonly store: PolicyStore;
  readonly settings: PolicySettings;
  /** LK_ALLOW_MEMBER_ADMIN, for the dry-run of the guards at capture. */
  readonly allowMemberAdmin: boolean;
  /** Timers for the expiry sweep (tests pass a FakeClock). Time itself comes from the store's `now`. */
  readonly clock?: Clock;
  readonly log?: { warn(o: Record<string, unknown>, m: string): void };
}

interface Snapshot {
  readonly exists: boolean;
  readonly version: string | null;
  readonly fingerprint: string;
  readonly state: unknown;
  readonly body: unknown;
}

export interface ProposalOpDetail extends ProposalOpView {
  /** The target as captured (capped; `preStateTruncated` says so). */
  readonly preState: unknown;
  readonly preStateTruncated: boolean;
  /** What the operation intends the target to look like. */
  readonly proposed: unknown;
  /** Top-level differences between `preState` and `proposed` (one entry for whole-value replaces). */
  readonly changes: readonly { path: string; before: unknown; after: unknown }[];
  /** `unsupported` block ids this operation would remove (always empty unless the agent allowed the loss). */
  readonly unsupportedLoss: readonly string[];
}

export interface ProposalDetail extends ProposalView {
  readonly ops: readonly ProposalOpDetail[];
}

/** What an agent may read about its own proposal. */
export interface AgentProposalView {
  readonly proposalId: string;
  readonly state: ProposalState;
  readonly summary: string;
  readonly title: string;
  readonly operations: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
  readonly jobId: string | null;
  readonly conflict: { readonly operation: number; readonly op: string; readonly reason: string } | null;
  readonly error: string | null;
}

export function newProposalId(): string {
  return `prop_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(v as string) as T;
  } catch {
    return fallback;
  }
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

function toView(r: Row, opCount: number): ProposalView {
  return {
    id: String(r.id),
    principalId: String(r.principal_id),
    principalLabel: String(r.principal_label),
    profile: String(r.profile),
    jobKind: r.job_kind as 'single_op' | 'batch_ops',
    title: String(r.title),
    priority: String(r.priority),
    summary: String(r.summary),
    state: r.state as ProposalState,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    expiresAt: Number(r.expires_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    rejectReason: (r.reject_reason as string | null) ?? null,
    jobId: (r.job_id as string | null) ?? null,
    conflict: parseJson<ProposalConflict | null>(r.conflict, null),
    error: parseJson<Record<string, unknown> | null>(r.error, null),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    opCount,
  };
}

/** Builds the read that shows an operation's target, from op-meta's reader (as the engine does before a write). */
export function readerTarget(opId: string, params: OpParams): CapturedTarget | null {
  const meta = opMeta(opId);
  // A create with a client id targets something that does not exist yet: nothing to capture or compare.
  if (!meta.reader || meta.verify === 'client-id') return null;
  const reader = READERS[meta.reader];
  const readOp = requireOperation(reader.op);
  const path: Record<string, string> = {};
  for (const m of readOp.pathTemplate.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    if (name === 'projectId') continue;
    const v = params.path?.[name];
    if (v === undefined) return null;
    path[name] = v;
  }
  const selectId = reader.selectBy ? params.path?.[reader.selectBy] : undefined;
  return { op: reader.op, path, ...(selectId !== undefined ? { selectId } : {}) };
}

function describe(opId: string, params: OpParams): string {
  const p = params.path ?? {};
  const id =
    p.blockId ??
    p.rowId ??
    p.propertyId ??
    p.laneId ??
    p.eventId ??
    p.featureId ??
    p.documentId ??
    p.resourceId;
  const name = (params.body as { name?: unknown } | undefined)?.name;
  return `${opId}${id ? ` on ${id}` : ''}${typeof name === 'string' ? ` ("${name.slice(0, 40)}")` : ''}`;
}

export function proposalSummary(ops: readonly { op: string; params: OpParams }[]): string {
  const parts = ops.map((o) => describe(o.op, o.params));
  const text =
    ops.length === 1 ? `Proposed ${parts[0]}` : `Proposed ${ops.length} operations: ${parts.join('; ')}`;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

export class ProposalService implements ProposalSink {
  private engine: JobEngine | undefined;
  private readonly clock: Clock;
  private sweepTimer: TimerHandle | undefined;
  private offJob: (() => void) | undefined;
  private offEmitter: (() => void) | undefined;

  constructor(private readonly o: ProposalServiceOptions) {
    this.clock = o.clock ?? systemClock;
  }

  private get store(): PolicyStore {
    return this.o.store;
  }

  private now(): number {
    return this.store.now();
  }

  // ============================================================================================ lifecycle

  /**
   * Connects the service to the engine it is the sink of: follows job outcomes, reconciles proposals left mid-approval
   * by a crash, and starts the expiry sweep. Returns `detach`.
   */
  attach(engine: JobEngine): () => void {
    this.detach();
    this.engine = engine;
    this.offEmitter = this.store.attachEmitter(engine.events);
    this.offJob = engine.events.on('job', (e) => {
      if (TERMINAL_JOB_STATUSES.has(e.job.status)) this.onJobFinished(e.job);
    });
    this.reconcile();
    this.expireDue();
    this.scheduleSweep();
    return () => this.detach();
  }

  detach(): void {
    this.offJob?.();
    this.offEmitter?.();
    this.offJob = undefined;
    this.offEmitter = undefined;
    if (this.sweepTimer) this.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    this.engine = undefined;
  }

  private requireEngine(): JobEngine {
    if (!this.engine)
      throw new PolicyError('NO_ENGINE', 'The proposal service is not attached to a job engine');
    return this.engine;
  }

  private scheduleSweep(): void {
    this.sweepTimer = this.clock.setTimeout(() => {
      try {
        this.expireDue();
      } catch (e) {
        this.o.log?.warn({ err: e }, 'proposal expiry sweep failed');
      }
      if (this.engine) this.scheduleSweep();
    }, this.o.settings.expirySweepMs);
  }

  // ============================================================================================ capture (sink)

  async capture(
    principal: Principal,
    ops: readonly ProposedOp[],
    meta: ProposalMeta,
  ): Promise<{ proposalId: string; summary: string }> {
    const engine = this.requireEngine();
    if (meta.kind !== 'single_op' && meta.kind !== 'batch_ops') {
      throw new PolicyDeniedError(
        ops[0]?.op ?? 'operation',
        'only operations and batches can be proposed',
        principal.principalId,
      );
    }
    if (ops.length === 0) throw new InvalidParamsError('batch_ops', [{ path: 'steps', message: 'Empty' }]);
    const batch = meta.kind === 'batch_ops';

    // 1. Validate, and dry-run the guards that do not write.
    const defs: OperationDef[] = ops.map((o, i) => {
      const def = getOperation(o.op);
      if (!def) throw new UnknownOperationError(o.op);
      const parsed = operationInputSchema(o.op).safeParse(o.params);
      if (!parsed.success) {
        throw new InvalidParamsError(
          o.op,
          parsed.error.issues.map((x) => ({
            path: `${batch ? `steps[${i}].` : ''}${x.path.map(String).join('.')}`,
            message: x.message,
          })),
        );
      }
      checkSubmitGuards(def, o.params, stepOptions(o), {
        readOnly: false,
        allowMemberAdmin: this.o.allowMemberAdmin,
      });
      return def;
    });

    // 2. Capture each target through the engine (governor, caller's priority). Reads only.
    const readOrigin: JobOrigin = {
      kind: meta.origin.kind,
      ...(meta.origin.client !== undefined ? { client: meta.origin.client } : {}),
      tool: 'proposal_capture',
      principal,
    };
    const seen = new Map<string, Snapshot>();
    const captured: { target: CapturedTarget | null; snap: Snapshot | null }[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      const target = readerTarget(o.op, o.params);
      if (!target) {
        captured.push({ target: null, snap: null });
        continue;
      }
      const key = canonicalJson(target);
      let snap = seen.get(key);
      if (!snap) {
        snap = await this.snapshot(engine, target, readOrigin, meta.priority);
        seen.set(key, snap);
      }
      const om = opMeta(o.op);
      if (om.guard && snap.exists) {
        const incoming =
          om.guard === 'document' ? (o.params.body as { blocks?: unknown })?.blocks : o.params.body;
        const existing = om.guard === 'document' ? (snap.body as { blocks?: unknown })?.blocks : snap.body;
        assertNoUnsupportedLoss(o.op, existing, incoming, stepOptions(o));
      }
      captured.push({ target, snap });
    }

    // 3. Store the ordered operations as one proposal.
    const id = newProposalId();
    const now = this.now();
    const summary = proposalSummary(ops);
    const origin = sanitiseOrigin(meta.origin);
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO proposals (id, principal_id, principal_label, profile, origin, job_kind, title, priority,
             on_error, summary, state, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          principal.principalId,
          principal.label.slice(0, 200),
          principal.profile,
          JSON.stringify(origin),
          meta.kind,
          meta.title.slice(0, 500),
          meta.priority,
          meta.onError ?? 'stop',
          summary,
          now,
          now,
          now + this.o.settings.proposalExpiryMs,
        );
      const insert = this.store.db.prepare(
        `INSERT INTO proposal_ops (proposal_id, idx, op_id, op_kind, params, params_hash, options, target,
           target_exists, version, fingerprint, pre_state, pre_state_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      ops.forEach((o, i) => {
        const c = captured[i]!;
        const pre = c.snap ? capJson(c.snap.state) : { text: null, truncated: false };
        insert.run(
          id,
          i,
          o.op,
          defs[i]!.kind,
          JSON.stringify(o.params),
          hashJson(o.params),
          JSON.stringify(stepOptions(o)),
          c.target ? JSON.stringify(c.target) : null,
          c.snap ? (c.snap.exists ? 1 : 0) : null,
          c.snap?.version ?? null,
          c.snap?.fingerprint ?? null,
          pre.text,
          pre.truncated ? 1 : 0,
        );
      });
    });
    this.store.emit('proposal', {
      type: 'captured',
      proposalId: id,
      state: 'pending',
      principalId: principal.principalId,
      profile: principal.profile,
      jobId: null,
    });
    return { proposalId: id, summary };
  }

  /** Reads one target through the engine and fingerprints what the operation would act on. */
  private async snapshot(
    engine: JobEngine,
    target: CapturedTarget,
    origin: JobOrigin,
    priority: ProposalMeta['priority'],
  ): Promise<Snapshot> {
    let body: unknown;
    try {
      const r = await engine.run(
        target.op,
        { path: target.path },
        { origin, priority, title: 'proposal read' },
      );
      if (r.status !== 'succeeded') {
        throw new JobsError(
          'BRIDGE_ERROR',
          `Could not read ${target.op} now (${r.status}); try again shortly`,
        );
      }
      body = r.result;
    } catch (e) {
      if (e instanceof LkOperationError && e.lk.status === 404) {
        return { exists: false, version: null, fingerprint: hashJson(null), state: null, body: undefined };
      }
      throw e;
    }
    const reader = Object.values(READERS).find((x) => x.op === target.op)!;
    let entity: unknown = body;
    if (reader.list) {
      const data = (body as { data?: unknown } | undefined)?.data;
      entity =
        target.selectId !== undefined && Array.isArray(data)
          ? (data as { id?: unknown }[]).find((x) => x?.id === target.selectId)
          : reader.selectBy
            ? undefined
            : body;
    }
    const version = reader.version?.(body, entity) ?? null;
    return {
      exists: entity !== undefined,
      version,
      fingerprint: hashJson(entity ?? null),
      state: entity ?? null,
      body,
    };
  }

  // ============================================================================================ decisions

  /**
   * Approves a pending proposal (owner command layer only). Resolves with the proposal as it then stands:
   * `executing` (with its job id), or `conflicted`. Throws `PolicyError` when it cannot be approved now; the proposal
   * then stays `pending`.
   */
  async approve(actor: OwnerActor, id: string): Promise<ProposalView> {
    assertOwner(actor);
    const engine = this.requireEngine();
    const p = this.require(id);
    if (p.state === 'pending' && p.expiresAt <= this.now()) {
      this.expireOne(id);
      throw new PolicyError('PROPOSAL_EXPIRED', `Proposal ${id} has expired`);
    }
    if (p.state !== 'pending') {
      throw new PolicyError('INVALID_TRANSITION', `Proposal ${id} is ${p.state}, not pending`);
    }
    const controls = engine.queries.controls();
    if (controls.readOnly) {
      throw new PolicyError(
        'BRIDGE_READ_ONLY',
        'The bridge is in read-only mode; the proposal stays pending',
      );
    }
    if (controls.writesPaused) {
      throw new PolicyError('WRITES_PAUSED', 'Writes are paused; the proposal stays pending');
    }
    if (controls.draining) {
      throw new PolicyError('DRAINING', 'The bridge is draining; the proposal stays pending');
    }
    // Compare-and-set: only one approval can ever win.
    if (!this.transition(id, ['pending'], 'approved', { decided_at: this.now(), decided_by: 'owner' })) {
      throw new PolicyError('INVALID_TRANSITION', `Proposal ${id} is no longer pending`);
    }
    this.store.audit('owner', 'proposal.approve', id, { state: 'pending' }, { state: 'approved' });

    // Re-read every target; any change since capture means conflict, and nothing runs.
    const ops = this.opRows(id);
    const systemOrigin: JobOrigin = {
      kind: 'ui',
      client: 'owner',
      tool: 'proposal_approval',
      detail: `proposal:${id}`,
    };
    const current = new Map<string, Snapshot>();
    try {
      for (const op of ops) {
        if (!op.target) continue;
        const key = canonicalJson(op.target);
        let snap = current.get(key);
        if (!snap) {
          snap = await this.snapshot(engine, op.target, systemOrigin, 'P0');
          current.set(key, snap);
        }
        const changed =
          snap.exists !== op.targetExists ||
          (op.version !== null ? snap.version !== op.version : snap.fingerprint !== op.fingerprint);
        if (changed) {
          const conflict: ProposalConflict = {
            index: op.index,
            op: op.op,
            reason: !snap.exists
              ? 'the target no longer exists'
              : op.targetExists === false
                ? 'the target now exists'
                : 'the target changed after the proposal was made',
            capturedVersion: op.version,
            currentVersion: snap.version,
          };
          this.transition(id, ['approved'], 'conflicted', {
            conflict: JSON.stringify(conflict),
            finished_at: this.now(),
          });
          this.store.audit(
            'system',
            'proposal.conflicted',
            id,
            { state: 'approved' },
            { state: 'conflicted', conflict },
          );
          return this.require(id);
        }
      }
    } catch (e) {
      this.transition(id, ['approved'], 'pending', { decided_at: null, decided_by: null });
      this.store.audit(
        'system',
        'proposal.approval_reverted',
        id,
        { state: 'approved' },
        { state: 'pending' },
      );
      throw new PolicyError(
        'REREAD_FAILED',
        `Could not re-read the proposal's targets, so nothing was executed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Submit the approved batch with a token bound to this proposal.
    const steps = executionSteps(ops);
    const token = issueApprovalToken(
      id,
      p.principalId,
      steps.map((s) => ({ op: s.op, paramsHash: hashJson(s.params ?? {}) })),
      this.now(),
    );
    const principal: Principal = { principalId: p.principalId, profile: p.profile, label: p.principalLabel };
    let result: Awaited<ReturnType<JobEngine['submit']>>;
    try {
      result = await engine.submit({
        kind: 'batch_ops',
        steps,
        onError: 'stop',
        priority: p.priority as ProposalMeta['priority'],
        title: `Approved ${id}: ${p.title}`.slice(0, 500),
        origin: { ...systemOrigin, principal, approvedBy: 'owner', approval: token },
      });
    } catch (e) {
      token.consume();
      if (e instanceof ReadOnlyError || e instanceof DrainingError) {
        this.transition(id, ['approved'], 'pending', { decided_at: null, decided_by: null });
        this.store.audit(
          'system',
          'proposal.approval_reverted',
          id,
          { state: 'approved' },
          { state: 'pending' },
        );
        throw new PolicyError(
          e instanceof ReadOnlyError ? 'BRIDGE_READ_ONLY' : 'DRAINING',
          `${e.message}; the proposal stays pending`,
        );
      }
      const error =
        e instanceof JobsError ? e.toJSON() : { message: e instanceof Error ? e.message : String(e) };
      this.transition(id, ['approved'], 'failed', { error: JSON.stringify(error), finished_at: this.now() });
      this.store.audit('system', 'proposal.failed', id, { state: 'approved' }, { state: 'failed', error });
      return this.require(id);
    }
    token.consume();
    if (!('jobId' in result)) {
      // Must never happen (the token makes the gate allow); never let approval create a proposal silently.
      const error = {
        code: 'APPROVAL_LOOP',
        message: `The engine asked for approval again (${result.proposalId})`,
      };
      this.transition(id, ['approved'], 'failed', { error: JSON.stringify(error), finished_at: this.now() });
      this.store.audit('system', 'proposal.failed', id, { state: 'approved' }, { state: 'failed', error });
      return this.require(id);
    }
    this.transition(id, ['approved'], 'executing', { job_id: result.jobId });
    const job = engine.queries.getJob(result.jobId);
    if (job && TERMINAL_JOB_STATUSES.has(job.status)) this.onJobFinished(job);
    return this.require(id);
  }

  /** Rejects a pending proposal with an optional reason the agent can read (owner command layer only). */
  reject(actor: OwnerActor, id: string, reason?: string): ProposalView {
    assertOwner(actor);
    const p = this.require(id);
    if (p.state !== 'pending') {
      throw new PolicyError('INVALID_TRANSITION', `Proposal ${id} is ${p.state}, not pending`);
    }
    const why = reason?.trim().slice(0, REASON_MAX) || null;
    if (
      !this.transition(id, ['pending'], 'rejected', {
        decided_at: this.now(),
        decided_by: 'owner',
        reject_reason: why,
        finished_at: this.now(),
      })
    ) {
      throw new PolicyError('INVALID_TRANSITION', `Proposal ${id} is no longer pending`);
    }
    this.store.audit(
      'owner',
      'proposal.reject',
      id,
      { state: 'pending' },
      { state: 'rejected', reason: why },
    );
    return this.require(id);
  }

  /** Expires every pending proposal past its expiry. Returns how many. */
  expireDue(): number {
    const due = this.store.db
      .prepare(`SELECT id FROM proposals WHERE state = 'pending' AND expires_at <= ?`)
      .all(this.now()) as { id: string }[];
    let n = 0;
    for (const { id } of due) if (this.expireOne(id)) n++;
    return n;
  }

  private expireOne(id: string): boolean {
    const ok = this.transition(id, ['pending'], 'expired', {
      decided_at: this.now(),
      decided_by: 'system',
      finished_at: this.now(),
    });
    if (ok) this.store.audit('system', 'proposal.expired', id, { state: 'pending' }, { state: 'expired' });
    return ok;
  }

  // ============================================================================================ execution outcome

  private onJobFinished(job: JobView): void {
    const row = this.store.db
      .prepare(`SELECT id FROM proposals WHERE job_id = ? AND state = 'executing'`)
      .get(job.id) as { id: string } | undefined;
    if (!row) return;
    if (job.status === 'succeeded') {
      if (this.transition(row.id, ['executing'], 'executed', { finished_at: this.now() })) {
        this.store.audit(
          'system',
          'proposal.executed',
          row.id,
          { state: 'executing' },
          { state: 'executed', jobId: job.id },
        );
      }
      return;
    }
    const error = {
      code: job.status === 'cancelled' ? 'JOB_CANCELLED' : 'JOB_FAILED',
      message: `Job ${job.id} ended ${job.status}${job.lastError ? `: ${job.lastError.message}` : ''}`,
      jobId: job.id,
      stepsDone: job.progress.stepsDone,
      stepsTotal: job.progress.stepsTotal,
    };
    if (
      this.transition(row.id, ['executing'], 'failed', {
        error: JSON.stringify(error),
        finished_at: this.now(),
      })
    ) {
      this.store.audit(
        'system',
        'proposal.failed',
        row.id,
        { state: 'executing' },
        { state: 'failed', error },
      );
    }
  }

  /**
   * After a restart: a proposal left `approved` either reached the engine (its job is found by the origin it was
   * submitted with, and the proposal follows it) or did not (it goes back to `pending`; nothing was sent). A proposal
   * left `executing` follows its job, which the engine resumes on its own.
   */
  reconcile(): void {
    const engine = this.requireEngine();
    const rows = this.store.db
      .prepare(
        `SELECT id, state, principal_id, job_id FROM proposals WHERE state IN ('approved', 'executing')`,
      )
      .all() as { id: string; state: string; principal_id: string; job_id: string | null }[];
    for (const r of rows) {
      let jobId = r.job_id;
      if (r.state === 'approved') {
        const found = this.store.db
          .prepare(
            `SELECT id FROM jobs WHERE approved_by IS NOT NULL AND principal_id = ?
               AND json_extract(origin, '$.detail') = ? ORDER BY created_at LIMIT 1`,
          )
          .get(r.principal_id, `proposal:${r.id}`) as { id: string } | undefined;
        if (!found) {
          if (this.transition(r.id, ['approved'], 'pending', { decided_at: null, decided_by: null })) {
            this.store.audit(
              'system',
              'proposal.approval_interrupted',
              r.id,
              { state: 'approved' },
              { state: 'pending' },
            );
          }
          continue;
        }
        jobId = found.id;
        this.transition(r.id, ['approved'], 'executing', { job_id: jobId });
      }
      const job = jobId ? engine.queries.getJob(jobId) : undefined;
      if (!job) {
        const error = { code: 'JOB_MISSING', message: `Job ${jobId ?? '(none)'} was not found` };
        this.transition(r.id, ['executing'], 'failed', {
          error: JSON.stringify(error),
          finished_at: this.now(),
        });
        continue;
      }
      if (TERMINAL_JOB_STATUSES.has(job.status)) this.onJobFinished(job);
    }
  }

  // ============================================================================================ queries

  state(id: string): ProposalState | undefined {
    const r = this.store.db.prepare('SELECT state FROM proposals WHERE id = ?').get(id) as
      { state: ProposalState } | undefined;
    return r?.state;
  }

  get(id: string): ProposalView | undefined {
    const r = this.store.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Row | undefined;
    return r ? toView(r, this.opCount(id)) : undefined;
  }

  list(filter: ProposalFilter = {}): ProposalView[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.state !== undefined) {
      const states = typeof filter.state === 'string' ? [filter.state] : [...filter.state];
      if (states.length === 0) return [];
      where.push(`state IN (${states.map(() => '?').join(',')})`);
      vals.push(...states);
    }
    if (filter.principalId !== undefined) {
      where.push('principal_id = ?');
      vals.push(filter.principalId);
    }
    if (filter.profile !== undefined) {
      where.push('profile = ? COLLATE NOCASE');
      vals.push(filter.profile);
    }
    if (filter.before !== undefined) {
      where.push('created_at < ?');
      vals.push(filter.before);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const rows = this.store.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM proposal_ops o WHERE o.proposal_id = p.id) AS op_count
         FROM proposals p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...vals, limit) as Row[];
    return rows.map((r) => toView(r, Number(r.op_count)));
  }

  /** The proposal with each operation's captured pre-state, the proposed state and the differences. */
  detail(id: string): ProposalDetail | undefined {
    const p = this.get(id);
    if (!p) return undefined;
    const rows = this.store.db
      .prepare('SELECT * FROM proposal_ops WHERE proposal_id = ? ORDER BY idx')
      .all(id) as Row[];
    const ops = rows.map((r): ProposalOpDetail => {
      const base = toOpView(r);
      const truncated = Number(r.pre_state_truncated) === 1;
      const pre = truncated ? ((r.pre_state as string | null) ?? '') : parseJson<unknown>(r.pre_state, null);
      const params = base.params as OpParams;
      const meta = opMeta(base.op);
      const proposed = meta.intent ? meta.intent(params) : params.body;
      const before = !truncated && meta.actual && pre !== null ? meta.actual(pre, pre) : pre;
      const guardOld = meta.guard === 'document' ? (pre as { blocks?: unknown } | null)?.blocks : pre;
      const guardNew =
        meta.guard === 'document' ? (params.body as { blocks?: unknown })?.blocks : params.body;
      return {
        ...base,
        preState: pre,
        preStateTruncated: truncated,
        proposed: proposed ?? null,
        changes: truncated ? [] : diff(before, proposed),
        unsupportedLoss: meta.guard && !truncated && pre !== null ? unsupportedLoss(guardOld, guardNew) : [],
      };
    });
    return { ...p, ops };
  }

  /** The agent-facing view (no params, no pre-state: an agent reads its own proposal's status only). */
  agentView(p: ProposalView): AgentProposalView {
    return {
      proposalId: p.id,
      state: p.state,
      summary: p.summary,
      title: p.title,
      operations: p.opCount,
      createdAt: iso(p.createdAt)!,
      expiresAt: iso(p.expiresAt)!,
      decidedAt: iso(p.decidedAt),
      rejectReason: p.rejectReason,
      jobId: p.jobId,
      conflict: p.conflict
        ? { operation: p.conflict.index + 1, op: p.conflict.op, reason: p.conflict.reason }
        : null,
      error: p.error ? errorText(p.error) : null,
    };
  }

  isFinal(state: ProposalState): boolean {
    return FINAL_PROPOSAL_STATES.has(state);
  }

  // ============================================================================================ helpers

  private require(id: string): ProposalView {
    const p = this.get(id);
    if (!p) throw new PolicyError('PROPOSAL_NOT_FOUND', `No proposal ${id}`);
    return p;
  }

  private opCount(id: string): number {
    const r = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM proposal_ops WHERE proposal_id = ?')
      .get(id) as {
      n: number;
    };
    return Number(r.n);
  }

  private opRows(id: string): ProposalOpView[] {
    return (
      this.store.db.prepare('SELECT * FROM proposal_ops WHERE proposal_id = ? ORDER BY idx').all(id) as Row[]
    ).map(toOpView);
  }

  /** Compare-and-set on the state; emits the `proposal` event when it applies. */
  private transition(
    id: string,
    from: readonly ProposalState[],
    to: ProposalState,
    fields: Record<string, string | number | null> = {},
  ): boolean {
    const keys = Object.keys(fields);
    const sets = ['state = ?', 'updated_at = ?', ...keys.map((k) => `${k} = ?`)];
    const res = this.store.db
      .prepare(
        `UPDATE proposals SET ${sets.join(', ')} WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`,
      )
      .run(to, this.now(), ...keys.map((k) => fields[k]), id, ...from);
    if (res.changes !== 1) return false;
    const p = this.get(id)!;
    this.store.emit('proposal', {
      type: 'updated',
      proposalId: id,
      state: to,
      principalId: p.principalId,
      profile: p.profile,
      jobId: p.jobId,
    });
    return true;
  }
}

function errorText(e: Record<string, unknown>): string {
  for (const v of [e.message, e.code]) if (typeof v === 'string' && v !== '') return v;
  return 'failed';
}

function toOpView(r: Row): ProposalOpView {
  return {
    index: Number(r.idx),
    op: String(r.op_id),
    opKind: String(r.op_kind),
    params: parseJson<unknown>(r.params, {}),
    options: parseJson<Record<string, unknown>>(r.options, {}),
    target: parseJson<CapturedTarget | null>(r.target, null),
    targetExists: r.target_exists === null ? null : Number(r.target_exists) === 1,
    version: (r.version as string | null) ?? null,
    fingerprint: (r.fingerprint as string | null) ?? null,
  };
}

/**
 * The steps submitted on approval. A versioned write whose target version was captured, and that no earlier operation
 * of the same proposal touches first, is pinned to that version (`ifMatch`): LegendKeeper then refuses it if the
 * document changed between the re-read and the write.
 */
function executionSteps(ops: readonly ProposalOpView[]): StepSpec[] {
  const touched = new Set<string>();
  return ops.map((op) => {
    const params = op.params as OpParams;
    const def = requireOperation(op.op);
    const keys = [params.path?.resourceId, params.path?.documentId].filter((k): k is string => !!k);
    let p: OpParams = params;
    if (
      def.versioned &&
      params.ifMatch === undefined &&
      op.version !== null &&
      !keys.some((k) => touched.has(k))
    ) {
      p = { ...params, ifMatch: op.version };
    }
    if (def.kind !== 'read') for (const k of keys) touched.add(k);
    return { op: op.op, params: p, ...(op.options as StepOptions) };
  });
}

function stepOptions(o: StepOptions): StepOptions {
  return {
    ...(o.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
    ...(o.confirm === 'cascade' ? { confirm: 'cascade' as const } : {}),
  };
}

/** The origin as stored with a proposal: never an approval or `approvedBy` (they cannot come from an agent). */
function sanitiseOrigin(o: JobOrigin): JobOrigin {
  return {
    kind: o.kind,
    ...(o.client !== undefined ? { client: String(o.client).slice(0, 200) } : {}),
    ...(o.tool !== undefined ? { tool: String(o.tool).slice(0, 100) } : {}),
    ...(o.detail !== undefined ? { detail: String(o.detail).slice(0, 500) } : {}),
    ...(o.principal ? { principal: o.principal } : {}),
  };
}

function capJson(v: unknown): { text: string | null; truncated: boolean } {
  const text = JSON.stringify(v ?? null);
  if (Buffer.byteLength(text) <= PRE_STATE_MAX_BYTES) return { text, truncated: false };
  return { text: text.slice(0, PRE_STATE_MAX_BYTES), truncated: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Top-level differences: changed keys of an object patch, or one whole-value change. */
function diff(before: unknown, after: unknown): { path: string; before: unknown; after: unknown }[] {
  if (after === undefined) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    return Object.keys(after)
      .filter((k) => canonicalJson(before[k]) !== canonicalJson(after[k]))
      .map((k) => ({ path: k, before: before[k] ?? null, after: after[k] }));
  }
  return canonicalJson(before) === canonicalJson(after) ? [] : [{ path: '', before: before ?? null, after }];
}

function assertOwner(actor: unknown): asserts actor is OwnerActor {
  if (actor !== 'owner') throw new PolicyError('NOT_OWNER', 'Only the owner can do this');
}
