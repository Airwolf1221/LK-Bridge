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
import { isWriteWithoutBaseVersion } from './flag.js';
import { outcomeOf, summariseArgs, type ArgSummary, type ToolOutcome } from './summary.js';

export { summariseArgs, outcomeOf } from './summary.js';
export { isWriteWithoutBaseVersion, BASE_VERSION_ARGUMENT } from './flag.js';
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
  /** A `write_page` or `set_facts` that edits existing content with no base version (src/toolcalls/flag.ts). */
  readonly noBaseVersion: boolean;
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
  /** Only the writes without a base version (`true`). */
  readonly noBaseVersion?: boolean;
  readonly limit?: number;
}

/** The calls of one Evaluation window: made by these connections, with an id above `afterId` and up to `upToId`. */
export interface ToolCallWindow {
  readonly principalIds: readonly string[];
  readonly afterId: number;
  /** Default: no upper bound (a window still open). */
  readonly upToId?: number;
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
  no_base_version: number;
}

const COLUMNS =
  'id, at, principal_id, profile, scope, tool, project, args, outcome, code, job_id, proposal_id, duration_ms, budget_requests, budget_writes, result_chars, no_base_version';

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
    noBaseVersion: r.no_base_version === 1,
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
  begin(rawTool: string, args: unknown, caller: CallerInfo): (end: ToolCallEnd) => void {
    if (this.retentionDays() === 0) return () => undefined;
    // The name is the client's text: keep it only when it looks like a tool name (the registry's own rule).
    const tool = /^[A-Za-z0-9_-]{1,64}$/.test(rawTool)
      ? rawTool
      : `(not a tool name: ${rawTool.length} chars)`;
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
               proposal_id, duration_ms, budget_requests, budget_writes, result_chars, no_base_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            isWriteWithoutBaseVersion(tool, summary, o.code, o.outcome) ? 1 : 0,
          );
        if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune();
      } catch (err) {
        this.warn('could not record a tool call', err);
      }
    };
  }

  private where(f: ToolCallFilter): { sql: string; params: unknown[] } {
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
    if (f.noBaseVersion === true) where.push('no_base_version = 1');
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
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(f: ToolCallFilter = {}): { readonly rows: ToolCallRow[]; readonly hasMore: boolean } {
    const { sql, params } = this.where(f);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = this.o.db
      .prepare(`SELECT ${COLUMNS} FROM tool_calls ${sql} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as DbRow[];
    return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit };
  }

  /** How many calls match, and how many of those are writes without a base version (paging is ignored). */
  summary(f: ToolCallFilter = {}): { readonly matching: number; readonly noBaseVersion: number } {
    const { noBaseVersion: _flagged, before: _paging, ...rest } = f;
    const { sql, params } = this.where(rest);
    const r = this.o.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(no_base_version), 0) AS flagged FROM tool_calls ${sql}`)
      .get(...params) as { n: number; flagged: number };
    return { matching: r.n, noBaseVersion: r.flagged };
  }

  /**
   * The id of the newest call ever recorded (0 before the first). It never goes down, even when every row has been pruned
   * (the table's ids only grow), so an Evaluation window that starts here holds exactly the calls made after it.
   */
  lastId(): number {
    const r = this.o.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'tool_calls'`).get() as
      { seq: number } | undefined;
    return r?.seq ?? 0;
  }

  /** The calls of an Evaluation window, oldest first (at most 2000). Calls of other connections are never in it. */
  window(w: ToolCallWindow): ToolCallRow[] {
    if (w.principalIds.length === 0) return [];
    const marks = w.principalIds.map(() => '?').join(', ');
    return (
      this.o.db
        .prepare(
          `SELECT ${COLUMNS} FROM tool_calls
           WHERE id > ? AND id <= ? AND principal_id IN (${marks}) ORDER BY id ASC LIMIT 2000`,
        )
        .all(w.afterId, w.upToId ?? Number.MAX_SAFE_INTEGER, ...w.principalIds) as DbRow[]
    ).map(toRow);
  }

  /** Distinct connections that made calls with an id above `afterId` (for "which connection was that?"). */
  principalsSince(afterId: number): string[] {
    return (
      this.o.db
        .prepare(
          `SELECT DISTINCT principal_id AS p FROM tool_calls WHERE id > ? AND principal_id IS NOT NULL ORDER BY p`,
        )
        .all(afterId) as { p: string }[]
    ).map((r) => r.p);
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
