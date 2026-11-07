import { createRequire } from 'node:module';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { authPlugin } from './auth/plugin.js';
import { type AuthServices, type CreateAuthServicesOptions, createAuthServices } from './auth/services.js';
import { type AuthConfig, AuthConfigError, loadAuthConfig } from './config/auth.js';
import { ConfigError, loadConfig } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { type Db, openDatabase } from './db/open.js';
import { type BridgeInfo, type McpToolProvider, bridgeInfoStub } from './mcp/server.js';
import { mcpTransportPlugin } from './mcp/transport.js';
import { type Policy, createPolicy } from './policy/index.js';

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
  /** Overrides `TRUST_PROXY` (tests only). */
  readonly trustProxy?: FastifyServerOptions['trustProxy'];
  /** Test seams for the auth services (clock, CIMD fetcher, rate limits). */
  readonly authOverrides?: Omit<Partial<CreateAuthServicesOptions>, 'config' | 'db' | 'log'>;
  readonly pruneIntervalMs?: number;
  /** The policy layer (profiles, scopes, proposals). Defaults to one on `db`, without a job engine attached. */
  readonly policy?: Policy;
}

/** Strips query strings from logged URLs: no code, state or stray token ever reaches the log. */
function pathOnly(url: string): string {
  return url.split('?')[0] ?? '';
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
  });

  const policy = o.policy ?? createPolicy({ db: o.db, allowMemberAdmin: false });
  const services = createAuthServices({
    config: o.authConfig,
    db: o.db,
    log: app.log,
    profiles: policy.consent,
    ...o.authOverrides,
  });
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
    serverInfo: { name: 'lk-bridge', version: BRIDGE_VERSION },
    tools: [...(o.tools ?? [bridgeInfoStub(bridgeInfo)]), ...policy.tools],
    access: policy.access,
  });

  app.get('/healthz', () => ({ ok: true, version: BRIDGE_VERSION }));
  return { app, services, policy };
}

async function main(): Promise<void> {
  let config;
  let authConfig;
  try {
    config = loadConfig();
    authConfig = loadAuthConfig();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof AuthConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const db = openDatabase(config.server.dbPath);
  runMigrations(db);
  const { app } = await buildServer({
    authConfig,
    db,
    logLevel: config.logLevel,
    bridgeInfo: () => ({
      version: BRIDGE_VERSION,
      projectId: config.lk.projectId,
      readOnly: config.lk.readOnly,
      writersMax: config.writers.max,
    }),
  });
  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
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
