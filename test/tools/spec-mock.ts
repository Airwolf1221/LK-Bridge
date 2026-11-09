/**
 * A responder for chunk 1's mock LK that answers EVERY operation from the vendored OpenAPI spec: the route table
 * (method + path -> operationId) and the 2xx response schema come from spec/legendkeeper-openapi.json, and a
 * schema-valid example body is generated from it. Also generates example inputs from the registry's schemas.
 */
import { readFileSync } from 'node:fs';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { operationInputSchema, operations, type OperationDef } from '../../src/lk/registry.js';
import { defs } from '../../src/lk/registry.defs.generated.js';

type Schema = Record<string, unknown>;
interface Spec {
  paths: Record<
    string,
    Record<
      string,
      { operationId: string; responses: Record<string, { content?: Record<string, { schema?: Schema }> }> }
    >
  >;
  components: { schemas: Record<string, Schema> };
}
const spec = JSON.parse(
  readFileSync(new URL('../../spec/legendkeeper-openapi.json', import.meta.url), 'utf8'),
) as Spec;

// ------------------------------------------------------------------------------------------------ examples

export interface ExampleOptions {
  /** Include optional properties one level deep (responses) or only required ones (inputs). */
  readonly all?: boolean;
}

function resolve(schema: Schema, pool: Record<string, Schema>): Schema {
  let cur = schema;
  for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++) {
    const name = cur.$ref.split('/').pop()!;
    cur = pool[name] ?? {};
  }
  return cur;
}

export function example(
  schema: Schema,
  pool: Record<string, Schema>,
  o: ExampleOptions = {},
  depth = 0,
  key = '',
): unknown {
  const s = resolve(schema, pool);
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (Array.isArray(s.allOf)) {
    return Object.assign({}, ...(s.allOf as Schema[]).map((x) => example(x, pool, o, depth, key) as object));
  }
  const alt = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (alt) {
    const first = alt.find((x) => resolve(x, pool).type !== 'null') ?? alt[0]!;
    return example(first, pool, o, depth, key);
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? 'null';
  if (type === undefined && s.properties) type = 'object';
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, Schema>;
      const required = new Set((s.required ?? []) as string[]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        const want = required.has(k) || (o.all === true && depth < 2 && !k.startsWith('_'));
        if (want && depth < 12) out[k] = example(v, pool, o, depth + 1, k);
      }
      return out;
    }
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      if (min === 0 && !(o.all === true && depth < 2)) return [];
      if (depth > 10) return [];
      return [example((s.items ?? {}) as Schema, pool, o, depth + 1, key)];
    }
    case 'string': {
      if (s.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.test/x';
      if (s.format === 'email') return 'someone@example.test';
      const pattern = typeof s.pattern === 'string' ? s.pattern : '';
      if (pattern.includes('a-f0-9') && s.minLength === 64) return 'a'.repeat(64);
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const base = key === 'id' || key.endsWith('Id') ? 'id' : 'x';
      return (base + 'x'.repeat(Math.max(0, min))).slice(0, Math.max(min, base.length));
    }
    case 'integer':
    case 'number': {
      if (typeof s.minimum === 'number')
        return Math.max(s.minimum, 1) <= (typeof s.maximum === 'number' ? s.maximum : Infinity)
          ? Math.max(s.minimum, 1)
          : s.minimum;
      if (typeof s.exclusiveMinimum === 'number') return s.exclusiveMinimum + 1;
      return 1;
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return {};
  }
}

/** Per-operation fixes where a required-only example is not what LK needs (or not valid on its own). */
const INPUT_OVERRIDES: Record<string, (base: Record<string, unknown>) => Record<string, unknown>> = {
  // The schema allows an empty list, but the items tiers cannot cost it.
  createManyResources: (base) => ({ ...base, body: { resources: [{ name: 'One' }, { name: 'Two' }] } }),
};

/** A valid caller-facing input `{ path?, query?, ifMatch?, body? }` for an operation. */
export function exampleInput(op: OperationDef): Record<string, unknown> {
  const raw = example(op.inputJsonSchema, defs) as Record<string, unknown>;
  const input = INPUT_OVERRIDES[op.operationId]?.(raw) ?? raw;
  const parsed = operationInputSchema(op.operationId).safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `example input for ${op.operationId} is invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
    );
  }
  return input;
}

// ------------------------------------------------------------------------------------------------ routes

interface Route {
  readonly operationId: string;
  readonly method: string;
  readonly pattern: RegExp;
  readonly literals: number;
  readonly status: number;
  readonly schema: Schema | undefined;
}

function buildRoutes(): Route[] {
  const routes: Route[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, opDef] of Object.entries(item)) {
      const statuses = Object.keys(opDef.responses)
        .filter((c) => c.startsWith('2'))
        .sort();
      const status = Number(statuses[0] ?? '200');
      const schema = opDef.responses[String(status)]?.content?.['application/json']?.schema;
      const segments = path.split('/').filter(Boolean);
      routes.push({
        operationId: opDef.operationId,
        method: method.toUpperCase(),
        pattern: new RegExp(`^/${segments.map((s) => (s.startsWith('{') ? '[^/]+' : s)).join('/')}$`),
        literals: segments.filter((s) => !s.startsWith('{')).length,
        status,
        schema,
      });
    }
  }
  return routes.sort((a, b) => b.literals - a.literals);
}

const ROUTES = buildRoutes();

export function routeFor(method: string, path: string): Route | undefined {
  const clean = path.replace(/\/$/, '');
  return ROUTES.find((r) => r.method === method && r.pattern.test(clean));
}

/** Answers any LK request from the spec. `overrides` lets a test replace the body for an operation. */
export function specRespond(overrides: Record<string, (req: MockRequest) => MockResponse | undefined> = {}) {
  return (req: MockRequest): MockResponse | undefined => {
    const route = routeFor(req.method, req.path);
    if (!route)
      return {
        status: 404,
        body: { message: 'no such route in the spec', code: 'NOT_FOUND', requestId: 'spec-mock' },
      };
    const custom = overrides[route.operationId]?.(req);
    if (custom) return custom;
    // v2 A1: a project key sees exactly its own project, which the bridge checks at start-up (the spec's example would
    // be a project with the id "id"). Tests that need another answer override listProjects.
    if (route.operationId === 'listProjects') {
      return {
        status: 200,
        body: { data: [{ id: 'proj_mock', name: 'Mock project' }], hasMore: false, nextCursor: null },
      };
    }
    if (route.status === 204 || !route.schema) return { status: route.status };
    return {
      status: route.status,
      body: example(route.schema, spec.components.schemas, { all: true }),
    };
  };
}

export const allOperations = operations;
