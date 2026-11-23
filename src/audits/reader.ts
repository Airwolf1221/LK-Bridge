/**
 * The audit's reader (v2 E2, ADR 0044): builds the project's `AuditModel` from the snapshot store and nothing else.
 *
 * It takes the **newest complete full snapshot**, lays every **later change snapshot** over it in time order (a change
 * snapshot's page entry replaces the pieces it took, a page it records as deleted is removed and remembered as deleted, a
 * document it records as deleted is dropped), and reads each page's pieces from the store. It makes no request to
 * LegendKeeper: that is what makes a full audit free. Each page remembers the snapshot that supplied its newest piece, so
 * a finding can say which snapshot it came from and how old that was.
 */
import { classifyName } from '../tree/classify.js';
import type { DocumentEntry, Manifest, PageEntry } from '../snapshots/manifest.js';
import type { SnapshotService } from '../snapshots/service.js';
import {
  extractResource,
  extractSidebar,
  scanDocument,
  type AuditPage,
  type DocumentInfo,
  type DocumentScan,
  type Ref,
} from './model.js';

/** What the reader needs from the snapshot store (a test can supply its own). */
export interface SnapshotSource {
  /** Complete full snapshots, newest first. */
  fulls(projectId: string): { id: string; takenAt: number }[];
  /** Change snapshots taken after `after` (ms), oldest first. */
  changesAfter(projectId: string, after: number): { id: string; takenAt: number }[];
  manifest(id: string): Promise<Manifest | null>;
  /** One stored piece, or null when it is missing or damaged. */
  piece(sha256: string): Promise<unknown>;
}

export function sourceOf(svc: SnapshotService): SnapshotSource {
  return {
    fulls: (projectId) =>
      svc.index
        .snapshots(projectId, { kind: 'full', limit: 100 })
        .filter((s) => s.state === 'complete')
        .map((s) => ({ id: s.id, takenAt: s.takenAt })),
    changesAfter: (projectId, after) =>
      svc.index
        .snapshots(projectId, { kind: 'change', limit: 20_000 })
        .filter((s) => s.takenAt > after)
        .sort((a, b) => a.takenAt - b.takenAt || (a.id < b.id ? -1 : 1))
        .map((s) => ({ id: s.id, takenAt: s.takenAt })),
    manifest: (id) => svc.manifest(id),
    piece: (sha) => svc.store.getJson<unknown>(sha),
  };
}

export interface AuditModel {
  readonly projectId: string;
  readonly base: { readonly id: string; readonly takenAt: number };
  /** Change snapshots laid over the base, oldest first. */
  readonly changes: readonly { readonly id: string; readonly takenAt: number }[];
  /** The newest snapshot used (the base, or the last change). */
  readonly newest: { readonly id: string; readonly takenAt: number };
  readonly rootId: string | null;
  readonly pages: ReadonlyMap<string, AuditPage>;
  /** Pages a change snapshot recorded as deleted (not in `pages`), with when. */
  readonly deleted: ReadonlyMap<
    string,
    { readonly takenAt: number; readonly snapshotId: string; readonly name: string }
  >;
  /** The project's templates from the base snapshot, or null when it holds none. */
  readonly templates: ReadonlyMap<string, AuditPage> | null;
  readonly unreadable: number;
  /**
   * v3 F4a (ADR 0063): the blocks of the page documents of the pages asked for (`keepBlocksOf`: the governance root),
   * by document id; a document whose piece could not be read is absent. Every other page keeps only its scan.
   */
  readonly blocks?: ReadonlyMap<string, readonly unknown[]>;
}

export type ModelResult =
  { readonly ok: true; readonly model: AuditModel } | { readonly ok: false; readonly reason: 'no_snapshot' };

interface Working {
  entry: PageEntry;
  docs: Map<string, DocumentEntry>;
  sourceSnapshotId: string;
  sourceTakenAt: number;
}

export interface ReaderOptions {
  /** The name of the key-value property facts are read from (`PROPERTIES`). */
  readonly propertiesName: string;
  /** The tag-definition document, whose `json` code blocks are kept. */
  readonly tagSource?: { readonly pageId: string; readonly documentId: string } | null;
  /** v3 F4a (ADR 0063): pages whose page documents' blocks are kept whole (the governance root). */
  readonly keepBlocksOf?: ReadonlySet<string>;
  /** v3 F7 (ADR 0070, G7): also keep the blocks of the pages this says yes to (characters' Art pages), by name. */
  readonly keepBlocksWhere?: (page: { readonly id: string; readonly name: string }) => boolean;
  /** Concurrent store reads. */
  readonly concurrency?: number;
}

const MAX_CHANGES = 5000;

/** Runs `fn` over `items` with at most `n` in flight. */
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

/** Lays one page entry over what is known of it. */
function apply(into: Map<string, Working>, entry: PageEntry, snap: { id: string; takenAt: number }): void {
  const prev = into.get(entry.id);
  const docs = new Map(prev?.docs ?? []);
  for (const gone of entry.deletedDocuments ?? []) docs.delete(gone);
  for (const d of entry.documents ?? []) docs.set(d.id, d);
  const merged: PageEntry = {
    ...(prev?.entry ?? entry),
    // The tree fields are the entry's own; a piece it did not take is kept from before.
    id: entry.id,
    parentId: entry.parentId,
    rank: entry.rank,
    name: entry.name,
    kind: entry.kind,
    ...(entry.resource ? { resource: entry.resource } : {}),
    ...(entry.sidebar ? { sidebar: entry.sidebar } : {}),
  };
  const took = entry.resource || entry.sidebar || (entry.documents?.length ?? 0) > 0 || !prev;
  into.set(entry.id, {
    entry: merged,
    docs,
    sourceSnapshotId: took || !prev ? snap.id : prev.sourceSnapshotId,
    sourceTakenAt: took || !prev ? snap.takenAt : prev.sourceTakenAt,
  });
}

export async function buildModel(
  source: SnapshotSource,
  projectId: string,
  o: ReaderOptions,
): Promise<ModelResult> {
  const fulls = source.fulls(projectId);
  const baseRow = fulls[0];
  if (!baseRow) return { ok: false, reason: 'no_snapshot' };
  const base = await source.manifest(baseRow.id);
  if (!base) return { ok: false, reason: 'no_snapshot' };

  const working = new Map<string, Working>();
  const deleted = new Map<string, { takenAt: number; snapshotId: string; name: string }>();
  for (const p of base.pages) {
    if (p.deleted) continue;
    apply(working, p, { id: base.id, takenAt: baseRow.takenAt });
  }
  const changes = source.changesAfter(projectId, baseRow.takenAt).slice(0, MAX_CHANGES);
  for (const c of changes) {
    const m = await source.manifest(c.id);
    if (!m) continue;
    for (const p of m.pages) {
      if (p.deleted) {
        // A deleted page takes its children with it only as far as the snapshot says: each child has its own entry
        // when the delete was a cascade (E1a takes the pages the cascade removed).
        working.delete(p.id);
        deleted.set(p.id, { takenAt: c.takenAt, snapshotId: c.id, name: p.name });
        continue;
      }
      deleted.delete(p.id);
      apply(working, p, c);
    }
  }
  const newest =
    changes.length > 0 ? changes[changes.length - 1]! : { id: baseRow.id, takenAt: baseRow.takenAt };

  let unreadable = 0;
  const conc = o.concurrency ?? 8;
  const kept = new Map<string, readonly unknown[]>();
  const load = async (w: Working, keepCodeFor: (docId: string) => boolean): Promise<AuditPage> => {
    const unreadablePieces: string[] = [];
    let tags: string[] = [];
    let aliases: string[] = [];
    if (w.entry.resource) {
      const r = await source.piece(w.entry.resource.sha256);
      if (r === null) unreadablePieces.push('resource');
      else ({ tags, aliases } = extractResource(r));
    }
    let side = extractSidebar({ properties: [] }, o.propertiesName);
    let properties: AuditPage['properties'] = null;
    if (w.entry.sidebar) {
      const s = await source.piece(w.entry.sidebar.sha256);
      if (s === null) unreadablePieces.push('sidebar');
      else {
        side = extractSidebar(s, o.propertiesName);
        properties = side.properties;
      }
    }
    const refs: Ref[] = [...side.refs];
    const scans: DocumentScan[] = [];
    const documents: DocumentInfo[] = [];
    for (const d of w.docs.values()) {
      documents.push({ id: d.id, name: d.name, type: d.type });
      if (d.type !== 'page') continue;
      const piece = (await source.piece(d.sha256)) as { blocks?: unknown[] } | null;
      if (piece === null) {
        unreadablePieces.push(`document ${d.id}`);
        continue;
      }
      const { scan, refs: r } = scanDocument(d, Array.isArray(piece.blocks) ? piece.blocks : [], {
        keepCode: keepCodeFor(d.id),
      });
      scans.push(scan);
      refs.push(...r);
      if (o.keepBlocksOf?.has(w.entry.id) || o.keepBlocksWhere?.({ id: w.entry.id, name: w.entry.name }))
        kept.set(d.id, Array.isArray(piece.blocks) ? piece.blocks : []);
    }
    unreadable += unreadablePieces.length;
    const { kind: classified, displayName } = classifyName(w.entry.name);
    return {
      id: w.entry.id,
      parentId: w.entry.parentId,
      rank: w.entry.rank,
      rawName: w.entry.name,
      displayName,
      // The root is told by its id; everything else by its name's prefix (the name is the newest the snapshot holds).
      kind: w.entry.id === base.rootId ? 'root' : classified,
      tags,
      aliases,
      properties,
      facts: side.facts,
      hasProperties: side.hasProperties,
      documents,
      scans,
      refs,
      sourceSnapshotId: w.sourceSnapshotId,
      sourceTakenAt: w.sourceTakenAt,
      unreadable: unreadablePieces,
    };
  };

  const pages = new Map<string, AuditPage>();
  const list = [...working.values()];
  await pool(list, conc, async (w) => {
    const tagDoc = o.tagSource && o.tagSource.pageId === w.entry.id ? o.tagSource.documentId : null;
    pages.set(w.entry.id, await load(w, (docId) => tagDoc === docId));
  });

  let templates: Map<string, AuditPage> | null = null;
  if (base.templates) {
    templates = new Map();
    const tw = new Map<string, Working>();
    for (const t of base.templates) apply(tw, t, { id: base.id, takenAt: baseRow.takenAt });
    await pool([...tw.values()], conc, async (w) => {
      templates!.set(w.entry.id, await load(w, () => false));
    });
  }

  // A stable order for everything downstream.
  const ordered = new Map([...pages].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return {
    ok: true,
    model: {
      projectId,
      base: { id: baseRow.id, takenAt: baseRow.takenAt },
      changes,
      newest,
      rootId: base.rootId,
      pages: ordered,
      deleted,
      templates,
      unreadable,
      ...(o.keepBlocksOf || o.keepBlocksWhere ? { blocks: kept } : {}),
    },
  };
}
