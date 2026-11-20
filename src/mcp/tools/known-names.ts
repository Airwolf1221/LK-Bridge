/**
 * v3 F4a (ADR 0063): the names the bridge knows, for the governance drift check (the audits' `governance` category):
 *
 * - every tool it offers, the per-operation tools included whether or not this server lists them (a setting decides
 *   that, not the bridge's knowledge), and every tool a setting pack adds;
 * - its retired names, each with the tool that took over (a governance page still naming one is told the new name);
 * - the words of its tools that are not tools: every tool's argument names, the finding codes of the audits and the
 *   appraisal, and the statuses a job, a proposal or a tool answers with. A governance page may put these in code
 *   formatting (`operation_id`, `proposal_captured`) without naming a tool, so they are never reported as one.
 */
import { CHECKS as APPRAISAL_CHECKS } from '../../appraisal/rules.js';
import { CODES } from '../../audits/types.js';
import type { KnownNames } from '../../audits/checks/governance.js';
import { JOB_STATUSES } from '../../jobs/types.js';
import { operations } from '../../lk/index.js';
import { PROPOSAL_STATES } from '../../policy/types.js';
import type { McpToolProvider } from '../server.js';

/** What a tool answers with besides the job and proposal states. */
const RESULT_STATUSES = [
  'proposal_captured',
  'dry_run',
  'stored',
  'still_present',
  'refused_in_lock',
  'rest_proposed',
];

/** The names the bridge knows, from its tool list (the runtime's, which the setting packs' tools join). */
export function knownNamesOf(tools: readonly McpToolProvider[]): KnownNames {
  const names = new Set<string>();
  const retired = new Map<string, string>();
  const vocabulary = new Set<string>([
    ...Object.keys(CODES),
    ...Object.keys(APPRAISAL_CHECKS),
    ...JOB_STATUSES,
    ...PROPOSAL_STATES,
    ...RESULT_STATUSES,
  ]);
  for (const t of tools) {
    const renamed = t.retired === true ? /^Renamed to ([A-Za-z0-9_-]+)/.exec(t.description) : null;
    if (renamed) retired.set(t.name, renamed[1]!);
    else names.add(t.name);
    const shape = (t.inputSchema as { shape?: unknown }).shape;
    if (shape && typeof shape === 'object') for (const k of Object.keys(shape)) vocabulary.add(k);
  }
  for (const op of operations) names.add(`lk_op_${op.operationId}`);
  return { tools: names, retired, vocabulary };
}
