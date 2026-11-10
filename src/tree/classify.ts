/**
 * Pure helpers of the repository tree: a name's kind and display name, the case-folded key exact-name lookups use,
 * the tree settings with their defaults, and what a listResources item or a getResource response says about a
 * resource (an `Observation`), including the catalogue fields read from the key-value property.
 */
import type { ProjectSettings } from '../projects/settings.js';
import type {
  CatalogueFields,
  NodeKind,
  Observation,
  PageKind,
  SidebarBlock,
  TreeDocument,
} from './types.js';
import { inRankOrder } from '../lk/row-order.js';

export const INDEX_PREFIX = '[INDEX] ';
export const BSRC_PREFIX = '[BSRC] ';
/** v2 C2c (ADR 0035): a Working page. */
export const BWRK_PREFIX = '[BWRK] ';
/** v2 C2c (ADR 0035): an Archived page. */
export const BARC_PREFIX = '[BARC] ';

/** The prefix of each classified kind, exactly as names carry it (capitals, one space). */
export const KIND_PREFIX: Readonly<Record<'index' | PageKind, string>> = {
  index: INDEX_PREFIX,
  bsrc: BSRC_PREFIX,
  bwrk: BWRK_PREFIX,
  barc: BARC_PREFIX,
};

/** v2 C2c: the page kinds, in the order mentions prefer them (current first: [BSRC], then [BWRK], then [BARC]). */
export const PAGE_KINDS: readonly PageKind[] = ['bsrc', 'bwrk', 'barc'];

/** v2 C2c: whether a kind is a page (`[BSRC]`, `[BWRK]` or `[BARC]`): name handling treats the three alike. */
export function isPageKind(kind: string): kind is PageKind {
  return kind === 'bsrc' || kind === 'bwrk' || kind === 'barc';
}

/** A name's kind (by its exact prefix) and its display name (the prefix removed, and spaces after it). */
export function classifyName(raw: string): { kind: Exclude<NodeKind, 'root'>; displayName: string } {
  for (const [kind, prefix] of Object.entries(KIND_PREFIX) as ['index' | PageKind, string][]) {
    if (raw.startsWith(prefix)) return { kind, displayName: raw.slice(prefix.length).trimStart() };
  }
  return { kind: 'unclassified', displayName: raw };
}

/** The case-folded form of a name, for case-insensitive exact lookups (Unicode NFC, lower case). */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The settings the tree reads, with their defaults. */
export interface TreeSettings {
  readonly rootId: string | null;
  readonly propertiesName: string;
  readonly referenceTypeRow: string;
  readonly scopeRow: string;
  readonly indexScopeRow: string;
  readonly canonicalNameRow: string;
  readonly sweepEnabled: boolean;
}

export function treeSettingsFrom(s: ProjectSettings): TreeSettings {
  return {
    rootId: s.aiRepositoryRootId ?? null,
    propertiesName: s.treePropertiesName ?? 'PROPERTIES',
    referenceTypeRow: s.treeReferenceTypeRow ?? 'Reference Type',
    scopeRow: s.treeScopeRow ?? 'Scope',
    indexScopeRow: s.treeIndexScopeRow ?? 'Index Scope',
    canonicalNameRow: s.treeCanonicalNameRow ?? 'Canonical Display Name',
    sweepEnabled: s.treeSweepEnabled ?? true,
  };
}

/**
 * v2 C2c: the version of the name classification. Stored with the tree (in its catalogue key), so a tree built before
 * `[BWRK]` and `[BARC]` were kinds is re-classified once, with no reads.
 */
export const CLASSIFICATION_VERSION = 'kinds-2';

/** The settings that decide the catalogue fields (and the classification's version), as one comparable string. */
export function catalogueSettingsKey(t: TreeSettings): string {
  return JSON.stringify([
    CLASSIFICATION_VERSION,
    t.propertiesName,
    t.referenceTypeRow,
    t.scopeRow,
    t.indexScopeRow,
    t.canonicalNameRow,
  ]);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function documentsOf(v: unknown): TreeDocument[] {
  if (!Array.isArray(v)) return [];
  const out: TreeDocument[] = [];
  for (const d of v) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    if (typeof o.deletedAt === 'string') continue; // a deleted document is not the resource's
    out.push({ id: o.id, name: str(o.name), type: str(o.type) });
  }
  return out;
}

/** A row's plain text: `text` when given, otherwise its runs (mentions by their text or name, breaks as newlines). */
function rowText(row: Record<string, unknown>): string {
  if (typeof row.text === 'string') return row.text;
  if (!Array.isArray(row.content)) return '';
  let out = '';
  for (const run of row.content) {
    if (!run || typeof run !== 'object') continue;
    const r = run as Record<string, unknown>;
    if (typeof r.text === 'string') out += r.text;
    else if (r.break === true) out += '\n';
    else if (r.mention && typeof r.mention === 'object') {
      const m = r.mention as Record<string, unknown>;
      out += str(m.text) ?? str(m.name) ?? '';
    }
  }
  return out;
}

/** The sidebar properties of a getResource response, summarised (kind, title, and key-value rows). */
export function summariseSidebar(properties: unknown): SidebarBlock[] {
  if (!Array.isArray(properties)) return [];
  const out: SidebarBlock[] = [];
  for (const p of properties) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const kind = str(o.kind) ?? 'unknown';
    const block: SidebarBlock = {
      id: str(o.id),
      kind,
      title: str(o.title),
      ...(kind === 'keyValue' && Array.isArray(o.rows)
        ? {
            // In LegendKeeper's display order (by rank): getResource gives rows in stored order.
            rows: inRankOrder(
              (o.rows as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'),
            ).map((r) => ({ key: str(r.key) ?? '', text: rowText(r) })),
          }
        : {}),
    };
    out.push(block);
  }
  return out;
}

const same = (a: string | null | undefined, b: string): boolean =>
  typeof a === 'string' && nameKey(a.trim()) === nameKey(b.trim());

/**
 * The catalogue fields from the sidebar: the first key-value property titled like `propertiesName` (case and outer
 * spaces ignored), and in it the first row keyed like each configured row name. An empty value reads as null.
 */
export function catalogueFrom(sidebar: readonly SidebarBlock[], t: TreeSettings): CatalogueFields {
  const block = sidebar.find((b) => b.kind === 'keyValue' && same(b.title, t.propertiesName));
  const value = (key: string): string | null => {
    const row = block?.rows?.find((r) => same(r.key, key));
    const v = row?.text.trim() ?? '';
    return v === '' ? null : v;
  };
  return {
    referenceType: value(t.referenceTypeRow),
    scope: value(t.scopeRow),
    indexScope: value(t.indexScopeRow),
    canonicalDisplayName: value(t.canonicalNameRow),
    propertiesFound: block !== undefined,
  };
}

/** A listResources item as an observation (structure only). Null when it is not a usable item. */
export function observationFromListItem(item: unknown): Observation | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '' || typeof o.name !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    parentId: str(o.parentId),
    rank: str(o.rank),
    tags: strings(o.tags),
    aliases: strings(o.aliases),
    documents: documentsOf(o.documents),
    isHidden: o.isHidden === true,
  };
}

/** A getResource response as an observation (structure and properties). Null when it is not a usable resource. */
export function observationFromResource(res: unknown): Observation | null {
  const base = observationFromListItem(res);
  if (!base) return null;
  const o = res as Record<string, unknown>;
  return {
    ...base,
    props: { isLocked: o.isLocked === true, sidebar: summariseSidebar(o.properties) },
  };
}
