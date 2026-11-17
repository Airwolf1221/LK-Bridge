/**
 * The appraisal's overlay and full-text index (v3 F3c, ADR 0054; the design's A1).
 *
 * The audits read the newest complete full snapshot and lay every later change snapshot over it (ADR 0044 decision 1)
 * at each run. The appraisal tools answer per request, so that overlay is **materialised** in the bridge's database
 * once and kept current:
 *
 * - **built** from the newest full snapshot and the change snapshots after it (the audits' own rules: a change
 *   snapshot's page entry replaces the pieces it took and keeps the rest; a page it records as deleted leaves). Unlike
 *   the audits, a **partial** full snapshot is taken as the base too (the service's source lists it): one image whose
 *   bytes could not be taken must not leave the appraisal a day behind. The pieces it lacks are recorded per page
 *   (`unreadable`), and the reports list those pages as blocked cases, never guessed;
 * - **updated** from each later change snapshot, page by page (only the pages it took are re-indexed);
 * - **rebuilt** when a newer full snapshot exists (the snapshot service's `afterFull` hook starts it at once;
 *   any appraisal or search finds it out of date otherwise), and when a change snapshot turns up older than one already
 *   laid over (two jobs' snapshots indexed out of order: never merged out of order).
 *
 * Every call that reads it first catches up (`ensure`): the change snapshots the overlay has not seen are applied, so an
 * answer is complete as of the newest snapshot. It reads the snapshot store only, never LegendKeeper.
 *
 * What it holds per page: its place in the snapshot's tree and its pieces' hashes (`appraisal_index_pages`), its text
 * units (`appraisal_fts`, an FTS5 table), its references to other pages (`appraisal_refs`) and its images
 * (`appraisal_images`); and per project the templates' sidebars (`appraisal_index_templates`) and the state.
 */
import type { Db } from '../db/open.js';
import type { SnapshotSource } from '../audits/reader.js';
import type { DocumentEntry, Manifest, PageEntry } from '../snapshots/manifest.js';
import { classifyName } from '../tree/classify.js';
import type { NodeKind } from '../tree/index.js';
import { extractPage, urlPath, type DocumentInput, type PageExtract } from './extract.js';

type Obj = Record<string, unknown>;

export interface IndexState {
  readonly projectId: string;
  readonly baseSnapshotId: string;
  readonly baseTakenAt: number;
  readonly newestSnapshotId: string;
  readonly newestTakenAt: number;
  readonly changes: number;
  readonly rootId: string | null;
  readonly librarySha: string | null;
  readonly pages: number;
  readonly units: number;
  readonly refs: number;
  readonly unreadable: number;
  readonly builtAt: number;
  readonly buildMs: number;
  readonly updatedAt: number;
  readonly lastUpdateMs: number | null;
  readonly sizeBytes: number | null;
  readonly notes: readonly string[];
}

export interface OverlayDocument {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
  readonly sha256: string;
}

/** A page as the overlay holds it (no content: the pieces are read from the store by their hashes). */
export interface OverlayPage {
  readonly id: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: NodeKind;
  readonly resourceSha: string | null;
  readonly sidebarSha: string | null;
  readonly documents: readonly OverlayDocument[];
  readonly sourceSnapshotId: string;
  readonly sourceTakenAt: number;
  readonly unreadable: readonly string[];
}

export interface OverlayTemplate {
  readonly id: string;
  readonly name: string;
  readonly sidebarSha: string | null;
}

/** What `ensure` did: nothing to do, a build, or change snapshots applied. */
export interface EnsureOutcome {
  readonly state: IndexState | null;
  /** `no_snapshot`: no full snapshot exists yet (the first nightly snapshot makes one). */
  readonly reason?: 'no_snapshot';
  readonly built?: boolean;
  readonly applied?: number;
}

export interface IndexDeps {
  readonly db: Db;
  readonly source: (projectId: string) => SnapshotSource;
  /** The key-value property facts are read from (`PROPERTIES`). */
  readonly propertiesName: (projectId: string) => string;
  readonly now: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Concurrent store reads (default 8). */
  readonly concurrency?: number;
}

interface Working {
  id: string;
  parentId: string | null;
  rank: string | null;
  name: string;
  resourceSha: string | null;
  sidebarSha: string | null;
  docs: Map<string, DocumentEntry>;
  images: Set<string>;
  /** What the snapshot could not take of the page (a partial snapshot's missing pieces), in words. */
  missing: string[];
  sourceSnapshotId: string;
  sourceTakenAt: number;
}

/** The tables the index occupies (their size is measured with `dbstat`). */
const INDEX_TABLES = [
  'appraisal_index_state',
  'appraisal_index_applied',
  'appraisal_index_pages',
  'appraisal_index_pages_parent',
  'appraisal_index_templates',
  'appraisal_fts',
  'appraisal_fts_data',
  'appraisal_fts_idx',
  'appraisal_fts_content',
  'appraisal_fts_docsize',
  'appraisal_fts_config',
  'appraisal_fts_rows',
  'appraisal_refs',
  'appraisal_refs_to',
  'appraisal_refs_from',
  'appraisal_images',
  'appraisal_images_page',
  'appraisal_images_path',
];

const MAX_CHANGES = 5000;

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, Math.max(1, items.length)) }, worker));
}

const json = (s: unknown, fallback: unknown): unknown => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** Lays one manifest page entry over what is known of the page (the audits' reader's rule). */
function layOver(into: Map<string, Working>, e: PageEntry, snap: { id: string; takenAt: number }): void {
  const prev = into.get(e.id);
  const docs = new Map(prev?.docs ?? []);
  for (const gone of e.deletedDocuments ?? []) docs.delete(gone);
  for (const d of e.documents ?? []) docs.set(d.id, d);
  const took = e.resource || e.sidebar || (e.documents?.length ?? 0) > 0 || !prev;
  const images = new Set(prev?.images ?? []);
  for (const i of e.images ?? []) images.add(i.url);
  const missing = (e.missing ?? []).map(
    (m) => `${m.piece}${m.ref ? ` ${m.ref}` : ''} (not in the snapshot: ${m.reason})`,
  );
  into.set(e.id, {
    id: e.id,
    parentId: e.parentId,
    rank: e.rank,
    name: e.name,
    resourceSha: e.resource?.sha256 ?? prev?.resourceSha ?? null,
    sidebarSha: e.sidebar?.sha256 ?? prev?.sidebarSha ?? null,
    docs,
    images,
    // A snapshot that took the page again says again what it could not take.
    missing: took || !prev ? missing : prev.missing,
    sourceSnapshotId: took || !prev ? snap.id : prev.sourceSnapshotId,
    sourceTakenAt: took || !prev ? snap.takenAt : prev.sourceTakenAt,
  });
}

function workingFromRow(r: Obj): Working {
  const docs = new Map<string, DocumentEntry>();
  for (const d of (json(r.documents, []) as OverlayDocument[]) ?? [])
    docs.set(d.id, { id: d.id, type: d.type, name: d.name, sha256: d.sha256, size: 0 });
  return {
    id: String(r.page_id),
    parentId: (r.parent_id as string | null) ?? null,
    rank: (r.rank as string | null) ?? null,
    name: String(r.name),
    resourceSha: (r.resource_sha as string | null) ?? null,
    sidebarSha: (r.sidebar_sha as string | null) ?? null,
    docs,
    images: new Set(),
    missing: ((json(r.unreadable, []) as string[]) ?? []).filter((x) => x.includes('(not in the snapshot:')),
    sourceSnapshotId: String(r.source_snapshot_id),
    sourceTakenAt: Number(r.source_taken_at),
  };
}

export class AppraisalIndex {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, { stamp: string; pages: Map<string, OverlayPage> }>();
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly d: IndexDeps) {}

  // ============================================================================================ reading

  state(projectId: string): IndexState | null {
    const r = this.d.db.prepare('SELECT * FROM appraisal_index_state WHERE project_id = ?').get(projectId) as
      Obj | undefined;
    if (!r) return null;
    return {
      projectId,
      baseSnapshotId: String(r.base_snapshot_id),
      baseTakenAt: Number(r.base_taken_at),
      newestSnapshotId: String(r.newest_snapshot_id),
      newestTakenAt: Number(r.newest_taken_at),
      changes: Number(r.changes),
      rootId: (r.root_id as string | null) ?? null,
      librarySha: (r.library_sha as string | null) ?? null,
      pages: Number(r.pages),
      units: Number(r.units),
      refs: Number(r.refs),
      unreadable: Number(r.unreadable),
      builtAt: Number(r.built_at),
      buildMs: Number(r.build_ms),
      updatedAt: Number(r.updated_at),
      lastUpdateMs: r.last_update_ms === null ? null : Number(r.last_update_ms),
      sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
      notes: (json(r.notes, []) as string[]) ?? [],
    };
  }

  /** Every page of the overlay, by id (cached until the overlay changes). */
  pages(projectId: string): ReadonlyMap<string, OverlayPage> {
    const st = this.state(projectId);
    const stamp = st ? `${st.baseSnapshotId}:${st.newestSnapshotId}:${st.updatedAt}:${st.pages}` : 'none';
    const hit = this.cache.get(projectId);
    if (hit && hit.stamp === stamp) return hit.pages;
    const rows = this.d.db
      .prepare('SELECT * FROM appraisal_index_pages WHERE project_id = ? ORDER BY page_id')
      .all(projectId) as Obj[];
    const pages = new Map<string, OverlayPage>();
    for (const r of rows) {
      const name = String(r.name);
      const id = String(r.page_id);
      const c = classifyName(name);
      pages.set(id, {
        id,
        parentId: (r.parent_id as string | null) ?? null,
        rank: (r.rank as string | null) ?? null,
        rawName: name,
        displayName: c.displayName,
        kind: st?.rootId === id ? 'root' : c.kind,
        resourceSha: (r.resource_sha as string | null) ?? null,
        sidebarSha: (r.sidebar_sha as string | null) ?? null,
        documents: (json(r.documents, []) as OverlayDocument[]) ?? [],
        sourceSnapshotId: String(r.source_snapshot_id),
        sourceTakenAt: Number(r.source_taken_at),
        unreadable: (json(r.unreadable, []) as string[]) ?? [],
      });
    }
    this.cache.set(projectId, { stamp, pages });
    return pages;
  }

  templates(projectId: string): OverlayTemplate[] {
    return (
      this.d.db
        .prepare('SELECT * FROM appraisal_index_templates WHERE project_id = ? ORDER BY template_id')
        .all(projectId) as Obj[]
    ).map((r) => ({
      id: String(r.template_id),
      name: String(r.name),
      sidebarSha: (r.sidebar_sha as string | null) ?? null,
    }));
  }

  /** The size of the appraisal tables on disk (every project), measured with SQLite's `dbstat`. */
  measureSize(): number | null {
    try {
      const r = this.d.db
        .prepare(
          `SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${INDEX_TABLES.map(() => '?').join(', ')})`,
        )
        .get(...INDEX_TABLES) as { bytes: number | null };
      return r.bytes ?? 0;
    } catch {
      return null;
    }
  }

  // ============================================================================================ keeping it current

  /** Serialises the builds and updates of one project. */
  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Brings the overlay up to date: built when there is none or a newer full snapshot exists (or `rebuild`),
   * else each change snapshot it has not seen laid over, page by page. Reads the snapshot store only.
   */
  ensure(projectId: string, o: { readonly rebuild?: boolean } = {}): Promise<EnsureOutcome> {
    return this.serial(projectId, async () => {
      const source = this.d.source(projectId);
      const fulls = source.fulls(projectId);
      const st = this.state(projectId);
      const newestFull = fulls[0];
      if (!newestFull) return st ? { state: st } : { state: null, reason: 'no_snapshot' };
      if (!st || st.baseSnapshotId !== newestFull.id || o.rebuild === true) {
        const built = await this.build(projectId, source, newestFull);
        return built ? { state: this.state(projectId), built: true } : { state: st, reason: 'no_snapshot' };
      }
      const applied = new Set(
        (
          this.d.db
            .prepare('SELECT snapshot_id FROM appraisal_index_applied WHERE project_id = ?')
            .all(projectId) as { snapshot_id: string }[]
        ).map((r) => r.snapshot_id),
      );
      const pending = source
        .changesAfter(projectId, st.baseTakenAt)
        .filter((c) => !applied.has(c.id))
        .slice(0, MAX_CHANGES);
      if (pending.length === 0) return { state: st, applied: 0 };
      // A change snapshot older than one already laid over: never merged out of order, the overlay is built again.
      if (pending.some((c) => c.takenAt < st.newestTakenAt)) {
        await this.build(projectId, source, newestFull);
        return { state: this.state(projectId), built: true };
      }
      const t0 = Date.now();
      let n = 0;
      for (const c of pending) {
        const m = await source.manifest(c.id);
        if (!m) continue;
        await this.applyChange(projectId, source, m, c);
        n++;
      }
      const ms = Date.now() - t0;
      this.finishUpdate(projectId, ms);
      return { state: this.state(projectId), applied: n };
    });
  }

  /** After a full snapshot completes (the snapshot service's hook): the overlay rebuilt from it, in the background. */
  afterFullSnapshot(projectId: string): void {
    const p = this.ensure(projectId)
      .then(() => undefined)
      .catch((e: unknown) =>
        this.d.log?.warn(
          { err: e, projectId },
          'the appraisal index could not be built after the full snapshot',
        ),
      )
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /** Waits for the builds started after full snapshots (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ============================================================================================ building

  private async build(
    projectId: string,
    source: SnapshotSource,
    base: { id: string; takenAt: number },
  ): Promise<boolean> {
    const t0 = Date.now();
    const manifest = await source.manifest(base.id);
    if (!manifest) return false;
    const working = new Map<string, Working>();
    for (const p of manifest.pages) if (!p.deleted) layOver(working, p, base);
    const changes = source.changesAfter(projectId, base.takenAt).slice(0, MAX_CHANGES);
    const applied: { id: string; takenAt: number }[] = [];
    let librarySha = manifest.library?.piece?.sha256 ?? null;
    for (const c of changes) {
      const m = await source.manifest(c.id);
      if (!m) continue;
      for (const p of m.pages) {
        if (p.deleted) working.delete(p.id);
        else layOver(working, p, c);
      }
      if (m.library?.piece?.sha256) librarySha = m.library.piece.sha256;
      applied.push(c);
    }
    const newest = applied.length > 0 ? applied[applied.length - 1]! : base;
    const propertiesName = this.d.propertiesName(projectId);
    const extracted = new Map<string, { extract: PageExtract; unreadable: string[] }>();
    await pool([...working.values()], this.d.concurrency ?? 8, async (w) => {
      extracted.set(w.id, await this.extractWorking(source, w, propertiesName));
    });
    const db = this.d.db;
    const now = this.d.now();
    let units = 0;
    let refs = 0;
    let unreadable = 0;
    db.transaction(() => {
      this.clearProject(projectId);
      for (const w of working.values()) {
        const x = extracted.get(w.id)!;
        this.insertPage(projectId, w, x.unreadable);
        const n = this.insertExtract(projectId, w, x.extract);
        units += n.units;
        refs += n.refs;
        unreadable += x.unreadable.length;
      }
      const tpl = db.prepare(
        'INSERT INTO appraisal_index_templates (project_id, template_id, name, sidebar_sha) VALUES (?, ?, ?, ?)',
      );
      for (const t of manifest.templates ?? [])
        if (!t.deleted) tpl.run(projectId, t.id, t.name, t.sidebar?.sha256 ?? null);
      const ins = db.prepare(
        'INSERT INTO appraisal_index_applied (project_id, snapshot_id, taken_at) VALUES (?, ?, ?)',
      );
      for (const c of applied) ins.run(projectId, c.id, c.takenAt);
      const notes: string[] = [];
      const missing = manifest.counts.missing ?? 0;
      if (!manifest.complete || missing > 0)
        notes.push(
          `The base full snapshot (${base.id}) is partial: ${missing} piece(s) could not be taken (an image that could not be downloaded, a map LegendKeeper cannot list…); each is reported on its page, never guessed.`,
        );
      if (!manifest.templates)
        notes.push(
          'The base full snapshot holds no templates, so the template checks cannot run until the next nightly snapshot.',
        );
      db.prepare(
        `INSERT INTO appraisal_index_state (project_id, base_snapshot_id, base_taken_at, newest_snapshot_id,
           newest_taken_at, changes, root_id, library_sha, pages, units, refs, unreadable, built_at, build_ms,
           updated_at, last_update_ms, size_bytes, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        projectId,
        base.id,
        base.takenAt,
        newest.id,
        newest.takenAt,
        applied.length,
        manifest.rootId,
        librarySha,
        working.size,
        units,
        refs,
        unreadable,
        now,
        0,
        now,
        JSON.stringify(notes),
      );
    })();
    const ms = Date.now() - t0;
    const size = this.measureSize();
    db.prepare('UPDATE appraisal_index_state SET build_ms = ?, size_bytes = ? WHERE project_id = ?').run(
      ms,
      size,
      projectId,
    );
    this.cache.delete(projectId);
    return true;
  }

  /** Lays one change snapshot over the overlay: each page it took is re-read from the store and re-indexed. */
  private async applyChange(
    projectId: string,
    source: SnapshotSource,
    m: Manifest,
    snap: { id: string; takenAt: number },
  ): Promise<void> {
    const db = this.d.db;
    const propertiesName = this.d.propertiesName(projectId);
    const rowOf = db.prepare('SELECT * FROM appraisal_index_pages WHERE project_id = ? AND page_id = ?');
    const updates: { w: Working; x: { extract: PageExtract; unreadable: string[] } }[] = [];
    const deletions: string[] = [];
    for (const p of m.pages) {
      if (p.deleted) {
        deletions.push(p.id);
        continue;
      }
      const r = rowOf.get(projectId, p.id) as Obj | undefined;
      const into = new Map<string, Working>();
      if (r) {
        const prev = workingFromRow(r);
        // The images a page showed before are kept (union): an image only leaves a page's list at the next full snapshot.
        for (const u of this.d.db
          .prepare(`SELECT url FROM appraisal_images WHERE project_id = ? AND page_id = ? AND kind = 'other'`)
          .all(projectId, p.id) as { url: string }[])
          prev.images.add(u.url);
        into.set(p.id, prev);
      }
      layOver(into, p, snap);
      const w = into.get(p.id)!;
      updates.push({ w, x: await this.extractWorking(source, w, propertiesName) });
    }
    db.transaction(() => {
      for (const id of deletions) this.deletePage(projectId, id);
      for (const u of updates) {
        this.deletePage(projectId, u.w.id);
        this.insertPage(projectId, u.w, u.x.unreadable);
        this.insertExtract(projectId, u.w, u.x.extract);
      }
      if (m.library?.piece?.sha256)
        db.prepare('UPDATE appraisal_index_state SET library_sha = ? WHERE project_id = ?').run(
          m.library.piece.sha256,
          projectId,
        );
      db.prepare(
        'INSERT OR IGNORE INTO appraisal_index_applied (project_id, snapshot_id, taken_at) VALUES (?, ?, ?)',
      ).run(projectId, snap.id, snap.takenAt);
      db.prepare(
        `UPDATE appraisal_index_state SET newest_snapshot_id = ?, newest_taken_at = ?, changes = changes + 1,
           updated_at = ? WHERE project_id = ?`,
      ).run(snap.id, snap.takenAt, this.d.now(), projectId);
    })();
    this.cache.delete(projectId);
  }

  /** The counts after an update, and how long it took. */
  private finishUpdate(projectId: string, ms: number): void {
    const db = this.d.db;
    const count = (sql: string) => (db.prepare(sql).get(projectId) as { n: number }).n;
    const unreadable = (
      db
        .prepare('SELECT unreadable FROM appraisal_index_pages WHERE project_id = ? AND unreadable <> ?')
        .all(projectId, '[]') as { unreadable: string }[]
    ).reduce((n, r) => n + ((json(r.unreadable, []) as unknown[]) ?? []).length, 0);
    db.prepare(
      `UPDATE appraisal_index_state SET pages = ?, units = ?, refs = ?, unreadable = ?, last_update_ms = ?, size_bytes = ?
       WHERE project_id = ?`,
    ).run(
      count('SELECT COUNT(*) AS n FROM appraisal_index_pages WHERE project_id = ?'),
      count('SELECT COUNT(*) AS n FROM appraisal_fts_rows WHERE project_id = ?'),
      count('SELECT COUNT(*) AS n FROM appraisal_refs WHERE project_id = ?'),
      unreadable,
      ms,
      this.measureSize(),
      projectId,
    );
    this.cache.delete(projectId);
  }

  /** One page's pieces read from the store and extracted. */
  private async extractWorking(
    source: SnapshotSource,
    w: Working,
    propertiesName: string,
  ): Promise<{ extract: PageExtract; unreadable: string[] }> {
    const unreadable: string[] = [...w.missing];
    const resource = w.resourceSha ? await source.piece(w.resourceSha) : null;
    if (w.resourceSha && resource === null) unreadable.push('resource');
    const sidebar = w.sidebarSha ? await source.piece(w.sidebarSha) : null;
    if (w.sidebarSha && sidebar === null) unreadable.push('sidebar');
    const documents: DocumentInput[] = [];
    for (const d of w.docs.values()) {
      if (d.type !== 'page') continue;
      const piece = await source.piece(d.sha256);
      if (piece === null) unreadable.push(`document ${d.id}`);
      documents.push({ id: d.id, type: d.type, name: d.name, piece });
    }
    const { displayName } = classifyName(w.name);
    const extract = extractPage(
      { rawName: w.name, displayName, resource, sidebar, documents },
      propertiesName,
    );
    // The images the snapshot names for the page that are not image blocks of its text (a map's image, a banner…).
    const shown = new Set(extract.images.map((i) => urlPath(i.url)));
    for (const url of w.images)
      if (!shown.has(urlPath(url))) {
        shown.add(urlPath(url));
        extract.images.push({
          documentId: null,
          blockId: null,
          kind: 'other',
          url,
          label: null,
          interpretation: false,
          section: null,
        });
      }
    return { extract, unreadable };
  }

  private clearProject(projectId: string): void {
    const db = this.d.db;
    db.prepare(
      'DELETE FROM appraisal_fts WHERE rowid IN (SELECT fts_rowid FROM appraisal_fts_rows WHERE project_id = ?)',
    ).run(projectId);
    for (const t of [
      'appraisal_fts_rows',
      'appraisal_refs',
      'appraisal_images',
      'appraisal_index_pages',
      'appraisal_index_templates',
      'appraisal_index_applied',
      'appraisal_index_state',
    ])
      db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(projectId);
  }

  private deletePage(projectId: string, pageId: string): void {
    const db = this.d.db;
    db.prepare(
      `DELETE FROM appraisal_fts WHERE rowid IN
         (SELECT fts_rowid FROM appraisal_fts_rows WHERE project_id = ? AND page_id = ?)`,
    ).run(projectId, pageId);
    for (const t of ['appraisal_fts_rows', 'appraisal_images', 'appraisal_index_pages'])
      db.prepare(`DELETE FROM ${t} WHERE project_id = ? AND page_id = ?`).run(projectId, pageId);
    db.prepare('DELETE FROM appraisal_refs WHERE project_id = ? AND from_page = ?').run(projectId, pageId);
  }

  private insertPage(projectId: string, w: Working, unreadable: readonly string[]): void {
    const docs: OverlayDocument[] = [...w.docs.values()].map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
      sha256: d.sha256,
    }));
    this.d.db
      .prepare(
        `INSERT INTO appraisal_index_pages (project_id, page_id, parent_id, rank, name, resource_sha, sidebar_sha,
           documents, source_snapshot_id, source_taken_at, unreadable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        w.id,
        w.parentId,
        w.rank,
        w.name,
        w.resourceSha,
        w.sidebarSha,
        JSON.stringify(docs),
        w.sourceSnapshotId,
        w.sourceTakenAt,
        JSON.stringify(unreadable),
      );
  }

  private insertExtract(projectId: string, w: Working, x: PageExtract): { units: number; refs: number } {
    const db = this.d.db;
    const fts = db.prepare(
      `INSERT INTO appraisal_fts (text, project_id, page_id, document_id, block_id, unit, field, section)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const map = db.prepare(
      'INSERT INTO appraisal_fts_rows (project_id, page_id, fts_rowid) VALUES (?, ?, ?)',
    );
    for (const u of x.units) {
      const r = fts.run(u.text, projectId, w.id, u.documentId, u.blockId, u.unit, u.field, u.section);
      map.run(projectId, w.id, Number(r.lastInsertRowid));
    }
    const ref = db.prepare(
      `INSERT INTO appraisal_refs (project_id, from_page, from_document, from_block, section, via, property, row_key,
         to_page, to_document, label, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of x.refs)
      ref.run(
        projectId,
        w.id,
        r.fromDocument,
        r.fromBlock,
        r.section,
        r.via,
        r.property,
        r.rowKey,
        r.toPage,
        r.toDocument,
        r.label,
        r.context,
      );
    const img = db.prepare(
      `INSERT INTO appraisal_images (project_id, page_id, document_id, block_id, kind, url, url_path, label,
         interpretation, section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const i of x.images)
      img.run(
        projectId,
        w.id,
        i.documentId,
        i.blockId,
        i.kind,
        i.url,
        urlPath(i.url),
        i.label,
        i.interpretation ? 1 : 0,
        i.section,
      );
    return { units: x.units.length, refs: x.refs.length };
  }
}
