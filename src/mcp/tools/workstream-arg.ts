/**
 * v3 F5c (ADR 0069, H8): the optional `workstream` argument of every tool that writes or proposes. The tool list wraps
 * each write tool: its input schema gains `workstream` (at most 80 characters), its handler runs inside a frame holding
 * the label in force (the argument, else the calling connection's default from `bridge_workstream`), so `mcpOrigin`
 * records it on the job, the proposal and the journal entries, and its result echoes the label (`workstream`).
 */
import * as z from 'zod';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { toolAccess } from '../server.js';
import {
  currentFrame,
  normaliseWorkstream,
  withWorkstream,
  WORKSTREAM_MAX,
  type WorkstreamFrame,
} from '../../workstreams/context.js';
import type { WorkstreamDefaults } from '../../workstreams/defaults.js';

export const workstreamArg = z
  .string()
  .max(WORKSTREAM_MAX)
  .optional()
  .describe(
    'A short label grouping this change with the rest of one maintenance objective (for example "Menkheti culture split"); recorded on the job, proposal and journal, and reported by bridge_workstream_report. Default: the label set with bridge_workstream, if any.',
  );

/** The label in force for a call: its own argument, else its connection's default (which this use keeps alive). */
export function frameFor(
  given: unknown,
  mctx: McpToolContext,
  defaults: WorkstreamDefaults | undefined,
): WorkstreamFrame {
  const own = normaliseWorkstream(given);
  if (own !== null) return { label: own, source: 'argument' };
  // A tool called by another tool (a narrative promotion hands its proposals on) stays in the caller's workstream.
  const outer = currentFrame();
  if (outer && outer.label !== null) return outer;
  const pid = mctx.principal?.principalId;
  if (pid && defaults) {
    const d = defaults.get(pid, { touch: true });
    if (d) return { label: d.label, source: 'default' };
  }
  return { label: null, source: null };
}

/** The result with `workstream` added to its JSON body (the first line), when it has one. */
export function echoWorkstream(result: McpToolResult, frame: WorkstreamFrame): McpToolResult {
  if (frame.label === null) return result;
  const content: readonly McpToolResult['content'][number][] = result.content;
  if (content.length === 0) return result;
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') return result;
  const nl = first.text.indexOf('\n');
  const head = nl === -1 ? first.text : first.text.slice(0, nl);
  const tail = nl === -1 ? '' : first.text.slice(nl);
  let body: unknown;
  try {
    body = JSON.parse(head);
  } catch {
    return result;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return result;
  const b = body as Record<string, unknown>;
  // A body that names a workstream of its own (a record read back) keeps it; the label in force is noted only when the
  // two agree.
  if ('workstream' in b) {
    if (b.workstream !== frame.label || frame.source !== 'default' || 'workstreamSource' in b) return result;
    const text = JSON.stringify({ ...b, workstreamSource: 'default (bridge_workstream)' });
    return { ...result, content: [{ type: 'text', text: `${text}${tail}` }, ...content.slice(1)] };
  }
  const { project, ...rest } = b;
  const next = {
    ...(project !== undefined ? { project } : {}),
    workstream: frame.label,
    ...(frame.source === 'default' ? { workstreamSource: 'default (bridge_workstream)' } : {}),
    ...rest,
  };
  return {
    ...result,
    content: [{ type: 'text', text: `${JSON.stringify(next)}${tail}` }, ...content.slice(1)],
  };
}

/** Wraps a write tool with the `workstream` argument (a read tool, or one that already takes it, is returned as it is). */
export function withWorkstreamArg(
  tool: McpToolProvider,
  defaults: () => WorkstreamDefaults | undefined,
): McpToolProvider {
  if (tool.retired || toolAccess(tool) !== 'write') return tool;
  const schema: unknown = tool.inputSchema;
  if (!(schema instanceof z.ZodObject) || 'workstream' in schema.shape) return tool;
  const inputSchema = schema.extend({ workstream: workstreamArg });
  return {
    ...tool,
    inputSchema,
    handler: async (args: Record<string, unknown>, mctx: McpToolContext) => {
      const { workstream, ...rest } = args;
      const frame = frameFor(workstream, mctx, defaults());
      const result = await withWorkstream(frame, () => tool.handler(rest as never, mctx));
      return echoWorkstream(result, frame);
    },
  };
}
