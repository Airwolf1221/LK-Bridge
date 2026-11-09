/**
 * SQLite storage for mapping sets, type rules and field maps (migration 0400). Since v2 A1 (migration 0600) mappings
 * belong to a project: a store is bound to ONE project's LegendKeeper id, and every query and insert carries it, so
 * another project's sets, rules and field maps are invisible (and unknown ids answer "not found").
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import {
  MappingError,
  type FieldInput,
  type FieldMap,
  type Location,
  type MappingSet,
  type RuleInput,
  type Selector,
  type SetInput,
  type SetSummary,
  type TypeRule,
} from './types.js';

type Row = Record<string, unknown>;
const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const toSet = (r: Row): MappingSet => ({
  id: r.id as string,
  name: r.name as string,
  description: str(r.description),
  notes: str(r.notes),
  active: r.active === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toRule = (r: Row): TypeRule => {
  const kind = r.selector_kind as Selector['kind'];
  const selector: Selector =
    kind === 'subtree'
      ? { kind, resourceId: r.selector_id as string, descendants: r.descendants === 1 }
      : kind === 'template'
        ? { kind, templateId: r.selector_id as string }
        : { kind, tag: r.selector_id as string };
  return {
    id: r.id as string,
    setId: r.set_id as string,
    selector,
    semanticType: r.semantic_type as string,
    priority: Number(r.priority),
    notes: str(r.notes),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

const toField = (r: Row): FieldMap => {
  const kind = r.location_kind as Location['kind'];
  const nn = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const location: Location =
    kind === 'sidebar_property'
      ? { kind, title: str(r.property_title) }
      : kind === 'infobox_row'
        ? { kind, infoboxTitle: str(r.infobox_title), rowKey: str(r.row_key) }
        : {
            kind,
            ...(nn(r.heading_text) !== undefined ? { heading: nn(r.heading_text)! } : {}),
            ...(nn(r.block_id) !== undefined ? { blockId: nn(r.block_id)! } : {}),
          };
  return {
    id: r.id as string,
    setId: r.set_id as string,
    semanticType: r.semantic_type as string,
    fieldName: r.field_name as string,
    location,
    expectedKind: r.expected_kind as FieldMap['expectedKind'],
    notes: str(r.notes),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
};

const ruleColumns = (s: Selector) => ({
  kind: s.kind,
  id: s.kind === 'subtree' ? s.resourceId : s.kind === 'template' ? s.templateId : s.tag,
  descendants: s.kind === 'subtree' && s.descendants ? 1 : 0,
});

const fieldColumns = (l: Location) => ({
  kind: l.kind,
  property: l.kind === 'sidebar_property' ? l.title : null,
  infobox: l.kind === 'infobox_row' ? l.infoboxTitle : null,
  row: l.kind === 'infobox_row' ? l.rowKey : null,
  heading: l.kind === 'block' ? (l.heading ?? null) : null,
  block: l.kind === 'block' ? (l.blockId ?? null) : null,
});

export class MappingStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
    /** The project this store reads and writes (its LegendKeeper id). */
    readonly projectId: string,
  ) {
    if (typeof projectId !== 'string' || projectId === '') throw new Error('A mapping store needs a project');
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ----------------------------------------------------------------------------------------------- sets

  listSets(): SetSummary[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM mapping_type_rules WHERE set_id = s.id) AS rule_count,
                  (SELECT COUNT(*) FROM mapping_field_maps WHERE set_id = s.id) AS field_count
             FROM mapping_sets s WHERE s.project_id = ? ORDER BY s.active DESC, s.name COLLATE NOCASE`,
        )
        .all(this.projectId) as Row[]
    ).map((r) => ({ ...toSet(r), ruleCount: Number(r.rule_count), fieldCount: Number(r.field_count) }));
  }

  getSet(id: string): MappingSet | undefined {
    const r = this.db
      .prepare('SELECT * FROM mapping_sets WHERE id = ? AND project_id = ?')
      .get(id, this.projectId) as Row | undefined;
    return r ? toSet(r) : undefined;
  }

  requireSet(id: string): MappingSet {
    const s = this.getSet(id);
    if (!s) throw new MappingError('NOT_FOUND', `No mapping set ${id}`);
    return s;
  }

  activeSet(): MappingSet | undefined {
    const r = this.db
      .prepare('SELECT * FROM mapping_sets WHERE active = 1 AND project_id = ?')
      .get(this.projectId) as Row | undefined;
    return r ? toSet(r) : undefined;
  }

  private nameTaken(name: string, exceptId?: string): boolean {
    const r = this.db
      .prepare('SELECT id FROM mapping_sets WHERE project_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(this.projectId, name, exceptId ?? null);
    return r !== undefined;
  }

  insertSet(input: SetInput): MappingSet {
    if (this.nameTaken(input.name))
      throw new MappingError('NAME_TAKEN', `A mapping set named “${input.name}” already exists`);
    const id = newId('ms');
    const at = this.now();
    this.db
      .prepare(
        'INSERT INTO mapping_sets (id, project_id, name, description, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(id, this.projectId, input.name, input.description, input.notes, at, at);
    return this.requireSet(id);
  }

  updateSet(id: string, input: SetInput): MappingSet {
    this.requireSet(id);
    if (this.nameTaken(input.name, id))
      throw new MappingError('NAME_TAKEN', `A mapping set named “${input.name}” already exists`);
    this.db
      .prepare(
        'UPDATE mapping_sets SET name = ?, description = ?, notes = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      )
      .run(input.name, input.description, input.notes, this.now(), id, this.projectId);
    return this.requireSet(id);
  }

  /** Makes `id` the one active set (or, with `active = false`, leaves no set active if it was). */
  setActive(id: string, active: boolean): MappingSet {
    this.requireSet(id);
    this.tx(() => {
      if (active)
        this.db
          .prepare(
            'UPDATE mapping_sets SET active = 0, updated_at = ? WHERE active = 1 AND id <> ? AND project_id = ?',
          )
          .run(this.now(), id, this.projectId);
      this.db
        .prepare('UPDATE mapping_sets SET active = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run(active ? 1 : 0, this.now(), id, this.projectId);
    });
    return this.requireSet(id);
  }

  deleteSet(id: string): void {
    this.requireSet(id);
    // Rules and field maps cascade.
    this.db.prepare('DELETE FROM mapping_sets WHERE id = ? AND project_id = ?').run(id, this.projectId);
  }

  private touch(setId: string): void {
    this.db
      .prepare('UPDATE mapping_sets SET updated_at = ? WHERE id = ? AND project_id = ?')
      .run(this.now(), setId, this.projectId);
  }

  // ---------------------------------------------------------------------------------------------- rules

  listRules(setId: string): TypeRule[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM mapping_type_rules WHERE set_id = ? AND project_id = ? ORDER BY priority DESC, created_at, rowid',
        )
        .all(setId, this.projectId) as Row[]
    ).map(toRule);
  }

  getRule(id: string): TypeRule | undefined {
    const r = this.db
      .prepare('SELECT * FROM mapping_type_rules WHERE id = ? AND project_id = ?')
      .get(id, this.projectId) as Row | undefined;
    return r ? toRule(r) : undefined;
  }

  requireRule(id: string): TypeRule {
    const r = this.getRule(id);
    if (!r) throw new MappingError('NOT_FOUND', `No type rule ${id}`);
    return r;
  }

  insertRule(setId: string, input: RuleInput): TypeRule {
    this.requireSet(setId);
    const id = newId('tr');
    const at = this.now();
    const c = ruleColumns(input.selector);
    this.db
      .prepare(
        `INSERT INTO mapping_type_rules (id, set_id, project_id, selector_kind, selector_id, descendants, semantic_type, priority, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        setId,
        this.projectId,
        c.kind,
        c.id,
        c.descendants,
        input.semanticType,
        input.priority,
        input.notes,
        at,
        at,
      );
    this.touch(setId);
    return this.requireRule(id);
  }

  updateRule(id: string, input: RuleInput): TypeRule {
    const before = this.requireRule(id);
    const c = ruleColumns(input.selector);
    this.db
      .prepare(
        `UPDATE mapping_type_rules SET selector_kind = ?, selector_id = ?, descendants = ?, semantic_type = ?, priority = ?,
           notes = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
      )
      .run(
        c.kind,
        c.id,
        c.descendants,
        input.semanticType,
        input.priority,
        input.notes,
        this.now(),
        id,
        this.projectId,
      );
    this.touch(before.setId);
    return this.requireRule(id);
  }

  deleteRule(id: string): TypeRule {
    const before = this.requireRule(id);
    this.db.prepare('DELETE FROM mapping_type_rules WHERE id = ? AND project_id = ?').run(id, this.projectId);
    this.touch(before.setId);
    return before;
  }

  // ---------------------------------------------------------------------------------------------- fields

  listFields(setId: string): FieldMap[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM mapping_field_maps WHERE set_id = ? AND project_id = ? ORDER BY semantic_type COLLATE NOCASE, field_name COLLATE NOCASE',
        )
        .all(setId, this.projectId) as Row[]
    ).map(toField);
  }

  getField(id: string): FieldMap | undefined {
    const r = this.db
      .prepare('SELECT * FROM mapping_field_maps WHERE id = ? AND project_id = ?')
      .get(id, this.projectId) as Row | undefined;
    return r ? toField(r) : undefined;
  }

  requireField(id: string): FieldMap {
    const f = this.getField(id);
    if (!f) throw new MappingError('NOT_FOUND', `No field map ${id}`);
    return f;
  }

  private fieldTaken(setId: string, input: FieldInput, exceptId?: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT id FROM mapping_field_maps WHERE set_id = ? AND semantic_type = ? COLLATE NOCASE AND field_name = ? COLLATE NOCASE AND id IS NOT ?`,
        )
        .get(setId, input.semanticType, input.fieldName, exceptId ?? null) !== undefined
    );
  }

  insertField(setId: string, input: FieldInput): FieldMap {
    this.requireSet(setId);
    if (this.fieldTaken(setId, input)) {
      throw new MappingError(
        'DUPLICATE_FIELD',
        `${input.semanticType} already has a field called “${input.fieldName}”`,
      );
    }
    const id = newId('fm');
    const at = this.now();
    const c = fieldColumns(input.location);
    this.db
      .prepare(
        `INSERT INTO mapping_field_maps (id, set_id, project_id, semantic_type, field_name, location_kind, property_title, infobox_title, row_key,
           heading_text, block_id, expected_kind, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        setId,
        this.projectId,
        input.semanticType,
        input.fieldName,
        c.kind,
        c.property,
        c.infobox,
        c.row,
        c.heading,
        c.block,
        input.expectedKind,
        input.notes,
        at,
        at,
      );
    this.touch(setId);
    return this.requireField(id);
  }

  updateField(id: string, input: FieldInput): FieldMap {
    const before = this.requireField(id);
    if (this.fieldTaken(before.setId, input, id)) {
      throw new MappingError(
        'DUPLICATE_FIELD',
        `${input.semanticType} already has a field called “${input.fieldName}”`,
      );
    }
    const c = fieldColumns(input.location);
    this.db
      .prepare(
        `UPDATE mapping_field_maps SET semantic_type = ?, field_name = ?, location_kind = ?, property_title = ?, infobox_title = ?,
           row_key = ?, heading_text = ?, block_id = ?, expected_kind = ?, notes = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
      )
      .run(
        input.semanticType,
        input.fieldName,
        c.kind,
        c.property,
        c.infobox,
        c.row,
        c.heading,
        c.block,
        input.expectedKind,
        input.notes,
        this.now(),
        id,
        this.projectId,
      );
    this.touch(before.setId);
    return this.requireField(id);
  }

  deleteField(id: string): FieldMap {
    const before = this.requireField(id);
    this.db.prepare('DELETE FROM mapping_field_maps WHERE id = ? AND project_id = ?').run(id, this.projectId);
    this.touch(before.setId);
    return before;
  }
}
