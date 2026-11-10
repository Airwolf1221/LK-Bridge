/**
 * A page's sidebar as the facts code sees it (v2 C2a): the properties LegendKeeper returns (`listProperties`, or the
 * `properties` of `getResource`), and what each sidebar write would do to them. The canonical guard simulates a write
 * on the sidebar as it is now, then compares the facts before and after; the set_facts planner builds on the same model.
 */
import { normaliseContent } from '../jobs/sidebar-state.js';
import type { OpParams } from '../jobs/types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export interface SidebarRow {
  readonly id: string | null;
  readonly key: string;
  /** The value as runs (LegendKeeper's `content`), as sent or read. */
  readonly content: readonly Obj[];
  readonly rank?: string;
}

export interface SidebarProperty {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly rows?: readonly SidebarRow[];
  readonly raw: Obj;
}

export type Sidebar = readonly SidebarProperty[];

/** The sidebar from a `listProperties` answer (`{ data }`), a `getResource` answer (`{ properties }`) or a list. */
export function sidebarFrom(body: unknown): SidebarProperty[] {
  const list = Array.isArray(body)
    ? body
    : isObj(body) && Array.isArray(body.data)
      ? body.data
      : isObj(body) && Array.isArray(body.properties)
        ? body.properties
        : [];
  return (list as unknown[]).filter(isObj).map(propertyFrom);
}

export function propertyFrom(p: Obj): SidebarProperty {
  const kind = str(p.kind) ?? 'unknown';
  return {
    id: str(p.id) ?? '',
    kind,
    title: typeof p.title === 'string' ? p.title : '',
    ...(kind === 'keyValue' ? { rows: rowsFrom(p.rows) } : {}),
    raw: p,
  };
}

export function rowsFrom(rows: unknown): SidebarRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).filter(isObj).map((r) => ({
    id: str(r.id) ?? null,
    key: typeof r.key === 'string' ? r.key : '',
    content: Array.isArray(r.content)
      ? (r.content as unknown[]).filter(isObj)
      : typeof r.text === 'string' && r.text !== ''
        ? [{ text: r.text }]
        : [],
    ...(typeof r.rank === 'string' ? { rank: r.rank } : {}),
  }));
}

/** A value's plain text: text runs, a mention's label (or its page id), a line break as a new line. */
export function valueText(content: readonly Obj[]): string {
  return content
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      if (r.break === true) return '\n';
      if (isObj(r.mention))
        return str(r.mention.text) ?? str(r.mention.name) ?? str(r.mention.resourceId) ?? '';
      return '';
    })
    .join('')
    .trim();
}

/**
 * A value's identity for "did it change?": its normalised text and the pages (and documents) it mentions. Marks do
 * not count (bold or not, the value is the same).
 */
export function valueSignature(content: readonly Obj[]): string {
  const runs = normaliseContent(content);
  const mentions = runs
    .filter((r) => isObj(r.mention))
    .map((r) => {
      const m = r.mention as Obj;
      return `${str(m.resourceId) ?? ''}/${str(m.documentId) ?? ''}`;
    });
  return JSON.stringify([valueText(runs).replace(/\s+/g, ' '), mentions]);
}

/** Every key-value row of the sidebar (the facts), in order. */
export function factRows(sidebar: Sidebar): SidebarRow[] {
  return sidebar.flatMap((p) => (p.kind === 'keyValue' ? [...(p.rows ?? [])] : []));
}

/** The operations that can write a page's sidebar facts (v2 C2a: each is guarded). */
export const SIDEBAR_WRITE_OPS: ReadonlySet<string> = new Set([
  'createProperty',
  'updateProperty',
  'deleteProperty',
  'createPropertyRow',
  'updatePropertyRow',
  'deletePropertyRow',
]);

/** A row's value from a create or patch body: `content` wins over `text` (`null` content clears it). */
function bodyContent(body: Obj, current: readonly Obj[]): readonly Obj[] {
  if ('content' in body) return Array.isArray(body.content) ? (body.content as unknown[]).filter(isObj) : [];
  if (typeof body.text === 'string') return body.text === '' ? [] : [{ text: body.text }];
  return current;
}

/**
 * The sidebar after one sidebar write, or `null` when the write's target is not in the sidebar (LegendKeeper would
 * refuse it with 404, so nothing changes). Placement (`before` / `after`) is followed; a new row or property has id null.
 */
export function applySidebarWrite(
  sidebar: Sidebar,
  opId: string,
  params: OpParams,
): SidebarProperty[] | null {
  const body = isObj(params.body) ? params.body : {};
  const pid = params.path?.propertyId;
  const rid = params.path?.rowId;
  const props = [...sidebar];
  const at = props.findIndex((p) => p.id === pid);
  const prop = at >= 0 ? props[at]! : undefined;
  const withRows = (rows: SidebarRow[]): SidebarProperty => ({ ...prop!, rows });
  switch (opId) {
    case 'createProperty': {
      const created = propertyFrom({ ...body, id: str(body.id) ?? '' });
      const idx = typeof body.after === 'string' ? props.findIndex((p) => p.id === body.after) + 1 : -1;
      const before = typeof body.before === 'string' ? props.findIndex((p) => p.id === body.before) : -1;
      if (idx > 0) props.splice(idx, 0, created);
      else if (before >= 0) props.splice(before, 0, created);
      else props.push(created);
      return props;
    }
    case 'updateProperty': {
      if (!prop) return null;
      const next: SidebarProperty = {
        ...prop,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(Array.isArray(body.rows) ? { rows: rowsFrom(body.rows) } : {}),
      };
      props[at] = next;
      return props;
    }
    case 'deleteProperty':
      if (!prop) return null;
      props.splice(at, 1);
      return props;
    case 'createPropertyRow': {
      if (!prop) return null;
      const rows = [...(prop.rows ?? [])];
      const row: SidebarRow = {
        id: null,
        key: typeof body.key === 'string' ? body.key : '',
        content: bodyContent(body, []),
      };
      const after = typeof body.after === 'string' ? rows.findIndex((r) => r.id === body.after) : -1;
      const before = typeof body.before === 'string' ? rows.findIndex((r) => r.id === body.before) : -1;
      if (after >= 0) rows.splice(after + 1, 0, row);
      else if (before >= 0) rows.splice(before, 0, row);
      else rows.push(row);
      props[at] = withRows(rows);
      return props;
    }
    case 'updatePropertyRow': {
      if (!prop) return null;
      const rows = [...(prop.rows ?? [])];
      const i = rows.findIndex((r) => r.id === rid);
      if (i < 0) return null;
      const r = rows[i]!;
      rows[i] = {
        ...r,
        key: typeof body.key === 'string' ? body.key : r.key,
        content: bodyContent(body, r.content),
      };
      props[at] = withRows(rows);
      return props;
    }
    case 'deletePropertyRow': {
      if (!prop) return null;
      const rows = [...(prop.rows ?? [])];
      const i = rows.findIndex((r) => r.id === rid);
      if (i < 0) return null;
      rows.splice(i, 1);
      props[at] = withRows(rows);
      return props;
    }
    default:
      return props;
  }
}
