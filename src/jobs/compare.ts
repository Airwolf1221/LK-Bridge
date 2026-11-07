/**
 * "Does LK already hold what this write intended?" Used when verifying a write that may have applied (after a
 * restart, or a 412 / DUPLICATE_ID after an ambiguous retry, PLAN §5.3).
 *
 * The comparison is a structural subset: every value the write specified must be present and equal in the re-read;
 * fields LK adds (ids for new blocks, timestamps, `version`, defaults) are ignored. Arrays:
 * - `replace`: same length, compared position by position (a replace sends the whole list);
 * - `patch`: when every intended element has an `id`, each is matched to the re-read element with that id; otherwise
 *   positional, same length.
 * A false negative only ever makes the engine more careful (a conflict or `uncertain`), never a duplicate.
 */
export type CompareMode = 'replace' | 'patch';

const IGNORED_KEYS = new Set(['version']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasId(v: unknown): v is { id: string } {
  return isObject(v) && typeof v.id === 'string';
}

export function matchesIntent(intended: unknown, actual: unknown, mode: CompareMode = 'patch'): boolean {
  if (intended === undefined) return true;
  if (intended === null) return actual === null || actual === undefined;
  if (Array.isArray(intended)) {
    if (!Array.isArray(actual)) return false;
    if (mode === 'patch' && intended.length > 0 && intended.every(hasId)) {
      const byId = new Map(actual.filter(hasId).map((a) => [a.id, a]));
      return intended.every((i) => matchesIntent(i, byId.get(i.id), mode));
    }
    if (intended.length !== actual.length) return false;
    return intended.every((v, i) => matchesIntent(v, actual[i], mode));
  }
  if (isObject(intended)) {
    if (!isObject(actual)) return false;
    for (const [k, v] of Object.entries(intended)) {
      if (IGNORED_KEYS.has(k)) continue;
      if (!matchesIntent(v, actual[k], mode)) return false;
    }
    return true;
  }
  return Object.is(intended, actual);
}
