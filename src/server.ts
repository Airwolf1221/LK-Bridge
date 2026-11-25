import { uploadsPlugin } from './images/http.js';
import type { ImageService } from './images/service.js';
import { createRequire } from 'node:module';
import type { Writable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { adminPlugin, type AdminRuntime } from './admin/index.js';
import { authPlugin } from './auth/plugin.js';
import { type AuthServices, type CreateAuthServicesOptions, createAuthServices } from './auth/services.js';
import { type AuthConfig, AuthConfigError, loadAuthConfig } from './config/auth.js';
import {
  AdminConfigError,
  MaintenanceConfigError,
  type AdminSettings,
  type Config,
  ConfigError,
  defaultAdminSettings,
  loadAdminConfig,
  loadMaintenanceConfig,
  loadConfig,
  loadPolicyConfig,
  loadToolsConfig,
  PolicyConfigError,
  type ToolsSettings,
} from './config/index.js';
import {
  MigrationError,
  defaultMigrationsDir,
  migrationContextFromEnv,
  runMigrations,
} from './db/migrate.js';
import { InstanceLockError } from './projects/index.js';
import { RESTART_EXIT_CODE } from './admin/restart.js';
import { loadEffectiveConfiguration } from './config/effective.js';
import { type Db, openDatabase } from './db/open.js';
import {
  type BridgeInfo,
  type McpResourceProvider,
  type McpToolCallObserver,
  type McpToolProvider,
  bridgeInfoStub,
} from './mcp/server.js';
import { mcpMaxBodyBytes, mcpTransportPlugin } from './mcp/transport.js';
import { type Policy, createPolicy } from './policy/index.js';
import {
  createRuntime,
  type RestartStopOptions,
  type RestartStopReport,
  type Runtime,
  type RuntimeOptions,
} from './runtime.js';
import type { SecretStore } from './secrets/store.js';
import { processActivities } from './observability/watchdog.js';

/**
 * Composition root. Chunk 4 wires the authorization server and the MCP transport; later chunks
 * add their plugins here (admin API and UI in chunk 5) and pass their tools in `tools` (chunk 3).
 */

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
export const BRIDGE_VERSION = pkg.version;

export interface BuildServerOptions {
  readonly authConfig: AuthConfig;
  readonly db: Db;
  readonly logLevel?: string;
  /** Log destination (defaults to stdout). Tests capture it to check that no secret is logged. */
  readonly logStream?: Writable;
  /** MCP tools. Defaults to the `bridge_info` stub. */
  readonly tools?: readonly McpToolProvider[];
  readonly bridgeInfo?: () => BridgeInfo;
  /** v2 B2: documents published as MCP resources (the guides). */
  readonly resources?: readonly McpResourceProvider[];
  /** MCP server `instructions` shown to connecting agents. */
  readonly instructions?: string;
  /** Largest `/mcp` request body (chunk 8, F-05). Defaults to the SDK's 4 MiB; `createBridge` sizes it for uploads. */
  readonly mcpMaxBodyBytes?: number;
  /** Overrides `TRUST_PROXY` (tests only). */
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  /** Test seams for the auth services (clock, CIMD fetcher, rate limits). */
  readonly authOverrides?: Omit<Partial<CreateAuthServicesOptions>, 'config' | 'db' | 'log'>;
  readonly pruneIntervalMs?: number;
  /** v2 E3 (ADR 0045): the tool-call log; the transport records each tool call in it. */
  readonly toolCalls?: McpToolCallObserver;
  /** Tells connected MCP sessions when what is listed changes (the runtime's `toolList`). */
  readonly toolsChanged?: { subscribe(fn: () => void): () => void };
  /** The policy layer (profiles, scopes, proposals). Defaults to one on `db`, without a job engine attached. */
  readonly policy?: Policy;
  /** OPS2: the encrypted secret store (the owner's credentials live there). Without it, the env file's values only. */
  readonly secrets?: SecretStore;
  /** v2 D3 (ADR 0041): the image pipeline; with it, the binary endpoint `POST /uploads/<upload_id>` exists. */
  readonly images?: ImageService;
  /**
   * CR-2026-11-R3 (fix A): true while the bridge stops for a restart. Every new request is then answered 503
   * `BRIDGE_RESTARTING` (MCP calls as a JSON-RPC error), with `Retry-After`; requests already under way finish.
   */
  readonly restarting?: () => boolean;
  /** The dashboard and its admin API (chunk 5). Without it, `/ui` and `/api/admin` do not exist. */
  readonly admin?: {
    readonly runtime: AdminRuntime;
    readonly settings?: AdminSettings;
    /** Where the built dashboard is (default: `ui/dist` next to `src` or `dist`). */
    readonly uiDir?: string;
    readonly version?: string;
  };
}

/** CR-2026-11-R3 (fix A): what every request is told while the bridge stops for a restart. */
export const RESTARTING_MESSAGE =
  'The bridge is restarting (a deploy or a stop) and takes no new requests until it is back, in about a minute. ' +
  'Nothing was done with this request: make it again then. Work already accepted (jobs, proposals) is kept and ' +
  'continues by itself.';
const RESTART_RETRY_AFTER_S = 30;

/** `ui/dist`, whether running from `src/` (tsx) or `dist/` (built): both sit next to `ui/`. */
const DEFAULT_UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist');

function withPolicyTools(
  tools: readonly McpToolProvider[],
  extra: readonly McpToolProvider[],
): McpToolProvider[] {
  const have = new Set(tools.map((t) => t.name));
  const missing = extra.filter((t) => !have.has(t.name));
  // v3 F3a (ADR 0050): the runtime's own list (which has them) is kept as it is, so the pack tools it adds later show.
  return missing.length === 0 ? (tools as McpToolProvider[]) : [...tools, ...missing];
}

/**
 * v3 F6a.1 (ADR 0061 amendment 1): a tool call registers with the process's activities while it runs (the watchdog's
 * "request still running" names the tool) and is logged at debug when it starts (its name only, never its arguments).
 */
export function activityObserver(
  inner: McpToolCallObserver | undefined,
  log: { debug(obj: Record<string, unknown>, msg: string): void },
): McpToolCallObserver {
  return {
    begin(tool, args, caller) {
      log.debug({ tool }, 'tool call started');
      const done = processActivities.begin('tool', `tool ${tool}`, { method: 'POST', url: '/mcp', tool });
      let record: ReturnType<McpToolCallObserver['begin']> | null = null;
      try {
        record = inner ? inner.begin(tool, args, caller) : null;
      } catch (err) {
        done();
        throw err;
      }
      return (end) => {
        done();
        record?.(end);
      };
    },
  };
}

/** Strips query strings from logged URLs: no code, state or stray token ever reaches the log. */
function pathOnly(url: string): string {
  return url.split('?')[0] ?? '';
}

/**
 * Chunk 8 (F-09): Fastify logged "incoming request" and "request completed" at info for every request, and "Route …
 * not found" (with the query string) for every internet scanner's probe of /info.php, /actuator/env, WordPress paths
 * and so on. Now: one compact line per matched request at info (method, path without query, status, time, address),
 * unmatched paths at debug only, never a header or a body. Errors keep Fastify's own handling and levels, and auth
 * events (src/auth/events.ts) are logged separately at theirs.
 */
class CompactRequestLog extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, req: FastifyRequest, reply: FastifyReply): void {
    const line = {
      method: req.method,
      url: pathOnly(req.url),
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      ip: req.ip,
    };
    if (error) req.log.error({ ...line, err: error }, 'request errored');
    else if (req.routeOptions.url === undefined && reply.statusCode === 404)
      req.log.debug(line, 'no such route');
    else req.log.info(line, 'request completed');
  }

  override routeNotFound(req: FastifyRequest): void {
    req.log.debug({ method: req.method, url: pathOnly(req.url) }, 'no such route');
  }
}

export async function buildServer(
  o: BuildServerOptions,
): Promise<{ app: FastifyInstance; services: AuthServices; policy: Policy }> {
  const app = Fastify({
    logger: {
      level: o.logLevel ?? 'info',
      ...(o.logStream ? { stream: o.logStream } : {}),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'headers.authorization',
          'headers.cookie',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: pathOnly(req.url),
          remoteAddress: req.ip,
        }),
      },
    },
    // TRUST_PROXY (default loopback: Caddy on the same host). `request.ip` is then the client
    // address from X-Forwarded-For, taken from the right, skipping only trusted proxies.
    trustProxy: o.trustProxy ?? (o.authConfig.trustProxy === false ? false : [...o.authConfig.trustProxy]),
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
    // Chunk 8 (F-09): one compact line per request instead of Fastify's two, and scanner probes at debug only.
    logController: new CompactRequestLog(),
  });

  // v3 F6a.1 (ADR 0061 amendment 1): every request is registered while it runs, so the watchdog can say what is still
  // running (src/observability/watchdog.ts: method and path only, never a query string, header or body). MCP requests
  // are registered per tool call instead (`activityObserver`), with the tool's name. A dashboard action (a POST, PUT or
  // DELETE under /api/admin) is also logged when it starts, at debug: the journal logs a request when it completes.
  const activityEnds = new WeakMap<FastifyRequest, () => void>();
  const endActivity = (req: FastifyRequest) => {
    activityEnds.get(req)?.();
    activityEnds.delete(req);
  };
  app.addHook('onRequest', (req, _reply, done) => {
    const url = pathOnly(req.url);
    if (url !== '/mcp' && !url.startsWith('/mcp/'))
      activityEnds.set(
        req,
        processActivities.begin('request', `${req.method} ${url}`, { method: req.method, url }),
      );
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.startsWith('/api/admin/'))
      req.log.debug({ method: req.method, url }, 'request started');
    done();
  });
  app.addHook('onResponse', (req, _reply, done) => {
    endActivity(req);
    done();
  });
  app.addHook('onRequestAbort', (req, done) => {
    endActivity(req);
    done();
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).type('application/json; charset=utf-8').send({ error: 'not_found' }),
  );

  // CR-2026-11-R3 (fix A): while the bridge stops for a restart, no new request is taken. Added before every plugin, so
  // it covers them all: an agent's MCP call and a dashboard action are told plainly, with Retry-After.
  if (o.restarting) {
    const restarting = o.restarting;
    app.addHook('onRequest', (req, reply, done) => {
      if (!restarting()) {
        done();
        return;
      }
      reply
        .code(503)
        .header('retry-after', String(RESTART_RETRY_AFTER_S))
        .header('cache-control', 'no-store');
      const path = pathOnly(req.url);
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        void reply.type('application/json; charset=utf-8').send({
          jsonrpc: '2.0',
          error: { code: -32000, message: RESTARTING_MESSAGE, data: { code: 'BRIDGE_RESTARTING' } },
          id: null,
        });
      } else if (path === '/healthz') {
        void reply
          .type('application/json; charset=utf-8')
          .send({ ok: false, restarting: true, version: BRIDGE_VERSION });
      } else {
        void reply
          .type('application/json; charset=utf-8')
          .send({ error: { code: 'BRIDGE_RESTARTING', message: RESTARTING_MESSAGE } });
      }
    });
  }

  const policy = o.policy ?? createPolicy({ db: o.db, allowMemberAdmin: false });
  const services = createAuthServices({
    config: o.authConfig,
    db: o.db,
    log: app.log,
    profiles: policy.consent,
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...o.authOverrides,
  });
  // OPS2: the owner's credentials imported from the env file at this start, audited by name only.
  for (const variable of services.importedCredentials) {
    policy.store.audit('system', 'owner.credential_import', variable);
  }
  await app.register(authPlugin, {
    services,
    ...(o.pruneIntervalMs !== undefined ? { pruneIntervalMs: o.pruneIntervalMs } : {}),
  });

  const bridgeInfo =
    o.bridgeInfo ?? (() => ({ version: BRIDGE_VERSION, projectId: null, readOnly: null, writersMax: null }));
  await app.register(mcpTransportPlugin, {
    config: o.authConfig,
    bearer: services.bearer,
    event: services.event,
    serverInfo: {
      name: 'lk-bridge',
      version: BRIDGE_VERSION,
      ...(o.instructions ? { instructions: o.instructions } : {}),
    },
    // The policy layer's proposal tools, unless the caller's list has them already (the runtime's does).
    tools: withPolicyTools(o.tools ?? [bridgeInfoStub(bridgeInfo)], policy.tools),
    access: policy.access,
    // v3 F6a.1: every tool call is registered (and logged at debug when it starts), whatever else observes it.
    observer: activityObserver(o.toolCalls, app.log),
    ...(o.toolsChanged ? { toolsChanged: o.toolsChanged } : {}),
    ...(o.resources ? { resources: o.resources } : {}),
    ...(o.mcpMaxBodyBytes !== undefined ? { maxBodyBytes: o.mcpMaxBodyBytes } : {}),
  });

  // Chunk 5: the owner dashboard (/ui), its admin API and the live stream (/api/admin), behind the owner session.
  if (o.admin) {
    await app.register(adminPlugin, {
      runtime: o.admin.runtime,
      services,
      settings: o.admin.settings ?? defaultAdminSettings(),
      version: o.admin.version ?? BRIDGE_VERSION,
      uiDir: o.admin.uiDir ?? DEFAULT_UI_DIR,
    });
  }

  // v2 D3 (ADR 0041): the single-use binary image endpoint, in its own scope (its own body handling).
  if (o.images) {
    await app.register(uploadsPlugin, {
      images: o.images,
      scopeOf: (principalId) => policy.gate.scopeOf(principalId),
      audit: (actor, action, target, after) => policy.store.audit(actor, action, target, undefined, after),
    });
  }

  app.get('/healthz', () => ({ ok: true, version: BRIDGE_VERSION }));
  return { app, services, policy };
}

export interface CreateBridgeOptions {
  readonly config: Config;
  readonly authConfig: AuthConfig;
  readonly toolsSettings: ToolsSettings;
  /** Opened and migrated. */
  readonly db: Db;
  readonly policySettings?: RuntimeOptions['policySettings'];
  readonly adminSettings?: AdminSettings;
  readonly maintenanceSettings?: RuntimeOptions['maintenanceSettings'];
  /** Overrides the dashboard's static directory (tests). */
  readonly uiDir?: string;
  /** Reported by bridge_info (defaults to package.json's version). */
  readonly version?: string;
  readonly logLevel?: string;
  readonly logStream?: Writable;
  readonly pruneIntervalMs?: number;
  /** v3 F6a.1: start the watchdog's thread, which still speaks while the event loop is blocked (the bridge's own start). */
  readonly watchdogThread?: boolean;
  /** Test seams, passed to `createRuntime`. */
  readonly clock?: RuntimeOptions['clock'];
  readonly lkTransport?: RuntimeOptions['lkTransport'];
  /** v2 E1b test seam: Google's endpoints and fetch for the off-site copy's sign-in. */
  readonly googleOAuth?: RuntimeOptions['googleOAuth'];
  readonly uploadGuard?: RuntimeOptions['uploadGuard'];
  readonly projectRetryMs?: RuntimeOptions['projectRetryMs'];
  /**
   * Wait until every project's key has been checked before returning (default true: tests and the e2e server then
   * start with their projects served). `main` does not wait: the bridge listens at once and serves each project
   * from the moment its own check passes.
   */
  readonly awaitProjects?: boolean;
  /**
   * v3 F8 (ADR 0073): the process environment the configuration was loaded from (default `process.env`): the Settings
   * page's "environment" column, the `now` settings, and `INVOCATION_ID` for the restart button.
   */
  readonly settingsEnv?: Readonly<Record<string, string | undefined>>;
  /** v3 F8: dashboard values `main` left out because they no longer loaded (names only). */
  readonly droppedSettings?: readonly string[];
  /** v3 F8: how "Restart the bridge" ends the process (default `process.exit`); tests pass a fake. */
  readonly exit?: (code: number) => void;
}

/**
 * The real boot path (what `main` runs): the runtime (governor, LK client, engine with the live policy gate and
 * proposal sink, tools) and the HTTP server around it, sharing ONE policy layer.
 */
export async function createBridge(
  o: CreateBridgeOptions,
): Promise<{ app: FastifyInstance; services: AuthServices; runtime: Runtime }> {
  const runtime = createRuntime({
    config: o.config,
    toolsSettings: o.toolsSettings,
    db: o.db,
    version: o.version ?? BRIDGE_VERSION,
    ...(o.policySettings ? { policySettings: o.policySettings } : {}),
    ...(o.adminSettings ? { adminSettings: o.adminSettings } : {}),
    ...(o.maintenanceSettings ? { maintenanceSettings: o.maintenanceSettings } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.lkTransport ? { lkTransport: o.lkTransport } : {}),
    ...(o.googleOAuth ? { googleOAuth: o.googleOAuth } : {}),
    ...(o.uploadGuard ? { uploadGuard: o.uploadGuard } : {}),
    ...(o.projectRetryMs ? { projectRetryMs: o.projectRetryMs } : {}),
    ...(o.settingsEnv ? { settingsEnv: o.settingsEnv } : {}),
    ...(o.droppedSettings ? { droppedSettings: o.droppedSettings } : {}),
    // The runtime logs (project checks, start-up warnings) go where the server's do.
    ...(o.logLevel ? { logLevel: o.logLevel } : {}),
    ...(o.logStream ? { logStream: o.logStream } : {}),
    ...(o.watchdogThread === true ? { watchdog: { thread: true } } : {}),
  });
  if (o.awaitProjects !== false) await runtime.ready;
  const { app, services } = await buildServer({
    authConfig: o.authConfig,
    db: o.db,
    logLevel: o.logLevel ?? o.config.logLevel,
    ...(o.logStream ? { logStream: o.logStream } : {}),
    ...(o.pruneIntervalMs !== undefined ? { pruneIntervalMs: o.pruneIntervalMs } : {}),
    tools: runtime.tools,
    resources: runtime.resources,
    instructions: runtime.instructions,
    mcpMaxBodyBytes: mcpMaxBodyBytes(o.toolsSettings.upload.maxBytes),
    policy: runtime.policy,
    toolCalls: runtime.toolCalls,
    toolsChanged: runtime.toolList,
    secrets: runtime.secrets,
    images: runtime.images,
    restarting: () => runtime.restarting,
    admin: {
      runtime,
      ...(o.adminSettings ? { settings: o.adminSettings } : {}),
      ...(o.uiDir ? { uiDir: o.uiDir } : {}),
      version: o.version ?? BRIDGE_VERSION,
    },
  });
  // v3 F8 (ADR 0073 decision 7): "Restart the bridge": the SIGTERM stop, then exit 75 for systemd to start it again.
  const exit = o.exit ?? ((code: number) => process.exit(code));
  runtime.configSettings.restart.attach(async () => {
    const watchdog = setTimeout(() => {
      app.log.error(
        { afterMs: SHUTDOWN_WATCHDOG_MS },
        'the restart’s stop did not finish in time: exiting now',
      );
      exit(RESTART_EXIT_CODE);
    }, SHUTDOWN_WATCHDOG_MS);
    watchdog.unref();
    try {
      const r = await stopBridgeForRestart({ app, runtime, db: o.db });
      app.log.info(
        {
          exitCode: RESTART_EXIT_CODE,
          ms: r.ms,
          parked: r.parked.length,
          stillRunning: r.stillRunning,
          ...(r.overran.length > 0 ? { overran: r.overran } : {}),
        },
        'restart requested by the owner: stopped, exiting for systemd to start the bridge again',
      );
    } catch (err) {
      app.log.error({ err }, 'the restart’s stop failed; exiting for systemd to start the bridge again');
      try {
        o.db.close();
      } catch {
        // already closed
      }
    }
    clearTimeout(watchdog);
    exit(RESTART_EXIT_CODE);
  });
  return { app, services, runtime };
}

/** CR-2026-11-R3 (fix A): whatever happens, the process exits this long after SIGTERM (systemd allows 75 s). */
const SHUTDOWN_WATCHDOG_MS = 25_000;

/** CR-2026-11-R3 (fix A): what a stop for a restart did, end to end (`stopBridgeForRestart`). */
export interface BridgeStopReport extends RestartStopReport {
  /** True when HTTP had to cut connections still open after its own limit. */
  readonly connectionsCut: boolean;
}

/**
 * CR-2026-11-R3 (fix A, the owner's clean shutdown): what SIGTERM runs. The runtime's bounded stop (no new work, every
 * job parked at its next step boundary, every wait ended; `Runtime.stopForRestart`), then HTTP (requests still open
 * after `httpMs` are cut), then the database. Never throws for a stage that overruns: it reports it.
 */
export async function stopBridgeForRestart(
  b: { readonly app: FastifyInstance; readonly runtime: Runtime; readonly db: Db },
  o: RestartStopOptions & { readonly httpMs?: number } = {},
): Promise<BridgeStopReport> {
  const started = Date.now();
  const report = await b.runtime.stopForRestart(o);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    b.app.close().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), o.httpMs ?? 2_000);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) b.app.server.closeAllConnections();
  b.db.close();
  return {
    ...report,
    ms: Date.now() - started,
    connectionsCut: !closed,
    overran: closed ? report.overran : [...report.overran, 'HTTP'],
  };
}

async function main(): Promise<void> {
  let config;
  let authConfig;
  let policySettings;
  let toolsSettings;
  let adminSettings;
  let maintenanceSettings;
  try {
    // Every setting is validated here, at start-up, before anything is built.
    config = loadConfig();
    authConfig = loadAuthConfig();
    policySettings = loadPolicyConfig();
    toolsSettings = loadToolsConfig();
    adminSettings = loadAdminConfig();
    maintenanceSettings = loadMaintenanceConfig();
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof AuthConfigError ||
      err instanceof PolicyConfigError ||
      err instanceof AdminConfigError ||
      err instanceof MaintenanceConfigError
    ) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const db = openDatabase(config.server.dbPath);
  let created;
  let dropped: readonly string[];
  try {
    // v2 A1: migration 0600 assigns rows written before multi-project support to the single-project form's project.
    // (LK_PROJECT_ID and LK_PROJECT_NAME, the same values `npm run db:migrate` and deploy.sh use; not secrets.)
    runMigrations(db, defaultMigrationsDir(), { context: migrationContextFromEnv(process.env) });
    // v3 F8 (ADR 0073): the Settings page's values on top of the environment (dashboard → environment → default).
    // Bootstrap settings and secrets are never stored there, so DB_PATH, the listen address and the keys are the
    // environment's alone. A stored value that no longer loads is left out (named, never its value).
    const effective = loadEffectiveConfiguration(process.env, db);
    ({ config, authConfig, policySettings, toolsSettings, adminSettings, maintenanceSettings } =
      effective.bundle);
    dropped = effective.dropped;
    if (dropped.length > 0) {
      process.stderr.write(
        `Settings saved on the dashboard were left out because they no longer load with this environment: ${dropped.join(', ')}\n`,
      );
    }
    // Project registry and one governor per project, policy layer, job engine (its startup recovery runs here, before
    // /mcp accepts anything) and tools, in dependency order; then the HTTP server with the same policy layer. Each
    // project's key is checked in the background; a project is served once its check passes.
    created = await createBridge({
      config,
      authConfig,
      toolsSettings,
      watchdogThread: true,
      policySettings,
      adminSettings,
      maintenanceSettings,
      db,
      awaitProjects: false,
      settingsEnv: process.env,
      droppedSettings: dropped,
    });
  } catch (err) {
    if (err instanceof MigrationError || err instanceof InstanceLockError) {
      process.stderr.write(`${err.message}\n`);
      db.close();
      process.exit(1);
    }
    throw err;
  }
  const { app, runtime } = created;
  // CR-2026-11-R3 (fix A): SIGTERM (a deploy, `systemctl stop`) stops the bridge for a restart, every stage bounded,
  // well inside systemd's stop timeout: no new requests (503 BRIDGE_RESTARTING), every job parked at its next step
  // boundary for the next start (requests in flight finish), every wait ended, HTTP and the database closed. A watchdog
  // makes sure of the exit whatever happens.
  let stopping = false;
  const shutdown = (signal: string) => {
    // v3 F8: a restart the owner asked for is already stopping the bridge (it exits 75 itself).
    if (stopping || runtime.restarting) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    const watchdog = setTimeout(() => {
      app.log.error(
        { signal, afterMs: SHUTDOWN_WATCHDOG_MS },
        'the stop did not finish in time: exiting now',
      );
      try {
        db.close();
      } catch {
        // already closed, or busy: the WAL is replayed at the next open
      }
      process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);
    watchdog.unref();
    stopBridgeForRestart({ app, runtime, db }).then(
      (r) => {
        app.log.info(
          {
            signal,
            ms: r.ms,
            parked: r.parked.length,
            stillRunning: r.stillRunning,
            ...(r.overran.length > 0 ? { overran: r.overran } : {}),
          },
          'stopped for a restart',
        );
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err, signal }, 'the stop failed');
        try {
          db.close();
        } catch {
          // already closed
        }
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info({ mcp: authConfig.mcpUrl }, 'LK-Bridge listening');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
