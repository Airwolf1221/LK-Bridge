/**
 * v3 F4c (ADR 0065): the calendar the narrative tools and audit read dates with: the chronology's, as the chronology
 * tools keep it, and its date style (null when the chronology is not set up: no date can then be read, and nothing is
 * guessed).
 */
import { DEFAULT_DATE_STYLE, type Calendar, type DateTextStyle } from '../calendar/index.js';
import type { Chronology } from '../chronology/index.js';

export function narrativeCalendar(
  chronology: Pick<Chronology, 'config' | 'calendar'>,
  projectId: string,
): { readonly calendar: Calendar | null; readonly style: DateTextStyle } {
  try {
    const cfg = chronology.config(projectId);
    return { calendar: chronology.calendar(projectId), style: cfg.style.date };
  } catch {
    return { calendar: null, style: DEFAULT_DATE_STYLE };
  }
}
