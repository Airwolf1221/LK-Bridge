/**
 * Everything the dashboard shows goes through here first. Secrets never reach the browser (CLAUDE.md): signed upload
 * URLs and their headers, upload keys, image bytes, and anything shaped like a credential are replaced; very long
 * strings and large structures are shortened, so a 64 KB step body or a base64 image cannot flood the page or the
 * event stream. Applied to job and step views, errors, artefacts, the journal, proposals and every stream event.
 */

const SECRET_KEYS = new Set([
  'uploadurl',
  'headers',
  'uploadkey',
  'database64',
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwordhash',
  'secret',
  'clientsecret',
  'apikey',
  'signature',
  'sessiontoken',
  'csrftoken',
  'codeverifier',
  'totpsecret',
]);

export const REDACTED = '[redacted]';

export interface RedactOptions {
  /** Strings longer than this are cut (default 2000 characters). */
  readonly maxString?: number;
  /** Arrays longer than this are cut (default 200 items). */
  readonly maxItems?: number;
  /** Objects with more keys than this are cut (default 200). */
  readonly maxKeys?: number;
  /** Nesting deeper than this is replaced (default 12). */
  readonly maxDepth?: number;
}

const isSecretKey = (k: string): boolean => SECRET_KEYS.has(k.toLowerCase().replace(/[-_\s]/g, ''));

/** A copy of `value` that is safe to show: secrets replaced, long things shortened. JSON-shaped input expected. */
export function redactDeep(value: unknown, opts: RedactOptions = {}): unknown {
  const maxString = opts.maxString ?? 2000;
  const maxItems = opts.maxItems ?? 200;
  const maxKeys = opts.maxKeys ?? 200;
  const maxDepth = opts.maxDepth ?? 12;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      return v.length > maxString ? `${v.slice(0, maxString)}… [${v.length - maxString} more characters]` : v;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return '[nested too deeply to show]';
    if (Array.isArray(v)) {
      const out = v.slice(0, maxItems).map((x) => walk(x, depth + 1));
      if (v.length > maxItems) out.push(`… [${v.length - maxItems} more items]`);
      return out;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, maxKeys)) out[k] = isSecretKey(k) ? REDACTED : walk(x, depth + 1);
    if (entries.length > maxKeys) out['…'] = `${entries.length - maxKeys} more keys`;
    return out;
  };
  return walk(value, 0);
}
