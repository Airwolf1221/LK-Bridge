/**
 * Readable names for low-level operations (v2 E6, "Chronology II", ADR 0048).
 *
 * A proposal made by `lk_api_write` or `lk_api_batch` used to say only ids (`deleteEvent on aeanf5w1 › vuxddr…`). At
 * capture the bridge already reads each operation's target (its pre-image); from that read, the repository tree (free)
 * and, for a sidebar row, one cheap read of its property, it names:
 *
 * - the page (the tree's name);
 * - the document (the tree's name of the page's document);
 * - the entity: an event's name and date, a map feature's or lane's name, a block's first words, a property's title,
 *   a row's key (with its property's title).
 *
 * A name that cannot be found is left out and the ids stand in for it: naming never blocks or fails a proposal.
 */
import type { OpParams } from '../jobs/types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export interface OpNames {
  readonly page: string | null;
  readonly document: string | null;
  /** The entity in plain words: `event “The Long Winter” (Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102)`. */
  readonly entity: string | null;
}

export interface NameLookups {
  /** A page's name from the tree, or null. */
  page(resourceId: string): string | null;
  /** A document's name from the tree, or null. */
  document(resourceId: string, documentId: string): string | null;
  /** A sidebar (or infobox) property's title by one cheap read, or null. Absent: not looked up. */
  propertyTitle?(params: OpParams): Promise<string | null>;
}

export const NO_NAMES: OpNames = { page: null, document: null, entity: null };

/** The text of a block or a run list: its runs' text, nested blocks' text, a mention's label; spaces collapsed. */
export function textOf(v: unknown, depth = 0): string {
  if (depth > 20) return '';
  if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).join(' ');
  if (!isObj(v)) return '';
  if (typeof v.text === 'string' && !Array.isArray(v.content)) return v.text;
  if (isObj(v.mention)) return str(v.mention.text) ?? str(v.mention.name) ?? '';
  return [textOf(v.content, depth + 1), textOf(v.children, depth + 1)].join(' ');
}

/** The first words of a text, cut with `…` when longer. */
export function firstWords(text: string, words = 8): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const parts = t.split(' ');
  if (parts.length <= words && t.length <= 60) return t;
  const cut = parts.slice(0, words).join(' ');
  return `${cut.length > 60 ? cut.slice(0, 59).trimEnd() : cut}…`;
}

const quoted = (s: string, max = 80) => `“${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}”`;

/** An event's date as LegendKeeper shows it (`formattedStart` and `formattedEnd`). */
const eventDate = (e: Obj): string | null => {
  const a = str(e.formattedStart);
  if (!a) return null;
  const b = str(e.formattedEnd);
  return b ? `${a} - ${b}` : a;
};

/** The entity an operation acts on, from its pre-image (or what it sends, for a create). */
function entityOf(op: string, params: OpParams, state: unknown): string | null {
  const s = isObj(state) ? state : null;
  const body = isObj(params.body) ? params.body : {};
  if (/Event$/.test(op)) {
    const e = s ?? body;
    const name = str(e.name);
    const date = s ? eventDate(s) : null;
    return name ? `event ${quoted(name)}${date ? ` (${date})` : ''}` : null;
  }
  if (/Feature$/.test(op)) {
    const f = s ?? body;
    const name = str(f.name);
    const type = str(f.type) ?? 'feature';
    return name ? `${type} ${quoted(name)}` : `${type} (no name)`;
  }
  if (/Lane$/.test(op)) {
    const name = str((s ?? body).name);
    return name ? `lane ${quoted(name)}` : null;
  }
  if (/(?:PropertyRow|BlockRow)$/.test(op)) {
    const key = str(s?.key) ?? str(body.key);
    const value = str(s?.text);
    return key ? `row ${quoted(key, 60)}${value ? ` (${quoted(firstWords(value, 6), 50)})` : ''}` : null;
  }
  if (/Property$/.test(op)) {
    const title = str(s?.title) ?? str(body.title);
    return title ? `property ${quoted(title, 60)}` : null;
  }
  if (/Block$/.test(op)) {
    const block = s ?? (isObj(body.block) ? body.block : body);
    const text = firstWords(textOf(block));
    const kind = str(block.kind) ?? 'block';
    return text ? `${kind} ${quoted(text)}` : kind !== 'block' ? `a ${kind}` : null;
  }
  if (/Shapes$|BoardContent$/.test(op)) return 'board shapes';
  if (/Calendar$/.test(op)) {
    const name = str((s ?? body).name);
    return name ? `calendar ${quoted(name)}` : null;
  }
  return null;
}

/**
 * The names of one operation (see the module comment). Never throws: what cannot be named is null. `state` is the
 * target as captured (the pre-image), or null.
 */
export async function nameOperation(
  op: string,
  params: OpParams,
  state: unknown,
  lookups: NameLookups,
): Promise<OpNames> {
  const base = nameFromState(op, params, state, lookups);
  if (!/(?:PropertyRow|BlockPropertyRow)$/.test(op) || !lookups.propertyTitle) return base;
  try {
    const title = await lookups.propertyTitle(params);
    if (!title) return base;
    return { ...base, entity: `${base.entity ?? 'a row'} of ${quoted(title, 60)}` };
  } catch {
    return base;
  }
}

/** The names that need no read: the tree's page and document names and the entity from the pre-image. */
export function nameFromState(op: string, params: OpParams, state: unknown, lookups: NameLookups): OpNames {
  const p = params.path ?? {};
  const safe = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  const rid = p.resourceId;
  const page = rid ? safe(() => lookups.page(rid)) : null;
  const did = p.documentId;
  const document = rid && did ? safe(() => lookups.document(rid, did)) : null;
  const entity = safe(() => entityOf(op, params, state));
  return { page: page ?? null, document: document ?? null, entity: entity ?? null };
}

/** The ids an operation names (`resource › entity`), as the summary has always given them. */
export function idsOf(params: OpParams): string | null {
  const p = params.path ?? {};
  const id =
    p.blockId ??
    p.rowId ??
    p.propertyId ??
    p.laneId ??
    p.eventId ??
    p.featureId ??
    p.documentId ??
    p.resourceId;
  return id && p.resourceId && id !== p.resourceId ? `${p.resourceId} › ${id}` : (id ?? null);
}

/**
 * One operation in plain words: `deleteEvent: event “The Long Winter” (Kumikas 19th, 4A 100) in “Fourth Arkonan Age -
 * Timeline” on “[BSRC] Universal Chronology” (chrono01 › efour001)`. With no names it is the old id form.
 */
export function describeNamed(op: string, params: OpParams, names: OpNames = NO_NAMES): string {
  const ids = idsOf(params);
  const bodyName = (params.body as { name?: unknown } | undefined)?.name;
  const named = names.entity !== null || names.document !== null || names.page !== null;
  if (!named)
    return `${op}${ids ? ` on ${ids}` : ''}${typeof bodyName === 'string' ? ` ("${bodyName.slice(0, 40)}")` : ''}`;
  const parts = [
    names.entity,
    names.document ? `in ${quoted(names.document, 60)}` : null,
    names.page ? `on ${quoted(names.page, 60)}` : null,
  ].filter((x): x is string => x !== null);
  return `${op}: ${parts.join(' ')}${ids ? ` (${ids})` : ''}`;
}

/** What an operation does to its entity, for the page-level summary (`deleted`, `changed`, `added`, `moved`). */
export function verbOf(op: string): string {
  if (/^delete/.test(op)) return 'deleted';
  if (/^(?:create|insert)/.test(op)) return 'added';
  if (/^move/.test(op)) return 'moved';
  if (/^restore/.test(op)) return 'restored';
  return 'changed';
}

/** The page-level summary's part for a named operation: `event “X” (date) deleted in “Doc”`, or null. */
export function pagePart(op: string, names: OpNames): string | null {
  if (!names.entity) return null;
  return `${names.entity} ${verbOf(op)}${names.document ? ` in ${quoted(names.document, 60)}` : ''}`;
}
