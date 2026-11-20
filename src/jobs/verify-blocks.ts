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
 * 2. A mention's display fields, only where LegendKeeper fills them in: `name` ("the resource's current name; it is
 *    read-only", spec `Run`) always, and `text` (its label) when the bridge sent none (CR-2026-11-R3, R3-67: a split's
 *    job read its own mentions back as "not verified"). A label the bridge itself wrote is kept as sent (the owner's
 *    sandbox run, X2, in a table cell too) and is compared. A mention is otherwise compared by its target, `resourceId`
 *    and `documentId`.
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
  'a mention’s name (the page’s current name, filled in by LegendKeeper), and its text when the bridge sent none (the label LegendKeeper fills in); a label the bridge wrote is compared, and so is the target (resourceId, documentId)',
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

/**
 * CR-2026-11-R3 (R3-67): a mention's target (`resourceId`, and `documentId` when it has one), as the verify compares
 * it. Only comparisons use this: a state the bridge stores (to check against, or to put back) keeps the label.
 */
export function mentionTarget(m: Obj): Obj {
  return {
    resourceId: m.resourceId,
    ...(m.documentId !== undefined && m.documentId !== null ? { documentId: m.documentId } : {}),
  };
}

/** A label the bridge sent with a mention (a non-empty `text`), or null: LegendKeeper fills one in then. */
const labelOf = (m: unknown): string | null =>
  isObj(m) && typeof m.text === 'string' && m.text !== '' ? m.text : null;

/**
 * The owner's sandbox run (X2): a mention as the verify compares it: its target, and its label (`text`) when it has one.
 * The stored side's label is dropped first where the bridge sent none (`dropFilled`), so a label LegendKeeper filled in
 * never counts, and a label the bridge wrote always does.
 */
function mentionCompared(m: Obj): Obj {
  const label = labelOf(m);
  return { ...mentionTarget(m), ...(label !== null ? { text: label } : {}) };
}

/**
 * The runs `stored` holds, with the label of each mention dropped where the corresponding mention `sent` (paired in
 * order among the mentions of the list: LegendKeeper merges neighbouring text runs, so positions may shift) carried
 * none. A mention with no counterpart keeps its label.
 */
function dropFilledLabels(sent: readonly unknown[], stored: readonly unknown[]): unknown[] {
  const sentMentions = sent.filter((r) => isObj(r) && isObj(r.mention)) as Obj[];
  let k = 0;
  return stored.map((r) => {
    if (!isObj(r) || !isObj(r.mention)) return r;
    const twin = sentMentions[k++];
    if (!twin || labelOf(twin.mention) !== null) return r;
    return { ...r, mention: withoutKey(r.mention, 'text') };
  });
}

/**
 * CR-2026-11-R3 (R3-67) and X2: whether two lists of runs are the same as the verify judges them: a mention by its
 * target, and by its label when `expected` (what the bridge wrote or expects) carries one; a label LegendKeeper filled
 * in (none expected) never counts. Runs normalised on both sides.
 */
export function sameRuns(expected: readonly Obj[], actual: readonly Obj[]): boolean {
  const e = normaliseRuns(expected).map((r) =>
    isObj(r.mention) ? { ...r, mention: mentionCompared(r.mention) } : r,
  );
  const a = normaliseRuns(dropFilledLabels(expected, actual) as Obj[]).map((r) =>
    isObj(r.mention) ? { ...r, mention: mentionCompared(r.mention) } : r,
  );
  return JSON.stringify(sortKeys(e)) === JSON.stringify(sortKeys(a));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

/**
 * LegendKeeper's run normalisation: empty text runs dropped, neighbours with identical marks merged; a mention's
 * read-only `name` dropped (its label kept: this also makes the states the bridge stores and puts back).
 */
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
      out[k] = mentionCompared(x);
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
 * Drops what LegendKeeper fills in where the plan sent nothing, walking both trees in parallel by position: the stored id
 * of every block the plan sent without one (LegendKeeper gave it an id), and (X2) the label of every mention the plan
 * sent without one (paired in order within each list of runs).
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
    if (k === 'content' && isRuns(x) && isRuns(planned[k])) {
      out[k] = dropFilledLabels(planned[k], x);
      continue;
    }
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
