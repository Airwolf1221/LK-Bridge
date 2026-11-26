/**
 * Owner commands for the type registry and taxonomy, on the owner command layer pattern (`src/mappings/commands.ts`):
 * every function takes `actor: 'owner'` first, every change writes an `audit_log` row (which emits a `policy` event),
 * and none of it is reachable from MCP. Reads write nothing.
 */
import type { ProjectSettings } from '../projects/index.js';
import { computeDrift, type DriftReport } from './drift.js';
import { cleanPrefixes, key } from './names.js';
import { characterTypeFromTree, seedTaxonomy, type TaxonomySeedResult } from './seed.js';
import { CHARACTER_SEED } from './seed-data.js';
import { placementFrom, type NewType, type RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';
import {
  RegistryError,
  characterSeedSchema,
  entryUpdateSchema,
  parseOrThrow,
  typeInputSchema,
  typeUpdateSchema,
  type NodeRef,
  type RegistryType,
  type ReviewReason,
  type TaxonomyEntry,
  type TemplateInfo,
  type TemplatesSnapshot,
} from './types.js';
import type { TreeMeta } from '../tree/index.js';

export interface AuditSink {
  audit(actor: string, action: string, target: string | null, before?: unknown, after?: unknown): void;
}

/** A type as the dashboard shows it: the stored type, plus what is wrong with it NOW (live, never stored). */
export interface TypeView extends RegistryType {
  readonly rootIndex: NodeRef | null;
  readonly checks: readonly ReviewReason[];
  readonly entries: number;
  readonly entriesNeedingReview: number;
}

export interface EntryView extends TaxonomyEntry {
  /** The source index as the tree holds it now, or null when it is not in the tree. */
  readonly source: NodeRef | null;
}

export interface TaxonomyView {
  readonly type: TypeView;
  /** In tree order: parents before children. */
  readonly entries: readonly EntryView[];
  readonly reviewQueue: readonly EntryView[];
  readonly tree: TreeMeta;
}

export interface RegistryCommandsDeps {
  readonly store: RegistryStore;
  /** A fresh window on the tree for each operation (it caches sidebars only while one operation runs). */
  readonly tree: () => ProjectTree;
  readonly audit: AuditSink;
  readonly settings: () => ProjectSettings;
  /** Reads the project's templates (every page of listTemplates, through the governor). */
  readonly readTemplates: () => Promise<TemplateInfo[]>;
}

function assertOwner(actor: unknown): asserts actor is 'owner' {
  if (actor !== 'owner') throw new RegistryError('NOT_OWNER', 'Only the owner can do this.');
}

const brief = (t: RegistryType) => ({
  singular: t.singular,
  plural: t.plural,
  rootIndexId: t.rootIndexId,
  indexTemplateId: t.indexTemplateId,
  pageTemplates: t.pageTemplates,
  assetRootFolder: t.assetRootFolder,
  placementKind: t.placementKind,
  status: t.status,
  notes: t.notes,
});

const entryBrief = (e: TaxonomyEntry) => ({
  plural: e.plural,
  singular: e.singular,
  parentId: e.parentId,
  aliases: e.aliases,
  assetFolder: e.assetFolder,
  status: e.status,
  notes: e.notes,
  ...(e.shortName ? { shortName: e.shortName } : {}),
});

export function createRegistryCommands(d: RegistryCommandsDeps) {
  const { store } = d;
  const tree = (): ProjectTree => d.tree();
  const audit = (action: string, target: string | null, before?: unknown, after?: unknown) =>
    d.audit.audit(
      'owner',
      action,
      target,
      before === undefined ? undefined : { project: store.projectId, ...(before as object) },
      after === undefined ? undefined : { project: store.projectId, ...(after as object) },
    );

  const typeView = (t: RegistryType): TypeView => {
    const checks: ReviewReason[] = [];
    const root = t.rootIndexId ? tree().node(t.rootIndexId) : null;
    if (!t.rootIndexId) checks.push({ code: 'no_root', message: 'No root index is set.' });
    else if (!root)
      checks.push({
        code: 'root_not_in_tree',
        message: `The root index ${t.rootIndexId} is not in the repository tree.`,
      });
    const snap = store.templates();
    const known = new Set(snap.templates.map((x) => x.id));
    const tpl = (label: string, id: string | null) => {
      if (id === null) checks.push({ code: 'no_template', message: `${label}: none is set.` });
      else if (snap.readAt !== null && !known.has(id)) {
        checks.push({
          code: 'template_unknown',
          message: `${label}: ${id} is not among the project's templates as last read.`,
        });
      }
    };
    tpl('Index template', t.indexTemplateId);
    for (const p of t.pageTemplates) tpl(`The “${p.role}” template`, p.templateId);
    const entries = store.entries(t.id);
    return {
      ...t,
      rootIndex: root ? tree().ref(root) : null,
      checks,
      entries: entries.length,
      entriesNeedingReview: entries.filter((e) => e.status === 'needs_review').length,
    };
  };

  /** Refuses a root that the tree holds as something other than an index. */
  const checkRoot = (id: string | null | undefined) => {
    if (!id) return;
    const n = tree().node(id);
    if (n && n.kind !== 'index') {
      throw new RegistryError(
        'INVALID_INPUT',
        `${id} (“${n.rawName}”) is not an [INDEX] page, so it cannot be a type's root.`,
      );
    }
  };

  const refreshTemplates = async (): Promise<TemplatesSnapshot> => {
    try {
      const templates = await d.readTemplates();
      store.saveTemplates({ templates, error: null });
    } catch (e) {
      store.saveTemplates({ error: e instanceof Error ? e.message : String(e) });
    }
    return store.templates();
  };

  const entryView = (e: TaxonomyEntry): EntryView => {
    const n = tree().node(e.sourceNodeId);
    return { ...e, source: n ? tree().ref(n) : null };
  };

  const ordered = (entries: readonly TaxonomyEntry[]): TaxonomyEntry[] => {
    const kids = new Map<string | null, TaxonomyEntry[]>();
    const ids = new Set(entries.map((e) => e.id));
    for (const e of entries) {
      const p = e.parentId && ids.has(e.parentId) ? e.parentId : null;
      kids.set(p, [...(kids.get(p) ?? []), e]);
    }
    const out: TaxonomyEntry[] = [];
    const walk = (p: string | null) => {
      for (const e of (kids.get(p) ?? []).sort((a, b) => a.plural.localeCompare(b.plural))) {
        out.push(e);
        walk(e.id);
      }
    };
    walk(null);
    return out;
  };

  return Object.freeze({
    listTypes(actor: 'owner'): TypeView[] {
      assertOwner(actor);
      return store.listTypes().map(typeView);
    },

    getType(actor: 'owner', id: string): TypeView {
      assertOwner(actor);
      return typeView(store.requireType(id));
    },

    templates(actor: 'owner'): TemplatesSnapshot {
      assertOwner(actor);
      return store.templates();
    },

    seedDefaults() {
      return CHARACTER_SEED;
    },

    createType(actor: 'owner', input: unknown): TypeView {
      assertOwner(actor);
      const i = parseOrThrow(typeInputSchema, input);
      checkRoot(i.rootIndexId);
      const t = store.insertType({
        singular: i.singular,
        plural: i.plural,
        rootIndexId: i.rootIndexId ?? null,
        indexTemplateId: i.indexTemplateId ?? null,
        pageTemplates: i.pageTemplates ?? [],
        assetRootFolder: i.assetRootFolder ?? i.plural,
        placementKind: i.placementKind ?? 'generic',
        placementConfig: i.placement ?? {},
        status: 'ok',
        review: [],
        notes: i.notes ?? '',
      });
      if (t.rootIndexId) store.link(t.rootIndexId, 'type', t.id);
      audit('registry.type_create', t.id, undefined, brief(t));
      return typeView(t);
    },

    updateType(actor: 'owner', id: string, input: unknown): TypeView {
      assertOwner(actor);
      const before = store.requireType(id);
      const i = parseOrThrow(typeUpdateSchema, input);
      checkRoot(i.rootIndexId);
      const kind = i.placementKind ?? before.placementKind;
      const next: NewType = {
        singular: i.singular ?? before.singular,
        plural: i.plural ?? before.plural,
        rootIndexId: i.rootIndexId !== undefined ? i.rootIndexId : before.rootIndexId,
        indexTemplateId: i.indexTemplateId !== undefined ? i.indexTemplateId : before.indexTemplateId,
        pageTemplates: i.pageTemplates ?? before.pageTemplates,
        assetRootFolder: i.assetRootFolder !== undefined ? i.assetRootFolder : before.assetRootFolder,
        placementKind: kind,
        placementConfig: { ...store.storedPlacementConfig(id), ...i.placement },
        status: i.reviewed ? 'ok' : before.status,
        review: i.reviewed ? [] : before.review,
        notes: i.notes ?? before.notes,
      };
      // Fills the defaults to prove the merged settings are complete and valid.
      placementFrom(kind, next.placementConfig);
      const after = store.updateType(id, next);
      if (before.rootIndexId !== after.rootIndexId) {
        store.unlinkType(id);
        if (after.rootIndexId) store.link(after.rootIndexId, 'type', id);
      }
      audit('registry.type_update', id, brief(before), brief(after));
      return typeView(after);
    },

    deleteType(actor: 'owner', id: string): void {
      assertOwner(actor);
      const before = store.requireType(id);
      const entries = store.entries(id).length;
      store.deleteType(id);
      store.unlinkType(id);
      audit('registry.type_delete', id, { ...brief(before), entries }, undefined);
    },

    /**
     * Seeds the Character type from the tree (the `[INDEX] Characters` node directly under the root) and the
     * project's templates (read now when never read, or when asked). Refused when a type of that name exists.
     */
    async seedCharacterType(actor: 'owner', input: unknown): Promise<TypeView> {
      assertOwner(actor);
      const i = parseOrThrow(characterSeedSchema, input);
      tree().requireUsable();
      const singular = i.singular ?? CHARACTER_SEED.singular;
      const plural = i.plural ?? CHARACTER_SEED.plural;
      const clash = store.typeByName(singular) ?? store.typeByName(plural);
      if (clash) {
        throw new RegistryError('TYPE_EXISTS', `The type ${clash.singular} exists already; edit it instead.`);
      }
      if (i.refreshTemplates || store.templates().readAt === null) await refreshTemplates();
      const t = store.insertType(characterTypeFromTree(tree(), store.templates(), i, d.settings()));
      if (t.rootIndexId) store.link(t.rootIndexId, 'type', t.id);
      audit('registry.type_seed', t.id, undefined, { ...brief(t), review: t.review });
      return typeView(t);
    },

    /** Reads the project's templates again (listTemplates, one request per 100). */
    async refreshTemplates(actor: 'owner'): Promise<TemplatesSnapshot> {
      assertOwner(actor);
      const s = await refreshTemplates();
      audit('registry.templates_refresh', null, undefined, { templates: s.templates.length, error: s.error });
      return s;
    },

    taxonomy(actor: 'owner', typeId: string): TaxonomyView {
      assertOwner(actor);
      const type = store.requireType(typeId);
      const entries = ordered(store.entries(typeId)).map(entryView);
      return {
        type: typeView(type),
        entries,
        reviewQueue: entries.filter((e) => e.status === 'needs_review'),
        tree: tree().meta(),
      };
    },

    seedTaxonomy(actor: 'owner', typeId: string): TaxonomySeedResult {
      assertOwner(actor);
      const r = seedTaxonomy(tree(), store, store.requireType(typeId), 'seed');
      audit('registry.taxonomy_seed', typeId, undefined, summary(r));
      return r;
    },

    addMissing(actor: 'owner', typeId: string): TaxonomySeedResult {
      assertOwner(actor);
      const r = seedTaxonomy(tree(), store, store.requireType(typeId), 'add_missing');
      audit('registry.taxonomy_add_missing', typeId, undefined, summary(r));
      return r;
    },

    updateEntry(actor: 'owner', id: string, input: unknown): EntryView {
      assertOwner(actor);
      const before = store.requireEntry(id);
      const i = parseOrThrow(entryUpdateSchema, input);
      const siblings = store.entries(before.typeId).filter((e) => e.id !== id);
      if (i.parentId !== undefined && i.parentId !== null) {
        const byId = new Map(store.entries(before.typeId).map((e) => [e.id, e]));
        if (!byId.has(i.parentId)) {
          throw new RegistryError(
            'INVALID_INPUT',
            `The parent ${i.parentId} is not an entry of the same type.`,
          );
        }
        for (let p: string | null = i.parentId; p !== null; p = byId.get(p)?.parentId ?? null) {
          if (p === id) throw new RegistryError('INVALID_INPUT', 'An entry cannot be under itself.');
        }
      }
      const singular = i.singular !== undefined ? cleanPrefixes(i.singular).name : before.singular;
      const aliases = i.aliases ?? before.aliases;
      // A name that another entry of the type answers to would make races ambiguous: refused here.
      for (const n of [singular, ...aliases]) {
        const k = key(n);
        const other = siblings.find(
          (e) => key(e.plural) === k || key(e.singular) === k || e.aliases.some((a) => key(a) === k),
        );
        if (other) {
          throw new RegistryError('NAME_CLASH', `“${n}” is already a name of the entry “${other.plural}”.`, {
            entryId: other.id,
          });
        }
      }
      // A singular the owner gives (even the guess itself) is the owner's: the guess no longer needs review.
      const singularGiven = i.singular !== undefined;
      let review = before.review;
      if (singularGiven) review = review.filter((r) => r.code !== 'singular_guess');
      if (i.reviewed) review = [];
      const after = store.updateEntry(id, {
        singular,
        singularSource: singularGiven ? 'owner' : before.singularSource,
        aliases,
        assetFolder: i.assetFolder ?? before.assetFolder,
        parentId: i.parentId !== undefined ? i.parentId : before.parentId,
        notes: i.notes ?? before.notes,
        status: review.length > 0 ? 'needs_review' : 'ok',
        review,
        // v3 F6c (ADR 0080): a Nation entry's short name; blank clears it.
        ...(i.shortName !== undefined ? { shortName: i.shortName?.trim() || null } : {}),
      });
      audit('registry.entry_update', id, entryBrief(before), entryBrief(after));
      return entryView(after);
    },

    deleteEntry(actor: 'owner', id: string): void {
      assertOwner(actor);
      const before = store.deleteEntry(id);
      audit('registry.entry_delete', id, entryBrief(before), undefined);
    },

    /** Compares the taxonomy with the tree now and stores the report (no request). */
    runDrift(actor: 'owner'): DriftReport {
      assertOwner(actor);
      const r = makeDriftReport(tree(), store, 'owner', null);
      audit('registry.drift_run', null, undefined, { report: r.id, findings: r.count });
      return r;
    },

    drift(actor: 'owner'): { latest: DriftReport | null; recent: Omit<DriftReport, 'findings'>[] } {
      assertOwner(actor);
      return { latest: store.latestReport() ?? null, recent: store.recentReports(10) };
    },
  });
}

export type RegistryCommands = ReturnType<typeof createRegistryCommands>;

function summary(r: TaxonomySeedResult) {
  return {
    created: r.created.length,
    needsReview: r.needsReview,
    characterIndexes: r.characterIndexes.length,
    reserved: r.reserved.length,
    unchanged: r.unchanged,
  };
}

/** Makes and stores a drift report. A tree that cannot answer gives an empty report saying why. */
export function makeDriftReport(
  tree: ProjectTree,
  store: RegistryStore,
  source: 'check' | 'owner',
  passId: string | null,
): DriftReport {
  const meta = tree.meta();
  if (meta.status !== 'ready' && meta.status !== 'stale') {
    return store.saveReport({
      source,
      passId,
      treeStatus: meta.status,
      note: `Not compared: the repository tree is ${meta.status.replace('_', ' ')}.`,
      findings: [],
    });
  }
  return store.saveReport({
    source,
    passId,
    treeStatus: meta.status,
    note: null,
    findings: computeDrift(tree, store),
  });
}
