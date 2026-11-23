/**
 * What every check is given (v2 E2, ADR 0044): the snapshot model, the project's settings, the type registry, the
 * lifecycle records and the chronology check's last run. Built once per run by the audit service; checks are pure
 * functions of it, so each is tested with a hand-made context.
 */
import type { OutfitRecord } from '../art/store.js';
import type { ArtPageText } from './checks/art-layout.js';
import type { LifecycleConfig } from '../lifecycle/index.js';
import type { LifecycleTagRules } from '../lifecycle/tags.js';
import type { RegistryType, TaxonomyEntry } from '../registry/index.js';
import { ProjectTree } from '../registry/tree-view.js';
import type { TreeSettings } from '../tree/classify.js';
import type { CheckRun } from '../chronology/store.js';
import type { AuditRule, AuditSettings, TagSource } from './config.js';
import { nameKey, type AuditPage } from './model.js';
import type { AuditModel } from './reader.js';
import type { FindingDraft, FindingSource } from './types.js';
import type { AssetLibrary } from './checks/assets.js';
import type { GovernanceAuditInput } from './checks/governance.js';
import type { ClassificationRecord, RetagContext, TagRuling } from '../packs/retag/engine.js';
import type { NarrativeRules } from '../packs/types.js';
import type { Calendar, DateTextStyle } from '../calendar/index.js';
import { nkey, rootsOf, type NView } from '../narrative/layout.js';
import { childrenByRank, SnapshotTree } from './snapshot-tree.js';
import type { UnknownWriteItem } from '../jobs/reconcile.js';

/** A lifecycle record or set record that stopped part-way (the audit reports it with its pages). */
export interface IncompleteRecord {
  readonly id: number;
  readonly pageId: string;
  readonly pageName: string;
  readonly action: string;
  readonly createdAt: number;
  readonly jobId: string | null;
  /** For a set: its root and every page it captured. */
  readonly set?: {
    readonly rootId: string;
    readonly pages: readonly { readonly id: string; readonly name: string }[];
  };
}

export interface AuditContext {
  readonly projectId: string;
  readonly model: AuditModel;
  readonly now: number;
  readonly treeSettings: TreeSettings;
  readonly lifecycle: LifecycleConfig;
  /**
   * v3 F3d (ADR 0053): where the lifecycle tag goes and the AU ruling, from the project's approved pack (absent: the
   * defaults, `append` and no ruling).
   */
  readonly lifecycleTags?: LifecycleTagRules;
  readonly types: readonly RegistryType[];
  readonly entries: (typeId: string) => readonly TaxonomyEntry[];
  readonly rules: readonly AuditRule[];
  readonly settings: AuditSettings;
  readonly tagSource: TagSource | null;
  readonly incompleteRecords: readonly IncompleteRecord[];
  readonly incompleteSets: readonly IncompleteRecord[];
  /** D1's chronology: whether it is confirmed, its resource page, and the newest check that succeeded (folded in). */
  readonly chronologyConfigured: boolean;
  readonly chronologyResourceId: string | null;
  readonly chronology: CheckRun | null;
  /**
   * A page the snapshots once held (by id) that is not in the repository now: its last known name, and whether the
   * newest snapshot of it recorded its deletion; null when no snapshot ever held it.
   */
  readonly everSeen: (id: string) => { readonly name: string | null; readonly deleted: boolean } | null;
  /** The tree's own knowledge of pages found gone (tombstones): the bridge's, from its own passes. */
  readonly tombstone: (id: string) => { readonly observedAt: number; readonly reason: string } | null;
  /** Template ids the registry knows (listTemplates, as last read). */
  readonly knownTemplateIds: ReadonlySet<string>;
  /** The names of the project's templates (the registry's last read, and the snapshot's), for the Reference Types they stand for. */
  readonly templateNames: readonly string[];
  /** Pages of the snapshot as a registry tree (for `classifyType`, `computeDrift`, `outOfOrder`). */
  readonly tree: ProjectTree;
  readonly snapshotTree: SnapshotTree;
  /** v3 F2: the asset library as the bridge's asset tree holds it (null when it is not built). */
  readonly assetLibrary?: AssetLibrary | null;
  /** v3 F7 (ADR 0070, G7): a character folder's outfit record (the art layout check). */
  readonly outfitsOf?: (characterFolderId: string) => readonly OutfitRecord[];
  /** v3 F7 (G7): the Art pages of a character (by its name), with their blocks from the snapshots. */
  readonly artPages?: (character: string) => readonly ArtPageText[];
  /**
   * v3 F3f (ADR 0060): the retag engine, when the project's approved pack has retag rules: the tag findings then come
   * from it (the same verdicts as `arkona_retag_audit`), never from the tag-definition document.
   */
  readonly retag?: RetagAuditHook | null;
  /**
   * v3 F4a (ADR 0063): the governance documents (the governance root's tabs, from the snapshots), the pack's drift rules,
   * the bridge's tool names and the names the owner allowed; null or absent: no governance check for this project.
   */
  readonly governance?: GovernanceAuditInput | null;
  /**
   * v3 F4b (ADR 0064): the consistency check's Contradictory findings (computed from the same snapshots by the
   * consistency service: the facts index over the appraisal's overlay); null or absent: no consistency check here.
   */
  readonly consistency?: readonly ConsistencyAuditItem[] | null;
  /**
   * v3 F4c (ADR 0065): the narrative rules of the project's approved pack and the chronology's calendar (null or absent:
   * no narrative audit, and Narratives is ordinary content).
   */
  readonly narrative?: NarrativeAuditInput | null;
  /**
   * v3 F5a (ADR 0067, H10): the writes the reconciler could not settle (outcome still unknown), from the bridge's own
   * journal; absent: none reported.
   */
  readonly unknownWrites?: readonly UnknownWriteItem[];
  /** v3 F4c: every page under Narratives (narrative pages: E2's exemptions), worked out by `makeContext`. */
  readonly narrativeIds?: ReadonlySet<string>;
}

/** v3 F4c (ADR 0065): what the narrative audit needs besides the snapshots. */
export interface NarrativeAuditInput {
  readonly rules: NarrativeRules;
  readonly calendar: Calendar | null;
  readonly style?: DateTextStyle;
}

/** v3 F4b (ADR 0064): one Contradictory finding of the consistency check, as the audits receive it. */
export interface ConsistencyAuditItem {
  /** Its stable id (`cf_…`), the same in the tool, the audits and the dashboard. */
  readonly id: string;
  readonly code:
    'consistency_birth' | 'consistency_death' | 'consistency_identity' | 'consistency_chronology';
  readonly pageId: string;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** v3 F3f: what the audits need of the retag engine (src/packs/retag): its context and each page's records. */
export interface RetagAuditHook {
  readonly context: RetagContext;
  readonly policy: { readonly version: number; readonly digest: string };
  readonly packRecord: (pageId: string) => ClassificationRecord | null;
  readonly owner: (pageId: string) => ClassificationRecord | null;
  readonly templateOf: (pageId: string) => string | null;
  /** v3 F5a (ADR 0067, H2): the owner's "Keep this tag here" rulings of a page (absent: none). */
  readonly rulings?: (pageId: string) => readonly TagRuling[];
}

export function makeContext(o: Omit<AuditContext, 'tree' | 'snapshotTree' | 'narrativeIds'>): AuditContext {
  const snapshotTree = new SnapshotTree(o.model, o.treeSettings);
  const narrativeIds = o.narrative ? narrativePagesOf(o.model, o.narrative.rules) : new Set<string>();
  return { ...o, snapshotTree, tree: new ProjectTree(snapshotTree, o.projectId), narrativeIds };
}

/** v3 F4c: the snapshots' pages as the narrative layout reads them (sibling order is LegendKeeper's rank). */
export function modelView(model: AuditModel): NView {
  const kids = childrenByRank(model);
  return {
    node: (id) => model.pages.get(id) ?? null,
    children: (id) => kids.get(id) ?? [],
    indexesNamed: (name) =>
      [...model.pages.values()].filter((p) => p.kind === 'index' && nkey(p.displayName) === nkey(name)),
    fact: (id, key) => {
      const f = model.pages.get(id)?.facts.get(nameKey(key));
      const t = f && f.count === 1 ? f.text.trim() : '';
      return t === '' ? null : t;
    },
  };
}

/** v3 F4c: every page under the one Narratives index (none when it is missing or ambiguous). */
export function narrativePagesOf(model: AuditModel, rules: NarrativeRules): Set<string> {
  const view = modelView(model);
  const roots = rootsOf(view, rules);
  const out = new Set<string>();
  if (!roots.narratives) return out;
  const walk = (id: string) => {
    for (const k of view.children(id)) {
      if (out.has(k.id)) continue;
      out.add(k.id);
      walk(k.id);
    }
  };
  walk(roots.narratives.id);
  return out;
}

/** v3 F4c: whether a page is a narrative page (E2: exempt from the owner rules, tagging and lifecycle checks). */
export const isNarrativePage = (ctx: AuditContext, id: string): boolean => ctx.narrativeIds?.has(id) ?? false;

/** Where a page is, for a finding: its display-name path. */
export function pathOf(ctx: AuditContext, p: AuditPage): string {
  const n = ctx.snapshotTree.node(p.id);
  return (n?.path.names ?? [p.displayName]).join(' / ');
}

/** The snapshot a page's data came from, as a finding's source (the run fills in the age). */
export function snapshotSource(ctx: AuditContext, p: AuditPage | null): FindingSource {
  const m = ctx.model;
  return {
    kind: 'snapshot',
    snapshotId: p?.sourceSnapshotId ?? m.newest.id,
    takenAt: p?.sourceTakenAt ?? m.newest.takenAt,
    ageMs: Math.max(0, ctx.now - (p?.sourceTakenAt ?? m.newest.takenAt)),
    baseSnapshotId: m.base.id,
  };
}

/** A fact's text (the first PROPERTIES row of that key), or null when absent or empty. */
export function fact(ctx: AuditContext, p: AuditPage, row: string): string | null {
  const f = p.facts.get(nameKey(row));
  if (!f || f.count > 1) return null;
  const t = f.text.trim();
  return t === '' ? null : t;
}

/** A fact the page holds more than once (ambiguous). */
export function factAmbiguous(p: AuditPage, row: string): boolean {
  return (p.facts.get(nameKey(row))?.count ?? 0) > 1;
}

/** Pages worth auditing: everything but the root. */
export function contentPages(ctx: AuditContext): AuditPage[] {
  return [...ctx.model.pages.values()].filter((p) => p.kind !== 'root');
}

/**
 * v3 F4c (ADR 0065, design E2): the content pages the owner's rules, the tagging grammar and the lifecycle checks apply
 * to: every content page but the narrative pages (Narratives has its own audit, the `narrative` category).
 */
export function ownedPages(ctx: AuditContext): AuditPage[] {
  return contentPages(ctx).filter((p) => !isNarrativePage(ctx, p.id));
}

export type Check = (ctx: AuditContext) => FindingDraft[];

/** The draft's page fields for a page. */
export const onPage = (p: AuditPage) => ({ pageId: p.id });
