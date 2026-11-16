/**
 * The set_facts planner (v2 C2a, ADR 0032): pure. From the page's sidebar as read (`listProperties`), the facts and
 * links asked for (values already converted to runs, link references already resolved), and the template's key order,
 * it decides exactly which LegendKeeper writes to make, in which order, and what the sidebar will hold afterwards.
 *
 * - A fact whose key matches an existing row (without case, spaces trimmed) changes that row (its key is kept as it
 *   is); `null` removes it; the same value writes nothing.
 * - The rows are taken in LegendKeeper's one order, by rank (sidebar.ts), whatever order the read gave them in.
 * - A new template fact goes in template order: after its nearest existing preceding template fact, else before its
 *   nearest existing following one, else above the facts that are not in the template (or at the end when there are
 *   none). LegendKeeper ranks it between the anchor and the anchor's rank-sorted neighbour, so the plan splices it in
 *   at that place in rank order too (never next to the anchor's neighbour in stored order). Several new facts with the same anchor are ordered so they end up in template order. Any other new fact
 *   goes at the bottom, in the order given.
 * - A link collection (found by title) keeps every existing item's id and rank, the order, and its filter (the filter
 *   is never sent); added pages are appended, removed ones left out. LegendKeeper has no item-level operations for
 *   collections, so a collection change is ONE `updateProperty` with the full items list.
 * - Row writes run first (changes, then additions, then removals: additions are anchored to rows that stay), then the
 *   collection writes. The expected final state comes from running the planned writes through the same sidebar model
 *   the canonical guard uses (sidebar.ts), so the plan, the guard and the verify step agree.
 */
import { normaliseContent, rowsState, stableJson } from '../jobs/sidebar-state.js';
import type { CollectionState, ItemState } from '../jobs/sidebar-state.js';
import type { OpParams } from '../jobs/types.js';
import { factKey } from './rules.js';
import { applySidebarWrite, valueText, type SidebarProperty, type SidebarRow } from './sidebar.js';

type Obj = Record<string, unknown>;

export class FactsPlanError extends Error {
  override readonly name = 'FactsPlanError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** A fact asked for: its key as given, and its value as runs (null removes it). */
export interface FactRequest {
  readonly key: string;
  readonly value: readonly Obj[] | null;
}

/** A page (or one of its documents) a link adds or removes, resolved. */
export interface LinkTarget {
  readonly resourceId: string;
  readonly documentId?: string;
  /** For the result and the proposal: the page's name, and the document's. */
  readonly name: string;
  readonly documentName?: string;
}

export interface LinkRequest {
  /** The collection's title as given. */
  readonly title: string;
  readonly add: readonly LinkTarget[];
  readonly remove: readonly LinkTarget[];
}

export interface FactsPlanInput {
  readonly resourceId: string;
  readonly sidebar: readonly SidebarProperty[];
  /** The key-value property's title (set_facts' `property`, or the project's default). */
  readonly propertyTitle: string;
  readonly facts: readonly FactRequest[];
  readonly links: readonly LinkRequest[];
  /** The template's fact keys in order, or null when the template could not be determined. */
  readonly templateKeys: readonly string[] | null;
}

export interface PlannedWrite {
  readonly op: 'createPropertyRow' | 'updatePropertyRow' | 'deletePropertyRow' | 'updateProperty';
  readonly params: OpParams;
  /** For results and the journal: `Status: changed`, `Dependencies: 2 added`. */
  readonly label: string;
  /** v3 F2 (ADR 0049): a row write's fact key (whether it is a housekeeping key, for Last Major Revision). */
  readonly factKey?: string;
  /** The property it writes. */
  readonly propertyId: string;
  /** Rows of the key-value property just before this write (row writes; for the in-step check). */
  readonly rowsBefore?: readonly SidebarRow[];
  /** The collection just before this write (collection writes; for the in-step check). */
  readonly collectionBefore?: CollectionState;
}

export interface FactChange {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly change: 'added' | 'changed' | 'removed' | 'unchanged' | 'not_present';
}

export interface LinkChange {
  readonly title: string;
  readonly propertyId: string;
  readonly kind: string;
  readonly added: readonly LinkTarget[];
  readonly removed: readonly LinkTarget[];
  readonly alreadyLinked: readonly LinkTarget[];
  readonly notLinked: readonly LinkTarget[];
  readonly before: CollectionState;
  readonly after: CollectionState;
  /** The collection has a filter (kept as it is; it may add pages the items do not list). */
  readonly filtered: boolean;
}

export interface FactsPlan {
  readonly property: { readonly id: string; readonly title: string } | null;
  /** Every fact asked for, and what happens to it. */
  readonly facts: readonly FactChange[];
  /** The key-value property's rows before and after (for the before/after table and the verify step). */
  readonly rowsBefore: readonly SidebarRow[];
  readonly rowsAfter: readonly SidebarRow[];
  readonly links: readonly LinkChange[];
  /** The writes, in order: row writes, then collection writes. */
  readonly writes: readonly PlannedWrite[];
  readonly sidebarAfter: readonly SidebarProperty[];
  readonly notes: readonly string[];
  readonly empty: boolean;
}

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase('en-GB') === b.trim().toLocaleLowerCase('en-GB');

/** Finds the one property with this title among `kinds`, or refuses (missing, or several). */
function findProperty(
  sidebar: readonly SidebarProperty[],
  title: string,
  kinds: readonly string[],
  what: string,
): SidebarProperty {
  const all = sidebar.filter((p) => kinds.includes(p.kind));
  const hits = all.filter((p) => same(p.title, title));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    throw new FactsPlanError(
      what === 'facts' ? 'FACTS_PROPERTY_NOT_FOUND' : 'LINK_COLLECTION_NOT_FOUND',
      what === 'facts'
        ? `The page has no key-value property titled “${title}”. Its key-value properties: ${all.map((p) => `“${p.title}”`).join(', ') || 'none'}.`
        : `The page has no link collection titled “${title}”. Its link collections: ${all.map((p) => `“${p.title}”`).join(', ') || 'none'}.`,
      { title, available: all.map((p) => p.title) },
    );
  }
  throw new FactsPlanError(
    what === 'facts' ? 'FACTS_PROPERTY_AMBIGUOUS' : 'LINK_COLLECTION_AMBIGUOUS',
    `The page has ${hits.length} ${what === 'facts' ? 'key-value properties' : 'link collections'} titled “${title}”; the bridge will not guess which. Change it in LegendKeeper, or tell the owner.`,
    { title, ids: hits.map((p) => p.id) },
  );
}

const sameRuns = (a: readonly Obj[], b: readonly Obj[]) =>
  stableJson(normaliseContent(a)) === stableJson(normaliseContent(b));

const text = (content: readonly Obj[] | null): string | null =>
  content === null ? null : valueText(content);

/** Plans the facts and links (see the module comment). Throws `FactsPlanError` for anything it will not guess. */
export function planFacts(input: FactsPlanInput): FactsPlan {
  const notes: string[] = [];
  const writes: PlannedWrite[] = [];
  let sidebar: SidebarProperty[] = [...input.sidebar];
  const step = (w: Omit<PlannedWrite, 'rowsBefore' | 'collectionBefore'>, extra: Partial<PlannedWrite>) => {
    const after = applySidebarWrite(sidebar, w.op, w.params);
    if (!after) throw new FactsPlanError('BRIDGE_ERROR', `the planned ${w.op} has no target`);
    writes.push({ ...w, ...extra });
    sidebar = after;
  };

  // ---------------------------------------------------------------------------------------------- facts
  const facts: FactChange[] = [];
  let property: SidebarProperty | null = null;
  let rowsBefore: SidebarRow[] = [];
  if (input.facts.length > 0) {
    const seen = new Map<string, string>();
    for (const f of input.facts) {
      const k = factKey(f.key);
      if (k === '') throw new FactsPlanError('INVALID_FACTS', 'A fact key cannot be empty.');
      const other = seen.get(k);
      if (other !== undefined)
        throw new FactsPlanError(
          'INVALID_FACTS',
          `“${other}” and “${f.key}” are the same fact; give it once.`,
          {
            keys: [other, f.key],
          },
        );
      seen.set(k, f.key);
    }
    property = findProperty(input.sidebar, input.propertyTitle, ['keyValue'], 'facts');
    rowsBefore = [...(property.rows ?? [])];
    const byKey = new Map<string, SidebarRow[]>();
    for (const r of rowsBefore) byKey.set(factKey(r.key), [...(byKey.get(factKey(r.key)) ?? []), r]);
    const pid = property.id;
    const path = { resourceId: input.resourceId, propertyId: pid };
    const rowsNow = () => (sidebar.find((p) => p.id === pid)?.rows ?? []) as SidebarRow[];
    const updates: FactRequest[] = [];
    const removals: { f: FactRequest; row: SidebarRow }[] = [];
    const additions: FactRequest[] = [];
    for (const f of input.facts) {
      const rows = byKey.get(factKey(f.key)) ?? [];
      if (rows.length > 1) {
        throw new FactsPlanError(
          'FACT_KEY_DUPLICATED',
          `“${input.propertyTitle}” has ${rows.length} rows keyed “${rows[0]!.key}”; the bridge will not guess which to change. Fix it in LegendKeeper, or tell the owner.`,
          { key: f.key, rowIds: rows.map((r) => r.id) },
        );
      }
      const row = rows[0];
      if (!row) {
        if (f.value === null) facts.push({ key: f.key, before: null, after: null, change: 'not_present' });
        else additions.push(f);
        continue;
      }
      if (f.value === null) {
        removals.push({ f, row });
        facts.push({ key: row.key, before: text(row.content), after: null, change: 'removed' });
      } else if (sameRuns(row.content, f.value)) {
        facts.push({
          key: row.key,
          before: text(row.content),
          after: text(row.content),
          change: 'unchanged',
        });
      } else {
        updates.push(f);
        facts.push({ key: row.key, before: text(row.content), after: text(f.value), change: 'changed' });
      }
    }
    // 1. Changes.
    for (const f of updates) {
      const row = byKey.get(factKey(f.key))![0]!;
      const before = rowsNow();
      step(
        {
          op: 'updatePropertyRow',
          params: {
            path: { ...path, rowId: row.id! },
            body: f.value!.length > 0 ? { content: f.value } : { content: null },
          },
          label: `${row.key}: changed`,
          factKey: row.key,
          propertyId: pid,
        },
        { rowsBefore: before },
      );
    }
    // 2. Additions: template facts in template order, anchored to rows that stay; the others at the bottom.
    const removed = new Set(removals.map((r) => r.row.id));
    const survivors = () => rowsNow().filter((r) => !removed.has(r.id));
    const template = input.templateKeys?.map(factKey) ?? null;
    if (additions.length > 0 && template === null) {
      notes.push(
        'The page’s template could not be determined (no recorded template, and its Reference Type maps to none in the type registry), so new facts were put at the bottom.',
      );
    }
    const tIdx = (key: string) => (template ? template.indexOf(factKey(key)) : -1);
    const inTemplate = additions.filter((f) => tIdx(f.key) >= 0).sort((a, b) => tIdx(a.key) - tIdx(b.key));
    const others = additions.filter((f) => tIdx(f.key) < 0);
    type Anchor = { kind: 'after' | 'before'; id: string } | { kind: 'end' };
    const anchorOf = (f: FactRequest): Anchor => {
      const t = tIdx(f.key);
      const rows = survivors().filter((r) => r.id !== null);
      let prev: SidebarRow | undefined;
      let prevT = -1;
      let next: SidebarRow | undefined;
      let nextT = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const rt = tIdx(r.key);
        if (rt < 0) continue;
        if (rt < t && rt > prevT) [prev, prevT] = [r, rt];
        if (rt > t && rt < nextT) [next, nextT] = [r, rt];
      }
      if (prev) return { kind: 'after', id: prev.id! };
      if (next) return { kind: 'before', id: next.id! };
      const firstExtra = rows.find((r) => tIdx(r.key) < 0);
      return firstExtra ? { kind: 'before', id: firstExtra.id! } : { kind: 'end' };
    };
    // Anchors are taken from the rows as they are before any addition, so every new fact lands in its gap.
    const groups = new Map<string, { anchor: Anchor; facts: FactRequest[] }>();
    for (const f of inTemplate) {
      const a = anchorOf(f);
      const key = a.kind === 'end' ? 'end' : `${a.kind}:${a.id}`;
      const g = groups.get(key) ?? { anchor: a, facts: [] };
      g.facts.push(f);
      groups.set(key, g);
    }
    const create = (f: FactRequest, anchor: Anchor) => {
      const before = rowsNow();
      step(
        {
          op: 'createPropertyRow',
          params: {
            path,
            body: {
              key: f.key.trim(),
              ...(f.value!.length > 0 ? { content: f.value } : {}),
              ...(anchor.kind === 'after'
                ? { after: anchor.id }
                : anchor.kind === 'before'
                  ? { before: anchor.id }
                  : {}),
            },
          },
          label: `${f.key.trim()}: added`,
          factKey: f.key.trim(),
          propertyId: pid,
        },
        { rowsBefore: before },
      );
      facts.push({ key: f.key.trim(), before: null, after: text(f.value), change: 'added' });
    };
    for (const g of groups.values()) {
      // "after P": each new row goes straight after P, so insert in reverse template order; "before N" or the end: in order.
      const list = g.anchor.kind === 'after' ? [...g.facts].reverse() : g.facts;
      for (const f of list) create(f, g.anchor);
    }
    for (const f of others) create(f, { kind: 'end' });
    // 3. Removals.
    for (const { row } of removals) {
      const before = rowsNow();
      step(
        {
          op: 'deletePropertyRow',
          params: { path: { ...path, rowId: row.id! } },
          label: `${row.key}: removed`,
          factKey: row.key,
          propertyId: pid,
        },
        { rowsBefore: before },
      );
    }
  }

  // ---------------------------------------------------------------------------------------------- links
  const links: LinkChange[] = [];
  const seenTitles = new Map<string, string>();
  for (const l of input.links) {
    const k = l.title.trim().toLocaleLowerCase('en-GB');
    if (seenTitles.has(k))
      throw new FactsPlanError('INVALID_LINKS', `The collection “${l.title}” is named twice; give it once.`);
    seenTitles.set(k, l.title);
    const coll = findProperty(input.sidebar, l.title, ['resourceCollection', 'resourceLink'], 'links');
    const raw = Array.isArray(coll.raw.items) ? (coll.raw.items as Obj[]) : [];
    const items: ItemState[] = raw.map((i) => ({
      id: typeof i.id === 'string' && i.id !== '' ? i.id : null,
      resourceId: typeof i.resourceId === 'string' ? i.resourceId : '',
      documentId: typeof i.documentId === 'string' && i.documentId !== '' ? i.documentId : null,
    }));
    const before: CollectionState = { items, filter: coll.raw.filter ?? null };
    const matches = (i: ItemState, t: LinkTarget, exactDoc: boolean) =>
      i.resourceId === t.resourceId &&
      (exactDoc
        ? i.documentId === (t.documentId ?? null)
        : t.documentId === undefined || i.documentId === t.documentId);
    const key = (t: LinkTarget) => `${t.resourceId}/${t.documentId ?? ''}`;
    for (const a of l.add)
      if (l.remove.some((r) => key(r) === key(a)))
        throw new FactsPlanError(
          'INVALID_LINKS',
          `“${a.name}${a.documentName ? ` / ${a.documentName}` : ''}” is both added to and removed from “${coll.title}”.`,
        );
    const removedItems = new Set<number>();
    const removed: LinkTarget[] = [];
    const notLinked: LinkTarget[] = [];
    for (const r of l.remove) {
      let hit = false;
      items.forEach((i, n) => {
        if (matches(i, r, false)) {
          removedItems.add(n);
          hit = true;
        }
      });
      (hit ? removed : notLinked).push(r);
    }
    const kept = items.filter((_, n) => !removedItems.has(n));
    const added: LinkTarget[] = [];
    const alreadyLinked: LinkTarget[] = [];
    const addedKeys = new Set<string>();
    for (const a of l.add) {
      if (addedKeys.has(key(a))) continue;
      addedKeys.add(key(a));
      if (kept.some((i) => matches(i, a, true))) alreadyLinked.push(a);
      else added.push(a);
    }
    const after: CollectionState = {
      items: [
        ...kept,
        ...added.map((a) => ({ id: null, resourceId: a.resourceId, documentId: a.documentId ?? null })),
      ],
      filter: before.filter,
    };
    if (after.items.length > 256) {
      throw new FactsPlanError(
        'INVALID_LINKS',
        `“${coll.title}” would hold ${after.items.length} items; LegendKeeper allows 256.`,
      );
    }
    links.push({
      title: coll.title,
      propertyId: coll.id,
      kind: coll.kind,
      added,
      removed,
      alreadyLinked,
      notLinked,
      before,
      after,
      filtered: before.filter !== null && before.filter !== undefined,
    });
    if (added.length === 0 && removedItems.size === 0) continue;
    // The full items list: every kept item exactly as LegendKeeper gave it (id, rank, page, document), then the new ones.
    const keptRaw = raw
      .filter((_, n) => !removedItems.has(n))
      .map((i) => {
        const o: Obj = {};
        for (const k of ['id', 'rank', 'resourceId', 'documentId'])
          if (typeof i[k] === 'string' && i[k] !== '') o[k] = i[k];
        return o;
      });
    const newRaw = added.map((a) => ({
      resourceId: a.resourceId,
      ...(a.documentId ? { documentId: a.documentId } : {}),
    }));
    const parts = [
      added.length ? `${added.length} added` : '',
      removed.length ? `${removedItems.size} removed` : '',
    ]
      .filter(Boolean)
      .join(', ');
    writes.push({
      op: 'updateProperty',
      params: {
        path: { resourceId: input.resourceId, propertyId: coll.id },
        body: { items: [...keptRaw, ...newRaw] },
      },
      label: `${coll.title}: ${parts}`,
      propertyId: coll.id,
      collectionBefore: before,
    });
    sidebar = sidebar.map((p) =>
      p.id === coll.id ? { ...p, raw: { ...p.raw, items: [...keptRaw, ...newRaw] } } : p,
    );
  }

  const rowsAfter = property
    ? [...((sidebar.find((p) => p.id === property.id)?.rows ?? []) as SidebarRow[])]
    : [];
  return {
    property: property ? { id: property.id, title: property.title } : null,
    facts,
    rowsBefore,
    rowsAfter,
    links,
    writes,
    sidebarAfter: sidebar,
    notes,
    empty: writes.length === 0,
  };
}

/**
 * Rows as the check and verify steps compare them (`RowState`), in rank order: each existing row with its id and rank,
 * a planned new row with neither (it keeps the place the plan gave it, next to its anchor).
 */
export function rowStates(rows: readonly SidebarRow[]) {
  return rowsState(rows.map((r) => ({ id: r.id, rank: r.rank ?? null, key: r.key, content: r.content })));
}
