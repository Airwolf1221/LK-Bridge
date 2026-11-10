/**
 * The registry's tables (migration 0800) for ONE project: types, taxonomy entries, the templates snapshot and drift
 * reports. Every statement names the store's project, so nothing of another project is reachable through it.
 * Synchronous (better-sqlite3), like the tree.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import { key } from './names.js';
import {
  DEFAULT_CHARACTER_PLACEMENT,
  RegistryError,
  type CharacterPlacementConfig,
  type PageTemplate,
  type PlacementKind,
  type Recipe,
  type RegistryType,
  type ReviewReason,
  type ReviewStatus,
  type TaxonomyEntry,
  type TemplateInfo,
  type TemplatesSnapshot,
} from './types.js';
import type { DriftFinding, DriftReport } from './drift.js';

interface TypeRow {
  project_id: string;
  id: string;
  singular: string;
  plural: string;
  root_index_id: string | null;
  index_template_id: string | null;
  page_templates: string;
  asset_root_folder: string | null;
  placement_kind: PlacementKind;
  placement_config: string;
  recipe: string;
  pack_id: string | null;
  status: ReviewStatus;
  review: string;
  notes: string;
  taxonomy_seeded_at: number | null;
  created_at: number;
  updated_at: number;
}

interface EntryRow {
  project_id: string;
  id: string;
  type_id: string;
  plural: string;
  singular: string;
  singular_source: 'list' | 'rule' | 'owner';
  parent_id: string | null;
  aliases: string;
  source_node_id: string;
  source_parent_node_id: string | null;
  asset_folder: string;
  status: ReviewStatus;
  review: string;
  notes: string;
  origin: 'seed' | 'add_missing';
  created_at: number;
  updated_at: number;
}

function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const j = (v: unknown) => JSON.stringify(v);

export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/** The stored character settings with every missing field filled from the defaults. */
export function placementFrom(kind: PlacementKind, stored: unknown): CharacterPlacementConfig | null {
  if (kind !== 'character') return null;
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<CharacterPlacementConfig>;
  return {
    ...DEFAULT_CHARACTER_PLACEMENT,
    ...s,
    referenceTypes: { ...DEFAULT_CHARACTER_PLACEMENT.referenceTypes, ...s.referenceTypes },
    pageNames: { ...DEFAULT_CHARACTER_PLACEMENT.pageNames, ...s.pageNames },
  };
}

/** Drift reports kept per project. */
const REPORTS_KEPT = 60;

export interface NewType {
  singular: string;
  plural: string;
  rootIndexId: string | null;
  indexTemplateId: string | null;
  pageTemplates: readonly PageTemplate[];
  assetRootFolder: string | null;
  placementKind: PlacementKind;
  /** The stored (partial) settings of the placement rule; defaults fill the rest when read. */
  placementConfig: Readonly<Record<string, unknown>>;
  status: ReviewStatus;
  review: readonly ReviewReason[];
  notes: string;
}

export interface NewEntry {
  typeId: string;
  plural: string;
  singular: string;
  singularSource: 'list' | 'rule' | 'owner';
  parentId: string | null;
  aliases: readonly string[];
  sourceNodeId: string;
  sourceParentNodeId: string | null;
  assetFolder: string;
  status: ReviewStatus;
  review: readonly ReviewReason[];
  origin: 'seed' | 'add_missing';
}

export class RegistryStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
    readonly projectId: string,
  ) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ============================================================================================ types

  private static typeView(r: TypeRow): RegistryType {
    const config = parse<unknown>(r.placement_config, {});
    return {
      id: r.id,
      projectId: r.project_id,
      singular: r.singular,
      plural: r.plural,
      rootIndexId: r.root_index_id,
      indexTemplateId: r.index_template_id,
      pageTemplates: parse<PageTemplate[]>(r.page_templates, []),
      assetRootFolder: r.asset_root_folder,
      placementKind: r.placement_kind,
      placement: placementFrom(r.placement_kind, config),
      recipe: parse<Recipe>(r.recipe, { version: 1 }),
      packId: r.pack_id,
      status: r.status,
      review: parse<ReviewReason[]>(r.review, []),
      notes: r.notes,
      taxonomySeededAt: r.taxonomy_seeded_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listTypes(): RegistryType[] {
    return (
      this.db
        .prepare('SELECT * FROM registry_types WHERE project_id = ? ORDER BY singular_key')
        .all(this.projectId) as TypeRow[]
    ).map((r) => RegistryStore.typeView(r));
  }

  type(id: string): RegistryType | undefined {
    const r = this.db
      .prepare('SELECT * FROM registry_types WHERE project_id = ? AND id = ?')
      .get(this.projectId, id) as TypeRow | undefined;
    return r ? RegistryStore.typeView(r) : undefined;
  }

  requireType(id: string): RegistryType {
    const t = this.type(id);
    if (!t) throw new RegistryError('NOT_FOUND', `No type ${id} in this project.`);
    return t;
  }

  /** The type named `name` (its singular or plural, any case), or undefined. */
  typeByName(name: string): RegistryType | undefined {
    const k = key(name);
    const r = this.db
      .prepare('SELECT * FROM registry_types WHERE project_id = ? AND (singular_key = ? OR plural_key = ?)')
      .get(this.projectId, k, k) as TypeRow | undefined;
    return r ? RegistryStore.typeView(r) : undefined;
  }

  /** Refuses a singular or plural another type already uses (as its singular or its plural). */
  private assertNamesFree(singular: string, plural: string, exceptId: string | null): void {
    for (const n of [singular, plural]) {
      const k = key(n);
      const clash = this.db
        .prepare(
          'SELECT singular FROM registry_types WHERE project_id = ? AND (singular_key = ? OR plural_key = ?) AND id IS NOT ?',
        )
        .get(this.projectId, k, k, exceptId) as { singular: string } | undefined;
      if (clash)
        throw new RegistryError('NAME_TAKEN', `“${n}” is already the name of the type ${clash.singular}.`);
    }
  }

  insertType(t: NewType): RegistryType {
    this.assertNamesFree(t.singular, t.plural, null);
    const id = newId('typ');
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO registry_types (project_id, id, singular, plural, singular_key, plural_key, root_index_id,
           index_template_id, page_templates, asset_root_folder, placement_kind, placement_config, status, review, notes,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        id,
        t.singular,
        t.plural,
        key(t.singular),
        key(t.plural),
        t.rootIndexId,
        t.indexTemplateId,
        j(t.pageTemplates),
        t.assetRootFolder,
        t.placementKind,
        j(t.placementConfig),
        t.status,
        j(t.review),
        t.notes,
        at,
        at,
      );
    return this.requireType(id);
  }

  updateType(id: string, t: NewType): RegistryType {
    this.requireType(id);
    this.assertNamesFree(t.singular, t.plural, id);
    this.db
      .prepare(
        `UPDATE registry_types SET singular = ?, plural = ?, singular_key = ?, plural_key = ?, root_index_id = ?,
           index_template_id = ?, page_templates = ?, asset_root_folder = ?, placement_kind = ?, placement_config = ?,
           status = ?, review = ?, notes = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        t.singular,
        t.plural,
        key(t.singular),
        key(t.plural),
        t.rootIndexId,
        t.indexTemplateId,
        j(t.pageTemplates),
        t.assetRootFolder,
        t.placementKind,
        j(t.placementConfig),
        t.status,
        j(t.review),
        t.notes,
        this.now(),
        this.projectId,
        id,
      );
    return this.requireType(id);
  }

  /** The stored (not defaulted) placement settings of a type. */
  storedPlacementConfig(id: string): Record<string, unknown> {
    const r = this.db
      .prepare('SELECT placement_config FROM registry_types WHERE project_id = ? AND id = ?')
      .get(this.projectId, id) as { placement_config: string } | undefined;
    return parse<Record<string, unknown>>(r?.placement_config ?? null, {});
  }

  markTaxonomySeeded(id: string): void {
    this.db
      .prepare(
        'UPDATE registry_types SET taxonomy_seeded_at = ?, updated_at = ? WHERE project_id = ? AND id = ?',
      )
      .run(this.now(), this.now(), this.projectId, id);
  }

  deleteType(id: string): void {
    this.tx(() => {
      // Children before parents: the parent reference has no cascade.
      this.db
        .prepare('UPDATE taxonomy_entries SET parent_id = NULL WHERE project_id = ? AND type_id = ?')
        .run(this.projectId, id);
      this.db.prepare('DELETE FROM registry_types WHERE project_id = ? AND id = ?').run(this.projectId, id);
    });
  }

  // ============================================================================================ taxonomy

  private static entryView(r: EntryRow): TaxonomyEntry {
    return {
      id: r.id,
      projectId: r.project_id,
      typeId: r.type_id,
      plural: r.plural,
      singular: r.singular,
      singularSource: r.singular_source,
      parentId: r.parent_id,
      aliases: parse<string[]>(r.aliases, []),
      sourceNodeId: r.source_node_id,
      sourceParentNodeId: r.source_parent_node_id,
      assetFolder: r.asset_folder,
      status: r.status,
      review: parse<ReviewReason[]>(r.review, []),
      notes: r.notes,
      origin: r.origin,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  entries(typeId: string): TaxonomyEntry[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM taxonomy_entries WHERE project_id = ? AND type_id = ? ORDER BY created_at, id',
        )
        .all(this.projectId, typeId) as EntryRow[]
    ).map((r) => RegistryStore.entryView(r));
  }

  entry(id: string): TaxonomyEntry | undefined {
    const r = this.db
      .prepare('SELECT * FROM taxonomy_entries WHERE project_id = ? AND id = ?')
      .get(this.projectId, id) as EntryRow | undefined;
    return r ? RegistryStore.entryView(r) : undefined;
  }

  requireEntry(id: string): TaxonomyEntry {
    const e = this.entry(id);
    if (!e) throw new RegistryError('NOT_FOUND', `No taxonomy entry ${id} in this project.`);
    return e;
  }

  entryBySource(nodeId: string): TaxonomyEntry | undefined {
    const r = this.db
      .prepare('SELECT * FROM taxonomy_entries WHERE project_id = ? AND source_node_id = ?')
      .get(this.projectId, nodeId) as EntryRow | undefined;
    return r ? RegistryStore.entryView(r) : undefined;
  }

  insertEntry(e: NewEntry): TaxonomyEntry {
    const id = newId('tax');
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO taxonomy_entries (project_id, id, type_id, plural, singular, singular_source, parent_id, aliases,
           source_node_id, source_parent_node_id, asset_folder, status, review, notes, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      )
      .run(
        this.projectId,
        id,
        e.typeId,
        e.plural,
        e.singular,
        e.singularSource,
        e.parentId,
        j(e.aliases),
        e.sourceNodeId,
        e.sourceParentNodeId,
        e.assetFolder,
        e.status,
        j(e.review),
        e.origin,
        at,
        at,
      );
    this.link(e.sourceNodeId, 'taxonomy', id);
    return this.requireEntry(id);
  }

  updateEntry(
    id: string,
    f: {
      singular: string;
      singularSource: 'list' | 'rule' | 'owner';
      aliases: readonly string[];
      assetFolder: string;
      parentId: string | null;
      notes: string;
      status: ReviewStatus;
      review: readonly ReviewReason[];
    },
  ): TaxonomyEntry {
    this.db
      .prepare(
        `UPDATE taxonomy_entries SET singular = ?, singular_source = ?, aliases = ?, asset_folder = ?, parent_id = ?,
           notes = ?, status = ?, review = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        f.singular,
        f.singularSource,
        j(f.aliases),
        f.assetFolder,
        f.parentId,
        f.notes,
        f.status,
        j(f.review),
        this.now(),
        this.projectId,
        id,
      );
    return this.requireEntry(id);
  }

  deleteEntry(id: string): TaxonomyEntry {
    const e = this.requireEntry(id);
    const children = this.db
      .prepare('SELECT COUNT(*) AS n FROM taxonomy_entries WHERE project_id = ? AND parent_id = ?')
      .get(this.projectId, id) as { n: number };
    if (children.n > 0) {
      throw new RegistryError(
        'HAS_CHILDREN',
        `“${e.plural}” has ${children.n} ${children.n === 1 ? 'entry' : 'entries'} under it; move or delete those first.`,
      );
    }
    this.tx(() => {
      this.db.prepare('DELETE FROM taxonomy_entries WHERE project_id = ? AND id = ?').run(this.projectId, id);
      this.db
        .prepare('DELETE FROM tree_node_links WHERE project_id = ? AND link = ? AND target = ?')
        .run(this.projectId, 'taxonomy', id);
    });
    return e;
  }

  /**
   * A link from a tree node to a registry record (ADR 0025: `tree_node_links`), for lookups from the node's side.
   * Written only while the node is in the tree; the registry's own rows never depend on it.
   */
  link(nodeId: string, link: 'taxonomy' | 'type', target: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tree_node_links (project_id, node_id, link, target, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tree_nodes WHERE project_id = ? AND id = ?)`,
      )
      .run(this.projectId, nodeId, link, target, this.now(), this.projectId, nodeId);
  }

  unlinkType(typeId: string): void {
    this.db
      .prepare("DELETE FROM tree_node_links WHERE project_id = ? AND link = 'type' AND target = ?")
      .run(this.projectId, typeId);
  }

  // ============================================================================================ templates

  templates(): TemplatesSnapshot {
    const r = this.db
      .prepare(
        'SELECT templates, templates_read_at, templates_error FROM registry_state WHERE project_id = ?',
      )
      .get(this.projectId) as
      | { templates: string | null; templates_read_at: number | null; templates_error: string | null }
      | undefined;
    return {
      templates: parse<TemplateInfo[]>(r?.templates ?? null, []),
      readAt: r?.templates_read_at ?? null,
      error: r?.templates_error ?? null,
    };
  }

  saveTemplates(s: { templates?: readonly TemplateInfo[]; error: string | null }): void {
    const at = this.now();
    const prev = this.templates();
    this.db
      .prepare(
        `INSERT INTO registry_state (project_id, templates, templates_read_at, templates_error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET templates = excluded.templates,
           templates_read_at = excluded.templates_read_at, templates_error = excluded.templates_error,
           updated_at = excluded.updated_at`,
      )
      .run(this.projectId, j(s.templates ?? prev.templates), s.templates ? at : prev.readAt, s.error, at);
  }

  // ============================================================================================ drift reports

  saveReport(r: {
    source: 'check' | 'owner';
    passId: string | null;
    treeStatus: string;
    note: string | null;
    findings: readonly DriftFinding[];
  }): DriftReport {
    const at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO taxonomy_drift_reports (project_id, at, source, pass_id, tree_status, note, findings, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.projectId, at, r.source, r.passId, r.treeStatus, r.note, j(r.findings), r.findings.length);
    this.db
      .prepare(
        `DELETE FROM taxonomy_drift_reports WHERE project_id = ? AND id NOT IN
           (SELECT id FROM taxonomy_drift_reports WHERE project_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(this.projectId, this.projectId, REPORTS_KEPT);
    return this.report(Number(info.lastInsertRowid))!;
  }

  private report(id: number): DriftReport | undefined {
    const r = this.db
      .prepare('SELECT * FROM taxonomy_drift_reports WHERE project_id = ? AND id = ?')
      .get(this.projectId, id) as
      | {
          id: number;
          at: number;
          source: 'check' | 'owner';
          pass_id: string | null;
          tree_status: string;
          note: string | null;
          findings: string;
          count: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      at: r.at,
      source: r.source,
      passId: r.pass_id,
      treeStatus: r.tree_status,
      note: r.note,
      findings: parse<DriftFinding[]>(r.findings, []),
      count: r.count,
    };
  }

  latestReport(): DriftReport | undefined {
    const r = this.db
      .prepare('SELECT id FROM taxonomy_drift_reports WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(this.projectId) as { id: number } | undefined;
    return r ? this.report(r.id) : undefined;
  }

  recentReports(limit: number): Omit<DriftReport, 'findings'>[] {
    return (
      this.db
        .prepare(
          `SELECT id, at, source, pass_id, tree_status, note, count FROM taxonomy_drift_reports
           WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(this.projectId, limit) as {
        id: number;
        at: number;
        source: 'check' | 'owner';
        pass_id: string | null;
        tree_status: string;
        note: string | null;
        count: number;
      }[]
    ).map((r) => ({
      id: r.id,
      at: r.at,
      source: r.source,
      passId: r.pass_id,
      treeStatus: r.tree_status,
      note: r.note,
      count: r.count,
    }));
  }
}
