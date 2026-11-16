/**
 * The setting packs' storage (v3 F3a, ADR 0050; migration 3000): packs, their attachments to projects, every version of
 * their rules, and the reservations a package's job takes when it runs. Plain SQLite through better-sqlite3, so every
 * method is atomic in this process (the bridge runs one process per project: ADR 0023).
 */
import type { Db } from '../db/open.js';
import {
  governanceSourceSchema,
  packRulesSchema,
  type GovernanceSource,
  type Pack,
  type PackApproval,
  type PackAttachment,
  type PackDrift,
  type PackRules,
} from './types.js';

interface PackRow {
  id: string;
  name: string;
  prefix: string;
  rules: string;
  version: number;
  governance: string;
  approved: string | null;
  drift: string | null;
  seed: string | null;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  pack_id: string;
  project_id: string;
  templates: string;
  notes: string;
  attached_at: number;
  attached_by: string;
}

/** Job states in which a reservation still counts. */
const ACTIVE_JOB_STATES = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'];

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class PackStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private toPack(r: PackRow): Pack {
    const rules = packRulesSchema.safeParse(parseJson<unknown>(r.rules, null));
    if (!rules.success) {
      throw new Error(
        `The stored rules of the pack ${r.id} are not valid: ${rules.error.issues[0]?.message ?? ''}`,
      );
    }
    const governance = parseJson<unknown[]>(r.governance, [])
      .map((g) => governanceSourceSchema.safeParse(g))
      .filter((g) => g.success)
      .map((g) => g.data);
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      rules: rules.data,
      version: r.version,
      governance,
      approved: parseJson<PackApproval | null>(r.approved, null),
      drift: parseJson<PackDrift | null>(r.drift, null),
      seed: r.seed,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(id: string): Pack | null {
    const r = this.db.prepare('SELECT * FROM packs WHERE id = ?').get(id) as PackRow | undefined;
    return r ? this.toPack(r) : null;
  }

  list(): Pack[] {
    return (this.db.prepare('SELECT * FROM packs ORDER BY id').all() as PackRow[]).map((r) => this.toPack(r));
  }

  /** Stores a new pack at version 1 (with its first version row). */
  insert(p: {
    id: string;
    name: string;
    prefix: string;
    rules: PackRules;
    governance: readonly GovernanceSource[];
    seed: string | null;
  }): Pack {
    const at = this.now();
    const rules = JSON.stringify(packRulesSchema.parse(p.rules));
    const governance = JSON.stringify(p.governance);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO packs (id, name, prefix, rules, version, governance, approved, drift, seed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(p.id, p.name, p.prefix, rules, governance, p.seed, at, at);
      this.db
        .prepare(
          `INSERT INTO pack_versions (pack_id, version, rules, governance, approved, reason, created_at)
           VALUES (?, 1, ?, ?, NULL, 'seed', ?)`,
        )
        .run(p.id, rules, governance, at);
    })();
    return this.get(p.id)!;
  }

  /** A new version of the rules (validated), kept with its reason; the approval stays on the version it covered. */
  newVersion(id: string, rules: PackRules, reason: string): Pack {
    const at = this.now();
    const valid = JSON.stringify(packRulesSchema.parse(rules));
    this.db.transaction(() => {
      const cur = this.db.prepare('SELECT version, governance FROM packs WHERE id = ?').get(id) as
        { version: number; governance: string } | undefined;
      if (!cur) throw new Error(`No pack ${id}`);
      const version = cur.version + 1;
      this.db
        .prepare('UPDATE packs SET rules = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(valid, version, at, id);
      this.db
        .prepare(
          `INSERT INTO pack_versions (pack_id, version, rules, governance, approved, reason, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, version, valid, cur.governance, reason.slice(0, 500), at);
    })();
    return this.get(id)!;
  }

  /**
   * v3 F3b (ADR 0052): a newer seed offered as a new version, in one transaction: the rules (validated), the governance
   * sources and the seed's name; the approval stays on the version it covered, so the pack waits for the owner.
   */
  upgrade(
    id: string,
    rules: PackRules,
    governance: readonly GovernanceSource[],
    seed: string,
    reason: string,
  ): Pack {
    const at = this.now();
    const valid = JSON.stringify(packRulesSchema.parse(rules));
    const sources = JSON.stringify(governance.map((g) => governanceSourceSchema.parse(g)));
    this.db.transaction(() => {
      const cur = this.db.prepare('SELECT version FROM packs WHERE id = ?').get(id) as
        { version: number } | undefined;
      if (!cur) throw new Error(`No pack ${id}`);
      const version = cur.version + 1;
      this.db
        .prepare('UPDATE packs SET rules = ?, version = ?, governance = ?, seed = ?, updated_at = ? WHERE id = ?')
        .run(valid, version, sources, seed, at, id);
      this.db
        .prepare(
          `INSERT INTO pack_versions (pack_id, version, rules, governance, approved, reason, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, version, valid, sources, reason.slice(0, 500), at);
    })();
    return this.get(id)!;
  }

  /** Records the owner's approval of the CURRENT version (and clears the drift it settles). */
  approve(id: string, approval: PackApproval): Pack {
    const at = this.now();
    const text = JSON.stringify(approval);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE packs SET approved = ?, drift = NULL, updated_at = ? WHERE id = ? AND version = ?')
        .run(text, at, id, approval.version);
      this.db
        .prepare('UPDATE pack_versions SET approved = ? WHERE pack_id = ? AND version = ?')
        .run(text, id, approval.version);
    })();
    return this.get(id)!;
  }

  /** Replaces a pack's governance sources (a newer seed, or a test world pointing them at its own documents). */
  setGovernance(id: string, sources: readonly GovernanceSource[]): void {
    const valid = sources.map((g) => governanceSourceSchema.parse(g));
    this.db
      .prepare('UPDATE packs SET governance = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(valid), this.now(), id);
  }

  setDrift(id: string, drift: PackDrift | null): void {
    this.db
      .prepare('UPDATE packs SET drift = ?, updated_at = ? WHERE id = ?')
      .run(drift ? JSON.stringify(drift) : null, this.now(), id);
  }

  versions(
    id: string,
  ): { version: number; reason: string; approved: PackApproval | null; createdAt: number }[] {
    return (
      this.db
        .prepare(
          'SELECT version, reason, approved, created_at FROM pack_versions WHERE pack_id = ? ORDER BY version DESC',
        )
        .all(id) as { version: number; reason: string; approved: string | null; created_at: number }[]
    ).map((r) => ({
      version: r.version,
      reason: r.reason,
      approved: parseJson<PackApproval | null>(r.approved, null),
      createdAt: r.created_at,
    }));
  }

  // ============================================================================================ attachments

  private toAttachment(r: AttachmentRow): PackAttachment {
    return {
      packId: r.pack_id,
      projectId: r.project_id,
      templates: parseJson<Record<string, string | null>>(r.templates, {}),
      notes: parseJson<string[]>(r.notes, []),
      attachedAt: r.attached_at,
      attachedBy: r.attached_by,
    };
  }

  attachments(packId?: string): PackAttachment[] {
    const rows = (
      packId === undefined
        ? this.db.prepare('SELECT * FROM pack_projects ORDER BY pack_id, project_id').all()
        : this.db.prepare('SELECT * FROM pack_projects WHERE pack_id = ? ORDER BY project_id').all(packId)
    ) as AttachmentRow[];
    return rows.map((r) => this.toAttachment(r));
  }

  attachment(packId: string, projectId: string): PackAttachment | null {
    const r = this.db
      .prepare('SELECT * FROM pack_projects WHERE pack_id = ? AND project_id = ?')
      .get(packId, projectId) as AttachmentRow | undefined;
    return r ? this.toAttachment(r) : null;
  }

  attach(
    packId: string,
    projectId: string,
    templates: Readonly<Record<string, string | null>>,
    notes: readonly string[],
    by: string,
  ): PackAttachment {
    this.db
      .prepare(
        `INSERT INTO pack_projects (pack_id, project_id, templates, notes, attached_at, attached_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pack_id, project_id) DO NOTHING`,
      )
      .run(packId, projectId, JSON.stringify(templates), JSON.stringify(notes), this.now(), by);
    return this.attachment(packId, projectId)!;
  }

  setTemplates(
    packId: string,
    projectId: string,
    templates: Readonly<Record<string, string | null>>,
    notes: readonly string[],
  ): void {
    this.db
      .prepare('UPDATE pack_projects SET templates = ?, notes = ? WHERE pack_id = ? AND project_id = ?')
      .run(JSON.stringify(templates), JSON.stringify(notes), packId, projectId);
  }

  detach(packId: string, projectId: string): void {
    this.db.prepare('DELETE FROM pack_projects WHERE pack_id = ? AND project_id = ?').run(packId, projectId);
  }

  // ============================================================================================ reservations

  /**
   * Reserves `key` for `jobId`, atomically. Refused (with the holder) when another job that still counts holds it; a
   * reservation of a job that has finished no longer counts (its pages are in LegendKeeper then, which the caller
   * checks), and is cleared.
   */
  reserve(projectId: string, key: string, jobId: string): { ok: true } | { ok: false; holder: string } {
    return this.db.transaction(() => {
      const holders = this.db
        .prepare('SELECT job_id FROM pack_reservations WHERE project_id = ? AND key = ? AND job_id != ?')
        .all(projectId, key, jobId) as { job_id: string }[];
      for (const h of holders) {
        const j = this.db
          .prepare('SELECT status FROM jobs WHERE id = ? AND project_id = ?')
          .get(h.job_id, projectId) as { status: string } | undefined;
        if (j && ACTIVE_JOB_STATES.includes(j.status)) return { ok: false as const, holder: h.job_id };
        this.db
          .prepare('DELETE FROM pack_reservations WHERE project_id = ? AND key = ? AND job_id = ?')
          .run(projectId, key, h.job_id);
      }
      this.db
        .prepare(
          `INSERT INTO pack_reservations (project_id, key, job_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id, key, job_id) DO NOTHING`,
        )
        .run(projectId, key, jobId, this.now());
      return { ok: true as const };
    })();
  }
}
