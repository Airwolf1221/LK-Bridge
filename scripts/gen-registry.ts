/**
 * Generates the operation registry from the vendored LegendKeeper OpenAPI spec.
 *
 *   npm run gen:registry            write src/lk/registry.generated.ts + registry.defs.generated.ts
 *   npm run gen:registry -- --check exit 1 if the committed files are stale
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Concurrency,
  HttpMethod,
  JsonSchema,
  OperationDef,
  OperationKind,
  Risk,
  TierId,
} from '../src/lk/registry-types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_PATH = resolve(root, 'spec/legendkeeper-openapi.json');
export const REGISTRY_PATH = resolve(root, 'src/lk/registry.generated.ts');
export const DEFS_PATH = resolve(root, 'src/lk/registry.defs.generated.ts');

const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
const API_PREFIX = '/api/v3';

/** Operations whose draw on the upload tier is reactive-only (LK publishes no numbers). */
const UPLOAD_OPS = new Set(['createImageUpload', 'createImageAsset']);
/** Member and invite management: disabled by default (LK_ALLOW_MEMBER_ADMIN). */
const ADMIN_OPS = new Set(['inviteMember', 'removeMember', 'revokeInvite']);
/** Destructive regardless of HTTP method (PLAN §4). */
const DESTRUCTIVE_OPS = new Set([
  'replaceDocumentBlocks',
  'replaceBoardContent',
  'updateCalendar',
  'deleteBoardShapes', // POST, but deletes
]);
/** `createManyResources` draws on the items tiers, one unit per array entry. */
const ITEMS_FROM: Record<string, string> = { createManyResources: 'body.resources' };

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}
interface OpenApiOperation {
  operationId: string;
  tags: string[];
  summary?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
}
interface OpenApiSpec {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], OpenApiOperation>>>;
  components: { schemas: Record<string, JsonSchema> };
  info: { version: string };
}

/** Rewrites OpenAPI component refs to the `$defs` location used by the generated registry. */
function rewriteRefs<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', '#/$defs/')) as T;
}

function classify(
  opId: string,
  method: HttpMethod,
  path: string,
): {
  kind: OperationKind;
  concurrency: Concurrency;
  risk: Risk;
} {
  const kind: OperationKind = UPLOAD_OPS.has(opId) ? 'upload' : method === 'GET' ? 'read' : 'write';
  let concurrency: Concurrency = 'none';
  if (kind !== 'read') {
    if (path.includes('{documentId}')) concurrency = 'document';
    else if (path.includes('{resourceId}')) concurrency = 'resource';
  }
  let risk: Risk = 'safe';
  if (ADMIN_OPS.has(opId)) risk = 'admin';
  else if (method === 'DELETE' || DESTRUCTIVE_OPS.has(opId)) risk = 'destructive';
  return { kind, concurrency, risk };
}

function costsFor(kind: OperationKind, itemsFrom: string | undefined): TierId[] {
  const tiers: TierId[] = [];
  if (kind !== 'read') tiers.push('write-min', 'write-hour');
  tiers.push('key-min', 'key-hour', 'key-day', 'project-hour');
  if (itemsFrom) tiers.push('items-min', 'items-hour');
  if (kind === 'upload') tiers.push('upload');
  return tiers;
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function inputSchemaFor(op: OpenApiOperation): { schema: JsonSchema; paged: boolean; versioned: boolean } {
  const pathProps: Record<string, JsonSchema> = {};
  const pathRequired: string[] = [];
  const queryProps: Record<string, JsonSchema> = {};
  const queryRequired: string[] = [];
  let versioned = false;
  let paged = false;

  for (const p of op.parameters ?? []) {
    const schema = rewriteRefs({ ...p.schema, ...(p.description ? { description: p.description } : {}) });
    if (p.in === 'path') {
      if (p.name === 'projectId') continue; // injected from config
      pathProps[p.name] = schema;
      pathRequired.push(p.name);
    } else if (p.in === 'query') {
      queryProps[p.name] = schema;
      if (p.required) queryRequired.push(p.name);
      if (p.name === 'cursor') paged = true;
    } else if (p.in === 'header' && p.name.toLowerCase() === 'if-match') {
      versioned = true;
    }
    // Idempotency-Key is supplied by the bridge (deterministic per job step).
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  if (Object.keys(pathProps).length > 0) {
    properties.path = objectSchema(pathProps, pathRequired);
    required.push('path');
  }
  if (Object.keys(queryProps).length > 0) {
    properties.query = objectSchema(queryProps, queryRequired);
    if (queryRequired.length > 0) required.push('query');
  }
  if (versioned) {
    properties.ifMatch = {
      type: 'string',
      description:
        'Document/board/calendar version to send as If-Match. Omit to let the bridge read the current version first.',
    };
  }
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    properties.body = rewriteRefs(bodySchema);
    if (op.requestBody?.required) required.push('body');
  }
  return { schema: objectSchema(properties, required), paged, versioned };
}

export function buildOperations(spec: OpenApiSpec): OperationDef[] {
  const ops: OperationDef[] = [];
  for (const [fullPath, item] of Object.entries(spec.paths)) {
    if (!fullPath.startsWith(API_PREFIX)) throw new Error(`Unexpected path prefix: ${fullPath}`);
    const pathTemplate = fullPath.slice(API_PREFIX.length);
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const method = m.toUpperCase() as HttpMethod;
      const { kind, concurrency, risk } = classify(op.operationId, method, pathTemplate);
      const itemsFrom = ITEMS_FROM[op.operationId];
      const { schema, paged, versioned } = inputSchemaFor(op);
      ops.push({
        operationId: op.operationId,
        method,
        pathTemplate,
        tag: op.tags[0] ?? 'Untagged',
        summary: op.summary ?? op.operationId,
        kind,
        costs: costsFor(kind, itemsFrom),
        ...(itemsFrom ? { itemsFrom } : {}),
        concurrency,
        versioned,
        paged,
        risk,
        inputJsonSchema: schema,
      });
    }
  }
  const ids = new Set(ops.map((o) => o.operationId));
  if (ids.size !== ops.length) throw new Error('Duplicate operationId in spec');
  return ops;
}

export function generate(specText: string): { registry: string; defs: string } {
  const spec = JSON.parse(specText) as OpenApiSpec;
  const sha = createHash('sha256').update(specText).digest('hex');
  const ops = buildOperations(spec);
  const header =
    '// GENERATED by scripts/gen-registry.ts from spec/legendkeeper-openapi.json. Do not edit.\n';
  const registry =
    header +
    `import type { OperationDef } from './registry-types.js';\n\n` +
    `export const SPEC_API_VERSION = ${JSON.stringify(spec.info.version)};\n` +
    `export const SPEC_SHA256 = ${JSON.stringify(sha)};\n\n` +
    `export const operations: readonly OperationDef[] = ${JSON.stringify(ops, null, 2)};\n`;
  const defs =
    header +
    `import type { JsonSchema } from './registry-types.js';\n\n` +
    `export const defs: Record<string, JsonSchema> = ${JSON.stringify(rewriteRefs(spec.components.schemas), null, 2)};\n`;
  return { registry, defs };
}

function main(): void {
  const check = process.argv.includes('--check');
  const { registry, defs } = generate(readFileSync(SPEC_PATH, 'utf8'));
  if (check) {
    const stale =
      readFileSync(REGISTRY_PATH, 'utf8') !== registry || readFileSync(DEFS_PATH, 'utf8') !== defs;
    if (stale) {
      console.error('Generated registry is stale. Run: npm run gen:registry');
      process.exit(1);
    }
    console.log('Generated registry is up to date.');
    return;
  }
  writeFileSync(REGISTRY_PATH, registry);
  writeFileSync(DEFS_PATH, defs);
  console.log(`Wrote ${REGISTRY_PATH} and ${DEFS_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
