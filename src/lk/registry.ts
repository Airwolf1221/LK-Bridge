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

/** Zod schema for an operation's caller-facing input (`{ path?, query?, ifMatch?, body? }`). Built lazily and cached. */
export function operationInputSchema(operationId: string): z.ZodType {
  const cached = schemaCache.get(operationId);
  if (cached) return cached;
  const op = requireOperation(operationId);
  const schema = z.fromJSONSchema({ ...op.inputJsonSchema, $defs: defs });
  schemaCache.set(operationId, schema);
  return schema;
}
