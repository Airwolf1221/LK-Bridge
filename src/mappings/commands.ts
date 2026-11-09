/**
 * Owner commands for mappings, on the owner command layer pattern (`src/policy/commands.ts`): every function takes
 * `actor: 'owner'` first, every change writes an `audit_log` row and emits a `policy` event, and none of it is
 * reachable from MCP. Reads (`list`, `get`, `export`, `preview`) are owner-only too but write nothing.
 */
import type { JobEngine } from '../jobs/index.js';
import type { PolicyStore } from '../policy/store.js';
import { exportSet, parseImport, type MappingDocument } from './exchange.js';
import { previewResource, type PreviewResult } from './preview.js';
import type { MappingStore } from './store.js';
import { summarise } from './summary.js';
import {
  MappingError,
  fieldInputSchema,
  parseOrThrow,
  ruleInputSchema,
  setInputSchema,
  type FieldMap,
  type MappingSet,
  type SetDetail,
  type SetSummary,
  type TypeRule,
} from './types.js';

export interface MappingCommands {
  listSets(actor: 'owner'): SetSummary[];
  getSet(actor: 'owner', id: string): SetDetail;
  createSet(actor: 'owner', input: unknown): MappingSet;
  updateSet(actor: 'owner', id: string, input: unknown): MappingSet;
  deleteSet(actor: 'owner', id: string): void;
  /** At most one set is active: activating one deactivates the other. */
  activateSet(actor: 'owner', id: string): MappingSet;
  deactivateSet(actor: 'owner', id: string): MappingSet;
  createRule(actor: 'owner', setId: string, input: unknown): TypeRule;
  updateRule(actor: 'owner', id: string, input: unknown): TypeRule;
  deleteRule(actor: 'owner', id: string): void;
  createField(actor: 'owner', setId: string, input: unknown): FieldMap;
  updateField(actor: 'owner', id: string, input: unknown): FieldMap;
  deleteField(actor: 'owner', id: string): void;
  exportSet(actor: 'owner', id: string): MappingDocument;
  /** Creates a NEW, inactive set from an export document (a JSON string or a parsed value). Optional new `name`. */
  importSet(actor: 'owner', document: unknown, name?: string): SetDetail;
  /** Read-only. Reads through the governor at P0; writes nothing. */
  preview(actor: 'owner', setId: string, resourceId: string): Promise<PreviewResult>;
}

function assertOwner(actor: unknown): asserts actor is 'owner' {
  if (actor !== 'owner') throw new MappingError('NOT_OWNER', 'Only the owner can do this');
}

const brief = (s: MappingSet) => ({
  name: s.name,
  description: s.description,
  notes: s.notes,
  active: s.active,
});

export function createMappingCommands(d: {
  store: MappingStore;
  audit: PolicyStore;
  engine: JobEngine;
  now: () => number;
}): MappingCommands {
  const { store } = d;
  // v2 A1: every audit row says which project's mappings changed.
  const audit = (action: string, target: string, before?: unknown, after?: unknown) =>
    d.audit.audit(
      'owner',
      action,
      target,
      before === undefined ? undefined : { project: store.projectId, ...(before as object) },
      after === undefined ? undefined : { project: store.projectId, ...(after as object) },
    );
  const detail = (id: string): SetDetail => {
    const set = store.requireSet(id);
    const rules = store.listRules(id);
    const fields = store.listFields(id);
    return { set, rules, fields, summary: summarise(set, rules, fields) };
  };
  const refuseEmptyId = (id: unknown): string => {
    if (typeof id !== 'string' || id.length === 0)
      throw new MappingError('INVALID_INPUT', 'An id is required');
    return id;
  };

  const commands: MappingCommands = {
    listSets(actor) {
      assertOwner(actor);
      return store.listSets();
    },
    getSet(actor, id) {
      assertOwner(actor);
      return detail(refuseEmptyId(id));
    },
    createSet(actor, input) {
      assertOwner(actor);
      const set = store.insertSet(parseOrThrow(setInputSchema, input));
      audit('mapping.set_create', set.id, undefined, brief(set));
      return set;
    },
    updateSet(actor, id, input) {
      assertOwner(actor);
      const before = store.requireSet(id);
      const after = store.updateSet(id, parseOrThrow(setInputSchema, input));
      audit('mapping.set_update', id, brief(before), brief(after));
      return after;
    },
    deleteSet(actor, id) {
      assertOwner(actor);
      const before = detail(id);
      store.deleteSet(id);
      audit(
        'mapping.set_delete',
        id,
        { ...brief(before.set), rules: before.rules.length, fields: before.fields.length },
        undefined,
      );
    },
    activateSet(actor, id) {
      assertOwner(actor);
      const was = store.activeSet();
      const after = store.setActive(id, true);
      audit('mapping.set_activate', id, { previouslyActive: was?.id ?? null }, { active: true });
      return after;
    },
    deactivateSet(actor, id) {
      assertOwner(actor);
      const before = store.requireSet(id);
      const after = store.setActive(id, false);
      audit('mapping.set_deactivate', id, { active: before.active }, { active: false });
      return after;
    },
    createRule(actor, setId, input) {
      assertOwner(actor);
      const rule = store.insertRule(setId, parseOrThrow(ruleInputSchema, input));
      audit('mapping.rule_create', rule.id, undefined, rule);
      return rule;
    },
    updateRule(actor, id, input) {
      assertOwner(actor);
      const before = store.requireRule(id);
      const after = store.updateRule(id, parseOrThrow(ruleInputSchema, input));
      audit('mapping.rule_update', id, before, after);
      return after;
    },
    deleteRule(actor, id) {
      assertOwner(actor);
      const before = store.deleteRule(id);
      audit('mapping.rule_delete', id, before, undefined);
    },
    createField(actor, setId, input) {
      assertOwner(actor);
      const field = store.insertField(setId, parseOrThrow(fieldInputSchema, input));
      audit('mapping.field_create', field.id, undefined, field);
      return field;
    },
    updateField(actor, id, input) {
      assertOwner(actor);
      const before = store.requireField(id);
      const after = store.updateField(id, parseOrThrow(fieldInputSchema, input));
      audit('mapping.field_update', id, before, after);
      return after;
    },
    deleteField(actor, id) {
      assertOwner(actor);
      const before = store.deleteField(id);
      audit('mapping.field_delete', id, before, undefined);
    },
    exportSet(actor, id) {
      assertOwner(actor);
      const set = store.requireSet(id);
      return exportSet(set, store.listRules(id), store.listFields(id), d.now());
    },
    importSet(actor, document, name) {
      assertOwner(actor);
      const doc = parseImport(document);
      const wanted = name !== undefined && name.trim() !== '' ? name : doc.set.name;
      const id = store.tx(() => {
        const set = store.insertSet(parseOrThrow(setInputSchema, { ...doc.set, name: wanted }));
        for (const r of doc.typeRules) store.insertRule(set.id, r);
        for (const f of doc.fieldMaps) store.insertField(set.id, f);
        return set.id;
      });
      const result = detail(id);
      audit('mapping.set_import', id, undefined, {
        name: result.set.name,
        rules: result.rules.length,
        fields: result.fields.length,
      });
      return result;
    },
    async preview(actor, setId, resourceId) {
      assertOwner(actor);
      const id = refuseEmptyId(resourceId);
      if (id.length > 256) throw new MappingError('INVALID_INPUT', 'That is not a resource id');
      store.requireSet(setId);
      return previewResource({
        engine: d.engine,
        project: store.projectId,
        rules: store.listRules(setId),
        fields: store.listFields(setId),
        resourceId: id,
      });
    },
  };
  return Object.freeze(commands);
}
