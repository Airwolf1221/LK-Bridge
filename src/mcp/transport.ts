import type { IncomingMessage } from 'node:http';
import { type NodeIncomingMessageLike, toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BearerGuard } from '../auth/bearer.js';
import type { AuthEventLogger } from '../auth/events.js';
import type { AuthConfig } from '../config/auth.js';
import { type McpServerInfo, type McpToolProvider, createMcpServerFactory } from './server.js';

/**
 * Streamable HTTP transport at `/mcp` (MCP 2025-era stateless serving, and the 2026-07-28
 * per-request protocol, through the SDK's `createMcpHandler`).
 *
 * Order of checks on every request, before the SDK sees it:
 *  1. `Origin`, when present, must be this bridge, an allowed Claude origin or loopback (DNS
 *     rebinding protection, MCP transport spec). Otherwise `403`.
 *  2. A valid bearer token (OAuth access token or PAT) in the `Authorization` header. Otherwise
 *     `401` with `WWW-Authenticate: Bearer resource_metadata=...` (or `403 insufficient_scope`).
 * The endpoint never redirects: the SDK answers with 200/202/4xx only.
 */

export const MCP_PATH = '/mcp';

export interface McpTransportOptions {
  readonly config: AuthConfig;
  readonly bearer: BearerGuard;
  readonly event: AuthEventLogger;
  readonly serverInfo: McpServerInfo;
  readonly tools: readonly McpToolProvider[];
}

const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function originAllowed(origin: string | undefined, config: AuthConfig): boolean {
  if (origin === undefined) return true; // non-browser clients (Claude's servers, Claude Code) send none
  return (
    origin === config.publicUrl || config.mcpAllowedOrigins.includes(origin) || LOOPBACK_ORIGIN.test(origin)
  );
}

export function mcpTransportPlugin(app: FastifyInstance, opts: McpTransportOptions): Promise<void> {
  const { config, bearer, event } = opts;
  const factory = createMcpServerFactory(opts.serverInfo, opts.tools, app.log);
  const onerror = (err: Error) => app.log.warn({ err }, 'MCP transport error');
  const handler = createMcpHandler(factory, { legacy: 'stateless', onerror });
  const serve = toNodeHandler(handler, { onerror });
  app.addHook('onClose', async () => {
    await handler.close();
  });

  // Leave the request body unread: the SDK reads and validates it itself (JSON-RPC parse errors,
  // 415 for non-JSON, 413 over 4 MiB), after authentication has passed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => {
    done(null, undefined);
  });

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!originAllowed(req.headers.origin, config)) {
      event('mcp.rejected', { status: 403, reason: 'origin', ip: req.ip }, 'warn');
      return reply
        .code(403)
        .type('application/json')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null });
    }
    const result = await bearer.authenticate(req.headers.authorization);
    if (!result.ok) {
      event('mcp.rejected', { status: result.status, reason: result.body.error, ip: req.ip }, 'warn');
      return reply
        .code(result.status)
        .header('www-authenticate', result.wwwAuthenticate)
        .header('cache-control', 'no-store')
        .type('application/json')
        .send(result.body);
    }
    const { caller } = result;
    const authInfo: AuthInfo = {
      // Tools never need the raw credential; keep it out of tool code and anything it logs.
      token: '[redacted]',
      clientId: caller.clientId,
      scopes: [...caller.scopes],
      ...(caller.expiresAt !== undefined ? { expiresAt: caller.expiresAt } : {}),
      resource: new URL(config.mcpUrl),
      resourceMetadataUrl: config.resourceMetadataUrl,
      extra: { caller },
    };
    reply.hijack();
    const raw = req.raw as IncomingMessage & { auth?: AuthInfo };
    raw.auth = authInfo;
    // IncomingMessage satisfies the adapter's duck type at runtime; only optional-property typing differs.
    await serve(raw as unknown as NodeIncomingMessageLike, reply.raw);
  };

  app.route({ method: ['GET', 'POST', 'DELETE'], url: MCP_PATH, handler: handle });
  return Promise.resolve();
}
