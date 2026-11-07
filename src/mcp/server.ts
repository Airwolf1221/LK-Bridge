import { McpServer, type CallToolResult, type McpServerFactory } from '@modelcontextprotocol/server';
import type { FastifyBaseLogger } from 'fastify';
import * as z from 'zod';
import type { CallerIdentity } from '../auth/bearer.js';
import type { Principal } from '../jobs/types.js';

/**
 * The tool-registration seam (requirement 14).
 *
 * Chunk 3 supplies its tools as {@link McpToolProvider}s and passes them to the transport (via
 * `buildServer({ tools })` in `src/server.ts`). Nothing in `src/auth` or `src/mcp/transport.ts`
 * needs to change to add, remove or replace tools.
 */

export type McpToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export interface McpToolContext {
  /** Who is calling: the OAuth client or personal access token that authenticated the request. */
  readonly caller: CallerIdentity | undefined;
  /** Aborted when the client cancels the request or disconnects. */
  readonly signal: AbortSignal;
  readonly log: FastifyBaseLogger;
  /**
   * Who the call acts for, resolved from the server-issued token (never from `clientInfo` or a client name). Pass
   * it as `origin.principal` to the job engine. Undefined only when no policy layer is wired.
   */
  readonly principal?: Principal;
  /** The principal's scope, read live for this request. */
  readonly scope?: string;
}

/** Whether a tool only reads (`read`) or may write (`write`). Tools without it count as `write` unless read-only. */
export type ToolAccess = 'read' | 'write';

export function toolAccess(tool: Pick<McpToolProvider, 'access' | 'annotations'>): ToolAccess {
  return tool.access ?? (tool.annotations?.readOnlyHint === true ? 'read' : 'write');
}

/** `read` scope sees read tools only; `propose` and `write` see every tool (for `propose`, writes become proposals). */
export function toolVisible(access: ToolAccess, scope: string | undefined): boolean {
  return access === 'read' || scope === 'propose' || scope === 'write';
}

/** The policy layer's view of a request (src/policy/mcp.ts implements it). */
export interface McpAccessControl {
  /** The caller's principal and live scope, or undefined when the bridge does not know it. */
  resolve(
    caller: CallerIdentity | undefined,
  ): { readonly principal: Principal; readonly scope: string } | undefined;
}

/**
 * MCP tool annotations (hints for the client, not guarantees). Claude and ChatGPT use them to
 * decide what to auto-approve: set `readOnlyHint: true` on tools that never write, and leave
 * writes `readOnlyHint: false` with an honest `destructiveHint`, so users keep confirmations on
 * them (PLAN amendment 2).
 */
export interface McpToolAnnotations {
  /** The tool does not modify anything. */
  readonly readOnlyHint?: boolean;
  /** A write may destroy or overwrite data (only meaningful when not read-only). */
  readonly destructiveHint?: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  readonly idempotentHint?: boolean;
  /** The tool reaches an open world (the internet) rather than a closed system. */
  readonly openWorldHint?: boolean;
}

export interface McpToolProvider<S extends z.ZodObject = z.ZodObject> {
  /** Tool name: 1-64 of `A-Z a-z 0-9 _ -`. Unique across providers. */
  readonly name: string;
  /** Human-readable name shown in client UIs (`title`, and `annotations.title` for older clients). */
  readonly title?: string;
  /** Shown to the model. State the rate cost and risk (PLAN §7). */
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations?: McpToolAnnotations;
  /** `read` or `write`; filters tools/list per principal (see {@link toolVisible}). */
  readonly access?: ToolAccess;
  /** Scopes the caller must hold (checked before the handler). Default: none beyond `/mcp` access. */
  readonly requiredScopes?: readonly string[];
  handler(input: z.output<S>, ctx: McpToolContext): McpToolResult | Promise<McpToolResult>;
}

/** The part of an MCP server that tool registration needs. `McpServer` satisfies it. */
export type McpServerLike = Pick<McpServer, 'registerTool'>;

export interface RegisterToolsDeps {
  readonly tools: readonly McpToolProvider[];
  readonly log: FastifyBaseLogger;
  /**
   * The request's principal and scope when a policy layer is wired. Write tools are then refused at call time for a
   * `read` scope even if a client calls one it was not shown (the job engine's policy gate refuses too).
   */
  readonly policy?: { readonly principal: Principal; readonly scope: string } | null;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

export class ToolRegistrationError extends Error {}

/** The annotations object sent in `tools/list`: only the known hints, plus the title. */
function toolAnnotations(tool: McpToolProvider): Record<string, string | boolean> | undefined {
  const out: Record<string, string | boolean> = {};
  for (const hint of HINTS) {
    const v = tool.annotations?.[hint];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ToolRegistrationError(`${tool.name}: ${hint} must be a boolean`);
    out[hint] = v;
  }
  if (out.readOnlyHint === true && out.destructiveHint === true) {
    throw new ToolRegistrationError(`${tool.name}: a read-only tool cannot also be destructive`);
  }
  if (tool.title !== undefined) out.title = tool.title;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Registers every provider on `server`. Throws {@link ToolRegistrationError} on a bad or duplicate name. */
export function registerTools(server: McpServerLike, deps: RegisterToolsDeps): void {
  const seen = new Set<string>();
  for (const tool of deps.tools) {
    if (!TOOL_NAME.test(tool.name)) throw new ToolRegistrationError(`Invalid tool name: ${tool.name}`);
    if (seen.has(tool.name)) throw new ToolRegistrationError(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    const annotations = toolAnnotations(tool);
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(annotations !== undefined ? { annotations } : {}),
      },
      async (args, ctx): Promise<CallToolResult> => {
        const caller = ctx.http?.authInfo?.extra?.caller as CallerIdentity | undefined;
        const missing = (tool.requiredScopes ?? []).filter((s) => !caller?.scopes.includes(s));
        if (missing.length > 0) {
          return {
            isError: true,
            content: [{ type: 'text', text: `This tool needs scope: ${missing.join(' ')}` }],
          };
        }
        const policy = deps.policy;
        if (policy !== undefined && !toolVisible(toolAccess(tool), policy?.scope)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  `${tool.name} is not available: this connection is read-only. ` +
                  'The bridge owner can change its profile’s scope in the LK-Bridge dashboard.',
              },
            ],
          };
        }
        try {
          const result = await tool.handler(args, {
            caller,
            signal: ctx.mcpReq.signal,
            log: deps.log,
            ...(policy ? { principal: policy.principal, scope: policy.scope } : {}),
          });
          return result as CallToolResult;
        } catch (err) {
          deps.log.error({ err, tool: tool.name }, 'MCP tool failed');
          return {
            isError: true,
            content: [{ type: 'text', text: `${tool.name} failed: ${(err as Error).message}` }],
          };
        }
      },
    );
  }
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
}

/** Builds the per-request server factory used by the Streamable HTTP transport. */
export function createMcpServerFactory(
  info: McpServerInfo,
  tools: readonly McpToolProvider[],
  log: FastifyBaseLogger,
  access?: McpAccessControl,
): McpServerFactory {
  // Validate names once at start-up rather than on the first request.
  registerTools({ registerTool: () => undefined as never }, { tools, log });
  return (ctx) => {
    const server = new McpServer(
      { name: info.name, version: info.version },
      { capabilities: { tools: {} }, ...(info.instructions ? { instructions: info.instructions } : {}) },
    );
    if (!access) {
      registerTools(server, { tools, log });
      return server;
    }
    // Per request, so a scope change shows in the very next tools/list. Unknown callers see read tools only.
    const caller = ctx?.authInfo?.extra?.caller as CallerIdentity | undefined;
    const policy = access.resolve(caller) ?? null;
    const visible = new Set(
      tools.filter((t) => toolVisible(toolAccess(t), policy?.scope)).map((t) => t.name),
    );
    // Every tool is registered, so a direct call to a hidden write tool gets the clear read-only refusal (from
    // registerTools) rather than "not found"; tools/list then shows only the visible ones.
    if (hideFromList(server, visible, () => registerTools(server, { tools, log, policy }))) return server;
    // Fallback (the SDK internals moved): register only the visible tools, as strict as before.
    const strict = new McpServer(
      { name: info.name, version: info.version },
      { capabilities: { tools: {} }, ...(info.instructions ? { instructions: info.instructions } : {}) },
    );
    registerTools(strict, { tools: tools.filter((t) => visible.has(t.name)), log, policy });
    return strict;
  };
}

type RequestHandler = (request: unknown, ctx: unknown) => Promise<unknown>;

/**
 * Registers the tools (`register`), then wraps the SDK's own `tools/list` handler so it returns only `visible`.
 * Uses the SDK's request-handler map (pinned SDK version; test/tools/policy-e2e.test.ts covers it). Returns false
 * when that map or handler is not where it is expected; the caller then serves a server with visible tools only.
 */
function hideFromList(server: McpServer, visible: ReadonlySet<string>, register: () => void): boolean {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) return false;
  register();
  const inner = handlers.get('tools/list') as RequestHandler | undefined;
  if (typeof inner !== 'function') return false;
  handlers.set('tools/list', async (request: unknown, ctx: unknown) => {
    const result = (await inner(request, ctx)) as { tools?: { name: string }[] };
    return { ...result, tools: (result.tools ?? []).filter((t) => visible.has(t.name)) };
  });
  return true;
}

export interface BridgeInfo {
  readonly version: string;
  readonly projectId: string | null;
  readonly readOnly: boolean | null;
  readonly writersMax: number | null;
}

/**
 * Stub `bridge_info` (PLAN §7). Chunk 3 replaces it with the real tool, which adds the LK key
 * role and live writer state from the governor and job engine.
 */
export function bridgeInfoStub(info: () => BridgeInfo): McpToolProvider {
  return {
    name: 'bridge_info',
    title: 'Bridge information',
    description:
      'Shows the LK-Bridge version, LegendKeeper project, read-only flag and writer pool size. ' +
      'Costs no LegendKeeper rate budget. Risk: none (read-only).',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    access: 'read',
    handler: (_input, ctx) => {
      const i = info();
      const body = {
        bridge: 'LK-Bridge',
        version: i.version,
        project: i.projectId,
        role: 'unknown (the LegendKeeper client arrives in chunk 1)',
        readOnly: i.readOnly,
        writersMax: i.writersMax,
        caller: ctx.caller ? { kind: ctx.caller.kind, clientId: ctx.caller.clientId } : null,
        stub: true,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    },
  };
}
