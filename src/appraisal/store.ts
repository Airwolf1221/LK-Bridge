/**
 * The appraisal's stored runs (v3 F3c, ADR 0054; the design's decision D4): the latest run of each tool, per project and
 * scope (a page, a branch, everything), with its report, in the bridge's own database. Nothing goes to LegendKeeper.
 *
 * A new run of the same scope replaces the last one and is compared with it (findings new, still present, gone), as
 * the audits compare runs. Each finding is kept by its id (a fingerprint: the same finding has the same id in every
 * run), so "Propose a fix" and paging find it without the report being sent again.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { AppraisalFinding, AppraisalReport, AppraisalTool } from './types.js';

type Obj = Record<string, unknown>;

/** The most stored scopes per project and tool (the oldest go first). */
export const MAX_RUNS_PER_TOOL = 100;

export interface RunView {
  readonly id: string;
  readonly tool: AppraisalTool;
  readonly scopeKey: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly actor: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly compared: AppraisalReport['compared'] | null;
}

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const newRunId = (): string => `apr_${randomBytes(8).toString('hex')}`;

export class AppraisalStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Stores a run (replacing the last one of its scope) and returns its comparison with it. */
  save(
    projectId: string,
    o: {
      readonly report: AppraisalReport;
      readonly scopeKey: string;
      readonly actor: string;
      readonly startedAt: number;
    },
  ): AppraisalReport {
    const db = this.db;
    const finishedAt = this.now();
    const prev = db
      .prepare(
        'SELECT id, finished_at FROM appraisal_runs WHERE project_id = ? AND tool = ? AND scope_key = ?',
      )
      .get(projectId, o.report.tool, o.scopeKey) as { id: string; finished_at: number } | undefined;
    let compared: AppraisalReport['compared'];
    if (prev) {
      const before = new Set(
        (
          db
            .prepare('SELECT id FROM appraisal_findings WHERE project_id = ? AND run_id = ?')
            .all(projectId, prev.id) as {
            id: string;
          }[]
        ).map((r) => r.id),
      );
      const now = new Set(o.report.findings.map((f) => f.id));
      compared = {
        new: [...now].filter((id) => !before.has(id)).length,
        still: [...now].filter((id) => before.has(id)).length,
        gone: [...before].filter((id) => !now.has(id)).length,
        previousRunAt: new Date(prev.finished_at).toISOString(),
      };
    }
    const report: AppraisalReport = { ...o.report, ...(compared ? { compared } : {}) };
    db.transaction(() => {
      if (prev) {
        db.prepare('DELETE FROM appraisal_findings WHERE project_id = ? AND run_id = ?').run(
          projectId,
          prev.id,
        );
        db.prepare('DELETE FROM appraisal_runs WHERE id = ?').run(prev.id);
      }
      db.prepare(
        `INSERT INTO appraisal_runs (id, project_id, tool, scope_key, scope, actor, started_at, finished_at, duration_ms,
           source, counts, compared, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        report.runId,
        projectId,
        report.tool,
        o.scopeKey,
        JSON.stringify(report.scope),
        o.actor,
        o.startedAt,
        finishedAt,
        Math.max(0, finishedAt - o.startedAt),
        JSON.stringify(report.source),
        JSON.stringify(report.counts),
        compared ? JSON.stringify(compared) : null,
        JSON.stringify(report),
      );
      const ins = db.prepare(
        `INSERT OR REPLACE INTO appraisal_findings (project_id, run_id, id, tool, check_id, page_id, finding)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of report.findings)
        ins.run(projectId, report.runId, f.id, f.tool, f.check, f.page?.id ?? null, JSON.stringify(f));
      // Only the newest scopes of each tool are kept.
      const old = db
        .prepare(
          `SELECT id FROM appraisal_runs WHERE project_id = ? AND tool = ? ORDER BY finished_at DESC, id DESC
           LIMIT -1 OFFSET ?`,
        )
        .all(projectId, report.tool, MAX_RUNS_PER_TOOL) as { id: string }[];
      for (const r of old) {
        db.prepare('DELETE FROM appraisal_findings WHERE project_id = ? AND run_id = ?').run(projectId, r.id);
        db.prepare('DELETE FROM appraisal_runs WHERE id = ?').run(r.id);
      }
    })();
    return report;
  }

  /** A stored run's report. */
  report(projectId: string, runId: string): AppraisalReport | null {
    const r = this.db
      .prepare('SELECT report FROM appraisal_runs WHERE project_id = ? AND id = ?')
      .get(projectId, runId) as { report: string } | undefined;
    return r ? json<AppraisalReport | null>(r.report, null) : null;
  }

  /** The latest stored runs (newest first), optionally of one tool. */
  runs(projectId: string, o: { readonly tool?: string; readonly limit?: number } = {}): RunView[] {
    const rows = this.db
      .prepare(
        `SELECT id, tool, scope_key, scope, actor, started_at, finished_at, duration_ms, counts, compared
         FROM appraisal_runs WHERE project_id = ? ${o.tool ? 'AND tool = ?' : ''}
         ORDER BY finished_at DESC, id DESC LIMIT ?`,
      )
      .all(...(o.tool ? [projectId, o.tool] : [projectId]), o.limit ?? 50) as Obj[];
    return rows.map((r) => ({
      id: String(r.id),
      tool: String(r.tool) as AppraisalTool,
      scopeKey: String(r.scope_key),
      scope: json<Record<string, unknown>>(r.scope, {}),
      actor: String(r.actor),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      durationMs: Number(r.duration_ms),
      counts: json<Record<string, number>>(r.counts, {}),
      compared: json<AppraisalReport['compared'] | null>(r.compared, null),
    }));
  }

  /** A finding by its id, from the newest stored run that holds it. */
  finding(projectId: string, id: string): { finding: AppraisalFinding; runId: string } | null {
    const r = this.db
      .prepare(
        `SELECT f.finding, f.run_id FROM appraisal_findings f JOIN appraisal_runs r ON r.id = f.run_id
         WHERE f.project_id = ? AND f.id = ? ORDER BY r.finished_at DESC LIMIT 1`,
      )
      .get(projectId, id) as { finding: string; run_id: string } | undefined;
    if (!r) return null;
    const finding = json<AppraisalFinding | null>(r.finding, null);
    return finding ? { finding, runId: r.run_id } : null;
  }
}
