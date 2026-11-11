/**
 * Typed refusals of the calendar engine (v2 D1, ADR 0038). Every refusal is one of these, with a message written for an
 * agent to act on (it names the calendar's own months, eras and forms) and the details that explain it.
 */
export type CalendarErrorCode =
  /** The calendar definition cannot be used (an unknown era reset mode, a leap rule that cannot be read, no months). */
  | 'CALENDAR_UNSUPPORTED'
  /** Nothing to parse. */
  | 'DATE_EMPTY'
  /** `Unknown` with no year: refused by the owner's decision (PLAN-v2 section 1). */
  | 'DATE_UNKNOWN_ALONE'
  /** The text is none of the accepted forms. */
  | 'DATE_UNRECOGNISED'
  /** A month name the calendar does not have. */
  | 'DATE_UNKNOWN_MONTH'
  /** An era abbreviation the calendar does not have. */
  | 'DATE_UNKNOWN_ERA'
  /** A year that cannot exist (0 in a calendar without year 0, a badly grouped number, past the calendar's range). */
  | 'DATE_INVALID_YEAR'
  /** A day the month does not have, or a month that does not occur that year. */
  | 'DATE_IMPOSSIBLE_DAY'
  /** A date outside its era (before the era begins, or once the next era has begun), or outside the calendar. */
  | 'DATE_OUTSIDE_ERA'
  /** A range whose end is not after its start. */
  | 'DATE_RANGE_REVERSED'
  /** A minute or KCY value outside the calendar. */
  | 'DATE_OUT_OF_RANGE';

export class CalendarError extends Error {
  override readonly name = 'CalendarError';
  constructor(
    readonly code: CalendarErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }

  toJSON(): { code: CalendarErrorCode; message: string; details: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
