/**
 * The chronology's settings per project (v2 D1, PLAN-v2 4.9, ADR 0038), stored in the project's settings under
 * `chronology`, found by naming convention, shown on the dashboard and confirmed by the owner (as C2c confirms the
 * lifecycle indexes). Until confirmed, every chronology tool refuses.
 *
 * What is confirmed: the chronology resource, its calendar, its Main document (and the Main table's row of each age),
 * and per age (each an era of the calendar, by name) its table document, its timeline document and that timeline's one
 * lane. Also how the tables write dates and KCY values, learned from the real rows (never invented).
 */
import * as z from 'zod';
import {
  DEFAULT_DATE_STYLE,
  DEFAULT_KCY_STYLE,
  type DateTextStyle,
  type KcyStyle,
} from '../calendar/index.js';
import { AGE_COLUMNS, MAIN_COLUMNS } from './table.js';

const id = z.string().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);

const ageSchema = z
  .object({
    /** The age's name (an era name of the calendar, the Main table's Age cell, the start of the document names). */
    name: text(200),
    /** The calendar era it is. */
    eraId: id,
    tableDocumentId: id,
    timelineDocumentId: id,
    laneId: id,
    laneName: z.string().max(500),
    /** The Main table's row of this age (its block id). */
    mainRowId: id,
  })
  .strict();

export const chronologySchema = z
  .object({
    resourceId: id.nullable().optional(),
    calendarId: id.nullable().optional(),
    mainDocumentId: id.nullable().optional(),
    ages: z.array(ageSchema).max(100).optional(),
    style: z
      .object({
        date: z
          .object({ rangeSeparator: z.string().min(1).max(10), yearGrouping: z.string().max(1) })
          .strict(),
        kcy: z
          .object({
            grouping: z.string().max(1),
            minus: z.string().min(1).max(1),
            rangeSeparator: z.string().min(1).max(10),
            sameYearRange: z.enum(['single', 'range']),
          })
          .strict(),
      })
      .strict()
      .optional(),
    /** The names the lookup goes by (the owner's conventions). */
    names: z
      .object({
        resource: text(200),
        mainDocument: text(200),
        // Not trimmed: a suffix is matched with its spaces (` - Table`).
        tableSuffix: z.string().min(1).max(100),
        timelineSuffix: z.string().min(1).max(100),
        laneName: text(200),
      })
      .strict()
      .optional(),
    columns: z
      .object({
        event: text(100),
        date: text(100),
        kcy: text(100),
        age: text(100),
        count: text(100),
        table: text(100),
        timeline: text(100),
      })
      .strict()
      .optional(),
    confirmed: z.boolean().optional(),
    confirmedAt: z.number().optional(),
  })
  .strict();

export type StoredChronology = z.infer<typeof chronologySchema>;

export interface AgeConfig {
  readonly name: string;
  readonly eraId: string;
  readonly tableDocumentId: string;
  readonly timelineDocumentId: string;
  readonly laneId: string;
  readonly laneName: string;
  readonly mainRowId: string;
}

export interface ChronologyConfig {
  readonly resourceId: string | null;
  readonly calendarId: string | null;
  readonly mainDocumentId: string | null;
  readonly ages: readonly AgeConfig[];
  readonly style: { readonly date: DateTextStyle; readonly kcy: KcyStyle };
  readonly names: {
    readonly resource: string;
    readonly mainDocument: string;
    readonly tableSuffix: string;
    readonly timelineSuffix: string;
    readonly laneName: string;
  };
  readonly columns: {
    readonly event: string;
    readonly date: string;
    readonly kcy: string;
    readonly age: string;
    readonly count: string;
    readonly table: string;
    readonly timeline: string;
  };
  readonly confirmed: boolean;
  readonly confirmedAt: number | null;
  /** Why the stored value could not be used (the defaults then apply, unconfirmed), or null. */
  readonly problem: string | null;
}

/** The owner's conventions (PLAN-v2 section 2): the names on the test world and Arkona. */
export const DEFAULT_CHRONOLOGY: Omit<ChronologyConfig, 'problem'> = Object.freeze({
  resourceId: null,
  calendarId: null,
  mainDocumentId: null,
  ages: [],
  style: { date: DEFAULT_DATE_STYLE, kcy: DEFAULT_KCY_STYLE },
  names: {
    resource: 'Universal Chronology',
    mainDocument: 'Main',
    tableSuffix: ' - Table',
    timelineSuffix: ' - Timeline',
    laneName: 'Historical Events',
  },
  columns: { ...AGE_COLUMNS, ...MAIN_COLUMNS },
  confirmed: false,
  confirmedAt: null,
});

/** The configuration from a project's stored settings (defaults where absent; the defaults, unconfirmed, if invalid). */
export function chronologyConfigFrom(stored: unknown): ChronologyConfig {
  if (stored === undefined || stored === null) return { ...DEFAULT_CHRONOLOGY, problem: null };
  const r = chronologySchema.safeParse(stored);
  if (!r.success) {
    return {
      ...DEFAULT_CHRONOLOGY,
      problem: `The stored chronology settings are not valid (${r.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}); they must be confirmed again.`,
    };
  }
  const s = r.data;
  return {
    resourceId: s.resourceId ?? null,
    calendarId: s.calendarId ?? null,
    mainDocumentId: s.mainDocumentId ?? null,
    ages: s.ages ?? [],
    style: s.style ?? DEFAULT_CHRONOLOGY.style,
    names: s.names ?? DEFAULT_CHRONOLOGY.names,
    columns: s.columns ?? DEFAULT_CHRONOLOGY.columns,
    confirmed: s.confirmed === true,
    confirmedAt: s.confirmedAt ?? null,
    problem: null,
  };
}

/** The stored form of a configuration. */
export function storedFrom(c: Omit<ChronologyConfig, 'problem'>): StoredChronology {
  return {
    resourceId: c.resourceId,
    calendarId: c.calendarId,
    mainDocumentId: c.mainDocumentId,
    ages: c.ages.map((a) => ({ ...a })),
    style: { date: { ...c.style.date }, kcy: { ...c.style.kcy } },
    names: { ...c.names },
    columns: { ...c.columns },
    confirmed: c.confirmed,
    ...(c.confirmedAt !== null ? { confirmedAt: c.confirmedAt } : {}),
  };
}
