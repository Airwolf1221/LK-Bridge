import * as z from 'zod';
import type { OperationDef } from './registry-types.js';
import { operations } from './registry.generated.js';
import { defs } from './registry.defs.generated.js';

export { operations };
export type { OperationDef } from './registry-types.js';

const byId = new Map<string, OperationDef>(operations.map((o) => [o.operationId, o]));

export function getOperation(operationId: string): OperationDef | undefined {
  return byId.get(operationId);
}

export function requireOperation(operationId: string): OperationDef {
  const op = byId.get(operationId);
  if (!op) throw new Error(`Unknown LegendKeeper operation: ${operationId}`);
  return op;
}

const schemaCache = new Map<string, z.ZodType>();

/**
 * Body fields the generated schema types as a string only but whose description says `null` is allowed (v2 D2, ADR 0040):
 * a feature's `parentId` ("Parent feature ID for hierarchy (null = root)") is how a feature leaves its folder for the
 * top level. The generated files stay exactly as the spec gives them (the drift check compares them); only the
 * bridge's own validation accepts the null. Whether LegendKeeper takes it is a sandbox check (maps: move to the top
 * level); a refusal is a 400 with nothing written.
 */
const NULLABLE_BODY_FIELDS: Readonly<
  Record<string, { readonly def: string; readonly fields: readonly string[] }>
> = {
  updateFeature: { def: 'FeatureUpdateParams', fields: ['parentId'] },
};

function amendedDefs(operationId: string): typeof defs {
  const a = NULLABLE_BODY_FIELDS[operationId];
  if (!a) return defs;
  const def = (defs as Record<string, unknown>)[a.def] as {
    properties?: Record<string, Record<string, unknown>>;
  };
  const properties = { ...def.properties };
  for (const f of a.fields) {
    const p = properties[f];
    if (p) properties[f] = { ...p, type: [p.type, 'null'] };
  }
  return { ...defs, [a.def]: { ...def, properties } };
}

/** Zod schema for an operation's caller-facing input (`{ path?, query?, ifMatch?, body? }`). Built lazily and cached. */
export function operationInputSchema(operationId: string): z.ZodType {
  const cached = schemaCache.get(operationId);
  if (cached) return cached;
  const op = requireOperation(operationId);
  const schema = z.fromJSONSchema({ ...op.inputJsonSchema, $defs: amendedDefs(operationId) });
  schemaCache.set(operationId, schema);
  return schema;
}
