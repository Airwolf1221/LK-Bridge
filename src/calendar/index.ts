/**
 * The calendar engine (v2 D1, PLAN-v2 4.8, ADR 0038): built from a LegendKeeper calendar definition, with nothing
 * about Arkona hard-coded. `createCalendar(definition)` gives the engine (minutes, eras, KCY, LegendKeeper's formatted
 * text) and the parser of the owner's date forms.
 */
import { CalendarEngine } from './engine.js';
import { DateParser } from './parse.js';

export { CalendarEngine, type DateFields, type Detail, type EventDate, type Moment } from './engine.js';
export {
  DateParser,
  DEFAULT_DATE_STYLE,
  LK_DATE_STYLE,
  type DateForm,
  type DateTextStyle,
  type EventShape,
  type ParsedDate,
} from './parse.js';
export { CalendarError, type CalendarErrorCode } from './errors.js';
export {
  DEFAULT_KCY_STYLE,
  formatKcy,
  parseKcyCell,
  type KcyCell,
  type KcyStyle,
  type KcyValue,
} from './kcy.js';
export type { CalendarDefinition, Era, EraRef } from './definition.js';
export { eraRef } from './definition.js';
export { ordinal, groupDigits } from './template.js';

export interface Calendar {
  readonly engine: CalendarEngine;
  readonly parser: DateParser;
}

/** Builds the engine and parser from a definition (throws `CalendarError` `CALENDAR_UNSUPPORTED`). */
export function createCalendar(definition: unknown): Calendar {
  const engine = CalendarEngine.fromDefinition(definition);
  return { engine, parser: new DateParser(engine) };
}
