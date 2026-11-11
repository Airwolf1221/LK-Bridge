/**
 * A LegendKeeper calendar definition (the `Calendar` of `listCalendars`; spec/legendkeeper-openapi.json), as the calendar
 * engine reads it (v2 D1, PLAN-v2 4.8, ADR 0038). Only the fields date arithmetic and formatting use are read; anything
 * else (moons, colours, the version) is passed over. Nothing here is specific to Arkona: every number, name and format
 * comes from the definition.
 */
import * as z from 'zod';

const month = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    isIntercalary: z.boolean().optional(),
    length: z.number().int().min(1),
    interval: z.number().int().min(1).optional(),
    offset: z.number().int().optional(),
  })
  .loose();

const leapDay = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    month: z.number().int().min(0),
    interval: z.string().max(256),
    offset: z.number().int().optional(),
  })
  .loose();

const negativeEra = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    abbr: z.string().optional(),
    hideAbbr: z.boolean().optional(),
    startsAt: z.number().int().max(-1),
    resetMode: z.string().optional(),
  })
  .loose();

const positiveEra = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    abbr: z.string().optional(),
    hideAbbr: z.boolean().optional(),
    startsAt: z.number().int().min(0),
    resetMode: z.enum(['none', 'year', 'calendar']).optional(),
  })
  .loose();

const format = z
  .object({
    id: z.string().optional(),
    year: z.string(),
    month: z.string(),
    day: z.string(),
    time: z.string(),
  })
  .loose();

export const calendarDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    hasZeroYear: z.boolean().optional(),
    maxMinutes: z.number().optional(),
    months: z.array(month).min(1),
    leapDays: z.array(leapDay).optional(),
    weekdays: z
      .array(z.object({ id: z.string().optional(), name: z.string() }).loose())
      .min(1)
      .optional(),
    epochWeekday: z.number().int().min(0).optional(),
    weekResetsEachMonth: z.boolean().optional(),
    hoursInDay: z.number().int().min(1),
    minutesInHour: z.number().int().min(1),
    negativeEra: negativeEra.optional(),
    positiveEras: z.array(positiveEra).min(1),
    format: format.optional(),
    halfClock: z.boolean().optional(),
    version: z.string().optional(),
  })
  .loose();

export type CalendarDefinition = z.infer<typeof calendarDefinitionSchema>;

/** LegendKeeper's default formats, used when a calendar has none (the spec's `CalendarFormat` description). */
export const DEFAULT_FORMAT = {
  id: 'american-verbose',
  year: 'YYYY E',
  month: 'MMMM YYYY E',
  day: 'MMMM D^, YYYY E',
  time: 'MMMM D^, YYYY, HH:mm',
} as const;

/** An era as the engine uses it: the negative era (counting down) or a forward era. */
export interface Era {
  readonly id: string;
  readonly name: string;
  readonly abbr: string;
  readonly hideAbbr: boolean;
  /** The era's first minute. */
  readonly startsAt: number;
  /** The first minute of the next era (exclusive), or null for the last era (bounded by `maxMinutes`). */
  readonly endsBefore: number | null;
  readonly negative: boolean;
  readonly resetMode: 'none' | 'year' | 'calendar';
  /** Position in the calendar, from the earliest. */
  readonly index: number;
}

/** The era as LegendKeeper's `EventDate.era` gives it. */
export interface EraRef {
  readonly id: string;
  readonly name: string;
  readonly abbr: string;
}

export const eraRef = (e: Era): EraRef => ({ id: e.id, name: e.name, abbr: e.abbr });
