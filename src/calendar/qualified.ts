/**
 * Qualified dates read by their anchor (v2 E6, "Chronology II", ADR 0048).
 *
 * The owner writes some table dates with their declared precision: `c. 4A 563; exact date unresolved`, `After Isar
 * 6th and before Zarzakh 29th, 4A 610; …`, `Approximately House Year 8 (c. 4A 578); …`. These are deliberate, not
 * errors, and the table is never rewritten (decided 15 November 2026). The engine reads such a cell by its ANCHOR: the
 * calendar date (or dates) it is pinned to, read strictly by the ordinary parser (parse.ts). Everything outside the
 * anchor is the qualifier, kept verbatim so it can be shown and audited.
 *
 * Rules, in order. A reading must be certain; anything else stays unreadable, and the result says why.
 *
 * 1. The text before the first `;` (or the whole cell) is the date part; the rest is qualifier.
 * 2. `c.`, `ca.`, `circa`, `approx.`, `approximately`, `about` and `around` at the start mean approximate.
 * 3. A bracketed date, `(c. 4A 578)` or `(c. 4A 589-600)`, wins over an in-world era phrase (`House Year 8`) outside
 *    it; a trailing bracket with no date in it is qualifier.
 * 4. Relative offsets (`about nine months after X`, `two days before Y`) are never read.
 * 5. `After X and before Y`, `After X, before Y`, `Between X and Y`, `From X to Y`, `X to Y` and `X through … Y` are
 *    ranges with bounds; a trailing year shared by both ends applies to both (`After Isar 6th and before Zarzakh 29th,
 *    4A 610`). An end that is not a date (`After Pardis-an placement and before Y`) leaves that side open.
 * 6. `After X`, `Following X`, `Since X`, `From X`, `X onward`, `Less than two days after X`, `Days following X` give
 *    an open end; `Before Y`, `By Y`, `Prior to Y`, `No later than Y` an open start. The reading is a single point at
 *    the known bound.
 * 7. `Late`, `Early`, `Mid`, `Third week of`, `First half of`, `End of` and the like qualify a year or a month; they
 *    never invent a month or a day (and on a day they are refused).
 * 8. `In X`, `During X` read X; trailing words after a full date (`Camue 10th, 4A 624 departure`) are qualifier, as
 *    long as they hold no other date.
 *
 * v3 F2.1 (ADR 0048, F2.1 amendments; the owner, 16 November 2026), six more certain forms:
 *
 * 9. `On or after X` and `On or before X` read like `After X` and `Before X` (an open end or start at X).
 * 10. `Before or during X` is an open start ending at the end of X; `During or after X` an open end starting at the
 *     start of X. X is any form the reader knows (`the third week of Isar, 4A 566`), one date.
 * 11. `4A 614-617` is the years 4A 614 to 4A 617 (the second part a bare number greater than the first, the same era);
 *     `Across X` reads X, as `In X` does.
 * 12. `Early`, `Mid` and `Late` on a year make it an approximate year; `Late 4A 621 onward` is an open end from it.
 * 13. A bracketed gloss in another era that names the same instant (`Camue 1st, 5A 1 (4A 950)`: the same KCY at a
 *     year's precision, the same minutes at a finer one) is qualifier; one that does not agree leaves the cell unread.
 * 14. A range whose ends differ in precision (`Camue 4A 624` to `Kumikas 25th, 4A 630`) is read with each end at its own
 *     precision; its event takes the coarser detail.
 *
 * Nothing about Arkona is hard-coded: months and eras are the calendar's, the anchor is read by the calendar's own
 * forms. A month or era word the reader cannot place is never guessed: the cell stays unreadable.
 */
import { CalendarError } from './errors.js';
import { DEFAULT_DATE_STYLE, type DateParser, type DateTextStyle, type ParsedDate } from './parse.js';

export type ReadingShape = 'day' | 'month' | 'year' | 'range';
export type ReadingPrecision = 'day' | 'month' | 'year';

/** A qualified cell read by its anchor. */
export interface QualifiedReading {
  /** The cell as given (spaces collapsed). */
  readonly text: string;
  readonly shape: ReadingShape;
  /** The anchor's precision: what LegendKeeper calls `detail` (1 year, 2 month, 3 day). */
  readonly precision: ReadingPrecision;
  /** LegendKeeper minutes of the anchor (for an open reading, of its known bound). */
  readonly start: number;
  /** A range's last day, month or year (its first minute, as LegendKeeper stores ends). */
  readonly end?: number;
  readonly approximate: boolean;
  /** Before the bound: the start is not known (`Before Y`, `By Y`). */
  readonly openStart?: true;
  /**
   * v3 F2.1: the bound itself is included (`On or before Y`, `Before or during Y`, `During or after X`): the reading
   * and the event are the same as without it; only the words differ.
   */
  readonly inclusive?: true;
  /**
   * v3 F2.1: a range whose ends differ in precision, its ends as written, each at its own precision (`Camue 4A 624 -
   * Kumikas 25th, 4A 630`). `start` and `end` are those ends' minutes; `date` (the event) takes the coarser detail.
   */
  readonly endsText?: string;
  /** After the bound: the end is not known (`After X`, `From X through the reign`). */
  readonly openEnd?: true;
  /** Everything outside the anchor, verbatim, the anchor's own text replaced by `…`. */
  readonly qualifier: string;
  /** The anchor as the engine writes it (the table style). */
  readonly anchorText: string;
  /** The anchor's text as it stands in the cell, one entry per date read. */
  readonly anchors: readonly string[];
  /** The anchor read as an ordinary date: what a timeline event takes (minutes, `detail`, an end for a range). */
  readonly date: ParsedDate;
}

export type QualifiedCode =
  | 'DATE_EMPTY'
  | 'DATE_NO_ANCHOR'
  | 'DATE_RELATIVE'
  | 'DATE_AMBIGUOUS'
  | 'DATE_BOUND_UNREADABLE'
  | 'DATE_RANGE_MIXED'
  | 'DATE_RANGE_REVERSED'
  | 'DATE_QUALIFIER_ON_DAY'
  | 'DATE_UNKNOWN_MONTH'
  | 'DATE_UNKNOWN_ERA'
  | 'DATE_IMPOSSIBLE_DAY'
  | 'DATE_OUTSIDE_ERA'
  | 'DATE_INVALID_YEAR'
  | 'DATE_UNRECOGNISED';

export type QualifiedResult =
  | { readonly ok: true; readonly reading: QualifiedReading }
  | {
      readonly ok: false;
      /** One of `QualifiedCode`, or the plain parser's own code (`CalendarErrorCode`). */
      readonly code: string;
      readonly message: string;
    };

// ============================================================================================ the vocabulary

const APPROX = /^(?:c\.|ca\.|circa|approx\.|approximately|about|around)\s*/iu;
const NUMBER_WORD =
  '(?:\\d+(?:[.,]\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|a\\s+few|few|many|some|a\\s+couple\\s+of|half\\s+a)';
const UNIT =
  '(?:minutes?|hours?|days?|nights?|weeks?|fortnights?|months?|seasons?|years?|decades?|centuries?|generations?)';
/** An amount of time before or after a date: a relative offset, never read (rule 4). */
const RELATIVE = new RegExp(
  `^(?:(?:approximately|about|around|roughly|nearly|almost|some|c\\.|ca\\.)\\s+)?${NUMBER_WORD}\\s+(?:more\\s+)?${UNIT}\\s+(?:after|before|following|later\\s+than|earlier\\s+than|prior\\s+to|from)\\b`,
  'iu',
);
/** A bounded offset after a date: certainly after it (`Less than two days after X`). */
const LESS_THAN_AFTER = new RegExp(
  `^(?:less\\s+than|under|within|no\\s+more\\s+than|at\\s+most)\\s+${NUMBER_WORD}\\s+${UNIT}\\s+(?:after|following)\\s+(.+)$`,
  'iu',
);
/** `Days following X`, `In the weeks after X`. */
const UNITS_FOLLOWING = new RegExp(
  `^(?:in\\s+)?(?:the\\s+)?(?:${UNIT}|subsequent\\s+${UNIT})\\s+(?:following|after)\\s+(.+)$`,
  'iu',
);
const POSITIONAL =
  /^((?:late|early|mid)(?:\s*-\s*|\s+)|(?:the\s+)?(?:first|second|third|fourth|fifth|last|final|closing|opening)\s+(?:week|fortnight|days|months|quarter)\s+of\s+|(?:the\s+)?(?:first|second|last|latter|earlier|later)\s+half\s+of\s+|(?:the\s+)?(?:end|start|beginning|middle|close)\s+of\s+)(.+)$/iu;
const IN_PREFIX = /^((?:sometime|some\s+time)?\s*(?:in|during|across)\s+)(.+)$/iu;
const OPEN_END =
  /^((?:(?:shortly|soon|immediately|just|directly)\s+)?(?:on\s+or\s+after|after|following|since|from|no\s+earlier\s+than|not\s+before)\s+)(.+)$/iu;
const OPEN_START = /^((?:on\s+or\s+before|before|by|prior\s+to|no\s+later\s+than|not\s+after)\s+)(.+)$/iu;
/** v3 F2.1: `Before or during X` (an open start to the end of X) and `During or after X` (an open end from its start). */
const BEFORE_OR_DURING = /^before\s+or\s+during\s+(.+)$/iu;
const DURING_OR_AFTER = /^during\s+or\s+after\s+(.+)$/iu;
/** v3 F2.1: `Early`, `Mid` and `Late`: on a year they make it approximate (rule 12). */
const EARLY_MID_LATE = /^(?:late|early|mid)\b/iu;
const ONWARD = /^(?:onwards?|and\s+after|and\s+later|and\s+beyond)\b/iu;

// ============================================================================================ the reader

/** One date found in the text, with the slice of the cell it was read from. */
interface Found {
  readonly date: ParsedDate;
  readonly slices: readonly string[];
}

/** What a part of the text is: a date (single or range), no date at all, or something that looks like one. */
type Side =
  | { readonly kind: 'date'; readonly found: Found }
  | { readonly kind: 'none' }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string };

/** The anchor of the date part: one date, a range, or one bound with the other side open. */
interface Core {
  readonly date: ParsedDate;
  readonly slices: readonly string[];
  readonly openStart?: boolean;
  readonly openEnd?: boolean;
  /** v3 F2.1: `Early`, `Mid` or `Late` on a year. */
  readonly approximate?: boolean;
  /** v3 F2.1: the bound is included (`On or after X`, `Before or during X`). */
  readonly inclusive?: boolean;
  /** v3 F2.1: a range of mixed precision: its ends at their own precision. */
  readonly exact?: { readonly start: number; readonly end: number; readonly text: string };
}

type Step =
  | { readonly ok: true; readonly core: Core }
  | { readonly ok: false; readonly code: string; readonly message: string }
  | null;

const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class QualifiedReader {
  private readonly monthToken: RegExp;
  private readonly eraToken: RegExp;
  private readonly monthWord: RegExp;

  constructor(
    readonly parser: DateParser,
    readonly style: DateTextStyle = DEFAULT_DATE_STYLE,
  ) {
    const cal = parser.cal;
    const months = [...cal.months].sort((a, b) => b.length - a.length).map(escape);
    const eras = [...new Set(cal.eras.map((e) => e.abbr))]
      .filter((a) => a !== '')
      .sort((a, b) => b.length - a.length)
      .map(escape);
    this.monthToken = new RegExp(`(?<![\\p{L}])(?:${months.join('|') || '(?!)'})(?![\\p{L}])`, 'iu');
    this.eraToken = new RegExp(`(?<![\\p{L}\\p{N}])(?:${eras.join('|') || '(?!)'})\\s*\\d`, 'iu');
    this.monthWord = new RegExp(`^(${months.join('|') || '(?!)'}),\\s*(.+)$`, 'iu');
  }

  /** Whether a text holds something that looks like a calendar date (a month of the calendar, or an era and a year). */
  hasDateToken(text: string): boolean {
    return this.monthToken.test(text) || this.eraToken.test(text);
  }

  /** Reads a table cell by its anchor (see the module comment), or says why it cannot. */
  read(cell: string): QualifiedResult {
    const text = cell.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (text === '') return fail('DATE_EMPTY', 'The cell is empty.');
    const semi = text.indexOf(';');
    let part = (semi >= 0 ? text.slice(0, semi) : text).trim();
    // Rule 2: approximate.
    let approximate = false;
    const am = APPROX.exec(part);
    if (am) {
      approximate = true;
      part = part.slice(am[0].length).trim();
    }
    part = part.replace(/[\s.,]+$/u, '');
    if (part === '') return fail('DATE_NO_ANCHOR', 'The cell names no calendar date before its qualifier.');
    // Rule 3: brackets.
    const br = this.brackets(part);
    if (!br.ok) return br;
    if (br.core) return this.result(text, br.core, approximate || br.approximate);
    part = br.part;
    const step = this.core(part);
    if (step === null || !step.ok) {
      if (step && !step.ok) return step;
      if (!this.hasDateToken(part))
        return fail('DATE_NO_ANCHOR', `“${part}” holds no date of the calendar “${this.parser.cal.name}”.`);
      return this.strictReason(part);
    }
    return this.result(text, step.core, approximate);
  }

  /** The strict parser's own reason for a date part that matched none of the qualified forms. */
  private strictReason(part: string): QualifiedResult {
    try {
      this.parser.parse(part, this.style);
      return fail('DATE_AMBIGUOUS', `“${part}” could not be read with certainty.`);
    } catch (e) {
      if (e instanceof CalendarError && e.code !== 'DATE_UNRECOGNISED') return fail(e.code, e.message);
      return fail(
        'DATE_AMBIGUOUS',
        `“${part}” is not a form the reader knows with certainty (a date with words around it that are not a qualifier it knows).`,
      );
    }
  }

  /**
   * Rule 3: a bracketed date wins over an in-world phrase outside it; a trailing bracket with no date is qualifier.
   * Returns the anchor when a bracket gave it, else the date part with its trailing qualifier brackets removed.
   */
  private brackets(
    part: string,
  ):
    | { ok: true; core: Core | null; approximate: boolean; part: string }
    | { ok: false; code: string; message: string } {
    const all = [...part.matchAll(/\(([^()]*)\)/gu)];
    if (all.length === 0) return { ok: true, core: null, approximate: false, part };
    const dated = all.filter((m) => this.hasDateToken(m[1]!));
    if (dated.length > 1)
      return fail(
        'DATE_AMBIGUOUS',
        `“${part}” has ${dated.length} bracketed dates; which one is the anchor is not certain.`,
      );
    if (dated.length === 1) {
      const m = dated[0]!;
      const outside = part.slice(0, m.index) + part.slice(m.index + m[0].length);
      let inner = m[1]!.trim();
      const im = APPROX.exec(inner);
      if (im) inner = inner.slice(im[0].length).trim();
      if (this.hasDateToken(outside)) {
        // v3 F2.1 (rule 13): a gloss in another era naming the same instant is qualifier; anything else stays unread.
        const main = this.core(outside.replace(/[\s.,]+$/u, '').trim());
        const gloss = this.core(inner.replace(/[\s.,]+$/u, ''));
        if (main?.ok && gloss?.ok && sameInstant(main.core, gloss.core))
          return { ok: true, core: main.core, approximate: false, part };
        return fail(
          'DATE_AMBIGUOUS',
          main?.ok && gloss?.ok
            ? `“${part}” has a date both inside and outside its brackets, and they do not name the same instant; which one is the anchor is not certain.`
            : `“${part}” has a date both inside and outside its brackets; which one is the anchor is not certain.`,
        );
      }
      const step = this.core(inner.replace(/[\s.,]+$/u, ''));
      if (step === null) {
        const why = this.strictReason(inner);
        return why.ok ? fail('DATE_AMBIGUOUS', `“${inner}” could not be read with certainty.`) : why;
      }
      if (!step.ok) return step;
      return { ok: true, core: step.core, approximate: im !== null, part };
    }
    // No bracket holds a date: trailing brackets are qualifier; a bracket elsewhere is not certain.
    let p = part;
    for (;;) {
      const t = /\s*\(([^()]*)\)\s*$/u.exec(p);
      if (!t) break;
      p = p.slice(0, t.index).replace(/[\s,]+$/u, '');
    }
    if (/[()]/u.test(p))
      return fail(
        'DATE_AMBIGUOUS',
        `“${part}” has a bracket inside the date; the reader does not guess around it.`,
      );
    return { ok: true, core: null, approximate: false, part: p };
  }

  // ------------------------------------------------------------------------------------------ the anchor

  /** The anchor of a date part with no approximate marker and no brackets (rules 4 to 8). Null: no form applies. */
  private core(s: string): Step {
    if (s === '') return null;
    if (RELATIVE.test(s))
      return fail(
        'DATE_RELATIVE',
        `“${s}” is a relative offset (an amount of time after or before a date); the reader never works one out.`,
      );
    let m = LESS_THAN_AFTER.exec(s) ?? UNITS_FOLLOWING.exec(s);
    if (m) return this.open(m[1]!, 'end');
    // v3 F2.1 (rule 10): `Before or during X`, `During or after X`.
    m = BEFORE_OR_DURING.exec(s);
    if (m) return this.during(m[1]!, 'start');
    m = DURING_OR_AFTER.exec(s);
    if (m) return this.during(m[1]!, 'end');
    // Rule 5: ranges with bounds.
    m =
      /^(?:after|following|since)\s+(.+?)(?:\s*,\s*|\s+and\s+|\s+but\s+)(?:before|by|prior\s+to|no\s+later\s+than)\s+(.+)$/iu.exec(
        s,
      );
    if (m) return this.bounds(m[1]!, m[2]!);
    m = /^between\s+(.+?)\s+and\s+(.+)$/iu.exec(s);
    if (m) return this.bounds(m[1]!, m[2]!);
    m = /^from\s+(.+?)\s+(?:to|until|till)\s+(.+)$/iu.exec(s);
    if (m) return this.bounds(m[1]!, m[2]!);
    // Rule 6: an open start.
    m = OPEN_START.exec(s);
    if (m) return this.open(m[2]!, 'start', /^on\s/iu.test(m[1]!));
    // `X through … Y` (and `From X through …`).
    m = /^(?:from\s+)?(.+?)\s+through\s+(.+)$/iu.exec(s);
    if (m) {
      const r = this.through(m[1]!, m[2]!);
      if (r) return r;
    }
    // Rule 6: an open end.
    m = OPEN_END.exec(s);
    if (m) return this.open(m[2]!, 'end', /^on\s/iu.test(m[1]!));
    // `X to Y`: both ends full dates.
    m = /^(.+?)\s+(?:to|until|till)\s+(.+)$/iu.exec(s);
    if (m) {
      const x = this.side(m[1]!);
      const y = this.side(m[2]!);
      if (x.kind === 'date' && y.kind === 'date') return this.range(x.found, y.found);
      if (x.kind === 'date' && y.kind === 'fail') return fail('DATE_BOUND_UNREADABLE', y.message);
    }
    // Rule 7: a qualifier on a year or month.
    m = POSITIONAL.exec(s);
    if (m) return this.positional(s, m[1]!, m[2]!);
    // Rule 8: `In X`, `During X` (v3 F2.1: `Across X`).
    m = IN_PREFIX.exec(s);
    if (m) return this.anchor(m[2]!);
    return this.anchor(s);
  }

  /**
   * Rule 7: `Late`, `Early`, `Mid`, `Third week of` and the like on a year or a month (never a day, never an open date).
   * v3 F2.1 (rule 12): `Early`, `Mid` and `Late` on one year make it approximate, and `Late 4A 621 onward` is an open
   * end from that year.
   */
  private positional(s: string, prefix: string, rest: string): Step {
    const a = this.anchor(rest);
    if (a === null || !a.ok) return a;
    const eml = EARLY_MID_LATE.test(prefix.trim());
    const oneYear = a.core.date.detail === 1 && a.core.date.end === null;
    if (a.core.openStart || a.core.openEnd) {
      if (eml && oneYear && a.core.openEnd && !a.core.openStart)
        return { ok: true, core: { ...a.core, approximate: true } };
      return fail(
        'DATE_AMBIGUOUS',
        `“${s}” qualifies an open date; the reader does not guess what it means.`,
      );
    }
    if (a.core.date.detail === 3)
      return fail(
        'DATE_QUALIFIER_ON_DAY',
        `“${prefix.trim()}” qualifies a year or a month; on a day (“${rest}”) its meaning is not certain.`,
      );
    return eml && oneYear ? { ok: true, core: { ...a.core, approximate: true } } : a;
  }

  /**
   * v3 F2.1 (rule 10): `Before or during X` (an open start whose bound is the end of X) and `During or after X` (an
   * open end from the start of X). X is one date in any form the reader knows (`the third week of Isar, 4A 566`).
   */
  private during(xs: string, side: 'start' | 'end'): Step {
    const t = xs.trim().replace(/[\s.,]+$/u, '');
    const pm = POSITIONAL.exec(t);
    const x = pm ? this.positional(t, pm[1]!, pm[2]!) : this.anchor(t);
    if (x === null)
      return this.hasDateToken(t)
        ? fail('DATE_BOUND_UNREADABLE', `“${t}” looks like a date but cannot be read.`)
        : null;
    if (!x.ok) return x;
    if (x.core.date.end !== null || x.core.openStart || x.core.openEnd)
      return fail('DATE_AMBIGUOUS', `“${t}” is itself a range or open; the bound must be one date.`);
    return {
      ok: true,
      core: {
        ...x.core,
        inclusive: true,
        ...(side === 'start' ? { openStart: true } : { openEnd: true }),
      },
    };
  }

  /** One date, a compressed year range, or a date with trailing words that hold no other date. */
  private anchor(s: string): Step {
    const t = s.trim().replace(/[\s.,]+$/u, '');
    const side = this.side(t);
    if (side.kind === 'date') return { ok: true, core: { date: side.found.date, slices: side.found.slices } };
    const y = this.yearRange(t);
    if (y) return y;
    const lead = this.parser.leadingDate(t, this.style);
    if (!lead) return side.kind === 'fail' ? fail(side.code, side.message) : null;
    const rest = lead.rest.replace(/^[\s,]+/u, '').trim();
    if (rest === '') return { ok: true, core: { date: lead.date, slices: [lead.match] } };
    // v3 F2.1 (rule 14): `X - Y` whose ends differ in precision (the plain forms read only same-precision ranges).
    const dash = /^[-–—]\s*(.+)$/u.exec(rest);
    if (dash) {
      const y = this.side(dash[1]!);
      if (y.kind === 'date' && y.found.date.end === null && y.found.date.detail !== lead.date.detail)
        return this.range({ date: lead.date, slices: [lead.match] }, y.found);
    }
    if (ONWARD.test(rest)) {
      const after = rest.replace(ONWARD, '').trim();
      if (this.hasDateToken(after))
        return fail('DATE_AMBIGUOUS', `“${s}” holds more than one date; which is the anchor is not certain.`);
      return { ok: true, core: { date: lead.date, slices: [lead.match], openEnd: true } };
    }
    if (this.hasDateToken(rest))
      return fail(
        'DATE_AMBIGUOUS',
        `“${s}” holds another date after “${lead.match}” in a form the reader does not know; it does not guess.`,
      );
    return { ok: true, core: { date: lead.date, slices: [lead.match] } };
  }

  /** A part read as one date (strictly; `Isar, 4A 566` as `Isar 4A 566`), no date at all, or one that cannot be read. */
  private side(raw: string): Side {
    const x = raw.trim().replace(/[\s.,]+$/u, '');
    if (x === '') return { kind: 'none' };
    try {
      const d = this.parser.parse(x, this.style);
      return { kind: 'date', found: { date: d, slices: [x] } };
    } catch (e) {
      const cm = this.monthWord.exec(x);
      if (cm) {
        try {
          const d = this.parser.parse(`${cm[1]} ${cm[2]}`, this.style);
          return { kind: 'date', found: { date: d, slices: [x] } };
        } catch {
          /* fall through */
        }
      }
      if (!this.hasDateToken(x)) return { kind: 'none' };
      if (e instanceof CalendarError && e.code !== 'DATE_UNRECOGNISED')
        return { kind: 'fail', code: e.code, message: e.message };
      return {
        kind: 'fail',
        code: 'DATE_AMBIGUOUS',
        message: `“${x}” looks like a date but cannot be read with certainty.`,
      };
    }
  }

  /** A side with no year, read with the other end's year (`After Isar 6th and before Zarzakh 29th, 4A 610`). */
  private sideWithYear(raw: string, other: ParsedDate): Side {
    const x = raw.trim().replace(/[\s.,]+$/u, '');
    if (!this.monthToken.test(x) || this.eraToken.test(x)) return this.side(x);
    const year = this.parser.render('year', other.start, null, this.style);
    for (const joined of [`${x}, ${year}`, `${x} ${year}`]) {
      try {
        const d = this.parser.parse(joined, this.style);
        if (d.end === null) return { kind: 'date', found: { date: d, slices: [x] } };
      } catch {
        /* the next joining */
      }
    }
    return this.side(x);
  }

  /** `4A 564-565`: a year range written with one era (rule 5). */
  private yearRange(s: string): Step {
    const lead = this.parser.leadingDate(s, this.style);
    if (!lead || lead.date.detail !== 1) return null;
    const m = /^\s*[-–—]\s*(\d[\d,]*)$/u.exec(lead.rest);
    if (!m) return null;
    const endText = lead.match.replace(/\d[\d,]*(?!.*\d)/u, m[1]!);
    const end = this.side(endText);
    if (end.kind !== 'date') return end.kind === 'fail' ? fail(end.code, end.message) : null;
    return this.range({ date: lead.date, slices: [s] }, { date: end.found.date, slices: [] });
  }

  /** A range whose ends are both read, or one open side (`After <not a date> and before Y`). */
  private bounds(xs: string, ys: string): Step {
    const y = this.side(ys);
    if (y.kind === 'fail') return fail('DATE_BOUND_UNREADABLE', `The end “${ys}”: ${y.message}`);
    const x = y.kind === 'date' ? this.sideWithYear(xs, y.found.date) : this.side(xs);
    if (x.kind === 'fail') return fail('DATE_BOUND_UNREADABLE', `The start “${xs}”: ${x.message}`);
    if (x.kind === 'date' && y.kind === 'date') return this.range(x.found, y.found);
    if (x.kind === 'none' && y.kind === 'date') return this.single(y.found, 'start');
    if (x.kind === 'date' && y.kind === 'none') return this.single(x.found, 'end');
    return null;
  }

  /** `X through … Y`: X a date; Y the last date of the rest (words before it are qualifier), or none (open end). */
  private through(xs: string, rest: string): Step {
    const x = this.side(xs);
    if (x.kind !== 'date') return null;
    const whole = this.side(rest);
    if (whole.kind === 'date') return this.range(x.found, whole.found);
    const tail = this.parser.trailingDate(rest.replace(/[\s.,]+$/u, ''), this.style);
    if (tail) {
      if (this.hasDateToken(tail.rest))
        return fail(
          'DATE_AMBIGUOUS',
          `“${rest}” holds more than one date; which ends the range is not certain.`,
        );
      return this.range(x.found, { date: tail.date, slices: [tail.match] });
    }
    if (this.hasDateToken(rest))
      return fail('DATE_BOUND_UNREADABLE', `The end “${rest}” looks like a date but cannot be read.`);
    return this.single(x.found, 'end');
  }

  /** `After X` (open end) or `Before Y` (open start): the bound, a single date, with words after it allowed. */
  private open(s: string, side: 'start' | 'end', inclusive = false): Step {
    const a = this.anchor(s);
    if (a === null)
      return this.hasDateToken(s)
        ? fail('DATE_BOUND_UNREADABLE', `“${s}” looks like a date but cannot be read.`)
        : null;
    if (!a.ok) return a;
    if (a.core.date.end !== null || a.core.openStart || a.core.openEnd)
      return fail('DATE_AMBIGUOUS', `“${s}” is itself a range or open; an open bound must be one date.`);
    const one = this.single({ date: a.core.date, slices: a.core.slices }, side);
    return inclusive && one?.ok ? { ok: true, core: { ...one.core, inclusive: true } } : one;
  }

  private single(f: Found, open: 'start' | 'end'): Step {
    if (f.date.end !== null)
      return fail('DATE_AMBIGUOUS', `“${f.date.input}” is itself a range; an open bound must be one date.`);
    return {
      ok: true,
      core: {
        date: f.date,
        slices: f.slices,
        ...(open === 'start' ? { openStart: true } : { openEnd: true }),
      },
    };
  }

  /** A range from two single dates of the same precision. */
  private range(a: Found, b: Found): Step {
    if (a.date.end !== null || b.date.end !== null)
      return fail(
        'DATE_AMBIGUOUS',
        'An end of the range is itself a range; the reader does not guess which bound applies.',
      );
    const p = this.parser;
    const input = `${a.date.input} - ${b.date.input}`;
    if (a.date.detail !== b.date.detail) {
      // v3 F2.1 (rule 14): each end at its own precision; the event takes the coarser detail (its ends the first
      // minute of each end's year or month, as LegendKeeper stores a range of that detail).
      const coarse = Math.min(a.date.detail, b.date.detail) as 1 | 2;
      const unit = (minute: number) =>
        p.parse(p.render(coarse === 1 ? 'year' : 'month', minute, null, this.style), this.style).start;
      const from = unit(a.date.start);
      const to = unit(b.date.start);
      if (b.date.start <= a.date.start || to <= from)
        return fail(
          'DATE_RANGE_REVERSED',
          to <= from && b.date.start > a.date.start
            ? `The range “${a.date.input}” to “${b.date.input}” ends in the ${word(coarse)} it begins; its precision is not certain.`
            : `The range “${a.date.input}” to “${b.date.input}” ends before it begins.`,
        );
      return {
        ok: true,
        core: {
          date: p.result(p.formFor(from, to, coarse), from, to, input, this.style),
          slices: [...a.slices, ...b.slices],
          exact: {
            start: a.date.start,
            end: b.date.start,
            text: `${a.date.text}${this.style.rangeSeparator}${b.date.text}`,
          },
        },
      };
    }
    if (b.date.start <= a.date.start)
      return fail(
        'DATE_RANGE_REVERSED',
        b.date.start === a.date.start
          ? `The range “${a.date.input}” to “${b.date.input}” ends where it begins.`
          : `The range “${a.date.input}” to “${b.date.input}” ends before it begins.`,
      );
    const form = p.formFor(a.date.start, b.date.start, a.date.detail);
    return {
      ok: true,
      core: {
        date: p.result(form, a.date.start, b.date.start, input, this.style),
        slices: [...a.slices, ...b.slices],
      },
    };
  }

  private result(text: string, core: Core, approximate: boolean): QualifiedResult {
    const d = core.date;
    let qualifier = text;
    let from = 0;
    for (const s of core.slices) {
      const at = qualifier.indexOf(s, from);
      if (at < 0) continue;
      qualifier = `${qualifier.slice(0, at)}…${qualifier.slice(at + s.length)}`;
      from = at + 1;
    }
    const precision: ReadingPrecision = d.detail === 1 ? 'year' : d.detail === 2 ? 'month' : 'day';
    const start = core.exact?.start ?? d.start;
    const end = core.exact?.end ?? d.end;
    return {
      ok: true,
      reading: {
        text,
        shape: d.end !== null ? 'range' : precision,
        precision,
        start,
        ...(end !== null ? { end } : {}),
        approximate: approximate || core.approximate === true,
        ...(core.openStart ? { openStart: true as const } : {}),
        ...(core.openEnd ? { openEnd: true as const } : {}),
        ...(core.inclusive ? { inclusive: true as const } : {}),
        ...(core.exact ? { endsText: core.exact.text } : {}),
        qualifier,
        anchorText: d.text,
        anchors: [...core.slices],
        date: d,
      },
    };
  }
}

const word = (detail: number) => (detail === 1 ? 'year' : detail === 2 ? 'month' : 'day');

/**
 * v3 F2.1 (rule 13): a bracketed gloss names the same instant as the date outside it: in another era, and at the
 * gloss's precision the same (a year: the same KCY at each end; a month or a day: the same minutes and detail). Open
 * dates never agree.
 */
function sameInstant(main: Core, gloss: Core): boolean {
  if (main.openStart || main.openEnd || gloss.openStart || gloss.openEnd || main.exact || gloss.exact)
    return false;
  const a = main.date;
  const g = gloss.date;
  if (a.era.id === g.era.id) return false;
  if ((a.end === null) !== (g.end === null)) return false;
  if (g.detail === 1)
    return a.kcy.start === g.kcy.start && (a.kcy.end ?? a.kcy.start) === (g.kcy.end ?? g.kcy.start);
  return a.detail === g.detail && a.start === g.start && a.end === g.end;
}

/** Reads one cell (a reader per call; use `QualifiedReader` to read many). */
export function parseQualified(
  parser: DateParser,
  cell: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
): QualifiedResult {
  return new QualifiedReader(parser, style).read(cell);
}

/** A reading in plain words, for findings, proposals and the dashboard: `year 4A 563, approximate`. */
export function describeReading(r: QualifiedReading): string {
  const what = r.openStart
    ? `${r.inclusive ? 'up to and including' : 'before'} ${r.anchorText} (an open start)`
    : r.openEnd
      ? `${r.inclusive ? 'from' : 'after'} ${r.anchorText} (an open end)`
      : r.endsText
        ? `range ${r.endsText} (the event by ${r.precision})`
        : r.shape === 'range'
          ? `${r.precision === 'year' ? 'years' : r.precision === 'month' ? 'months' : 'range'} ${r.anchorText}`
          : `${r.shape} ${r.anchorText}`;
  return r.approximate ? `${what}, approximate` : what;
}
