/**
 * A qualified row's event name (ADR 0048 decision 3; ADR 0049 decision 1): `<opening words> – <Date cell>`.
 *
 * The opening words are the row's description cut short (or the caller's name); the tail is the row's Date cell, spaces
 * collapsed, cut with `...` so that the whole name fits LegendKeeper's 500 characters. Only the LAST ` – ` separates the
 * tail: the opening words may hold the separator themselves. Pure; no runtime dependencies, so the store can use it.
 */
import type { ChronologyLink } from './store.js';
import type { AgeRow } from './table.js';

/** Between a qualified row's event name and its Date cell. */
export const QUALIFIED_NAME_SEPARATOR = ' – ';

/** LegendKeeper's longest event name. */
export const EVENT_NAME_MAX = 500;

/** The tail a Date cell becomes after these opening words (null when there is no room for one). */
export function tailFor(opening: string, cell: string): string | null {
  const c = cell.replace(/\s+/g, ' ').trim();
  const room = EVENT_NAME_MAX - opening.length - QUALIFIED_NAME_SEPARATOR.length;
  if (room < 10 || c === '') return null;
  return c.length <= room ? c : `${c.slice(0, room - 3).trimEnd()}...`;
}

/** The opening words with the cell as the tail (the opening words alone, capped, when there is no room). */
export function nameWithTail(opening: string, cell: string): string {
  const tail = tailFor(opening, cell);
  if (tail === null) return opening.slice(0, EVENT_NAME_MAX);
  return `${opening}${QUALIFIED_NAME_SEPARATOR}${tail}`;
}

/** A name split at its LAST separator (null when it has none, or nothing before it). */
export function splitNameTail(name: string): { opening: string; tail: string } | null {
  const at = name.lastIndexOf(QUALIFIED_NAME_SEPARATOR);
  if (at <= 0) return null;
  return { opening: name.slice(0, at), tail: name.slice(at + QUALIFIED_NAME_SEPARATOR.length) };
}

/**
 * v3 F2 (ADR 0049 decision 1): the name a linked event should have now, or null to leave it alone.
 *
 * Only a tail the bridge wrote counts: the link records it (`nameTail`), and the event's name must still end with it
 * after its LAST ` – ` (an owner who edited the name in the app made it theirs). The opening words are never touched.
 * When the row's Date cell differs from the tail, the tail becomes the cell (capped as when it was made); when the row
 * has become plain (readable without the qualified reader), the tail and its ` – ` are dropped. An unlinked event, or
 * one whose ` – ` came from anyone else, is never renamed.
 */
export function renameFor(
  event: { readonly id: string; readonly name: string },
  link: ChronologyLink | null | undefined,
  row: AgeRow,
): string | null {
  if (!link || link.eventId !== event.id || !link.nameTail) return null;
  const split = splitNameTail(event.name);
  if (!split || split.tail !== link.nameTail) return null;
  const want = row.reading
    ? nameWithTail(split.opening, row.dateText)
    : split.opening.slice(0, EVENT_NAME_MAX);
  return want === event.name ? null : want;
}

/** The proposal's line for a rename: `name: "… – old" → "… – new"` (the unchanged opening words shown as `…`). */
export function renameLine(from: string, to: string): string {
  const a = splitNameTail(from);
  const b = splitNameTail(to);
  if (a && b && a.opening === b.opening)
    return `name: "…${QUALIFIED_NAME_SEPARATOR}${a.tail}" → "…${QUALIFIED_NAME_SEPARATOR}${b.tail}"`;
  if (a && a.opening === to)
    return `name: "…${QUALIFIED_NAME_SEPARATOR}${a.tail}" → "${to}" (the date tail dropped)`;
  return `name: "${from}" → "${to}"`;
}
