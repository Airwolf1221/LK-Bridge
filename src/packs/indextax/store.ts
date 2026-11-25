/** v3 F6b (ADR 0079): the owner's index classification decisions (migration 4710). */
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/open.js';
import { prepared } from '../../db/statements.js';
import type { IndexRole } from '../../tree/classify.js';
import type { SubjectKind } from './rules.js';

export type IndexDecisionAction = 'approve' | 'change' | 'undecided';
export type IndexDecisionVia = 'approve' | 'change' | 'undecided' | 'bulk';

export interface IndexRoleDecision {
  readonly id: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly action: IndexDecisionAction;
  /** The decided role (null: left undecided). */
  readonly role: IndexRole | null;
  readonly subject: SubjectKind | null;
  readonly proposed: string | null;
  readonly rule: string | null;
  readonly via: IndexDecisionVia;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

interface Row {
  id: string;
  project_id: string;
  page_id: string;
  page_name: string;
  action: IndexDecisionAction;
  role: IndexRole | null;
  subject: SubjectKind | null;
  proposed: string | null;
  rule: string | null;
  via: IndexDecisionVia;
  reason: string;
  by: string;
  at: number;
}

const view = (r: Row): IndexRoleDecision => ({
  id: r.id,
  projectId: r.project_id,
  pageId: r.page_id,
  pageName: r.page_name,
  action: r.action,
  role: r.role,
  subject: r.subject,
  proposed: r.proposed,
  rule: r.rule,
  via: r.via,
  reason: r.reason,
  by: r.by,
  at: r.at,
});

export type DecisionInput = Omit<IndexRoleDecision, 'id' | 'projectId' | 'at' | 'by'>;

export class IndexRoleStore {
  /** Bumped by every change (the report's rows are cached on it). */
  private changes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  version(): number {
    return this.changes;
  }

  decisions(projectId: string): IndexRoleDecision[] {
    return (
      prepared(this.db, 'SELECT * FROM index_role_decisions WHERE project_id = ? ORDER BY at, id').all(
        projectId,
      ) as Row[]
    ).map(view);
  }

  decision(projectId: string, pageId: string): IndexRoleDecision | null {
    const r = prepared(
      this.db,
      'SELECT * FROM index_role_decisions WHERE project_id = ? AND page_id = ?',
    ).get(projectId, pageId) as Row | undefined;
    return r ? view(r) : null;
  }

  /** Records (or replaces) the decision on one page. Run inside the caller's transaction for a bulk approve. */
  put(projectId: string, by: string, d: DecisionInput): IndexRoleDecision {
    const id = `icd_${randomBytes(8).toString('hex')}`;
    const at = this.now();
    prepared(
      this.db,
      `INSERT INTO index_role_decisions
         (id, project_id, page_id, page_name, action, role, subject, proposed, rule, via, reason, by, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE SET
         id = excluded.id, page_name = excluded.page_name, action = excluded.action, role = excluded.role,
         subject = excluded.subject, proposed = excluded.proposed, rule = excluded.rule, via = excluded.via,
         reason = excluded.reason, by = excluded.by, at = excluded.at`,
    ).run(
      id,
      projectId,
      d.pageId,
      d.pageName.slice(0, 500),
      d.action,
      d.role,
      d.subject,
      d.proposed,
      d.rule,
      d.via,
      d.reason.slice(0, 1000),
      by,
      at,
    );
    this.changes++;
    return this.decision(projectId, d.pageId)!;
  }

  /** Several decisions in ONE transaction (all or none). */
  putMany(projectId: string, by: string, ds: readonly DecisionInput[]): IndexRoleDecision[] {
    return this.db.transaction(() => ds.map((d) => this.put(projectId, by, d)))();
  }

  /** Removes the decision on a page (the row goes back to its proposal). */
  remove(projectId: string, pageId: string): boolean {
    const n = prepared(this.db, 'DELETE FROM index_role_decisions WHERE project_id = ? AND page_id = ?').run(
      projectId,
      pageId,
    ).changes;
    if (n > 0) this.changes++;
    return n > 0;
  }
}
