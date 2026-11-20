import type { IncomingMessage } from 'node:http';
import { type NodeIncomingMessageLike, toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BearerGuard } from '../auth/bearer.js';
import type { AuthEventLogger } from '../auth/events.js';
import type { AuthConfig } from '../config/auth.js';
import {
  type McpAccessControl,
  type McpServerInfo,
  type McpResourceProvider,
  type McpToolCallObserver,
  type McpToolProvider,
  createMcpServerFactory,
} from './server.js';

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

/** The MCP SDK's own default request body limit, kept as the floor. */
export const MCP_DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Chunk 8 (F-05): the request body limit at `/mcp`, sized so that `lk_upload_image` can receive an image of
 * `uploadMaxBytes` as base64 (4 characters per 3 bytes) inside its JSON-RPC envelope (256 KiB of headroom). Never below
 * the SDK's 4 MiB. Fastify's own `bodyLimit` does not apply here: the body is left unread for the SDK, which enforces
 * this limit (413) only after the bearer token has been checked.
 */
export function mcpMaxBodyBytes(uploadMaxBytes: number): number {
  return Math.max(MCP_DEFAULT_MAX_BODY_BYTES, Math.ceil(uploadMaxBytes / 3) * 4 + 256 * 1024);
}

export interface McpTransportOptions {
  readonly config: AuthConfig;
  readonly bearer: BearerGuard;
  readonly event: AuthEventLogger;
  readonly serverInfo: McpServerInfo;
  readonly tools: readonly McpToolProvider[];
  /** v2 B2: documents published as MCP resources (the guides). */
  readonly resources?: readonly McpResourceProvider[];
  /** Per-principal tool lists and the principal in each tool's context (src/policy). */
  readonly access?: McpAccessControl;
  /** v2 E3 (ADR 0045): the tool-call log, which records each call (names and sizes only). */
  readonly observer?: McpToolCallObserver;
  /** Largest request body accepted (default: the SDK's 4 MiB). See {@link mcpMaxBodyBytes}. */
  readonly maxBodyBytes?: number;
  /**
   * Told when what any session would list changes (a pack approved, a profile's scope changed): every connected session
   * listening for it gets `notifications/tools/list_changed` and asks for its list again (src/mcp/tool-list.ts).
   */
  readonly toolsChanged?: { subscribe(fn: () => void): () => void };
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
  const factory = createMcpServerFactory(
    opts.serverInfo,
    opts.tools,
    app.log,
    opts.access,
    opts.resources ?? [],
    opts.observer,
  );
  const onerror = (err: Error) => app.log.warn({ err }, 'MCP transport error');
  const maxRequestBodySize = opts.maxBodyBytes ?? MCP_DEFAULT_MAX_BODY_BYTES;
  const handler = createMcpHandler(factory, { legacy: 'stateless', onerror, maxRequestBodySize });
  const serve = toNodeHandler(handler, { onerror, maxRequestBodySize });
  // Every open `subscriptions/listen` stream that asked for tool-list changes is told; each list is worked out afresh
  // per request, so the session's next tools/list shows the new one.
  const offToolsChanged = opts.toolsChanged?.subscribe(() => {
    try {
      handler.notify.toolsChanged();
    } catch (err) {
      app.log.warn({ err }, 'MCP: the tool-list change could not be sent');
    }
  });
  app.addHook('onClose', async () => {
    offToolsChanged?.();
    await handler.close();
  });

  // Leave the request body unread: the SDK reads and validates it itself (JSON-RPC parse errors,
  // 415 for non-JSON, 413 over `maxRequestBodySize`), after authentication has passed.
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
