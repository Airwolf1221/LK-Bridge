/**
 * v3 F5b (ADR 0068): the automation framework's own tables (migration 4200): each code's setting per project, the
 * journal of changes, the bridge-wide pause, the runs and their items, the bridge-managed governance paragraphs and the
 * governance writes' jobs. Nothing here reads LegendKeeper.
 */
import type { Db } from '../db/open.js';

export type Mode = 'off' | 'propose' | 'apply';
export const MODES: readonly Mode[] = ['off', 'propose', 'apply'];

export interface SettingRow {
  readonly projectId: string;
  readonly code: string;
  readonly mode: Mode;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly pausedAt: number | null;
  readonly pausedReason: string | null;
  readonly stoppedAt: number | null;
  readonly stoppedReason: string | null;
  readonly skipReason: string | null;
  readonly skipStreak: number;
  readonly governancePending: string | null;
}

export interface ChangeRow {
  readonly id: number;
  readonly projectId: string;
  readonly code: string;
  readonly from: Mode;
  readonly to: Mode;
  readonly principal: string;
  readonly at: number;
  readonly reason: string | null;
  readonly governanceJobId: string | null;
  readonly governanceState: 'written' | 'pending' | 'failed' | 'none';
}

export type RunState = 'running' | 'succeeded' | 'stopped' | 'skipped' | 'failed';
export interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly trigger: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly state: RunState;
  readonly summary: string | null;
  readonly stopReason: string | null;
}

export type ItemOutcome = 'applied' | 'proposed' | 'skipped' | 'guarded' | 'failed' | 'stopped';
export interface ItemRow {
  readonly id: number;
  readonly runId: string;
  readonly code: string;
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly outcome: ItemOutcome;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly at: number;
}

export interface ParagraphRow {
  readonly projectId: string;
  readonly code: string;
  readonly resourceId: string;
  readonly documentId: string;
  readonly blockId: string;
  readonly text: string;
  readonly jobId: string | null;
  readonly updatedAt: number;
}

export interface GovernanceJobRow {
  readonly jobId: string;
  readonly projectId: string;
  readonly code: string;
  readonly kind: 'enable' | 'amend' | 'disable';
  readonly changeId: number | null;
  readonly resourceId: string;
  readonly documentId: string;
  readonly blockId: string;
  readonly beforeVersion: string;
  readonly beforeBlocks: unknown[];
  readonly plannedBlocks: unknown[];
  readonly previousText: string | null;
  readonly text: string;
  readonly at: number;
}

type R = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class AutomationStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ---------------------------------------------------------------------------------------------- settings

  setting(projectId: string, code: string): SettingRow | null {
    const r = this.db
      .prepare('SELECT * FROM automation_settings WHERE project_id = ? AND code = ?')
      .get(projectId, code) as R | undefined;
    return r ? toSetting(r) : null;
  }

  settings(projectId: string): SettingRow[] {
    return (
      this.db.prepare('SELECT * FROM automation_settings WHERE project_id = ?').all(projectId) as R[]
    ).map(toSetting);
  }

  /** The mode of a code (off when it has no row). */
  mode(projectId: string, code: string): Mode {
    return this.setting(projectId, code)?.mode ?? 'off';
  }

  /** Sets the mode; a change of mode clears the pause, the stop and the skip streak. */
  setMode(projectId: string, code: string, mode: Mode, by: string, o: { stopped?: string } = {}): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO automation_settings (project_id, code, mode, updated_at, updated_by, stopped_at, stopped_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, code) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by, paused_at = NULL, paused_reason = NULL,
           stopped_at = excluded.stopped_at, stopped_reason = excluded.stopped_reason,
           skip_reason = NULL, skip_streak = 0`,
      )
      .run(projectId, code, mode, at, by, o.stopped ? at : null, o.stopped ?? null);
  }

  pause(projectId: string, code: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE automation_settings SET paused_at = ?, paused_reason = ? WHERE project_id = ? AND code = ?',
      )
      .run(this.now(), reason.slice(0, 2000), projectId, code);
  }

  resume(projectId: string, code: string): void {
    this.db
      .prepare(
        `UPDATE automation_settings SET paused_at = NULL, paused_reason = NULL, skip_reason = NULL, skip_streak = 0
         WHERE project_id = ? AND code = ?`,
      )
      .run(projectId, code);
  }

  /** Records a skip; returns the streak of skips for this reason (a different reason starts a new streak). */
  skip(projectId: string, code: string, reason: string): number {
    const s = this.setting(projectId, code);
    if (!s) return 0;
    const streak = s.skipReason === reason ? s.skipStreak + 1 : 1;
    this.db
      .prepare(
        'UPDATE automation_settings SET skip_reason = ?, skip_streak = ? WHERE project_id = ? AND code = ?',
      )
      .run(reason, streak, projectId, code);
    return streak;
  }

  clearSkips(projectId: string, code: string): void {
    this.db
      .prepare(
        'UPDATE automation_settings SET skip_reason = NULL, skip_streak = 0 WHERE project_id = ? AND code = ?',
      )
      .run(projectId, code);
  }

  setGovernancePending(projectId: string, code: string, what: string | null): void {
    this.db
      .prepare('UPDATE automation_settings SET governance_pending = ? WHERE project_id = ? AND code = ?')
      .run(what, projectId, code);
  }

  // ---------------------------------------------------------------------------------------------- changes

  recordChange(c: Omit<ChangeRow, 'id' | 'at'> & { at?: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO automation_changes (project_id, code, from_mode, to_mode, principal, at, reason,
           governance_job_id, governance_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.projectId,
        c.code,
        c.from,
        c.to,
        c.principal,
        c.at ?? this.now(),
        c.reason?.slice(0, 2000) ?? null,
        c.governanceJobId,
        c.governanceState,
      );
    return Number(r.lastInsertRowid);
  }

  setChangeGovernance(id: number, jobId: string | null, state: ChangeRow['governanceState']): void {
    this.db
      .prepare('UPDATE automation_changes SET governance_job_id = ?, governance_state = ? WHERE id = ?')
      .run(jobId, state, id);
  }

  changes(projectId: string, code?: string, limit = 200): ChangeRow[] {
    const rows = (
      code
        ? this.db
            .prepare(
              'SELECT * FROM automation_changes WHERE project_id = ? AND code = ? ORDER BY id DESC LIMIT ?',
            )
            .all(projectId, code, limit)
        : this.db
            .prepare('SELECT * FROM automation_changes WHERE project_id = ? ORDER BY id DESC LIMIT ?')
            .all(projectId, limit)
    ) as R[];
    return rows.map((r) => ({
      id: Number(r.id),
      projectId: String(r.project_id),
      code: String(r.code),
      from: String(r.from_mode) as Mode,
      to: String(r.to_mode) as Mode,
      principal: String(r.principal),
      at: Number(r.at),
      reason: str(r.reason),
      governanceJobId: str(r.governance_job_id),
      governanceState: String(r.governance_state) as ChangeRow['governanceState'],
    }));
  }

  // ---------------------------------------------------------------------------------------------- the brake

  global(): { paused: boolean; pausedAt: number | null; pausedBy: string | null } {
    const r = this.db.prepare('SELECT * FROM automation_global WHERE id = 1').get() as R | undefined;
    return { paused: r?.paused === 1, pausedAt: num(r?.paused_at), pausedBy: str(r?.paused_by) };
  }

  setGlobalPause(paused: boolean, by: string): void {
    this.db
      .prepare('UPDATE automation_global SET paused = ?, paused_at = ?, paused_by = ? WHERE id = 1')
      .run(paused ? 1 : 0, paused ? this.now() : null, paused ? by : null);
  }

  // ---------------------------------------------------------------------------------------------- runs

  startRun(id: string, projectId: string, trigger: string): void {
    this.db
      .prepare(
        `INSERT INTO automation_runs (id, project_id, trigger, started_at, state) VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(id, projectId, trigger, this.now());
  }

  finishRun(id: string, state: RunState, summary: string, stopReason: string | null): void {
    this.db
      .prepare(
        'UPDATE automation_runs SET finished_at = ?, state = ?, summary = ?, stop_reason = ? WHERE id = ?',
      )
      .run(this.now(), state, summary.slice(0, 4000), stopReason?.slice(0, 2000) ?? null, id);
  }

  run(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as R | undefined;
    return r ? toRun(r) : null;
  }

  runs(projectId: string, o: { since?: number; limit?: number } = {}): RunRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM automation_runs WHERE project_id = ? AND started_at >= ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
        )
        .all(projectId, o.since ?? 0, o.limit ?? 50) as R[]
    ).map(toRun);
  }

  addItem(i: Omit<ItemRow, 'id' | 'at'> & { projectId: string }): void {
    this.db
      .prepare(
        `INSERT INTO automation_run_items (run_id, project_id, code, page_id, page_name, outcome, reason_code, reason,
           job_id, proposal_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.runId,
        i.projectId,
        i.code,
        i.pageId,
        i.pageName?.slice(0, 500) ?? null,
        i.outcome,
        i.reasonCode,
        i.reason?.slice(0, 2000) ?? null,
        i.jobId,
        i.proposalId,
        this.now(),
      );
  }

  items(runId: string): ItemRow[] {
    return (
      this.db.prepare('SELECT * FROM automation_run_items WHERE run_id = ? ORDER BY id').all(runId) as R[]
    ).map(toItem);
  }

  /** v3 F10 (ADR 0078, C5): the newest items of several codes (the Chronology page's repairs). */
  itemsOfCodes(projectId: string, codes: readonly string[], limit = 50): ItemRow[] {
    if (codes.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM automation_run_items WHERE project_id = ? AND code IN (${codes.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ?`,
        )
        .all(projectId, ...codes, limit) as R[]
    ).map(toItem);
  }

  /** The newest items of a code (the Automation page's "what was done or skipped"). */
  codeItems(projectId: string, code: string, limit = 20): ItemRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM automation_run_items WHERE project_id = ? AND code = ? ORDER BY id DESC LIMIT ?',
        )
        .all(projectId, code, limit) as R[]
    ).map(toItem);
  }

  // ---------------------------------------------------------------------------------------------- paragraphs

  paragraph(projectId: string, code: string): ParagraphRow | null {
    const r = this.db
      .prepare('SELECT * FROM automation_paragraphs WHERE project_id = ? AND code = ?')
      .get(projectId, code) as R | undefined;
    return r ? toParagraph(r) : null;
  }

  paragraphs(projectId: string): ParagraphRow[] {
    return (
      this.db.prepare('SELECT * FROM automation_paragraphs WHERE project_id = ?').all(projectId) as R[]
    ).map(toParagraph);
  }

  setParagraph(p: Omit<ParagraphRow, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO automation_paragraphs (project_id, code, resource_id, document_id, block_id, text, job_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, code) DO UPDATE SET resource_id = excluded.resource_id,
           document_id = excluded.document_id, block_id = excluded.block_id, text = excluded.text,
           job_id = excluded.job_id, updated_at = excluded.updated_at`,
      )
      .run(p.projectId, p.code, p.resourceId, p.documentId, p.blockId, p.text, p.jobId, this.now());
  }

  removeParagraph(projectId: string, code: string): void {
    this.db
      .prepare('DELETE FROM automation_paragraphs WHERE project_id = ? AND code = ?')
      .run(projectId, code);
  }

  // ---------------------------------------------------------------------------------------------- governance jobs

  recordGovernanceJob(g: Omit<GovernanceJobRow, 'at'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO automation_governance_jobs (job_id, project_id, code, kind, change_id, resource_id,
           document_id, block_id, before_version, before_blocks, planned_blocks, previous_text, text, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.jobId,
        g.projectId,
        g.code,
        g.kind,
        g.changeId,
        g.resourceId,
        g.documentId,
        g.blockId,
        g.beforeVersion,
        JSON.stringify(g.beforeBlocks),
        JSON.stringify(g.plannedBlocks),
        g.previousText,
        g.text,
        this.now(),
      );
  }

  governanceJob(projectId: string, jobId: string): GovernanceJobRow | null {
    const r = this.db
      .prepare('SELECT * FROM automation_governance_jobs WHERE project_id = ? AND job_id = ?')
      .get(projectId, jobId) as R | undefined;
    if (!r) return null;
    return {
      jobId: String(r.job_id),
      projectId: String(r.project_id),
      code: String(r.code),
      kind: String(r.kind) as GovernanceJobRow['kind'],
      changeId: num(r.change_id),
      resourceId: String(r.resource_id),
      documentId: String(r.document_id),
      blockId: String(r.block_id),
      beforeVersion: String(r.before_version),
      beforeBlocks: JSON.parse(String(r.before_blocks)) as unknown[],
      plannedBlocks: JSON.parse(String(r.planned_blocks)) as unknown[],
      previousText: str(r.previous_text),
      text: String(r.text),
      at: Number(r.at),
    };
  }
}

function toSetting(r: R): SettingRow {
  return {
    projectId: String(r.project_id),
    code: String(r.code),
    mode: String(r.mode) as Mode,
    updatedAt: Number(r.updated_at),
    updatedBy: String(r.updated_by),
    pausedAt: num(r.paused_at),
    pausedReason: str(r.paused_reason),
    stoppedAt: num(r.stopped_at),
    stoppedReason: str(r.stopped_reason),
    skipReason: str(r.skip_reason),
    skipStreak: Number(r.skip_streak ?? 0),
    governancePending: str(r.governance_pending),
  };
}

function toRun(r: R): RunRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    trigger: String(r.trigger),
    startedAt: Number(r.started_at),
    finishedAt: num(r.finished_at),
    state: String(r.state) as RunState,
    summary: str(r.summary),
    stopReason: str(r.stop_reason),
  };
}

function toItem(r: R): ItemRow {
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    code: String(r.code),
    pageId: str(r.page_id),
    pageName: str(r.page_name),
    outcome: String(r.outcome) as ItemOutcome,
    reasonCode: str(r.reason_code),
    reason: str(r.reason),
    jobId: str(r.job_id),
    proposalId: str(r.proposal_id),
    at: Number(r.at),
  };
}

function toParagraph(r: R): ParagraphRow {
  return {
    projectId: String(r.project_id),
    code: String(r.code),
    resourceId: String(r.resource_id),
    documentId: String(r.document_id),
    blockId: String(r.block_id),
    text: String(r.text),
    jobId: str(r.job_id),
    updatedAt: Number(r.updated_at),
  };
}
