/**
 * What the tool-call log keeps of a call (v2 E3, ADR 0045): names and sizes, never page content or secrets.
 *
 * The rule is deny by default. An argument's NAME and a size are always kept (`markdown: string(1204)`,
 * `facts: object(3 keys)`, `items: array(12)`). Its VALUE is kept only when it is a boolean, a number, or a short string
 * under one of the reference names below (a page name, a mode, a section path, a tool's own enum). Anything else, such as
 * `markdown`, `facts`, `data_base64`, `upload_id`, a version, a URL or a token, never leaves the call.
 */
import type { McpToolResult } from '../mcp/server.js';

export interface ArgSummary {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  /** Characters (string), items (array) or keys (object). */
  readonly size?: number;
  /** Only for booleans, numbers and short reference strings. */
  readonly value?: string | number | boolean;
}

/** Arguments whose short string value helps to see what the assistant asked for, and is neither content nor a secret. */
const REFERENCE_NAMES = new Set([
  'project',
  'page',
  'resource',
  'document',
  'section',
  'mode',
  'kind',
  'status',
  'type',
  'category',
  'query',
  'operationId',
  'detail',
  'format',
  'scope',
  'event',
  'feature',
  'featureFolder',
  'folder',
  'parent',
  'to',
  'destination',
  'template',
  'name',
  'race',
  'tool',
  'state',
  'age',
  'date',
  'calendar',
  'tag',
]);
const MAX_VALUE = 80;
const MAX_ARGS = 40;

function one(name: string, v: unknown): ArgSummary {
  if (v === null || v === undefined) return { name, type: 'null' };
  if (typeof v === 'boolean') return { name, type: 'boolean', value: v };
  if (typeof v === 'number') return { name, type: 'number', value: v };
  if (typeof v === 'string') {
    return REFERENCE_NAMES.has(name) && v.length <= MAX_VALUE
      ? { name, type: 'string', size: v.length, value: v }
      : { name, type: 'string', size: v.length };
  }
  if (Array.isArray(v)) return { name, type: 'array', size: v.length };
  if (typeof v === 'object') return { name, type: 'object', size: Object.keys(v).length };
  return { name, type: 'null' }; // JSON arguments hold nothing else
}

/** The arguments of a call as names and sizes (see the file's rule). */
export function summariseArgs(args: unknown): ArgSummary[] {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return [];
  const out: ArgSummary[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (out.length >= MAX_ARGS) break;
    if (v === undefined) continue;
    out.push(one(k.slice(0, 64), v));
  }
  return out;
}

export type ToolOutcome = 'success' | 'error' | 'proposal' | 'waiting' | 'queued';

export interface OutcomeSummary {
  readonly outcome: ToolOutcome;
  /** The error code, or the status the result carried (`proposal_captured`, `waiting_budget`, `queued`, `succeeded`…). */
  readonly code: string | null;
  readonly project: string | null;
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly resultChars: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 200) : null);

/**
 * Reads a result the way the tool layer writes it: one text block of compact JSON, then the budget line. Anything that
 * does not parse is a plain success or error by its `isError` flag.
 */
export function outcomeOf(result: McpToolResult): OutcomeSummary {
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
  const lines = text.split('\n');
  const first =
    lines.length > 1 && /^budget \(/.test(lines.at(-1) ?? '') ? lines.slice(0, -1).join('\n') : text;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(first);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    /* plain text result */
  }
  const err =
    body && typeof body.error === 'object' && body.error !== null
      ? (body.error as Record<string, unknown>)
      : null;
  const status = str(body?.status);
  const project = str(body?.project);
  const jobId = str(body?.jobId) ?? str(err?.jobId);
  const proposalId = str(body?.proposalId);
  const base = { project, jobId, proposalId, resultChars: text.length };
  if (result.isError === true || err)
    return { ...base, outcome: 'error', code: str(err?.code) ?? plainErrorCode(text) };
  if (status === 'proposal_captured') return { ...base, outcome: 'proposal', code: status };
  if (status === 'waiting_budget') return { ...base, outcome: 'waiting', code: status };
  if (status === 'queued') return { ...base, outcome: 'queued', code: status };
  return { ...base, outcome: 'success', code: status };
}

/** The code of an error that is plain text (the SDK's or the wrapper's own refusals), so the log can group them. */
function plainErrorCode(text: string): string {
  if (/^Input validation error/i.test(text)) return 'INVALID_ARGUMENTS';
  if (/is not available: this connection is read-only/.test(text)) return 'READ_ONLY_CONNECTION';
  if (/^This tool needs scope/.test(text)) return 'MISSING_SCOPE';
  if (/^Tool .* not found/i.test(text)) return 'TOOL_NOT_FOUND';
  if (/ failed: /.test(text.slice(0, 120))) return 'TOOL_FAILED';
  return 'ERROR';
}
