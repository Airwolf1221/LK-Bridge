/**
 * The proposal workflow (the real `ProposalSink`; docs/policy.md).
 *
 * Capture (an agent at scope `propose` asked for writes): params are validated with the registry schema, the guards
 * that do not write are dry-run (cascade confirmation, member admin, the unsupported-block guard), and for each
 * operation the target is READ through the engine (so through the governor, at the caller's priority) to record its
 * version, a fingerprint and the pre-state for a diff. The ordered operations are stored as ONE proposal. Nothing but
 * those reads is sent to LegendKeeper.
 *
 * States: pending → approved → executing → executed | failed; pending → rejected | expired; approved → conflicted; conflicted → rejected.
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
  VersionConflictError,
} from '../jobs/errors.js';
import {
  assertNoUnsupportedLoss,
  checkSubmitGuards,
  unsupportedGuardSides,
  unsupportedLoss,
} from '../jobs/guards.js';
import { READERS, opMeta } from '../jobs/op-meta.js';
import {
  EXPECT_STEP,
  internalStepIssues,
  isBridgeStep,
  LMR_STEP,
  withoutDirectOnlyChecks,
} from '../jobs/internal-steps.js';
import { mintClientId } from '../jobs/ids.js';
import type { ProposalMeta, ProposalSink, ProposedOp } from '../jobs/policy.js';
import {
  TERMINAL_JOB_STATUSES,
  type JobOrigin,
  type JobView,
  type OpParams,
  type Principal,
  type StepOptions,
  type StepSpec,
  type LifecycleMarker,
} from '../jobs/types.js';
import { systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
import { getOperation, operationInputSchema, requireOperation } from '../lk/registry.js';
import { sidebarInRankOrder } from '../lk/row-order.js';
import { projectWhere } from '../jobs/repo.js';
import type { OperationDef } from '../lk/registry-types.js';
import { markdownDiff, type MarkdownDiff } from '../pages/diff.js';
import { canonicalJson, hashJson, issueApprovalToken } from './approval.js';
import { buildPageSummary, type PageSummaryEntry } from './page-summary.js';
import {
  describeNamed,
  nameFromState,
  nameOperation,
  NO_NAMES,
  pagePart,
  type NameLookups,
  type OpNames,
} from './op-names.js';
import {
  PAGE_SCOPE_LIMIT,
  compareScope,
  implicitSubtrees,
  listScope,
  scopeChanged,
  scopeText,
  type PageScope,
  type PageScopeEntry,
} from './page-scope.js';
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

/** Finished states the `proposal-prune` job may delete. `pending`, `approved`, `executing` and `conflicted` never. */
export const PRUNABLE_STATES = ['executed', 'rejected', 'expired', 'failed'] as const;
const PRUNE_BATCH = 500;

/** Pre-state kept for the diff, per operation. Larger states keep only a prefix (the fingerprint is always whole). */
const PRE_STATE_MAX_BYTES = 512 * 1024;
/**
 * Chunk 8 (F-04): pre-state kept for ONE proposal, all operations together. Capture reads each target once, but used to
 * store its pre-state in every operation row, so 500 operations on one large page stored about 256 MB. Past the budget an
 * operation keeps its version and fingerprint (conflict detection uses only those) but no pre-state text.
 */
export const PROPOSAL_PRE_STATE_BUDGET_BYTES = 4 * 1024 * 1024;
/** Chunk 8 (F-04): pending proposals one principal may hold; more are refused until the owner decides some. */
export const MAX_PENDING_PROPOSALS_PER_PRINCIPAL = 50;
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
  /**
   * Chunk 6: when true the service starts no expiry timer of its own; the maintenance scheduler's `proposal-expiry`
   * job calls `expireDue()` instead. Expiry is also enforced lazily (approving an expired proposal expires it).
   */
  readonly externalExpirySweep?: boolean;
  /** v2 C2a: a page's name from the repository tree, for the page-level summary (also settable later). */
  readonly pageName?: (projectId: string, resourceId: string) => string | null;
}

interface Snapshot {
  readonly exists: boolean;
  readonly version: string | null;
  readonly fingerprint: string;
  readonly state: unknown;
  readonly body: unknown;
}

export interface ProposalOpDetail extends ProposalOpView {
  /**
   * v2 E6 (ADR 0048): the operation in plain words (`deleteEvent: event “X” (date) in “Doc” on “Page” (ids)`), from
   * its captured pre-image and the tree's names; the ids alone when nothing could be named. Absent for the bridge's
   * own check and verify steps.
   */
  readonly label?: string;
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
  /**
   * v2 C1: the high-level operation as captured (write_page: page, document, mode, section, the Markdown, the page's
   * Markdown before and after), or null for a v1 proposal.
   */
  readonly operationDetail: Readonly<Record<string, unknown>> | null;
  /** v2 C1: the page's Markdown before and after, line by line, keep regions as labelled placeholders. */
  readonly markdownDiff: MarkdownDiff | null;
  /** v2 C1: what the read after the write found, once the approved job ran (from the job). */
  readonly execution: { readonly verified: boolean | null; readonly verification: unknown } | null;
  /** v2 C2a: every high-level operation of the proposal (C1's `operationDetail` is the first of them). */
  readonly operations: readonly Readonly<Record<string, unknown>>[];
  /** v2 C2a: the operations grouped by the page they affect (shown first). */
  readonly pageSummary: readonly PageSummaryEntry[];
  /** v2 C2a: the protected canonical changes, when the proposal needs canonical approval. */
  readonly canonical: { readonly reason: string; readonly changes: readonly unknown[] } | null;
}

/** v2 C1: the high-level operation kept with a proposal: each text field at most this long. */
const OPERATION_FIELD_MAX = 512 * 1024;

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
  /** v2 C1: the high-level operation, briefly (tool, page, document, mode, section), or null. */
  readonly operation: Readonly<Record<string, unknown>> | null;
  /**
   * v2 C2a: the change is protected canon: only the owner's "Approve and accept as canon" can run it; `reason` says
   * which change.
   */
  readonly requiresCanonicalApproval: boolean;
  readonly canonicalReason: string | null;
  /** v2 C2a: the pages it affects, one plain line each. */
  readonly pages: readonly string[];
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
    projectId: String(r.project_id),
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
    operation: operationBrief(parseJson<Record<string, unknown> | null>(r.operation, null)),
    requiresCanonicalApproval: Number(r.requires_canonical ?? 0) === 1,
    canonicalApprovedBy: (r.canonical_approved_by as string | null) ?? null,
    canonicalApprovedAt: r.canonical_approved_at == null ? null : Number(r.canonical_approved_at),
    pages: parseJson<PageSummaryEntry[]>(r.page_summary, []).map((e) => e.label),
  };
}

/** v2 C2a: how a proposal's approved batch is submitted besides its steps. */
interface StoredJobOptions {
  readonly holdLock?: { readonly resourceId: string };
  readonly internal?: boolean;
  /** v2 C2c: the second job-level lock, and the lifecycle change the job makes. */
  readonly holdDocument?: { readonly documentId: string };
  readonly holdAlso?: { readonly resourceId: string };
  /** v2 D1: the documents a chronology job holds the locks of. */
  readonly holdDocuments?: readonly string[];
  readonly lifecycle?: LifecycleMarker;
  /** C2d: further job-level locks (a whole set). */
  readonly holdMore?: { readonly resources?: readonly string[]; readonly documents?: readonly string[] };
  /** C2d (ADR 0036 decision 5): the pages the proposal touches without naming them, as captured. */
  readonly pageScope?: PageScope;
}

/** The part of a high-level operation a list shows (never the Markdown or the page). */
function operationBrief(op: Record<string, unknown> | null): Readonly<Record<string, unknown>> | null {
  if (!op) return null;
  const out: Record<string, unknown> = {};
  for (const k of [
    'tool',
    'page',
    'document',
    'mode',
    'section',
    'plannedOn',
    'baseVersion',
    'counts',
    'property',
    'pageParts',
  ])
    if (op[k] !== undefined) out[k] = op[k];
  return out;
}

/** Caps each long text field of a high-level operation (the Markdown, the page before and after). */
function capOperation(op: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const truncated: string[] = [];
  for (const [k, v] of Object.entries(op)) {
    if (typeof v === 'string' && v.length > OPERATION_FIELD_MAX) {
      out[k] = v.slice(0, OPERATION_FIELD_MAX);
      truncated.push(k);
    } else out[k] = v;
  }
  if (truncated.length > 0) out.truncated = truncated;
  return out;
}

/** Builds the read that shows an operation's target, from op-meta's reader (as the engine does before a write). */
/** The reads whose answer holds key-value rows in stored order (see snapshotOf). */
const SIDEBAR_READS: ReadonlySet<string> = new Set(['getProperty', 'getResource', 'listProperties']);

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

/**
 * The summary of a proposal: each operation in plain words. v2 E6 (ADR 0048): with `names` (a low-level proposal's
 * page, document and entity, found at capture), `deleteEvent: event “X” (date) in “Doc” on “Page” (ids)`; without, the
 * ids as before.
 */
export function proposalSummary(
  ops: readonly { op: string; params: OpParams }[],
  names?: readonly (OpNames | null)[],
): string {
  const parts = ops.map((o, i) => describeNamed(o.op, o.params, names?.[i] ?? NO_NAMES));
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

  private pageNames: ((projectId: string, resourceId: string) => string | null) | undefined;

  /** v2 C2a: where the page-level summary gets page names (the repository tree; set once the tree exists). */
  setPageNames(fn: (projectId: string, resourceId: string) => string | null): void {
    this.pageNames = fn;
  }

  private pageName(projectId: string, resourceId: string): string | null {
    try {
      return (this.pageNames ?? this.o.pageName)?.(projectId, resourceId) ?? null;
    } catch {
      return null;
    }
  }

  private requireEngine(): JobEngine {
    if (!this.engine)
      throw new PolicyError('NO_ENGINE', 'The proposal service is not attached to a job engine');
    return this.engine;
  }

  private scheduleSweep(): void {
    if (this.o.externalExpirySweep) return; // the maintenance scheduler runs the sweep (chunk 6)
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
    proposed: readonly ProposedOp[],
    meta: ProposalMeta,
  ): Promise<{ proposalId: string; summary: string }> {
    // v2 C2a (PLAN-v2 10.2): every client id the expansion needs is minted NOW and stored, so a child "under" a new
    // index and a link "to" a new page are fixed in the proposal, and approval runs with exactly these ids.
    // v2 C2b: a whole-sidebar check made for a direct write (`baseFactsVersion`) is left out: from capture on, the
    // proposal's own captured state protects it.
    const ops = proposed
      .map(withMintedIds)
      .map((o) =>
        o.op === EXPECT_STEP ? { ...o, params: withoutDirectOnlyChecks(o.params) as OpParams } : o,
      );
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
    // Checked before any read is spent on capture.
    const pending = (
      this.store.db
        .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE principal_id = ? AND state = 'pending'`)
        .get(principal.principalId) as { n: number }
    ).n;
    if (pending >= MAX_PENDING_PROPOSALS_PER_PRINCIPAL) {
      throw new PolicyDeniedError(
        ops[0]?.op ?? 'operation',
        `this connection already has ${pending} proposals waiting for the owner (the limit is ` +
          `${MAX_PENDING_PROPOSALS_PER_PRINCIPAL}); wait until the owner has approved or rejected some, ` +
          'and follow them with bridge_proposal_status (no proposalId lists yours)',
        principal.principalId,
      );
    }

    // 1. Validate, and dry-run the guards that do not write.
    const defs: (OperationDef | null)[] = ops.map((o, i) => {
      // v2 C2a: the bridge's own check and verify steps, only in an expansion bridge code built.
      if (meta.jobOptions?.internal === true && isBridgeStep(o.op)) {
        const issues = internalStepIssues(o.op, o.params);
        if (issues.length > 0) {
          throw new InvalidParamsError(
            o.op,
            issues.map((x) => ({ path: `${batch ? `steps[${i}].` : ''}${x.path}`, message: x.message })),
          );
        }
        return null;
      }
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
    const reads = new Map<string, Promise<{ readonly found: boolean; readonly body: unknown }>>();
    const captured: { target: CapturedTarget | null; snap: Snapshot | null }[] = [];
    // v2 C2b: a page an earlier operation of this proposal creates does not exist yet: nothing to capture or compare.
    const created = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      const rid = o.params.path?.resourceId;
      // v2 D1 (ADR 0038): a chronology write is judged by its job's own check inside the lock (the row still as planned,
      // no identical row, the place and the count worked out from the documents as they are then), not by the
      // document's version: another approved event in the same table must not make it conflict.
      const target =
        defs[i] && !(rid && created.has(rid)) && o.judgedInLock !== true
          ? readerTarget(o.op, o.params)
          : null;
      for (const id of createdIds(o.op, o.params)) created.add(id);
      if (!target) {
        captured.push({ target: null, snap: null });
        continue;
      }
      const key = canonicalJson(target);
      let snap = seen.get(key);
      if (!snap) {
        // v2 C1: a read the tool made in this same call is used as it is (the plan was built on exactly it).
        const pre = meta.extras?.prefetched?.find(
          (p) => p.op === target.op && canonicalJson(p.path) === canonicalJson(target.path),
        );
        snap = pre
          ? this.snapshotOf(target, pre.body)
          : await this.snapshot(engine, meta.project, target, readOrigin, meta.priority, reads);
        seen.set(key, snap);
      }
      // v2 C1: a high-level write planned on a version must be captured on that version, or it is a conflict.
      if (meta.extras?.operation && o.params.ifMatch !== undefined && snap.version !== o.params.ifMatch) {
        throw new VersionConflictError(o.op, o.params.ifMatch, snap.version);
      }
      const om = opMeta(o.op);
      if (om.guard && snap.exists) {
        const sides = unsupportedGuardSides(om.guard, o.op, o.params, {
          body: snap.body,
          entity: snap.state ?? undefined,
        });
        if (sides) assertNoUnsupportedLoss(o.op, sides.existing, sides.incoming, stepOptions(o));
      }
      captured.push({ target, snap });
    }

    // 2b. C2d (ADR 0036 decision 5): an approval covers only the pages it listed. The pages an operation touches without
    // naming them (a cascade's, a template copy's children) are listed now and kept with the proposal; a lifecycle set
    // brings its own list (its tool listed it). Checked again at approval and inside the lock.
    const scopeEntries: PageScopeEntry[] = [...(meta.jobOptions?.pageScope?.subtrees ?? [])];
    for (const s of implicitSubtrees(ops)) {
      if (created.has(s.rootId)) continue; // made by this proposal: nothing under it yet to capture
      const pages = await listScope(
        (op, params) =>
          engine.internalRead(meta.project, op, params, { priority: meta.priority, notFoundIsAnswer: true }),
        s.rootId,
      );
      if (pages === null || pages.length > PAGE_SCOPE_LIMIT) {
        throw new PolicyDeniedError(
          ops[s.step]?.op ?? 'operation',
          pages === null
            ? `${s.label} could not be listed, so the proposal could not record which pages it covers; nothing was proposed. Try again`
            : `${s.label} are more than ${PAGE_SCOPE_LIMIT}; an approval covers only the pages it lists, so delete or copy them in parts`,
          principal.principalId,
        );
      }
      scopeEntries.push({ ...s, pages });
    }
    const pageScope: PageScope | null = scopeEntries.length > 0 ? { subtrees: scopeEntries } : null;

    // 2c. v2 E6 (ADR 0048): a low-level proposal (lk_api_write, lk_api_batch) names what each operation touches: the
    // page and document (the tree), the entity (the pre-image just captured; a sidebar row's property by one cheap
    // read). A high-level tool gives its own summary and pays nothing here. A name that cannot be found is left out.
    const lowLevel = !meta.extras?.summary && !meta.extras?.operation && !meta.extras?.operations;
    // v3 F2 (ADR 0049): the Last Major Revision steps the engine appended are not named one by one (the note says
    // what they do), and cost nothing here.
    const own = ops.filter((o) => o.op !== LMR_STEP && o.decisionFrom === undefined);
    const ownCaptured = captured.filter(
      (_, i) => ops[i]!.op !== LMR_STEP && ops[i]!.decisionFrom === undefined,
    );
    const names: (OpNames | null)[] = lowLevel
      ? await this.nameOps(engine, meta, readOrigin, own, ownCaptured)
      : own.map(() => null);

    // 3. Store the ordered operations as one proposal.
    const id = newProposalId();
    const now = this.now();
    const note = meta.extras?.lmrNote ? ` ${meta.extras.lmrNote}` : '';
    const base = meta.extras?.summary ? meta.extras.summary : proposalSummary(own, names);
    const summary =
      note === ''
        ? base.slice(0, SUMMARY_MAX)
        : `${base.slice(0, Math.max(0, SUMMARY_MAX - note.length))}${note}`;
    const origin = sanitiseOrigin(meta.origin);
    const operation = meta.extras?.operation ? JSON.stringify(capOperation(meta.extras.operation)) : null;
    // v2 C2a: the list of high-level operations, the page-level summary, canonical approval and the job's shape.
    const opList = meta.extras?.operations ?? (meta.extras?.operation ? [meta.extras.operation] : undefined);
    const operations = opList ? JSON.stringify(opList.map(capOperation)) : null;
    const pages = buildPageSummary(
      own,
      opList,
      (rid) => this.pageName(meta.project, rid),
      names.map((n, i) => (n ? pagePart(own[i]!.op, n) : null)),
    );
    const jobOptions: StoredJobOptions | null =
      (meta.jobOptions &&
        (meta.jobOptions.holdLock ||
          meta.jobOptions.internal ||
          meta.jobOptions.lifecycle ||
          (meta.jobOptions.holdDocuments?.length ?? 0) > 0)) ||
      pageScope
        ? {
            ...(meta.jobOptions?.holdLock
              ? { holdLock: { resourceId: meta.jobOptions.holdLock.resourceId } }
              : {}),
            ...(meta.jobOptions?.internal ? { internal: true } : {}),
            ...(meta.jobOptions?.holdDocument
              ? { holdDocument: { documentId: meta.jobOptions.holdDocument.documentId } }
              : {}),
            ...(meta.jobOptions?.holdAlso
              ? { holdAlso: { resourceId: meta.jobOptions.holdAlso.resourceId } }
              : {}),
            ...(meta.jobOptions?.holdMore ? { holdMore: meta.jobOptions.holdMore } : {}),
            ...(meta.jobOptions?.holdDocuments && meta.jobOptions.holdDocuments.length > 0
              ? { holdDocuments: meta.jobOptions.holdDocuments.filter((d) => typeof d === 'string') }
              : {}),
            ...(meta.jobOptions?.lifecycle ? { lifecycle: meta.jobOptions.lifecycle } : {}),
            ...(pageScope ? { pageScope } : {}),
          }
        : null;
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO proposals (id, project_id, principal_id, principal_label, profile, origin, job_kind, title,
             priority, on_error, summary, state, created_at, updated_at, expires_at, operation, operations,
             page_summary, requires_canonical, canonical_changes, job_options)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          meta.project,
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
          operation,
          operations,
          JSON.stringify(pages),
          meta.canonical ? 1 : 0,
          meta.canonical ? JSON.stringify(meta.canonical) : null,
          jobOptions ? JSON.stringify(jobOptions) : null,
        );
      const insert = this.store.db.prepare(
        `INSERT INTO proposal_ops (proposal_id, project_id, idx, op_id, op_kind, params, params_hash, options,
           target, target_exists, version, fingerprint, pre_state, pre_state_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let budget = PROPOSAL_PRE_STATE_BUDGET_BYTES;
      ops.forEach((o, i) => {
        const c = captured[i]!;
        const pre = c.snap
          ? capJson(c.snap.state, Math.min(PRE_STATE_MAX_BYTES, budget))
          : { text: null, truncated: false };
        budget -= pre.text === null ? 0 : Buffer.byteLength(pre.text);
        insert.run(
          id,
          meta.project,
          i,
          o.op,
          defs[i]?.kind ?? 'read',
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
      projectId: meta.project,
      state: 'pending',
      principalId: principal.principalId,
      profile: principal.profile,
      jobId: null,
    });
    return { proposalId: id, summary };
  }

  /**
   * v2 E6 (ADR 0048): the page, document and entity each operation of a low-level proposal touches. Never throws: a
   * name that cannot be found is null (the summary then gives the ids).
   */
  private async nameOps(
    engine: JobEngine,
    meta: ProposalMeta,
    origin: JobOrigin,
    ops: readonly ProposedOp[],
    captured: readonly { target: CapturedTarget | null; snap: Snapshot | null }[],
  ): Promise<(OpNames | null)[]> {
    const titles = new Map<string, Promise<string | null>>();
    const lookups: NameLookups = {
      page: (rid) => this.pageName(meta.project, rid),
      document: (rid, did) => this.documentName(meta.project, rid, did),
      propertyTitle: (params) => {
        const p = params.path ?? {};
        const block = p.blockId !== undefined && p.documentId !== undefined;
        const op = block ? 'getBlockProperty' : 'getProperty';
        const path: Record<string, string> = block
          ? {
              resourceId: p.resourceId ?? '',
              documentId: p.documentId!,
              blockId: p.blockId!,
              propertyId: p.propertyId ?? '',
            }
          : { resourceId: p.resourceId ?? '', propertyId: p.propertyId ?? '' };
        if (!path.resourceId || !path.propertyId) return Promise.resolve(null);
        const key = canonicalJson({ op, path });
        let t = titles.get(key);
        if (!t) {
          t = engine
            .run(
              op,
              { path },
              { origin, priority: meta.priority, title: 'proposal name', project: meta.project },
            )
            .then((r) => {
              const v = (r.status === 'succeeded' ? r.result : null) as { title?: unknown } | null;
              return typeof v?.title === 'string' && v.title.trim() !== '' ? v.title : null;
            })
            .catch(() => null);
          titles.set(key, t);
        }
        return t;
      },
    };
    const out: (OpNames | null)[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      if (isBridgeStep(o.op)) {
        out.push(null);
        continue;
      }
      try {
        out.push(await nameOperation(o.op, o.params, captured[i]?.snap?.state ?? null, lookups));
      } catch {
        out.push(null);
      }
    }
    return out;
  }

  private documentNames:
    ((projectId: string, resourceId: string, documentId: string) => string | null) | undefined;

  /** v2 E6 (ADR 0048): where a low-level proposal gets document names (the repository tree; set once the tree exists). */
  setDocumentNames(fn: (projectId: string, resourceId: string, documentId: string) => string | null): void {
    this.documentNames = fn;
  }

  private documentName(projectId: string, resourceId: string, documentId: string): string | null {
    try {
      return this.documentNames?.(projectId, resourceId, documentId) ?? null;
    } catch {
      return null;
    }
  }

  /** Reads one target through the engine and fingerprints what the operation would act on. */
  private async snapshot(
    engine: JobEngine,
    project: string,
    target: CapturedTarget,
    origin: JobOrigin,
    priority: ProposalMeta['priority'],
    reads?: Map<string, Promise<{ readonly found: boolean; readonly body: unknown }>>,
  ): Promise<Snapshot> {
    const missing: Snapshot = {
      exists: false,
      version: null,
      fingerprint: hashJson(null),
      state: null,
      body: undefined,
    };
    // v2 C2a: one read per target READ (operation and path), shared by every operation it selects from (several row
    // writes to one property read its rows once).
    if (reads) {
      const key = canonicalJson({ op: target.op, path: target.path });
      let read = reads.get(key);
      if (!read) {
        read = this.readTarget(engine, project, target, origin, priority);
        reads.set(key, read);
      }
      const got = await read;
      return got.found ? this.snapshotOf(target, got.body) : missing;
    }
    const got = await this.readTarget(engine, project, target, origin, priority);
    return got.found ? this.snapshotOf(target, got.body) : missing;
  }

  /** One read of a target (a 404 is an answer: not there). */
  private async readTarget(
    engine: JobEngine,
    project: string,
    target: CapturedTarget,
    origin: JobOrigin,
    priority: ProposalMeta['priority'],
  ): Promise<{ readonly found: boolean; readonly body: unknown }> {
    let body: unknown;
    try {
      // Chunk 6: a reader with no path parameters (listMembers, listInvites, listCalendars) must get `{}`: the registry
      // rejects an empty `path` object as an unrecognised key, which made proposals for those targets fail at capture.
      const r = await engine.run(
        target.op,
        Object.keys(target.path).length > 0 ? { path: target.path } : {},
        { origin, priority, title: 'proposal read', project },
      );
      if (r.status !== 'succeeded') {
        throw new JobsError(
          'BRIDGE_ERROR',
          `Could not read ${target.op} now (${r.status}); try again shortly`,
        );
      }
      body = r.result;
    } catch (e) {
      if (e instanceof LkOperationError && e.lk.status === 404) return { found: false, body: undefined };
      throw e;
    }
    return { found: true, body };
  }

  /** What a target read's body says: whether the entity exists, its version, fingerprint and state. */
  private snapshotOf(target: CapturedTarget, body: unknown): Snapshot {
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
    // A sidebar read's rows in LegendKeeper's one order (by rank), so the fingerprint (and the pre-state shown on the
    // proposal) never depends on the order an endpoint happened to give them in (hotfix, 10 November 2026).
    if (entity !== undefined && SIDEBAR_READS.has(target.op)) entity = sidebarInRankOrder(entity);
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
    return this.approveWith(actor, id, false, false);
  }

  /**
   * v2 C2a (ADR 0032): "Approve and accept as canon" (owner command layer only): the one way to approve a proposal
   * flagged `requiresCanonicalApproval`. A separate, audited action (`proposal.approve_as_canon`) that records
   * `canonicalApprovedBy`; the approved work carries a canonical approval token, the only thing that lets the write
   * guard pass its protected changes. Everything else is as `approve`. `bulk` (the dashboard's "Accept selected as
   * canon") is recorded in the audit row's details and changes nothing else: each proposal is approved on its own.
   */
  async approveAsCanon(
    actor: OwnerActor,
    id: string,
    opts: { readonly bulk?: boolean } = {},
  ): Promise<ProposalView> {
    return this.approveWith(actor, id, true, opts.bulk === true);
  }

  private async approveWith(
    actor: OwnerActor,
    id: string,
    canonical: boolean,
    bulk: boolean,
  ): Promise<ProposalView> {
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
    if (p.requiresCanonicalApproval && !canonical) {
      throw new PolicyError(
        'CANONICAL_APPROVAL_REQUIRED',
        `Proposal ${id} makes a protected canonical change; only "Approve and accept as canon" can approve it`,
      );
    }
    if (!p.requiresCanonicalApproval && canonical) {
      throw new PolicyError(
        'NOT_CANONICAL',
        `Proposal ${id} makes no protected canonical change; approve it with the ordinary Approve`,
      );
    }
    // v2 A1: the proposal's own project, and only that one: its read-only flag, its availability, its data.
    const controls = engine.queries.controls(p.projectId);
    if (controls.project && !controls.project.available) {
      throw new PolicyError(
        'PROJECT_UNAVAILABLE',
        `Project "${controls.project.name}" is not available now; the proposal stays pending`,
      );
    }
    if (controls.readOnly) {
      throw new PolicyError(
        'BRIDGE_READ_ONLY',
        controls.project?.readOnly && !engine.queries.controls().readOnly
          ? `Project "${controls.project.name}" is read-only; the proposal stays pending`
          : 'The bridge is in read-only mode; the proposal stays pending',
      );
    }
    if (controls.writesPaused) {
      throw new PolicyError('WRITES_PAUSED', 'Writes are paused; the proposal stays pending');
    }
    if (controls.draining) {
      throw new PolicyError('DRAINING', 'The bridge is draining; the proposal stays pending');
    }
    // Compare-and-set: only one approval can ever win.
    if (
      !this.transition(id, ['pending'], 'approved', {
        decided_at: this.now(),
        decided_by: 'owner',
        ...(canonical ? { canonical_approved_by: 'owner', canonical_approved_at: this.now() } : {}),
      })
    ) {
      throw new PolicyError('INVALID_TRANSITION', `Proposal ${id} is no longer pending`);
    }
    if (canonical) {
      const changes = this.canonicalOf(id);
      this.store.audit(
        'owner',
        'proposal.approve_as_canon',
        id,
        { state: 'pending' },
        {
          state: 'approved',
          canonicalApprovedBy: 'owner',
          canonical: changes,
          ...(bulk ? { bulk: true } : {}),
        },
      );
    } else this.store.audit('owner', 'proposal.approve', id, { state: 'pending' }, { state: 'approved' });
    const unapprove = {
      decided_at: null,
      decided_by: null,
      canonical_approved_by: null,
      canonical_approved_at: null,
    };

    // Re-read every target; any change since capture means conflict, and nothing runs.
    const ops = this.opRows(id);
    const systemOrigin: JobOrigin = {
      kind: 'ui',
      client: 'owner',
      tool: 'proposal_approval',
      detail: `proposal:${id}`,
    };
    const current = new Map<string, Snapshot>();
    const reads = new Map<string, Promise<{ readonly found: boolean; readonly body: unknown }>>();
    try {
      for (const op of ops) {
        if (!op.target) continue;
        const key = canonicalJson(op.target);
        let snap = current.get(key);
        if (!snap) {
          snap = await this.snapshot(engine, p.projectId, op.target, systemOrigin, 'P0', reads);
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
      this.transition(id, ['approved'], 'pending', unapprove);
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

    // C2d (ADR 0036 decision 5): the pages it touches without naming them, listed again: an approval covers only the
    // pages it listed, so a page added, gone or moved under them since capture is a conflict, and nothing runs.
    const scope = this.jobOptionsOf(id)?.pageScope;
    for (const entry of scope?.subtrees ?? []) {
      const now = await listScope(
        (op, params) =>
          engine.internalRead(p.projectId, op, params, { priority: 'P0', notFoundIsAnswer: true }),
        entry.rootId,
      );
      const d = now === null ? null : compareScope(entry.pages, now);
      if (d === null || scopeChanged(d)) {
        const conflict: ProposalConflict = {
          index: entry.step ?? 0,
          op: entry.step !== undefined ? (ops[entry.step]?.op ?? 'operation') : (ops[0]?.op ?? 'operation'),
          reason:
            d === null
              ? `${entry.label} could not be listed again, so the bridge cannot tell they are the pages the approval listed; nothing was written`
              : scopeText(entry, d),
          capturedVersion: null,
          currentVersion: null,
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

    // Submit the approved batch with a token bound to this proposal.
    const steps = executionSteps(ops);
    const token = issueApprovalToken(
      id,
      p.principalId,
      p.projectId,
      steps.map((s) => ({ op: s.op, paramsHash: hashJson(s.params ?? {}) })),
      this.now(),
      canonical,
    );
    const jobOptions = this.jobOptionsOf(id);
    const principal: Principal = { principalId: p.principalId, profile: p.profile, label: p.principalLabel };
    // CR-2026-11 (CR-03): the sidebars this re-read has just read (a page's getResource carries its properties) are
    // handed to the write guards' entry check, which would otherwise read them again a moment later. The guards still
    // judge them, and check again inside the lock before each write.
    const prefetched = ops.flatMap((op) => {
      if (!op.target || (op.target.op !== 'getResource' && op.target.op !== 'listProperties')) return [];
      const snap = current.get(canonicalJson(op.target));
      return snap?.exists ? [{ op: op.target.op, path: op.target.path, body: snap.body }] : [];
    });
    let result: Awaited<ReturnType<JobEngine['submit']>>;
    try {
      result = await engine.submit({
        kind: 'batch_ops',
        project: p.projectId,
        steps,
        onError: 'stop',
        priority: p.priority as ProposalMeta['priority'],
        title: `Approved ${id}: ${p.title}`.slice(0, 500),
        origin: {
          ...systemOrigin,
          principal,
          approvedBy: 'owner',
          approval: token,
          ...(canonical ? { canonicalApprovedBy: 'owner' } : {}),
        },
        ...(jobOptions?.holdLock ? { holdLock: jobOptions.holdLock } : {}),
        ...(jobOptions?.internal ? { internal: true } : {}),
        ...(jobOptions?.holdDocument ? { holdDocument: jobOptions.holdDocument } : {}),
        ...(jobOptions?.holdAlso ? { holdAlso: jobOptions.holdAlso } : {}),
        ...(jobOptions?.holdMore ? { holdMore: jobOptions.holdMore } : {}),
        ...(jobOptions?.holdDocuments && jobOptions.holdDocuments.length > 0
          ? { holdDocuments: jobOptions.holdDocuments }
          : {}),
        ...(jobOptions?.lifecycle ? { lifecycle: jobOptions.lifecycle } : {}),
        ...(jobOptions?.pageScope ? { pageScope: jobOptions.pageScope } : {}),
        ...(prefetched.length > 0 ? { proposal: { prefetched } } : {}),
      });
    } catch (e) {
      token.consume();
      if (e instanceof ReadOnlyError || e instanceof DrainingError) {
        this.transition(id, ['approved'], 'pending', unapprove);
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
    const job = engine.queries.getJob(p.projectId, result.jobId);
    if (job && TERMINAL_JOB_STATUSES.has(job.status)) this.onJobFinished(job);
    return this.require(id);
  }

  /**
   * Rejects a `pending` or a `conflicted` proposal with an optional reason the agent can read (owner command layer
   * only). A conflicted proposal (the target changed after capture) can only be closed this way: nothing else moves it
   * on, and `proposal-prune` never deletes it until it is rejected. It keeps its stored `conflict` details; the
   * rejection stamps `finished_at`, so it is pruned after the retention like any rejected proposal. One compare-and-set
   * from those two states; the audit row's `before` records the state it really was in.
   */
  reject(actor: OwnerActor, id: string, reason?: string): ProposalView {
    assertOwner(actor);
    const p = this.require(id);
    if (p.state !== 'pending' && p.state !== 'conflicted') {
      throw new PolicyError(
        'INVALID_TRANSITION',
        `Proposal ${id} is ${p.state}; only pending or conflicted proposals can be rejected`,
      );
    }
    const why = reason?.trim().slice(0, REASON_MAX) || null;
    const was = p.state;
    if (
      !this.transition(id, ['pending', 'conflicted'], 'rejected', {
        decided_at: this.now(),
        decided_by: 'owner',
        reject_reason: why,
        finished_at: this.now(),
      })
    ) {
      throw new PolicyError(
        'INVALID_TRANSITION',
        `Proposal ${id} is ${this.require(id).state}; only pending or conflicted proposals can be rejected`,
      );
    }
    this.store.audit('owner', 'proposal.reject', id, { state: was }, { state: 'rejected', reason: why });
    return this.require(id);
  }

  /**
   * v3 F3b (ADR 0052; design section 6): withdraws a PENDING proposal because a setting pack's package takes over what
   * it would do (a staged image's own placement): rejected by `system`, with the reason the package gives ("superseded
   * by package prop_…"), audited `proposal.superseded`. False when it is not pending any more (one compare-and-set).
   */
  supersede(id: string, reason: string): boolean {
    const why = reason.trim().slice(0, REASON_MAX) || 'superseded';
    const ok = this.transition(id, ['pending'], 'rejected', {
      decided_at: this.now(),
      decided_by: 'system',
      reject_reason: why,
      finished_at: this.now(),
    });
    if (ok) this.store.audit('system', 'proposal.superseded', id, { state: 'pending' }, { state: 'rejected', reason: why });
    return ok;
  }

  /**
   * v3 F3b: whether a proposal does nothing but place one staged image (upload_image's own placement at scope
   * `propose`): no high-level operation, and every operation it lists is that image's `place_image`.
   */
  isImagePlacement(id: string, stagedId: string): boolean {
    const row = this.store.db.prepare('SELECT operation, operations FROM proposals WHERE id = ?').get(id) as
      { operation: string | null; operations: string | null } | undefined;
    if (!row || row.operation) return false;
    const ops = parseJson<unknown>(row.operations, null);
    return (
      Array.isArray(ops) &&
      ops.length > 0 &&
      ops.every(
        (o) =>
          typeof o === 'object' &&
          o !== null &&
          (o as Record<string, unknown>).kind === 'place_image' &&
          (o as Record<string, unknown>).stagedId === stagedId,
      )
    );
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

  // ============================================================================================ retention

  /**
   * Deletes finished proposals (`executed`, `rejected`, `expired`, `failed`) that finished more than the retention
   * (`POLICY_PROPOSAL_RETENTION_DAYS`, default 90) ago, with their operations and stored pre-state (v1.0.1, F-16).
   * `pending`, `approved`, `executing` and `conflicted` proposals are never touched. Jobs, journal entries and audit
   * rows that name a proposal keep its id as plain text (no foreign key points at `proposals` except its own
   * operations). Runs in batches so the database's write lock is held briefly. Called by the `proposal-prune`
   * maintenance job.
   */
  pruneFinished(retentionMs: number = this.o.settings.proposalRetentionMs): {
    readonly removed: number;
    readonly cutoff: number;
  } {
    const cutoff = this.now() - retentionMs;
    const select = this.store.db.prepare(
      `SELECT id FROM proposals
       WHERE state IN (${PRUNABLE_STATES.map(() => '?').join(', ')})
         AND COALESCE(finished_at, decided_at, updated_at) <= ?
       ORDER BY COALESCE(finished_at, decided_at, updated_at)
       LIMIT ${PRUNE_BATCH}`,
    );
    const del = this.store.db.prepare(
      `DELETE FROM proposals WHERE id = ? AND state IN (${PRUNABLE_STATES.map(() => '?').join(', ')})`,
    );
    let removed = 0;
    for (;;) {
      const batch = this.store.db.transaction(() => {
        const ids = (select.all(...PRUNABLE_STATES, cutoff) as { id: string }[]).map((r) => r.id);
        let n = 0;
        for (const id of ids) n += del.run(id, ...PRUNABLE_STATES).changes; // proposal_ops cascade
        return { found: ids.length, n };
      })();
      removed += batch.n;
      if (batch.found < PRUNE_BATCH) break;
    }
    if (removed > 0) {
      this.store.audit('system', 'proposal.pruned', null, undefined, {
        removed,
        finishedBefore: new Date(cutoff).toISOString(),
        states: PRUNABLE_STATES,
      });
    }
    return { removed, cutoff };
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
      .prepare(`SELECT id FROM proposals WHERE job_id = ? AND project_id = ? AND state = 'executing'`)
      .get(job.id, job.projectId) as { id: string } | undefined;
    if (!row) return;
    // v2 C2a: what the job's verify read found is kept on the proposal too (the job may be pruned before it).
    const ver = (job.result ?? {}) as { verified?: unknown; verification?: unknown };
    if (ver.verification !== undefined) {
      this.store.db.prepare('UPDATE proposals SET verification = ? WHERE id = ?').run(
        JSON.stringify({
          verified: typeof ver.verified === 'boolean' ? ver.verified : null,
          verification: ver.verification,
        }),
        row.id,
      );
    }
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
    // v2 C1: a page write whose compare-and-swap refused it inside the lock wrote nothing: the proposal is conflicted, as
    // if the approval's own re-read had seen the change (the owner approves exactly what they saw, never a re-plan).
    // CR-2026-11 (CR-05): every high-level proposal (write_page's `operation`, and the `operations` of set_facts, the
    // resource, document and character tools and the lifecycle tools), and "nothing was written" judged by the job's
    // LegendKeeper writes (none succeeded, none may have been sent), not by its step count: the bridge's own check and
    // record steps come first in those jobs and succeed without writing anything to LegendKeeper.
    const highLevel = this.store.db
      .prepare('SELECT operation, operations FROM proposals WHERE id = ?')
      .get(row.id) as { operation: string | null; operations: string | null } | undefined;
    const steps = this.engine?.queries.getJob(job.projectId, job.id)?.steps ?? [];
    const wroteNothing =
      steps.length > 0
        ? !steps.some(
            (s) =>
              s.opKind !== 'read' && (s.status === 'succeeded' || s.status === 'uncertain' || s.maybeSent),
          )
        : job.progress.stepsDone === 0;
    // C2d (ADR 0036 decision 5): the pages an approval listed, changed before the write (the page-scope guard inside
    // the lock): conflicted whatever tool made the proposal.
    const scopeConflict = (job.lastError as { scope?: unknown } | null | undefined)?.scope === true;
    if (
      (highLevel?.operation || highLevel?.operations || scopeConflict) &&
      job.status === 'failed' &&
      job.lastError?.code === 'VERSION_CONFLICT' &&
      wroteNothing
    ) {
      const le = job.lastError as {
        stepNo?: unknown;
        sentVersion?: unknown;
        currentVersion?: unknown;
        opId?: unknown;
      };
      const conflict: ProposalConflict = {
        index: typeof le.stepNo === 'number' ? le.stepNo - 1 : 0,
        op: typeof le.opId === 'string' ? le.opId : 'replaceDocumentBlocks',
        reason: scopeConflict
          ? typeof (job.lastError as { message?: unknown }).message === 'string'
            ? (job.lastError as { message: string }).message
            : 'the pages the approval listed changed'
          : typeof (le as { label?: unknown }).label === 'string'
            ? `${String((le as { label?: unknown }).label)} changed between the approval’s check and the write (the bridge’s own check inside the page’s lock); nothing was written`
            : 'the page changed between the approval’s check and the write (the bridge’s own version check inside the page’s lock); nothing was written',
        capturedVersion: typeof le.sentVersion === 'string' ? le.sentVersion : null,
        currentVersion: typeof le.currentVersion === 'string' ? le.currentVersion : null,
      };
      if (
        this.transition(row.id, ['executing'], 'conflicted', {
          conflict: JSON.stringify(conflict),
          finished_at: this.now(),
        })
      ) {
        this.store.audit(
          'system',
          'proposal.conflicted',
          row.id,
          { state: 'executing' },
          { state: 'conflicted', conflict, jobId: job.id },
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
        `SELECT id, project_id, state, principal_id, job_id FROM proposals WHERE state IN ('approved', 'executing')`,
      )
      .all() as {
      id: string;
      project_id: string;
      state: string;
      principal_id: string;
      job_id: string | null;
    }[];
    for (const r of rows) {
      let jobId = r.job_id;
      if (r.state === 'approved') {
        const found = this.store.db
          .prepare(
            `SELECT id FROM jobs WHERE approved_by IS NOT NULL AND principal_id = ? AND project_id = ?
               AND json_extract(origin, '$.detail') = ? ORDER BY created_at LIMIT 1`,
          )
          .get(r.principal_id, r.project_id, `proposal:${r.id}`) as { id: string } | undefined;
        if (!found) {
          if (
            this.transition(r.id, ['approved'], 'pending', {
              decided_at: null,
              decided_by: null,
              canonical_approved_by: null,
              canonical_approved_at: null,
            })
          ) {
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
      const job = jobId ? engine.queries.getJob(r.project_id, jobId) : undefined;
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

  /** Proposals of one project (or, explicitly, `ALL_PROJECTS`), newest first. */
  list(filter: ProposalFilter): ProposalView[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    const scope = projectWhere(filter.project, 'p.project_id');
    if (scope.sql) {
      where.push(scope.sql);
      vals.push(...scope.vals);
    }
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
      // v2 C2a: the bridge's own check and verify steps change nothing; they show their parameters only.
      if (isBridgeStep(base.op)) {
        return {
          ...base,
          preState: null,
          preStateTruncated: false,
          proposed: params.body ?? null,
          changes: [],
          unsupportedLoss: [],
        };
      }
      const meta = opMeta(base.op);
      // v2 E6 (ADR 0048): the operation in plain words, from its captured pre-image and the tree's names.
      const named = nameFromState(base.op, params, truncated ? null : pre, {
        page: (rid) => this.pageName(p.projectId, rid),
        document: (rid, did) => this.documentName(p.projectId, rid, did),
      });
      const label = describeNamed(base.op, params, named);
      const proposed = meta.intent ? meta.intent(params) : params.body;
      const before = !truncated && meta.actual && pre !== null ? meta.actual(pre, pre) : pre;
      const sides =
        meta.guard && !truncated && pre !== null
          ? unsupportedGuardSides(meta.guard, base.op, params, { body: pre, entity: pre })
          : null;
      return {
        ...base,
        label,
        preState: pre,
        preStateTruncated: truncated,
        proposed: proposed ?? null,
        changes: truncated ? [] : diff(before, proposed),
        unsupportedLoss: sides ? unsupportedLoss(sides.existing, sides.incoming) : [],
      };
    });
    const opRow = this.store.db.prepare('SELECT operation FROM proposals WHERE id = ?').get(id) as
      { operation: string | null } | undefined;
    const operationDetail = parseJson<Record<string, unknown> | null>(opRow?.operation, null);
    const before = operationDetail?.before;
    const after = operationDetail?.after;
    const md = typeof before === 'string' && typeof after === 'string' ? markdownDiff(before, after) : null;
    const extra = this.store.db
      .prepare('SELECT operations, page_summary FROM proposals WHERE id = ?')
      .get(id) as { operations: string | null; page_summary: string | null } | undefined;
    const operations =
      parseJson<Record<string, unknown>[] | null>(extra?.operations, null) ??
      (operationDetail ? [operationDetail] : []);
    return {
      ...p,
      ops,
      operationDetail,
      markdownDiff: md,
      execution: this.execution(p),
      operations,
      pageSummary: parseJson<PageSummaryEntry[]>(extra?.page_summary, []),
      canonical: p.requiresCanonicalApproval ? this.canonicalOf(id) : null,
    };
  }

  /** v2 C2a: the protected changes a proposal was flagged for. */
  private canonicalOf(id: string): { reason: string; changes: readonly unknown[] } | null {
    const r = this.store.db.prepare('SELECT canonical_changes FROM proposals WHERE id = ?').get(id) as
      { canonical_changes: string | null } | undefined;
    return parseJson<{ reason: string; changes: unknown[] } | null>(r?.canonical_changes, null);
  }

  /** v2 C2a: the job-level lock and internal steps the approved batch is submitted with. */
  private jobOptionsOf(id: string): StoredJobOptions | null {
    const r = this.store.db.prepare('SELECT job_options FROM proposals WHERE id = ?').get(id) as
      { job_options: string | null } | undefined;
    return parseJson<StoredJobOptions | null>(r?.job_options, null);
  }

  /** v2 C1: the verify result of the approved job, once it ran (from the job's own record). */
  private execution(p: ProposalView): ProposalDetail['execution'] {
    const stored = this.store.db.prepare('SELECT verification FROM proposals WHERE id = ?').get(p.id) as
      { verification: string | null } | undefined;
    const kept = parseJson<{ verified: boolean | null; verification: unknown } | null>(
      stored?.verification,
      null,
    );
    if (kept) return kept;
    if (!p.jobId || !this.engine) return null;
    const job = this.engine.queries.getJob(p.projectId, p.jobId);
    const r = (job?.result ?? null) as { verified?: unknown; verification?: unknown } | null;
    if (!r || r.verification === undefined) return null;
    return { verified: typeof r.verified === 'boolean' ? r.verified : null, verification: r.verification };
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
      operation: p.operation,
      requiresCanonicalApproval: p.requiresCanonicalApproval,
      canonicalReason: p.requiresCanonicalApproval ? (this.canonicalOf(p.id)?.reason ?? null) : null,
      pages: p.pages,
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
      projectId: p.projectId,
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
    // v2 C2a: the bridge's own check and verify steps are submitted exactly as stored.
    if (isBridgeStep(op.op)) return { op: op.op, params, ...stepOptions(op.options) };
    const def = requireOperation(op.op);
    const keys = [params.path?.resourceId, params.path?.documentId].filter((k): k is string => !!k);
    let p: OpParams = params;
    const chained = (op.options as StepOptions).ifMatchFrom !== undefined; // v2 C2a: bound in the job
    if (
      def.versioned &&
      !chained &&
      params.ifMatch === undefined &&
      op.version !== null &&
      !keys.some((k) => touched.has(k))
    ) {
      p = { ...params, ifMatch: op.version };
    }
    if (def.kind !== 'read') for (const k of keys) touched.add(k);
    return { op: op.op, params: p, ...stepOptions(op.options) };
  });
}

/** v2 C2b: the resources an operation creates with client ids (a create, a template copy, a batch). */
function createdIds(op: string, params: OpParams): string[] {
  const body = params.body as Record<string, unknown> | undefined;
  if (!body) return [];
  if (op === 'createResource' || op === 'createResourceFromTemplate')
    return typeof body.id === 'string' ? [body.id] : [];
  if (op === 'createManyResources' && Array.isArray(body.resources)) {
    return (body.resources as Record<string, unknown>[])
      .map((r) => r?.id)
      .filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/** v2 C2a: a create's client id(s), minted now where the operation takes one and none was given. */
function withMintedIds(o: ProposedOp): ProposedOp {
  if (isBridgeStep(o.op) || !getOperation(o.op)) return o;
  const meta = opMeta(o.op);
  const body = o.params.body as Record<string, unknown> | undefined;
  if (meta.clientId === 'body.id' && body && body.id === undefined) {
    return { ...o, params: { ...o.params, body: { ...body, id: mintClientId() } } };
  }
  if (meta.clientId === 'body.resources[].id' && body && Array.isArray(body.resources)) {
    const resources = (body.resources as Record<string, unknown>[]).map((r) =>
      r && typeof r === 'object' && r.id === undefined ? { ...r, id: mintClientId() } : r,
    );
    return { ...o, params: { ...o.params, body: { ...body, resources } } };
  }
  return o;
}

function stepOptions(o: StepOptions): StepOptions {
  return {
    ...(o.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
    ...(o.confirm === 'cascade' ? { confirm: 'cascade' as const } : {}),
    // v2 C1: an approved page write is verified and journalled with its operation like a direct one. It is never
    // re-planned (`replan` is not kept): the owner approves exactly the expansion they saw.
    ...(o.verifyAfterWrite === true ? { verifyAfterWrite: true } : {}),
    ...(o.journalOperation ? { journalOperation: o.journalOperation } : {}),
    // v2 C2a: a multi-step write's chain, in-step check, tree re-read and pre-image, exactly as planned.
    ...(o.ifMatchFrom ? { ifMatchFrom: o.ifMatchFrom } : {}),
    ...(o.expectCurrent ? { expectCurrent: o.expectCurrent } : {}),
    ...(o.deferTreeReread === true ? { deferTreeReread: true } : {}),
    ...(o.journalPreImage !== undefined ? { journalPreImage: o.journalPreImage } : {}),
    // v2 D2: a folder's cascade delete keeps what it removes in its own journal entry.
    ...(o.journalPreImageWith !== undefined ? { journalPreImageWith: o.journalPreImageWith } : {}),
    // v2 C2b: a write to a page the same job creates from a template: its ids are bound in the job.
    ...(o.bindIds ? { bindIds: o.bindIds } : {}),
    // v2 D1: a chronology write whose place or new count the job's own check works out inside the lock.
    ...(o.bindBody ? { bindBody: o.bindBody } : {}),
    ...(o.judgedInLock === true ? { judgedInLock: true } : {}),
    // v2 E1a (ADR 0042 decision 9): a field LegendKeeper may refuse (an icon name) is dropped, and the run says so.
    ...(o.dropIfRefused ? { dropIfRefused: o.dropIfRefused } : {}),
    // v2 D3 (ADR 0041): a folder (or asset) the same job creates, its id bound in the job (an image placement).
    ...(o.bindFrom ? { bindFrom: o.bindFrom } : {}),
    // v3 F2 (ADR 0049): the Last Major Revision write, decided and dated when the approved job runs; never fatal.
    ...(o.decisionFrom ? { decisionFrom: o.decisionFrom } : {}),
    ...(o.followUp ? { followUp: o.followUp } : {}),
    // v3 F2 (ADR 0049 decision 9): a planned folder is found or created when the approved job runs.
    ...(o.findOrCreate === true ? { findOrCreate: true } : {}),
    ...(o.onlyIfEmpty === true ? { onlyIfEmpty: true } : {}),
    // v3 F3a (ADR 0050): a new page's image blocks name the assets the same approved job uploads, and its text is
    // fitted into the template copy's content inside the lock (keeping only what Markdown cannot express there).
    ...(o.bindAssetUrls ? { bindAssetUrls: o.bindAssetUrls } : {}),
    ...(o.fill ? { fill: o.fill } : {}),
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

/** The JSON of `v` if it fits in `maxBytes`; otherwise a prefix of at most `maxBytes` bytes (none when 0). */
function capJson(v: unknown, maxBytes: number): { text: string | null; truncated: boolean } {
  const text = JSON.stringify(v ?? null);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  if (maxBytes <= 0) return { text: null, truncated: true };
  // Cut by bytes, not characters (multi-byte text could otherwise exceed the cap), dropping a split last character.
  return {
    text: bytes
      .subarray(0, maxBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, ''),
    truncated: true,
  };
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
