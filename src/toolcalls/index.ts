/**
 * The tool-call log (v2 E3, ADR 0045; migration 2400): which tools each connection actually called, with what (names
 * and sizes only), what came of it, how long it took and how much request budget it used. For the owner's Tool calls
 * page, to evaluate the assistants without copying transcripts. No agent tool reads it.
 *
 * Recording never affects a call: every failure here is swallowed (and logged once), and the log is written after the
 * result exists. Rows older than `toolcalls.retention_days` (default 7; 0 switches recording off) are removed by the
 * log itself, at start-up and then at most once an hour as calls arrive.
 */
import type { Db } from '../db/open.js';
import type { McpToolResult } from '../mcp/server.js';
import type { PolicyStore } from '../policy/store.js';
import { outcomeOf, summariseArgs, type ArgSummary, type ToolOutcome } from './summary.js';

export { summariseArgs, outcomeOf } from './summary.js';
export type { ArgSummary, ToolOutcome, OutcomeSummary } from './summary.js';

export const RETENTION_DAYS_KEY = 'toolcalls.retention_days';
export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;

export interface ToolCallRow {
  readonly id: number;
  readonly at: number;
  readonly principalId: string | null;
  readonly profile: string | null;
  readonly scope: string | null;
  readonly tool: string;
  readonly project: string | null;
  readonly args: ArgSummary[];
  readonly outcome: ToolOutcome;
  readonly code: string | null;
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly durationMs: number;
  readonly budgetRequests: number | null;
  readonly budgetWrites: number | null;
  readonly resultChars: number | null;
}

export interface ToolCallFilter {
  readonly principalId?: string;
  readonly profile?: string;
  readonly tool?: string;
  /** `success`, `error`, `proposal`, `waiting`, `queued`, or `not_success` (everything but a success). */
  readonly outcome?: ToolOutcome | 'not_success';
  readonly code?: string;
  readonly project?: string;
  /** Only calls at or after this time (ms). */
  readonly since?: number;
  /** Only calls before this time (ms). */
  readonly until?: number;
  /** Paging: calls with an id below this. */
  readonly before?: number;
  readonly limit?: number;
}

/** Who made a call, as the MCP wrapper knows it. */
export interface CallerInfo {
  readonly principalId: string | null;
  readonly profile: string | null;
  readonly scope: string | null;
}

/** The request budget's movement during a call: the sum, over all projects, of the hourly request and write counters. */
export interface BudgetProbe {
  (): { readonly requests: number; readonly writes: number } | null;
}

export interface ToolCallEnd {
  readonly result?: McpToolResult;
  /** The handler threw (the wrapper turned it into an error result). */
  readonly thrown?: unknown;
  /** The call was refused before the handler ran (scope, read-only connection). */
  readonly refusedCode?: string;
}

export interface ToolCallLogOptions {
  readonly db: Db;
  readonly settings: Pick<PolicyStore, 'readSetting' | 'writeSetting' | 'audit'>;
  readonly budget?: BudgetProbe;
  readonly now?: () => number;
  readonly warn?: (message: string, err: unknown) => void;
}

interface DbRow {
  id: number;
  at: number;
  principal_id: string | null;
  profile: string | null;
  scope: string | null;
  tool: string;
  project: string | null;
  args: string;
  outcome: ToolOutcome;
  code: string | null;
  job_id: string | null;
  proposal_id: string | null;
  duration_ms: number;
  budget_requests: number | null;
  budget_writes: number | null;
  result_chars: number | null;
}

const COLUMNS =
  'id, at, principal_id, profile, scope, tool, project, args, outcome, code, job_id, proposal_id, duration_ms, budget_requests, budget_writes, result_chars';

function toRow(r: DbRow): ToolCallRow {
  let args: ArgSummary[] = [];
  try {
    const parsed: unknown = JSON.parse(r.args);
    if (Array.isArray(parsed)) args = parsed as ArgSummary[];
  } catch {
    /* an unreadable summary shows as no arguments */
  }
  return {
    id: r.id,
    at: r.at,
    principalId: r.principal_id,
    profile: r.profile,
    scope: r.scope,
    tool: r.tool,
    project: r.project,
    args,
    outcome: r.outcome,
    code: r.code,
    jobId: r.job_id,
    proposalId: r.proposal_id,
    durationMs: r.duration_ms,
    budgetRequests: r.budget_requests,
    budgetWrites: r.budget_writes,
    resultChars: r.result_chars,
  };
}

export class ToolCallLog {
  private readonly now: () => number;
  private lastPrune = 0;
  private warned = false;

  constructor(private readonly o: ToolCallLogOptions) {
    this.now = o.now ?? (() => Date.now());
    this.prune();
  }

  /** Days rows are kept: the stored setting, else 7. 0 = recording is off. */
  retentionDays(): number {
    const v = this.o.settings.readSetting(RETENTION_DAYS_KEY);
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_RETENTION_DAYS
      ? v
      : DEFAULT_RETENTION_DAYS;
  }

  /** Owner command: set the retention (0 = do not record; at most 90). Audited. */
  setRetentionDays(days: number, by = 'owner'): number {
    if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
      throw new RangeError(`Retention must be a whole number of days from 0 to ${MAX_RETENTION_DAYS}`);
    }
    const before = this.retentionDays();
    this.o.settings.writeSetting(RETENTION_DAYS_KEY, days, by);
    this.o.settings.audit(
      by,
      'policy.set_toolcalls_retention',
      RETENTION_DAYS_KEY,
      { days: before },
      { days },
    );
    this.prune();
    return days;
  }

  /**
   * Starts timing a call; the returned function records it. Never throws and never delays the call by more than a few
   * counter reads.
   */
  begin(tool: string, args: unknown, caller: CallerInfo): (end: ToolCallEnd) => void {
    if (this.retentionDays() === 0) return () => undefined;
    const startedAt = this.now();
    let before: ReturnType<BudgetProbe> = null;
    let summary: ArgSummary[] = [];
    try {
      before = this.o.budget?.() ?? null;
      summary = summariseArgs(args);
    } catch (err) {
      this.warn('could not prepare a tool-call record', err);
    }
    return (end) => {
      try {
        const after = this.o.budget?.() ?? null;
        const result: McpToolResult = end.result ?? {
          isError: true,
          content: [{ type: 'text', text: '' }],
        };
        const o =
          end.refusedCode !== undefined || end.thrown !== undefined
            ? {
                outcome: 'error' as const,
                code: end.refusedCode ?? 'TOOL_FAILED',
                project: null,
                jobId: null,
                proposalId: null,
                resultChars: result.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0),
              }
            : outcomeOf(result);
        this.o.db
          .prepare(
            `INSERT INTO tool_calls (at, principal_id, profile, scope, tool, project, args, outcome, code, job_id,
               proposal_id, duration_ms, budget_requests, budget_writes, result_chars)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            startedAt,
            caller.principalId,
            caller.profile,
            caller.scope,
            tool,
            o.project,
            JSON.stringify(summary),
            o.outcome,
            o.code,
            o.jobId,
            o.proposalId,
            Math.max(0, this.now() - startedAt),
            before && after ? Math.max(0, after.requests - before.requests) : null,
            before && after ? Math.max(0, after.writes - before.writes) : null,
            o.resultChars,
          );
        if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune();
      } catch (err) {
        this.warn('could not record a tool call', err);
      }
    };
  }

  list(f: ToolCallFilter = {}): { readonly rows: ToolCallRow[]; readonly hasMore: boolean } {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: string | undefined) => {
      if (v !== undefined && v !== '') {
        where.push(`${col} = ?`);
        params.push(v);
      }
    };
    eq('principal_id', f.principalId);
    eq('profile', f.profile);
    eq('tool', f.tool);
    eq('code', f.code);
    eq('project', f.project);
    if (f.outcome === 'not_success') where.push(`outcome <> 'success'`);
    else eq('outcome', f.outcome);
    if (f.since !== undefined) {
      where.push('at >= ?');
      params.push(f.since);
    }
    if (f.until !== undefined) {
      where.push('at < ?');
      params.push(f.until);
    }
    if (f.before !== undefined) {
      where.push('id < ?');
      params.push(f.before);
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = this.o.db
      .prepare(
        `SELECT ${COLUMNS} FROM tool_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as DbRow[];
    return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit };
  }

  /** The tools, profiles and codes present in the log, for the page's filters. */
  facets(): { tools: string[]; profiles: string[]; codes: string[]; total: number; oldest: number | null } {
    const col = (c: string) =>
      (
        this.o.db
          .prepare(`SELECT DISTINCT ${c} AS v FROM tool_calls WHERE ${c} IS NOT NULL ORDER BY ${c}`)
          .all() as { v: string }[]
      ).map((r) => r.v);
    const t = this.o.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM tool_calls').get() as {
      n: number;
      oldest: number | null;
    };
    return { tools: col('tool'), profiles: col('profile'), codes: col('code'), total: t.n, oldest: t.oldest };
  }

  /** Removes rows older than the retention; with recording off (0 days) removes them all. Returns how many. */
  prune(): number {
    this.lastPrune = this.now();
    try {
      const cutoff = this.now() - this.retentionDays() * DAY_MS;
      return this.o.db.prepare('DELETE FROM tool_calls WHERE at < ?').run(cutoff).changes;
    } catch (err) {
      this.warn('could not prune the tool-call log', err);
      return 0;
    }
  }

  private warn(message: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.o.warn?.(message, err);
  }
}
