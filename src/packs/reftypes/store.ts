/**
 * v3 F6a (ADR 0076): the owner's Reference Type decisions and the vocabulary's publications (migration 4500).
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/open.js';

export type DecisionAction = 'map' | 'reject' | 'specialist';
export type DecisionVia = 'accept' | 'edit' | 'reject' | 'specialist' | 'bulk';

export interface ReferenceTypeDecision {
  readonly id: string;
  readonly projectId: string;
  readonly value: string;
  /** The primary category ('' when the pages have none). */
  readonly category: string;
  readonly action: DecisionAction;
  readonly target: string | null;
  readonly targetNew: boolean;
  readonly role: string | null;
  readonly pages: readonly { readonly id: string; readonly name: string }[] | null;
  readonly via: DecisionVia;
  readonly suggestion: string | null;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
  readonly publishedAt: number | null;
  readonly appliedCount: number;
  readonly appliedAt: number | null;
}

export interface Publication {
  readonly id: string;
  readonly projectId: string;
  readonly jobId: string | null;
  readonly replaced: boolean;
  readonly text: string;
  readonly decisions: readonly string[];
  readonly state: 'submitted' | 'succeeded' | 'failed';
  readonly by: string;
  readonly at: number;
}

interface DecisionRow {
  id: string;
  project_id: string;
  value: string;
  category: string;
  action: DecisionAction;
  target: string | null;
  target_new: number;
  role: string | null;
  pages: string | null;
  via: DecisionVia;
  suggestion: string | null;
  reason: string;
  by: string;
  at: number;
  published_at: number | null;
  applied_count: number;
  applied_at: number | null;
}

interface PublicationRow {
  id: string;
  project_id: string;
  job_id: string | null;
  replaced: number;
  text: string;
  decisions: string;
  state: Publication['state'];
  by: string;
  at: number;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const decisionOf = (r: DecisionRow): ReferenceTypeDecision => ({
  id: r.id,
  projectId: r.project_id,
  value: r.value,
  category: r.category,
  action: r.action,
  target: r.target,
  targetNew: r.target_new === 1,
  role: r.role,
  pages: r.pages === null ? null : parse<{ id: string; name: string }[]>(r.pages, []),
  via: r.via,
  suggestion: r.suggestion,
  reason: r.reason,
  by: r.by,
  at: r.at,
  publishedAt: r.published_at,
  appliedCount: r.applied_count,
  appliedAt: r.applied_at,
});

const publicationOf = (r: PublicationRow): Publication => ({
  id: r.id,
  projectId: r.project_id,
  jobId: r.job_id,
  replaced: r.replaced === 1,
  text: r.text,
  decisions: parse<string[]>(r.decisions, []),
  state: r.state,
  by: r.by,
  at: r.at,
});

export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;

export class ReferenceTypeStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  decisions(projectId: string): ReferenceTypeDecision[] {
    return (
      this.db
        .prepare('SELECT * FROM reference_type_decisions WHERE project_id = ? ORDER BY at, id')
        .all(projectId) as DecisionRow[]
    ).map(decisionOf);
  }

  decision(projectId: string, id: string): ReferenceTypeDecision | null {
    const r = this.db
      .prepare('SELECT * FROM reference_type_decisions WHERE project_id = ? AND id = ?')
      .get(projectId, id) as DecisionRow | undefined;
    return r ? decisionOf(r) : null;
  }

  decisionFor(projectId: string, value: string, category: string): ReferenceTypeDecision | null {
    const r = this.db
      .prepare(
        'SELECT * FROM reference_type_decisions WHERE project_id = ? AND value_key = ? AND category = ?',
      )
      .get(projectId, value, category) as DecisionRow | undefined;
    return r ? decisionOf(r) : null;
  }

  /** Records a decision (a value and category decided once: an existing one is refused by the caller first). */
  insert(
    d: Omit<ReferenceTypeDecision, 'id' | 'at' | 'publishedAt' | 'appliedCount' | 'appliedAt'>,
  ): ReferenceTypeDecision {
    const id = newId('rtd');
    this.db
      .prepare(
        `INSERT INTO reference_type_decisions
          (id, project_id, value, value_key, category, action, target, target_new, role, pages, via, suggestion,
           reason, by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.projectId,
        d.value,
        d.value,
        d.category,
        d.action,
        d.target,
        d.targetNew ? 1 : 0,
        d.role,
        d.pages === null ? null : JSON.stringify(d.pages),
        d.via,
        d.suggestion,
        d.reason.slice(0, 1000),
        d.by,
        this.now(),
      );
    return this.decision(d.projectId, id)!;
  }

  remove(projectId: string, id: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM reference_type_decisions WHERE project_id = ? AND id = ?')
        .run(projectId, id).changes > 0
    );
  }

  markApplied(projectId: string, id: string): void {
    this.db
      .prepare(
        'UPDATE reference_type_decisions SET applied_count = applied_count + 1, applied_at = ? WHERE project_id = ? AND id = ?',
      )
      .run(this.now(), projectId, id);
  }

  markPublished(projectId: string, ids: readonly string[], at: number): void {
    const stmt = this.db.prepare(
      'UPDATE reference_type_decisions SET published_at = COALESCE(published_at, ?) WHERE project_id = ? AND id = ?',
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, projectId, id);
    })();
  }

  recordPublication(p: Omit<Publication, 'id' | 'at' | 'state'>): Publication {
    const id = newId('rtp');
    this.db
      .prepare(
        `INSERT INTO reference_type_publications (id, project_id, job_id, replaced, text, decisions, state, by, at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      )
      .run(
        id,
        p.projectId,
        p.jobId,
        p.replaced ? 1 : 0,
        p.text,
        JSON.stringify(p.decisions),
        p.by,
        this.now(),
      );
    return this.publication(id)!;
  }

  publication(id: string): Publication | null {
    const r = this.db.prepare('SELECT * FROM reference_type_publications WHERE id = ?').get(id) as
      PublicationRow | undefined;
    return r ? publicationOf(r) : null;
  }

  publicationByJob(jobId: string): Publication | null {
    const r = this.db.prepare('SELECT * FROM reference_type_publications WHERE job_id = ?').get(jobId) as
      PublicationRow | undefined;
    return r ? publicationOf(r) : null;
  }

  publications(projectId: string, limit = 20): Publication[] {
    return (
      this.db
        .prepare('SELECT * FROM reference_type_publications WHERE project_id = ? ORDER BY at DESC LIMIT ?')
        .all(projectId, limit) as PublicationRow[]
    ).map(publicationOf);
  }

  setPublicationState(id: string, state: Publication['state']): void {
    this.db.prepare('UPDATE reference_type_publications SET state = ? WHERE id = ?').run(state, id);
  }
}
