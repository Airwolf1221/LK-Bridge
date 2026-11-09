/**
 * A small JSON Schema validator for the vendored spec's block schemas (`src/lk/registry.defs.generated.ts`, generated
 * from spec/legendkeeper-openapi.json). It supports exactly the keywords those schemas use and dispatches `oneOf` on its
 * `discriminator`, so a 3,000-block page validates in milliseconds with a precise path for every problem (the generic
 * zod import took seconds and reported only "invalid union").
 *
 * Strings are measured in UTF-16 code units, as JavaScript validators (and so, most likely, LegendKeeper) measure them;
 * that is never more lenient than counting code points.
 */
import { defs } from '../lk/registry.defs.generated.js';

type Schema = Record<string, unknown>;

export interface SchemaIssue {
  /** Dotted path from the validated value, e.g. `children[0].content[2].text`. */
  readonly path: string;
  /** The keyword that failed (`maxLength`, `additionalProperties`, `type`…). */
  readonly keyword: string;
  readonly message: string;
}

/** Keywords that state a size limit: their failures are field-limit errors rather than schema errors. */
export const LIMIT_KEYWORDS: ReadonlySet<string> = new Set([
  'maxLength',
  'maxItems',
  'maxProperties',
  'maximum',
  'minimum',
  'exclusiveMinimum',
  'minLength',
  'minItems',
  'x-max-depth',
]);

const MAX_ISSUES = 50;

function def(name: string): Schema {
  const s = (defs as Record<string, unknown>)[name];
  if (!s || typeof s !== 'object') throw new Error(`schema: unknown definition ${name}`);
  return s as Schema;
}

function resolve(s: Schema): Schema {
  let cur = s;
  for (let i = 0; i < 32 && typeof cur.$ref === 'string'; i++) {
    cur = def(cur.$ref.replace('#/$defs/', '').replace('#/components/schemas/', ''));
  }
  return cur;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  if (want === 'number') return t === 'number' || t === 'integer';
  return want === t;
}

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

const regexCache = new Map<string, RegExp>();
function regex(p: string): RegExp {
  let r = regexCache.get(p);
  if (!r) {
    r = new RegExp(p, 'u');
    regexCache.set(p, r);
  }
  return r;
}

class Validator {
  readonly issues: SchemaIssue[] = [];
  private add(path: string, keyword: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, keyword, message });
  }

  /** Returns true when valid. Issues are recorded only when `record` is true. */
  check(schema: Schema, v: unknown, path: string, record: boolean): boolean {
    const s = resolve(schema);
    if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return this.alternatives(s, v, path, record);
    let ok = true;
    const fail = (keyword: string, message: string) => {
      ok = false;
      if (record) this.add(path, keyword, message);
    };
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeMatches(t, v))) {
        fail('type', `expected ${types.join(' or ')}, got ${typeOf(v)}`);
        return false;
      }
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => Object.is(e, v))) {
      fail('enum', `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }
    if (typeof v === 'string') {
      if (typeof s.maxLength === 'number' && v.length > s.maxLength)
        fail('maxLength', `is ${v.length} characters long; the limit is ${s.maxLength}`);
      if (typeof s.minLength === 'number' && v.length < s.minLength)
        fail('minLength', `must be at least ${s.minLength} characters long`);
      if (typeof s.pattern === 'string' && !regex(s.pattern).test(v))
        fail('pattern', `must match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (typeof s.maximum === 'number' && v > s.maximum) fail('maximum', `must be at most ${s.maximum}`);
      if (typeof s.minimum === 'number' && v < s.minimum) fail('minimum', `must be at least ${s.minimum}`);
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum)
        fail('exclusiveMinimum', `must be more than ${s.exclusiveMinimum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.maxItems === 'number' && v.length > s.maxItems)
        fail('maxItems', `holds ${v.length} items; the limit is ${s.maxItems}`);
      if (typeof s.minItems === 'number' && v.length < s.minItems)
        fail('minItems', `must hold at least ${s.minItems} items`);
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
      for (let i = 0; i < v.length; i++) {
        const item = i < prefix.length ? prefix[i] : (s.items as Schema | undefined);
        if (item && !this.check(item, v[i], join(path, i), record)) {
          ok = false;
          if (!record) return false;
        }
      }
    }
    if (typeOf(v) === 'object') {
      const o = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) {
        if (!(r in o) || o[r] === undefined) fail('required', `${join(path, r)} is required`);
      }
      const keys = Object.keys(o).filter((k) => o[k] !== undefined);
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties)
        fail('maxProperties', `holds ${keys.length} keys; the limit is ${s.maxProperties}`);
      for (const k of keys) {
        if (s.propertyNames && !this.check(s.propertyNames as Schema, k, join(path, k), record)) ok = false;
        const p = props[k];
        if (p) {
          if (!this.check(p, o[k], join(path, k), record)) {
            ok = false;
            if (!record) return false;
          }
        } else if (s.additionalProperties === false) {
          ok = false;
          if (record)
            this.add(join(path, k), 'additionalProperties', 'is not a field LegendKeeper accepts here');
        } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
          if (!this.check(s.additionalProperties as Schema, o[k], join(path, k), record)) ok = false;
        }
      }
    }
    return ok;
  }

  private alternatives(s: Schema, v: unknown, path: string, record: boolean): boolean {
    const branches = (s.oneOf ?? s.anyOf) as Schema[];
    const disc = s.discriminator as { propertyName: string; mapping?: Record<string, string> } | undefined;
    if (disc && typeOf(v) === 'object') {
      const tag = (v as Record<string, unknown>)[disc.propertyName];
      const ref = typeof tag === 'string' ? disc.mapping?.[tag] : undefined;
      if (!ref) {
        if (record) {
          const known = Object.keys(disc.mapping ?? {}).join(', ');
          this.add(
            join(path, disc.propertyName),
            'discriminator',
            `unknown ${disc.propertyName} ${JSON.stringify(tag)}; expected one of ${known}`,
          );
        }
        return false;
      }
      return this.check({ $ref: ref }, v, path, record);
    }
    for (const b of branches) if (this.check(b, v, path, false)) return true;
    if (!record) return false;
    // Report the closest branch: the one with the fewest problems.
    let best: SchemaIssue[] | null = null;
    for (const b of branches) {
      const probe = new Validator();
      probe.check(b, v, path, true);
      if (best === null || probe.issues.length < best.length) best = probe.issues;
    }
    for (const i of best ?? []) this.add(i.path, i.keyword, i.message);
    if (!best || best.length === 0) this.add(path, 'anyOf', 'matches none of the accepted shapes');
    return false;
  }
}

/** Validates `value` against a spec definition (default `Block`). Returns the problems found (empty when valid). */
export function validateAgainstSpec(value: unknown, definition = 'Block'): SchemaIssue[] {
  const v = new Validator();
  v.check({ $ref: `#/$defs/${definition}` }, value, '', true);
  return v.issues;
}

/** The spec's nesting limit for blocks (`x-max-depth`). */
export const MAX_BLOCK_DEPTH: number = (() => {
  const d = def('Block')['x-max-depth'];
  return typeof d === 'number' ? d : 64;
})();

/** The spec's limit on blocks per document (`DocumentBlocksWrite.blocks.maxItems`). */
export const MAX_DOCUMENT_BLOCKS: number = (() => {
  const blocks = (def('DocumentBlocksWrite').properties as Record<string, Schema> | undefined)?.blocks;
  return typeof blocks?.maxItems === 'number' ? blocks.maxItems : 10_000;
})();
