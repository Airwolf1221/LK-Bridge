/**
 * Export and import of one mapping set as JSON. The document is versioned (`schema` and `version`); an import is
 * validated whole before anything is written, and always creates a NEW, inactive set (it never overwrites).
 */
import * as z from 'zod';
import {
  MappingError,
  fieldInputSchema,
  parseOrThrow,
  ruleInputSchema,
  setInputSchema,
  type FieldMap,
  type MappingSet,
  type TypeRule,
} from './types.js';

export const EXPORT_SCHEMA = 'lk-bridge.mapping-set';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_RULES = 2000;
export const MAX_IMPORT_FIELDS = 5000;

const documentSchema = z.strictObject({
  schema: z.literal(EXPORT_SCHEMA, {
    error: `Not an LK-Bridge mapping set (expected schema “${EXPORT_SCHEMA}”)`,
  }),
  version: z.number().int(),
  exportedAt: z.string().optional(),
  set: setInputSchema,
  typeRules: z.array(ruleInputSchema).max(MAX_IMPORT_RULES, `At most ${MAX_IMPORT_RULES} type rules`),
  fieldMaps: z.array(fieldInputSchema).max(MAX_IMPORT_FIELDS, `At most ${MAX_IMPORT_FIELDS} field maps`),
});

export type MappingDocument = z.infer<typeof documentSchema>;

export function exportSet(
  set: MappingSet,
  rules: readonly TypeRule[],
  fields: readonly FieldMap[],
  now: number,
): MappingDocument {
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    set: { name: set.name, description: set.description, notes: set.notes },
    typeRules: rules.map((r) => ({
      selector: r.selector,
      semanticType: r.semanticType,
      priority: r.priority,
      notes: r.notes,
    })),
    fieldMaps: fields.map((f) => ({
      semanticType: f.semanticType,
      fieldName: f.fieldName,
      location: f.location,
      expectedKind: f.expectedKind,
      notes: f.notes,
    })),
  };
}

/** Parses and validates an import. Accepts the JSON text or an already-parsed value. Throws `INVALID_IMPORT`. */
export function parseImport(input: unknown): MappingDocument {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_IMPORT_BYTES) {
      throw new MappingError(
        'INVALID_IMPORT',
        `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
      );
    }
    try {
      value = JSON.parse(input);
    } catch {
      throw new MappingError('INVALID_IMPORT', 'The file is not valid JSON');
    }
  }
  if (typeof value === 'object' && value !== null && 'version' in value) {
    const v = (value as { version: unknown }).version;
    if (typeof v === 'number' && v !== EXPORT_VERSION) {
      throw new MappingError(
        'INVALID_IMPORT',
        `This file is version ${v} of the mapping format; this bridge reads version ${EXPORT_VERSION}`,
      );
    }
  }
  const doc = parseOrThrow(documentSchema, value, 'INVALID_IMPORT');
  // The same field twice for one type would collide on import: say so up front.
  const seen = new Set<string>();
  for (const f of doc.fieldMaps) {
    const k = `${f.semanticType.toLowerCase()}|${f.fieldName.toLowerCase()}`;
    if (seen.has(k)) {
      throw new MappingError(
        'INVALID_IMPORT',
        `${f.semanticType} has the field “${f.fieldName}” more than once`,
        [`fieldMaps: duplicate ${f.semanticType} / ${f.fieldName}`],
      );
    }
    seen.add(k);
  }
  return doc;
}
