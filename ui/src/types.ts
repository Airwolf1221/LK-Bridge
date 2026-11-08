/** Shapes of the admin API (docs/dashboard.md). Only the fields the pages use are described. */

export type Scope = 'read' | 'propose' | 'write';
export type TierId =
  | 'write-min'
  | 'write-hour'
  | 'key-min'
  | 'key-hour'
  | 'key-day'
  | 'project-hour'
  | 'items-min'
  | 'items-hour'
  | 'upload';
export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3';
export type JobStatus =
  'queued' | 'running' | 'waiting_budget' | 'waiting_lock' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';

export interface SessionInfo {
  authenticated: true;
  username: string;
  csrfToken: string;
  logoutCsrfToken: string;
  logoutPath: string;
  version: string;
  publicUrl: string;
}

export interface Controls {
  writesPaused: boolean;
  draining: boolean;
  readOnly: boolean;
  readOnlyOverride: boolean | null;
  writersMax: number;
  allowMemberAdmin: boolean;
}

export interface TierSnapshot {
  tier: TierId;
  limit: number | null;
  configuredLimit: number | null;
  used: number;
  remaining: number | null;
  windowMs: number | null;
  resetAtMs: number | null;
  blockedUntilMs: number | null;
  inFlight: number;
  reactiveOnly: boolean;
  drift: { atMs: number; observedUsed: number; modelledUsed: number; delta: number } | null;
}

export interface BudgetSnapshot {
  atMs: number;
  tiers: Record<TierId, TierSnapshot>;
  queues: Record<PriorityClass, number>;
  inFlight: number;
  writeSpacingMs: number;
  nextWriteAtMs: number | null;
}

export interface BudgetPayload {
  snapshot: BudgetSnapshot;
  writesPerMinute: number;
}

export interface Health {
  checkedAt: number;
  reachable: boolean | null;
  projectName: string | null;
  keyRole: 'ADMIN' | 'MEMBER' | 'unknown';
  plan: 'ok' | 'unpaid' | 'unknown';
  note: string | null;
}

export interface Overview {
  health: Health;
  controls: Controls;
  activeJobs: {
    total: number;
    running: number;
    queued: number;
    waiting: number;
    paused: number;
    uncertain: number;
  };
  errorsLastHour: { count: number; capped: boolean };
  pendingProposals: number;
  writes: { state: 'running' | 'paused' | 'draining'; perMinute: number };
  budget: { queues: Record<PriorityClass, number>; gauges: TierSnapshot[] };
}

export interface JobOrigin {
  kind: 'mcp' | 'ui' | 'system' | 'maintenance' | 'test';
  client?: string;
  tool?: string;
  detail?: string;
}

export interface Job {
  id: string;
  kind: string;
  title: string;
  origin: JobOrigin;
  principalId: string;
  profile: string;
  approvedBy: string | null;
  priority: PriorityClass;
  status: JobStatus;
  progress: { stepsDone: number; stepsTotal: number; stepsFailed: number };
  currentStep: number | null;
  resumeAt: number | null;
  waitReason: Record<string, unknown> | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  uncertain: boolean;
  lastError: { code?: string; message: string; requestId?: string; stepNo?: number } | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Step {
  jobId: string;
  stepNo: number;
  opId: string;
  opKind: string;
  params: unknown;
  attempt0: number;
  idempotencyKey: string | null;
  clientIds: string[];
  ifMatch: string | null;
  status: StepStatus;
  attempts: number;
  maybeSent: boolean;
  requestIds: string[];
  resultSummary: unknown;
  error: { code?: string; message: string; requestId?: string; status?: number } | null;
  startedAt: number | null;
  finishedAt: number | null;
  retry?: { allowed: boolean; ambiguous: boolean; warning: string | null };
}

export interface Artifact {
  id: string;
  jobId: string;
  stepNo: number | null;
  kind: 'params' | 'result' | 'items';
  itemCount: number;
  bytes: number;
  truncated: boolean;
  truncatedReason: string | null;
}

export interface JobDetail extends Job {
  steps: Step[];
  artifacts: Artifact[];
}

export interface ErrorGroup {
  fingerprint: string;
  opId: string;
  code: string | null;
  path: string;
  classification: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolved: boolean;
  lastMessage: string;
  lastRequestId: string | null;
  lastJobId: string | null;
}

export interface ErrorRecord {
  id: number;
  at: number;
  opId: string;
  jobId: string | null;
  stepNo: number | null;
  principalId: string;
  profile: string;
  status: number | null;
  code: string | null;
  message: string;
  issues: { path: string; message: string }[];
  requestId: string | null;
  retryable: boolean;
  classification: string;
  detail: Record<string, unknown> | null;
  resolvedAt: number | null;
}

export interface BudgetsResponse extends BudgetPayload {
  tierOrder: TierId[];
  reserveFloors: {
    current: { interactive: number; job: number; maintenance: number };
    environment: { interactive: number; job: number; maintenance: number };
    stored: { interactive: number; job: number; maintenance: number } | null;
  };
  projectDrift: TierSnapshot['drift'];
  samples: {
    since: number;
    until: number;
    bucketMs: number;
    count: number;
    points: {
      at: number;
      tiers: Partial<Record<TierId, { used: number; limit: number | null }>>;
      queues: Partial<Record<PriorityClass, number>>;
    }[];
  };
}

export interface WriterSlot {
  slot: number;
  state: 'idle' | 'busy';
  jobId?: string;
  stepNo?: number;
  opId?: string;
  principalId?: string;
  profile?: string;
  lockKey?: string | null;
  resourceId?: string | null;
  documentId?: string | null;
  since?: number;
}

export interface WritersResponse {
  writers: {
    max: number;
    busy: number;
    slots: WriterSlot[];
    waiting: { jobId: string; stepNo: number; opId: string }[];
  };
  locks: {
    key: string;
    holder: { jobId: string; stepNo: number; since: number };
    waiting: { jobId: string; stepNo: number; since: number }[];
  }[];
  controls: Controls;
  jobs: Record<string, { title: string; status: string; profile: string; principalId: string }>;
  writesPerMinute: number;
  writeMinuteLimit: number | null;
  writeSpacingMs: number;
}

export type ProposalState =
  'pending' | 'approved' | 'rejected' | 'conflicted' | 'expired' | 'executing' | 'executed' | 'failed';

export interface Proposal {
  id: string;
  principalId: string;
  principalLabel: string;
  profile: string;
  title: string;
  summary: string;
  state: ProposalState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  decidedAt: number | null;
  rejectReason: string | null;
  jobId: string | null;
  conflict: {
    index: number;
    op: string;
    reason: string;
    capturedVersion: string | null;
    currentVersion: string | null;
  } | null;
  error: Record<string, unknown> | null;
  opCount: number;
}

export interface ProposalOp {
  index: number;
  op: string;
  opKind: string;
  params: unknown;
  targetExists: boolean | null;
  version: string | null;
  preState: unknown;
  preStateTruncated: boolean;
  proposed: unknown;
  changes: { path: string; before: unknown; after: unknown }[];
  unsupportedLoss: string[];
}

export interface ProposalDetail extends Proposal {
  ops: ProposalOp[];
}

export interface Profile {
  id: string;
  label: string;
  kind: string;
  scope: Scope;
  connections: number;
}

export interface Connection {
  id: string;
  type: 'grant' | 'pat';
  label: string;
  clientId: string | null;
  profileId: string | null;
  profile: string | null;
  scope: Scope | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  active: boolean;
}

export interface ClientsResponse {
  profiles: Profile[];
  defaultScope: Scope;
  connections: Connection[];
  kinds: string[];
  scopes: Scope[];
}

export interface JournalEntry {
  id: number;
  at: number;
  jobId: string | null;
  stepNo: number | null;
  opId: string;
  principalId: string;
  profile: string;
  approvedBy: string | null;
  risk: string;
  targetKind: string;
  targetId: string | null;
  resourceId: string | null;
  documentId: string | null;
  version: string | null;
  params: unknown;
  preImage?: unknown;
  bytes: number;
  outcome: string;
}

interface Deferred<T> {
  running: T;
  stored: T | null;
  environment: T;
  pendingRestart: boolean;
  appliesAt: 'restart';
}

export interface SettingsView {
  readOnly: { effective: boolean; override: boolean | null; environment: boolean; appliesAt: 'immediately' };
  exposePerOpTools: Deferred<boolean>;
  memberAdmin: Deferred<boolean>;
  journalRetention: Deferred<{ retentionDays: number; maxBytes: number }>;
  tierLimits: {
    running: Record<string, number | null>;
    stored: Record<string, number> | null;
    environment: Record<string, number | null>;
    pendingRestart: boolean;
    tiers: string[];
    appliesAt: 'restart';
  };
  writersMax: number;
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
}
