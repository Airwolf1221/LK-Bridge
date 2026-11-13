/**
 * Hand-made audit worlds for the unit tests of the checks (v2 E2): pages, a model, a context. No database, no store, no
 * LegendKeeper: every check is a pure function of its context.
 */
import { DEFAULT_AUDIT_SETTINGS, type AuditRule, type AuditSettings } from '../../src/audits/config.js';
import { makeContext, type AuditContext } from '../../src/audits/context.js';
import type { AuditPage, DocumentInfo, DocumentScan, PropertySummary, Ref } from '../../src/audits/model.js';
import type { AuditModel } from '../../src/audits/reader.js';
import { DEFAULT_LIFECYCLE } from '../../src/lifecycle/settings.js';
import {
  DEFAULT_CHARACTER_PLACEMENT,
  type RegistryType,
  type TaxonomyEntry,
} from '../../src/registry/index.js';
import { classifyName, treeSettingsFrom } from '../../src/tree/classify.js';

export const NOW = Date.parse('2026-11-13T12:00:00Z');
export const BASE = { id: '20261113T003000Z-full-aaaaaa', takenAt: NOW - 11 * 3_600_000 };

let rankSeq = 0;

export interface PageSpec {
  readonly id: string;
  readonly name: string;
  readonly parent?: string | null;
  readonly rank?: string;
  readonly tags?: readonly string[];
  readonly aliases?: readonly string[];
  /** The PROPERTIES key-value rows, in order. */
  readonly facts?: Readonly<Record<string, string>>;
  /** Further sidebar properties (collections, unsupported…), after PROPERTIES. */
  readonly props?: readonly PropertySummary[];
  readonly docs?: readonly DocumentInfo[];
  readonly refs?: readonly Ref[];
  readonly scans?: readonly DocumentScan[];
  readonly root?: boolean;
  readonly noSidebar?: boolean;
}

export function kv(
  title: string,
  rows: readonly string[],
  o: Partial<PropertySummary> = {},
): PropertySummary {
  return {
    id: `p-${title}`,
    kind: 'keyValue',
    title,
    isTitleHidden: false,
    isHidden: false,
    display: 'list',
    rows: rows.map((k) => ({ id: `r-${k}`, key: k, text: '' })),
    ...o,
  };
}

export function prop(title: string, kind: string, o: Partial<PropertySummary> = {}): PropertySummary {
  return {
    id: `p-${title}`,
    kind,
    title,
    isTitleHidden: false,
    isHidden: false,
    display: null,
    rows: null,
    ...o,
  };
}

export function page(s: PageSpec): AuditPage {
  const facts = new Map<string, { key: string; text: string; rowId: string | null; count: number }>();
  for (const [k, v] of Object.entries(s.facts ?? {}))
    facts.set(k.toLowerCase(), { key: k, text: v, rowId: `r-${k}`, count: 1 });
  const { kind, displayName } = classifyName(s.name);
  const factRows = Object.entries(s.facts ?? {}).map(([k, v], i) => ({ id: `r${i}`, key: k, text: v }));
  const props: PropertySummary[] = s.noSidebar
    ? []
    : [{ ...kv('PROPERTIES', []), rows: factRows }, ...(s.props ?? [])];
  return {
    id: s.id,
    parentId: s.root ? null : (s.parent ?? 'root'),
    rank: s.rank ?? String(++rankSeq).padStart(6, '0'),
    rawName: s.name,
    displayName,
    kind: s.root ? 'root' : kind,
    tags: s.tags ?? [],
    aliases: s.aliases ?? [],
    properties: s.noSidebar ? null : props,
    facts,
    hasProperties: !s.noSidebar,
    documents: s.docs ?? [{ id: `${s.id}-main`, name: 'Main', type: 'page' }],
    scans: s.scans ?? [],
    refs: s.refs ?? [],
    sourceSnapshotId: BASE.id,
    sourceTakenAt: BASE.takenAt,
    unreadable: [],
  };
}

export function scan(documentId: string, o: Partial<DocumentScan> = {}): DocumentScan {
  return {
    documentId,
    name: 'Main',
    lineBreaks: [],
    iconBlocks: [],
    unsupported: { count: 0, blockIds: [] },
    collectionBlocks: 0,
    codeBlocks: [],
    ...o,
  };
}

export function mention(
  resourceId: string,
  documentId: string | null = null,
  via: Ref['via'] = { kind: 'mention', where: 'document', documentId: 'd1', blockId: 'b1' },
): Ref {
  return { resourceId, documentId, via };
}

export function model(
  pages: readonly AuditPage[],
  o: {
    templates?: readonly AuditPage[] | null;
    deleted?: Record<string, { takenAt: number; snapshotId: string; name: string }>;
    changes?: { id: string; takenAt: number }[];
  } = {},
): AuditModel {
  const changes = o.changes ?? [];
  return {
    projectId: 'prj',
    base: BASE,
    changes,
    newest: changes.at(-1) ?? BASE,
    rootId: 'root',
    pages: new Map(pages.map((p) => [p.id, p])),
    deleted: new Map(Object.entries(o.deleted ?? {})),
    templates: o.templates === null ? null : new Map((o.templates ?? []).map((p) => [p.id, p])),
    unreadable: 0,
  };
}

export const ROOT = page({ id: 'root', name: 'AI REPOSITORY', root: true });

export function characterType(o: Partial<RegistryType> = {}): RegistryType {
  return {
    id: 'type1',
    projectId: 'prj',
    singular: 'Character',
    plural: 'Characters',
    rootIndexId: 'chars',
    indexTemplateId: 'tpl-index',
    pageTemplates: [
      { role: 'core', templateId: 'tpl-core' },
      { role: 'compact', templateId: 'tpl-compact' },
    ],
    assetRootFolder: 'Characters',
    placementKind: 'character',
    placement: DEFAULT_CHARACTER_PLACEMENT,
    recipe: { version: 1 },
    packId: null,
    status: 'ok',
    review: [],
    notes: '',
    taxonomySeededAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  };
}

export function entry(
  id: string,
  plural: string,
  singular: string,
  sourceNodeId: string,
  o: Partial<TaxonomyEntry> = {},
): TaxonomyEntry {
  return {
    id,
    projectId: 'prj',
    typeId: 'type1',
    plural,
    singular,
    singularSource: 'owner',
    parentId: null,
    aliases: [],
    sourceNodeId,
    sourceParentNodeId: 'chars',
    assetFolder: plural,
    status: 'ok',
    review: [],
    notes: '',
    origin: 'seed',
    createdAt: 1,
    updatedAt: 1,
    ...o,
  };
}

export function context(
  m: AuditModel,
  o: {
    rules?: readonly AuditRule[];
    types?: readonly RegistryType[];
    entries?: readonly TaxonomyEntry[];
    settings?: Partial<AuditSettings>;
    lifecycle?: Partial<typeof DEFAULT_LIFECYCLE>;
    tagSource?: AuditContext['tagSource'];
    tombstones?: Record<string, { observedAt: number; reason: string }>;
    knownTemplateIds?: readonly string[];
    templateNames?: readonly string[];
    everSeen?: Record<string, { name: string | null; deleted: boolean }>;
    incompleteRecords?: AuditContext['incompleteRecords'];
    incompleteSets?: AuditContext['incompleteSets'];
    chronology?: AuditContext['chronology'];
    chronologyConfigured?: boolean;
  } = {},
): AuditContext {
  const entries = o.entries ?? [];
  return makeContext({
    projectId: 'prj',
    model: m,
    now: NOW,
    treeSettings: treeSettingsFrom({}),
    lifecycle: { ...DEFAULT_LIFECYCLE, ...o.lifecycle, problem: null },
    types: o.types ?? [],
    entries: (typeId) => entries.filter((e) => e.typeId === typeId),
    rules: o.rules ?? [],
    settings: { ...DEFAULT_AUDIT_SETTINGS, ...o.settings },
    tagSource: o.tagSource ?? null,
    incompleteRecords: o.incompleteRecords ?? [],
    incompleteSets: o.incompleteSets ?? [],
    chronologyConfigured: o.chronologyConfigured ?? false,
    chronologyResourceId: null,
    chronology: o.chronology ?? null,
    tombstone: (id) => o.tombstones?.[id] ?? null,
    knownTemplateIds: new Set(o.knownTemplateIds ?? []),
    templateNames: o.templateNames ?? [],
    everSeen: (id) => o.everSeen?.[id] ?? null,
  });
}

export const codes = (drafts: readonly { code: string }[]): string[] => drafts.map((d) => d.code).sort();
