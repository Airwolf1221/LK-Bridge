/**
 * Public surface of `src/registry` (v2 A3, docs/registry.md, ADR 0026): the type registry and taxonomy, name
 * resolution, ordering and character placement, per project. No MCP tool and no LegendKeeper write: the only request
 * it ever makes is the owner's read of the project's templates (listTemplates), through the governor.
 *
 * ```ts
 * const registry = createRegistry({ db, tree, engine, audit: policy.store });
 * registry.attach();                                        // the drift report follows the tree's daily check
 * const r = registry.forProject(projectId);
 * r.resolve('[INDEX] Humans', { scope: { type: 'Character' } }); // resolved | ambiguous | not_found
 * r.placementFor(parentId, 'Foxians', 'index');              // { after } | { before } | {}
 * r.planCharacterPlacement({ characterName: 'Mehrana', race: 'Qishen', kind: 'core' });
 * ```
 */
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/index.js';
import type { ResolveMention } from '../markdown/index.js';
import { ProjectStore, type ProjectSettings } from '../projects/index.js';
import type { PassView } from '../tree/index.js';
import {
  createRegistryCommands,
  makeDriftReport,
  type AuditSink,
  type RegistryCommands,
} from './commands.js';
import type { DriftReport } from './drift.js';
import { outOfOrder, placementFor, type OutOfOrderParent } from './ordering.js';
import {
  planCharacterPlacement,
  resolveCharacterRaceFolders,
  type CharacterPlacementInput,
  type CharacterPlacementPlan,
  type CharacterRaceFolders,
} from './placement.js';
import { NameResolver } from './resolve.js';
import { RegistryStore } from './store.js';
import { ProjectTree, type RegistryTree } from './tree-view.js';
import type { CharacterRole, MentionChoice } from './resolve.js';
import type { NodeRef, ResolveKind, ResolveOptions, ResolveResult, Slot, TemplateInfo } from './types.js';

/** The registry of ONE project (its LegendKeeper id); nothing of another project is reachable through it. */
export interface ProjectTypes {
  readonly projectId: string;
  readonly store: RegistryStore;
  readonly commands: RegistryCommands;
  /** A name or id to exactly one node, or `ambiguous` / `not_found` (PLAN-v2 4.4). */
  resolve(query: string, o?: ResolveOptions): ResolveResult;
  /** The same, as one node or a typed `RegistryError` (`AMBIGUOUS`, `NOT_FOUND`). */
  resolveOne(query: string, o?: ResolveOptions): NodeRef;
  /**
   * `ctx.resolveMention` for the Markdown converter (B1). v2 C2b: several pages of one character resolve to its Core,
   * else its Reference, else its index; `onChoice` hears which and why.
   */
  mentionResolver(
    o?: ResolveOptions & { readonly onChoice?: (c: MentionChoice & { name: string }) => void },
  ): ResolveMention;
  /** v2 C2b: a page's character role (Core, Reference, index) and subject, or null. */
  characterRole(id: string): { readonly role: CharacterRole; readonly subject: string } | null;
  /** The ordering slot for a new or moved page (PLAN-v2 4.5). */
  placementFor(parentId: string, newDisplayName: string, kind: ResolveKind, o?: { excludeId?: string }): Slot;
  /** Siblings out of order (reports only). */
  outOfOrder(parentId?: string): OutOfOrderParent[];
  /** Where a character page goes (PLAN-v2 section 9), with no write. */
  planCharacterPlacement(input: CharacterPlacementInput): CharacterPlacementPlan;
  /** v2 D3 (ADR 0041): a declared race's asset folder names (`[group, race]` or `[race]`), or unknown. */
  raceFolders(race: string | null | undefined, type?: string): CharacterRaceFolders;
}

export interface Registry {
  forProject(projectId: string): ProjectTypes;
  /** Follows the tree's passes: each completed daily check makes a taxonomy drift report. Returns a detach function. */
  attach(): () => void;
  /** Makes and stores a drift report for a project (what the daily check calls). */
  driftReport(projectId: string, source: 'check' | 'owner', passId: string | null): DriftReport;
}

export interface RegistryOptions {
  readonly db: Db;
  readonly tree: RegistryTree & { onPassFinished?(fn: (pass: PassView) => void): () => void };
  /** For the templates read (listTemplates through the project's governor). */
  readonly engine?: Pick<JobEngine, 'internalRead'>;
  readonly audit: AuditSink;
  readonly now?: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Replaces the templates read (tests). */
  readonly readTemplates?: (projectId: string) => Promise<TemplateInfo[]>;
}

const TEMPLATE_PAGES_MAX = 50;

/** Every page of listTemplates for a project, through the governor (P1: the owner is waiting). */
async function readTemplatesVia(
  engine: Pick<JobEngine, 'internalRead'>,
  projectId: string,
): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TEMPLATE_PAGES_MAX; page++) {
    const r = (await engine.internalRead(
      projectId,
      'listTemplates',
      { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      { priority: 'P1' },
    )) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | null;
    for (const t of Array.isArray(r?.data) ? (r.data as unknown[]) : []) {
      if (!t || typeof t !== 'object') continue;
      const o = t as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
      out.push({ id: o.id, name: o.name, parentId: typeof o.parentId === 'string' ? o.parentId : null });
    }
    if (r?.hasMore !== true || typeof r.nextCursor !== 'string') return out;
    cursor = r.nextCursor;
  }
  return out;
}

export function createRegistry(o: RegistryOptions): Registry {
  const now = o.now ?? (() => Date.now());
  const projectStore = new ProjectStore(o.db, now);
  const settingsOf = (projectId: string): ProjectSettings => projectStore.byId(projectId)?.settings ?? {};
  const cache = new Map<string, ProjectTypes>();
  const readTemplates =
    o.readTemplates ??
    ((projectId: string) => {
      if (!o.engine) return Promise.reject(new Error('Templates cannot be read here (no job engine).'));
      return readTemplatesVia(o.engine, projectId);
    });

  const forProject = (projectId: string): ProjectTypes => {
    let p = cache.get(projectId);
    if (p) return p;
    const store = new RegistryStore(o.db, now, projectId);
    const tree = () => new ProjectTree(o.tree, projectId);
    const resolver = () => new NameResolver(tree(), store);
    p = Object.freeze({
      projectId,
      store,
      commands: createRegistryCommands({
        store,
        tree,
        audit: o.audit,
        settings: () => settingsOf(projectId),
        readTemplates: () => readTemplates(projectId),
      }),
      resolve: (q: string, ro?: ResolveOptions) => resolver().resolve(q, ro),
      resolveOne: (q: string, ro?: ResolveOptions) => resolver().resolveOne(q, ro),
      mentionResolver: (
        ro?: ResolveOptions & { readonly onChoice?: (c: MentionChoice & { name: string }) => void },
      ) => resolver().mentionResolver(ro),
      characterRole: (id: string) => resolver().characterRole(id),
      placementFor: (parentId: string, name: string, kind: ResolveKind, po?: { excludeId?: string }) =>
        placementFor(tree(), parentId, name, kind, po),
      outOfOrder: (parentId?: string) => outOfOrder(tree(), parentId),
      planCharacterPlacement: (input: CharacterPlacementInput) =>
        planCharacterPlacement(tree(), store, input),
      raceFolders: (race: string | null | undefined, type?: string) =>
        resolveCharacterRaceFolders(tree(), store, { race, type }),
    });
    cache.set(projectId, p);
    return p;
  };

  const driftReport = (projectId: string, source: 'check' | 'owner', passId: string | null) =>
    makeDriftReport(new ProjectTree(o.tree, projectId), forProject(projectId).store, source, passId);

  return {
    forProject,
    driftReport,
    attach() {
      if (!o.tree.onPassFinished) return () => undefined;
      return o.tree.onPassFinished((pass) => {
        if (pass.kind !== 'check' || pass.status !== 'succeeded') return;
        try {
          driftReport(pass.projectId, 'check', pass.id);
        } catch (e) {
          o.log?.warn({ err: e, projectId: pass.projectId }, 'the taxonomy drift report failed');
        }
      });
    },
  };
}

export { RegistryStore } from './store.js';
export { ProjectTree, type RegistryTree } from './tree-view.js';
export { NameResolver, ROLE_LABEL, type CharacterRole, type MentionChoice } from './resolve.js';
export { classifyType, type Classification, type CategoryCandidate } from './classify.js';
export { computeDrift, type DriftCode, type DriftFinding, type DriftReport } from './drift.js';
export {
  COLLATOR,
  compareSiblings,
  outOfOrder,
  outOfOrderAmong,
  placementFor,
  slotAmong,
  type OutOfOrderParent,
} from './ordering.js';
export {
  planCharacterPlacement,
  resolveCharacterRaceFolders,
  type CharacterRaceFolders,
  type CharacterPlacementInput,
  type CharacterPlacementPlan,
  type IndexPlan,
  type PagePlan,
} from './placement.js';
export { seedTaxonomy, matchTemplate, type TaxonomySeedResult } from './seed.js';
export {
  createRegistryCommands,
  type RegistryCommands,
  type TypeView,
  type EntryView,
  type TaxonomyView,
} from './commands.js';
export { CHARACTER_SEED, SINGULAR_PLURALS } from './seed-data.js';
export { cleanPrefixes, singularFor, templateBaseKey, subjectOf } from './names.js';
export * from './types.js';
