import type { PrincipalNames } from './format';
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
/** v3 F9 (ADR 0074): P4 is bulk (the whole-repository passes). */
export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
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
  /** OPS2: whether sign-in (and re-authentication) asks for an authenticator code. */
  totpEnabled?: boolean;
}

export interface Controls {
  writesPaused: boolean;
  draining: boolean;
  /** Effective read-only flag. Asked for one project, it is also on when that project's own flag is on (v2 A1). */
  readOnly: boolean;
  readOnlyOverride: boolean | null;
  writersMax: number;
  allowMemberAdmin: boolean;
  /** Present when the controls were read for one project: its own flag and whether it is served now. */
  project?: { id: string; name: string; readOnly: boolean; available: boolean };
}

// ------------------------------------------------------------------------------------------- projects (v2 A1)

export type ProjectStatus = 'verifying' | 'active' | 'unverified' | 'stopped' | 'not_configured' | 'archived';

/** The project a scoped response is about. */
export interface ProjectRef {
  /** The LegendKeeper project id. */
  id: string;
  name: string;
}

/** One row of `GET /projects`. A key is never sent: only the name of the variable that holds it. */
export interface ProjectInfo {
  name: string;
  /** Null until a key has proved which LegendKeeper project it is. */
  id: string | null;
  displayName: string | null;
  isDefault: boolean;
  isSandbox: boolean;
  /** The project's own read-only flag (the bridge-wide flag on the Settings page applies as well). */
  readOnly: boolean;
  /** Listed in the env file with a key. */
  configured: boolean;
  /** Stored in the database (it has, or had, data). */
  registered: boolean;
  status: ProjectStatus;
  /** Plain-language reason for any status but `active`. */
  reason: string | null;
  /** The env variable that holds the key (its name only), when configured. */
  keyVariable: string | null;
  keyPresent: boolean;
  /** Whether the key authenticated at the last check (null: not checked yet, or not configured). */
  keyValid: boolean | null;
  verifiedAt: number | null;
  checkedAt: number | null;
  settings: Record<string, unknown>;
  settingsProblem: string | null;
  /** OPS2: where the key in use comes from: the encrypted store, the env file, or nowhere. */
  keySource?: 'store' | 'env' | null;
  /** OPS2: the last four characters of the key in use (all that is ever shown of a key). */
  keyHint?: string | null;
  /** OPS2: the env file holds another key than the store; the stored one is used. */
  keyConflict?: string | null;
  /** OPS2: paused and draining before removal. */
  draining?: boolean;
  /** OPS2: removed on the dashboard; its history is kept, read-only. */
  archived?: boolean;
  archivedAt?: number | null;
  /** OPS2: what keeps it from being removed now. */
  pending?: { jobs: number; proposals: number };
}

/** OPS2: what a key check found (nothing is stored until the owner confirms). Never the key. */
export interface KeyCheck {
  checkId: string;
  kind: 'add' | 'replace';
  name: string;
  lkProjectId: string;
  lkProjectName: string | null;
  role: 'ADMIN' | 'MEMBER' | 'unknown';
  keyHint: string;
  expiresAt: number;
}

/** OPS2: the owner's account (GET /security). */
export interface SecurityInfo {
  username: string;
  password: { source: 'store' | 'env' | null; problem: string | null };
  totp: {
    enabled: boolean;
    source: 'store' | 'env' | null;
    problem: string | null;
    recoveryCodesLeft: number;
    enrolmentPending: boolean;
  };
  reauth: { until: number | null; windowSeconds: number };
  /** ADR 0062: the owner's sessions kept on the server, and when this one ends unless used again. */
  sessions?: { active: number; thisEndsAt: number | null };
  store: {
    available: boolean;
    problem: string | null;
    keyId: string | null;
    stored: number;
    unreadable: number;
    underPrevious: number;
  };
  canManageKeys: boolean;
  warnings: string[];
  keyConflicts: { project: string; message: string }[];
}

export interface ProjectSettingKey {
  key: string;
  label: string;
  kind: string;
  /** v2 A2: the value used while none is stored. */
  default?: string | boolean;
  /** v2 A2: editable on the Projects page. */
  editable?: boolean;
  help?: string;
}

export interface ProjectsResponse {
  /** The default project's name. */
  default: string;
  requireProjectForWrites: boolean;
  singleProjectForm: boolean;
  settingKeys: ProjectSettingKey[];
  projects: ProjectInfo[];
  /** OPS2: keys can be added and replaced here (the encrypted store has its master key). */
  canManageKeys?: boolean;
  /** OPS2: start-up notes about the env file's project lines. */
  notes?: string[];
  /** v3 F2: the default the dashboard stored ("Make default"). */
  storedDefault?: string | null;
  /** v3 F2: LK_DEFAULT_PROJECT, when it is set and disagrees with the stored default (it then overrides it). */
  envOverride?: string | null;
  overrideNote?: string;
}

/** Every project's status, as the Overview lists it. */
export interface ProjectStatusSummary {
  name: string;
  id: string | null;
  status: ProjectStatus;
  reason: string | null;
  isDefault: boolean;
  readOnly: boolean;
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

/**
 * v2 E5.5: a limit LegendKeeper reported that matches no documented tier, learned for an operation group. It paces only
 * that group's calls and expires once its window has passed twice without being seen again.
 */
export interface OperationTierSnapshot {
  id: string;
  group: string;
  ops: string[];
  limit: number;
  windowMs: number;
  used: number;
  remaining: number;
  reportedRemaining: number;
  resetAtMs: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  blockedUntilMs: number | null;
  inFlight: number;
}

export interface BudgetSnapshot {
  atMs: number;
  tiers: Record<TierId, TierSnapshot>;
  /** v2 E5.5: learned operation limits (absent from a bridge before E5.5). */
  operationTiers?: OperationTierSnapshot[];
  queues: Record<PriorityClass, number>;
  inFlight: number;
  writeSpacingMs: number;
  nextWriteAtMs: number | null;
}

export interface BudgetPayload {
  snapshot: BudgetSnapshot;
  writesPerMinute: number;
}

/** The live stream's `budget` event: every project's budget, by LegendKeeper project id (one governor each). */
export interface BudgetStreamPayload {
  projects: Record<string, BudgetPayload & { name: string }>;
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
  project?: ProjectRef;
  /** Every project's status, so a stopped one shows on the Overview whichever project is selected. */
  projects?: ProjectStatusSummary[];
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
  /** v3 F5a (ADR 0067, H10): writes with an unknown outcome (being read back, or left for the owner). */
  unknownWrites?: { pending: number; unresolved: number };
  pendingProposals: number;
  /** v3 F3.4 (ADR 0055): agents' direct writes at scope `write` not reviewed yet (absent from an older bridge). */
  unreviewedDirectWrites?: number;
  /** v3 F5b (ADR 0068): what automation did in the last 24 hours (null: no project data). */
  automation?: AutomationOvernight | null;
  writes: { state: 'running' | 'paused' | 'draining'; perMinute: number };
  /** Null when the project has no governor now (its key is not in use). */
  budget: { queues: Record<PriorityClass, number>; gauges: TierSnapshot[] } | null;
  /** OPS2: the owner's sign-in and the secret store. */
  /** v2 E1b: the off-site copy's health (absent from a bridge without it). */
  offsite?: { state: 'not_set_up' | 'ok' | 'warning' | 'bad'; messages: string[] } | null;
  security?: {
    totpEnabled: boolean;
    canManageKeys: boolean;
    storeProblem: string | null;
    warnings: string[];
  };
}

export interface JobOrigin {
  kind: 'mcp' | 'ui' | 'system' | 'maintenance' | 'test';
  client?: string;
  tool?: string;
  detail?: string;
}

export interface Job {
  id: string;
  /** The LegendKeeper id of the project the job works on. */
  projectId?: string;
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
  projectId?: string;
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

/** v3 F3d (ADR 0058): where a package, a rename or a recreate stopped part-way. */
export interface JobStop {
  jobId: string;
  kind: 'package' | 'rename' | 'recreate' | 'split';
  /** Every step up to this one succeeded and none was read back different from its plan (0: none). */
  lastVerifiedStep: number;
  lastVerifiedLabel: string | null;
  stoppedStep: number | null;
  stoppedLabel: string | null;
  reason: string | null;
  status: 'failed' | 'cancelled';
  stoppedAt: number;
  resumes: number;
  lastResumedAt: number | null;
  lastResumedBy: string | null;
}

/** v3 F3d (ADR 0058): whether Resume applies to a stopped job now, and what it would do. */
export interface ResumeView {
  resumable: boolean;
  reason: { code: string; message: string } | null;
  kind: JobStop['kind'] | null;
  stop: JobStop | null;
  left: { stepNo: number; op: string; status: string }[];
  recheck: number[];
  approvedBy: string | null;
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
  projectId?: string;
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

export interface BudgetSamples {
  since: number;
  until: number;
  bucketMs: number;
  count: number;
  points: {
    at: number;
    tiers: Partial<Record<TierId, { used: number; limit: number | null }>>;
    queues: Partial<Record<PriorityClass, number>>;
  }[];
}

export interface BudgetsResponse extends BudgetPayload {
  project?: ProjectRef;
  tierOrder: TierId[];
  reserveFloors: {
    current: { interactive: number; job: number; maintenance: number; bulk: number };
    environment: { interactive: number; job: number; maintenance: number; bulk: number };
    /** `bulk` only when the owner saved one (v3 F9). */
    stored: { interactive: number; job: number; maintenance: number; bulk?: number } | null;
    /** v3 F9: the bulk floor is set (saved here or in the environment) rather than following the default. */
    bulkExplicit: boolean;
  };
  projectDrift: TierSnapshot['drift'];
  samples: BudgetSamples;
}

/** `GET /budgets/all`: every project with a governor, side by side. */
export interface BudgetsAllResponse {
  tierOrder: TierId[];
  projects: (BudgetPayload & {
    project: ProjectRef;
    status: ProjectStatus | 'unknown';
    projectDrift: TierSnapshot['drift'];
    samples: BudgetSamples;
  })[];
}

export interface WriterSlot {
  slot: number;
  state: 'idle' | 'busy';
  /** The LegendKeeper id of the busy step's project (the pool is shared by every project). */
  projectId?: string;
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
  /** The project whose budget figures (writes per minute) are shown; slots and locks span every project. */
  project?: ProjectRef;
  writers: {
    max: number;
    busy: number;
    slots: WriterSlot[];
    waiting: { projectId?: string; jobId: string; stepNo: number; opId: string }[];
  };
  locks: {
    /** `<projectId>:doc:<id>` and so on. */
    key: string;
    holder: { jobId: string; stepNo: number; since: number };
    waiting: { jobId: string; stepNo: number; since: number }[];
  }[];
  controls: Controls;
  jobs: Record<
    string,
    { title: string; status: string; profile: string; principalId: string; project?: string }
  >;
  writesPerMinute: number;
  writeMinuteLimit: number | null;
  writeSpacingMs: number;
}

export type ProposalState =
  'pending' | 'approved' | 'rejected' | 'conflicted' | 'expired' | 'executing' | 'executed' | 'failed';

export interface Proposal {
  /** v3 F5a (ADR 0067, H4): the tool that proposed it, or null. */
  tool?: string | null;
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
  /** v2 C1: the high-level operation, briefly (write_page: page, document, mode, section…), or null. */
  operation?: ProposalOperationBrief | null;
  /** v2 C2a: the change touches protected canon: only "Approve and accept as canon" can approve it. */
  requiresCanonicalApproval?: boolean;
  canonicalApprovedBy?: string | null;
  canonicalApprovedAt?: number | null;
  /** v2 C2a: the page-level summary, one plain line per page. */
  pages?: string[];
  /** v3 F3d (ADR 0058): a proposal made of items: how many, and (once decided) how many approved and left out. */
  items?: { total: number; approved: number | null; omitted: number | null } | null;
  /** v3 F3d: the proposal made of this one's left-out items ("Propose these again"), and the one this one came from. */
  reproposedAs?: string | null;
  reproposalOf?: string | null;
}

/** v3 F3d (ADR 0058): one item of a proposal made of items (a package's page, one edit of a rename). */
export interface PlanItem {
  id: string;
  kind: string;
  group: string;
  label: string;
  page?: { id: string; name: string } | null;
  diff?: {
    before?: string | null;
    after?: string | null;
    context?: string;
    changes?: {
      what: string;
      before: string | null;
      after: string | null;
      /** Amendment 1 to ADR 0072: a change of words: the replaced words in `before`, the new ones in `after`. */
      removed?: TextSpan;
      added?: TextSpan;
    }[];
  };
  /** The items it needs: leaving one of them out leaves this one out too. */
  dependsOn: string[];
  /** Ticked by the plan (a rename's D1 (a) rules untick some, saying why). */
  selected: boolean;
  why?: string;
  tags?: string[];
}

/** Amendment 1 to ADR 0072: character offsets of the words that change (end exclusive). */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * Amendment 1 to ADR 0072: one change of a page's words as the owner reads it (src/jobs/text-change.ts): the sentence(s)
 * before and after, and where the replaced words are in each.
 */
export interface TextChange {
  page: string;
  pageId?: string;
  blockId?: string;
  what?: string;
  before: string;
  after: string;
  removed: TextSpan;
  added: TextSpan;
}

/** v2 C2a: one line of a proposal's page-level summary. */
export interface PageSummaryEntry {
  resourceId: string | null;
  page: string;
  isNew: boolean;
  parts: string[];
  label: string;
}

/** v2 C2a: a protected canonical change, as the guard describes it. */
export interface ProtectedChange {
  ruleId?: string;
  key?: string;
  direction?: 'to' | 'from' | 'change' | 'delete';
  value?: string;
  before?: string[];
  after?: string[];
  page?: string;
  text?: string;
  unchecked?: string;
  /**
   * v2 C2c: a lifecycle change. The marker's own entry names the tool (`promote_page`) and its pages, with no text; the
   * guard's entries name what changed (`status`, `prefix`, `tag`) with a text.
   */
  lifecycle?: string;
  pages?: { id: string; to: string | null }[];
}

/** v2 C2a: set_facts' high-level operation, as a proposal keeps it. */
export interface FactsOperation {
  tool: 'set_facts';
  page?: { id: string; name: string; path?: string };
  property?: string;
  pageParts?: string[];
  facts?: { key: string; before: string | null; after: string | null; change: string }[];
  rowsBefore?: { key: string; value: string }[];
  rowsAfter?: { key: string; value: string }[];
  links?: {
    title: string;
    added: { name: string; document?: string }[];
    removed: { name: string; document?: string }[];
    alreadyLinked: { name: string; document?: string }[];
    notLinked: { name: string; document?: string }[];
    filtered?: boolean;
  }[];
  notes?: string[];
}

/** v2 C1: what a high-level tool proposed (write_page). */
export interface ProposalOperationBrief {
  tool?: string;
  page?: { id: string; name: string; path?: string };
  document?: { id: string; name: string | null };
  mode?: string;
  section?: string;
  plannedOn?: string;
  baseVersion?: string;
  counts?: Record<string, number>;
}

export interface MarkdownDiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export interface MarkdownDiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  lines: MarkdownDiffLine[];
}

export interface MarkdownDiff {
  added: number;
  removed: number;
  hunks: MarkdownDiffHunk[];
  coarse?: boolean;
}

export interface ProposalOp {
  index: number;
  op: string;
  /** v2 E6 (ADR 0048): the operation in plain words (page, document, entity), or the ids. */
  label?: string;
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
  /** v2 C1: the whole high-level operation (with the agent's Markdown), or null for a v1 proposal. */
  operationDetail?: (ProposalOperationBrief & { markdown?: string; dropRegions?: string[] }) | null;
  /** v2 C1: the page's Markdown before and after, line by line; keep regions are labelled placeholders. */
  markdownDiff?: MarkdownDiff | null;
  /** v2 C1: what the read after the approved write found. */
  execution?: { verified: boolean | null; verification: unknown } | null;
  /** v2 C2a: every high-level operation (C1's operationDetail is the first). */
  operations?: (Record<string, unknown> & { tool?: string })[];
  /** v2 C2a: the operations grouped by the page they affect. */
  pageSummary?: PageSummaryEntry[];
  /** v2 C2a: the protected changes, when the proposal needs canonical approval. */
  canonical?: { reason: string; changes: ProtectedChange[] } | null;
  /** v3 F3d (ADR 0058): its items, and (once decided) the ids approved and left out; null for an ordinary proposal. */
  itemPlan?: {
    items: PlanItem[];
    approved: string[] | null;
    omitted: string[] | null;
    /** v3 F3d amendment (ADR 0058, A): the approved items the job skipped because what they edit changed meanwhile. */
    skipped?: SkippedItem[];
  } | null;
}

/** v2 C2a: a project's protected canonical facts rules. */
export interface CanonRule {
  id: string;
  /** Absent for `deleteKind` (it names a prefix, not a fact). */
  key?: string;
  /**
   * `delete` (v2 C2b): deleting a page whose fact holds one of `values` needs canonical approval. v2 C2c: `deleteKind`
   * (deleting a page of these kinds, by prefix) and `deleteDocument` (deleting a document of these types of a page whose
   * fact holds one of `values`).
   */
  kind: 'value' | 'change' | 'delete' | 'deleteKind' | 'deleteDocument' | 'statusTags';
  values?: string[];
  kinds?: string[];
  documentTypes?: string[];
  note?: string;
  /** v2 C2c: false switches the rule off (kept in the list). */
  enabled?: boolean;
}

export interface CanonConfig {
  project: string;
  rules: CanonRule[];
  defaults: boolean;
  agentDefaultStatus: string;
  problem: string | null;
  defaultRules: CanonRule[];
}

export interface ProposalCounts {
  project?: ProjectRef;
  /** Counts by state, for the selected project. */
  counts: Record<string, number>;
  /** Every project's pending count, by project name. */
  byProject?: Record<string, number>;
}

export interface Profile {
  id: string;
  label: string;
  kind: string;
  scope: Scope;
  /** v2 B2: shown the low-level tools in tools/list. */
  showLowLevelTools: boolean;
  /** v3 F3.4 (ADR 0055): what still becomes a proposal at scope `write` (absent from an older bridge). */
  rails?: WriteRails;
  connections: number;
}

/** v3 F3.4 (ADR 0055): a profile's safety rails at scope `write`. */
export interface WriteRails {
  deletes: boolean;
  bulk: boolean;
  bulkPages: number;
  renamesMoves: boolean;
  assets: boolean;
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
  /** Active, but unused for longer than `settings.staleAfterDays`. */
  stale: boolean;
}

export interface ClientsResponse {
  profiles: Profile[];
  defaultScope: Scope;
  connections: Connection[];
  /** In days; 0 = never. */
  settings: { autoRemoveDays: number; staleAfterDays: number };
  kinds: string[];
  scopes: Scope[];
}

/** v3 F5a (ADR 0067, H10): how a write whose outcome was unknown was (or is being) settled. */
export interface Reconciliation {
  journalId: number;
  state: 'pending' | 'settled' | 'unresolved';
  outcome: 'applied' | 'not_applied' | 'superseded' | 'unknown' | null;
  attempts: number;
  settledAt: number | null;
  settledBy: string | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
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
  /** v2 C1: the high-level operation (write_page: mode, section, a hash of the Markdown…), or null. */
  operation?: unknown;
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
  contactEmail: { stored: string | null; appliesAt: 'immediately' };
  writersMax: number;
}

// ------------------------------------------------------------------------------- every setting (v3 F8, ADR 0073)

export interface ConfigUnit {
  base: string;
  display: string;
  factor: number;
}

export interface ConfigEntry {
  key: string;
  group: string;
  label: string;
  description: string;
  type: 'integer' | 'number' | 'boolean' | 'enum' | 'string' | 'url' | 'list' | 'json';
  unit: ConfigUnit | null;
  default: unknown;
  min: number | null;
  max: number | null;
  enum: string[] | null;
  integer: boolean;
  applies: 'now' | 'next_start' | 'bootstrap';
  secret: boolean;
  editedOn: 'settings' | 'projects' | 'server';
  editable: boolean;
  bootstrapReason: string | null;
  managedAt: { label: string; href: string } | null;
  projectSetting: string | null;
  scope: 'env' | 'dashboard' | 'project';
  value?: unknown;
  source?: 'default' | 'environment' | 'dashboard';
  environment?: unknown;
  dashboard?: unknown;
  running?: unknown;
  pendingRestart: boolean;
  isSet?: boolean;
  setIn?: 'environment' | 'secret store' | null;
}

export interface RestartStatus {
  available: boolean;
  reason: string | null;
  last: { requestedAt: number; by: string; backAt: number | null } | null;
  inProgress: boolean;
}

export interface ConfigView {
  groups: { id: string; label: string }[];
  entries: ConfigEntry[];
  pendingRestart: number;
  restart: RestartStatus;
  dropped: string[];
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

// ------------------------------------------------------------------------------------- repository tree (v2 A2)

export type TreeStatusName = 'not_configured' | 'not_built' | 'building' | 'ready' | 'stale';

export interface TreeMetaView {
  projectId: string;
  status: TreeStatusName;
  reason: string | null;
  rootId: string | null;
  confirmedAt: number | null;
  confirmedBy: 'build' | 'sweep' | 'check' | null;
  staleNodes: number;
  pendingRereads: number;
}

export interface TreeNodeView {
  id: string;
  rawName: string;
  displayName: string;
  kind: 'root' | 'index' | 'bsrc' | 'bwrk' | 'barc' | 'unclassified';
  parentId: string | null;
  rank: string | null;
  depth: number;
  path: { ids: string[]; names: string[] };
  tags: string[];
  aliases: string[];
  documents: { id: string; name: string | null; type: string | null }[];
  isHidden: boolean;
  isLocked: boolean | null;
  referenceType: string | null;
  scope: string | null;
  indexScope: string | null;
  canonicalDisplayName: string | null;
  propertiesFound: boolean | null;
  templateId: string | null;
  lastReadAt: number;
  lastReadBy: 'build' | 'write' | 'sweep' | 'check';
  propertiesPending: boolean;
  stale: boolean;
  staleReason: string | null;
}

export interface TreePass {
  id: string;
  projectId: string;
  kind: 'build' | 'sweep' | 'check';
  trigger: string;
  status:
    'listing' | 'awaiting_confirmation' | 'reading' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  rootId: string;
  snapshotAt: number | null;
  pages: number;
  listed: number;
  subtree: number | null;
  toRead: number | null;
  readOk: number;
  readFailed: number;
  requests: number;
  added: number;
  removed: number;
  corrected: number;
  estimate: {
    listed: number;
    subtree: number;
    reads: number;
    listingRequests: number;
    wallClockMs: number;
    fitsInDailyBudget: boolean;
    tightestTier: string | null;
    at: number;
  } | null;
  summary: string | null;
  error: string | null;
  jobId: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface TreeCorrection {
  id: number;
  at: number;
  source: 'build' | 'sweep' | 'check' | 'write';
  passId: string | null;
  nodeId: string;
  nodeName: string | null;
  change: 'added' | 'removed' | 'updated' | 'reread_failed';
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  detail: string | null;
}

export interface TreeOverview {
  project: { id: string; name: string };
  tree: TreeMetaView;
  settings: {
    rootId: string | null;
    propertiesName: string;
    referenceTypeRow: string;
    scopeRow: string;
    indexScopeRow: string;
    canonicalNameRow: string;
    sweepEnabled: boolean;
  };
  counts: {
    total: number;
    byKind: Record<'root' | 'index' | 'bsrc' | 'bwrk' | 'barc' | 'unclassified', number>;
    maxDepth: number;
    stale: number;
    propertiesPending: number;
  };
  unclassified: TreeNodeView[];
  staleNodes: TreeNodeView[];
  activePass: TreePass | null;
  lastBuild: TreePass | null;
  lastSweep: TreePass | null;
  lastCheck: TreePass | null;
  recentPasses: TreePass[];
  rereads: {
    inFlight: number;
    failed: {
      id: number;
      op: string;
      jobId: string | null;
      resourceIds: string[];
      attempts: number;
      lastError: string | null;
      nextAt: number | null;
      createdAt: number;
    }[];
  };
  suggestion: {
    at: number;
    candidates: { id: string; name: string }[];
    suggested: string | null;
    listed: number;
    error: string | null;
  } | null;
  suggesting: boolean;
  now: number;
}

// ------------------------------------------------------------------------------------- asset tree (v2 A4)

export type AssetTreeStatusName = 'not_built' | 'building' | 'ready' | 'stale';

export interface AssetMetaView {
  projectId: string;
  status: AssetTreeStatusName;
  reason: string | null;
  confirmedAt: number | null;
  confirmedBy: 'build' | 'refresh' | 'check' | null;
  staleRows: number;
  pendingRereads: number;
}

export interface AssetFolderView {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  path: { ids: string[]; names: string[] };
  isHidden: boolean;
  lastReadAt: number;
  lastReadBy: 'build' | 'write' | 'refresh' | 'check';
  stale: boolean;
  staleReason: string | null;
}

export interface AssetItemView {
  id: string;
  name: string;
  folderId: string | null;
  type: string;
  url: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  sha256: string | null;
  isHidden: boolean;
  createdAt: string | null;
  lastReadAt: number;
  lastReadBy: 'build' | 'write' | 'refresh' | 'check';
  stale: boolean;
  staleReason: string | null;
}

export interface AssetPass {
  id: string;
  projectId: string;
  kind: 'build' | 'refresh' | 'check';
  trigger: string;
  status:
    'preparing' | 'awaiting_confirmation' | 'walking' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  snapshotAt: number | null;
  foldersFound: number;
  foldersDone: number;
  foldersFailed: number;
  listed: number;
  pages: number;
  requests: number;
  verified: number;
  added: number;
  removed: number;
  corrected: number;
  estimate: {
    rootFolders: number;
    rootAssets: number;
    requestsSoFar: number;
    minRequestsRemaining: number;
    likelyRequestsRemaining: number;
    basis: 'root level only' | 'the previous inventory';
    previousFolders: number | null;
    previousAssets: number | null;
    wallClockMs: number;
    fitsInDailyBudget: boolean;
    tightestTier: string | null;
    at: number;
  } | null;
  summary: string | null;
  error: string | null;
  jobId: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface AssetCorrection {
  id: number;
  at: number;
  source: 'build' | 'refresh' | 'check' | 'write';
  passId: string | null;
  itemId: string;
  itemName: string | null;
  itemKind: 'folder' | 'asset';
  change: 'added' | 'removed' | 'updated' | 'reread_failed';
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  detail: string | null;
}

export interface AssetOverview {
  project: { id: string; name: string };
  tree: AssetMetaView;
  settings: { refreshEnabled: boolean; charactersRootId: string | null };
  counts: {
    folders: number;
    assets: number;
    byType: Record<string, number>;
    maxDepth: number;
    stale: number;
    withHash: number;
  };
  stale: { folders: AssetFolderView[]; assets: AssetItemView[] };
  activePass: AssetPass | null;
  lastBuild: AssetPass | null;
  lastRefresh: AssetPass | null;
  lastCheck: AssetPass | null;
  recentPasses: AssetPass[];
  rereads: {
    inFlight: number;
    failed: {
      id: number;
      op: string;
      jobId: string | null;
      assetIds: string[];
      attempts: number;
      lastError: string | null;
      nextAt: number | null;
      createdAt: number;
    }[];
  };
  now: number;
}

export interface AssetChildren {
  tree: AssetMetaView;
  folder: AssetFolderView | null;
  path: AssetFolderView[];
  folders: AssetFolderView[];
  assets: { assets: AssetItemView[]; total: number };
}

export interface AssetPlanStep {
  name: string;
  action: 'reuse' | 'create';
  folderId: string | null;
  parentFolderId: string | null;
  path: string[];
}

export interface AssetPlanView {
  project: string;
  mode: 'existing_character_folder' | 'character_path' | 'folder_path';
  character: {
    name: string;
    resourceId: string | null;
    group: string | null;
    race: string | null;
    raceSource: 'page_ancestry' | 'unknown_race' | 'not_needed';
  } | null;
  steps: AssetPlanStep[];
  reused: AssetPlanStep[];
  wouldCreate: AssetPlanStep[];
  destination: { path: string[]; folderId: string | null; exists: boolean };
  notes: string[];
  assetTree: { status: AssetTreeStatusName; reason: string | null; confirmedAt: number | null };
}

export type AssetPlanResponse =
  | { ok: true; plan: AssetPlanView }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

// ============================================================================================ v2 C2c: the lifecycle

export interface LifecycleIndexLookup {
  status: 'found' | 'missing' | 'ambiguous';
  name: string;
  node?: { id: string; name: string; path: string };
  candidates?: { id: string; name: string; path: string }[];
}

export interface LifecycleConfigView {
  workingIndexId: string | null;
  archiveIndexId: string | null;
  indexNames: { working: string; archived: string };
  status: { authoritative: string; working: string; archived: string };
  tags: { canon: string; working: string; archived: string };
  fields: {
    status: string;
    continuityType: string;
    scope: string;
    temporalScope: string;
    lastMajorRevision: string;
  };
  continuityTypes: { canon: string; au: string; nonCurrent: string };
  texts: {
    noteFromAuthoritative: string;
    noteFromWorking: string;
    scopePrefix: string;
    temporalFromAuthoritative: string;
    temporalFromWorking: string;
    /** C2d: the note an index archived with its set gets. */
    noteForIndex: string;
  };
  /** E5.3: indexes whose pages are Authoritative without CANON (ids). */
  canonExemptIndexes: string[];
  problem: string | null;
}

export interface LifecycleView {
  project: string;
  working: LifecycleIndexLookup;
  archived: LifecycleIndexLookup;
  config: LifecycleConfigView;
  confirmed: { ok: boolean; code?: string; message?: string };
}

export interface LifecycleRecordView {
  id: number;
  /** C2d: the whole-set change this record belongs to, if any. */
  setId?: number | null;
  pageId: string;
  pageName: string;
  action: 'archive' | 'unarchive' | 'move_to_working' | 'promote';
  date: string;
  state: 'incomplete' | 'complete';
  previousState: string;
  previousName: string;
  previousParentId: string | null;
  target: { name: string; parentId: string };
  tagsRemoved: string[];
  tagsAdded: string[];
  principalId: string;
  approver: string | null;
  jobId: string | null;
  jobs: string[];
  proposalId: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
  completedAt: number | null;
}

export interface LinkSweepView {
  id: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  pagesTotal: number | null;
  pagesDone: number;
  documentsRead: number;
  requests: number;
  links: number;
  error: string | null;
}

export interface LifecycleRecordsResponse {
  project: ProjectRef;
  total: number;
  records: LifecycleRecordView[];
  principals: Record<string, { name: string } | undefined>;
  links: { total: number; lastSweep: LinkSweepView | null; running: LinkSweepView | null };
}

// ============================================================================================ v2 D1: the chronology

/** A document of the chronology resource as the repository tree knows it. */
export interface ChronologyDocRef {
  id: string;
  name: string;
  type: string | null;
}

/** What a lookup by name finds in the repository tree (free: no LegendKeeper request). */
export interface ChronologyFindView {
  resource:
    | { status: 'found'; id: string; name: string; path: string }
    | { status: 'missing'; name: string }
    | { status: 'ambiguous'; name: string; candidates: { id: string; name: string; path: string }[] };
  main: ChronologyDocRef | null;
  ages: { name: string; table: ChronologyDocRef | null; timeline: ChronologyDocRef | null }[];
  problems: string[];
}

export interface ChronologyAgeConfig {
  name: string;
  eraId: string;
  tableDocumentId: string;
  timelineDocumentId: string;
  laneId: string;
  laneName: string;
  mainRowId: string;
}

/** How the tables write dates and KCY values. */
export interface ChronologyStyle {
  date: { rangeSeparator: string; yearGrouping: string };
  kcy: { grouping: string; minus: string; rangeSeparator: string; sameYearRange: 'single' | 'range' };
}

export interface ChronologyNames {
  resource: string;
  mainDocument: string;
  tableSuffix: string;
  timelineSuffix: string;
  laneName: string;
}

export interface ChronologyColumns {
  event: string;
  date: string;
  kcy: string;
  age: string;
  count: string;
  table: string;
  timeline: string;
}

/** The settings as stored and as confirmed (`PUT /projects/:name/chronology` takes them back as `settings`). */
export interface ChronologySettings {
  resourceId?: string | null;
  calendarId?: string | null;
  mainDocumentId?: string | null;
  ages?: ChronologyAgeConfig[];
  style?: ChronologyStyle;
  names?: ChronologyNames;
  columns?: ChronologyColumns;
  confirmed?: boolean;
  confirmedAt?: number;
}

export interface ChronologyConfigView {
  resourceId: string | null;
  calendarId: string | null;
  mainDocumentId: string | null;
  ages: ChronologyAgeConfig[];
  style: ChronologyStyle;
  names: ChronologyNames;
  columns: ChronologyColumns;
  confirmed: boolean;
  confirmedAt: number | null;
  problem: string | null;
}

/** `GET /projects/:name/chronology` (and the reply of its PUT). */
export interface ChronologyView {
  project: string;
  config: ChronologyConfigView;
  find: ChronologyFindView;
  ready: { ok: boolean; code?: string; message?: string };
  calendarCached: boolean;
}

/** What the rows show of one aspect of the writing style. */
export interface ChronologyEvidence<T extends string = string> {
  /** The value the rows show most, or null when no row showed it (the default is proposed then). */
  value: T | null;
  seen: Record<string, number>;
  examples: string[];
}

export interface ChronologyDetectedStyle {
  date: { rangeSeparator: ChronologyEvidence; yearGrouping: ChronologyEvidence };
  kcy: {
    grouping: ChronologyEvidence;
    minus: ChronologyEvidence;
    rangeSeparator: ChronologyEvidence;
    sameYearRange: ChronologyEvidence<'single' | 'range'>;
  };
  proposed: ChronologyStyle;
  conflicts: string[];
}

/** `POST /projects/:name/chronology/lookup` ("Read the chronology"). */
export interface ChronologyLookupView extends ChronologyFindView {
  project: string;
  requests: number;
  calendar: { id: string; name: string; eras: { id: string; name: string; abbr: string }[] } | null;
  mainTable: {
    tableId: string | null;
    rows: { id: string | null; age: string; count: string; table: string | null; timeline: string | null }[];
  } | null;
  found: (ChronologyAgeConfig & { era: string; rows: number; count: string; problems: string[] })[];
  style: ChronologyDetectedStyle | null;
  /** The settings to confirm, or null when something is missing (see `problems`). */
  proposed: ChronologySettings | null;
}

export type ChronologyFindingKind =
  | 'row_without_event'
  | 'event_without_row'
  /** v3 F2.1: an unpaired event that unpaired rows could own: paired by the owner, never deleted. */
  | 'event_in_tie'
  | 'date_mismatch'
  | 'name_drift'
  | 'row_out_of_order'
  | 'wrong_kcy'
  | 'count_mismatch'
  | 'wrong_uri'
  | 'unreadable_date'
  | 'date_text_differs'
  | 'not_found';

export interface ChronologyFinding {
  kind: ChronologyFindingKind;
  age: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** One age as the last check saw it (v2 E6, ADR 0048: how its dates were read and how each pair was made). */
export interface ChronologyAgeSummary {
  age: string;
  rows: number;
  events: number;
  count: string | null;
  /** Rows read by their qualified date's anchor, rows whose date stays unreadable, rows marked table-only. */
  dates?: { qualified: number; unreadable: number; tableOnly: number };
  /** Table-only marks that no longer hold (the row changed or is gone): the row is back in the check. */
  tableOnlyLapsed?: { rowId: string; date: string }[];
  /** How many pairs each way made (`link`, `date+name`, `date`, `mismatch:start+shape`, …). */
  pairedBy?: Record<string, number>;
  pairs?: {
    rowId: string | null;
    eventId: string;
    by: string;
    date: string;
    mismatch?: boolean;
    qualified?: boolean;
  }[];
}

export interface ChronologyCheckRun {
  id: number;
  projectId: string;
  trigger: string;
  state: 'running' | 'succeeded' | 'failed';
  requests: number;
  summary: string | null;
  findings: ChronologyFinding[];
  ages?: ChronologyAgeSummary[];
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** v2 E6 (ADR 0048): a row the owner never wants on the timeline (`GET /chronology/table-only`). */
export interface ChronologyTableOnlyMark {
  tableDocumentId: string;
  rowId: string;
  age: string;
  textsHash: string;
  texts: { description: string; date: string; kcy: string };
  reason: string | null;
  markedBy: string;
  markedAt: number;
}

export interface ChronologyTableOnlyResponse {
  project: ProjectRef;
  marks: ChronologyTableOnlyMark[];
}

/** `POST /chronology/propose-fix` (v2 D1.1): the proposal made for one finding, or why there is nothing to propose. */
export type ChronologyProposeFixResponse =
  | { status: 'proposal_captured'; proposalId: string; summary: string | null }
  | { status: 'nothing_to_do'; message: string };

/** `GET /chronology/check`. */
export interface ChronologyCheckResponse {
  project: ProjectRef;
  last: ChronologyCheckRun | null;
  running: boolean;
}

export interface ChronologyRecordView {
  id: number;
  tool:
    | 'create_timeline_event'
    | 'update_timeline_event'
    | 'delete_timeline_event'
    | 'sync_timeline_event'
    | 'chronology_count_fix';
  summary: string;
  ages: string[];
  state: 'incomplete' | 'complete' | 'resolved';
  jobId: string | null;
  jobs: string[];
  principalId: string;
  approver: string | null;
  proposalId: string | null;
  /** The kind of each write the change makes (`row.insert`, `event.create`, `count`, …). */
  writes: string[];
  detail: Record<string, unknown>;
  createdAt: number;
  completedAt: number | null;
}

/** `GET /chronology/records`. */
export interface ChronologyRecordsResponse {
  project: ProjectRef;
  total: number;
  incomplete: number;
  records: ChronologyRecordView[];
  /** Each record's connection by id, in words (as the journal shows them). */
  principals: Record<
    string,
    { id: string; name: string; type: 'grant' | 'pat' | 'system' | 'removed'; removedAt: number | null }
  >;
}

// ---------------------------------------------------------------------------------------------- v2 D3: staging

export interface StagedImageView {
  stagedId: string;
  state: 'uploading' | 'uploaded' | 'failed' | 'discarded';
  staged: boolean;
  name: string;
  assetId: string | null;
  url: string | null;
  width: number;
  height: number;
  frames: number;
  bytes: number;
  originalFormat: string;
  originalBytes: number;
  conversion: 'converted' | 'webp_passthrough';
  storedVerified: boolean | null;
  verifyReason: string | null;
  principalId: string;
  source: string;
  createdAt: number;
  intended: string | null;
  intendedDestination: Record<string, unknown> | null;
  placing: { proposalId?: string; jobId?: string } | null;
  discarding: { jobId: string } | null;
  error: string | null;
  old: boolean;
  /** v3 F2: waiting on the bridge's server (not in LegendKeeper), with its thumbnail from the bridge's own copy. */
  onServer?: boolean;
  thumbnail?: string;
  /** v3 F2: when it goes if it stays unplaced (once warned), and the project's maximum age in days. */
  removedAfter?: number;
  maxDays?: number;
}

export interface StagingResponse {
  project: string;
  folder: string;
  reportDays: number;
  staged: StagedImageView[];
  old: number;
  limits: { maxBytes: number; maxPixels: number; maxFrames: number };
  kept: {
    files: number;
    bytes: number;
    retentionDays: number;
    recent: {
      assetId: string;
      name: string | null;
      sha256: string;
      size: number;
      keptAt: number;
      expiresAt: number;
    }[];
  };
  overrides: { assetId: string; grantedAt: number; expiresAt: number; usedAt: number | null }[];
}

export interface StagingUploadResponse {
  deduplicated: boolean;
  image: StagedImageView;
}

/** `POST /staging/preview`: the folder plan of a destination as a dry run (v2 D3.2). */
export interface StagingPreviewResponse {
  path: string;
  segments: { name: string; new: boolean }[];
  newFolders: number;
  exists: boolean;
  notes: string[];
  dryRun: true;
}

export interface StagingActionResponse {
  jobId?: string;
  proposalId?: string;
  status?: string;
  verified?: boolean | null;
  image?: StagedImageView;
}

// ------------------------------------------------------------------------------------------ v2 E1a: snapshots

export type SnapshotKind = 'full' | 'change';

export interface SnapshotRowView {
  id: string;
  projectId: string;
  kind: SnapshotKind;
  state: 'complete' | 'partial';
  takenAt: number;
  startedAt: number;
  pages: number;
  pieces: number;
  logicalBytes: number;
  newObjects: number;
  newBytes: number;
  reads: number;
  downloads: number;
  missing: number;
  trigger: Record<string, unknown>;
  summary: string;
  damaged: string | null;
  /** v3 F2: a partial snapshot's missing pieces, from its manifest (null: the manifest could not be read). */
  missingPieces?: SnapshotMissingPiece[] | null;
  /** v3 F2: how many more there are than listed. */
  missingMore?: number;
}

/** v3 F2: one missing piece of a partial snapshot. */
export interface SnapshotMissingPiece {
  /** The page's (or template's) id; null for the asset library. */
  pageId: string | null;
  pageName: string | null;
  piece: string;
  ref?: string;
  reason: string;
}

export interface SnapshotRunView {
  id: string;
  projectId: string;
  kind: 'full';
  state: 'running' | 'succeeded' | 'failed' | 'refused' | 'stopped';
  trigger: string;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  total: number;
  done: number;
  reads: number;
  downloads: number;
  newObjects: number;
  newBytes: number;
  estimate: Record<string, unknown> | null;
  error: string | null;
  snapshotId: string | null;
}

export interface SnapshotFindingView {
  id: number;
  sha256: string;
  problem: 'missing' | 'corrupt' | 'manifest';
  detail: string | null;
  snapshots: string[];
  foundAt: number;
}

export interface SnapshotNoticeView {
  id: number;
  projectId: string | null;
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  at: number;
}

export interface SnapshotOverview {
  dir: string;
  exists: boolean;
  store: { objects: number; objectBytes: number; manifests: number; manifestBytes: number; bytes: number };
  disk: { total: number; free: number } | null;
  minFreeBytes: number;
  headroom: number | null;
  logical: { referenced: number; unique: number; uniqueCount: number };
  dedupRatio: number | null;
  compressionRatio: number | null;
  retention: { keepFullDays: number; keepWeekly: number; keepDays: number; softDeleteDays: number };
  counts?: Record<string, { count: number; last: number | null }>;
  nextFullEstimate?: number | null;
  runs?: SnapshotRunView[];
  owed?: number;
  findings: SnapshotFindingView[];
  notices: SnapshotNoticeView[];
}

export interface PlanNoteView {
  what: string;
  where?: string;
  why: string;
}

export interface RestoreRecordView {
  id: string;
  projectId: string;
  pageId: string;
  pageName: string;
  snapshotId: string;
  scope: string;
  mode: string | null;
  documentId: string | null;
  proposalId: string | null;
  state: 'proposed' | 'executed' | 'failed' | 'closed';
  followUp: string | null;
  followUpProposalId: string | null;
  requestedBy: string;
  summary: string;
  /** Fields LegendKeeper refused and the run left out (an icon name it does not know). */
  couldntRestoreExactly?: { what: string; why: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface RehearsalView {
  id: string;
  projectId: string;
  sourceProjectId: string;
  snapshotId: string;
  mode: 'sampled' | 'full';
  state: 'running' | 'succeeded' | 'failed' | 'stopped';
  keep: boolean;
  rootId: string | null;
  rootName: string | null;
  rootState: 'none' | 'kept' | 'deleted' | 'delete_failed';
  startedBy: string;
  startedAt: number;
  finishedAt: number | null;
  estimate: {
    reads?: number;
    writes?: number;
    uploads?: number;
    wallClockMs?: number | null;
    pacing?: { msPerWrite: number; msPerRead: number } | null;
    figures?: PlanFiguresView | null;
  } | null;
  plan: {
    pages?: string[];
    coverage?: Record<string, string[]>;
    images?: number;
    /** v2 E5.4: what a sampled rehearsal left out. */
    cuts?: { page: string; document: string; what: string; kept: number; of: number }[];
  } | null;
  progress: Record<string, unknown>;
  result: {
    pagesCompared?: number;
    exact?: number;
    differences?: { page: string; piece: string; reason: string; detail?: unknown }[];
    cannotRestore?: { page?: string; what?: string; reason: string }[];
    images?: { uploaded: number; of: number };
    changedForRehearsal?: Record<string, number>;
    cost?: Record<string, number>;
    ms?: number;
  } | null;
  error: string | null;
}

export interface BackupFileView {
  name: string;
  label: string;
  size: number;
  at: number;
}

export interface SnapshotsResponse {
  project: string;
  overview: SnapshotOverview;
  snapshots: SnapshotRowView[];
  restores: RestoreRecordView[];
  rehearsals: RehearsalView[];
  sandboxes: { name: string; id: string; active: boolean }[];
  jobs: {
    id: string;
    name: string;
    enabled: boolean;
    scheduleText: string;
    nextRunAt: number | null;
    lastRun: { at: number; outcome: string; durationMs: number; detail: string | null } | null;
  }[];
  backups: { dir: string; files: BackupFileView[]; error?: string };
  now: number;
}

export interface SnapshotPagesResponse {
  project: string;
  pages: { pageId: string; name: string | null; lastAt: number; deleted: boolean }[];
}

export interface SnapshotHistoryEntry {
  snapshot: string;
  takenAt: string;
  kind: SnapshotKind;
  partial?: true;
  damaged?: unknown;
  madeBy?: string;
  pieces: { piece: string; documentId?: string; change: string }[];
}

export interface SnapshotPageResponse {
  project: string;
  page: { id: string; name: string; live: boolean };
  documents: { id: string; name: string | null }[];
  history: { count: number; snapshots: SnapshotHistoryEntry[]; more?: number };
  restores: RestoreRecordView[];
}

export interface SnapshotDiffResponse {
  page: string;
  piece: string;
  ref: string | null;
  from: string;
  to: string;
  identical: boolean;
  added: number;
  removed: number;
  diff: MarkdownDiff;
  text: string;
  reads: number;
}

/** v2 E5.5 (backlog 16): the figures a plan's time rests on (older servers send none). */
export interface PlanFiguresView {
  perWrite: {
    ms: number;
    from: 'measured' | 'spacing';
    measuredMs: number | null;
    samples: number;
    spacingMs: number;
  } | null;
  limits: { tier: string; limit: number | null; windowMs: number | null; share: number }[];
  groups: { group: string; limit: number; windowMs: number; steps: number; ms: number }[];
}

export interface PlanEstimateView {
  reads: number;
  writes: number;
  wallClockMs: number | null;
  fitsToday: boolean | null;
  pacing: { msPerWrite: number; msPerRead: number } | null;
  figures: PlanFiguresView | null;
}

export interface RestorePlanView {
  page: { id: string; name: string };
  scope: string;
  mode: string | null;
  snapshot: { id: string; takenAt: number; kind: string };
  summary: string;
  pieces: { label: string; diff: string }[];
  writes: number;
  lost: PlanNoteView[];
  kept: PlanNoteView[];
  notRestored: PlanNoteView[];
  warnings: string[];
  idMap: Record<string, string> | null;
  followUp: string | null;
  reads: number;
  /** v2 E5.5: how long it should take once approved, and the figures used (absent from older servers). */
  estimate?: PlanEstimateView | null;
}

export interface RestoreResponse {
  status: 'nothing_to_do' | 'dry_run' | 'proposal_captured';
  proposalId?: string;
  restoreId?: string;
  canonical?: { reason: string };
  plan: RestorePlanView;
}

export interface ImageReferenceView {
  pageId: string;
  page: string;
  documents: { id: string; name: string; what: string }[];
  byHand: string[];
}

export interface ImageRestoreResponse {
  status: 'dry_run' | 'proposal_captured';
  proposalId?: string;
  old: Record<string, unknown>;
  /**
   * v3 F3c (ADR 0051): where the image goes back once approved: its name, the folder's path from the library's root, and
   * the folders made on the way. The new asset exists only after approval.
   */
  image?: { name: string; path: string[]; creates: string[]; stagedId?: string };
  references: ImageReferenceView[];
  updated?: boolean;
  notes?: PlanNoteView[];
  summary?: string;
}

export interface RehearsalPlanResponse {
  plan: {
    source: { projectId: string; snapshotId: string; takenAt: string; kind: string };
    target: { projectId: string; name: string };
    mode: 'sampled' | 'full';
    pages: string[];
    coverage: Record<string, string[]>;
    images: number;
    /** v2 E5.4: what a sampled rehearsal leaves out (older servers send none). */
    cuts?: {
      page: string;
      document: string;
      what: 'events' | 'features';
      kept: number;
      of: number;
      lanes?: { kept: number; of: number };
    }[];
    estimate: {
      reads: number;
      writes: number;
      uploads: number;
      wallClockMs: number | null;
      fitsToday: boolean | null;
      pacing?: { msPerWrite: number; msPerRead: number } | null;
      /** v2 E5.5: the figures the time rests on. */
      figures?: PlanFiguresView | null;
    };
  };
}

// ---------------------------------------------------------------------------------------------- audits (v2 E2, ADR 0044)

export type AuditSeverity = 'error' | 'warning' | 'info';

export interface AuditFixView {
  kind: string;
  summary: string;
  args: Record<string, unknown>;
  /** v2 E6 (ADR 0048): the owner confirms what the fix changes first (`range → single day`). */
  confirm?: { shapeChange: string };
}

export interface AuditSourceView {
  kind: 'snapshot' | 'chronology-check' | 'bridge' | 'live';
  snapshotId?: string;
  baseSnapshotId?: string;
  checkId?: number;
  takenAt: number;
  ageMs: number;
}

export interface AuditFindingView {
  id: number;
  code: string;
  category: string;
  severity: AuditSeverity;
  pageId: string | null;
  pageName: string | null;
  pagePath: string | null;
  documentId: string | null;
  blockId: string | null;
  message: string;
  evidence: Record<string, unknown>;
  source: AuditSourceView;
  fix: AuditFixView | null;
  state: 'open' | 'gone';
  firstSeenRun: string;
  firstSeenAt: number;
  lastSeenRun: string;
  lastSeenAt: number;
  resolvedRun: string | null;
  resolvedAt: number | null;
  acknowledgement: { reason: string; by: string; at: number } | null;
  acknowledgementLapsed: boolean;
}

export interface AuditRunCounts {
  byCategory: Record<string, Record<AuditSeverity, number>>;
  open: number;
  acknowledged: number;
  new: number;
  still: number;
  gone: number;
}

export interface AuditRunView {
  id: string;
  trigger: string;
  state: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  snapshotId: string | null;
  snapshotTakenAt: number | null;
  snapshotAgeMs: number | null;
  changeSnapshots: number;
  newestSnapshotId: string | null;
  stale: boolean;
  pages: number;
  counts: AuditRunCounts | null;
  summary: string | null;
  error: string | null;
}

export interface AuditCodeInfo {
  code: string;
  category: string;
  severity: AuditSeverity;
  title: string;
  fix?: string;
}

export interface AuditOverviewResponse {
  project: { id: string; name: string };
  summary: {
    byCategory: Record<string, Record<AuditSeverity, number>>;
    open: number;
    acknowledged: number;
    gone: number;
    new: number;
  };
  latestRun: AuditRunView | null;
  running: AuditRunView | null;
  runs: AuditRunView[];
  codes: { code: string; n: number }[];
  catalogue: { categories: string[]; severities: AuditSeverity[]; codes: AuditCodeInfo[] };
  newestFullSnapshot: { id: string; takenAt: number; ageMs: number } | null;
  maxSnapshotAgeHours: number;
  now: number;
}

export interface AuditFindingsResponse {
  project: { id: string; name: string };
  findings: AuditFindingView[];
  total: number;
  latestRun: string | null;
  groups?: { pageId: string | null; pageName: string | null; pagePath: string | null; findings: number[] }[];
  now: number;
}

export interface AuditRuleSelectors {
  referenceType?: string;
  registryType?: string;
  role?: string;
  namePrefix?: string;
  ancestorName?: string;
  kind?: 'index' | 'bsrc' | 'bwrk' | 'barc';
}

export interface AuditRuleView {
  id: string;
  name: string;
  enabled: boolean;
  selectors: AuditRuleSelectors;
  template: { registry?: { type: string; role: string }; templateId?: string; templateName?: string };
}

export interface AuditSettingsView {
  reportUnmatched: boolean;
  maxSnapshotAgeHours: number;
  manualOrderIndexes: string[];
  knownReferenceTypes: string[];
  strictReferenceTypes: boolean;
  /** v3 F4a (ADR 0063): external skill names the governance check never reports. */
  governanceAllowedNames?: string[];
}

export interface AuditConfigResponse {
  project: { id: string; name: string };
  rules: AuditRuleView[] | null;
  effectiveRules: AuditRuleView[];
  seeded: boolean;
  tagSource: { pageId: string; documentId: string } | null;
  tagSourcePage: {
    id: string;
    name: string;
    path: string;
    documents: { id: string; name: string | null; type: string | null }[];
  } | null;
  settings: AuditSettingsView;
  registryTypes: { id: string; singular: string; plural: string; roles: string[]; placementKind: string }[];
  updatedAt: number | null;
  updatedBy: string | null;
}

export type AuditProposeFixResponse =
  | { status: 'proposal_captured'; proposalId: string; summary: string | null; fix: string }
  | { status: 'nothing_to_do'; message: string };

export interface AuditRecheckResponse {
  status: 'still_present' | 'gone';
  finding: AuditFindingView | null;
  reads: number;
}

// ------------------------------------------------------------------------------------------------ Tool calls (v2 E3)

export interface ToolCallArg {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  /** Characters, items or keys. */
  size?: number;
  /** Only booleans, numbers and short reference strings; never page content or secrets. */
  value?: string | number | boolean;
}

export type ToolCallOutcome = 'success' | 'error' | 'proposal' | 'waiting' | 'queued';

export interface ToolCallRow {
  id: number;
  at: number;
  principalId: string | null;
  profile: string | null;
  scope: string | null;
  tool: string;
  project: string | null;
  args: ToolCallArg[];
  outcome: ToolCallOutcome;
  code: string | null;
  jobId: string | null;
  proposalId: string | null;
  durationMs: number;
  budgetRequests: number | null;
  budgetWrites: number | null;
  resultChars: number | null;
  /** A write_page or set_facts that edits existing content with no base version (src/toolcalls/flag.ts). */
  noBaseVersion?: boolean;
}

export interface ToolCallsResponse {
  calls: ToolCallRow[];
  principals: PrincipalNames;
  hasMore: boolean;
  nextBefore: number | null;
  facets: { tools: string[]; profiles: string[]; codes: string[]; total: number; oldest: number | null };
  /** The calls matching the filters (the flag aside), and how many of them are writes without a base version. */
  summary?: { matching: number; noBaseVersion: number };
  settings: { retentionDays: number; maxRetentionDays: number; recording: boolean };
}

// ------------------------------------------------------------------------------------- Evaluation helper (v2 E3)

export type EvaluationAssistant = 'chatgpt' | 'claude';
export type EvaluationSet = 'core' | 'all';
export type OwnerGrade = 'right' | 'partly' | 'wrong';

export interface EvaluationScenario {
  id: number;
  section: string;
  title: string;
  shortTitle: string;
  /** v3 F3a: the setting pack the scenario exercises (`arkona`). */
  pack?: string;
  assistants: EvaluationAssistant[];
  needsApproval: boolean;
  alwaysProposal: boolean;
  core: boolean;
  dependsOn: number[];
  freshChat: boolean;
  prompts: string[];
  interlude: string | null;
  setupNote: string | null;
  /** An inner list means "any one of these". */
  expectedTools: (string | string[])[];
  optionalTools: string[];
  mistakeTools: string[];
  expectedNote: string;
  watchFor: string;
  toolCallsNote: string;
  /** What the owner pastes: the preamble in front of the first prompt of a fresh chat. */
  copy: string[];
}

export interface EvaluationScenarios {
  preamble: string;
  scenarios: EvaluationScenario[];
  coreIds: number[];
}

export type EvaluationHint = 'looks_right' | 'check' | 'looks_wrong' | 'no_calls';

export interface EvaluationAutoGrade {
  expectedPresent: boolean;
  missingExpected: string[];
  mistakeTools: string[];
  errorCodes: { code: string; count: number }[];
  callCount: number;
  writesWithoutBaseVersion: number;
  hint: EvaluationHint;
}

export interface EvaluationCall {
  tool: string;
  outcome: ToolCallOutcome;
  code: string | null;
  live?: boolean;
  noBase?: true;
}

export interface EvaluationResult {
  scenarioId: number;
  title: string;
  state: 'pending' | 'recording' | 'done';
  startedAt: number | null;
  finishedAt: number | null;
  startCallId: number | null;
  endCallId: number | null;
  principalIds: string[];
  connectionMode: 'auto' | 'manual';
  calls: EvaluationCall[];
  sequence: string;
  autoGrade: EvaluationAutoGrade | null;
  ownerGrade: OwnerGrade | null;
  note: string;
  live?: { callCount: number; tools: string[] };
}

export interface EvaluationRunSummary {
  id: string;
  createdAt: number;
  assistant: EvaluationAssistant;
  set: EvaluationSet;
  bridgeVersion: string;
  status: 'in_progress' | 'finished';
  finishedAt: number | null;
  progress: { total: number; done: number; graded: number };
}

export interface EvaluationRun extends EvaluationRunSummary {
  principalIds: string[] | null;
  results: EvaluationResult[];
}

export interface EvaluationRunsResponse {
  runs: EvaluationRunSummary[];
  recording: boolean;
  retentionDays: number;
}

export interface EvaluationRunResponse {
  run: EvaluationRun;
  principals: PrincipalNames;
}

export interface EvaluationConnection {
  id: string;
  name: string;
  type: 'grant' | 'pat';
  profile: string | null;
  scope: string | null;
  active: boolean;
  removed: boolean;
  lastUsedAt: number | null;
  calls: number;
  lastCallAt: number | null;
  assistant: EvaluationAssistant | null;
  reason: string;
}

export interface EvaluationConnectionsResponse {
  connections: EvaluationConnection[];
  recognised: string[];
}

export interface EvaluationScenarioComparison {
  scenarioId: number;
  shortTitle: string;
  inA: boolean;
  inB: boolean;
  gradeA: OwnerGrade | null;
  gradeB: OwnerGrade | null;
  movement: 'better' | 'worse' | 'same' | 'new' | 'unknown';
  gradeText: string;
  callsA: number;
  callsB: number;
  toolsAdded: { tool: string; from: number; to: number }[];
  toolsRemoved: { tool: string; from: number; to: number }[];
  codesAppeared: string[];
  codesGone: string[];
}

export interface EvaluationComparison {
  a: { id: string; createdAt: number; assistant: string };
  b: { id: string; createdAt: number; assistant: string };
  scenarios: EvaluationScenarioComparison[];
  commonScenarios: number;
  errorCodeChanges: { code: string; from: number; to: number }[];
  summary: string[];
}

// ============================================================================================ v3 F3a: setting packs

export interface PackRoleRule {
  role: string;
  template: string;
  name: string;
  referenceType: string | null;
  tags: string[];
  /** v3 F3b: a Working page's own tags (an owner page: Working, the primary tag, then the specialist if any). */
  workingTags?: string[];
  facts: 'identity' | 'general' | 'none';
  body: 'required' | 'optional' | 'drafted';
  warnMissing: string[];
  max: number;
}

export interface PackTypeRules {
  name: string;
  tool: string;
  hook: string | null;
  placement:
    | { kind: 'taxonomy'; registryType: string; field: string; fallbackIndex: string }
    | { kind: 'fixed'; index: string };
  roles: PackRoleRule[];
  identity: { field: string; key: string; gated: boolean }[];
  unestablished: string;
  fixedFacts: Record<string, string>;
  generalKeys: string[];
  specialistTags: string[];
  suggestedReferenceTypes: Record<string, string>;
  assets: { displayName: string; section: string; role: string };
}

/** v3 F3b (ADR 0052): where an owner page may live. */
export type PackHomeRule =
  | { kind: 'category'; level: 'continent' | 'nation' | 'world'; category: string }
  | { kind: 'nation' }
  | { kind: 'named'; name: string }
  | { kind: 'under'; parent: string; label: string }
  | { kind: 'index'; id: string; name: string }
  | { kind: 'races'; as: 'root' | 'group' | 'race' };

export interface PackOwnerKind {
  homes: PackHomeRule[];
  name: string;
  referenceType: string | null;
  specialist: string | null;
  navigation: 'race' | 'group' | null;
}

export interface PackOwnerType {
  name: string;
  template: string;
  primary: string;
  specialist: string[];
  homes: PackHomeRule[];
  kinds?: Partial<Record<'race' | 'racialGroup' | 'subrace', PackOwnerKind>>;
  note?: string;
}

export interface PackOwners {
  tool: string;
  facts: { required: string[]; keys: string[]; fixed: Record<string, string>; supersedes: string };
  tags: { authoritative: string[]; working: string[] };
  worldPrefix: string;
  nations: string;
  races: { root: { id: string; name: string }; navigation: string };
  types: PackOwnerType[];
}

export interface PackRules {
  schema: 1;
  settings: { alwaysPropose: boolean };
  tags: {
    authoritative: string;
    working: string;
    never: string[];
    race: Record<string, string>;
    culture: Record<string, string>;
    exceptional: string[];
    /** v3 F3b: the owner's AU ruling. */
    au?: { continuityType: string; tag: string };
  };
  names: { forbiddenWords: string[]; datePatterns: string[] };
  sidebar: { property: string; dependencies: string; related: string };
  types: PackTypeRules[];
  /** v3 F3b (ADR 0052): the non-character owners. */
  owners?: PackOwners;
  /** v3 F3b: the owner's rulings the rules follow. */
  rulings?: { key: string; date: string; by: string; summary: string }[];
  /** v3 F3d (ADR 0053): where the lifecycle tools put the lifecycle tag, per project name (absent: append). */
  lifecycleTagPosition?: Record<string, 'lead' | 'append'>;
  /** v3 F3f (ADR 0060): the retag rules (absent: no retag tools). */
  retag?: {
    batchSize: number;
    identityReferenceTypes: string[];
    excludedRoutineTags: string[];
    excludedAreas: string[];
  };
}

export interface PackSourceStatus {
  key: string;
  name: string;
  label?: string;
  project: string;
  resourceId: string;
  documentId: string;
  approved: string | null;
  current: string | null;
  digest: string | null;
  state: 'same' | 'changed' | 'unreadable' | 'unapproved';
  reason?: string;
  /** v3 F3b: the pinned sections, each as read now. */
  sections?: {
    heading: string;
    found: string | null;
    state: 'same' | 'changed' | 'missing' | 'unapproved';
  }[];
  /** ADR 0052 amendment: the page's headings in order, with their levels, when a pinned section is missing. */
  outline?: { heading: string; level: number }[];
}

export interface PackGovernance {
  state: 'current' | 'changed' | 'unapproved' | 'rules_changed' | 'unreadable';
  message: string;
  sources: PackSourceStatus[];
  version: number;
  approvedVersion: number | null;
}

export interface PackView {
  id: string;
  name: string;
  prefix: string;
  rules: PackRules;
  version: number;
  governance: {
    key: string;
    project: string;
    resourceId: string;
    documentId: string;
    name: string;
    label?: string;
    /** v3 F3b: the sections of the document the rules depend on. */
    sections?: string[];
  }[];
  approved: {
    version: number;
    at: number;
    by: string;
    sources: { key: string; version: string; sections?: { heading: string; digest: string }[] }[];
  } | null;
  drift: {
    at: number;
    changed: { key: string; name: string; approved: string | null; current: string | null }[];
  } | null;
  seed: string | null;
  attachments: {
    projectId: string;
    projectName: string;
    served: boolean;
    templates: Record<string, string | null>;
    notes: string[];
    attachedAt: number;
    attachedBy: string;
  }[];
  tools: string[];
  /** v3 F3.4 (ADR 0055): each write tool's "always propose" switch (absent from an older bridge). */
  toolModes?: { tool: string; mode: 'propose' | 'scope'; source: 'switch' | 'default' }[];
  versions: { version: number; reason: string; approved: unknown; createdAt: number }[];
}

export interface PacksResponse {
  packs: PackView[];
}

// ------------------------------------------------------------------------------------------------ v3 F3c: Appraisal

export type AppraisalToolName =
  | 'arkona_appraise_owner'
  | 'arkona_change_impact'
  | 'arkona_working_digest'
  | 'arkona_visual_hygiene'
  | 'arkona_split_appraisal';

export type AppraisalFollowUp =
  | { kind: 'fix'; tool: 'arkona_appraisal_fix'; args: { findingId: string }; change: string; via?: 'audit' }
  | { kind: 'judgement'; tool: string; decide: string }
  | { kind: 'none'; reason: string };

export interface AppraisalFindingView {
  id: string;
  tool: AppraisalToolName;
  check: string;
  group: string;
  evidence: string;
  rule: { page: string; section: string | null; rule?: string };
  page: { id: string; name: string; path: string } | null;
  documentId?: string | null;
  blockId?: string | null;
  message: string;
  details: Record<string, unknown>;
  followUp: AppraisalFollowUp;
  source: { kind: string; snapshotId?: string; takenAt?: number; ageMs?: number; auditFindingId?: number };
  labels?: { lifecycle: string | null; branch: string | null };
}

export interface AppraisalReportView {
  tool: AppraisalToolName;
  runId: string;
  scope: Record<string, unknown>;
  createdAt: string;
  source: {
    index: {
      base: { id: string; takenAt: string };
      newest: { id: string; takenAt: string };
      changeSnapshots: number;
      age: string;
      ageMs: number;
    } | null;
    audit?: { runAt: string | null; snapshotId: string | null };
    assetTree?: { status: string; confirmedAt: string | null };
    pack?: { version: number; approvedVersion: number | null };
  };
  inspected: Record<string, unknown>;
  couldNotCheck: string[];
  counts: Record<string, number>;
  findings: AppraisalFindingView[];
  compared?: { new: number; still: number; gone: number; previousRunAt: string };
  /** v3 F3e (ADR 0059): the split appraisal's questions for the owner. */
  questions?: { trigger: string; question: string }[];
}

/** v3 F3e (ADR 0059): one section of a split candidate's draft destination map. */
export interface SplitDraftEntry {
  section: string;
  words: number;
  images: number;
  to: 'stays' | 'new' | 'relationship' | 'divide' | 'review';
  suggestion?: Record<string, unknown>;
  note?: string;
}

export interface AppraisalIndexView {
  baseSnapshotId: string;
  baseTakenAt: number;
  newestSnapshotId: string;
  newestTakenAt: number;
  changes: number;
  pages: number;
  units: number;
  refs: number;
  unreadable: number;
  builtAt: number;
  buildMs: number;
  updatedAt: number;
  lastUpdateMs: number | null;
  sizeBytes: number | null;
  notes: string[];
}

export interface AppraisalRunView {
  id: string;
  tool: AppraisalToolName;
  scopeKey: string;
  scope: Record<string, unknown>;
  actor: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  counts: Record<string, number>;
  compared: { new: number; still: number; gone: number; previousRunAt: string } | null;
}

export interface AppraisalOverviewResponse {
  project: { id: string; name: string };
  attached: boolean;
  index: AppraisalIndexView | null;
  areas: { key: string; label: string; found: { id: string; name: string }[] }[];
  runs: AppraisalRunView[];
  now: number;
}

export type AppraisalFixResponse =
  | { status: 'proposal_captured'; proposalId: string; summary: string | null; fix: string; reads: number }
  | { status: 'nothing_to_do'; message: string; reads: number };

// ------------------------------------------------------------------------------------- v3 F3.4: write scope (ADR 0055)

export interface ReviewCounts {
  project?: ProjectRef;
  unreviewed: number;
  byProject: Record<string, number>;
}

export interface ReviewRevert {
  id: number;
  revertJobId: string;
  state: 'submitted' | 'succeeded' | 'failed' | 'cancelled';
  partial: boolean;
  createdAt: number;
  finishedAt: number | null;
}

export interface ReviewItem {
  jobId: string;
  projectId: string;
  createdAt: number;
  finishedAt: number | null;
  status: JobStatus;
  agent: { principalId: string; name: string; profile: string };
  tool: string | null;
  summary: string;
  /** CR-2026-11-R2 (R2-06): the title the agent gave a low-level job (a secondary label, never the summary). */
  agentTitle?: string;
  pages: { id: string; name: string | null }[];
  /** Amendment 1 to ADR 0072: the words the job changed, sentence by sentence. */
  textChanges?: TextChange[];
  reviewed: { at: number; by: string; via: string } | null;
  revert: ReviewRevert | null;
}

export interface ReviewChange {
  key: string;
  kind: string;
  what: string;
  steps: number[];
  uncertain: boolean;
  markdownDiff?: MarkdownDiff;
  document?: { id: string; name: string | null };
  facts?: { key: string; before: string | null; after: string | null }[];
  links?: {
    title: string;
    added: { id: string; name: string | null }[];
    removed: { id: string; name: string | null }[];
  }[];
  fields?: { field: string; before: unknown; after: unknown }[];
  notRevertible?: {
    reason: string;
    deletion: boolean;
    creation: boolean;
    instead: string | null;
    journal: number[];
  };
}

export interface ReviewDetail extends ReviewItem {
  pageChanges: { page: { id: string; name: string | null } | null; changes: ReviewChange[] }[];
  revertable: { ok: boolean; reason: string | null };
}

export interface ReviewResponse {
  project?: ProjectRef;
  items: ReviewItem[];
  facets: { profiles: string[]; tools: string[] };
  counts: { unreviewed: number; matching: number };
  /** CR-2026-11-R2 (R2-09): the set "Mark all reviewed" would mark, sent back with it. */
  markAll?: { count: number; fingerprint: string };
}

export interface RevertTarget {
  key: string;
  kind: string;
  page: { id: string; name: string | null } | null;
  what: string;
  state: 'ready' | 'changed' | 'gone' | 'not_revertible' | 'nothing_to_do';
  detail: string;
  differences?: { path: string; expected: unknown; actual: unknown }[];
  deletion?: boolean;
  instead?: string | null;
  journal?: number[];
}

export interface RevertPreview {
  jobId: string;
  projectId: string;
  eligible: { ok: true } | { ok: false; code: string; message: string };
  targets: RevertTarget[];
  ready: number;
  notReverted: number;
  /**
   * v3 F3e (ADR 0059): a split's phase 1: the pages it made go to ONE deletion proposal. CR-2026-11-R3 (R3-09): it is
   * reverted whole or not at all (`wholeOnly`).
   */
  split?: { pagesMade: number; wholeOnly?: boolean };
}

/** v3 F3d amendment (ADR 0058, A): an item a job skipped when it ran, with why and a before and after excerpt. */
export interface SkippedItem {
  item: string;
  reason: string;
  before?: string | null;
  after?: string | null;
  where?: string;
}

// ============================================================================================ v3 F5b: automation

export type AutomationMode = 'off' | 'propose' | 'apply';
export type AutomationOutcome = 'applied' | 'proposed' | 'skipped' | 'guarded' | 'failed' | 'stopped';

export interface AutomationItem {
  id: number;
  runId: string;
  code: string;
  pageId: string | null;
  pageName: string | null;
  outcome: AutomationOutcome;
  reasonCode: string | null;
  reason: string | null;
  jobId: string | null;
  proposalId: string | null;
  at: number;
}

export interface AutomationRun {
  id: string;
  projectId: string;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  state: 'running' | 'succeeded' | 'stopped' | 'skipped' | 'failed';
  summary: string | null;
  stopReason: string | null;
}

export interface AutomationCode {
  code: string;
  name: string;
  example: string;
  transformation: string;
  source: 'audit' | 'appraisal' | 'retag';
  mode: AutomationMode;
  /** v3 F7: the modes the owner can choose (a proposal-only code: Off or Propose). */
  modes?: AutomationMode[];
  paused: { at: number; reason: string } | null;
  stopped: { at: number; reason: string } | null;
  governancePending: string | null;
  lastRun: { runId: string; at: number } | null;
  recent: AutomationItem[];
  changes: {
    from: AutomationMode;
    to: AutomationMode;
    principal: string;
    at: number;
    reason: string | null;
    governanceJobId: string | null;
    governanceState: string;
  }[];
}

export interface AutomationPayload {
  project: { id: string; name: string };
  global: { paused: boolean; pausedAt: number | null; pausedBy: string | null };
  caps: { perCode: number; perRun: number };
  codes: AutomationCode[];
  runs: AutomationRun[];
  never: { code: string; name: string; why: string[]; transformation: string }[];
  eligible: number;
}

export interface AutomationGovernance {
  ok: boolean;
  code: string | null;
  message: string;
  problems: { code: string; state: string; expected: string | null; found: string | null }[];
}

export interface AutomationOvernight {
  since: number;
  runs: { id: string; state: string; startedAt: number; summary: string | null }[];
  codes: {
    code: string;
    name: string;
    counts: Record<AutomationOutcome, number>;
    jobs: string[];
    proposals: string[];
  }[];
  paused: boolean;
}

/** v3 F5c (ADR 0069, H8): one workstream on the Workstreams page. */
export interface WorkstreamRow {
  projectId: string;
  workstream: string;
  principals: { id: string; name: string | null }[];
  first: string | null;
  last: string | null;
  jobs: number;
  openJobs: number;
  failedJobs: number;
  proposals: number;
  awaitingOwner: number;
  writes: number;
  pages: number;
  unknownOutcomes: number;
}

export interface WorkstreamsPayload {
  project: { id: string; name: string };
  workstreams: WorkstreamRow[];
}

export interface WorkstreamWrite {
  journalId: number;
  op: string;
  what?: string;
  versionBefore: string | null;
  versionAfter: string | null;
  outcome: string;
}

export interface WorkstreamReport {
  cost: string;
  counts: Record<string, number>;
  groups: {
    writtenAndVerified: {
      page: { id: string; name: string | null };
      writes: WorkstreamWrite[];
      verified: boolean | null;
    }[];
    acceptedNotYetRun: Record<string, unknown>[];
    deliberatelyExcluded: Record<string, unknown>[];
    awaitingJudgement: Record<string, unknown>[];
    residualInconsistencies: {
      unknownOutcomes: Record<string, unknown>[];
      verificationMismatches: Record<string, unknown>[];
      failedJobs: Record<string, unknown>[];
      openFindings: Record<string, unknown>[];
      consistencyFollowUps: Record<string, unknown>[];
    };
  };
  stillToDo: string[];
}
