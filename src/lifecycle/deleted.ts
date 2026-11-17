/**
 * What the bridge recorded of a deleted page (v2 E4, RV2-1): its name, parent and tags, from the delete's journal entry.
 * `delete_resource` keeps the page and every page deleted with it (`subtree`); a low-level delete keeps what the engine
 * read before it (the resource, when it read one). The lifecycle guard judges a restore by it: the page lands back under
 * that parent, and its own state (prefix, status tag) says which lifecycle area it belongs in.
 *
 * CR-2026-11-R2 (C1): `restoreSetReader`, the pages a restore may bring back WITH the page (LegendKeeper restores "every
 * descendant deleted by the same operation"), for both guards.
 */
import type { JobEngine } from '../jobs/index.js';
import type { SnapshotService } from '../snapshots/service.js';
import type { TreeNode } from '../tree/index.js';
import type { DeletedPageRecord } from './guard.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : undefined;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** CR-2026-11-R2 (C1): a page a restore may bring back with the page restored (deleted with it, as far as is known). */
export interface RestoredWith {
  readonly id: string;
  readonly name: string | null;
  /** Its parent when it was deleted (as the record that names it says). */
  readonly parentId: string | null;
  readonly tags?: readonly string[];
  /** Its sidebar rows as the newest snapshot holding them took them; null when no snapshot holds them. */
  readonly rows: readonly { readonly key: string; readonly content: readonly Obj[] }[] | null;
  /** The bridge made the delete that took it (its journal, or the change snapshot after that delete, lists it). */
  readonly recorded: boolean;
  /** The repository tree still holds it: it may not be deleted at all (the guards read it live). */
  readonly inTree: boolean;
}

export interface RestoreSet {
  /**
   * False when nothing tells what was under the page when it was deleted (no journal of the bridge's delete, no snapshot
   * of the page's subtree, the tree has dropped it), or when it held more pages than the guards read: the guards then
   * fail closed (a canonical proposal).
   */
  readonly known: boolean;
  /** The pages under it that may come back with it (not the page itself), at most `RESTORE_SET_LIMIT`. */
  readonly pages: readonly RestoredWith[];
}

/** At most this many pages under a restored page are judged; more count as unknown. */
export const RESTORE_SET_LIMIT = 100;

export interface RestoreSetDeps {
  readonly engine: Pick<JobEngine, 'queries'>;
  /** The snapshot service (a getter: the runtime makes it after the guards). */
  readonly snapshots: () => Pick<SnapshotService, 'index' | 'store' | 'manifest'> | undefined;
  /** A node of the repository tree, or null. */
  readonly node: (projectId: string, id: string) => TreeNode | null;
  /** The pages under a page in the repository tree (not the page itself), or null when it cannot answer. */
  readonly subtree: (projectId: string, id: string) => readonly TreeNode[] | null;
}

/** Every entry of `list` whose parent chain within the list runs through `root` (not `root` itself). */
function under<T extends { readonly id: string; readonly parentId: string | null }>(
  list: readonly T[],
  root: string,
): T[] {
  const kids = new Map<string, T[]>();
  for (const x of list)
    if (x.parentId !== null && x.id !== root) kids.set(x.parentId, [...(kids.get(x.parentId) ?? []), x]);
  const out: T[] = [];
  const seen = new Set([root]);
  for (let level = [root]; level.length > 0 && out.length <= RESTORE_SET_LIMIT;) {
    const next: string[] = [];
    for (const p of level)
      for (const k of kids.get(p) ?? [])
        if (!seen.has(k.id)) {
          seen.add(k.id);
          out.push(k);
          next.push(k.id);
        }
    level = next;
  }
  return out;
}

/** A page's sidebar rows and tags as the newest snapshot holding them took them (null when none holds them). */
async function lastState(
  svc: Pick<SnapshotService, 'index' | 'store'>,
  projectId: string,
  pageId: string,
  needTags: boolean,
): Promise<{ rows: RestoredWith['rows']; tags?: string[] }> {
  const newest = (piece: string) =>
    svc.index.pageHistory(projectId, pageId, { piece, limit: 50 }).find((r) => r.piece === piece && r.sha256);
  const sbRow = newest('sidebar');
  const sb = sbRow?.sha256 ? await svc.store.getJson<Obj>(sbRow.sha256) : null;
  const rows = sb
    ? (Array.isArray(sb.properties) ? sb.properties.filter(isObj) : [])
        .filter((p) => p.kind === 'keyValue')
        .flatMap((p) =>
          (Array.isArray(p.rows) ? p.rows.filter(isObj) : []).map((r) => ({
            key: typeof r.key === 'string' ? r.key : '',
            content: Array.isArray(r.content)
              ? r.content.filter(isObj)
              : typeof r.text === 'string'
                ? [{ text: r.text }]
                : [],
          })),
        )
    : null;
  if (!needTags) return { rows };
  const resRow = newest('resource');
  const res = resRow?.sha256 ? await svc.store.getJson<Obj>(resRow.sha256) : null;
  const tags = strings(res?.tags);
  return { rows, ...(tags ? { tags } : {}) };
}

/**
 * CR-2026-11-R2 (C1): the pages a restore of `id` may bring back with it. LegendKeeper lists no deleted page, so they come
 * from the bridge's own records: the journal of a delete the bridge made (`delete_resource` keeps the subtree; a low-level
 * delete without cascade took nothing with it), the newest snapshots holding the page (a full snapshot holds the whole
 * tree as it was, so the pages under the page when it was deleted in the app since; the change snapshot after a delete
 * the bridge made lists every page it took), and the repository tree while it has not seen the delete. Each page's facts
 * are its newest snapshot's. Read again on each call after a few seconds (a check at entry and one inside the lock see
 * their own), so the two guards' checks of one request share one reading.
 */
export function restoreSetReader(d: RestoreSetDeps): (projectId: string, id: string) => Promise<RestoreSet> {
  const recent = new Map<string, { at: number; set: Promise<RestoreSet> }>();
  return (projectId, id) => {
    const key = `${projectId}\u0000${id}`;
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > 5_000) recent.delete(k);
    const had = recent.get(key);
    if (had) return had.set;
    const set = readRestoreSet(d, projectId, id);
    recent.set(key, { at: now, set });
    set.catch(() => recent.delete(key));
    return set;
  };
}

async function readRestoreSet(d: RestoreSetDeps, projectId: string, id: string): Promise<RestoreSet> {
  const found = new Map<
    string,
    { name: string | null; parentId: string | null; tags?: string[]; recorded: boolean }
  >();
  let known = false;
  const add = (
    x: { id: string; name: string | null; parentId: string | null; tags?: string[] },
    recorded: boolean,
  ) => {
    const had = found.get(x.id);
    found.set(x.id, {
      name: had?.name ?? x.name,
      parentId: had?.parentId ?? x.parentId,
      ...((had?.tags ?? x.tags) ? { tags: had?.tags ?? x.tags } : {}),
      recorded: (had?.recorded ?? false) || recorded,
    });
  };
  // The bridge's own delete of it (the newest journal entry that names it), unless a snapshot saw the page alive after
  // that delete (it was restored since: a later delete, in the app, is not the bridge's).
  const svc = d.snapshots();
  const aliveAt =
    svc?.index
      .pageHistory(projectId, id, { limit: 50 })
      .find((r) => r.piece !== 'deleted' && r.piece !== 'document-deleted')?.takenAt ?? null;
  try {
    for (const e of d.engine.queries.journalLookup(projectId, {
      opId: 'deleteResource',
      limit: 500,
      includePreImage: true,
    })) {
      const pre = isObj(e.preImage) ? e.preImage : undefined;
      const sub = (Array.isArray(pre?.subtree) ? pre.subtree.filter(isObj) : [])
        .filter((x) => typeof x.id === 'string')
        .map((x) => {
          const tags = strings(x.tags);
          return {
            id: x.id as string,
            name: strOrNull(x.name),
            parentId: strOrNull(x.parentId),
            ...(tags ? { tags } : {}),
          };
        });
      const listed = sub.some((x) => x.id === id);
      if (!listed && e.targetId !== id) continue;
      if (aliveAt !== null && aliveAt > e.at) break;
      if (listed) {
        known = true;
        for (const x of under(sub, id)) add(x, true);
      } else {
        const query = isObj(e.params) && isObj(e.params.query) ? e.params.query : undefined;
        // Without cascade LegendKeeper deletes a page only when nothing is under it: nothing came with it.
        if (query?.cascade !== true && query?.cascade !== 'true') known = true;
      }
      break;
    }
  } catch {
    /* no journal to read: the snapshots and the tree say */
  }
  // The newest snapshots holding it, until a full one or the change snapshot of the bridge's delete of it.
  if (svc) {
    const seen = new Set<string>();
    for (const r of svc.index.pageHistory(projectId, id, { limit: 500 })) {
      if (seen.has(r.snapshotId)) continue;
      if (seen.size >= 10) break;
      seen.add(r.snapshotId);
      const m = await svc.manifest(r.snapshotId).catch(() => null);
      const self = m?.pages.find((p) => p.id === id);
      if (!m || !self) continue;
      for (const p of under(m.pages, id))
        add({ id: p.id, name: p.name, parentId: p.parentId }, p.deleted === true);
      if (m.kind === 'full' || self.deleted === true) {
        known = true;
        break;
      }
    }
  }
  // The tree, while it has not seen the delete (it still holds the page).
  if (d.node(projectId, id)) {
    const s = d.subtree(projectId, id);
    if (s) {
      known = true;
      for (const n of s)
        if (n.id !== id) add({ id: n.id, name: n.rawName, parentId: n.parentId, tags: [...n.tags] }, false);
    }
  }
  const pages: RestoredWith[] = [];
  for (const [pid, x] of [...found].slice(0, RESTORE_SET_LIMIT)) {
    const last = svc ? await lastState(svc, projectId, pid, x.tags === undefined).catch(() => null) : null;
    const tags = x.tags ?? last?.tags;
    pages.push({
      id: pid,
      name: x.name,
      parentId: x.parentId,
      ...(tags ? { tags } : {}),
      rows: last?.rows ?? null,
      recorded: x.recorded,
      inTree: d.node(projectId, pid) !== null,
    });
  }
  return { known: known && found.size <= RESTORE_SET_LIMIT, pages };
}

export function deletedPageRecord(
  engine: Pick<JobEngine, 'queries'>,
  projectId: string,
  id: string,
): DeletedPageRecord | null {
  let entries: readonly { targetId: string | null; preImage?: unknown }[];
  try {
    entries = engine.queries.journalLookup(projectId, {
      opId: 'deleteResource',
      limit: 500,
      includePreImage: true,
    });
  } catch {
    return null;
  }
  for (const e of entries) {
    const pre = isObj(e.preImage) ? e.preImage : undefined;
    const sub = Array.isArray(pre?.subtree) ? (pre.subtree as unknown[]) : [];
    const inSub = sub.find((x) => isObj(x) && x.id === id) as Obj | undefined;
    if (inSub && typeof inSub.name === 'string') {
      const tags = strings(inSub.tags);
      return {
        name: inSub.name,
        parentId: typeof inSub.parentId === 'string' ? inSub.parentId : null,
        ...(tags ? { tags } : {}),
      };
    }
    if (e.targetId !== id) continue;
    const r = isObj(pre?.resource)
      ? pre.resource
      : isObj(pre) && typeof pre.name === 'string'
        ? pre
        : undefined;
    if (r && typeof r.name === 'string') {
      const tags = strings(r.tags);
      return {
        name: r.name,
        parentId: typeof r.parentId === 'string' ? r.parentId : null,
        ...(tags ? { tags } : {}),
      };
    }
    return null;
  }
  return null;
}
