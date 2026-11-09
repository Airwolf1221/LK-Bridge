/** Shared types of the job engine (PLAN §6). */
import type { PriorityClass } from '../config/lk.js';
import type { OperationKind } from '../lk/registry-types.js';

export type { PriorityClass } from '../config/lk.js';

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_budget',
  'waiting_lock',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'] as const;
/**
 * `uncertain`: the step may or may not have reached LK and the bridge could not establish which without risking a
 * duplicate. The job ends `failed` with `uncertain: true`; a person decides (retry the step, or check LK).
 */
export type StepStatus = (typeof STEP_STATUSES)[number];

export type JobKind = 'single_op' | 'batch_ops' | 'paginate_all' | 'upload_image';
export type OnError = 'stop' | 'continue';

/**
 * The identity work is done for. `principalId` is stable (an owner, an OAuth client, a PAT…), `profile` names the
 * policy profile it acts under, `label` is for display. The policy store that assigns them comes in a later chunk.
 */
export interface Principal {
  readonly principalId: string;
  readonly profile: string;
  readonly label: string;
}

/** The default for internal and UI-initiated work. */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  principalId: 'system',
  profile: 'system',
  label: 'System',
});

/** Who asked for the work. `kind` and the principal are filterable; the rest is shown in the UI. */
export interface JobOrigin {
  readonly kind: 'mcp' | 'ui' | 'system' | 'maintenance' | 'test';
  /** MCP client name or OAuth client id, PAT name, etc. */
  readonly client?: string;
  /** MCP tool or UI action. */
  readonly tool?: string;
  readonly detail?: string;
  /** Defaults to `SYSTEM_PRINCIPAL`. */
  readonly principal?: Principal;
  /** Who approved this work, when it ran from an approved proposal (recorded on the job and journal entries). */
  readonly approvedBy?: string;
  /**
   * Opaque proof of the owner's approval (src/policy). The engine never reads it; it only hands it to the policy
   * gate in `ctx.origin`. Only the policy layer can mint a valid one, and it serialises to `{ proposalId }` only.
   */
  readonly approval?: unknown;
}

/** Caller-facing input of a registry operation: `{ path?, query?, ifMatch?, body? }` (see src/lk/registry). */
export interface OpParams {
  readonly path?: Record<string, string>;
  readonly query?: Record<string, unknown>;
  readonly ifMatch?: string;
  readonly body?: unknown;
}

/** Per-step options that are not LK parameters. */
export interface StepOptions {
  /** PLAN §4 rule 2: let a replace drop `unsupported` blocks. Default false. */
  readonly allowUnsupportedLoss?: boolean;
  /** PLAN §4 rule 3: `deleteResource` with `cascade=true` needs `confirm: "cascade"`. */
  readonly confirm?: 'cascade';
}

export interface StepSpec extends StepOptions {
  readonly op: string;
  readonly params?: OpParams;
}

export interface RunOptions extends StepOptions {
  /** v2 A1: the LegendKeeper id of the project the operation is for. Required: there is no default in the engine. */
  readonly project: string;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
  /** Aborts waiting (inline reads, and an inline write while it waits for a lock or slot). */
  readonly signal?: AbortSignal;
}

export interface BatchSubmit {
  readonly kind: 'batch_ops';
  /** v2 A1: the project every step runs against. */
  readonly project: string;
  readonly steps: readonly StepSpec[];
  readonly onError?: OnError;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
}

export interface PaginateSubmit {
  readonly kind: 'paginate_all';
  readonly project: string;
  readonly op: string;
  readonly params?: OpParams;
  /** Lower caps than the engine's (never higher). */
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
}

/**
 * An image upload (PLAN §4 rule 5): `createImageUpload`, the signed-URL PUT (a custom step, not an LK call), then
 * `createImageAsset`. The bytes are checked by the caller (type, size, magic bytes) and stored with the PUT step so a
 * restart can send them again.
 */
export interface UploadImageSubmit {
  readonly kind: 'upload_image';
  readonly project: string;
  readonly contentType: string;
  /** Exactly the number of bytes in `dataBase64`. */
  readonly contentLength: number;
  /** Lowercase hex SHA-256 of the bytes; sent to LK so storage rejects a mismatch. */
  readonly contentHash?: string;
  readonly dataBase64: string;
  readonly name: string;
  readonly description?: string;
  readonly folderId?: string;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
}

export type SubmitRequest = BatchSubmit | PaginateSubmit | UploadImageSubmit;

export interface SubmitResult {
  readonly jobId: string;
  readonly status: JobStatus;
  /** Projected completion (ms since epoch) from governor.estimate, or null when unknown (writes paused, etc.). */
  readonly eta: number | null;
}

export type RunResult =
  | {
      readonly status: 'succeeded';
      /** Null for inline reads (they are not recorded as jobs). */
      readonly jobId: string | null;
      readonly result: unknown;
      readonly requestIds: readonly string[];
    }
  | {
      readonly status: 'queued' | 'waiting_budget';
      readonly jobId: string;
      readonly eta: number | null;
      readonly reason: 'estimate' | 'budget' | 'writes_paused' | 'read_only' | 'project_unavailable';
    }
  | ProposalCaptured;

/** The policy gate asked for approval: nothing was queued; the proposal sink holds the work. */
export interface ProposalCaptured {
  readonly status: 'proposal_captured';
  readonly proposalId: string;
  /** One line describing what was proposed, when the sink gives one. */
  readonly summary?: string;
}

export interface JobError {
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
  readonly status?: number | undefined;
  readonly requestId?: string | undefined;
  readonly classification?: string | undefined;
  readonly stepNo?: number | undefined;
  readonly [key: string]: unknown;
}

export interface JobView {
  readonly id: string;
  /** v2 A1: the LegendKeeper id of the project the job works on. */
  readonly projectId: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly origin: JobOrigin;
  /** Copies of `origin.principal` / `origin.approvedBy`, as stored in their own columns. */
  readonly principalId: string;
  readonly profile: string;
  readonly approvedBy: string | null;
  readonly priority: PriorityClass;
  readonly status: JobStatus;
  readonly onError: OnError;
  readonly progress: {
    readonly stepsDone: number;
    readonly stepsTotal: number;
    readonly stepsFailed: number;
  };
  readonly currentStep: number | null;
  readonly resumeAt: number | null;
  readonly waitReason: Record<string, unknown> | null;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  /** Set when a step ended `uncertain`: the UI flags the job for a person to check. */
  readonly uncertain: boolean;
  readonly lastError: JobError | null;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface StepView {
  readonly jobId: string;
  readonly projectId: string;
  readonly stepNo: number;
  readonly opId: string;
  readonly opKind: OperationKind;
  readonly params: OpParams | null;
  readonly paramsArtifactId: string | null;
  readonly paramsHash: string;
  readonly options: StepOptions;
  readonly attempt0: number;
  readonly idempotencyKey: string | null;
  readonly clientIds: readonly string[];
  readonly ifMatch: string | null;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly maybeSent: boolean;
  readonly requestIds: readonly string[];
  readonly resultSummary: unknown;
  readonly resultArtifactId: string | null;
  readonly error: JobError | null;
  readonly firstSentAt: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface JobWithSteps extends JobView {
  readonly steps: readonly StepView[];
  readonly artifacts: readonly ArtifactView[];
}

export interface ArtifactView {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly stepNo: number | null;
  readonly kind: 'params' | 'result' | 'items';
  readonly itemCount: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly truncatedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WriterSlotView {
  readonly slot: number;
  readonly state: 'idle' | 'busy';
  readonly projectId?: string;
  readonly jobId?: string;
  readonly stepNo?: number;
  readonly opId?: string;
  readonly principalId?: string;
  readonly profile?: string;
  readonly lockKey?: string | null;
  readonly resourceId?: string | null;
  readonly documentId?: string | null;
  readonly since?: number;
}

export interface WritersView {
  readonly max: number;
  readonly busy: number;
  readonly slots: readonly WriterSlotView[];
  /** Steps waiting for a slot, oldest first. They are served round-robin across projects, then oldest first (v2 A1). */
  readonly waiting: readonly {
    readonly projectId: string;
    readonly jobId: string;
    readonly stepNo: number;
    readonly opId: string;
  }[];
}

export interface LockView {
  /** `<projectId>:doc:<id>` and so on: locks are per project and per entity (v2 A1). */
  readonly key: string;
  readonly holder: { readonly jobId: string; readonly stepNo: number; readonly since: number };
  readonly waiting: readonly { readonly jobId: string; readonly stepNo: number; readonly since: number }[];
}

export interface ControlsView {
  readonly writesPaused: boolean;
  readonly draining: boolean;
  /**
   * Effective read-only flag: the runtime override if set, else LK_READ_ONLY. Asked for one project
   * (`controls(projectId)`), it is also true when that project's own read-only flag is on (v2 A1).
   */
  readonly readOnly: boolean;
  readonly readOnlyOverride: boolean | null;
  readonly writersMax: number;
  readonly allowMemberAdmin: boolean;
  /** Present when asked for one project: its own flag and whether it is served now (v2 A1). */
  readonly project?: {
    readonly id: string;
    readonly name: string;
    readonly readOnly: boolean;
    readonly available: boolean;
  };
}

export interface JobFilter {
  readonly status?: JobStatus | readonly JobStatus[];
  readonly originKind?: JobOrigin['kind'];
  readonly principalId?: string;
  readonly profile?: string;
  readonly kind?: JobKind;
  /** Only jobs created before this time (ms), for paging back through history. */
  readonly before?: number;
  readonly limit?: number;
}
