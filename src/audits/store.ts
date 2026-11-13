/**
 * The audits' storage (v2 E2, ADR 0044; migration 2300): the per-project config, the runs, the findings tracked across
 * runs, and the owner's acknowledgements. Synchronous, like every other store.
 *
 * Tracking. A finding is one row, identified by its fingerprint (code, page, document, block and the check's own key).
 * A run that sees it again updates it (`last_seen_run`); one that does not see it marks it gone (`resolved_run`,
 * `resolved_at`); one that sees a gone finding again reopens it as new. Only a run that completed commits, so a failed run
 * never marks the world "resolved".
 *
 * Acknowledging. An acknowledgement is tied to the finding's fingerprint and the hash of its evidence. It hides the
 * finding from the default view while the evidence is the same, and lapses (the finding shows again, marked) when the
 * evidence changes. It is kept when the finding goes, so a finding that comes back unchanged is still acknowledged.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import { stableJson } from '../jobs/sidebar-state.js';
import {
  auditSettingsSchema,
  DEFAULT_AUDIT_SETTINGS,
  EMPTY_AUDIT_CONFIG,
  ruleSchema,
  tagSourceSchema,
  type AuditConfig,
  type AuditConfigInput,
  type AuditRule,
} from './config.js';
import { sha1 } from './model.js';
import {
  CATEGORIES,
  type AuditRun,
  type Category,
  type Finding,
  type FindingCode,
  type FindingSource,
  type FixSpec,
  type RunCounts,
  type Severity,
} from './types.js';

type Obj = Record<string, unknown>;
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** A finding ready to be stored (the runner has added the page, the source and the fingerprint). */
export interface StoredDraft {
  readonly fingerprint: string;
  readonly code: FindingCode;
  readonly category: Category;
  readonly severity: Severity;
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly pagePath: string | null;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly message: string;
  readonly evidence: Obj;
  readonly source: FindingSource;
  readonly fix: FixSpec | null;
}

export const fingerprintOf = (
  projectId: string,
  d: {
    code: string;
    pageId: string | null;
    documentId: string | null;
    blockId: string | null;
    key?: string | undefined;
  },
): string =>
  sha1([projectId, d.code, d.pageId ?? '', d.documentId ?? '', d.blockId ?? '', d.key ?? ''].join('|'));

export const evidenceHashOf = (evidence: Obj): string => sha1(stableJson(evidence));

export interface FindingFilter {
  readonly category?: readonly string[];
  readonly code?: readonly string[];
  readonly severity?: readonly string[];
  /** A fragment of the page's path or name (case-insensitive). */
  readonly page?: string;
  readonly pageId?: string;
  /** First seen in the latest run. */
  readonly onlyNew?: boolean;
  /** `hide` (default): not acknowledged; `only`: acknowledged; `include`: both. */
  readonly acknowledged?: 'hide' | 'only' | 'include';
  /** `open` (default), `gone` or `all`. */
  readonly state?: 'open' | 'gone' | 'all';
  readonly limit?: number;
  readonly offset?: number;
}

interface Row {
  id: number;
  project_id: string;
  fingerprint: string;
  code: string;
  category: string;
  severity: string;
  page_id: string | null;
  page_name: string | null;
  page_path: string | null;
  document_id: string | null;
  block_id: string | null;
  message: string;
  evidence: string;
  evidence_hash: string;
  source: string;
  fix: string | null;
  state: string;
  first_seen_run: string;
  first_seen_at: number;
  last_seen_run: string;
  last_seen_at: number;
  resolved_run: string | null;
  resolved_at: number | null;
  ack_reason: string | null;
  ack_by: string | null;
  ack_at: number | null;
  ack_hash: string | null;
}

const SELECT = `SELECT f.*, a.reason AS ack_reason, a.acked_by AS ack_by, a.acked_at AS ack_at, a.evidence_hash AS ack_hash
  FROM audit_findings f LEFT JOIN audit_acks a ON a.project_id = f.project_id AND a.fingerprint = f.fingerprint`;

const findingOf = (r: Row): Finding => {
  const acked = r.ack_hash !== null && r.ack_hash === r.evidence_hash;
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprint: r.fingerprint,
    code: r.code as FindingCode,
    category: r.category as Category,
    severity: r.severity as Severity,
    pageId: r.page_id,
    pageName: r.page_name,
    pagePath: r.page_path,
    documentId: r.document_id,
    blockId: r.block_id,
    message: r.message,
    evidence: parse<Obj>(r.evidence, {}),
    evidenceHash: r.evidence_hash,
    source: parse<FindingSource>(r.source, { kind: 'bridge', takenAt: 0, ageMs: 0 }),
    fix: parse<FixSpec | null>(r.fix, null),
    state: r.state as 'open' | 'gone',
    firstSeenRun: r.first_seen_run,
    firstSeenAt: r.first_seen_at,
    lastSeenRun: r.last_seen_run,
    lastSeenAt: r.last_seen_at,
    resolvedRun: r.resolved_run,
    resolvedAt: r.resolved_at,
    acknowledgement: acked ? { reason: r.ack_reason ?? '', by: r.ack_by ?? '', at: r.ack_at ?? 0 } : null,
    acknowledgementLapsed: r.ack_hash !== null && !acked,
  };
};

interface RunRow {
  id: string;
  project_id: string;
  trigger: string;
  state: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  snapshot_id: string | null;
  snapshot_taken_at: number | null;
  snapshot_age_ms: number | null;
  change_snapshots: number;
  newest_snapshot_id: string | null;
  stale: number;
  pages: number;
  counts: string | null;
  summary: string | null;
  error: string | null;
}

const runOf = (r: RunRow): AuditRun => ({
  id: r.id,
  projectId: r.project_id,
  trigger: r.trigger,
  state: r.state as AuditRun['state'],
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  snapshotId: r.snapshot_id,
  snapshotTakenAt: r.snapshot_taken_at,
  snapshotAgeMs: r.snapshot_age_ms,
  changeSnapshots: r.change_snapshots,
  newestSnapshotId: r.newest_snapshot_id,
  stale: r.stale === 1,
  pages: r.pages,
  counts: parse<RunCounts | null>(r.counts, null),
  summary: r.summary,
  error: r.error,
});

const GONE_RETENTION_MS = 90 * 86_400_000;

export class AuditStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ------------------------------------------------------------------------------------------ config

  config(projectId: string): AuditConfig {
    const r = this.db.prepare('SELECT * FROM audit_config WHERE project_id = ?').get(projectId) as
      | {
          rules: string | null;
          tag_source: string | null;
          settings: string;
          updated_at: number;
          updated_by: string;
        }
      | undefined;
    if (!r) return EMPTY_AUDIT_CONFIG;
    const rules = r.rules === null ? null : ruleListOf(parse<unknown>(r.rules, null));
    const ts = tagSourceSchema.safeParse(parse<unknown>(r.tag_source, null));
    const st = auditSettingsSchema.safeParse(parse<unknown>(r.settings, {}));
    return {
      rules,
      tagSource: ts.success ? ts.data : null,
      settings: st.success ? st.data : DEFAULT_AUDIT_SETTINGS,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  }

  /** Applies a validated input (a field left out is kept) and returns the config before and after. */
  setConfig(
    projectId: string,
    input: AuditConfigInput,
    by: string,
  ): { before: AuditConfig; after: AuditConfig } {
    const before = this.config(projectId);
    const rules = input.rules === undefined ? before.rules : input.rules;
    const tagSource = input.tagSource === undefined ? before.tagSource : input.tagSource;
    const settings = auditSettingsSchema.parse({ ...before.settings, ...(input.settings ?? {}) });
    this.db
      .prepare(
        `INSERT INTO audit_config (project_id, rules, tag_source, settings, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET rules = excluded.rules, tag_source = excluded.tag_source,
           settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        projectId,
        rules === null ? null : JSON.stringify(rules),
        tagSource === null ? null : JSON.stringify(tagSource),
        JSON.stringify(settings),
        this.now(),
        by,
      );
    return { before, after: this.config(projectId) };
  }

  // ------------------------------------------------------------------------------------------ runs

  startRun(projectId: string, trigger: string): AuditRun {
    const id = `aud_${randomBytes(8).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO audit_runs (id, project_id, trigger, state, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(id, projectId, trigger, this.now());
    return this.run(id)!;
  }

  run(id: string): AuditRun | null {
    const r = this.db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? runOf(r) : null;
  }

  runs(projectId: string, limit = 30): AuditRun[] {
    return (
      this.db
        .prepare('SELECT * FROM audit_runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(projectId, limit) as RunRow[]
    ).map(runOf);
  }

  /** The newest run that completed (its findings are what the views show as current). */
  latestRun(projectId: string): AuditRun | null {
    const r = this.db
      .prepare(
        `SELECT * FROM audit_runs WHERE project_id = ? AND state = 'succeeded' ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId) as RunRow | undefined;
    return r ? runOf(r) : null;
  }

  runningRun(projectId: string): AuditRun | null {
    const r = this.db
      .prepare(
        `SELECT * FROM audit_runs WHERE project_id = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(projectId) as RunRow | undefined;
    return r ? runOf(r) : null;
  }

  /** A run a restart left running is closed as failed. */
  closeStaleRuns(projectId?: string): void {
    this.db
      .prepare(
        `UPDATE audit_runs SET state = 'failed', error = 'interrupted (the bridge stopped)', finished_at = ?
         WHERE state = 'running' ${projectId ? 'AND project_id = ?' : ''}`,
      )
      .run(...(projectId ? [this.now(), projectId] : [this.now()]));
  }

  finishRun(
    id: string,
    patch: {
      readonly state: 'succeeded' | 'failed' | 'skipped';
      readonly snapshotId?: string | null;
      readonly snapshotTakenAt?: number | null;
      readonly snapshotAgeMs?: number | null;
      readonly changeSnapshots?: number;
      readonly newestSnapshotId?: string | null;
      readonly stale?: boolean;
      readonly pages?: number;
      readonly counts?: RunCounts | null;
      readonly summary?: string | null;
      readonly error?: string | null;
    },
  ): AuditRun | null {
    const run = this.run(id);
    if (!run) return null;
    const t = this.now();
    this.db
      .prepare(
        `UPDATE audit_runs SET state = ?, finished_at = ?, duration_ms = ?, snapshot_id = ?, snapshot_taken_at = ?,
           snapshot_age_ms = ?, change_snapshots = ?, newest_snapshot_id = ?, stale = ?, pages = ?, counts = ?, summary = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        patch.state,
        t,
        Math.max(0, t - run.startedAt),
        patch.snapshotId ?? null,
        patch.snapshotTakenAt ?? null,
        patch.snapshotAgeMs ?? null,
        patch.changeSnapshots ?? 0,
        patch.newestSnapshotId ?? null,
        patch.stale ? 1 : 0,
        patch.pages ?? 0,
        patch.counts ? JSON.stringify(patch.counts) : null,
        patch.summary ?? null,
        patch.error ?? null,
        id,
      );
    return this.run(id);
  }

  // ------------------------------------------------------------------------------------------ findings

  /**
   * Commits a completed run's findings: new ones inserted, ones seen again updated (still present), a gone one that
   * returns reopened as new, and open ones not seen marked gone. Returns the run's counts.
   */
  commit(projectId: string, runId: string, drafts: readonly StoredDraft[]): RunCounts {
    const t = this.now();
    const byCategory: Record<string, Record<Severity, number>> = {};
    let fresh = 0;
    let still = 0;
    let gone = 0;
    this.db.transaction(() => {
      const existing = new Map(
        (
          this.db
            .prepare('SELECT id, fingerprint, state FROM audit_findings WHERE project_id = ?')
            .all(projectId) as { id: number; fingerprint: string; state: string }[]
        ).map((r) => [r.fingerprint, r]),
      );
      const ins = this.db.prepare(
        `INSERT INTO audit_findings (project_id, fingerprint, code, category, severity, page_id, page_name, page_path, document_id,
           block_id, message, evidence, evidence_hash, source, fix, state, first_seen_run, first_seen_at, last_seen_run, last_seen_at)
         VALUES (@projectId, @fingerprint, @code, @category, @severity, @pageId, @pageName, @pagePath, @documentId, @blockId,
           @message, @evidence, @evidenceHash, @source, @fix, 'open', @run, @t, @run, @t)`,
      );
      const upd = this.db.prepare(
        `UPDATE audit_findings SET code = @code, category = @category, severity = @severity, page_id = @pageId, page_name = @pageName,
           page_path = @pagePath, document_id = @documentId, block_id = @blockId, message = @message, evidence = @evidence,
           evidence_hash = @evidenceHash, source = @source, fix = @fix, last_seen_run = @run, last_seen_at = @t WHERE id = @id`,
      );
      const reopen = this.db.prepare(
        `UPDATE audit_findings SET code = @code, category = @category, severity = @severity, page_id = @pageId, page_name = @pageName,
           page_path = @pagePath, document_id = @documentId, block_id = @blockId, message = @message, evidence = @evidence,
           evidence_hash = @evidenceHash, source = @source, fix = @fix, state = 'open', first_seen_run = @run, first_seen_at = @t,
           last_seen_run = @run, last_seen_at = @t, resolved_run = NULL, resolved_at = NULL WHERE id = @id`,
      );
      const seen = new Set<string>();
      for (const d of drafts) {
        if (seen.has(d.fingerprint)) continue; // a check that reports the same finding twice counts once
        seen.add(d.fingerprint);
        const row = {
          projectId,
          fingerprint: d.fingerprint,
          code: d.code,
          category: d.category,
          severity: d.severity,
          pageId: d.pageId,
          pageName: d.pageName,
          pagePath: d.pagePath,
          documentId: d.documentId,
          blockId: d.blockId,
          message: d.message,
          evidence: JSON.stringify(d.evidence),
          evidenceHash: evidenceHashOf(d.evidence),
          source: JSON.stringify(d.source),
          fix: d.fix ? JSON.stringify(d.fix) : null,
          run: runId,
          t,
        };
        const prev = existing.get(d.fingerprint);
        if (!prev) {
          ins.run(row);
          fresh++;
        } else if (prev.state === 'open') {
          upd.run({ ...row, id: prev.id });
          still++;
        } else {
          reopen.run({ ...row, id: prev.id });
          fresh++;
        }
        const c = (byCategory[d.category] ??= { error: 0, warning: 0, info: 0 });
        c[d.severity]++;
      }
      const goneStmt = this.db.prepare(
        `UPDATE audit_findings SET state = 'gone', resolved_run = ?, resolved_at = ? WHERE id = ?`,
      );
      for (const [fp, r] of existing)
        if (r.state === 'open' && !seen.has(fp)) {
          goneStmt.run(runId, t, r.id);
          gone++;
        }
      this.db
        .prepare(`DELETE FROM audit_findings WHERE project_id = ? AND state = 'gone' AND resolved_at < ?`)
        .run(projectId, t - GONE_RETENTION_MS);
    })();
    const acked = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_findings f JOIN audit_acks a ON a.project_id = f.project_id AND a.fingerprint = f.fingerprint
           WHERE f.project_id = ? AND f.state = 'open' AND a.evidence_hash = f.evidence_hash`,
        )
        .get(projectId) as { n: number }
    ).n;
    return { byCategory, open: fresh + still, acknowledged: acked, new: fresh, still, gone };
  }

  private where(
    projectId: string,
    f: FindingFilter,
    latestRun: string | null,
  ): { sql: string; args: unknown[] } {
    const w = ['f.project_id = ?'];
    const args: unknown[] = [projectId];
    const list = (col: string, v: readonly string[] | undefined) => {
      if (!v || v.length === 0) return;
      w.push(`${col} IN (${v.map(() => '?').join(', ')})`);
      args.push(...v);
    };
    list('f.category', f.category);
    list('f.code', f.code);
    list('f.severity', f.severity);
    const state = f.state ?? 'open';
    if (state !== 'all') {
      w.push('f.state = ?');
      args.push(state);
    }
    if (f.pageId) {
      w.push('f.page_id = ?');
      args.push(f.pageId);
    }
    if (f.page) {
      w.push(`(f.page_path LIKE ? ESCAPE '\\' OR f.page_name LIKE ? ESCAPE '\\')`);
      const like = `%${f.page.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (f.onlyNew) {
      w.push('f.first_seen_run = ?');
      args.push(latestRun ?? '');
    }
    const ack = f.acknowledged ?? 'hide';
    if (ack === 'hide') w.push('(a.fingerprint IS NULL OR a.evidence_hash <> f.evidence_hash)');
    if (ack === 'only') w.push('(a.fingerprint IS NOT NULL AND a.evidence_hash = f.evidence_hash)');
    return { sql: w.join(' AND '), args };
  }

  list(
    projectId: string,
    f: FindingFilter = {},
  ): { findings: Finding[]; total: number; latestRun: string | null } {
    const latest = this.latestRun(projectId)?.id ?? null;
    const { sql, args } = this.where(projectId, f, latest);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_findings f LEFT JOIN audit_acks a ON a.project_id = f.project_id AND a.fingerprint = f.fingerprint WHERE ${sql}`,
        )
        .get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `${SELECT} WHERE ${sql}
         ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, f.category, f.page_path, f.code, f.id
         LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(f.limit ?? 100, 1000), f.offset ?? 0) as Row[];
    return { findings: rows.map(findingOf), total, latestRun: latest };
  }

  get(projectId: string, id: number): Finding | null {
    const r = this.db.prepare(`${SELECT} WHERE f.project_id = ? AND f.id = ?`).get(projectId, id) as
      Row | undefined;
    return r ? findingOf(r) : null;
  }

  /** Open findings by category and severity (acknowledged ones counted apart), for the dashboard's summary. */
  summary(projectId: string): {
    byCategory: Record<string, Record<Severity, number>>;
    open: number;
    acknowledged: number;
    gone: number;
    new: number;
  } {
    const latest = this.latestRun(projectId)?.id ?? null;
    const byCategory: Record<string, Record<Severity, number>> = {};
    for (const c of CATEGORIES) byCategory[c] = { error: 0, warning: 0, info: 0 };
    let open = 0;
    let acknowledged = 0;
    for (const r of this.db
      .prepare(
        `SELECT f.category, f.severity, (a.fingerprint IS NOT NULL AND a.evidence_hash = f.evidence_hash) AS acked, COUNT(*) AS n
         FROM audit_findings f LEFT JOIN audit_acks a ON a.project_id = f.project_id AND a.fingerprint = f.fingerprint
         WHERE f.project_id = ? AND f.state = 'open' GROUP BY f.category, f.severity, acked`,
      )
      .all(projectId) as { category: string; severity: Severity; acked: number; n: number }[]) {
      if (r.acked) {
        acknowledged += r.n;
        continue;
      }
      open += r.n;
      (byCategory[r.category] ??= { error: 0, warning: 0, info: 0 })[r.severity] += r.n;
    }
    const gone = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_findings WHERE project_id = ? AND state = 'gone'`)
        .get(projectId) as { n: number }
    ).n;
    const fresh = latest
      ? (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM audit_findings WHERE project_id = ? AND state = 'open' AND first_seen_run = ?`,
            )
            .get(projectId, latest) as { n: number }
        ).n
      : 0;
    return { byCategory, open, acknowledged, gone, new: fresh };
  }

  /** The codes that have findings (for the dashboard's filter). */
  codes(projectId: string): { code: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT code, COUNT(*) AS n FROM audit_findings WHERE project_id = ? AND state = 'open' GROUP BY code ORDER BY code`,
      )
      .all(projectId) as { code: string; n: number }[];
  }

  // ------------------------------------------------------------------------------------------ acknowledgements

  acknowledge(projectId: string, findingId: number, reason: string, by: string): Finding | null {
    const f = this.get(projectId, findingId);
    if (!f) return null;
    this.db
      .prepare(
        `INSERT INTO audit_acks (project_id, fingerprint, evidence_hash, reason, acked_by, acked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, fingerprint) DO UPDATE SET evidence_hash = excluded.evidence_hash, reason = excluded.reason,
           acked_by = excluded.acked_by, acked_at = excluded.acked_at`,
      )
      .run(projectId, f.fingerprint, f.evidenceHash, reason, by, this.now());
    return this.get(projectId, findingId);
  }

  unacknowledge(projectId: string, findingId: number): Finding | null {
    const f = this.get(projectId, findingId);
    if (!f) return null;
    this.db
      .prepare('DELETE FROM audit_acks WHERE project_id = ? AND fingerprint = ?')
      .run(projectId, f.fingerprint);
    return this.get(projectId, findingId);
  }

  /** A finding's evidence and source updated by a re-check (the finding itself unchanged otherwise). */
  touch(
    projectId: string,
    id: number,
    patch: { evidence: Obj; message: string; source: FindingSource },
  ): void {
    this.db
      .prepare(
        `UPDATE audit_findings SET evidence = ?, evidence_hash = ?, message = ?, source = ? WHERE project_id = ? AND id = ?`,
      )
      .run(
        JSON.stringify(patch.evidence),
        evidenceHashOf(patch.evidence),
        patch.message,
        JSON.stringify(patch.source),
        projectId,
        id,
      );
  }

  markGone(projectId: string, id: number, runId: string): void {
    this.db
      .prepare(
        `UPDATE audit_findings SET state = 'gone', resolved_run = ?, resolved_at = ? WHERE project_id = ? AND id = ? AND state = 'open'`,
      )
      .run(runId, this.now(), projectId, id);
  }
}

/** The stored rules, validated one by one (a bad one is dropped, so a hand-edited row never breaks a run). */
function ruleListOf(v: unknown): AuditRule[] | null {
  if (!Array.isArray(v)) return null;
  const out: AuditRule[] = [];
  for (const r of v) {
    const p = ruleSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out;
}
