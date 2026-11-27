/**
 * v3 F2.1 (ADR 0048, F2.1 amendments): resolving a chronology tie on the dashboard, without an assistant. Shared by the
 * Chronology page and the Audits page.
 *
 * - A refused fix (`PAIRING_AMBIGUOUS` for a row) shows each candidate event with **Use this event**, and one **Make a
 *   new event** button ("none of these").
 * - An event in a tie (or a refused delete of one) shows each candidate row with **Pair with this row**.
 *
 * Each button asks for the owner's confirmation and then runs at once as one job, as every "Apply fix" does (v3 F12,
 * ADR 0081).
 */
import { ApiError } from '../api';
import { Button } from '../components';

/** A candidate of a tie: an event a row could take, or a row an event could belong to. */
export type TieCandidate =
  | { readonly kind: 'event'; readonly eventId: string; readonly name: string; readonly date: string }
  | { readonly kind: 'row'; readonly rowId: string; readonly date: string; readonly words: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The candidate rows of an event in a tie, as the check lists them (`rowId`, `date`, `words`). */
export function rowCandidates(list: unknown): TieCandidate[] {
  if (!Array.isArray(list)) return [];
  return (list as Record<string, unknown>[])
    .filter((c) => typeof c.rowId === 'string' || typeof c.id === 'string')
    .map((c) => ({
      kind: 'row' as const,
      rowId: str(c.rowId) || str(c.id),
      date: str(c.date),
      words: str(c.words) || str(c.description),
    }));
}

/**
 * The candidates of a refused fix: `PAIRING_AMBIGUOUS` with `details.candidates` (events for a row's repair, rows for
 * an event's delete). Null for any other error.
 */
export function tieFromError(e: unknown): TieCandidate[] | null {
  if (!(e instanceof ApiError) || e.code !== 'PAIRING_AMBIGUOUS') return null;
  const details = (e.extra.details ?? e.extra) as Record<string, unknown>;
  const list = Array.isArray(details.candidates) ? (details.candidates as Record<string, unknown>[]) : [];
  if (details.event !== undefined) return rowCandidates(details.candidateRows ?? list);
  return list
    .filter((c) => typeof c.id === 'string')
    .map((c) => ({ kind: 'event' as const, eventId: str(c.id), name: str(c.name), date: str(c.date) }));
}

export function TieChoices({
  candidates,
  busy,
  disabled,
  onUse,
  onCreateNew,
}: {
  candidates: readonly TieCandidate[];
  busy: boolean;
  disabled: boolean;
  /** "Use this event" (an event candidate) or "Pair with this row" (a row candidate). */
  onUse: (c: TieCandidate) => void;
  /** "Make a new event": offered only for event candidates. */
  onCreateNew?: () => void;
}) {
  const events = candidates.some((c) => c.kind === 'event');
  return (
    <div className="small-text mt" data-testid="tie-choices">
      <div>
        {events
          ? 'Several events could be this row’s own. Pick one, or make a new event:'
          : 'Rows of the table could be this event’s own. Pair it with one (it is never deleted):'}
      </div>
      <ul className="plain">
        {candidates.map((c) => (
          <li
            key={c.kind === 'event' ? c.eventId : c.rowId}
            data-candidate={c.kind === 'event' ? c.eventId : c.rowId}
          >
            {c.kind === 'event' ? (
              <>
                “{c.name}” ({c.date}, <code>{c.eventId}</code>){' '}
              </>
            ) : (
              <>
                {c.date}: {c.words} (<code>{c.rowId}</code>){' '}
              </>
            )}
            <Button className="small" busy={busy} disabled={disabled} onClick={() => onUse(c)}>
              {c.kind === 'event' ? 'Use this event' : 'Pair with this row'}
            </Button>
          </li>
        ))}
      </ul>
      {events && onCreateNew && (
        <Button className="small" busy={busy} disabled={disabled} onClick={onCreateNew}>
          Make a new event
        </Button>
      )}
    </div>
  );
}
