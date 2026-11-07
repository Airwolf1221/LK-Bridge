import { McpServer, type CallToolResult, type McpServerFactory } from '@modelcontextprotocol/server';
import type { FastifyBaseLogger } from 'fastify';
import * as z from 'zod';
import type { CallerIdentity } from '../auth/bearer.js';

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
  /** Whether the tool only reads or may write; chunk 2b filters and enforces on it (not enforced here). */
  readonly access?: 'read' | 'write';
  /** Scopes the caller must hold (checked before the handler). Default: none beyond `/mcp` access. */
  readonly requiredScopes?: readonly string[];
  handler(input: z.output<S>, ctx: McpToolContext): McpToolResult | Promise<McpToolResult>;
}

/** The part of an MCP server that tool registration needs. `McpServer` satisfies it. */
export type McpServerLike = Pick<McpServer, 'registerTool'>;

export interface RegisterToolsDeps {
  readonly tools: readonly McpToolProvider[];
  readonly log: FastifyBaseLogger;
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
        try {
          const result = await tool.handler(args, { caller, signal: ctx.mcpReq.signal, log: deps.log });
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
): McpServerFactory {
  // Validate names once at start-up rather than on the first request.
  registerTools({ registerTool: () => undefined as never }, { tools, log });
  return () => {
    const server = new McpServer(
      { name: info.name, version: info.version },
      { capabilities: { tools: {} }, ...(info.instructions ? { instructions: info.instructions } : {}) },
    );
    registerTools(server, { tools, log });
    return server;
  };
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
