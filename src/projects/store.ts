/**
 * The `projects` table (migration 0600). Synchronous, like every other store. Only the registry (registry.ts), the
 * owner commands and the `projects` CLI write it.
 */
import type { Db } from '../db/open.js';
import { parseProjectSettings } from './settings.js';
import type { ProjectRecord } from './types.js';

interface Row {
  id: string;
  name: string;
  display_name: string | null;
  is_default: number;
  is_sandbox: number;
  read_only: number;
  settings: string;
  created_at: number;
  updated_at: number;
  verified_at: number | null;
  archived_at: number | null;
}

function toRecord(r: Row): ProjectRecord {
  const parsed = parseProjectSettings(r.settings);
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    isDefault: r.is_default === 1,
    isSandbox: r.is_sandbox === 1,
    readOnly: r.read_only === 1,
    settings: parsed.settings,
    settingsProblem: parsed.problem,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    verifiedAt: r.verified_at,
    archivedAt: r.archived_at ?? null,
  };
}

export class ProjectStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map(toRecord);
  }

  byName(name: string): ProjectRecord | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  byId(id: string): ProjectRecord | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  /** Registers a project the first time its key proves which LegendKeeper project it is. */
  insert(p: {
    id: string;
    name: string;
    displayName: string | null;
    verifiedAt: number | null;
  }): ProjectRecord {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at,
           updated_at, verified_at)
         VALUES (?, ?, ?, 0, 0, 0, '{}', ?, ?, ?)`,
      )
      .run(p.id, p.name, p.displayName, at, at, p.verifiedAt);
    return this.byId(p.id)!;
  }

  /** After a successful check: LegendKeeper's name for the project and when the key last proved it. */
  markVerified(id: string, displayName: string | null, at: number): void {
    this.db
      .prepare('UPDATE projects SET display_name = ?, verified_at = ?, updated_at = ? WHERE id = ?')
      .run(displayName, at, at, id);
  }

  /** Makes `name` the default (LK_DEFAULT_PROJECT); every other project loses the flag. Unknown names change nothing. */
  setDefault(name: string): void {
    this.db.transaction(() => {
      const target = this.byName(name);
      if (!target) return;
      const at = this.now();
      this.db
        .prepare('UPDATE projects SET is_default = 0, updated_at = ? WHERE is_default = 1 AND name <> ?')
        .run(at, name);
      if (!target.isDefault) {
        this.db.prepare('UPDATE projects SET is_default = 1, updated_at = ? WHERE name = ?').run(at, name);
      }
    })();
  }

  /**
   * OPS2: archives a project removed on the dashboard. Its row (and so every stored row that names it) stays, read-only;
   * it is no longer the default. Its name stays taken, so its history is never confused with a new project's.
   */
  archive(id: string): ProjectRecord | undefined {
    const at = this.now();
    this.db
      .prepare(
        'UPDATE projects SET archived_at = ?, is_default = 0, updated_at = ? WHERE id = ? AND archived_at IS NULL',
      )
      .run(at, at, id);
    return this.byId(id);
  }

  /** OPS2: brings an archived project back (added again on the dashboard with a key of the same LegendKeeper project). */
  unarchive(id: string): ProjectRecord | undefined {
    this.db
      .prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(this.now(), id);
    return this.byId(id);
  }

  setReadOnly(id: string, readOnly: boolean): ProjectRecord | undefined {
    this.db
      .prepare('UPDATE projects SET read_only = ?, updated_at = ? WHERE id = ?')
      .run(readOnly ? 1 : 0, this.now(), id);
    return this.byId(id);
  }

  /**
   * v2 A2: sets (or, with `null`, removes) one key of the JSON settings, keeping every other key as it is (unknown keys
   * included). Read and written in one transaction. Returns the record afterwards (undefined for an unknown project).
   */
  setSetting(id: string, key: string, value: unknown): ProjectRecord | undefined {
    return this.db.transaction(() => {
      const r = this.db.prepare('SELECT settings FROM projects WHERE id = ?').get(id) as
        { settings: string } | undefined;
      if (!r) return undefined;
      let current: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(r.settings || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
      if (value === null || value === undefined) delete current[key];
      else current[key] = value;
      this.db
        .prepare('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(current), this.now(), id);
      return this.byId(id);
    })();
  }

  setSandbox(id: string, sandbox: boolean): ProjectRecord | undefined {
    this.db
      .prepare('UPDATE projects SET is_sandbox = ?, updated_at = ? WHERE id = ?')
      .run(sandbox ? 1 : 0, this.now(), id);
    return this.byId(id);
  }
}
