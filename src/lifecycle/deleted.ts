/**
 * What the bridge recorded of a deleted page (v2 E4, RV2-1): its name, parent and tags, from the delete's journal entry.
 * `delete_resource` keeps the page and every page deleted with it (`subtree`); a low-level delete keeps what the engine
 * read before it (the resource, when it read one). The lifecycle guard judges a restore by it: the page lands back under
 * that parent, and its own state (prefix, status tag) says which lifecycle area it belongs in.
 */
import type { JobEngine } from '../jobs/index.js';
import type { DeletedPageRecord } from './guard.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : undefined;

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
