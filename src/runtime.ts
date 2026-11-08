import { pino } from 'pino';
import { applyStoredSettings, startInterimBudgetSampler } from './admin/index.js';
import {
  defaultAdminSettings,
  defaultPolicySettings,
  jobsSettingsFrom,
  lkSettingsFrom,
  type AdminSettings,
  type Config,
  type PolicySettings,
  type ToolsSettings,
} from './config/index.js';
import type { Db } from './db/open.js';
import { createJobEngine, UPLOAD_PUT_STEP, type JobEngine } from './jobs/index.js';
import { createLkClient, defaultTransport, type Clock, type LkClient, type Transport } from './lk/index.js';
import type { McpToolProvider } from './mcp/server.js';
import {
  BRIDGE_INSTRUCTIONS,
  createBridgeTools,
  createUploadPutHandler,
  createUploadTransport,
} from './mcp/tools/index.js';
import type { GuardOptions } from './mcp/tools/upload-http.js';
import { createPolicy, proposalTools, type Policy } from './policy/index.js';

/**
 * The bridge's working parts, in the order they depend on each other: governor-backed LK client, then the job
 * engine on the migrated database (its restart-resume runs inside `createRuntime`, before the caller opens the
 * MCP endpoint), then the MCP tools. `src/server.ts` builds the HTTP side around it. The policy layer (chunk 2b) is
 * built first: its live gate and proposal sink go into the engine, and it is attached once the engine has started.
 */
export interface Runtime {
  readonly lk: LkClient;
  readonly engine: JobEngine;
  /** Profiles, the live policy gate, proposals and owner commands; pass it to `buildServer({ policy })`. */
  readonly policy: Policy;
  readonly tools: readonly McpToolProvider[];
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
  /** Test seams. */
  readonly clock?: Clock;
  readonly lkTransport?: Transport;
  readonly uploadGuard?: GuardOptions;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  // Chunk 5: settings the owner saved in the dashboard (tool exposure, member admin, journal retention, tier limits,
  // reserve floors) are applied here, on top of the environment. `envConfig` is kept for "reset to default".
  const envConfig = o.config;
  const config = applyStoredSettings(envConfig, o.db);
  const log = pino({ level: config.logLevel, base: { component: 'engine' } });
  // Signed upload URLs are on another host: the transport sends LegendKeeper's host through the platform fetch
  // and every other host through the SSRF guard. Both stay under the governor.
  const transport = createUploadTransport({
    lkOrigin: new URL(config.lk.baseUrl).origin,
    lk: o.lkTransport ?? defaultTransport,
    ...(o.uploadGuard ?? {}),
  });
  const lk = createLkClient({
    ...lkSettingsFrom(config),
    transport,
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const policy = createPolicy({
    db: o.db,
    settings: o.policySettings ?? defaultPolicySettings(),
    allowMemberAdmin: config.lk.allowMemberAdmin,
    log,
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const engine = createJobEngine({
    db: o.db,
    lk,
    settings: jobsSettingsFrom(config),
    log,
    policyGate: policy.gate,
    proposalSink: policy.proposals,
    ...(o.clock ? { clock: o.clock } : {}),
    customSteps: {
      [UPLOAD_PUT_STEP]: createUploadPutHandler({
        putTimeoutMs: o.toolsSettings.upload.putTimeoutMs,
        ...(o.uploadGuard ? { guard: o.uploadGuard } : {}),
      }),
    },
    autoStart: false,
  });
  engine.start(); // restart-resume: jobs left running by a crash are verified and continued
  // Follows approved proposals' jobs, reconciles proposals left mid-approval by a crash, runs the expiry sweep.
  const detachPolicy = policy.attach(engine);

  // INTERIM (chunk 5): store a budget sample every 10 s for the sparklines. Chunk 6's `budget-sampler` job replaces it.
  const stopSampler = startInterimBudgetSampler(
    engine,
    lk,
    (o.adminSettings ?? defaultAdminSettings()).budgetSampleMs,
    (err) => log.warn({ err }, 'budget sample failed'),
  );

  const bridgeTools = createBridgeTools(
    {
      engine,
      lk,
      settings: o.toolsSettings,
      version: o.version,
      projectId: config.lk.projectId,
      configuredReadOnly: config.lk.readOnly,
      uploadGuard: o.uploadGuard,
    },
    { exposePerOpTools: config.mcp.exposePerOpTools },
  );
  // The agent-facing proposal tools (read-only, own proposals only), with the budget footer like every tool.
  const tools = [...bridgeTools, ...proposalTools(policy.proposals, () => lk.budgetFooter())];

  return {
    lk,
    engine,
    policy,
    tools,
    instructions: BRIDGE_INSTRUCTIONS,
    config,
    envConfig,
    async shutdown(drainTimeoutMs = 20_000) {
      stopSampler(); // stops cleanly, before the engine and database wind down
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
      lk.governor.close();
    },
  };
}
