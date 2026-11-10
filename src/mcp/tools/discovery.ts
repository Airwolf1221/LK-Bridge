/**
 * Operation discovery for callers that cannot see the low-level tools (hotfix, ADR 0033).
 *
 * With `showLowLevelTools` off a profile cannot see `lk_api_list_operations` or `lk_api_describe_operation`, yet it can
 * still run every operation through `lk_api_read`, `lk_api_write` and `lk_api_batch`. So an unknown operation id gets
 * close suggestions and a hint that names only tools the caller can see, and the bridge guide carries an Operations
 * section generated from the registry (so it cannot go stale).
 */
import { operations, type OperationDef } from '../../lk/index.js';
import { suggestOperations } from './schemas.js';
import type { ToolErrorBody } from './shape.js';

/** The `hint` of an UNKNOWN_OPERATION error: the low-level tools are named only when the caller can see them. */
export function operationsHint(lowLevelVisible: boolean): string {
  return lowLevelVisible
    ? `Use lk_api_list_operations to see all ${operations.length} operations and lk_api_describe_operation for one operation’s input schema. The full list is also in get_bridge_guide (Operations).`
    : 'The full list is in get_bridge_guide (Operations), or the owner can show the low-level tools for this profile on Clients & Access.';
}

/** The error body for an operation id that is not in the registry, with up to 5 close ids. */
export function unknownOperationBody(
  operationId: string,
  lowLevelVisible: boolean,
  extra: Record<string, unknown> = {},
): ToolErrorBody {
  return {
    code: 'UNKNOWN_OPERATION',
    message: `Unknown LegendKeeper operation: ${operationId}`,
    ...extra,
    didYouMean: suggestOperations(
      operationId,
      operations.map((o) => o.operationId),
    ),
    hint: operationsHint(lowLevelVisible),
  };
}

const SUMMARY_MAX = 90;
const clip = (s: string) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

/** One line: `- \`insertBlock\`: write, safe. Insert a block`. No schemas. */
function line(op: OperationDef): string {
  return `- \`${op.operationId}\`: ${op.kind}, ${op.risk}. ${clip(op.summary)}`;
}

/**
 * The "Operations" section of the bridge guide, generated from the operation registry every time the guide is served
 * and appended to docs/bridge-guide.md: every operation id, grouped by tag, each with its kind (read, write, upload)
 * and risk (safe, destructive, admin). One line each; no input schemas.
 */
export function operationsGuideSection(ops: readonly OperationDef[] = operations): string {
  const byTag = new Map<string, OperationDef[]>();
  for (const op of ops) byTag.set(op.tag, [...(byTag.get(op.tag) ?? []), op]);
  const groups = [...byTag].map(([tag, list]) => `### ${tag}\n\n${list.map(line).join('\n')}`).join('\n\n');
  return `## Operations

All ${ops.length} LegendKeeper operations, by tag, each with its kind and risk. Run a \`read\` with \`lk_api_read\`, a \`write\` or \`upload\` with \`lk_api_write\` (or several in order with \`lk_api_batch\`); the bridge refuses an operation sent to the wrong tool before it spends any budget. The list is generated from the bridge's operation registry when this guide is served, so it is always current.

Input schemas: \`lk_api_describe_operation\` returns an operation's input schema, but only when the owner has shown the low-level tools for your profile. Either way, \`getBlock\` and \`getDocumentBlocks\` show the current shape of real data: read a real block of the kind you want to write, and follow its shape.

${groups}
`;
}
