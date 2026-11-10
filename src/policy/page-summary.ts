/**
 * The page-level summary of a proposal (v2 C2a, PLAN-v2 10.2): its operations grouped by the page they affect, in plain
 * labels such as "Asagiri Miyabi: sidebar, 3 facts changed, 1 link added". Shown first on the dashboard, above the
 * per-operation diff. Made at capture, so the names are the pages' names then.
 *
 * A high-level operation that names its page and gives `pageParts` describes that page itself (set_facts, write_page,
 * and C2b's tools); every other operation is described from its LegendKeeper operation, counted per page.
 */
import { isInternalStep } from '../jobs/internal-steps.js';
import type { OpParams } from '../jobs/types.js';

export interface PageSummaryEntry {
  /** The page's resource id, or null for work that is not on a page (assets, calendars). */
  readonly resourceId: string | null;
  /** The page's name (as the tree knew it), the name a new page will have, or its id. */
  readonly page: string;
  /** The page is created by this proposal. */
  readonly isNew: boolean;
  readonly parts: readonly string[];
  /** `page: part, part, …` */
  readonly label: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an operation does to its page, as a counter name (aggregated) or a phrase. */
function effectOf(op: string): string {
  switch (op) {
    case 'createPropertyRow':
      return 'fact added';
    case 'updatePropertyRow':
      return 'fact changed';
    case 'deletePropertyRow':
      return 'fact removed';
    case 'createProperty':
      return 'sidebar property added';
    case 'updateProperty':
      return 'sidebar property changed';
    case 'deleteProperty':
      return 'sidebar property removed';
    case 'replaceDocumentBlocks':
    case 'insertBlock':
    case 'replaceBlock':
    case 'updateBlock':
    case 'deleteBlock':
    case 'moveBlock':
    case 'assignBlockIds':
      return 'text changed';
    case 'createDocument':
      return 'document added';
    case 'updateDocument':
      return 'document settings changed';
    case 'deleteDocument':
      return 'document deleted';
    case 'restoreDocument':
      return 'document restored';
    case 'updateResource':
      return 'details changed';
    case 'moveResource':
      return 'moved';
    case 'deleteResource':
      return 'deleted';
    case 'restoreResource':
      return 'restored';
    default:
      if (/Lane|Event/.test(op)) return 'timeline changed';
      if (/Feature/.test(op)) return 'map changed';
      if (/Board/.test(op)) return 'board changed';
      if (/Row|Propert/.test(op)) return 'infobox changed';
      return op;
  }
}

const COUNTED: Readonly<Record<string, [string, string]>> = {
  'fact added': ['fact added', 'facts added'],
  'fact changed': ['fact changed', 'facts changed'],
  'fact removed': ['fact removed', 'facts removed'],
};

interface Group {
  resourceId: string | null;
  page: string;
  isNew: boolean;
  /** v2 C2b: the label a high-level operation gave (`summaryLabel`), used as it is. */
  label?: string;
  sidebar: boolean;
  parts: string[];
  counts: Map<string, number>;
}

/**
 * Groups `ops` (the expansion) and `operations` (the high-level operations) by page. `nameOf` gives a page's current
 * name from the bridge's tree (null when it does not know the page).
 */
export function buildPageSummary(
  ops: readonly { readonly op: string; readonly params: OpParams }[],
  operations: readonly Readonly<Record<string, unknown>>[] | undefined,
  nameOf: (resourceId: string) => string | null,
): PageSummaryEntry[] {
  const groups = new Map<string, Group>();
  const group = (resourceId: string | null, name?: string, isNew = false): Group => {
    const key = resourceId ?? '@project';
    let g = groups.get(key);
    if (!g) {
      g = {
        resourceId,
        page: name ?? (resourceId ? (nameOf(resourceId) ?? resourceId) : 'Project'),
        isNew,
        sidebar: false,
        parts: [],
        counts: new Map(),
      };
      groups.set(key, g);
    } else if (isNew) g.isNew = true;
    return g;
  };
  const described = new Set<string>();
  for (const o of operations ?? []) {
    const page = isObj(o.page) ? o.page : null;
    const id = str(page?.id) ?? null;
    const parts = Array.isArray(o.pageParts)
      ? o.pageParts.filter((p): p is string => typeof p === 'string')
      : [];
    if (!id || parts.length === 0) continue;
    const g = group(id, str(page?.name), o.isNew === true);
    for (const p of parts) if (!g.parts.includes(p)) g.parts.push(p);
    const summaryLabel = str(o.summaryLabel);
    if (summaryLabel !== undefined && g.label === undefined) g.label = summaryLabel;
    described.add(id);
  }
  for (const { op, params } of ops) {
    if (isInternalStep(op)) continue;
    const body = isObj(params.body) ? params.body : {};
    if (op === 'createResource' || op === 'createResourceFromTemplate') {
      const id = str(body.id) ?? null;
      if (id && described.has(id)) continue;
      const g = group(id, str(body.name) ?? (id ? undefined : 'a new page'), true);
      const part = op === 'createResourceFromTemplate' ? 'created from a template' : 'created';
      if (!g.parts.includes(part)) g.parts.push(part);
      continue;
    }
    if (op === 'createManyResources') {
      for (const r of Array.isArray(body.resources) ? body.resources.filter(isObj) : []) {
        const id = str(r.id) ?? null;
        if (id && described.has(id)) continue;
        const g = group(id, str(r.name) ?? 'a new page', true);
        if (!g.parts.includes('created')) g.parts.push('created');
      }
      continue;
    }
    const rid = str(params.path?.resourceId) ?? null;
    if (rid && described.has(rid)) continue;
    const g = group(rid);
    const effect = effectOf(op);
    if (/Property/.test(op) && !/Block/.test(op)) g.sidebar = true;
    g.counts.set(effect, (g.counts.get(effect) ?? 0) + 1);
  }
  return [...groups.values()].map((g) => {
    const parts = [...g.parts];
    if (g.sidebar && !parts.includes('sidebar')) parts.unshift('sidebar');
    for (const [effect, n] of g.counts) {
      const forms = COUNTED[effect];
      parts.push(forms ? plural(n, forms[0], forms[1]) : n > 1 ? `${effect} (${n})` : effect);
    }
    const page = g.isNew && !/\(new\)$/.test(g.page) ? `${g.page} (new)` : g.page;
    return {
      resourceId: g.resourceId,
      page,
      isNew: g.isNew,
      parts,
      label: g.label ?? `${page}: ${parts.join(', ')}`,
    };
  });
}
