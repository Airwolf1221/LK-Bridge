/**
 * v3 F4b (ADR 0064): the facts index. The extractor (./extract.ts) run over the appraisal's overlay (its full-text units:
 * sidebar facts and page text) and the chronology's tables (from the snapshots), with what it read kept in the bridge's
 * database (`consistency_facts`), so both tools answer for free.
 *
 * - **Incremental** like the other F3c indexes: each page's stamp (its name and its pieces' hashes) is kept; a later
 *   change snapshot re-reads only the pages whose stamp moved, and a page gone from the overlay leaves.
 * - **Rebuilt** when what the facts were read WITH changes (the key: the pack's phrasings, the characters' names, the
 *   calendar, the chronology's settings) or the overlay was rebuilt from a newer full snapshot.
 * - **Bounded and streaming** (CR-2026-11-R3's per-event retention): the units are read with one cursor, page by page,
 *   and only the facts (a few per page) are kept until they are written; nothing is cached between runs.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { OverlayPage } from '../appraisal/overlay.js';
import type { DateReading } from './dates.js';
import {
  extractPageFacts,
  extractRowFacts,
  type ChronologyRowInput,
  type ExtractedFact,
  type FactKind,
  type FactPlace,
  type FactSource,
  type MatchedAs,
  type PageMeta,
  type Unit,
} from './extract.js';

type Obj = Record<string, unknown>;

/** What the extractor needs for one project (the service builds it). */
export interface ExtractEnv {
  /** What the facts are read with: when it changes, the index is rebuilt. */
  readonly key: string;
  readonly ctx: Parameters<typeof extractPageFacts>[2];
  /** The chronology's rows, read from the snapshots (only when the chronology page is (re)read). */
  readonly rows: () => Promise<readonly ChronologyRowInput[]>;
  /** The chronology's page (its rows are re-read with it). */
  readonly chronologyPageId: string | null;
}

/** A fact as stored. */
export interface StoredFact {
  readonly pageId: string;
  readonly seq: number;
  readonly kind: FactKind;
  readonly field: string | null;
  readonly source: FactSource;
  readonly pattern: string;
  readonly subjectKey: string;
  readonly subjectText: string;
  readonly matchedAs: MatchedAs;
  readonly valueText: string;
  readonly gap: boolean;
  readonly date: DateReading | null;
  readonly unreadable: string | null;
  readonly bound: 'from' | 'to' | 'both' | null;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly section: string | null;
  readonly excerpt: string;
  readonly mentions: readonly string[];
  /** ADR 0064 amendment 1 (F): read from a section or row marked non-current (kept with the mentions, no migration). */
  readonly nonCurrent?: true;
  /** CR-2026-11-R4: where the value was read (kept with the mentions, no migration; see `ExtractedFact.place`). */
  readonly place?: FactPlace;
  /** CR-2026-11-R4 (request L): the life a phrasing names (1 for the first), kept with the mentions (no migration). */
  readonly life?: number;
  /** CR-2026-11-R4 (request L): an attested start that begins a new life (a return, a restoration). */
  readonly start?: 'return' | 'restoration';
}

export interface FactIndexState {
  readonly key: string;
  readonly baseSnapshotId: string;
  readonly pages: number;
  readonly facts: number;
  readonly builtAt: number;
  readonly buildMs: number;
  readonly updatedAt: number;
  readonly lastUpdateMs: number | null;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/**
 * What the stored facts hold, as a version (part of the index's key): an index stored in an older format is rebuilt once,
 * on the first request after deploying. CR-2026-11-R4: `place-1`, each fact's place (`StoredFact.place`).
 */
export const INDEX_FORMAT = 'place-1';

/** A page's stamp: its name and its pieces' hashes (content-addressed, so an identical re-take keeps it). */
export function pageStamp(p: OverlayPage): string {
  return sha1(
    [
      p.rawName,
      p.resourceSha ?? '',
      p.sidebarSha ?? '',
      ...p.documents.map((d) => `${d.id}=${d.sha256}`),
    ].join('\u0001'),
  );
}

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** The `bound` of an attested fact is kept in its pattern's data; stored as open flags with the reading. */
function rowToFact(r: Obj): StoredFact {
  const start = r.start_min as number | null;
  const date: DateReading | null =
    start === null || start === undefined
      ? null
      : {
          text: String(r.value_text),
          start: Number(start),
          end: Number(r.end_min ?? start),
          precision: (r.precision as DateReading['precision']) ?? 'year',
          shape: (r.shape as DateReading['shape']) ?? 'year',
          approximate: r.approximate === 1,
          ...(r.open_start === 1 ? { openStart: true } : {}),
          ...(r.open_end === 1 ? { openEnd: true } : {}),
        };
  const meta = json<{
    bound?: StoredFact['bound'];
    mentions?: string[];
    nonCurrent?: boolean;
    place?: { sha?: unknown; at?: unknown };
    life?: number;
    start?: StoredFact['start'];
  }>(r.mentions, {});
  const place =
    meta.place && typeof meta.place.sha === 'string'
      ? { sha: meta.place.sha, at: typeof meta.place.at === 'number' ? meta.place.at : null }
      : null;
  return {
    pageId: String(r.page_id),
    seq: Number(r.seq),
    kind: r.kind as FactKind,
    field: (r.field as string | null) ?? null,
    source: r.source as FactSource,
    pattern: String(r.pattern),
    subjectKey: String(r.subject_key),
    subjectText: String(r.subject_text),
    matchedAs: r.matched_as as MatchedAs,
    valueText: String(r.value_text),
    gap: r.gap === 1,
    date,
    unreadable: (r.unreadable as string | null) ?? null,
    bound: meta.bound ?? null,
    documentId: (r.document_id as string | null) ?? null,
    blockId: (r.block_id as string | null) ?? null,
    section: (r.section as string | null) ?? null,
    excerpt: String(r.excerpt),
    mentions: meta.mentions ?? [],
    ...(meta.nonCurrent === true ? { nonCurrent: true as const } : {}),
    ...(place ? { place } : {}),
    ...(typeof meta.life === 'number' ? { life: meta.life } : {}),
    ...(meta.start === 'return' || meta.start === 'restoration' ? { start: meta.start } : {}),
  };
}

export class FactIndex {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  state(projectId: string): FactIndexState | null {
    const r = this.db.prepare('SELECT * FROM consistency_index_state WHERE project_id = ?').get(projectId) as
      Obj | undefined;
    if (!r) return null;
    return {
      key: String(r.key),
      baseSnapshotId: String(r.base_snapshot_id),
      pages: Number(r.pages),
      facts: Number(r.facts),
      builtAt: Number(r.built_at),
      buildMs: Number(r.build_ms),
      updatedAt: Number(r.updated_at),
      lastUpdateMs: r.last_update_ms === null ? null : Number(r.last_update_ms),
    };
  }

  /**
   * Brings the facts up to date with the overlay (call the overlay's `ensure` first): built when there are none, the key
   * changed or the overlay was rebuilt; else the pages whose stamp moved re-read. Reads the bridge's database and the
   * snapshot store only, never LegendKeeper.
   */
  async ensure(
    projectId: string,
    overlay: { readonly pages: ReadonlyMap<string, OverlayPage>; readonly baseSnapshotId: string },
    env: ExtractEnv,
  ): Promise<{ readonly built: boolean; readonly reread: number }> {
    const st = this.state(projectId);
    const t0 = Date.now();
    // The stored format is part of the key, so facts stored without what this build keeps are read again.
    const key = `${env.key}|${INDEX_FORMAT}`;
    if (!st || st.key !== key || st.baseSnapshotId !== overlay.baseSnapshotId) {
      await this.build(projectId, overlay, { ...env, key }, t0);
      return { built: true, reread: overlay.pages.size };
    }
    const stored = new Map(
      (
        this.db
          .prepare('SELECT page_id, stamp FROM consistency_pages WHERE project_id = ?')
          .all(projectId) as {
          page_id: string;
          stamp: string;
        }[]
      ).map((r) => [r.page_id, r.stamp]),
    );
    const changed: OverlayPage[] = [];
    for (const p of overlay.pages.values()) if (stored.get(p.id) !== pageStamp(p)) changed.push(p);
    const gone = [...stored.keys()].filter((id) => !overlay.pages.has(id));
    if (changed.length === 0 && gone.length === 0) return { built: false, reread: 0 };
    const unitsOf = this.db.prepare(
      `SELECT f.unit AS unit, f.text AS text, f.document_id AS document_id, f.block_id AS block_id, f.field AS field,
              f.section AS section
       FROM appraisal_fts_rows r JOIN appraisal_fts f ON f.rowid = r.fts_rowid
       WHERE r.project_id = ? AND r.page_id = ? ORDER BY r.fts_rowid`,
    );
    const pages: { page: OverlayPage; facts: ExtractedFact[]; meta: PageMeta }[] = [];
    for (const p of changed) {
      const units = (unitsOf.all(projectId, p.id) as Obj[]).map(unitOf);
      const x = extractPageFacts(p.id, units, env.ctx);
      pages.push({ page: p, ...x });
    }
    const chronologyChanged =
      env.chronologyPageId !== null && changed.some((p) => p.id === env.chronologyPageId);
    const rows = chronologyChanged ? extractRowFacts(await env.rows(), env.ctx) : null;
    this.db.transaction(() => {
      for (const id of gone) this.deletePage(projectId, id);
      for (const x of pages) {
        this.deletePage(projectId, x.page.id);
        const extra = rows && x.page.id === env.chronologyPageId ? rows : [];
        this.insertPage(projectId, x.page, x.meta, [...x.facts, ...extra]);
      }
      this.db
        .prepare(
          `UPDATE consistency_index_state SET pages = (SELECT COUNT(*) FROM consistency_pages WHERE project_id = ?),
             facts = (SELECT COUNT(*) FROM consistency_facts WHERE project_id = ?), updated_at = ?, last_update_ms = ?
           WHERE project_id = ?`,
        )
        .run(projectId, projectId, this.now(), Date.now() - t0, projectId);
    })();
    return { built: false, reread: changed.length };
  }

  /** Every page read again: ONE cursor over the overlay's units, page by page; only the facts are kept until written. */
  private async build(
    projectId: string,
    overlay: { readonly pages: ReadonlyMap<string, OverlayPage>; readonly baseSnapshotId: string },
    env: ExtractEnv,
    t0: number,
  ): Promise<void> {
    const out: { page: OverlayPage; facts: ExtractedFact[]; meta: PageMeta }[] = [];
    let current: string | null = null;
    let units: Unit[] = [];
    const flush = () => {
      if (current === null) return;
      const page = overlay.pages.get(current);
      if (page) out.push({ page, ...extractPageFacts(current, units, env.ctx) });
      units = [];
    };
    const cursor = this.db
      .prepare(
        `SELECT r.page_id AS page_id, f.unit AS unit, f.text AS text, f.document_id AS document_id,
                f.block_id AS block_id, f.field AS field, f.section AS section
         FROM appraisal_fts_rows r JOIN appraisal_fts f ON f.rowid = r.fts_rowid
         WHERE r.project_id = ? ORDER BY r.page_id, r.fts_rowid`,
      )
      .iterate(projectId) as IterableIterator<Obj>;
    for (const r of cursor) {
      const id = String(r.page_id);
      if (id !== current) {
        flush();
        current = id;
      }
      // Only what the extractor reads is kept: the page's name, its facts, and text holding a life-event verb.
      const u = unitOf(r);
      if (u.unit === 'name' || u.unit === 'fact' || /\b(?:born|died|dies|killed)\b/iu.test(u.text))
        units.push(u);
    }
    flush();
    // Pages with no units at all (a page whose pieces could not be read) still get their stamp.
    const seen = new Set(out.map((x) => x.page.id));
    for (const p of overlay.pages.values())
      if (!seen.has(p.id))
        out.push({ page: p, facts: [], meta: { subject: null, continuityType: null, continuity: null } });
    const rows = env.chronologyPageId !== null ? extractRowFacts(await env.rows(), env.ctx) : [];
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM consistency_facts WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM consistency_pages WHERE project_id = ?').run(projectId);
      for (const x of out)
        this.insertPage(
          projectId,
          x.page,
          x.meta,
          x.page.id === env.chronologyPageId ? [...x.facts, ...rows] : x.facts,
        );
      this.db
        .prepare(
          `INSERT INTO consistency_index_state (project_id, key, base_snapshot_id, pages, facts, built_at, build_ms,
             updated_at, last_update_ms)
           VALUES (?, ?, ?, ?, (SELECT COUNT(*) FROM consistency_facts WHERE project_id = ?), ?, ?, ?, NULL)
           ON CONFLICT (project_id) DO UPDATE SET key = excluded.key, base_snapshot_id = excluded.base_snapshot_id,
             pages = excluded.pages, facts = excluded.facts, built_at = excluded.built_at, build_ms = excluded.build_ms,
             updated_at = excluded.updated_at, last_update_ms = NULL`,
        )
        .run(projectId, env.key, overlay.baseSnapshotId, out.length, projectId, now, Date.now() - t0, now);
    })();
  }

  private deletePage(projectId: string, pageId: string): void {
    this.db
      .prepare('DELETE FROM consistency_facts WHERE project_id = ? AND page_id = ?')
      .run(projectId, pageId);
    this.db
      .prepare('DELETE FROM consistency_pages WHERE project_id = ? AND page_id = ?')
      .run(projectId, pageId);
  }

  private insertPage(
    projectId: string,
    p: OverlayPage,
    meta: PageMeta,
    facts: readonly ExtractedFact[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO consistency_pages (project_id, page_id, stamp, subject, continuity_type, continuity)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, p.id, pageStamp(p), meta.subject, meta.continuityType, meta.continuity);
    const ins = this.db.prepare(
      `INSERT INTO consistency_facts (project_id, page_id, seq, kind, field, source, pattern, subject_key, subject_text,
         matched_as, value_text, gap, start_min, end_min, precision, shape, approximate, open_start, open_end,
         unreadable, document_id, block_id, section, excerpt, mentions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    facts.forEach((f, i) =>
      ins.run(
        projectId,
        p.id,
        i,
        f.kind,
        f.field,
        f.source,
        f.pattern,
        f.subjectKey,
        f.subjectText,
        f.matchedAs,
        f.valueText,
        f.gap ? 1 : 0,
        f.date?.start ?? null,
        f.date?.end ?? null,
        f.date?.precision ?? null,
        f.date?.shape ?? null,
        f.date?.approximate ? 1 : 0,
        f.date?.openStart ? 1 : 0,
        f.date?.openEnd ? 1 : 0,
        f.unreadable,
        f.documentId,
        f.blockId,
        f.section,
        f.excerpt,
        JSON.stringify({
          ...(f.bound ? { bound: f.bound } : {}),
          mentions: f.mentions,
          ...(f.nonCurrent ? { nonCurrent: true } : {}),
          ...(f.place ? { place: { sha: f.place.sha, at: f.place.at } } : {}),
          ...(f.life !== undefined ? { life: f.life } : {}),
          ...(f.start ? { start: f.start } : {}),
        }),
      ),
    );
  }

  // ============================================================================================ reading

  /** The facts about these subjects (their names' keys, and `page:<id>` mentions). */
  factsAbout(projectId: string, subjectKeys: readonly string[]): StoredFact[] {
    const out: StoredFact[] = [];
    const keys = [...new Set(subjectKeys)];
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = keys.slice(i, i + 400);
      out.push(
        ...(
          this.db
            .prepare(
              `SELECT * FROM consistency_facts WHERE project_id = ? AND subject_key IN (${chunk.map(() => '?').join(', ')})
               ORDER BY page_id, seq`,
            )
            .all(projectId, ...chunk) as Obj[]
        ).map(rowToFact),
      );
    }
    return out;
  }

  /** The facts on these pages (an identity page's own, read whatever its subject is written as). */
  factsOn(projectId: string, pageIds: readonly string[]): StoredFact[] {
    const out: StoredFact[] = [];
    const ids = [...new Set(pageIds)];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      out.push(
        ...(
          this.db
            .prepare(
              `SELECT * FROM consistency_facts WHERE project_id = ? AND page_id IN (${chunk.map(() => '?').join(', ')})
               ORDER BY page_id, seq`,
            )
            .all(projectId, ...chunk) as Obj[]
        ).map(rowToFact),
      );
    }
    return out;
  }

  /** A page's subject and continuity, as the facts were read. */
  pageMeta(projectId: string, pageId: string): PageMeta | null {
    const r = this.db
      .prepare(
        'SELECT subject, continuity_type, continuity FROM consistency_pages WHERE project_id = ? AND page_id = ?',
      )
      .get(projectId, pageId) as Obj | undefined;
    if (!r) return null;
    return {
      subject: (r.subject as string | null) ?? null,
      continuityType: (r.continuity_type as string | null) ?? null,
      continuity: (r.continuity as string | null) ?? null,
    };
  }
}

function unitOf(r: Obj): Unit {
  return {
    unit: String(r.unit),
    text: typeof r.text === 'string' ? r.text : '',
    documentId: (r.document_id as string | null) ?? null,
    blockId: (r.block_id as string | null) ?? null,
    field: (r.field as string | null) ?? null,
    section: (r.section as string | null) ?? null,
  };
}
