import * as z from 'zod';
import { defs } from '../../lk/registry.defs.generated.js';
import type { JsonSchema, OperationDef } from '../../lk/registry-types.js';
import { opMeta, READERS } from '../../jobs/index.js';

/** The caller-facing input of a registry operation: `{ path?, query?, ifMatch?, body? }` (see lk_api_describe_operation). */
export const paramsSchema = z
  .strictObject({
    path: z
      .record(z.string(), z.string())
      .optional()
      .describe('Path parameters such as { resourceId, documentId }. projectId is supplied by the bridge.'),
    query: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Query parameters such as { limit, cursor }.'),
    ifMatch: z
      .string()
      .optional()
      .describe(
        'The `version` you read. Pass it on versioned writes so a change made since your read is refused (412) instead of overwritten.',
      ),
    body: z.unknown().optional().describe('The request body.'),
  })
  .describe('The operation input. Use lk_api_describe_operation for the exact shape.');

export const detailSchema = z
  .enum(['summary', 'full'])
  .optional()
  .describe('summary (default): ids, names, counts, versions. full: the whole payload, e.g. block trees.');

/** `$defs` reachable from a schema, so a described operation carries only what it needs. */
export function referencedDefs(schema: unknown): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
    } else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
          const name = v.slice('#/$defs/'.length);
          if (!(name in out) && defs[name]) {
            out[name] = defs[name];
            visit(defs[name]);
          }
        } else visit(v);
      }
    }
  };
  visit(schema);
  return out;
}

export type CostClass = 'read' | 'write' | 'items' | 'upload';

export function costClass(op: OperationDef): CostClass {
  if (op.kind === 'upload') return 'upload';
  if (op.itemsFrom) return 'items';
  return op.kind === 'read' ? 'read' : 'write';
}

/** One sentence on what an operation costs, for tool descriptions and describe results. */
export function rateCostText(op: OperationDef): string {
  switch (costClass(op)) {
    case 'read':
      return 'Costs 1 read (key and project request tiers; no write budget).';
    case 'write':
      return 'Costs 1 write (write, key and project tiers); writes are paced at least 500 ms apart.';
    case 'items':
      return 'Costs 1 write plus 1 createMany item per entry of body.resources (600 per minute, 6,000 per hour).';
    case 'upload':
      return 'Costs 1 write plus upload-tier backoff if LegendKeeper throttles uploads; prefer lk_upload_image.';
  }
}

export function versionReader(op: OperationDef): string | null {
  const reader = opMeta(op.operationId).reader;
  return op.versioned && reader ? READERS[reader].op : null;
}

/** Closest operation ids to a mistyped one (small edit distance, or containing it). */
export function suggestOperations(wanted: string, ids: readonly string[], n = 5): string[] {
  const w = wanted.toLowerCase();
  const dist = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length]!;
  };
  return ids
    .map((id) => ({
      id,
      d: id.toLowerCase().includes(w) || w.includes(id.toLowerCase()) ? 0 : dist(w, id.toLowerCase()),
    }))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id);
}
