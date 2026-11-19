/**
 * Verifying a page write (PLAN-v2 10.2 and 10.6, ADR 0031). After `replaceDocumentBlocks`, the engine reads the document
 * again, still inside its lock, and compares the stored blocks with the blocks it sent. A difference means the write
 * did not land as planned (an outside edit overlapped it, or LegendKeeper changed the content); it is recorded on the
 * step, the job and the result, and the write is never retried.
 *
 * The comparison is exact (ids included) except for what LegendKeeper legitimately changes, listed in
 * `VERIFY_IGNORED_FIELDS` and taken from its spec (3.0.0):
 *
 * 1. `version` on a block: the spec's `Versioned…Block` answers carry a read-only version per block.
 * 2. `name` in a mention: "the resource's current name; it is read-only" (spec `Run`).
 * 3. Run normalisation: "a run whose `text` is empty is dropped, and adjacent runs carrying identical marks are merged
 *    into one" (spec `Run`). Both sides are normalised the same way before they are compared.
 * 4. The id of a block sent without one: "A block without an id is given a new id" (spec `DocumentBlocksWrite`). The
 *    bridge mints ids for the blocks it adds, so this only concerns legacy blocks that never had one.
 * 5. The document's own `version`, `text` and `schema`: only `blocks` is compared.
 *
 * Everything else counts, key order excepted.
 */

/** The fields LegendKeeper may change on a write without it being a difference (documented in the result). */
export const VERIFY_IGNORED_FIELDS: readonly string[] = [
  'version on each block (read-only)',
  'name in a mention (read-only: the page’s current name)',
  'runs normalised as LegendKeeper does on write (empty text runs dropped, neighbouring runs with the same marks merged)',
  'the id LegendKeeper gives a block sent without one',
  'the document’s own version, text and schema (only the blocks are compared)',
];

export interface BlockDifference {
  /** Where, as a JSON path into `blocks` (`[3].children[0].content`). */
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface BlockComparison {
  readonly ok: boolean;
  /** The first differences (at most `limit`), in document order. */
  readonly differences: readonly BlockDifference[];
  /** How many differences there are in all (counting stops at 1,000). */
  readonly count: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `content` array of runs (objects without a `kind`). */
function isRuns(v: unknown): v is Obj[] {
  return Array.isArray(v) && v.every((r) => isObj(r) && typeof r.kind !== 'string');
}

const marksOf = (r: Obj): string =>
  JSON.stringify(
    Object.keys(r)
      .filter((k) => k !== 'text')
      .sort()
      .map((k) => [k, r[k]]),
  );

/** LegendKeeper's run normalisation: empty text runs dropped, neighbours with identical marks merged. */
export function normaliseRuns(runs: readonly Obj[]): Obj[] {
  const out: Obj[] = [];
  for (const raw of runs) {
    const r: Obj = isObj(raw.mention) ? { ...raw, mention: withoutKey(raw.mention, 'name') } : { ...raw };
    if (typeof r.text === 'string') {
      if (r.text === '') continue;
      const prev = out[out.length - 1];
      if (prev && typeof prev.text === 'string' && marksOf(prev) === marksOf(r)) {
        out[out.length - 1] = { ...prev, text: `${prev.text}${r.text}` };
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

function withoutKey(o: Obj, key: string): Obj {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

/** One value normalised for comparison: block versions dropped, runs and mentions normalised, at any depth. */
function normalise(v: unknown, depth = 0): unknown {
  if (depth > 200) return v;
  if (Array.isArray(v)) return v.map((x) => normalise(x, depth + 1));
  if (!isObj(v)) return v;
  const out: Obj = {};
  const block = typeof v.kind === 'string';
  for (const [k, x] of Object.entries(v)) {
    if (block && k === 'version') continue;
    if (k === 'mention' && isObj(x)) {
      out[k] = withoutKey(x, 'name');
      continue;
    }
    out[k] =
      k === 'content' && isRuns(x)
        ? normaliseRuns(x).map((r) => normalise(r, depth + 1))
        : normalise(x, depth + 1);
  }
  return out;
}

/**
 * CR-2026-11-R3 (R3-17): a value normalised exactly as `compareStoredBlocks` compares it (block versions dropped, runs and
 * mentions normalised as LegendKeeper stores them), for callers that compare blocks by a print (a split's moved blocks).
 */
export function normaliseForCompare(v: unknown): unknown {
  return normalise(v);
}

/**
 * Drops the stored id of every block the plan sent without one (LegendKeeper gave it an id), walking both trees in
 * parallel by position.
 */
function dropMintedIds(planned: unknown, stored: unknown, depth = 0): unknown {
  if (depth > 200) return stored;
  if (Array.isArray(planned) && Array.isArray(stored)) {
    return stored.map((s, i) => dropMintedIds(planned[i], s, depth + 1));
  }
  if (!isObj(planned) || !isObj(stored)) return stored;
  const out: Obj = {};
  for (const [k, x] of Object.entries(stored)) {
    if (k === 'id' && typeof planned.kind === 'string' && planned.id === undefined) continue;
    out[k] = k in planned ? dropMintedIds(planned[k], x, depth + 1) : x;
  }
  return out;
}

const short = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…` : (v ?? null);
};

function walk(
  a: unknown,
  b: unknown,
  path: string,
  out: BlockDifference[],
  state: { n: number },
  limit: number,
) {
  if (state.n >= 1000) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) {
        state.n++;
        if (out.length < limit)
          out.push({
            path: `${path}[${i}]`,
            expected: i < a.length ? short(a[i]) : '(nothing)',
            actual: i < b.length ? short(b[i]) : '(nothing)',
          });
        continue;
      }
      walk(a[i], b[i], `${path}[${i}]`, out, state, limit);
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a) || !(k in b)) {
        state.n++;
        if (out.length < limit)
          out.push({
            path: `${path}.${k}`,
            expected: k in a ? short(a[k]) : '(absent)',
            actual: k in b ? short(b[k]) : '(absent)',
          });
        continue;
      }
      walk(a[k], b[k], `${path}.${k}`, out, state, limit);
    }
    return;
  }
  if (Object.is(a, b)) return;
  state.n++;
  if (out.length < limit) out.push({ path: path || '(blocks)', expected: short(a), actual: short(b) });
}

/** Compares the blocks the bridge sent with the blocks LegendKeeper now holds (see the module comment). */
export function compareStoredBlocks(planned: unknown, stored: unknown, limit = 20): BlockComparison {
  const a = normalise(Array.isArray(planned) ? planned : []);
  const b = normalise(dropMintedIds(planned, Array.isArray(stored) ? stored : []));
  const differences: BlockDifference[] = [];
  const state = { n: 0 };
  walk(a, b, '', differences, state, limit);
  return { ok: state.n === 0, differences, count: state.n };
}
