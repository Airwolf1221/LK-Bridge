import { loggedTask, type TaskLogger } from './maintenance/task-log.js';
import { EXPLICIT_PACK_TOOLS, genericPackTool, genericPackToolNames } from './mcp/tools/packs.js';
import { createPacks, type Packs } from './packs/service.js';
import { findPageByName } from './packs/find-page.js';
import { ToolListWatch } from './mcp/tool-list.js';
import { inNarratives, narrativeRulesOf, narrativeScope } from './narrative/scope.js';
import { narrativeCalendar } from './narrative/calendar.js';
import { narrativeBlindAppraisal } from './narrative/authority.js';
import { narrativeCompare } from './narrative/names.js';
import { governanceAuditHook } from './packs/governance-audit.js';
import { knownNamesOf } from './mcp/tools/known-names.js';
import { textRemovalReader } from './policy/text-removal.js';
import { registerPackEngine } from './packs/engine/checks.js';
import { PACK_CHECKS } from './packs/engine/job.js';
import { addPackTaxonomyEntry, renamePackTaxonomyEntry } from './packs/taxonomy.js';
import { deletedPageRecord, restoreSetReader } from './lifecycle/deleted.js';
import { listDropsReader } from './policy/list-drops.js';
import { BLOCKWISE_CHECK, blockwiseChecker } from './pages/blockwise.js';
import { BlockwiseUndo } from './pages/undo.js';
import { pino } from 'pino';
import type { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyStoredSettings } from './admin/index.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  defaultMaintenanceSettings,
  defaultPolicySettings,
  jobsSettingsFrom,
  MASTER_KEY_NOT_SET_WARNING,
  MASTER_KEY_SHORT_WARNING,
  type AdminSettings,
  type Config,
  type MaintenanceSettings,
  type PolicySettings,
  type ToolsSettings,
} from './config/index.js';
import { databaseFile, type Db } from './db/open.js';
import { createJobEngine, UPLOAD_PUT_STEP, UPLOAD_VERIFY_STEP, type JobEngine } from './jobs/index.js';
import { defaultTransport, type Clock, type Transport } from './lk/index.js';
import type { McpResourceProvider, McpToolProvider } from './mcp/server.js';
import {
  BRIDGE_INSTRUCTIONS,
  createBridgeTools,
  createUploadPutHandler,
  createUploadVerifyHandler,
  guideResources,
  createUploadTransport,
  type ToolDeps,
} from './mcp/tools/index.js';
import type { GuardOptions } from './mcp/tools/upload-http.js';
import { footerFor } from './mcp/tools/shape.js';
import { ReviewService } from './review/service.js';
import { RevertService } from './review/revert.js';
import { ResumeService } from './resume/service.js';
import { registerRenameChecks, RENAME_CHECKS } from './packs/rename/checks.js';
import { registerSplitChecks } from './packs/split/checks.js';
import { ROUTE_BACK_REBASER, routeBackRebaser } from './jobs/route-back.js';
import { SplitService } from './packs/split/service.js';
import { RetagService } from './packs/retag/service.js';
import { registerRetagChecks, RETAG_CHECKS } from './packs/retag/checks.js';
import { bridgeArchiver } from './packs/split/archive.js';
import { RenameService } from './packs/rename/service.js';
import { createMaintenance, type Maintenance } from './maintenance/index.js';
import { createMappings, type Mappings } from './mappings/index.js';
import { createPolicy, type Policy } from './policy/index.js';
import { systemClock } from './lk/index.js';
import { createAssets, type AssetService } from './assets/index.js';
import { createImages, imageDataDir, type ImageService } from './images/service.js';
import { Audits, SPLIT_CHECK, SPLIT_VERIFY, splitChecker, splitVerifier } from './audits/index.js';
import { Appraisal } from './appraisal/index.js';
import { Consistency } from './consistency/service.js';
import { bridgePicker } from './consistency/fix.js';
import { BlockIdSweep } from './blockids/index.js';
import { SnapshotService } from './snapshots/index.js';
import { Restores } from './snapshots/restores.js';
import { snapshotMapCheckers } from './snapshots/restore.js';
import { Rehearsals } from './snapshots/rehearsal.js';
import { DEFAULT_SNAPSHOT_SETTINGS } from './config/tools.js';
import { createTree, type TreeService } from './tree/index.js';
import { SecretStore } from './secrets/store.js';
import { createRegistry, type Registry } from './registry/index.js';
import {
  createWritePagePlanner,
  DocumentVersions,
  pageConverterContext,
  WRITE_PAGE_PLANNER,
} from './pages/index.js';
import { CanonicalGuard } from './facts/index.js';
import { listSubtree } from './facts/canonical.js';
import { combineGuards } from './jobs/write-guard.js';
import { PageScopeGuard } from './policy/page-scope.js';
import { LifecycleGuard } from './lifecycle/guard.js';
import { lifecycleFrom } from './lifecycle/settings.js';
import { createLmrPlanner } from './lmr/index.js';
import { assetLibraryOf } from './assets/library.js';
import { snapshotPageState } from './snapshots/restore.js';
import { createLifecycle, type Lifecycle } from './lifecycle/index.js';
import { createChronology, type Chronology } from './chronology/index.js';
import { mapCheckers } from './maps/index.js';
import { OffsiteService } from './offsite/service.js';
import type { GoogleOAuthOptions } from './offsite/google.js';
import { requestDir as offsiteRequestDir } from './offsite/requests.js';
import { FactsVersions } from './facts/version.js';
import { ToolCallLog } from './toolcalls/index.js';
import { Evaluation } from './evaluation/index.js';
import { RequestRegistry } from './resources/requests.js';
import { TemplateKeys } from './facts/templates.js';
import {
  InstanceGuard,
  ProjectSelector,
  ProjectStore,
  createProjectRegistry,
  type ProjectRegistry,
} from './projects/index.js';

/**
 * The bridge's working parts, in the order they depend on each other: governor-backed LK client, then the job
 * engine on the migrated database (its restart-resume runs inside `createRuntime`, before the caller opens the
 * MCP endpoint), then the MCP tools. `src/server.ts` builds the HTTP side around it. The policy layer (chunk 2b) is
 * built first: its live gate and proposal sink go into the engine, and it is attached once the engine has started.
 */

/** CR-2026-11-R3 (R3-65): how often the process's memory is logged ("memory"). */
const MEMORY_LOG_MS = 10 * 60_000;
export interface Runtime {
  /**
   * The projects this bridge serves (v2 A1), each with its own governor and key; which are served now, and why not.
   */
  readonly projects: ProjectRegistry;
  /** OPS2: the encrypted secret store (project keys, the owner's credentials). Never exposes a value but by `read`. */
  readonly secrets: SecretStore;
  /** Resolves the `project` argument of the tools (REQUIRE_PROJECT_FOR_WRITES). */
  readonly selector: ProjectSelector;
  /**
   * Resolves once every configured project's key has been checked (each is served from the moment its own check
   * passes). Never rejects: a failed check stops only that project.
   */
  readonly ready: Promise<void>;
  readonly engine: JobEngine;
  /** Profiles, the live policy gate, proposals and owner commands; pass it to `buildServer({ policy })`. */
  readonly policy: Policy;
  /** v2 E3 (ADR 0045): the log of tool calls (names and sizes only) behind the dashboard's Tool calls page. */
  readonly toolCalls: ToolCallLog;
  /** v2 E3: the Evaluation helper (scripted scenarios recorded from the tool-call log); owner only. */
  readonly evaluation: Evaluation;
  /** The maintenance registry, scheduler and owner commands (chunk 6). */
  readonly maintenance: Maintenance;
  /** Repository mappings: data model and owner commands (chunk 6). */
  readonly mappings: Mappings;
  /** v2 A2: the repository tree of each project's AI REPOSITORY (build, after-write updates, sweep, check, queries). */
  readonly tree: TreeService;
  /** v2 A3: the type registry and taxonomy, name resolution, ordering and character placement, per project. */
  readonly registry: Registry;
  /** v2 A4: the asset tree of each project's asset library (build, after-write updates, refresh, check, queries, placement). */
  readonly assets: AssetService;
  /** v2 C2c (ADR 0035): the page lifecycle (settings, records, the link index). */
  readonly lifecycle: Lifecycle;
  /** v2 D1 (ADR 0038): chronology sync (settings, the calendar cache, records, links, the check). */
  readonly chronology: Chronology;
  /** v2 D3 (ADR 0041): the image pipeline (conversion, the binary endpoint's slots, staging, kept bytes). */
  readonly images: ImageService;
  /** v2 E1a (ADR 0042): snapshots (the store, full and change snapshots, retention, verify, restore, rehearsal). */
  readonly snapshots: SnapshotService;
  /** v2 E2 (ADR 0044): the audits: findings only, read from the snapshots. */
  readonly audits: Audits;
  /** v3 F3c (ADR 0054): the appraisal tools and the full-text index (read-only; fixes are proposals). */
  readonly appraisal: Appraisal;
  /** v3 F4b (ADR 0064): the consistency check and "as of a date" (read-only; the owner's pick is a proposal). */
  readonly consistency: Consistency;
  /** v2 E1a: restore proposals (always proposals) and their follow-ups. */
  readonly restores: Restores;
  /** v2 E1a: restore rehearsals into a throwaway root of a sandbox project. */
  readonly rehearsals: Rehearsals;
  /** v2 E1b (ADR 0043): the off-site copy to Google Drive (its settings, the Google connection, the runner's requests). */
  readonly offsite: OffsiteService;
  /** v3 F3a (ADR 0050): the setting packs (rules, attachments, governance, the owner's approval). */
  readonly packs: Packs;
  /** v3 F3.4 (ADR 0055): the review queue of agents' direct writes at scope `write`. */
  readonly review: ReviewService;
  /** v3 F3.4 (ADR 0055): the owner's revert of a finished direct-write job. */
  readonly reverts: RevertService;
  /** v3 F3d (ADR 0058): resuming a package, a rename or a recreate that stopped part-way. */
  readonly resume: ResumeService;
  /** v3 F3d (ADR 0058): arkona_rename's records, token versions and leftover reports. */
  readonly renames: RenameService;
  /** v3 F3e (ADR 0059): arkona_split_owner's records, phase 2 and reverts. */
  readonly splits: SplitService;
  /** v3 F3f (ADR 0060): the retag audit, apply batches, the owner's classifications and reconciliations. */
  readonly retag: RetagService;
  readonly tools: readonly McpToolProvider[];
  /** Tells connected MCP sessions when what is listed changes (`notifications/tools/list_changed`). */
  readonly toolList: ToolListWatch;
  /** v2 B2: the guides, published as MCP resources. */
  readonly resources: readonly McpResourceProvider[];
  readonly instructions: string;
  /** The configuration the components were built from: the environment plus the dashboard's stored settings. */
  readonly config: Config;
  /** The environment's values alone (what clearing a dashboard setting falls back to). */
  readonly envConfig: Config;
  /** Drain (bounded), stop the engine, close the governor. Does not close the database. */
  shutdown(drainTimeoutMs?: number): Promise<void>;
  /**
   * CR-2026-11-R3 (fix A): the stop for a restart (SIGTERM; `server.ts` `stopForRestart`). Does not close the database.
   * Every stage is bounded, so it ends well inside systemd's stop timeout.
   */
  stopForRestart(o?: RestartStopOptions): Promise<RestartStopReport>;
  /** CR-2026-11-R3 (fix A): true from the moment a stop for a restart begins (the HTTP layer refuses new requests). */
  readonly restarting: boolean;
}

/** CR-2026-11-R3 (fix A): how long a restart's stop may wait at each stage. */
export interface RestartStopOptions {
  /** How long running jobs have to reach their next step boundary (requests in flight finish). Default 10 s. */
  readonly graceMs?: number;
  /** How long background work (maintenance runs, passes) may take to stop, alongside the grace. Default 10 s. */
  readonly backgroundMs?: number;
  /** How long a job still in a request after the grace may take before it is left to the start-up recovery. 1 s. */
  readonly engineStopMs?: number;
  /** How long the tree's and the asset tree's final stop may take. Default 2 s. */
  readonly treesMs?: number;
}

/** CR-2026-11-R3 (fix A): what a restart's stop did. */
export interface RestartStopReport {
  readonly ms: number;
  /** Jobs parked at a step boundary for the next start. */
  readonly parked: readonly string[];
  /** Jobs still in a request when the grace ran out: the start-up recovery verifies their step before re-sending. */
  readonly stillRunning: readonly string[];
  /** Stages that ran out of time (the stop went on without them). */
  readonly overran: readonly string[];
}

export interface RuntimeOptions {
  readonly config: Config;
  readonly toolsSettings: ToolsSettings;
  /** Already opened and migrated. */
  readonly db: Db;
  readonly version: string;
  /** POLICY_* settings (`loadPolicyConfig()`); defaults when omitted. */
  readonly policySettings?: PolicySettings;
  /** ADMIN_* settings (`loadAdminConfig()`); defaults when omitted. */
  readonly adminSettings?: AdminSettings;
  /** MAINTENANCE_* settings (`loadMaintenanceConfig()`); defaults when omitted. */
  readonly maintenanceSettings?: MaintenanceSettings;
  /** Test seams. */
  readonly clock?: Clock;
  readonly lkTransport?: Transport;
  /**
   * v2 E5 hotfix (ADR 0046): the only registry operations any project's governor may send; anything else is refused
   * before a request. Only the Markdown round trip's read-only runtime sets it. Unset: every operation.
   */
  readonly lkAllowedOperations?: ReadonlySet<string>;
  readonly uploadGuard?: GuardOptions;
  /**
   * Claim the database for this process (ADR 0023: one bridge process per database and project). Default true; the
   * sandbox scripts, which run on a database of their own, may switch it off.
   */
  readonly instanceGuard?: boolean;
  /** Delays before a project whose key could not be checked is checked again (tests). */
  readonly projectRetryMs?: { readonly first: number; readonly max: number };
  /**
   * `unused` (C2d): this runtime keeps no secrets: the sandbox, soak, spike and round-trip scripts run on a temporary
   * database of their own, with the project's key handed to them directly (test/sandbox/target.ts opens the bridge's
   * store itself). Their wrappers deliberately keep `SECRETS_MASTER_KEY` out of every environment, so its absence is
   * expected there and is logged at debug instead of as a warning. Default `required` (the bridge).
   */
  readonly secretStore?: 'required' | 'unused';
  /** The runtime's log level and destination (default: LOG_LEVEL, to stdout). `createBridge` passes the server's. */
  readonly logLevel?: string;
  readonly logStream?: Writable;
  /** v2 E1b test seam: Google's OAuth and Drive endpoints and the fetch that reaches them (default: Google's). */
  readonly googleOAuth?: GoogleOAuthOptions;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  // Chunk 5: settings the owner saved in the dashboard (tool exposure, member admin, journal retention, tier limits,
  // reserve floors) are applied here, on top of the environment. `envConfig` is kept for "reset to default".
  const envConfig = o.config;
  const config = applyStoredSettings(envConfig, o.db);
  const logOptions = { level: o.logLevel ?? config.logLevel, base: { component: 'engine' } };
  const log = o.logStream ? pino(logOptions, o.logStream) : pino(logOptions);
  // CR-2026-11-R3 (R3-65): what background tasks log their start and finish with (task-log.ts).
  const taskLog: TaskLogger = { info: (obj, msg) => log.info(obj, msg) };
  // Signed upload URLs are on another host: the transport sends LegendKeeper's host through the platform fetch
  // and every other host through the SSRF guard. Both stay under the governor.
  // The SSRF guard for every non-LegendKeeper fetch of the tool layer (the signed-URL PUT and an image source URL):
  // port 443 only unless OUTBOUND_EXTRA_PORTS_ALLOWLIST lists host:port (v1.0.1). Test seams may add to it.
  const uploadGuard: GuardOptions = {
    allowedPorts: o.toolsSettings.outboundExtraPorts ?? new Set<string>(),
    ...(o.uploadGuard ?? {}),
  };
  const imageSettings = o.toolsSettings.images ?? DEFAULT_IMAGE_SETTINGS;
  const transport = createUploadTransport({
    lkOrigin: new URL(config.lk.baseUrl).origin,
    lk: o.lkTransport ?? defaultTransport,
    ...uploadGuard,
    // v2 D3: anonymous downloads of stored asset files (verification, bytes kept before a delete).
    assetHosts: imageSettings.assetHosts,
  });
  // C2d: a runtime that keeps no secrets (the sandbox scripts) expects no master key; nothing else is quietened.
  const secretsUnused = o.secretStore === 'unused';
  const masterKeyWarnings = new Set([MASTER_KEY_NOT_SET_WARNING, MASTER_KEY_SHORT_WARNING]);
  for (const w of config.warnings) {
    if (secretsUnused && masterKeyWarnings.has(w)) log.debug({}, w);
    else log.warn({}, w);
  }
  // ADR 0023: exactly one bridge process serves a database (and so its projects). Refuses a second one.
  const guard = o.instanceGuard === false ? null : new InstanceGuard({ db: o.db, taskLog });
  const took = guard?.acquire();
  if (took?.tookOver) {
    log.warn(
      { pid: took.tookOver.pid, host: took.tookOver.hostname },
      'took over the database from a bridge process that is no longer running',
    );
  }
  // v2 A1: one governor per project (its key's tiers and its project tier), with counts that survive a restart
  // (governor_counters, one row per project). Each project's key is checked below, without blocking start-up.
  // OPS2: the encrypted secret store. A missing or wrong master key only makes the secrets it cannot open unavailable
  // (each affected project is stopped with the reason; the dashboard shows it); nothing here throws.
  const secrets = new SecretStore(o.db, config.secrets, () => (o.clock ?? systemClock).now());
  const storeState = secrets.state();
  if (storeState.problem) {
    if (secretsUnused) log.debug({ keyId: storeState.keyId }, storeState.problem);
    else log.warn({ keyId: storeState.keyId }, storeState.problem);
  }
  // Env keys imported into the store are audited once the policy layer (which holds the audit log) exists; an import
  // made later, at a project's first key check, is audited as it happens.
  const importsToAudit: { project: string; variable: string; hint: string }[] = [];
  let auditImport = (i: { project: string; variable: string; hint: string }): void => {
    importsToAudit.push(i);
  };
  const projects = createProjectRegistry({
    db: o.db,
    config,
    transport,
    secrets,
    onImport: (i) => auditImport(i),
    log: {
      info: (obj, msg) => log.info(obj, msg),
      warn: (obj, msg) => log.warn(obj, msg),
      error: (obj, msg) => log.error(obj, msg),
    },
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.projectRetryMs ? { retryMs: o.projectRetryMs } : {}),
    ...(o.lkAllowedOperations ? { allowedOperations: o.lkAllowedOperations } : {}),
  });
  const selector = new ProjectSelector(projects, config.lk.requireProjectForWrites);
  const footer = (p: { id: string | null; name: string }) => footerFor({ projects }, p.id, p.name);
  const maintenanceSettings = o.maintenanceSettings ?? defaultMaintenanceSettings();
  const policySettings = o.policySettings ?? defaultPolicySettings();
  const policy = createPolicy({
    db: o.db,
    settings: policySettings,
    // The maintenance scheduler's `proposal-expiry` job runs the sweep (chunk 6). With the scheduler switched off the
    // service keeps its own timer, so proposals still expire.
    externalExpirySweep: maintenanceSettings.enabled,
    allowMemberAdmin: config.lk.allowMemberAdmin,
    log,
    proposalTools: { selector, footer },
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const engine = createJobEngine({
    db: o.db,
    projects,
    settings: jobsSettingsFrom(config),
    log,
    policyGate: policy.gate,
    proposalSink: policy.proposals,
    ...(o.clock ? { clock: o.clock } : {}),
    // v2 D1.1 (ADR 0039): the project setting `useEtagVersions` (default on), read when a write's version is wanted.
    etagVersions: (projectId) => projectStore.byId(projectId)?.settings?.useEtagVersions !== false,
    customSteps: {
      [UPLOAD_PUT_STEP]: createUploadPutHandler({
        putTimeoutMs: o.toolsSettings.upload.putTimeoutMs,
        guard: uploadGuard,
        // v3 F2 (ADR 0049 decision 10): a staged image's bytes, from the image service (created below).
        stagedBytes: (sha) => images.stagedBytes.get(sha),
      }),
      [UPLOAD_VERIFY_STEP]: createUploadVerifyHandler({ assetHosts: imageSettings.assetHosts }),
    },
    autoStart: false,
  });
  engine.start(); // restart-resume: jobs left running by a crash are verified and continued
  // OPS2: keys imported from the env file, audited by name and last four characters only.
  auditImport = (i) =>
    policy.store.audit('system', 'project.key_import', i.project, undefined, {
      variable: i.variable,
      keyHint: i.hint,
    });
  for (const i of importsToAudit.splice(0)) auditImport(i);
  // Follows approved proposals' jobs, reconciles proposals left mid-approval by a crash, runs the expiry sweep.
  const detachPolicy = policy.attach(engine);

  // v2 A2: the repository tree. It follows the engine's writes (a re-read after each write that can change the tree,
  // in the same job), resumes a build a restart interrupted, and runs the sweep and check for the scheduler.
  const tree = createTree({
    db: o.db,
    engine,
    projects,
    clock: o.clock ?? systemClock,
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
  });
  tree.attach();
  tree.start();
  // v2 A3: the type registry and taxonomy. Its drift report follows each completed daily check of the tree.
  const registry = createRegistry({
    db: o.db,
    tree,
    engine,
    audit: policy.store,
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachRegistry = registry.attach();
  // v3 F3a (ADR 0050): the setting packs (rules as data, attachments, governance, approval) and their engine hooks.
  const packs = createPacks({
    db: o.db,
    engine,
    projects,
    registry,
    // v3 F4c (ADR 0065): a governance source given by its page's name (any dash), found in the tree.
    findPage: (projectId, name) => findPageByName(tree.queries, projectId, name),
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  try {
    packs.ensureSeeded();
  } catch (err) {
    log.warn({ err }, 'the setting packs could not be seeded');
  }
  // v3 F4c (ADR 0065, design E1): inside Narratives, the Story Map comes first and acts and chapters follow by number
  // (never alphabetically): every tool that places a page there asks the registry for the parent's order.
  registry.setSiblingOrder((projectId, parentId) => {
    const scope = narrativeScope(packs, tree.queries, projectId);
    if (!scope) return null;
    return inNarratives(scope, tree.queries.node(projectId, parentId).data)
      ? narrativeCompare(scope.rules)
      : null;
  });
  const unregisterPackEngine = registerPackEngine(engine, {
    packs,
    registry,
    setTemplate: (projectId, resourceId, templateId) =>
      tree.store.setTemplate(projectId, resourceId, templateId),
    // v3 F3b (ADR 0052): the job's check that each staged image it places is still its to place (read when jobs run,
    // after the image service below exists).
    stagedImage: (projectId, stagedId) => images.staged(projectId, stagedId),
    proposalJob: (proposalId) => policy.proposals.get(proposalId)?.jobId ?? null,
    addTaxonomyEntry: (projectId, r, actor) =>
      addPackTaxonomyEntry(
        registry.forProject(projectId).store,
        r,
        (...a) => policy.store.audit(...a),
        actor,
      ),
    renameTaxonomyEntry: (projectId, r, actor) =>
      renamePackTaxonomyEntry(
        registry.forProject(projectId).store,
        r,
        (...a) => policy.store.audit(...a),
        actor,
      ),
  });
  // v2 C1: the bridge's memory of recent page versions, and write_page's in-lock re-planner (section edits whose section
  // is unchanged). Registered before any job can run: the scheduler starts in a microtask, after createRuntime returns.
  const versions = new DocumentVersions(o.db, () => (o.clock ?? systemClock).now());
  const unregisterPlanner = engine.registerPlanner(
    WRITE_PAGE_PLANNER,
    createWritePagePlanner({
      contextFor: (projectId) => pageConverterContext({ tree, registry }, projectId),
      versions,
    }),
  );

  // v2 C2a (ADR 0032): the protected canonical facts guard, asked by the engine at the entry of every request and
  // before every sidebar write inside its lock; and page names for the guard's reasons and the proposals' page-level
  // summaries, from the repository tree.
  const pageName = (projectId: string, resourceId: string): string | null => {
    try {
      return tree.queries.node(projectId, resourceId).data?.displayName ?? null;
    } catch {
      return null;
    }
  };
  policy.proposals.setPageNames(pageName);
  // v3 F3.4 (ADR 0055): the safety rails count a cascade's pages and name pages from the repository tree.
  policy.gate.setRailLookups({
    pageName,
    descendants: (projectId, resourceId) => {
      try {
        const status = tree.queries.status(projectId).status;
        if (status !== 'ready' && status !== 'stale') return null;
        if (!tree.queries.node(projectId, resourceId).data) return null;
        return Math.max(
          0,
          tree.queries.subtree(projectId, resourceId, { limit: 100_000 }).data.entries.length - 1,
        );
      } catch {
        return null;
      }
    },
    // CR-2026-11-R2 (R2-04): the pages under a page as LegendKeeper holds them now (as the canon guard lists a cascade at
    // entry, CR-09), only when the tree's count would let the request run directly; at most about `limit` + 1 reads.
    liveDescendants: async (projectId, resourceId, limit) => {
      const below = await listSubtree(
        (opId, params) => engine.internalRead(projectId, opId, params, { priority: 'P1' }),
        resourceId,
        limit,
      );
      return below === null ? null : below.length;
    },
  });
  // v3 F2 (ADR 0049 decision 2): a substantial edit also sets its page's Last Major Revision, in the same job and
  // proposal. The planner reads nothing: the tree's sidebar summary says where the row is.
  const unregisterLmr = engine.setLmrPlanner(
    createLmrPlanner({
      settings: (projectId) => projectStore.byId(projectId)?.settings,
      lmrKey: (projectId) => lifecycleFrom(projectStore.byId(projectId)?.settings).fields.lastMajorRevision,
      sidebar: (projectId, pageId) => {
        try {
          return tree.queries.sidebars(projectId, [pageId]).data.get(pageId);
        } catch {
          return undefined;
        }
      },
      pageName,
    }),
  );
  // v2 E6 (ADR 0048): a low-level proposal names the document it touches, from the tree.
  policy.proposals.setDocumentNames((projectId, resourceId, documentId) => {
    try {
      const doc = tree.queries.node(projectId, resourceId).data?.documents.find((d) => d.id === documentId);
      return doc?.name ?? null;
    } catch {
      return null;
    }
  });
  // Read live, so a rule the owner changes on the dashboard applies to the next write.
  const projectStore = new ProjectStore(o.db, () => (o.clock ?? systemClock).now());
  // v2 C2c (ADR 0035): the lifecycle guard beside it: lifecycle changes only through the lifecycle tools (Part 3).
  const treeNode = (projectId: string, id: string) => {
    try {
      return tree.queries.node(projectId, id).data ?? null;
    } catch {
      return null;
    }
  };
  // CR-2026-11-R2 (R2-10): the pages a restore may bring back with the page restored, for both guards (a getter: the
  // snapshot service is made below).
  const restoreSet = restoreSetReader({
    engine,
    snapshots: () => snapshots,
    node: treeNode,
    subtree: (projectId, id) => {
      try {
        return tree.queries.subtree(projectId, id, { limit: 1_000 }).data.entries.map((e) => e.node);
      } catch {
        return null;
      }
    },
  });
  // ADR 0057 decision 9: a restore counts, for the bulk rail, every page its restore set says may come back with it (an
  // unknown set fails closed). Decision 4: a whole-list write through a low-level tool is a removal when it drops an
  // entry LegendKeeper holds now (read live; a read that fails counts as a removal).
  policy.gate.setRailLookups({
    restored: async (projectId, id) => {
      const set = await restoreSet(projectId, id);
      return set.known ? set.pages.length : null;
    },
    drops: listDropsReader((projectId, opId, params) =>
      engine.internalRead(projectId, opId, params, { priority: 'P1' }),
    ),
    // ADR 0061 part B decision 1 (R3-53): text taken off a pack page through a low-level tool is a removal.
    textRemoved: textRemovalReader({
      packs,
      node: treeNode,
      characterOf: (projectId, id) => {
        try {
          return registry.forProject(projectId).characterOfPage(id).ok;
        } catch {
          return false;
        }
      },
      factKeys: (projectId, id) => {
        try {
          const sb = tree.queries.sidebars(projectId, [id]).data.get(id) ?? null;
          return sb
            ? (sb as readonly { kind?: string; rows?: readonly { key: string }[] }[])
                .filter((x) => x.kind === 'keyValue')
                .flatMap((x) => (x.rows ?? []).map((r) => r.key))
            : null;
        } catch {
          return null;
        }
      },
      read: (projectId, opId, params) => engine.internalRead(projectId, opId, params, { priority: 'P1' }),
    }),
  });
  const lifecycleGuard = new LifecycleGuard({
    settings: (projectId) => projectStore.byId(projectId)?.settings,
    engine,
    node: treeNode,
    restoreSet,
    // v2 E4 (RV2-1): what a delete recorded of a page (its name, parent and tags), so its restore can be judged.
    deletedPage: (projectId, id) => deletedPageRecord(engine, projectId, id),
    // v3 F2 (ADR 0049 decision 5): else what the newest snapshot holding it says (a page deleted in the app).
    snapshotPage: async (projectId, id) => {
      const s = await snapshotPageState(snapshots, projectId, id);
      return s ? { name: s.name, parentId: s.parentId, tags: s.tags } : null;
    },
    // v3 F3d (ADR 0053): the AU ruling's status tag is guarded on a project whose approved pack carries it.
    tagRules: (projectId) => packs.lifecycleRules(projectId),
  });
  const unregisterGuard = engine.setWriteGuard(
    combineGuards(
      // C2d (ADR 0036 decision 5): an approval covers only the pages it listed (checked again inside the lock).
      new PageScopeGuard(),
      new CanonicalGuard({
        settings: (projectId) => projectStore.byId(projectId)?.settings,
        engine,
        pageName,
        // v3 F2 (ADR 0049 decision 5): a deleted page restored is judged by the sidebar its newest snapshot holds.
        restoredPage: async (projectId, id) => {
          const s = await snapshotPageState(snapshots, projectId, id);
          return s ? { name: s.name, rows: s.rows } : null;
        },
        restoreSet,
        // v2 C2b: a cascade delete's pages, from the repository tree (null when the tree cannot answer).
        descendants: (projectId, resourceId) => {
          try {
            const status = tree.queries.status(projectId).status;
            if (status !== 'ready' && status !== 'stale') return null;
            if (!tree.queries.node(projectId, resourceId).data) return null; // not in the tree: listed live
            return tree.queries
              .subtree(projectId, resourceId, { limit: 100_000 })
              .data.entries.map((e) => e.node.id)
              .filter((id) => id !== resourceId);
          } catch {
            return null;
          }
        },
        // v2 C2c: a page's kind (its prefix) and a document's type, for the delete rules of the lifecycle (ADR 0035).
        pageKind: (projectId, resourceId) => {
          try {
            return tree.queries.node(projectId, resourceId).data?.kind ?? null;
          } catch {
            return null;
          }
        },
        documentInfo: (projectId, resourceId, documentId) => {
          try {
            const d = tree.queries
              .node(projectId, resourceId)
              .data?.documents.find((x) => x.id === documentId);
            return d ? { type: d.type, name: d.name } : null;
          } catch {
            return null;
          }
        },
      }),
      lifecycleGuard,
    ),
  );

  // v2 C2c (ADR 0035): the page lifecycle: its settings, the lifecycle record (the bridge.record step) and the link
  // index (followed from every write; swept by the maintenance job).
  const lifecycle = createLifecycle({
    db: o.db,
    engine,
    tree,
    settings: (projectId) => projectStore.byId(projectId)?.settings,
    setSetting: (projectId, key, value) => {
      projects.setSetting(projectId, key, value);
    },
    projectName: (projectId) => projects.nameOf(projectId),
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    busy: (projectId) => {
      const q = projects.anyClient(projectId)?.governor.snapshot().queues;
      return q !== undefined && q.P1 + q.P2 > 0;
    },
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachLifecycle = lifecycle.attach();
  // v2 D1 (ADR 0038): chronology sync: its settings, the calendar cache, the record and links its jobs write (the
  // bridge.record step), the checks inside the lock, and the chronology check.
  const chronology = createChronology({
    db: o.db,
    engine,
    tree,
    settings: (projectId) => projectStore.byId(projectId)?.settings,
    setSetting: (projectId, key, value) => {
      projects.setSetting(projectId, key, value);
    },
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    busy: (projectId) => {
      const q = projects.anyClient(projectId)?.governor.snapshot().queues;
      return q !== undefined && q.P1 + q.P2 > 0;
    },
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachChronology = chronology.attach();
  // v2 D2 (ADR 0040): the map-feature checks inside the lock (the compare-and-swap for writes LegendKeeper does not
  // version, and the verify after them). Pure functions; nothing to configure.
  const detachMaps = Object.entries(mapCheckers()).map(([name, fn]) => engine.registerMapChecker(name, fn));

  const characterType = (projectId: string) =>
    registry
      .forProject(projectId)
      .store.listTypes()
      .find((t) => t.placementKind === 'character');

  // v2 A4: the asset tree. It follows the engine's asset writes (a re-read after each, in the same job), resumes a
  // build a restart interrupted, and runs the refresh and check for the scheduler. Placement planning reads both trees.
  const assets = createAssets({
    db: o.db,
    engine,
    projects,
    clock: o.clock ?? systemClock,
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
    tree: tree.queries,
    // The type registry (A3) says where characters live: their asset root folder and their Characters index page.
    characterType: (projectId) => {
      const t = characterType(projectId);
      return t
        ? {
            assetRootFolder: t.assetRootFolder,
            rootIndexId: t.rootIndexId,
            unknownIndexName: t.placement?.unknownIndexName ?? null,
            coreReferenceType: t.placement?.referenceTypes.core ?? null,
          }
        : null;
    },
  });
  assets.attach();
  assets.start();
  // v2 E1a (ADR 0042): the snapshot store, beside the database the runtime was GIVEN (as the images' directory is). It
  // follows every write (change snapshots) and holds D3's kept bytes too (one store, not two).
  const runtimeDbPath = databaseFile(o.db) ?? ':memory:';
  // v2 E1b (ADR 0043): the off-site copy. Its runner is a separate service; the bridge keeps the connection and keys,
  // and leaves it requests in <data dir>/offsite/requests (a private temporary directory for an in-memory database).
  const offsite = new OffsiteService({
    db: o.db,
    secrets,
    publicUrl: config.server.publicUrl,
    requestDir:
      runtimeDbPath === ':memory:'
        ? join(tmpdir(), `lkb-offsite-${process.pid}-${randomBytes(4).toString('hex')}`, 'requests')
        : offsiteRequestDir(runtimeDbPath),
    ...(o.googleOAuth ? { google: o.googleOAuth } : {}),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const snapshots = new SnapshotService({
    db: o.db,
    engine,
    projects,
    tree,
    settings: o.toolsSettings.snapshots ?? DEFAULT_SNAPSHOT_SETTINGS,
    assetHosts: imageSettings.assetHosts,
    dbPath: runtimeDbPath,
    imageDir: imageDataDir(imageSettings, runtimeDbPath),
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    busy: (projectId) => {
      const q = projects.anyClient(projectId)?.governor.snapshot().queues;
      return q !== undefined && q.P1 + q.P2 > 0;
    },
    now: () => (o.clock ?? systemClock).now(),
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
    afterFull: async (projectId) => {
      // CR-2026-11-R3 (R3-65): background work: its start and finish in the log, with the memory.
      await loggedTask(taskLog, 'off-site copy after the full snapshot', { project: projectId }, () =>
        offsite.afterFullSnapshot(),
      );
      // v2 E2: an audit of the snapshot just completed (in the background; it reads no LegendKeeper).
      audits?.afterFullSnapshot(projectId);
      // v3 F3c (ADR 0054): the appraisal's overlay and full-text index rebuilt from it (likewise).
      appraisal?.afterFullSnapshot(projectId);
    },
  });
  void snapshots.start();
  // v2 E2 (ADR 0044): the audits, over the snapshots, the registry, the lifecycle records and the chronology check. Its
  // "Propose a fix" for a paragraph with line breaks checks the block inside the lock (the two checkers below).
  // v3 F3f (ADR 0060): the retag service is made later (it needs the appraisal and the proposals); the audits (its tag
  // findings) and Revert (an approved retag batch is revertible) reach it through this.
  const retagRef: { current: RetagService | null } = { current: null };
  // v3 F4a (ADR 0063): the governance check compares the governance pages with the bridge's tool list, made below.
  const toolsRef: { current: readonly McpToolProvider[] } = { current: [] };
  // v3 F4b (ADR 0064): the consistency check (made below, over the appraisal's overlay) feeds the audits' category.
  const consistencyRef: { current: Consistency | null } = { current: null };
  const audits: Audits = new Audits({
    db: o.db,
    snapshots,
    registry,
    chronology,
    tree,
    engine,
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg), info: (obj, msg) => log.info(obj, msg) },
    // v3 F2 (ADR 0049 decision 9): duplicate asset folders, from the bridge's asset tree (no LegendKeeper read).
    assetLibrary: (projectId) => assetLibraryOf(assets, projectId),
    // v3 F3d (ADR 0053): where the lifecycle tag goes and the AU ruling, from the project's approved pack.
    lifecycleTags: (projectId) => packs.lifecycleRules(projectId),
    // v3 F3f (ADR 0060): the tag findings from the retag engine, where the approved pack has retag rules.
    retag: (projectId) => retagRef.current?.auditHook(projectId) ?? null,
    // v3 F4a (ADR 0063): the governance documents against the bridge, where an attached pack has drift rules.
    governance: (projectId) =>
      governanceAuditHook({
        packs: packs.forProject(projectId),
        rulesAt: (id, version) => packs.store.rulesAt(id, version),
        projectName: projectStore.byId(projectId)?.name ?? null,
        known: () => knownNamesOf(toolsRef.current),
      }),
    // v3 F4b (ADR 0064): the Contradictory pairs of the consistency check (its facts index over the same snapshots).
    consistency: async (projectId) =>
      consistencyRef.current ? consistencyRef.current.auditItems(projectId) : null,
    // v3 F4c (ADR 0065): the narrative audit (the `narrative` category) and the narrative pages' exemptions.
    narrative: (projectId) => {
      const rules = narrativeRulesOf(packs, projectId);
      return rules ? { rules, ...narrativeCalendar(chronology, projectId) } : null;
    },
  });
  audits.start();
  // v3 F3c (ADR 0054): the appraisal tools and the full-text index, over the snapshot overlay, the audits, the asset tree
  // and the proposals. Read-only: a fix is always ONE proposal for the owner.
  const appraisal: Appraisal = new Appraisal({
    db: o.db,
    snapshots,
    audits,
    packs,
    tree,
    assets,
    proposals: policy.proposals,
    chronologyDocuments: (projectId) => {
      try {
        return (chronology.config(projectId).ages ?? []).map((a) => a.tableDocumentId);
      } catch {
        return [];
      }
    },
    characterFolder: (projectId, subject, race) => {
      const r = images.plan(projectId, { for_character: { name: subject, race } });
      return r.ok ? r.plan.destination.path : null;
    },
    engine,
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    assetHosts: imageSettings.assetHosts,
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg), info: (obj, msg) => log.info(obj, msg) },
  });
  // v3 F4b (ADR 0064): the consistency check and "as of a date", over the appraisal's overlay, the chronology's tables
  // and the calendar engine (free); the owner's pick is one proposal (src/consistency/fix.ts).
  const consistency: Consistency = new Consistency({
    db: o.db,
    // v3 F4c (ADR 0065, design E2): the facts index never reads a narrative page (fiction is never canon evidence).
    appraisal: narrativeBlindAppraisal(
      appraisal,
      (projectId) => narrativeRulesOf(packs, projectId)?.indexes.narratives ?? null,
    ),
    tree,
    registry,
    chronology,
    piece: (sha) => snapshots.store.getJson(sha),
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    now: () => (o.clock ?? systemClock).now(),
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    auditKnows: (projectId, consistencyId) =>
      audits.store
        .list(projectId, { category: ['consistency'], acknowledged: 'include', limit: 1000 })
        .findings.some((f) => f.evidence.consistencyId === consistencyId),
    jobOfProposal: (proposalId) => policy.proposals.get(proposalId)?.jobId ?? null,
  });
  consistencyRef.current = consistency;
  // v3 F3.5 (ADR 0056): the block-id sweep, an approved narrow automation. Its candidates come from the appraisal's
  // snapshot overlay (no LegendKeeper read); each document is one P3 job with its own check and verify (two checkers).
  const blockIds = new BlockIdSweep({
    db: o.db,
    engine,
    projects,
    version: o.version,
    overlay: {
      ensure: async (projectId) => {
        const st = (await appraisal.ensureIndex(projectId)).state;
        return st
          ? {
              snapshotId: st.newestSnapshotId,
              takenAt: st.newestTakenAt,
              stamp: `${st.baseSnapshotId}:${st.newestSnapshotId}:${st.updatedAt}:${st.pages}`,
            }
          : null;
      },
      pages: (projectId) => appraisal.index.pages(projectId),
      piece: (sha) => snapshots.store.getJson(sha),
    },
    now: () => (o.clock ?? systemClock).now(),
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachBlockIds = blockIds.attach();
  const detachAuditCheckers = [
    engine.registerChecker(SPLIT_CHECK, splitChecker),
    engine.registerChecker(SPLIT_VERIFY, splitVerifier),
    // v2 E4 (ADR 0046): block-by-block page writes (write_page on a page the API cannot take back whole, and restores).
    engine.registerChecker(BLOCKWISE_CHECK, blockwiseChecker),
  ];
  // v2 E4: a block-by-block write that stops part-way is undone when the page is exactly as it left it.
  const blockwiseUndo = new BlockwiseUndo({ engine, log: { warn: (obj, msg) => log.warn(obj, msg) } });
  const detachBlockwiseUndo = blockwiseUndo.start();
  // v2 E1a: restores are always proposals; the plan reads the page live at P1 and the tree for names and places.
  const restores = new Restores({
    db: o.db,
    svc: snapshots,
    engine,
    deps: (projectId) => ({
      svc: snapshots,
      read: snapshots.reader(projectId, 'P1', { wait: false }),
      projectSettings: (pid) => projectStore.byId(pid)?.settings ?? {},
      node: (pid, id) => treeNode(pid, id),
      children: (pid, id) => {
        try {
          return tree.queries.children(pid, id).data.map((n) => ({ id: n.id, rank: n.rank }));
        } catch {
          return [];
        }
      },
      assetLive: (pid, id) => {
        try {
          return assets.queries.asset(pid, id).data !== null;
        } catch {
          return false;
        }
      },
      now: () => (o.clock ?? systemClock).now(),
    }),
    // v2 E5.5: the restore's time once approved, from the project's governor (learned limits, measured write time).
    estimate: (projectId, input) => projects.anyClient(projectId)?.governor.estimate(input),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachRestores = restores.attach();
  const rehearsals = new Rehearsals({
    svc: snapshots,
    engine,
    projects: {
      find: (ref) => {
        const p = projects.find(ref);
        return p ? { id: p.id, name: p.name, isSandbox: p.isSandbox, status: p.status } : undefined;
      },
      list: () =>
        projects.list().map((p) => ({ id: p.id, name: p.name, isSandbox: p.isSandbox, status: p.status })),
      client: (id) => projects.client(id),
    },
    projectSettings: (pid) => projectStore.byId(pid)?.settings ?? {},
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  rehearsals.markInterrupted();
  const detachSnapshotCheckers = Object.entries(snapshotMapCheckers()).map(([name, fn]) =>
    engine.registerMapChecker(name, fn as Parameters<JobEngine['registerMapChecker']>[1]),
  );
  const images = createImages({
    // v3 F2 (ADR 0049 decision 10): migrate-staging downloads the old staged images through the project's governor.
    lkFor: (projectId) => projects.client(projectId),
    db: o.db,
    engine,
    assets,
    registry,
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    upload: o.toolsSettings.upload,
    images: imageSettings,
    // The database this runtime was GIVEN, never the config's default path (relative to the working directory): the
    // owner's sandbox run of 12 November 2026 resolved `images/` from `./data/bridge.db` in the read-only app folder.
    dbPath: runtimeDbPath,
    keptBytes: snapshots.keptBytes,
    uploadedBytes: (bytes) => snapshots.rememberBytes(bytes),
    proposals: {
      get: (id) => policy.proposals.get(id),
      // v3 F3b (ADR 0052): a setting pack's package takes over a staged image's own pending placement.
      isImagePlacement: (id, stagedId) => policy.proposals.isImagePlacement(id, stagedId),
      supersede: (id, reason) => policy.proposals.supersede(id, reason),
    },
    now: () => (o.clock ?? systemClock).now(),
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
  });
  images.start();

  // v3 F3.4 (ADR 0055): the review of agents' direct writes at scope `write`, and the owner's revert of one.
  const review = new ReviewService({
    db: o.db,
    engine,
    policy: policy.store,
    now: () => (o.clock ?? systemClock).now(),
    pageName,
    documentName: (projectId, resourceId, documentId) => {
      try {
        return (
          tree.queries.node(projectId, resourceId).data?.documents.find((d) => d.id === documentId)?.name ??
          null
        );
      } catch {
        return null;
      }
    },
    folderName: (projectId, id) => {
      if (id === null) return null;
      try {
        return assets.queries.folder(projectId, id).data?.name ?? null;
      } catch {
        return null;
      }
    },
    chronology: chronology.store,
    images,
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachReview = review.attach();
  // v3 F3e: the split service is made after the reverts (it hooks the proposals); Revert reaches it through this.
  const splitsRef: { current: SplitService | null } = { current: null };
  const reverts = new RevertService({
    db: o.db,
    engine,
    review,
    policy: policy.store,
    now: () => (o.clock ?? systemClock).now(),
    chronology: {
      readiness: (projectId) => {
        const r = chronology.readiness(projectId);
        return r.ok ? { ok: true, config: r.config } : { ok: false, message: r.message };
      },
      calendar: (projectId, calendarId) => chronology.calendar(projectId, calendarId),
      remember: (projectId, definition) => chronology.remember(projectId, definition),
    },
    images,
    // v3 F3e (ADR 0059): a split's phase 1 is revertible; the pages it made go to a deletion proposal afterwards.
    splits: {
      isPhase1: (projectId, jobId) => splitsRef.current?.isPhase1(projectId, jobId) ?? false,
      isReverted: (projectId, jobId) => splitsRef.current?.isReverted(projectId, jobId) ?? false,
      isRetired: (projectId, jobId) => splitsRef.current?.isRetired(projectId, jobId) ?? false,
      pagesMade: (projectId, jobId) => splitsRef.current?.pagesMade(projectId, jobId) ?? 0,
      coreUpgrade: (projectId, jobId) => splitsRef.current?.coreUpgrade(projectId, jobId) ?? null,
      afterRevert: (projectId, jobId, revertJobId) =>
        splitsRef.current?.afterRevert(projectId, jobId, revertJobId) ?? Promise.resolve(null),
    },
    // v3 F4b (ADR 0064, D6): the job of an owner's pick is revertible like an approved retag batch.
    approvedRevertible: (projectId, jobId) =>
      (retagRef.current?.isApplyJob(projectId, jobId) ?? false) || consistency.isPickJob(projectId, jobId),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachReverts = reverts.start();
  // v3 F3d (ADR 0058): resuming a package, a rename or a recreate that stopped part-way.
  /**
   * Whether a job has been reverted, is being, or was partly (CR-2026-11-R3, R3-45: a revert job that failed or was
   * cancelled may have put some of it back): it is never continued then (Resume, or a step Retry).
   */
  const revertStateOf = (projectId: string, jobId: string): 'submitted' | 'succeeded' | 'stopped' | null => {
    const row = o.db
      .prepare(`SELECT state FROM job_reverts WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1`)
      .get(projectId, jobId) as { state: string } | undefined;
    if (row?.state === 'submitted' || row?.state === 'succeeded') return row.state;
    if (row?.state === 'failed' || row?.state === 'cancelled') return 'stopped';
    // v3 F3e (ADR 0059): a split's phase 1 reverted with no revert job (it stopped before anything left the source).
    return splitsRef.current?.isReverted(projectId, jobId) ? 'succeeded' : null;
  };
  const unregisterContinueGuard = engine.setContinueGuard((projectId, jobId) => {
    const r = revertStateOf(projectId, jobId);
    return r === 'succeeded'
      ? `Job ${jobId} has been reverted: what it did was undone, so it is not continued. Plan the work again.`
      : r === 'submitted'
        ? `A revert of job ${jobId} is running: it is not continued.`
        : r === 'stopped'
          ? `A revert of job ${jobId} stopped part-way, so some of what it did may be undone already: it is not continued. Look at the revert on the Review page.`
          : null;
  });
  const resume = new ResumeService({
    db: o.db,
    engine,
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    proposals: {
      byJob: (projectId, jobId) => policy.proposals.byJob(projectId, jobId),
      jobResumed: (projectId, jobId) => policy.proposals.jobResumed(projectId, jobId),
      stateOf: (proposalId) => policy.proposals.get(proposalId)?.state ?? null,
    },
    // CR-2026-11-R3, R3-55 (ADR 0061 part B decision 4): an agent's Resume meets its profile's rails again.
    rails: (projectId, principalId, items, tool) =>
      policy.gate.rails({ principalId, profile: '', label: '' }, items, {
        project: projectId,
        jobKind: 'batch_ops',
        ...(tool !== undefined ? { tool } : {}),
      }),
    finishRecreate: async (projectId, restoreId, origin, by) => {
      const r = await restores.finish(projectId, restoreId, origin, by);
      return r.status === 'nothing_to_do'
        ? { status: 'nothing_to_do' as const, summary: r.plan.summary }
        : { status: 'proposal_captured' as const, proposalId: r.proposalId, summary: r.summary };
    },
    revertState: (projectId, jobId) => revertStateOf(projectId, jobId),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachResume = resume.start();
  // v3 F3d (ADR 0058): `arkona_rename`: its in-job checks, its record, the token change's pack version (the job waits for
  // the owner to approve it) and what a rename left, from the full-text index.
  const unregisterRenameChecks = registerRenameChecks(engine, packs, (projectId, pageId) => {
    // CR-2026-11-R3 (R3-29): the tree's view of a page (its name and path), for the rename's history check.
    const n = tree.queries.node(projectId, pageId).data;
    return n ? { rawName: n.rawName, path: n.path } : null;
  });
  const renames = new RenameService({
    db: o.db,
    engine,
    packs,
    proposals: {
      addHooks: (h) => policy.proposals.addHooks(h),
      get: (id) => policy.proposals.get(id),
    },
    appraisal,
    // ADR 0058 amendment (B): whose set a page is in, for the review list's shared names.
    characterOf: (projectId, pageId) => {
      try {
        const c = registry.forProject(projectId).characterOfPage(pageId);
        return c.ok ? c.value.subject || null : null;
      } catch {
        return null;
      }
    },
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachRenames = renames.start();
  // v3 F3e (ADR 0059): arkona_split_owner: its in-job checks and rebasers, its record, phase 2 (the source's archive,
  // proposed by the bridge once phase 1 has verified) and the deletion proposal after a revert of phase 1.
  const unregisterSplitChecks = registerSplitChecks(engine);
  // CR-2026-11-R3 (R3-37): "Propose these again" puts back the routing lines a partial approval left out.
  const unregisterRouteBack = engine.registerRebaser(ROUTE_BACK_REBASER, routeBackRebaser);
  // CR-2026-11-R3 (R3-62): the governance checks a large check runs again when its job goes on after a wait.
  const unmarkRelock = [PACK_CHECKS.governance, RENAME_CHECKS.pack, RETAG_CHECKS.policy].map((c) =>
    engine.markRelockCheck(c),
  );
  const splits = new SplitService({
    db: o.db,
    engine,
    proposals: {
      addHooks: (h) => policy.proposals.addHooks(h),
      get: (id) => policy.proposals.get(id),
      itemsOf: (id) => policy.proposals.itemsOf(id),
    },
    parentOf: (projectId, pageId) => tree.queries.node(projectId, pageId).data?.parentId ?? null,
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const detachSplits = splits.start();
  splitsRef.current = splits;
  // v3 F3f (ADR 0060): the retag audit and its separately approved apply: the job's checks (the policy, a fresh read per
  // page, the in-lock tags rebaser, the read-back), each batch's dispositions, the owner's classifications.
  const retag = new RetagService({
    db: o.db,
    packs,
    appraisal,
    templateOf: (projectId, pageId) => tree.queries.node(projectId, pageId).data?.templateId ?? null,
    engine,
    proposals: {
      addHooks: (h) => policy.proposals.addHooks(h),
      get: (id) => policy.proposals.get(id),
    },
    projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
    audit: (actor, action, target, before, after) => policy.store.audit(actor, action, target, before, after),
    now: () => (o.clock ?? systemClock).now(),
    log: { warn: (obj, msg) => log.warn(obj, msg) },
  });
  const unregisterRetagChecks = registerRetagChecks(engine, {
    policy: (packId, projectId) => retag.currentPolicy(packId, projectId),
    governance: (packId) => packs.governance(packId),
    records: (projectId, pageId) => retag.recordsOf(projectId, pageId),
  });
  const detachRetag = retag.start();
  retagRef.current = retag;

  // Chunk 6: the maintenance scheduler (budget sampler, journal prune, proposal expiry, SQLite optimise). Its state is
  // in SQLite; at most one overdue run per job happens now, before any timer fires.
  const maintenance = createMaintenance({
    db: o.db,
    engine,
    projects,
    policy,
    clock: o.clock ?? systemClock,
    settings: maintenanceSettings,
    expirySweepMs: policySettings.expirySweepMs,
    proposalRetentionMs: policySettings.proposalRetentionMs,
    log: { warn: (obj, msg) => log.warn(obj, msg), info: (obj, msg) => log.info(obj, msg) },
    tree,
    assets,
    links: lifecycle,
    chronology,
    snapshots,
    audits: { run: (projectId, trigger) => audits.run(projectId, trigger) },
    blockIds,
  });
  maintenance.start();
  // CR-2026-11-R3 (R3-65): the process's memory in the log every 10 minutes (and once at start), so a long run shows which
  // part grows: the V8 heap (used, and what V8 holds for it), memory outside it (Buffers, native), or the resident set.
  const logMemory = () => {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576);
    log.info(
      {
        memory: {
          rssMb: mb(m.rss),
          heapUsedMb: mb(m.heapUsed),
          heapTotalMb: mb(m.heapTotal),
          externalMb: mb(m.external),
          arrayBuffersMb: mb(m.arrayBuffers),
        },
      },
      'memory',
    );
  };
  logMemory();
  const memoryTimer = setInterval(logMemory, MEMORY_LOG_MS);
  memoryTimer.unref();
  const mappings = createMappings({
    db: o.db,
    engine,
    policyStore: policy.store,
    now: () => (o.clock ?? systemClock).now(),
  });

  const toolDeps: ToolDeps = {
    engine,
    projects,
    selector,
    settings: o.toolsSettings,
    version: o.version,
    principalNames: (ids) => policy.store.describePrincipals(ids),
    configuredReadOnly: config.lk.readOnly,
    publicUrl: config.server.publicUrl,
    uploadGuard,
    services: {
      tree,
      registry,
      assets,
      versions,
      projectSettings: (projectId) => projectStore.byId(projectId)?.settings ?? {},
      templateKeys: new TemplateKeys(o.db, () => (o.clock ?? systemClock).now()),
      // v2 C2b: factsVersion's memory, and the create tools' operation ids and duplicate-request claims (kept at
      // least as long as the journal).
      factsVersions: new FactsVersions(o.db, () => (o.clock ?? systemClock).now()),
      requests: new RequestRegistry(
        o.db,
        () => (o.clock ?? systemClock).now(),
        Math.max(30, config.journal.retentionDays + 1) * 24 * 3_600_000,
      ),
      // v2 C2c: the page lifecycle (settings, records, the link index).
      lifecycle,
      // v2 D1: chronology sync.
      chronology,
      images,
      snapshots,
      restores,
      // v2 E2: the audits (audit_findings).
      audits,
      // v2 E4: the undo of a block-by-block write that stopped part-way.
      blockwiseUndo,
      // v3 F3a (ADR 0050): the setting packs.
      packs,
      // v3 F3c (ADR 0054): the appraisal tools and the full-text index.
      appraisal,
      // v3 F4b (ADR 0064): the consistency check and "as of a date".
      consistency,
      // v3 F3d (ADR 0058): resuming a package or a rename that stopped part-way.
      resume,
      // v3 F3d (ADR 0058): arkona_rename's records and leftover reports.
      renames,
      // v3 F3e (ADR 0059): arkona_split_owner's records, phase 2 and reverts.
      splits,
      // v3 F3f (ADR 0060): the retag audit and apply.
      retag,
    },
  };
  // v3 F3e (ADR 0059, D2): phase 2 is archive_page's own plan, proposed by the bridge (it needs the tool layer's deps).
  splits.setArchiver(bridgeArchiver(toolDeps));
  // v3 F4b (ADR 0064, D6): the owner's pick is one proposal, planned with the tool layer (the chronology's row tools).
  consistency.setPicker(bridgePicker(toolDeps));
  const bridgeTools = createBridgeTools(toolDeps, { exposePerOpTools: config.mcp.exposePerOpTools });
  // The agent-facing proposal tools (read-only, own proposals only, per project), with the budget footer like every
  // tool.
  const tools: McpToolProvider[] = [...bridgeTools, ...policy.tools];
  // v3 F4a (ADR 0063): the same array, kept current as pack tools join and leave it.
  toolsRef.current = tools;
  // v3 F3a (ADR 0050): a pack's tools follow its data: every tool name its types name besides the explicit ones gets the
  // generic pack tool, added (and removed) in this same list when the pack's rules change, so a new type needs no code.
  const syncPackTools = () => {
    const want = genericPackToolNames(packs.list(), EXPLICIT_PACK_TOOLS);
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i] as McpToolProvider & { packGeneric?: boolean };
      if (t.packGeneric === true && !want.some((x) => x.name === t.name)) tools.splice(i, 1);
    }
    for (const x of want)
      if (!tools.some((t) => t.name === x.name))
        tools.push(genericPackTool(toolDeps, x.packId, x.prefix, x.tool));
  };
  syncPackTools();
  const detachPackTools = packs.onChange(syncPackTools);
  // The owner's report (20 November 2026): a pack approval (or any setting) that changes what is listed tells every
  // connected session (`notifications/tools/list_changed`, sent by the transport); each list is worked out afresh.
  const toolList = new ToolListWatch({
    listed: () =>
      tools
        .filter((t) => {
          if (t.retired === true) return false;
          try {
            return t.listed?.() !== false;
          } catch {
            return false;
          }
        })
        .map((t) => t.name),
    profiles: () =>
      policy.store
        .listProfiles()
        .map((p) => ({ id: p.id, scope: p.scope, showLowLevelTools: p.showLowLevelTools })),
  });
  const detachToolList = [
    packs.onChange(() => toolList.poke()),
    projects.onChange(() => toolList.poke()),
    policy.store.onChange(() => toolList.poke()),
  ];
  // v2 E3 (ADR 0045): the tool-call log. Its budget probe sums every project's hourly request and write counters, so a
  // call's budget use is how far they moved while it ran (approximate: another call in the same moment counts too).
  const toolCalls = new ToolCallLog({
    db: o.db,
    settings: policy.store,
    budget: () => {
      let requests = 0;
      let writes = 0;
      for (const p of projects.list()) {
        if (p.id === null) continue;
        const tiers = projects.anyClient(p.id)?.governor.snapshot().tiers;
        if (!tiers) continue;
        requests += tiers['key-hour'].used;
        writes += tiers['write-hour'].used;
      }
      return { requests, writes };
    },
    ...(o.clock ? { now: () => o.clock!.now() } : {}),
    warn: (message, err) => log.warn({ err }, message),
  });
  const evaluation = new Evaluation({
    db: o.db,
    log: toolCalls,
    store: policy.store,
    version: o.version,
    ...(o.clock ? { now: () => o.clock!.now() } : {}),
  });
  // Each project's key is checked now; a project is served from the moment its check passes.
  const ready = projects.verifyAll().catch((err: unknown) => log.error({ err }, 'project checks failed'));
  // v2 E1a: a full snapshot a restart interrupted continues once the projects are served.
  void ready.then(() => snapshots.resumeInterrupted());
  // v3 F3a: a pack attaches to its projects once their keys have proved which projects they are.
  void ready.then(() => {
    try {
      packs.ensureSeeded();
    } catch (err) {
      log.warn({ err }, 'the setting packs could not be seeded');
    }
  });

  /** CR-2026-11-R3 (fix A): set when a stop for a restart begins. */
  let restarting = false;
  return {
    projects,
    secrets,
    selector,
    ready,
    engine,
    policy,
    toolCalls,
    evaluation,
    maintenance,
    mappings,
    tree,
    registry,
    assets,
    lifecycle,
    chronology,
    images,
    snapshots,
    audits,
    appraisal,
    consistency,
    restores,
    rehearsals,
    offsite,
    packs,
    review,
    reverts,
    resume,
    renames,
    splits,
    retag,
    tools,
    toolList,
    resources: guideResources(),
    instructions: BRIDGE_INSTRUCTIONS,
    config,
    envConfig,
    get restarting() {
      return restarting;
    },
    async stopForRestart(o: RestartStopOptions = {}): Promise<RestartStopReport> {
      const started = Date.now();
      const overran: string[] = [];
      const bounded = async (label: string, p: Promise<unknown>, ms: number): Promise<void> => {
        if (!(await within(p, ms))) overran.push(label);
      };
      restarting = true;
      // 1. Nothing new is accepted (the HTTP layer answers BRIDGE_RESTARTING; the engine refuses submissions); every
      //    job stops at its next step boundary; every lock, slot, governor and budget wait ends at once.
      const parking = engine.stopForRestart(o.graceMs ?? 10_000);
      projects.stopWaits();
      // 2. Background work stops alongside: a build resumes at the next start; a sweep or check in flight ends as
      //    interrupted. The trees keep following writes while jobs reach their boundary.
      const background = (async () => {
        await Promise.allSettled([tree.stopPasses(), assets.stopPasses()]);
        lifecycle.stop();
        chronology.stop();
        snapshots.stop();
        images.stop();
        await maintenance.stop(o.backgroundMs ?? 10_000);
      })();
      const { parked, stillRunning } = await parking;
      await bounded(
        'background work',
        background,
        Math.max(0, (o.backgroundMs ?? 10_000) - (Date.now() - started)),
      );
      // 3. The rest of the shutdown, each part bounded.
      await windDown({ engineStopMs: o.engineStopMs ?? 1_000, treesMs: o.treesMs ?? 2_000, bounded });
      return {
        ms: Date.now() - started,
        parked,
        stillRunning,
        overran,
      };
    },
    async shutdown(drainTimeoutMs = 20_000) {
      // A build resumes at the next start; a sweep or check in flight ends as interrupted. Writes are still followed
      // while the engine drains, so their re-reads are made (or owed) before the tree stops.
      await tree.stopPasses();
      await assets.stopPasses();
      lifecycle.stop(); // a link sweep in flight stops, to be continued by the next run
      chronology.stop(); // a chronology check in flight stops (the next run starts again)
      snapshots.stop(); // a full snapshot in flight stops after its current read (it continues at the next start)
      await maintenance.stop(); // stops cleanly, before the engine and database wind down
      images.stop();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        engine.controls.drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      await windDown({});
    },
  };

  /** The end of every shutdown: hooks detached, the engine stopped, the trees stopped, the governors closed. */
  async function windDown(w: {
    readonly engineStopMs?: number;
    readonly treesMs?: number;
    readonly bounded?: (label: string, p: Promise<unknown>, ms: number) => Promise<void>;
  }): Promise<void> {
    const run = (label: string, p: Promise<unknown>, ms: number | undefined) =>
      ms === undefined || !w.bounded ? p : w.bounded(label, p, ms);
    detachPolicy();
    await run(
      'the engine',
      engine.stop(w.engineStopMs),
      w.engineStopMs === undefined ? undefined : w.engineStopMs + 500,
    );
    unregisterPlanner();
    unregisterGuard();
    unregisterLmr();
    detachLifecycle();
    detachChronology();
    for (const off of detachMaps) off();
    for (const off of detachSnapshotCheckers) off();
    for (const off of detachAuditCheckers) off();
    detachBlockIds();
    clearInterval(memoryTimer);
    detachBlockwiseUndo();
    detachReverts();
    detachResume();
    detachRenames();
    unregisterRenameChecks();
    detachSplits();
    unregisterSplitChecks();
    unregisterContinueGuard();
    unregisterRouteBack();
    for (const f of unmarkRelock) f();
    detachRetag();
    unregisterRetagChecks();
    detachReview();
    detachRestores();
    unregisterPackEngine();
    detachPackTools();
    for (const off of detachToolList) off();
    await run('the repository tree', tree.stop(), w.treesMs);
    detachRegistry();
    await run('the asset tree', assets.stop(), w.treesMs);
    projects.close(); // every governor saves its counts
    guard?.release();
  }
}

/** CR-2026-11-R3 (fix A): true when `p` settled within `ms` (real time), false when the time ran out first. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
  return done;
}
