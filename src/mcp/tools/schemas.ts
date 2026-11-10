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

/**
 * Verbs a caller is likely to use for the operation the bridge actually has (hotfix, ADR 0033): `appendDocumentBlocks`
 * is not an operation, `insertBlock` is. `get` and `list` are related because both read.
 */
const VERB_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  append: ['insert'],
  add: ['insert'],
  create: ['insert'],
  edit: ['update'],
  set: ['update'],
  remove: ['delete'],
  fetch: ['get', 'list'],
  list: ['get'],
  get: ['list'],
};

/** Case-insensitive Levenshtein distance. */
function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[y.length]!;
}

/** `insertDocumentBlocks` → ['insert', 'document', 'block'] (camel-case words, lower case, plural trimmed). */
function words(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

const sameWord = (a: string, b: string) =>
  a === b || (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1);

/**
 * The closest operation ids to one that does not exist (at most `n`): the verb counts most (the same verb, or a
 * synonym of it: append, add, create → insert; edit, set → update; remove → delete; fetch → get or list), then the
 * nouns the two share (document, block…), then a case-insensitive edit distance of the whole id, which also catches a
 * plain typo. Example: `appendDocumentBlocks` → insertBlock, replaceDocumentBlocks, getDocumentBlocks.
 */
export function suggestOperations(wanted: string, ids: readonly string[], n = 5): string[] {
  const w = wanted.toLowerCase();
  const [verb = '', ...nouns] = words(wanted);
  const synonyms = VERB_SYNONYMS[verb] ?? [];
  return ids
    .map((id) => {
      const lower = id.toLowerCase();
      if (lower === w) return { id, score: 100 };
      const [cverb = '', ...cnouns] = words(id);
      let score = cverb === verb ? 3 : synonyms.includes(cverb) ? 2.5 : 0;
      score += 1.5 * nouns.filter((x) => cnouns.some((y) => sameWord(x, y))).length;
      if (lower.includes(w) || w.includes(lower)) score += 2;
      score += 1.5 * Math.max(0, 1 - editDistance(w, lower) / Math.max(w.length, lower.length));
      return { id, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id);
}
