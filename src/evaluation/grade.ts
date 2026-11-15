/**
 * The auto-grade of one scenario (v2 E3, ADR 0045): a HINT for the owner, never the grade. It compares the tools an
 * assistant called with what the scenario expects and with what would be a mistake, and lists the error codes seen. The
 * owner confirms Right, Partly or Wrong; nothing here ever sets that.
 *
 * Pure: no database, no clock.
 */
import type { ToolOutcome } from '../toolcalls/summary.js';
import type { Scenario } from './scenarios.js';

/** One call, as a run keeps it (the underlying log row may be pruned long before the run is looked at). */
export interface RecordedCall {
  readonly tool: string;
  readonly outcome: ToolOutcome;
  /** The error code when the call failed; otherwise the status it carried, if any. */
  readonly code: string | null;
  /** The `live` argument when the call sent it (get_resource), for the results table. */
  readonly live?: boolean;
  /** The call was a write without a base version (src/toolcalls/flag.ts). */
  readonly noBase?: true;
}

/**
 * Tools that were merged into another: a call to the old name counts as the new one when grading, and a scenario may
 * name either. The results table still shows the name that was really called.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  get_resources: 'get_resource',
  bridge_proposals_mine: 'bridge_proposal_status',
  bridge_job_wait: 'bridge_job_status',
};

/** The current name of a tool (an old name maps to the tool it was merged into). */
export const canonicalTool = (name: string): string => TOOL_ALIASES[name] ?? name;

export interface ErrorCodeCount {
  readonly code: string;
  readonly count: number;
}

export type GradeHint = 'looks_right' | 'check' | 'looks_wrong' | 'no_calls';

export interface AutoGrade {
  /** Every tool the scenario expects was called (true when it expects none). */
  readonly expectedPresent: boolean;
  /** What is missing: a tool name, or `a or b` for a choice. */
  readonly missingExpected: string[];
  /** Mistake tools that were called (each once, canonical names). */
  readonly mistakeTools: string[];
  /** Codes of the calls that failed, with how many times each. */
  readonly errorCodes: ErrorCodeCount[];
  readonly callCount: number;
  /** Writes without a base version among the calls. */
  readonly writesWithoutBaseVersion: number;
  readonly hint: GradeHint;
}

export const HINT_LABEL: Readonly<Record<GradeHint, string>> = {
  looks_right: 'Looks right',
  check: 'Check it',
  looks_wrong: 'Looks wrong',
  no_calls: 'No calls recorded',
};

/** The error codes seen, most frequent first, then alphabetical. */
export function errorCodesOf(calls: readonly RecordedCall[]): ErrorCodeCount[] {
  const counts = new Map<string, number>();
  for (const c of calls)
    if (c.outcome === 'error') counts.set(c.code ?? 'ERROR', (counts.get(c.code ?? 'ERROR') ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function autoGrade(
  scenario: Pick<Scenario, 'expectedTools' | 'mistakeTools'>,
  calls: readonly RecordedCall[],
): AutoGrade {
  const called = new Set(calls.map((c) => canonicalTool(c.tool)));
  const missingExpected: string[] = [];
  for (const e of scenario.expectedTools) {
    const options = (Array.isArray(e) ? e : [e]).map(canonicalTool);
    if (!options.some((o) => called.has(o))) missingExpected.push(options.join(' or '));
  }
  const mistakes = new Set(scenario.mistakeTools.map(canonicalTool));
  const mistakeTools = [...called].filter((t) => mistakes.has(t)).sort();
  const errorCodes = errorCodesOf(calls);
  const callCount = calls.length;
  let hint: GradeHint;
  if (callCount === 0) hint = scenario.expectedTools.length === 0 ? 'looks_right' : 'no_calls';
  else if (mistakeTools.length > 0 || missingExpected.length > 0) hint = 'looks_wrong';
  else if (errorCodes.length > 0) hint = 'check';
  else hint = 'looks_right';
  return {
    expectedPresent: missingExpected.length === 0,
    missingExpected,
    mistakeTools,
    errorCodes,
    callCount,
    writesWithoutBaseVersion: calls.filter((c) => c.noBase === true).length,
    hint,
  };
}
