/**
 * v3 F10 (ADR 0078, C4): steering agents. A write that changes an age table (write_page, or a low-level write the
 * bridge can attribute to the table's document) carries one note: the bridge syncs the table's rows to the timeline,
 * and sync_timeline_event adds one row with its event in one step. Nothing is refused.
 */
import type { Chronology } from '../../chronology/index.js';

/** v3 F10 (ADR 0078, C4): the note a write to an age table carries (the owner's words). */
export const CHRONOLOGY_TABLE_NOTE =
  'This is a chronology table. New or changed rows are synced to the timeline by the bridge within minutes; to add one row with its event in one step, use sync_timeline_event.';

/** The note, when the document is an age table of the project's confirmed chronology (else nothing). */
export function chronologyTableNote(
  chronology: Pick<Chronology, 'config'> | undefined,
  projectId: string,
  resourceId: string,
  documentId: string,
): { chronologyNote?: string } {
  if (!chronology) return {};
  try {
    const c = chronology.config(projectId);
    if (!c.confirmed || c.resourceId !== resourceId) return {};
    return c.ages.some((a) => a.tableDocumentId === documentId)
      ? { chronologyNote: CHRONOLOGY_TABLE_NOTE }
      : {};
  } catch {
    return {};
  }
}
