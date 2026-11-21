/**
 * CR-2026-11-R4 (the owner's request L, characters with more than one life; the reviewer's RC-5 to RC-7): a character's
 * lives, and its state at a date. Pure functions: the identity page's dated births, deaths and starts (returns and
 * restorations) in, already read with the calendar (their spans), the lives and the state out.
 *
 * - **The lives** are built from ALL of them, whatever the Life State (the death guard's own algorithm, ADR 0065 "On top
 *   of F4b.1" 6): in date order, a start opens a life; a death closes the open life (a further death with no life open
 *   restates the last one's); a return or a restoration while a life is open closes it unrecorded (a return implies a
 *   death before it) and opens the next; a birth after a closed life opens the next (the guard's "next recorded birth"),
 *   and a birth of a later named life ("second life born …") likewise; any other birth restates the open life's.
 * - **A recorded death always wins inside its own span** (the owner's guard): a date reaching a death is never Alive; a
 *   date that overlaps a death's span is Unestablished ("the date spans the recorded death", RC-5); after it the
 *   character is between lives (a later life is recorded) or Deceased (none is), or, with a Life State recording the
 *   character alive now and no later life, "Unestablished (recorded death; current Life State …)".
 * - **Disagreeing deaths** (RC-7): a death is recorded from the earliest; after its start nothing is established.
 * - **A life that ended unrecorded** (a return with no death before it, RC-6): before the return nothing is
 *   established, unless an attestation inside that life says alive.
 * - **Attestations** belong to the life they fall in, from that life's start (else their own start) to their end (an
 *   attestation of the present: to the present), never past that life's death or the next life's start.
 * - **The Life State** (an alive value, a "Deceased by" bound) speaks of the last life only.
 *
 * A character with one life reads exactly as before (the same states and the same words); one with several names the
 * life a date falls in ("in the second life", "between lives: after the first life’s death, before the second life’s
 * birth", "in the restored life").
 */
import { overlaps, type Span } from './dates.js';
import type { StoredFact } from './facts-index.js';

/** A dated statement a life is built from, with its span. */
export interface LifeMark {
  readonly fact: StoredFact;
  readonly span: Span;
  /** Main CANON's, shown in an AU (D9). */
  readonly inherited: boolean;
  /** A death restated on another Authoritative page or a chronology row (the identity page records none: RC-7). */
  readonly restated?: boolean;
}

export type StartHow = 'birth' | 'return' | 'restoration';

export interface Life {
  /** 1 for the first. */
  readonly n: number;
  /** How it began: a birth, a return, a restoration; null when no start is recorded (the first life only). */
  readonly began: StartHow | null;
  /** The statements of its start (several births may restate it). */
  readonly starts: readonly LifeMark[];
  /** The statements of its death (several may restate it); empty when none is recorded. */
  readonly deaths: readonly LifeMark[];
  /** Its deaths disagree (their spans do not all overlap): a death is recorded from the earliest. */
  readonly disputed: boolean;
  /** It ended before the next life began, but no death of it is recorded. */
  readonly endedUnrecorded: boolean;
  /** The attestations that fall in it. */
  readonly attested: readonly LifeMark[];
}

export interface LivesInput {
  readonly births: readonly LifeMark[];
  readonly deaths: readonly LifeMark[];
  /** Returns and restorations: attested starts that begin a new life. */
  readonly starts: readonly LifeMark[];
  /** Attestations (attested bounds `to` and `both`). */
  readonly attested: readonly LifeMark[];
}

interface Building {
  n: number;
  began: StartHow | null;
  starts: LifeMark[];
  deaths: LifeMark[];
  endedUnrecorded: boolean;
  attested: LifeMark[];
}

const howOf = (m: LifeMark, isBirth: boolean): StartHow =>
  isBirth ? 'birth' : m.fact.start === 'restoration' ? 'restoration' : 'return';

/** The lives of a character, in order (at least one, possibly with no recorded start). */
export function buildLives(input: LivesInput): Life[] {
  type Ev = { at: number; order: number; seq: number; start?: StartHow; mark: LifeMark };
  const ev: Ev[] = [
    ...input.births.map((m) => ({
      at: m.span.from,
      order: 0,
      seq: m.fact.seq,
      start: 'birth' as const,
      mark: m,
    })),
    ...input.starts.map((m) => ({
      at: m.span.from,
      order: 0,
      seq: m.fact.seq,
      start: howOf(m, false),
      mark: m,
    })),
    ...input.deaths.map((m) => ({ at: m.span.from, order: 1, seq: m.fact.seq, mark: m })),
  ].sort((a, b) => a.at - b.at || a.order - b.order || a.seq - b.seq);
  const lives: Building[] = [];
  let open: Building | null = null;
  const begin = (e: Ev): Building => ({
    n: lives.length + 1,
    began: e.start ?? null,
    starts: [e.mark],
    deaths: [],
    endedUnrecorded: false,
    attested: [],
  });
  for (const e of ev) {
    if (e.start) {
      if (!open) {
        open = begin(e);
        continue;
      }
      // A return or a restoration, or the birth of a later named life, while a life is open: that life ended unrecorded.
      const later = e.start !== 'birth' || (e.mark.fact.life ?? 1) > (open.starts[0]?.fact.life ?? open.n);
      if (later) {
        open.endedUnrecorded = true;
        lives.push(open);
        open = begin(e);
      } else open.starts.push(e.mark);
      continue;
    }
    if (open) {
      open.deaths.push(e.mark);
      lives.push(open);
      open = null;
    } else if (lives.length > 0) lives[lives.length - 1]!.deaths.push(e.mark);
    else
      lives.push({ n: 1, began: null, starts: [], deaths: [e.mark], endedUnrecorded: false, attested: [] });
  }
  if (open) lives.push(open);
  if (lives.length === 0)
    lives.push({ n: 1, began: null, starts: [], deaths: [], endedUnrecorded: false, attested: [] });
  // Attestations, each in the life it falls in (by its start, or for "through" its end).
  for (const a of input.attested) {
    const anchor = a.fact.bound === 'to' ? a.span.to : a.span.from;
    let at = 0;
    for (let i = 0; i < lives.length; i++) {
      const from = startFrom(lives[i]!);
      if (from === null || from <= anchor) at = i;
    }
    lives[at]!.attested.push(a);
  }
  return lives.map((l) => ({
    ...l,
    disputed: l.deaths.length > 1 && !l.deaths.every((d) => l.deaths.every((x) => overlaps(d.span, x.span))),
  }));
}

/** A life's earliest start, or null when none is recorded. */
function startFrom(l: { readonly starts: readonly LifeMark[] }): number | null {
  return l.starts.length ? Math.min(...l.starts.map((s) => s.span.from)) : null;
}
/** A life's latest possible start (the last minute of its latest start statement). */
function startTo(l: Life): number | null {
  return l.starts.length ? Math.max(...l.starts.map((s) => s.span.to)) : null;
}
/** A life's death span (all its statements together), or null. */
function deathSpan(l: Life): Span | null {
  return l.deaths.length
    ? { from: Math.min(...l.deaths.map((d) => d.span.from)), to: Math.max(...l.deaths.map((d) => d.span.to)) }
    : null;
}

const ORDINAL_WORDS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
] as const;

/** A life's name in answers: "the first life", "the second life", "the restored life" (one begun by a restoration). */
export function lifeName(l: Pick<Life, 'n' | 'began'>): string {
  if (l.began === 'restoration') return 'the restored life';
  const w = ORDINAL_WORDS[l.n - 1];
  return w ? `the ${w} life` : `life ${l.n}`;
}

/** How a life began, in words: "its recorded birth (…)", "the recorded return (…)", "the restoration (…)". */
function startWords(l: Life): string {
  const t = l.starts[0]?.fact.valueText ?? '';
  return l.began === 'return'
    ? `the recorded return (${t})`
    : l.began === 'restoration'
      ? `the restoration (${t})`
      : `its recorded birth (${t})`;
}

const deathText = (l: Life): string => [...new Set(l.deaths.map((d) => d.fact.valueText))].join('; ');

/** A Life State recording the character alive now (an alive value), as `arkona_as_of` reads it. */
export interface AliveReading {
  /** Where its attestation ends: its own date ("Alive in 5A 931"), else the present. */
  readonly end: Span;
  /** "the present (5A 931)", or "4A 500 (the date the Life State gives)". */
  readonly endText: string;
  readonly value: string;
  /** Its principal part ("Alive"), for the guard's state. */
  readonly principal: string;
  readonly inherited: boolean;
}

/** A Life State's upper bound on death ("Deceased by 5A 931"). */
export interface UpperBound {
  readonly span: Span;
  readonly text: string;
  readonly approximate: boolean;
  readonly value: string;
  readonly inherited: boolean;
}

export interface LifeState {
  readonly value: string;
  readonly why: string;
  readonly inherited: boolean;
  /** Where the date falls: before the first life, in a life, between two, after the last, or across a boundary. */
  readonly position: 'before' | 'in' | 'between' | 'after' | 'spans';
  /** The life the date falls in (or the last one before it): an index into the lives. */
  readonly life: number | null;
  /** For `between`: the lives before and after the date. */
  readonly between?: readonly [number, number];
}

/** The attested window of a life: from its start (else the attestation's own) to the latest attestation, clipped. */
function windowOf(
  lives: readonly Life[],
  i: number,
  present: Span | null,
): (Span & { inherited: boolean }) | null {
  const l = lives[i]!;
  const sTo = startTo(l);
  const next = lives[i + 1];
  const limit = Math.min(
    deathSpan(l)?.from ?? Number.POSITIVE_INFINITY,
    (next ? startFrom(next) : null) ?? Number.POSITIVE_INFINITY,
  );
  let w: (Span & { inherited: boolean }) | null = null;
  for (const a of l.attested) {
    const from = sTo !== null ? Math.min(sTo, a.span.from) : a.span.from;
    // "alive at 5A 931": attested up to the present (D10).
    const to = present && overlaps(a.span, present) ? Math.max(a.span.to, present.to) : a.span.to;
    const clipped = Math.min(to, limit - 1);
    if (clipped < from) continue;
    w = w
      ? { from: Math.min(w.from, from), to: Math.max(w.to, clipped), inherited: w.inherited && a.inherited }
      : { from, to: clipped, inherited: a.inherited };
  }
  return w;
}

/**
 * The state at a date (D7, as amended by ADR 0065 and ADR 0064 amendment 2, with the owner's guard), over the lives.
 * One life: exactly F4.1's states and words. Several: the life is named in the reason.
 */
export function stateAt(o: {
  readonly lives: readonly Life[];
  readonly at: Span;
  readonly present: Span | null;
  readonly alive: AliveReading | null;
  readonly deceasedBy: UpperBound | null;
}): LifeState {
  const { lives, at } = o;
  const multi = lives.length > 1;
  const inh = (...ms: readonly (LifeMark | undefined)[]) => ms.some((m) => m?.inherited === true);
  const named = (i: number, s: string) => {
    if (!multi) return s;
    const l = lives[i]!;
    return l.began === 'restoration'
      ? `after the restoration (${l.starts[0]?.fact.valueText ?? ''}), in ${lifeName(l)}: ${s}`
      : `in ${lifeName(l)}: ${s}`;
  };
  const out = (
    value: string,
    why: string,
    position: LifeState['position'],
    life: number | null,
    inherited: boolean,
    between?: readonly [number, number],
  ): LifeState => ({ value, why, position, life, inherited, ...(between ? { between } : {}) });
  const unknown =
    'nothing recorded places the character alive or dead at this date (an attested life does not prove survival past it)';

  // The life the date starts in: the last whose start is at or before it (the first, when none started yet).
  let i = 0;
  for (let k = 0; k < lives.length; k++) {
    const f = startFrom(lives[k]!);
    if (f === null || f <= at.from) i = k;
  }
  const l = lives[i]!;
  const sFrom = startFrom(l);
  const sTo = startTo(l);
  if (sFrom !== null && at.from < sFrom) {
    // Before the first life began.
    return at.to < sFrom
      ? out(
          'Unestablished',
          l.began === 'birth' ? 'before the recorded birth' : unknown,
          'before',
          null,
          false,
        )
      : out('Unestablished', unknown, 'spans', i, false);
  }
  if (sTo !== null && at.from <= sTo && i > 0)
    return out(
      'Unestablished',
      `the date spans ${startWords(l)} that begins ${lifeName(l)}`,
      'spans',
      i,
      inh(l.starts[0]),
    );
  const next = lives[i + 1];
  const nFrom = next ? startFrom(next) : null;
  const last = i === lives.length - 1;

  // A recorded death always wins inside its own span.
  const d = deathSpan(l);
  if (d && at.to >= d.from) {
    const dInh = inh(...l.deaths);
    if (l.disputed)
      return out(
        'Unestablished',
        named(
          i,
          `a death is recorded from ${l.deaths.slice().sort((a, b) => a.span.from - b.span.from)[0]!.fact.valueText}, but the statements of it disagree (${deathText(l)}): after its start neither alive nor deceased is established`,
        ),
        'spans',
        i,
        dInh,
      );
    if (last && o.alive) {
      if (at.from < d.from)
        return out(
          'Unestablished',
          named(i, `the date spans the recorded death (${deathText(l)})`),
          'spans',
          i,
          dInh,
        );
      return out(
        `Unestablished (recorded death; current Life State ${o.alive.principal})`,
        named(
          i,
          `a death is recorded (${deathText(l)}) and the Life State records the character “${o.alive.value}” now, but no return is recorded after it: never alive across the gap`,
        ),
        'after',
        i,
        dInh || o.alive.inherited,
      );
    }
    if (at.from <= d.to)
      return out(
        'Unestablished',
        named(i, `the date spans the recorded death (${deathText(l)})`),
        'spans',
        i,
        dInh,
      );
    if (next && nFrom !== null) {
      if (at.to >= nFrom)
        return out(
          'Unestablished',
          `the date spans ${startWords(next)} that begins ${lifeName(next)}`,
          'spans',
          i,
          dInh || inh(next.starts[0]),
        );
      return out(
        'Between lives (recorded)',
        `between lives: after ${lifeName(l)}’s death (${deathText(l)}), before ${next.began === 'birth' ? `${lifeName(next)}’s birth (${next.starts[0]!.fact.valueText})` : `${startWords(next)} that begins ${lifeName(next)}`}`,
        'between',
        null,
        dInh || inh(next.starts[0]),
        [i, i + 1],
      );
    }
    return out(
      'Deceased (recorded)',
      multi
        ? `after ${lifeName(l)}’s recorded death (${deathText(l)}); no later life is recorded`
        : `after the recorded death (${deathText(l)})`,
      'after',
      i,
      dInh,
    );
  }
  if (next && nFrom !== null && at.to >= nFrom)
    return out(
      'Unestablished',
      `the date spans ${startWords(next)} that begins ${lifeName(next)}`,
      'spans',
      i,
      inh(next.starts[0]),
    );

  // "Deceased by <date>" (the Life State's, the last life's): at or after an exact bound; after an approximate one's margin.
  const by = last ? o.deceasedBy : null;
  if (by && (by.approximate ? at.from > by.span.to : at.from >= by.span.from))
    return out(
      `Deceased (recorded by ${by.text})`,
      `at or after the upper bound on death the Life State records (“${by.value}”); the exact death date is not recorded`,
      'after',
      i,
      by.inherited,
    );

  // Alive: between the life's start and its recorded death; inside its attested span; or by the Life State (the last life).
  const after = (x: number | null) => x === null || at.from > x;
  if (d && sTo !== null && after(sTo) && at.to < d.from)
    return out(
      'Alive (recorded)',
      multi
        ? `in ${lifeName(l)}: between ${startWords(l)} and its recorded death (${deathText(l)})`
        : 'between the recorded birth and the recorded death',
      'in',
      i,
      inh(l.starts[0], ...l.deaths),
    );
  const w = windowOf(lives, i, o.present);
  if (w && at.from >= w.from && at.to <= w.to)
    return out(
      'Alive (recorded)',
      named(i, 'inside the attested span'),
      'in',
      i,
      w.inherited || inh(l.starts[0]),
    );
  const a = last ? o.alive : null;
  if (a && at.to <= a.end.to && (sTo !== null ? after(sTo) : at.from >= a.end.from)) {
    const from =
      l.began === 'return'
        ? `the recorded return (${l.starts[0]!.fact.valueText})`
        : l.began === 'restoration'
          ? `the restoration (${l.starts[0]!.fact.valueText})`
          : 'the recorded birth';
    return out(
      'Alive (recorded)',
      named(
        i,
        sTo !== null
          ? `between ${from} and ${a.endText}: the Life State records the character “${a.value}”`
          : `at ${a.endText}: the Life State records the character “${a.value}”`,
      ),
      'in',
      i,
      a.inherited || inh(l.starts[0]),
    );
  }
  if (l.endedUnrecorded && next)
    return out(
      'Unestablished',
      `in ${lifeName(l)} or after it: no death of it is recorded, and ${startWords(next)} begins ${lifeName(next)}, so whether the character is alive at this date is not established`,
      'in',
      i,
      inh(l.starts[0], next.starts[0]),
    );
  return out('Unestablished', named(i, unknown), 'in', i, false);
}

/** The start of a life (its first statement, the earliest), for elapsed years within that life; null when none. */
export function lifeStart(l: Life): LifeMark | null {
  return l.starts[0] ?? null;
}

/** Whether a span agrees with any life's start (births, returns, restorations) or end (deaths). */
export function agreesWithLives(lives: readonly Life[], kind: 'birth' | 'death', s: Span): boolean {
  return lives.some((l) => (kind === 'birth' ? l.starts : l.deaths).some((m) => overlaps(m.span, s)));
}
