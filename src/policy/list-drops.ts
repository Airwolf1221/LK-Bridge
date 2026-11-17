/**
 * ADR 0057 decision 4 (R2-52): whether a whole-list write sent through a low-level tool drops an entry LegendKeeper holds
 * now. `replaceDocumentBlocks` deletes every block it does not send; `updateProperty` and `updateBlockProperty` replace a
 * property's `items`, `rows` or `children`; `replaceBlock` and `updateBlock` a block's. The rails (src/policy/rails.ts)
 * make such a write a delete for the `deletes` rail when it drops an entry; a write that only adds, reorders or edits
 * entries stays an edit.
 *
 * An entry is kept when the write sends an entry with its id (at any depth: a block moved into another block is kept),
 * or, for a link collection item without an id, an item naming the same page and document. Anything else that is held
 * now and not sent is dropped. An entry held now that has no id, and no page to match by, counts as dropped unless the
 * write sends at least as many such entries in the same list.
 */
import type { RailRequestItem } from '../jobs/policy.js';
import type { OpParams } from '../jobs/types.js';
import { listsSent } from './rails.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const LIST_KEYS = ['blocks', 'children', 'rows', 'items'] as const;

/** Every id of an object nested in the lists of `v` (blocks, children, rows, items), at any depth. */
function idsIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) idsIn(x, out);
    return out;
  }
  if (!isObj(v)) return out;
  if (typeof v.id === 'string' && v.id !== '') out.add(v.id);
  for (const k of LIST_KEYS) if (Array.isArray(v[k])) idsIn(v[k], out);
  return out;
}

/** A link item's page key (`resourceId` and `documentId`), or null. */
const linkKey = (x: Obj): string | null =>
  typeof x.resourceId === 'string'
    ? `${x.resourceId}\u0000${typeof x.documentId === 'string' ? x.documentId : ''}`
    : null;

function linkKeysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) linkKeysIn(x, out);
    return out;
  }
  if (!isObj(v)) return out;
  const k = linkKey(v);
  if (k) out.add(k);
  for (const key of LIST_KEYS) if (Array.isArray(v[key])) linkKeysIn(v[key], out);
  return out;
}

/** Entries held now in `current` (recursively, through the list keys) and absent from `sent`. */
function dropped(current: unknown, sent: unknown, ids: Set<string>, links: Set<string>): boolean {
  if (!Array.isArray(current)) return false;
  const sentList = Array.isArray(sent) ? sent : [];
  let anonymousHeld = 0;
  for (const x of current) {
    if (!isObj(x)) {
      anonymousHeld++;
      continue;
    }
    const id = typeof x.id === 'string' && x.id !== '' ? x.id : null;
    const link = linkKey(x);
    if (id !== null && ids.has(id)) {
      // Kept: its own lists are compared with the entry sent under the same id, wherever it is.
      const twin = findById(sent, id) ?? findById(sentList, id);
      for (const k of LIST_KEYS) if (Array.isArray(x[k]) && dropped(x[k], twin?.[k], ids, links)) return true;
      continue;
    }
    if (link !== null && links.has(link)) continue;
    if (id !== null) return true;
    anonymousHeld++;
  }
  const anonymousSent = sentList.filter(
    (x) => !isObj(x) || ((typeof x.id !== 'string' || x.id === '') && linkKey(x) === null),
  ).length;
  return anonymousHeld > anonymousSent;
}

function findById(v: unknown, id: string): Obj | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findById(x, id);
      if (f) return f;
    }
    return undefined;
  }
  if (!isObj(v)) return undefined;
  if (v.id === id) return v;
  for (const k of LIST_KEYS) {
    const f = Array.isArray(v[k]) ? findById(v[k], id) : undefined;
    if (f) return f;
  }
  return undefined;
}

/**
 * Whether writing `lists` of `body` over `current` (the property, block, or document's blocks as LegendKeeper returns
 * them) drops an entry held now. Pure.
 */
export function dropsEntries(current: unknown, body: unknown, lists: readonly string[]): boolean {
  const cur = isObj(current) ? current : {};
  const b = isObj(body) ? body : {};
  for (const k of lists) {
    const sent = b[k];
    const ids = idsIn(sent);
    const links = linkKeysIn(sent);
    if (dropped(cur[k], sent, ids, links)) return true;
  }
  return false;
}

/** The read that gives what a whole-list write replaces, or null for an operation that is not one. */
export function currentRead(
  item: Pick<RailRequestItem, 'opId' | 'params'>,
): { readonly opId: string; readonly params: OpParams } | null {
  const p = item.params.path ?? {};
  const { resourceId, documentId, blockId, propertyId } = p;
  switch (item.opId) {
    case 'replaceDocumentBlocks':
      return resourceId && documentId
        ? { opId: 'getDocumentBlocks', params: { path: { resourceId, documentId } } }
        : null;
    case 'updateProperty':
      return resourceId && propertyId
        ? { opId: 'getProperty', params: { path: { resourceId, propertyId } } }
        : null;
    case 'updateBlockProperty':
      return resourceId && documentId && blockId && propertyId
        ? { opId: 'getBlockProperty', params: { path: { resourceId, documentId, blockId, propertyId } } }
        : null;
    case 'replaceBlock':
    case 'updateBlock':
      return resourceId && documentId && blockId
        ? { opId: 'getBlock', params: { path: { resourceId, documentId, blockId } } }
        : null;
    default:
      return null;
  }
}

/**
 * The live check the policy gate asks (`RailLookups.drops`): reads what the write replaces and compares. Null when it
 * cannot be read (the rail then fails closed).
 */
export function listDropsReader(
  read: (projectId: string, opId: string, params: OpParams) => Promise<unknown>,
): (projectId: string, item: RailRequestItem) => Promise<boolean | null> {
  return async (projectId, item) => {
    const lists = listsSent(item.opId, item.params.body);
    if (lists.length === 0) return false;
    const r = currentRead(item);
    if (!r) return null;
    let current: unknown;
    try {
      current = await read(projectId, r.opId, r.params);
    } catch {
      return null;
    }
    return dropsEntries(current, item.params.body, lists);
  };
}
