/**
 * "Write without a base version" (v2 E3, ADR 0045): which calls the Tool calls page flags.
 *
 * Base versions stay optional (the owner's decision), but the owner wants to see whether an assistant ever skips them. A
 * call is flagged when ALL of these hold:
 *
 * - the tool is `write_page` (its version argument is `baseVersion`) or `set_facts` (`baseFactsVersion`);
 * - the call changes EXISTING content. Both tools only ever edit a page that already exists (a new page is made by a
 *   `create_*` tool, never by these two), and every `write_page` mode (append, prepend, replace, replace_section,
 *   append_to_section) edits the page's current document, so no mode is exempt. For `set_facts` the call must carry
 *   something to change: a `facts` or `links` argument with at least one entry (an empty call is refused as invalid and
 *   edits nothing);
 * - it is NOT a dry run (`dryRun: true`): a dry run shows the plan and writes nothing, so there is nothing to protect.
 *   `dryRun: false` or no `dryRun` counts as a real write;
 * - the version argument is missing, or is null or an empty string;
 * - the call reached the tool. A call the MCP layer refused before the tool ran (invalid arguments, a read-only
 *   connection, a missing scope, an unknown tool) edited nothing, so it is not flagged.
 *
 * It is decided at record time from the argument NAMES the log keeps (never values), and stored in
 * `tool_calls.no_base_version` (migration 2500) so the page can filter on it cheaply.
 */
import type { ArgSummary } from './summary.js';

/** Codes of calls refused before any tool ran (src/toolcalls/summary.ts `plainErrorCode`, and the wrapper's own). */
const NEVER_REACHED_THE_TOOL = new Set([
  'INVALID_ARGUMENTS',
  'READ_ONLY_CONNECTION',
  'MISSING_SCOPE',
  'TOOL_NOT_FOUND',
  'PROTOCOL_ERROR',
]);

/** The tools the flag applies to, and the argument that carries the version each one rests on. */
export const BASE_VERSION_ARGUMENT: Readonly<Record<string, string>> = {
  write_page: 'baseVersion',
  set_facts: 'baseFactsVersion',
};

const arg = (args: readonly ArgSummary[], name: string): ArgSummary | undefined =>
  args.find((a) => a.name === name);

/** An argument that holds something: not null, and not an empty string, array or object. */
function present(a: ArgSummary | undefined): boolean {
  if (!a || a.type === 'null') return false;
  if (a.type === 'string' || a.type === 'array' || a.type === 'object') return (a.size ?? 0) > 0;
  return true;
}

/** True when this call is a write without a base version, by the definition in this file's header. */
export function isWriteWithoutBaseVersion(
  tool: string,
  args: readonly ArgSummary[],
  outcomeCode: string | null,
  outcome: string,
): boolean {
  const versionArg = BASE_VERSION_ARGUMENT[tool];
  if (versionArg === undefined) return false;
  if (outcome === 'error' && outcomeCode !== null && NEVER_REACHED_THE_TOOL.has(outcomeCode)) return false;
  if (arg(args, 'dryRun')?.value === true) return false;
  if (present(arg(args, versionArg))) return false;
  if (tool === 'set_facts' && !present(arg(args, 'facts')) && !present(arg(args, 'links'))) return false;
  return true;
}
