/**
 * The bridge's memory of recent page versions (v2 C1, ADR 0031; migration 1200): the Markdown of a page document at a
 * version the bridge has read or written. write_page uses it to decide a section edit made from an older read: the
 * section as the agent read it (rebuilt from its `baseVersion`) must equal the section now, or the edit is refused.
 *
 * read_document and write_page record what they read; a verified write records the version it made. Only a few versions
 * per document are kept, for a few days: enough for an agent that reads, thinks and writes, never a history of the page.
 * Nothing here is ever a reason to write: a version the bridge does not remember only makes a section edit refuse.
 */
import type { Db } from '../db/open.js';

export interface DocumentVersionSettings {
  /** Versions kept per document, newest first (default 5). */
  readonly perDocument: number;
  /** Versions older than this are forgotten (default 7 days). */
  readonly maxAgeMs: number;
  /** Larger Markdown is not kept (default 2 MiB). */
  readonly maxBytes: number;
}

export const DEFAULT_DOCUMENT_VERSION_SETTINGS: DocumentVersionSettings = {
  perDocument: 5,
  maxAgeMs: 7 * 86_400_000,
  maxBytes: 2 * 1024 * 1024,
};

export class DocumentVersions {
  private lastPrune = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly settings: DocumentVersionSettings = DEFAULT_DOCUMENT_VERSION_SETTINGS,
  ) {}

  /** Records the Markdown of a document at a version (the latest sighting wins). Never throws. */
  remember(projectId: string, documentId: string, version: string, markdown: string): void {
    const bytes = Buffer.byteLength(markdown);
    if (!version || bytes > this.settings.maxBytes) return;
    const at = this.now();
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO document_versions (project_id, document_id, version, markdown, bytes, seen_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (project_id, document_id, version) DO UPDATE SET seen_at = excluded.seen_at`,
          )
          .run(projectId, documentId, version, markdown, bytes, at);
        this.db
          .prepare(
            `DELETE FROM document_versions WHERE project_id = ? AND document_id = ? AND version NOT IN (
               SELECT version FROM document_versions WHERE project_id = ? AND document_id = ?
               ORDER BY seen_at DESC LIMIT ?)`,
          )
          .run(projectId, documentId, projectId, documentId, this.settings.perDocument);
      })();
      if (at - this.lastPrune > 3_600_000) {
        this.lastPrune = at;
        this.db.prepare('DELETE FROM document_versions WHERE seen_at < ?').run(at - this.settings.maxAgeMs);
      }
    } catch {
      // A memory, not a record: failing to keep it only makes a later section edit from this version refuse.
    }
  }

  /** The Markdown of a document at `version`, if the bridge still remembers it (and it is not too old). */
  markdownAt(projectId: string, documentId: string, version: string): string | undefined {
    const r = this.db
      .prepare(
        `SELECT markdown, seen_at FROM document_versions WHERE project_id = ? AND document_id = ? AND version = ?`,
      )
      .get(projectId, documentId, version) as { markdown: string; seen_at: number } | undefined;
    if (!r || this.now() - r.seen_at > this.settings.maxAgeMs) return undefined;
    return r.markdown;
  }
}
