/**
 * The write guard hook (v2 C2a, ADR 0032): a check the engine makes on EVERY write path, besides the policy gate. The
 * protected canonical facts rule (src/facts/canonical.ts) is the one guard today: a write that would make a
 * protected change becomes a proposal that needs the owner's canonical approval, whatever the caller's scope.
 *
 * The engine calls it twice:
 * - `entry`, once per `run` / `submit`, with every operation of the request, after the policy gate allowed or proposed
 *   each one (a denied request never reaches it). It may allow, deny (nothing is queued) or force a proposal flagged
 *   for canonical approval. It sees the whole request at once, so a batch is judged as the sequence it is.
 * - `inLock`, before each write step is sent, inside the step's lock, with the read the engine made there (if any).
 *   It throws a `JobsError` (normally `CanonicalApprovalRequiredError`) to refuse; nothing is sent then.
 *
 * A guard that throws at entry counts as a deny (fail closed).
 */
import type {
  JobKind,
  JobOrigin,
  JobView,
  LifecycleMarker,
  OnError,
  OpParams,
  Principal,
  StepOptions,
  StepView,
} from './types.js';
import type { ProposalExtras } from './policy.js';
import { SYSTEM_PRINCIPAL } from './types.js';

export interface WriteGuardEntry {
  readonly project: string;
  readonly principal: Principal;
  readonly origin: JobOrigin;
  readonly jobKind: JobKind;
  readonly items: readonly {
    readonly op: string;
    readonly params: OpParams;
    readonly options: StepOptions;
  }[];
  /** Reads the calling tool already made in this call (the guard may use them instead of reading again). */
  readonly prefetched?: ProposalExtras['prefetched'];
  /** The policy gate's verdict for the request: `allow` (scope write, or approved work) or `propose`. */
  readonly gate: 'allow' | 'propose';
  /**
   * v3 F12 (ADR 0081): the request runs directly whatever a guard would otherwise have proposed (`directWrite`): an
   * agent at scope `write`, or the owner's confirmed dashboard action. For it a guard answers `allow` or `deny`, NEVER
   * `propose` or `propose_canonical`: a refusal of an invalid change still refuses, only "propose" becomes "allow".
   */
  readonly direct?: boolean;
  /** v2 C2c: the lifecycle change the request declares (bridge code only: `BatchSubmit.lifecycle`). */
  readonly lifecycle?: LifecycleMarker;
  /**
   * CR-2026-11 (CR-08): what the batch does after a failed step. With `continue`, a step the entry check simulated may
   * fail and the steps after it still run, so the guards also judge each write on the page as it is now.
   */
  readonly onError?: OnError;
}

export type WriteGuardVerdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string; readonly opId: string; readonly stepIndex?: number }
  /** Turn the request into a proposal that only the owner's canonical approval can run. */
  | { readonly decision: 'propose_canonical'; readonly reason: string; readonly changes: readonly unknown[] }
  /**
   * CR-2026-11-R4 (ADR 0065 amendment 2): turn the request into an ORDINARY proposal, whatever the scope (a page moved
   * into or out of Narratives): the owner's ordinary approval runs it. The reason is the proposal's `proposedBecause`.
   */
  | { readonly decision: 'propose'; readonly reason: string; readonly changes: readonly unknown[] };

export interface WriteGuardInLock {
  readonly job: JobView;
  readonly step: StepView;
  readonly opId: string;
  readonly params: OpParams;
  /** v2 C2c: the job's stored options (its lifecycle marker, when it is a lifecycle job). */
  readonly jobOptions?: Readonly<Record<string, unknown>>;
  /** The read the engine made inside the lock for this step (its reader), when it made one. */
  readonly current: { readonly body: unknown; readonly entity: unknown } | undefined;
  /** One more governed read, inside the lock, for the job (counted against its budget). */
  read(opId: string, params: OpParams): Promise<unknown>;
}

export interface WriteGuard {
  entry(input: WriteGuardEntry): Promise<WriteGuardVerdict> | WriteGuardVerdict;
  inLock?(input: WriteGuardInLock): Promise<void> | void;
}

/**
 * v2 C2c (ADR 0035): several guards as one (v3 F12: for a `direct` request, allow or deny only). At entry, the first deny wins; otherwise any `propose_canonical` makes the
 * request a canonical proposal (the reasons and changes of all of them together, an ordinary proposal's included);
 * otherwise any `propose` makes it an ordinary proposal; otherwise allow. Inside the lock each guard is asked in turn
 * (the first to throw refuses).
 */
export function combineGuards(...guards: readonly WriteGuard[]): WriteGuard {
  return {
    async entry(input) {
      const proposals: { reason: string; changes: readonly unknown[]; canonical: boolean }[] = [];
      for (const g of guards) {
        const v = await g.entry(input);
        if (v.decision === 'deny') return v;
        // v3 F12 (ADR 0081): a direct request is answered allow or deny; a guard that still proposes is a bridge fault,
        // refused (fail closed) rather than turned into a proposal nobody asked for.
        if (input.direct === true && v.decision !== 'allow')
          return {
            decision: 'deny',
            opId: input.items[0]?.op ?? 'operation',
            reason: `a write guard asked for a proposal of a direct write (${v.reason}); this is a bridge fault, nothing was written`,
          };
        if (v.decision === 'propose_canonical' || v.decision === 'propose')
          proposals.push({
            reason: v.reason,
            changes: v.changes,
            canonical: v.decision === 'propose_canonical',
          });
      }
      if (proposals.length === 0) return { decision: 'allow' };
      return {
        decision: proposals.some((p) => p.canonical) ? 'propose_canonical' : 'propose',
        reason: proposals.map((p) => p.reason).join('; and '),
        changes: proposals.flatMap((p) => p.changes),
      };
    },
    async inLock(input) {
      for (const g of guards) await g.inLock?.(input);
    },
  };
}

/** The automation engine's principal (`AUTOMATION_PRINCIPAL` in types.ts; kept as a literal to avoid a cycle). */
const AUTOMATION_PRINCIPAL_ID = 'automation';

/** v3 F6d follow-up: the owner's automation at Apply (the marker on the Automation principal's maintenance origin). */
function automationApply(principalId: string, origin: Pick<JobOrigin, 'kind' | 'automationApply'>): boolean {
  return (
    principalId === AUTOMATION_PRINCIPAL_ID &&
    origin.kind === 'maintenance' &&
    origin.automationApply === true
  );
}

/** An agent's own principal: neither the bridge's (`system`) nor the automation engine's. */
function isAgentPrincipal(principalId: string): boolean {
  return principalId !== SYSTEM_PRINCIPAL.principalId && principalId !== AUTOMATION_PRINCIPAL_ID;
}

/**
 * v3 F12 (ADR 0081): whether a request runs directly, at entry. Two kinds of work do, canon and lifecycle changes
 * included, so the guards answer them `allow` or `deny`, never a proposal:
 *
 * - an agent's request the policy gate allowed (scope `write`) that no approval carries and bridge code did not force
 *   into a proposal;
 * - the owner's confirmed dashboard action (`origin.ownerConfirmed`, the system principal on a dashboard origin);
 * - v3 F6d follow-up (the owner's ruling; ADR 0057 decision 5 and ADR 0081 amended): the owner's automation at Apply
 *   (`origin.automationApply`, the Automation principal on a maintenance origin): the owner's Apply setting is the
 *   approval. Its codes at Propose force proposals, so they never reach this as `allow`.
 *
 * Work at scope `propose` is a proposal at the gate and never reaches this as `allow`.
 */
export function directWrite(input: {
  readonly principal: { readonly principalId: string };
  readonly origin: Pick<JobOrigin, 'kind' | 'approval' | 'approvedBy' | 'ownerConfirmed' | 'automationApply'>;
  readonly gate: 'allow' | 'propose';
}): boolean {
  if (input.gate !== 'allow') return false;
  if (input.origin.approval !== undefined || input.origin.approvedBy !== undefined) return false;
  if (isAgentPrincipal(input.principal.principalId)) return true;
  if (automationApply(input.principal.principalId, input.origin)) return true;
  return (
    input.principal.principalId === SYSTEM_PRINCIPAL.principalId &&
    input.origin.kind === 'ui' &&
    input.origin.ownerConfirmed === true
  );
}

/**
 * v3 F12 (ADR 0081): the same, inside the lock, for a job that is running: an agent's job no owner approved (it ran
 * past entry only at scope `write`, and the gate is asked again before every step, so a lowered scope stops it), or the
 * owner's confirmed dashboard action. The guards let such a job make the canon and lifecycle changes they judged at
 * entry, as a job approved as canon makes them.
 */
export function directJob(job: Pick<JobView, 'principalId' | 'approvedBy' | 'origin'>): boolean {
  if (job.approvedBy !== null || job.origin.canonicalApprovedBy !== undefined) return false;
  if (isAgentPrincipal(job.principalId)) return true;
  if (automationApply(job.principalId, job.origin)) return true;
  return (
    job.principalId === SYSTEM_PRINCIPAL.principalId &&
    job.origin.kind === 'ui' &&
    job.origin.ownerConfirmed === true
  );
}

/** Inside the lock: the job may make protected canon changes (approved as canon, or a direct job, F12). */
export function canonAccepted(job: Pick<JobView, 'principalId' | 'approvedBy' | 'origin'>): boolean {
  return job.origin.canonicalApprovedBy !== undefined || directJob(job);
}

/**
 * v2 E1a (ADR 0042): a proposal bridge code forces from the dashboard (the owner's own request, such as "Propose a
 * restore"): the system principal, a dashboard origin, and the gate's `propose` (which, for the system principal, only a
 * forced proposal gives). Nothing is written until the owner approves it.
 */
export function ownerForcedProposal(input: {
  readonly principal: { readonly principalId: string };
  readonly origin: { readonly kind: string; readonly approval?: unknown };
  readonly gate: 'allow' | 'propose';
}): boolean {
  return (
    input.principal.principalId === SYSTEM_PRINCIPAL.principalId &&
    input.origin.kind === 'ui' &&
    input.origin.approval === undefined &&
    input.gate === 'propose'
  );
}
