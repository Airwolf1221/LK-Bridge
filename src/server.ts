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
import { type Db, openDatabase } from './db/open.js';
import {
  type BridgeInfo,
  type McpResourceProvider,
  type McpToolProvider,
  bridgeInfoStub,
} from './mcp/server.js';
import { mcpMaxBodyBytes, mcpTransportPlugin } from './mcp/transport.js';
import { type Policy, createPolicy } from './policy/index.js';
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.js';
import type { SecretStore } from './secrets/store.js';

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
  /** The policy layer (profiles, scopes, proposals). Defaults to one on `db`, without a job engine attached. */
  readonly policy?: Policy;
  /** OPS2: the encrypted secret store (the owner's credentials live there). Without it, the env file's values only. */
  readonly secrets?: SecretStore;
  /** The dashboard and its admin API (chunk 5). Without it, `/ui` and `/api/admin` do not exist. */
  readonly admin?: {
    readonly runtime: AdminRuntime;
    readonly settings?: AdminSettings;
    /** Where the built dashboard is (default: `ui/dist` next to `src` or `dist`). */
    readonly uiDir?: string;
    readonly version?: string;
  };
}

/** `ui/dist`, whether running from `src/` (tsx) or `dist/` (built): both sit next to `ui/`. */
const DEFAULT_UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist');

function withPolicyTools(
  tools: readonly McpToolProvider[],
  extra: readonly McpToolProvider[],
): McpToolProvider[] {
  const have = new Set(tools.map((t) => t.name));
  return [...tools, ...extra.filter((t) => !have.has(t.name))];
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

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).type('application/json; charset=utf-8').send({ error: 'not_found' }),
  );

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
  /** Test seams, passed to `createRuntime`. */
  readonly clock?: RuntimeOptions['clock'];
  readonly lkTransport?: RuntimeOptions['lkTransport'];
  readonly uploadGuard?: RuntimeOptions['uploadGuard'];
  readonly projectRetryMs?: RuntimeOptions['projectRetryMs'];
  /**
   * Wait until every project's key has been checked before returning (default true: tests and the e2e server then
   * start with their projects served). `main` does not wait: the bridge listens at once and serves each project
   * from the moment its own check passes.
   */
  readonly awaitProjects?: boolean;
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
    ...(o.uploadGuard ? { uploadGuard: o.uploadGuard } : {}),
    ...(o.projectRetryMs ? { projectRetryMs: o.projectRetryMs } : {}),
    // The runtime logs (project checks, start-up warnings) go where the server's do.
    ...(o.logLevel ? { logLevel: o.logLevel } : {}),
    ...(o.logStream ? { logStream: o.logStream } : {}),
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
    secrets: runtime.secrets,
    admin: {
      runtime,
      ...(o.adminSettings ? { settings: o.adminSettings } : {}),
      ...(o.uiDir ? { uiDir: o.uiDir } : {}),
      version: o.version ?? BRIDGE_VERSION,
    },
  });
  return { app, services, runtime };
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
  try {
    // v2 A1: migration 0600 assigns rows written before multi-project support to the single-project form's project.
    // (LK_PROJECT_ID and LK_PROJECT_NAME, the same values `npm run db:migrate` and deploy.sh use; not secrets.)
    runMigrations(db, defaultMigrationsDir(), { context: migrationContextFromEnv(process.env) });
    // Project registry and one governor per project, policy layer, job engine (its startup recovery runs here, before
    // /mcp accepts anything) and tools, in dependency order; then the HTTP server with the same policy layer. Each
    // project's key is checked in the background; a project is served once its check passes.
    created = await createBridge({
      config,
      authConfig,
      toolsSettings,
      policySettings,
      adminSettings,
      maintenanceSettings,
      db,
      awaitProjects: false,
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
  // SIGTERM: stop new work and let running jobs finish (drain), then stop HTTP, then close the database.
  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    runtime
      .shutdown()
      .then(() => app.close())
      .then(() => db.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
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
