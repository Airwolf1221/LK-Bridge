/**
 * v3 F6c (ADR 0080): the owner's Nation Subindexes decisions (migration 4810) and the owner's "keep it here" rulings for
 * `category_home_mismatch` (migration 4820).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/open.js';
import { prepared } from '../../db/statements.js';

export type SubindexAction = 'accept' | 'map' | 'specialist' | 'not_subindex';
export type SubindexVia = 'accept' | 'accept_all' | 'map' | 'map_all' | 'specialist' | 'not_subindex';

export interface SubindexDecision {
  readonly id: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly nationId: string;
  readonly pageName: string;
  readonly action: SubindexAction;
  /** The role (accept and map only). */
  readonly role: string | null;
  /** The unified display name when decided (accept and map only). */
  readonly proposedName: string | null;
  readonly via: SubindexVia;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

interface Row {
  id: string;
  project_id: string;
  page_id: string;
  nation_id: string;
  page_name: string;
  action: SubindexAction;
  role: string | null;
  proposed_name: string | null;
  via: SubindexVia;
  reason: string;
  by: string;
  at: number;
}

const view = (r: Row): SubindexDecision => ({
  id: r.id,
  projectId: r.project_id,
  pageId: r.page_id,
  nationId: r.nation_id,
  pageName: r.page_name,
  action: r.action,
  role: r.role,
  proposedName: r.proposed_name,
  via: r.via,
  reason: r.reason,
  by: r.by,
  at: r.at,
});

export type SubindexDecisionInput = Omit<SubindexDecision, 'id' | 'projectId' | 'at' | 'by'>;

export class NationSubindexStore {
  /** Bumped by every change (the report's rows and the classifier's input are cached on it). */
  private changes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  version(): number {
    return this.changes;
  }

  decisions(projectId: string): SubindexDecision[] {
    return (
      prepared(this.db, 'SELECT * FROM nation_subindex_decisions WHERE project_id = ? ORDER BY at, id').all(
        projectId,
      ) as Row[]
    ).map(view);
  }

  decision(projectId: string, pageId: string): SubindexDecision | null {
    const r = prepared(
      this.db,
      'SELECT * FROM nation_subindex_decisions WHERE project_id = ? AND page_id = ?',
    ).get(projectId, pageId) as Row | undefined;
    return r ? view(r) : null;
  }

  /** Records (or replaces) the decision on one child. Run inside the caller's transaction for a bulk mapping. */
  put(projectId: string, by: string, d: SubindexDecisionInput): SubindexDecision {
    const id = `nsd_${randomBytes(8).toString('hex')}`;
    prepared(
      this.db,
      `INSERT INTO nation_subindex_decisions
         (id, project_id, page_id, nation_id, page_name, action, role, proposed_name, via, reason, by, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE SET
         id = excluded.id, nation_id = excluded.nation_id, page_name = excluded.page_name, action = excluded.action,
         role = excluded.role, proposed_name = excluded.proposed_name, via = excluded.via, reason = excluded.reason,
         by = excluded.by, at = excluded.at`,
    ).run(
      id,
      projectId,
      d.pageId,
      d.nationId,
      d.pageName.slice(0, 500),
      d.action,
      d.role,
      d.proposedName,
      d.via,
      d.reason.slice(0, 1000),
      by,
      this.now(),
    );
    this.changes++;
    return this.decision(projectId, d.pageId)!;
  }

  putMany(projectId: string, by: string, ds: readonly SubindexDecisionInput[]): SubindexDecision[] {
    return this.db.transaction(() => ds.map((d) => this.put(projectId, by, d)))();
  }

  remove(projectId: string, pageId: string): boolean {
    const n = prepared(
      this.db,
      'DELETE FROM nation_subindex_decisions WHERE project_id = ? AND page_id = ?',
    ).run(projectId, pageId).changes;
    if (n > 0) this.changes++;
    return n > 0;
  }

  /** The distinct jobs whose applied writes carry this decision's id (the rename fix's journal entry). */
  appliedWrites(projectId: string, decisionId: string): number {
    try {
      const r = prepared(
        this.db,
        `SELECT COUNT(DISTINCT job_id) AS n FROM write_journal WHERE project_id = ? AND outcome = 'applied' AND operation LIKE ?`,
      ).get(projectId, `%"nationSubindexDecision":"${decisionId}"%`) as { n: number } | undefined;
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  }
}

// ============================================================================================ keep it here

export interface HomeRuling {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly stateHash: string;
  readonly parentId: string | null;
  readonly tags: readonly string[];
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

/** The state a "keep it here" ruling is tied to: the page's tags (in order) and its parent. */
export const homeStateHash = (tags: readonly string[], parentId: string | null): string =>
  createHash('sha256')
    .update(JSON.stringify({ tags: [...tags], parentId }))
    .digest('hex');

export class HomeRulingStore {
  private changes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  version(): number {
    return this.changes;
  }

  rulings(projectId: string): HomeRuling[] {
    return (
      prepared(this.db, 'SELECT * FROM category_home_rulings WHERE project_id = ?').all(projectId) as {
        project_id: string;
        page_id: string;
        page_name: string;
        state_hash: string;
        parent_id: string | null;
        tags: string;
        reason: string;
        by: string;
        at: number;
      }[]
    ).map((r) => ({
      projectId: r.project_id,
      pageId: r.page_id,
      pageName: r.page_name,
      stateHash: r.state_hash,
      parentId: r.parent_id,
      tags: JSON.parse(r.tags) as string[],
      reason: r.reason,
      by: r.by,
      at: r.at,
    }));
  }

  keep(
    projectId: string,
    by: string,
    r: { pageId: string; pageName: string; tags: readonly string[]; parentId: string | null; reason: string },
  ): HomeRuling {
    prepared(
      this.db,
      `INSERT INTO category_home_rulings (project_id, page_id, page_name, state_hash, parent_id, tags, reason, by, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE SET page_name = excluded.page_name, state_hash = excluded.state_hash,
         parent_id = excluded.parent_id, tags = excluded.tags, reason = excluded.reason, by = excluded.by, at = excluded.at`,
    ).run(
      projectId,
      r.pageId,
      r.pageName.slice(0, 500),
      homeStateHash(r.tags, r.parentId),
      r.parentId,
      JSON.stringify([...r.tags]),
      r.reason.slice(0, 1000),
      by,
      this.now(),
    );
    this.changes++;
    return this.rulings(projectId).find((x) => x.pageId === r.pageId)!;
  }

  remove(projectId: string, pageId: string): boolean {
    const n = prepared(this.db, 'DELETE FROM category_home_rulings WHERE project_id = ? AND page_id = ?').run(
      projectId,
      pageId,
    ).changes;
    if (n > 0) this.changes++;
    return n > 0;
  }
}
