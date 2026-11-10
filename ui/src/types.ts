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
  pendingProposals: number;
  writes: { state: 'running' | 'paused' | 'draining'; perMinute: number };
  /** Null when the project has no governor now (its key is not in use). */
  budget: { queues: Record<PriorityClass, number>; gauges: TierSnapshot[] } | null;
  /** OPS2: the owner's sign-in and the secret store. */
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
    current: { interactive: number; job: number; maintenance: number };
    environment: { interactive: number; job: number; maintenance: number };
    stored: { interactive: number; job: number; maintenance: number } | null;
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
  kind: 'root' | 'index' | 'bsrc' | 'unclassified';
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
    byKind: Record<'root' | 'index' | 'bsrc' | 'unclassified', number>;
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
