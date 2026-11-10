import { pino } from 'pino';
import type { Writable } from 'node:stream';
import { applyStoredSettings } from './admin/index.js';
import {
  defaultMaintenanceSettings,
  defaultPolicySettings,
  jobsSettingsFrom,
  type AdminSettings,
  type Config,
  type MaintenanceSettings,
  type PolicySettings,
  type ToolsSettings,
} from './config/index.js';
import type { Db } from './db/open.js';
import { createJobEngine, UPLOAD_PUT_STEP, type JobEngine } from './jobs/index.js';
import { defaultTransport, type Clock, type Transport } from './lk/index.js';
import type { McpResourceProvider, McpToolProvider } from './mcp/server.js';
import {
  BRIDGE_INSTRUCTIONS,
  createBridgeTools,
  createUploadPutHandler,
  guideResources,
  createUploadTransport,
} from './mcp/tools/index.js';
import type { GuardOptions } from './mcp/tools/upload-http.js';
import { footerFor } from './mcp/tools/shape.js';
import { createMaintenance, type Maintenance } from './maintenance/index.js';
import { createMappings, type Mappings } from './mappings/index.js';
import { createPolicy, type Policy } from './policy/index.js';
import { systemClock } from './lk/index.js';
import { createAssets, type AssetService } from './assets/index.js';
import { createTree, type TreeService } from './tree/index.js';
import { SecretStore } from './secrets/store.js';
import { createRegistry, type Registry } from './registry/index.js';
import {
  createWritePagePlanner,
  DocumentVersions,
  pageConverterContext,
  WRITE_PAGE_PLANNER,
} from './pages/index.js';
import {
  InstanceGuard,
  ProjectSelector,
  createProjectRegistry,
  type ProjectRegistry,
} from './projects/index.js';

/**
 * The bridge's working parts, in the order they depend on each other: governor-backed LK client, then the job
 * engine on the migrated database (its restart-resume runs inside `createRuntime`, before the caller opens the
 * MCP endpoint), then the MCP tools. `src/server.ts` builds the HTTP side around it. The policy layer (chunk 2b) is
 * built first: its live gate and proposal sink go into the engine, and it is attached once the engine has started.
 */
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
  readonly tools: readonly McpToolProvider[];
  /** v2 B2: the guides, published as MCP resources. */
  readonly resources: readonly McpResourceProvider[];
  readonly instructions: string;
  /** The configuration the components were built from: the environment plus the dashboard's stored settings. */
  readonly config: Config;
  /** The environment's values alone (what clearing a dashboard setting falls back to). */
  readonly envConfig: Config;
  /** Drain (bounded), stop the engine, close the governor. Does not close the database. */
  shutdown(drainTimeoutMs?: number): Promise<void>;
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
  readonly uploadGuard?: GuardOptions;
  /**
   * Claim the database for this process (ADR 0023: one bridge process per database and project). Default true; the
   * sandbox scripts, which run on a database of their own, may switch it off.
   */
  readonly instanceGuard?: boolean;
  /** Delays before a project whose key could not be checked is checked again (tests). */
  readonly projectRetryMs?: { readonly first: number; readonly max: number };
  /** The runtime's log level and destination (default: LOG_LEVEL, to stdout). `createBridge` passes the server's. */
  readonly logLevel?: string;
  readonly logStream?: Writable;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  // Chunk 5: settings the owner saved in the dashboard (tool exposure, member admin, journal retention, tier limits,
  // reserve floors) are applied here, on top of the environment. `envConfig` is kept for "reset to default".
  const envConfig = o.config;
  const config = applyStoredSettings(envConfig, o.db);
  const logOptions = { level: o.logLevel ?? config.logLevel, base: { component: 'engine' } };
  const log = o.logStream ? pino(logOptions, o.logStream) : pino(logOptions);
  // Signed upload URLs are on another host: the transport sends LegendKeeper's host through the platform fetch
  // and every other host through the SSRF guard. Both stay under the governor.
  // The SSRF guard for every non-LegendKeeper fetch of the tool layer (the signed-URL PUT and an image source URL):
  // port 443 only unless OUTBOUND_EXTRA_PORTS_ALLOWLIST lists host:port (v1.0.1). Test seams may add to it.
  const uploadGuard: GuardOptions = {
    allowedPorts: o.toolsSettings.outboundExtraPorts ?? new Set<string>(),
    ...(o.uploadGuard ?? {}),
  };
  const transport = createUploadTransport({
    lkOrigin: new URL(config.lk.baseUrl).origin,
    lk: o.lkTransport ?? defaultTransport,
    ...uploadGuard,
  });
  for (const w of config.warnings) log.warn({}, w);
  // ADR 0023: exactly one bridge process serves a database (and so its projects). Refuses a second one.
  const guard = o.instanceGuard === false ? null : new InstanceGuard({ db: o.db });
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
  if (storeState.problem) log.warn({ keyId: storeState.keyId }, storeState.problem);
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
    customSteps: {
      [UPLOAD_PUT_STEP]: createUploadPutHandler({
        putTimeoutMs: o.toolsSettings.upload.putTimeoutMs,
        guard: uploadGuard,
      }),
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
    log: { warn: (obj, msg) => log.warn(obj, msg) },
    tree,
    assets,
  });
  maintenance.start();
  const mappings = createMappings({
    db: o.db,
    engine,
    policyStore: policy.store,
    now: () => (o.clock ?? systemClock).now(),
  });

  const bridgeTools = createBridgeTools(
    {
      engine,
      projects,
      selector,
      settings: o.toolsSettings,
      version: o.version,
      principalNames: (ids) => policy.store.describePrincipals(ids),
      configuredReadOnly: config.lk.readOnly,
      uploadGuard,
      services: { tree, registry, assets, versions },
    },
    { exposePerOpTools: config.mcp.exposePerOpTools },
  );
  // The agent-facing proposal tools (read-only, own proposals only, per project), with the budget footer like every
  // tool.
  const tools = [...bridgeTools, ...policy.tools];
  // Each project's key is checked now; a project is served from the moment its check passes.
  const ready = projects.verifyAll().catch((err: unknown) => log.error({ err }, 'project checks failed'));

  return {
    projects,
    secrets,
    selector,
    ready,
    engine,
    policy,
    maintenance,
    mappings,
    tree,
    registry,
    assets,
    tools,
    resources: guideResources(),
    instructions: BRIDGE_INSTRUCTIONS,
    config,
    envConfig,
    async shutdown(drainTimeoutMs = 20_000) {
      // A build resumes at the next start; a sweep or check in flight ends as interrupted. Writes are still followed
      // while the engine drains, so their re-reads are made (or owed) before the tree stops.
      await tree.stopPasses();
      await assets.stopPasses();
      await maintenance.stop(); // stops cleanly, before the engine and database wind down
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        engine.controls.drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      detachPolicy();
      await engine.stop();
      unregisterPlanner();
      await tree.stop();
      detachRegistry();
      await assets.stop();
      projects.close(); // every governor saves its counts
      guard?.release();
    },
  };
}
