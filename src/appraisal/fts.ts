/**
 * Queries over the appraisal's full-text index (v3 F3c, ADR 0054; the design's A1). Pure SQL over `appraisal_fts`:
 *
 * - a **word** matches any word starting with it (`fox` finds "Foxians"), a **"quoted phrase"** exactly those words in
 *   order; case and accents are ignored (`unicode61`, diacritics removed). Each term is answered on its own as the set
 *   of pages whose text holds it, so the `search` tool's operators (AND, OR, NOT, brackets) combine whole pages, exactly
 *   as they combine names: a page matches `foxian shrine` when its text holds both words, anywhere in it;
 * - the **hits** of one page: its units holding any of the positive terms, best first, each with its document, block,
 *   section path and a short snippet.
 */
import type { Db } from '../db/open.js';

export interface Term {
  readonly value: string;
  readonly phrase: boolean;
}

/** The key a term is answered under. */
export const termKey = (t: Term): string => `${t.phrase ? 'p' : 'w'}:${t.value}`;

/** The FTS5 query of one term, or null when it holds no word the index can match (punctuation alone). */
export function ftsQueryOf(t: Term): string | null {
  if (!/[\p{L}\p{N}]/u.test(t.value)) return null;
  const quoted = `"${t.value.replace(/"/g, '""')}"`;
  return t.phrase ? quoted : `${quoted}*`;
}

/** Several terms, any of them (for a page's hits). */
export function anyOf(terms: readonly Term[]): string | null {
  const qs = terms.map(ftsQueryOf).filter((q): q is string => q !== null);
  if (qs.length === 0) return null;
  return qs.length === 1 ? qs[0]! : qs.map((q) => `(${q})`).join(' OR ');
}

export interface TextHit {
  readonly pageId: string;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly unit: string;
  readonly field: string | null;
  readonly section: string | null;
  readonly snippet: string;
  readonly text: string;
  /** bm25: lower is better. */
  readonly rank: number;
}

export class FullText {
  constructor(private readonly db: Db) {}

  /** The pages whose text holds the term, with each page's best rank (bm25, lower is better). */
  pagesFor(projectId: string, t: Term): Map<string, number> {
    const q = ftsQueryOf(t);
    const out = new Map<string, number>();
    if (q === null) return out;
    const rows = this.db
      .prepare(
        `SELECT page_id, MIN(rank) AS best FROM appraisal_fts
         WHERE appraisal_fts MATCH ? AND project_id = ? GROUP BY page_id`,
      )
      .all(q, projectId) as { page_id: string; best: number }[];
    for (const r of rows) out.set(r.page_id, r.best);
    return out;
  }

  /** One page's units holding any of the terms, best first. */
  hits(projectId: string, pageId: string, terms: readonly Term[], limit = 3): TextHit[] {
    const q = anyOf(terms);
    if (q === null) return [];
    return this.query(q, projectId, { pageId, limit });
  }

  /** Units holding the query anywhere in the project (A3's restatements), best first. */
  search(
    projectId: string,
    terms: readonly Term[],
    o: { readonly limit?: number; readonly excludePage?: string } = {},
  ): TextHit[] {
    const q = anyOf(terms);
    if (q === null) return [];
    return this.query(q, projectId, {
      limit: o.limit ?? 200,
      ...(o.excludePage ? { excludePage: o.excludePage } : {}),
    });
  }

  private query(
    q: string,
    projectId: string,
    o: { readonly pageId?: string; readonly excludePage?: string; readonly limit: number },
  ): TextHit[] {
    const where = ['appraisal_fts MATCH ?', 'project_id = ?'];
    const args: unknown[] = [q, projectId];
    if (o.pageId !== undefined) {
      where.push('page_id = ?');
      args.push(o.pageId);
    }
    if (o.excludePage !== undefined) {
      where.push('page_id <> ?');
      args.push(o.excludePage);
    }
    const rows = this.db
      .prepare(
        `SELECT page_id, document_id, block_id, unit, field, section, text, rank,
           snippet(appraisal_fts, 0, '«', '»', '…', 14) AS snippet
         FROM appraisal_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      )
      .all(...args, o.limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      pageId: String(r.page_id),
      documentId: (r.document_id as string | null) ?? null,
      blockId: (r.block_id as string | null) ?? null,
      unit: String(r.unit),
      field: (r.field as string | null) ?? null,
      section: (r.section as string | null) ?? null,
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
      text: typeof r.text === 'string' ? r.text : '',
      rank: Number(r.rank),
    }));
  }
}
