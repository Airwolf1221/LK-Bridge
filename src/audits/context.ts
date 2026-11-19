/**
 * What every check is given (v2 E2, ADR 0044): the snapshot model, the project's settings, the type registry, the
 * lifecycle records and the chronology check's last run. Built once per run by the audit service; checks are pure
 * functions of it, so each is tested with a hand-made context.
 */
import type { LifecycleConfig } from '../lifecycle/index.js';
import type { LifecycleTagRules } from '../lifecycle/tags.js';
import type { RegistryType, TaxonomyEntry } from '../registry/index.js';
import { ProjectTree } from '../registry/tree-view.js';
import type { TreeSettings } from '../tree/classify.js';
import type { CheckRun } from '../chronology/store.js';
import type { AuditRule, AuditSettings, TagSource } from './config.js';
import { nameKey, type AuditPage } from './model.js';
import type { AuditModel } from './reader.js';
import { SnapshotTree } from './snapshot-tree.js';
import type { FindingDraft, FindingSource } from './types.js';
import type { AssetLibrary } from './checks/assets.js';
import type { ClassificationRecord, RetagContext } from '../packs/retag/engine.js';

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
  /**
   * v3 F3f (ADR 0060): the retag engine, when the project's approved pack has retag rules: the tag findings then come
   * from it (the same verdicts as `arkona_retag_audit`), never from the tag-definition document.
   */
  readonly retag?: RetagAuditHook | null;
}

/** v3 F3f: what the audits need of the retag engine (src/packs/retag): its context and each page's records. */
export interface RetagAuditHook {
  readonly context: RetagContext;
  readonly policy: { readonly version: number; readonly digest: string };
  readonly packRecord: (pageId: string) => ClassificationRecord | null;
  readonly owner: (pageId: string) => ClassificationRecord | null;
  readonly templateOf: (pageId: string) => string | null;
}

export function makeContext(o: Omit<AuditContext, 'tree' | 'snapshotTree'>): AuditContext {
  const snapshotTree = new SnapshotTree(o.model, o.treeSettings);
  return { ...o, snapshotTree, tree: new ProjectTree(snapshotTree, o.projectId) };
}

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

export type Check = (ctx: AuditContext) => FindingDraft[];

/** The draft's page fields for a page. */
export const onPage = (p: AuditPage) => ({ pageId: p.id });
