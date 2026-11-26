/**
 * v3 F6c (ADR 0080; the F6 design's T3 to T5 as amended, approved 23 November 2026; the owner's rulings of 26
 * November): territories, nations and their subindexes.
 *
 * - **Five structural types** in the registry (Territory, Nation, Divine Realm, Culture family, Religion family), each
 *   seeded on the owner's request from F6b's APPROVED index classification (a row that is not approved is never seeded:
 *   it is listed as "classify first"), one type at a time, with "Add missing" afterwards, as the Character seed does.
 * - **Roles**: a Territory entry binds the pack's territory categories (`<Territory> <Category>` by exact name among the
 *   territory's children; Conflicts inside the bound Historical Events); a Nation entry binds the ten nation roles by
 *   C2's matching (src/packs/nations/roles.ts) and the owner's decisions. Anything the seed cannot be sure of is
 *   `needs_review` with the reason, never guessed.
 * - **The role view** placement reads (src/packs/engine/homes.ts, C5), cached on the registry's structure.
 * - **The Nation Subindexes report** (C3): every direct child index of every nation, its role match, the unified name,
 *   collisions and content that spans two roles; the owner's decisions (accept, map, keep as specialist, not a
 *   subindex; a mapping for every child of that exact name; undo before applied). Read-only and free: the tree, the
 *   registry and the pack. Cached in two layers (F6a.1's lesson): the base built in chunks that yield, on the tree's
 *   and the registry's versions; the rows from it in memory under the decisions.
 * - **The checks' input** (C4): the accepted rows, the territories and their bindings, the role view and the owner's
 *   "keep it here" rulings.
 *
 * Nothing here renames, moves or makes a page: the checks' fixes do, as proposals (or as the automation's Apply).
 */
import type { Db } from '../../db/open.js';
import type { NodeScanRow, TreeQueries } from '../../tree/index.js';
import { classifyName } from '../../tree/classify.js';
import type { RegistryStore } from '../../registry/store.js';
import {
  RegistryError,
  type ReviewReason,
  type TaxonomyEntry,
  type TaxonomyKind,
  type RegistryType,
} from '../../registry/types.js';
import type { Pack, PackRules, IndexTaxonomyRules } from '../types.js';
import type { IndexClassifyService } from '../indextax/service.js';
import { nameKeyOf } from '../indextax/classify.js';
import type { RoleView } from '../engine/homes.js';
import { categoryFromTags, vocabularyOf } from '../retag/engine.js';
import {
  canonicalRole,
  categoryParentOf,
  hasNationRoles,
  matchNationChild,
  nationRolesOf,
  roleForCategory,
  roleKey,
  rolesNamedBy,
  territoryCategoriesOf,
  unifiedName,
  type RoleMatch,
} from './roles.js';
import { HomeRulingStore, NationSubindexStore, type SubindexDecision } from './store.js';

type Obj = Record<string, unknown>;

export class NationTaxonomyError extends Error {
  override readonly name = 'NationTaxonomyError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** NATION_SUBINDEX_BULK_MAX's default. */
export const DEFAULT_SUBINDEX_BULK_MAX = 500;

/** The five structural types: their names and the F6b rules whose approved rows they are seeded from. */
export const STRUCTURAL_TYPES: Readonly<
  Record<
    TaxonomyKind,
    { readonly singular: string; readonly plural: string; readonly rules: readonly string[] }
  >
> = {
  territory: { singular: 'Territory', plural: 'Territories', rules: ['continent', 'realmship'] },
  nation: { singular: 'Nation', plural: 'Nations', rules: ['nation'] },
  divine_realm: { singular: 'Divine Realm', plural: 'Divine Realms', rules: ['divine_realm'] },
  culture_family: { singular: 'Culture family', plural: 'Culture families', rules: ['culture_family'] },
  religion_family: { singular: 'Religion family', plural: 'Religion families', rules: ['religion_family'] },
};
export const STRUCTURAL_ORDER: readonly TaxonomyKind[] = [
  'territory',
  'nation',
  'divine_realm',
  'culture_family',
  'religion_family',
];

export interface NationTaxonomyDeps {
  readonly db: Db;
  readonly packs: {
    forProject(projectId: string): readonly Pack[];
    approvedRules(packId: string): PackRules | null;
  };
  readonly tree: { readonly queries: TreeQueries };
  readonly registry: { forProject(projectId: string): { readonly store: RegistryStore } };
  readonly indexClassify: Pick<IndexClassifyService, 'allRows' | 'prepare' | 'store'>;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  /** NATION_SUBINDEX_BULK_MAX, read on each use. */
  readonly bulkMax?: () => number | undefined;
  /** The project's settings (the three checks' switches). */
  readonly projectSettings?: (projectId: string) => Readonly<Record<string, unknown>>;
}

// ============================================================================================ results

export interface StructuralTypeStatus {
  readonly kind: TaxonomyKind;
  readonly singular: string;
  readonly plural: string;
  readonly type: { readonly id: string; readonly seededAt: number | null } | null;
  readonly entries: number;
  readonly needsReview: number;
  readonly bindings: number;
  /** Rows of F6b's classification this type would seed that are not approved yet. */
  readonly classifyFirst: number;
  /** Seeding is refused until the Territory type is seeded (Nation). */
  readonly needsTerritoryFirst: boolean;
}

export interface SeedRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface StructuralSeedResult {
  readonly kind: TaxonomyKind;
  readonly typeId: string;
  readonly created: readonly TaxonomyEntry[];
  readonly unchanged: number;
  readonly bound: readonly {
    readonly entry: string;
    readonly role: string;
    readonly node: SeedRef;
    readonly status: string;
  }[];
  /** Rows the rules match that are not approved on the Index Classification page: never seeded. */
  readonly classifyFirst: readonly SeedRef[];
  readonly needsReview: number;
  readonly warnings: readonly string[];
}

export type SubindexStatus = 'proposed' | 'unmatched' | 'accepted' | 'mapped' | 'specialist' | 'not_subindex';
export const SUBINDEX_STATUSES: readonly SubindexStatus[] = [
  'proposed',
  'unmatched',
  'accepted',
  'mapped',
  'specialist',
  'not_subindex',
];

export interface SubindexRow {
  /** The child index's id (the row's id). */
  readonly id: string;
  readonly nation: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
    readonly shortName: string | null;
    readonly entryId: string | null;
  };
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  readonly link: string;
  readonly children: number;
  /** F6b's classification of the child: approved as nav, or not approved yet. */
  readonly classification: 'nav' | 'unapproved';
  readonly match: RoleMatch | null;
  /** The role in force for the row: the decision's, else the match's (none for a specialist or not a subindex). */
  readonly role: string | null;
  readonly proposedName: string | null;
  /** The display name is already the unified name. */
  readonly standard: boolean;
  readonly status: SubindexStatus;
  readonly decision: SubindexDecision | null;
  /** Another child of the same nation has the same role: neither is renamed until merged or re-mapped. */
  readonly collision: readonly { readonly id: string; readonly name: string }[];
  /** The matched name names two roles: the index's pages with their primary category tags, for the owner to see. */
  readonly spans: {
    readonly roles: readonly string[];
    readonly pages: readonly {
      readonly id: string;
      readonly name: string;
      readonly category: string | null;
    }[];
  } | null;
}

export interface SubindexFilter {
  readonly status?: readonly SubindexStatus[] | undefined;
  readonly nationId?: string | undefined;
  readonly role?: string | undefined;
  readonly nameContains?: string | undefined;
  readonly collision?: boolean | undefined;
}

export interface SubindexReport {
  readonly pack: { readonly id: string; readonly version: number; readonly approvedVersion: number | null };
  readonly rules: {
    readonly approved: boolean;
    readonly roles: readonly string[];
    readonly variants: readonly { readonly variant: string; readonly role: string }[];
    readonly nationSeeded: boolean;
  };
  readonly nations: readonly {
    readonly id: string;
    readonly name: string;
    readonly shortName: string | null;
  }[];
  readonly rows: readonly SubindexRow[];
  readonly totalRows: number;
  readonly counts: Readonly<Record<SubindexStatus, number>> & { readonly collision: number };
  readonly tree: { readonly status: string; readonly version: number };
}

/** What the three checks read (null: the approved pack carries no nation roles). */
export interface NationAuditInput {
  readonly rules: PackRules;
  readonly tax: IndexTaxonomyRules;
  /** The accepted and mapped decisions (the only rows `nation_subindex_nonstandard` acts on). */
  readonly decisions: readonly SubindexDecision[];
  /** Nation entries' short names, by the nation index's id. */
  readonly shortNames: ReadonlyMap<string, string>;
  readonly roles: RoleView | null;
  /** Territory entries (by index id): name and bindings (category → node). */
  readonly territories: readonly {
    readonly entryId: string;
    readonly nodeId: string;
    readonly name: string;
    readonly bindings: ReadonlyMap<string, string>;
  }[];
  /** The owner's "keep it here" rulings: page id → the state hash it was made on. */
  readonly homeRulings: ReadonlyMap<string, string>;
  /** Which checks the project has switched on (the per-project settings; default on). */
  readonly checks: {
    readonly nonstandard: boolean;
    readonly categoryMissing: boolean;
    readonly categoryHome: boolean;
  };
}

// ============================================================================================ the base

interface ChildBase {
  readonly id: string;
  readonly nationId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly path: string;
  readonly children: number;
  readonly grandchildren: readonly {
    readonly id: string;
    readonly name: string;
    readonly tags: readonly string[];
  }[];
}

interface Base {
  readonly key: string;
  readonly nations: readonly {
    readonly id: string;
    readonly rawName: string;
    readonly displayName: string;
    readonly entryId: string | null;
    readonly shortName: string | null;
  }[];
  readonly children: readonly ChildBase[];
  readonly tax: IndexTaxonomyRules;
  readonly rules: PackRules;
  readonly approved: boolean;
  readonly pack: Pack;
  readonly nationSeeded: boolean;
}

const reason = (code: string, message: string): ReviewReason => ({ code, message });

export class NationTaxonomyService {
  readonly decisions: NationSubindexStore;
  readonly rulings: HomeRulingStore;
  /** Children handled between yields while the base is built. */
  static readonly CHUNK = 200;
  private bases = new Map<string, Base>();
  private building = new Map<string, Promise<void>>();
  private rowsCache = new Map<string, { key: string; rows: SubindexRow[] }>();
  private views = new Map<string, { key: string; view: RoleView | null }>();

  constructor(private readonly d: NationTaxonomyDeps) {
    this.decisions = new NationSubindexStore(d.db, d.now);
    this.rulings = new HomeRulingStore(d.db, d.now);
  }

  bulkMax(): number {
    const v = this.d.bulkMax?.();
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_SUBINDEX_BULK_MAX;
  }

  private store(projectId: string): RegistryStore {
    return this.d.registry.forProject(projectId).store;
  }

  // ============================================================================================ the pack

  /**
   * The project's pack with an index taxonomy: the APPROVED rules when they carry it, else the current version's (the
   * report shows what an approval would do). Null: no pack with an index taxonomy.
   */
  rulesFor(
    projectId: string,
  ): { rules: PackRules; tax: IndexTaxonomyRules; approved: boolean; pack: Pack } | null {
    for (const p of [...this.d.packs.forProject(projectId)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const a = this.d.packs.approvedRules(p.id);
      if (a?.indexTaxonomy) return { rules: a, tax: a.indexTaxonomy, approved: true, pack: p };
      if (p.rules.indexTaxonomy)
        return { rules: p.rules, tax: p.rules.indexTaxonomy, approved: false, pack: p };
    }
    return null;
  }

  private requireRules(projectId: string) {
    const r = this.rulesFor(projectId);
    if (!r || !hasNationRoles(r.tax))
      throw new NationTaxonomyError(
        'NO_NATION_ROLES',
        'No setting pack with the nation roles is attached to this project (the Arkona pack from version arkona-2026-11-27-f6c has them: approve it on the Packs page).',
      );
    return r;
  }

  // ============================================================================================ the role view

  /** The registry's Territory and Nation entries and role bindings, as placement reads them (null: neither seeded). */
  roleView(projectId: string): RoleView | null {
    const store = this.store(projectId);
    const r = this.rulesFor(projectId);
    const key = `${store.structureKey()}|${r?.pack.id ?? ''}:${r?.approved ? `a${r.pack.approved?.version ?? 0}` : `c${r?.pack.version ?? 0}`}`;
    const had = this.views.get(projectId);
    if (had?.key === key) return had.view;
    const view = this.buildView(store, r?.tax ?? null);
    this.views.set(projectId, { key, view });
    return view;
  }

  private buildView(store: RegistryStore, tax: IndexTaxonomyRules | null): RoleView | null {
    const tt = store.typeByKind('territory');
    const nt = store.typeByKind('nation');
    const territorySeeded = tt?.taxonomySeededAt != null;
    const nationSeeded = nt?.taxonomySeededAt != null;
    if (!territorySeeded && !nationSeeded) return null;
    const territories = new Map<string, { entryId: string; name: string }>();
    const nations = new Map<string, { entryId: string; name: string; shortName: string | null }>();
    const nodeOfEntry = new Map<string, { node: string; kind: 'territory' | 'nation' }>();
    if (tt)
      for (const e of store.entries(tt.id)) {
        territories.set(e.sourceNodeId, { entryId: e.id, name: e.plural });
        nodeOfEntry.set(e.id, { node: e.sourceNodeId, kind: 'territory' });
      }
    if (nt)
      for (const e of store.entries(nt.id)) {
        nations.set(e.sourceNodeId, { entryId: e.id, name: e.plural, shortName: e.shortName });
        nodeOfEntry.set(e.id, { node: e.sourceNodeId, kind: 'nation' });
      }
    const bindings = new Map<string, Map<string, string>>();
    const bound = new Map<string, { kind: 'territory' | 'nation'; owner: string; role: string }>();
    for (const b of store.allBindings()) {
      const o = nodeOfEntry.get(b.entryId);
      if (!o) continue;
      let m = bindings.get(o.node);
      if (!m) bindings.set(o.node, (m = new Map<string, string>()));
      m.set(b.role, b.nodeId);
      bound.set(b.nodeId, { kind: o.kind, owner: o.node, role: b.role });
    }
    return {
      territorySeeded,
      nationSeeded,
      territories,
      nations,
      bound,
      bindings,
      roleForCategory: (c) => (tax ? roleForCategory(tax, c) : null),
    };
  }

  /** The Nation entries' short names, by the nation index's id. */
  shortNames(projectId: string): Map<string, string> {
    const store = this.store(projectId);
    const nt = store.typeByKind('nation');
    const out = new Map<string, string>();
    if (nt) for (const e of store.entries(nt.id)) if (e.shortName) out.set(e.sourceNodeId, e.shortName);
    return out;
  }

  // ============================================================================================ the structural types

  typeStatus(projectId: string): StructuralTypeStatus[] {
    const store = this.store(projectId);
    let rows: ReturnType<IndexClassifyService['allRows']> = [];
    try {
      rows = this.d.indexClassify.allRows(projectId);
    } catch {
      rows = [];
    }
    const r = this.rulesFor(projectId);
    const territory = store.typeByKind('territory');
    return STRUCTURAL_ORDER.map((kind) => {
      const def = STRUCTURAL_TYPES[kind];
      const t = store.typeByKind(kind);
      const entries = t ? store.entries(t.id) : [];
      const ids = new Set(entries.map((e) => e.id));
      const cands = r ? this.candidates(rows, kind, r.tax) : [];
      return {
        kind,
        singular: def.singular,
        plural: def.plural,
        type: t ? { id: t.id, seededAt: t.taxonomySeededAt } : null,
        entries: entries.length,
        needsReview: entries.filter((e) => e.status === 'needs_review').length,
        bindings: store.allBindings().filter((b) => ids.has(b.entryId)).length,
        classifyFirst: cands.filter((c) => c.approvedRole === null && c.status !== 'left_undecided').length,
        needsTerritoryFirst: kind === 'nation' && territory?.taxonomySeededAt == null,
      };
    });
  }

  /** The rows of F6b's classification a type is seeded from (in scope, the type's rule among those that matched). */
  private candidates(
    rows: ReturnType<IndexClassifyService['allRows']>,
    kind: TaxonomyKind,
    tax: IndexTaxonomyRules,
  ) {
    const want = new Set(STRUCTURAL_TYPES[kind].rules);
    const lost = new Set((tax.lostRealmshipParents ?? []).map(nameKeyOf));
    return rows.filter((r) => {
      if (r.scope !== 'in' || !r.matched.some((m) => want.has(m))) return false;
      if (kind === 'territory') {
        // Lost Realmships are not territories (the owner's ruling).
        const parent = r.path.split(' / ').slice(-2, -1)[0] ?? '';
        if (lost.has(nameKeyOf(parent))) return false;
      }
      return true;
    });
  }

  /** "Seed" (the first time, refused once seeded) or "Add missing" (new entries and unbound roles only). */
  seed(
    actor: string,
    projectId: string,
    kind: TaxonomyKind,
    mode: 'seed' | 'add_missing',
  ): StructuralSeedResult {
    if (actor !== 'owner') throw new RegistryError('NOT_OWNER', 'Only the owner seeds the registry.');
    const r = this.requireRules(projectId);
    const store = this.store(projectId);
    const def = STRUCTURAL_TYPES[kind];
    const meta = this.d.tree.queries.status(projectId);
    if (meta.status !== 'ready' && meta.status !== 'stale')
      throw new RegistryError('TREE_NOT_READY', `The repository tree is ${meta.status.replace('_', ' ')}.`);
    if (kind === 'nation' && store.typeByKind('territory')?.taxonomySeededAt == null)
      throw new RegistryError(
        'SEED_TERRITORY_FIRST',
        'Seed the Territory type first: each Nation entry’s parent is its Territory entry.',
      );
    let type = store.typeByKind(kind);
    if (mode === 'seed' && type?.taxonomySeededAt != null)
      throw new RegistryError(
        'ALREADY_SEEDED',
        `${def.singular} was seeded already; use “Add missing” for new indexes.`,
      );
    if (mode === 'add_missing' && (!type || type.taxonomySeededAt == null))
      throw new RegistryError('NOT_SEEDED', `Seed ${def.singular} first.`);
    const rows = this.d.indexClassify.allRows(projectId);
    const scan = this.d.tree.queries.nodeScan(projectId);
    const byId = new Map(scan.map((n) => [n.id, n]));
    const kids = childrenOf(scan);
    const cands = this.candidates(rows, kind, r.tax);
    const ref = (id: string): SeedRef => {
      const n = byId.get(id);
      return { id, name: n?.rawName ?? id, path: n ? n.pathNames.join(' / ') : '' };
    };
    const approved = cands.filter((c) => c.approvedRole === 'subject');
    const classifyFirst = cands
      .filter((c) => c.approvedRole === null && c.status !== 'left_undecided')
      .map((c) => ref(c.id));
    const warnings: string[] = [];
    const out = store.tx(() => {
      if (!type) {
        const clash = store.typeByName(def.singular) ?? store.typeByName(def.plural);
        if (clash)
          throw new RegistryError(
            'TYPE_EXISTS',
            `A type named ${clash.singular} exists already (not the structural ${def.singular} type); rename or delete it first.`,
          );
        type = store.insertType({
          singular: def.singular,
          plural: def.plural,
          rootIndexId: null,
          indexTemplateId: null,
          pageTemplates: [],
          assetRootFolder: null,
          placementKind: 'generic',
          placementConfig: {},
          status: 'ok',
          review: [],
          notes: `Seeded from the approved index classification (v3 F6c).`,
          taxonomyKind: kind,
        });
      }
      const t: RegistryType = type;
      const territories = this.territoryNodes(store);
      const created: TaxonomyEntry[] = [];
      let unchanged = 0;
      for (const c of approved) {
        const had = store.entryBySource(c.id);
        if (had) {
          if (had.typeId === t.id) unchanged++;
          else warnings.push(`${c.name} is an entry of another type already; left as it is.`);
          continue;
        }
        const node = byId.get(c.id);
        if (!node) continue;
        const reasons: ReviewReason[] = [];
        let parentId: string | null = null;
        if (kind !== 'territory' && kind !== 'divine_realm') {
          const terr = [...node.pathIds.slice(0, -1)].reverse().find((id) => territories.has(id));
          parentId = terr ? territories.get(terr)! : null;
          if (kind === 'nation' && !parentId)
            reasons.push(
              reason(
                'no_territory',
                `No Territory entry is above ${node.displayName}; seed or add its territory, then set the parent.`,
              ),
            );
        }
        created.push(
          store.insertEntry({
            typeId: t.id,
            plural: node.displayName,
            singular: node.displayName,
            singularSource: 'list',
            parentId,
            aliases: [],
            sourceNodeId: node.id,
            sourceParentNodeId: node.parentId,
            assetFolder: node.displayName,
            status: reasons.length > 0 ? 'needs_review' : 'ok',
            review: reasons,
            origin: mode,
          }),
        );
      }
      const bound: StructuralSeedResult['bound'][number][] = [];
      for (const e of store.entries(t.id)) {
        if (kind === 'territory') bound.push(...this.bindTerritory(store, r.tax, e, byId, kids, mode, ref));
        if (kind === 'nation')
          bound.push(...this.bindNation(projectId, store, r.tax, e, byId, kids, mode, ref));
      }
      if (mode === 'seed') store.markTaxonomySeeded(t.id);
      return { typeId: t.id, created, unchanged, bound };
    });
    const entries = store.entries(out.typeId);
    const result: StructuralSeedResult = {
      kind,
      ...out,
      classifyFirst,
      needsReview: entries.filter((e) => e.status === 'needs_review').length,
      warnings,
    };
    this.d.audit(
      actor,
      mode === 'seed' ? 'registry.structural_seed' : 'registry.structural_add_missing',
      projectId,
      undefined,
      {
        kind,
        typeId: out.typeId,
        created: out.created.length,
        bound: out.bound.length,
        classifyFirst: classifyFirst.length,
        unchanged: out.unchanged,
      },
    );
    return result;
  }

  /** Territory entries by their index's id → the entry's id. */
  private territoryNodes(store: RegistryStore): Map<string, string> {
    const t = store.typeByKind('territory');
    return new Map((t ? store.entries(t.id) : []).map((e) => [e.sourceNodeId, e.id]));
  }

  private addReview(store: RegistryStore, e: TaxonomyEntry, add: readonly ReviewReason[]): void {
    const have = store.requireEntry(e.id).review;
    const next = [...have];
    for (const x of add) if (!next.some((y) => y.code === x.code && y.message === x.message)) next.push(x);
    if (next.length !== have.length) store.setEntryReview(e.id, 'needs_review', next);
  }

  /** A Territory's categories by exact name (`<Territory> <Category>`); Conflicts inside its bound Historical Events. */
  private bindTerritory(
    store: RegistryStore,
    tax: IndexTaxonomyRules,
    e: TaxonomyEntry,
    byId: ReadonlyMap<string, NodeScanRow>,
    kids: ReadonlyMap<string, NodeScanRow[]>,
    mode: 'seed' | 'add_missing',
    ref: (id: string) => SeedRef,
  ): StructuralSeedResult['bound'][number][] {
    const node = byId.get(e.sourceNodeId);
    if (!node) return [];
    const cats = [...territoryCategoriesOf(tax)].sort(
      (a, b) => Number(categoryParentOf(tax, a) !== null) - Number(categoryParentOf(tax, b) !== null),
    );
    const out: StructuralSeedResult['bound'][number][] = [];
    const reviews: ReviewReason[] = [];
    for (const c of cats) {
      if (store.binding(e.id, c)) continue;
      const parentCat = categoryParentOf(tax, c);
      const parentCatName = parentCat
        ? (cats.find((x) => roleKey(x) === roleKey(parentCat)) ?? parentCat)
        : null;
      const container = parentCatName ? store.binding(e.id, parentCatName)?.nodeId : node.id;
      if (!container) continue;
      const want = nameKeyOf(`${node.displayName} ${c}`);
      const hits = (kids.get(container) ?? []).filter(
        (x) => x.kind === 'index' && nameKeyOf(x.displayName) === want,
      );
      if (hits.length === 1) {
        const h = hits[0]!;
        const other = store.bindingByNode(h.id);
        if (other) {
          reviews.push(
            reason(`role_node_bound:${c}`, `${h.rawName} is bound to another role (${other.role}) already.`),
          );
          continue;
        }
        const b = store.bind({ entryId: e.id, role: c, nodeId: h.id, status: 'ok', origin: mode });
        out.push({ entry: e.plural, role: c, node: ref(h.id), status: b.status });
      } else if (hits.length > 1)
        reviews.push(
          reason(
            `role_ambiguous:${c}`,
            `${hits.length} indexes are named “${node.displayName} ${c}” (${hits.map((h) => h.id).join(', ')}): none is bound; merge them or bind one.`,
          ),
        );
    }
    if (reviews.length > 0) this.addReview(store, e, reviews);
    return out;
  }

  /** A Nation's roles by C2's matching and the owner's Nation Subindexes decisions. */
  private bindNation(
    projectId: string,
    store: RegistryStore,
    tax: IndexTaxonomyRules,
    e: TaxonomyEntry,
    byId: ReadonlyMap<string, NodeScanRow>,
    kids: ReadonlyMap<string, NodeScanRow[]>,
    mode: 'seed' | 'add_missing',
    ref: (id: string) => SeedRef,
  ): StructuralSeedResult['bound'][number][] {
    const node = byId.get(e.sourceNodeId);
    if (!node) return [];
    const cls = classificationOf(this.d.indexClassify.store.decisions(projectId));
    const byRole = new Map<string, NodeScanRow[]>();
    for (const c of kids.get(node.id) ?? []) {
      if (c.kind !== 'index' || cls.get(c.id) === 'subject') continue;
      const dec = this.decisions.decision(projectId, c.id);
      const role =
        dec?.role ??
        (dec
          ? null
          : (matchNationChild(tax, c.displayName, [node.displayName, ...(e.shortName ? [e.shortName] : [])])
              ?.role ?? null));
      if (!role) continue;
      const l = byRole.get(role);
      if (l) l.push(c);
      else byRole.set(role, [c]);
    }
    const out: StructuralSeedResult['bound'][number][] = [];
    const reviews: ReviewReason[] = [];
    for (const role of nationRolesOf(tax)) {
      const hits = byRole.get(role) ?? [];
      if (hits.length === 0 || store.binding(e.id, role)) continue;
      if (hits.length > 1) {
        reviews.push(
          reason(
            `role_collision:${role}`,
            `Two subindexes for one role (${role}): ${hits.map((h) => h.rawName).join(', ')}. Neither is bound: merge or re-map first (Nation Subindexes).`,
          ),
        );
        continue;
      }
      const h = hits[0]!;
      if (store.bindingByNode(h.id)) continue;
      const unapproved = cls.get(h.id) !== 'nav';
      const b = store.bind({
        entryId: e.id,
        role,
        nodeId: h.id,
        status: unapproved ? 'needs_review' : 'ok',
        reason: unapproved
          ? `${h.rawName}’s classification is not approved as [NAV] yet (Index Classification).`
          : '',
        origin: mode,
      });
      out.push({ entry: e.plural, role, node: ref(h.id), status: b.status });
    }
    if (reviews.length > 0) this.addReview(store, e, reviews);
    return out;
  }

  /**
   * A role bound after a job made its index (the territory_category_missing fix, create_index's role form), on the
   * job's success. The entry by its index's id; refused quietly (the result says why) when the role was bound meanwhile.
   */
  recordBinding(
    projectId: string,
    r: { readonly ownerNodeId: string; readonly role: string; readonly nodeId: string },
    actor: string,
  ): Obj {
    const store = this.store(projectId);
    const e = store.entryBySource(r.ownerNodeId);
    if (!e) return { recorded: null, why: 'the territory or nation has no registry entry' };
    try {
      const b = store.bind({ entryId: e.id, role: r.role, nodeId: r.nodeId, status: 'ok', origin: 'job' });
      this.d.audit(actor, 'registry.role_bind', projectId, undefined, {
        entryId: e.id,
        role: r.role,
        nodeId: r.nodeId,
        by: 'job',
      });
      return { recorded: 'role_binding', entryId: e.id, role: b.role, nodeId: b.nodeId };
    } catch (x) {
      if (x instanceof RegistryError) return { recorded: null, why: x.message, code: x.code };
      throw x;
    }
  }

  // ============================================================================================ the report's base

  private baseKey(projectId: string): string {
    const r = this.rulesFor(projectId);
    const store = this.store(projectId);
    return [
      this.d.tree.queries.version(projectId),
      store.structureKey(),
      r ? `${r.pack.id}:${r.approved ? `a${r.pack.approved?.version ?? 0}` : `c${r.pack.version}`}` : '',
    ].join('|');
  }

  private *baseSteps(projectId: string, key: string): Generator<void, Base> {
    const r = this.requireRules(projectId);
    const store = this.store(projectId);
    const scan = this.d.tree.queries.nodeScan(projectId);
    yield;
    const byId = new Map(scan.map((n) => [n.id, n]));
    const kids = childrenOf(scan);
    yield;
    const nt = store.typeByKind('nation');
    const nationSeeded = nt?.taxonomySeededAt != null;
    const nations: Base['nations'][number][] = [];
    if (nationSeeded) {
      for (const e of store.entries(nt.id)) {
        const n = byId.get(e.sourceNodeId);
        if (n && n.kind === 'index')
          nations.push({
            id: n.id,
            rawName: n.rawName,
            displayName: n.displayName,
            entryId: e.id,
            shortName: e.shortName,
          });
      }
    } else {
      // By position (F3b's rule): an index directly in a `<Continent> Polities` index.
      const polities = r.rules.owners?.nations ?? 'Polities';
      const isPolities = (n: NodeScanRow | undefined) =>
        !!n && n.kind === 'index' && nameKeyOf(n.displayName).endsWith(` ${nameKeyOf(polities)}`);
      for (const n of scan)
        if (n.kind === 'index' && n.parentId && isPolities(byId.get(n.parentId)))
          nations.push({
            id: n.id,
            rawName: n.rawName,
            displayName: n.displayName,
            entryId: null,
            shortName: null,
          });
    }
    const children: ChildBase[] = [];
    let i = 0;
    for (const nat of nations)
      for (const c of kids.get(nat.id) ?? []) {
        if (c.kind !== 'index') continue;
        if (++i % NationTaxonomyService.CHUNK === 0) yield;
        const g = kids.get(c.id) ?? [];
        children.push({
          id: c.id,
          nationId: nat.id,
          rawName: c.rawName,
          displayName: c.displayName,
          path: c.pathNames.join(' / '),
          children: g.length,
          grandchildren: g.slice(0, 200).map((x) => ({ id: x.id, name: x.rawName, tags: x.tags })),
        });
      }
    return {
      key,
      nations,
      children,
      tax: r.tax,
      rules: r.rules,
      approved: r.approved,
      pack: r.pack,
      nationSeeded,
    };
  }

  private baseNow(projectId: string): Base {
    const key = this.baseKey(projectId);
    const had = this.bases.get(projectId);
    if (had?.key === key) return had;
    const g = this.baseSteps(projectId, key);
    let r = g.next();
    while (!r.done) r = g.next();
    this.bases.set(projectId, r.value);
    return r.value;
  }

  /** Makes the base current, yielding between chunks (one build at a time per project). The routes await this. */
  async prepare(projectId: string): Promise<void> {
    await this.d.indexClassify.prepare(projectId).catch(() => undefined);
    for (;;) {
      const key = this.baseKey(projectId);
      if (this.bases.get(projectId)?.key === key) return;
      const running = this.building.get(projectId);
      if (running) {
        await running.catch(() => undefined);
        continue;
      }
      const p = (async () => {
        const g = this.baseSteps(projectId, key);
        let r = g.next();
        while (!r.done) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          r = g.next();
        }
        this.bases.set(projectId, r.value);
      })();
      this.building.set(projectId, p);
      try {
        await p;
      } finally {
        this.building.delete(projectId);
      }
      return;
    }
  }

  cacheState(projectId: string): { readonly base: string | null; readonly rows: string | null } {
    return { base: this.bases.get(projectId)?.key ?? null, rows: this.rowsCache.get(projectId)?.key ?? null };
  }

  // ============================================================================================ the rows

  private rows(projectId: string, base: Base): SubindexRow[] {
    const key = `${base.key}|${this.decisions.version()}|${this.d.indexClassify.store.version()}`;
    const had = this.rowsCache.get(projectId);
    if (had?.key === key) return had.rows;
    const decisions = new Map(this.decisions.decisions(projectId).map((x) => [x.pageId, x]));
    const cls = classificationOf(this.d.indexClassify.store.decisions(projectId));
    const nations = new Map(base.nations.map((n) => [n.id, n]));
    const vocab = vocabularyOf(base.rules);
    const draft: (Omit<SubindexRow, 'collision'> & { collision: { id: string; name: string }[] })[] = [];
    for (const c of base.children) {
      if (cls.get(c.id) === 'subject') continue;
      const nat = nations.get(c.nationId)!;
      const decision = decisions.get(c.id) ?? null;
      const match = matchNationChild(base.tax, c.displayName, [
        nat.displayName,
        ...(nat.shortName ? [nat.shortName] : []),
      ]);
      const role =
        decision?.action === 'accept' || decision?.action === 'map'
          ? decision.role
          : decision
            ? null
            : (match?.role ?? null);
      const status: SubindexStatus = decision
        ? decision.action === 'accept'
          ? 'accepted'
          : decision.action === 'map'
            ? 'mapped'
            : decision.action
        : match
          ? 'proposed'
          : 'unmatched';
      const proposedName = role ? unifiedName(nat, role) : null;
      const word = decision?.action === 'map' ? null : match?.word;
      const named = word ? rolesNamedBy(base.tax, word) : [];
      draft.push({
        id: c.id,
        nation: {
          id: nat.id,
          name: nat.rawName,
          displayName: nat.displayName,
          shortName: nat.shortName,
          entryId: nat.entryId,
        },
        name: c.rawName,
        displayName: c.displayName,
        path: c.path,
        link: `/ui/tree?node=${encodeURIComponent(c.id)}`,
        children: c.children,
        classification: cls.get(c.id) === 'nav' ? 'nav' : 'unapproved',
        match,
        role,
        proposedName,
        standard: proposedName !== null && c.displayName === proposedName,
        status,
        decision,
        collision: [],
        spans:
          named.length >= 2
            ? {
                roles: named,
                pages: c.grandchildren.map((g) => {
                  const cat = categoryFromTags(g.tags, vocab);
                  return { id: g.id, name: g.name, category: 'primary' in cat ? cat.primary : null };
                }),
              }
            : null,
      });
    }
    // Collisions: two children of one nation with the same role.
    const groups = new Map<string, typeof draft>();
    for (const r of draft) {
      if (!r.role) continue;
      const k = `${r.nation.id}\u0000${roleKey(r.role)}`;
      const l = groups.get(k);
      if (l) l.push(r);
      else groups.set(k, [r]);
    }
    for (const l of groups.values())
      if (l.length > 1)
        for (const r of l)
          r.collision = l.filter((x) => x.id !== r.id).map((x) => ({ id: x.id, name: x.name }));
    const rows = draft as SubindexRow[];
    this.rowsCache.set(projectId, { key, rows });
    return rows;
  }

  private static filtered(rows: readonly SubindexRow[], f: SubindexFilter): SubindexRow[] {
    const want = f.nameContains?.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!f.status || f.status.length === 0 || f.status.includes(r.status)) &&
        (f.nationId === undefined || r.nation.id === f.nationId) &&
        (f.role === undefined || (r.role !== null && roleKey(r.role) === roleKey(f.role))) &&
        (f.collision === undefined || f.collision === r.collision.length > 0) &&
        (!want || r.name.toLowerCase().includes(want) || r.nation.name.toLowerCase().includes(want)),
    );
  }

  report(
    projectId: string,
    filter: SubindexFilter = {},
    page: { offset?: number; limit?: number } = {},
  ): SubindexReport {
    const base = this.baseNow(projectId);
    const all = this.rows(projectId, base);
    const rows = NationTaxonomyService.filtered(all, filter);
    const counts = Object.fromEntries(SUBINDEX_STATUSES.map((s) => [s, 0])) as Record<SubindexStatus, number>;
    let collision = 0;
    for (const r of all) {
      counts[r.status]++;
      if (r.collision.length > 0) collision++;
    }
    const offset = Math.max(0, page.offset ?? 0);
    const limit = Math.min(500, Math.max(1, page.limit ?? 100));
    return {
      pack: {
        id: base.pack.id,
        version: base.pack.version,
        approvedVersion: base.pack.approved?.version ?? null,
      },
      rules: {
        approved: base.approved,
        roles: nationRolesOf(base.tax),
        variants: base.tax.nationRoleVariants ?? [],
        nationSeeded: base.nationSeeded,
      },
      nations: base.nations.map((n) => ({ id: n.id, name: n.rawName, shortName: n.shortName })),
      rows: rows.slice(offset, offset + limit),
      totalRows: rows.length,
      counts: { ...counts, collision },
      tree: {
        status: this.d.tree.queries.status(projectId).status,
        version: this.d.tree.queries.version(projectId),
      },
    };
  }

  row(projectId: string, pageId: string): SubindexRow | null {
    return this.rows(projectId, this.baseNow(projectId)).find((r) => r.id === pageId) ?? null;
  }

  // ============================================================================================ decisions

  /** One decision on one row (the owner only, on the dashboard). Audited `nationsubindex.decide`. */
  decide(
    actor: string,
    projectId: string,
    i: {
      readonly pageId: string;
      readonly action: 'accept' | 'map' | 'specialist' | 'not_subindex';
      readonly role?: string;
      readonly reason?: string;
    },
  ): { decision: SubindexDecision; row: SubindexRow } {
    if (actor !== 'owner')
      throw new NationTaxonomyError('NOT_OWNER', 'Only the owner decides a nation’s subindexes.');
    const base = this.baseNow(projectId);
    const row = this.rows(projectId, base).find((r) => r.id === i.pageId);
    if (!row)
      throw new NationTaxonomyError(
        'NOT_A_CANDIDATE',
        `${i.pageId} is not a child index of a nation now (or the Index Classification approved it as a subject index).`,
      );
    let role: string | null = null;
    if (i.action === 'accept') {
      if (!row.match)
        throw new NationTaxonomyError(
          'NOTHING_MATCHED',
          `${row.name} matches no nation role: map it to a role, keep it as a specialist subindex, or rule it not a subindex.`,
        );
      role = row.match.role;
    } else if (i.action === 'map') {
      role = i.role ? canonicalRole(base.tax, i.role) : null;
      if (!role)
        throw new NationTaxonomyError(
          'ROLE_UNKNOWN',
          `Say which role: ${nationRolesOf(base.tax).join('; ')}.`,
          { roles: nationRolesOf(base.tax) },
        );
    }
    const before = this.decisions.decision(projectId, i.pageId);
    const nat = base.nations.find((n) => n.id === row.nation.id)!;
    const decision = this.decisions.put(projectId, actor, {
      pageId: i.pageId,
      nationId: row.nation.id,
      pageName: row.name,
      action: i.action,
      role,
      proposedName: role ? unifiedName(nat, role) : null,
      via: i.action,
      reason: i.reason ?? '',
    });
    this.d.audit(
      actor,
      'nationsubindex.decide',
      projectId,
      before ? { action: before.action, role: before.role } : null,
      { page: { id: i.pageId, name: row.name }, nation: row.nation.name, action: i.action, role },
    );
    return { decision, row: this.row(projectId, i.pageId)! };
  }

  /**
   * "Map to a role, for every page with this name": every nation's child of exactly this display name not decided yet,
   * in ONE transaction, at most NATION_SUBINDEX_BULK_MAX rows (BULK_TOO_LARGE above), idempotent.
   */
  mapAll(
    actor: string,
    projectId: string,
    i: { readonly pageId: string; readonly role: string; readonly reason?: string },
  ): {
    decisions: SubindexDecision[];
    rows: SubindexRow[];
    skipped: { id: string; reason: string }[];
    max: number;
  } {
    if (actor !== 'owner')
      throw new NationTaxonomyError('NOT_OWNER', 'Only the owner decides a nation’s subindexes.');
    const base = this.baseNow(projectId);
    const all = this.rows(projectId, base);
    const row = all.find((r) => r.id === i.pageId);
    if (!row)
      throw new NationTaxonomyError('NOT_A_CANDIDATE', `${i.pageId} is not a child index of a nation now.`);
    const role = canonicalRole(base.tax, i.role);
    if (!role)
      throw new NationTaxonomyError(
        'ROLE_UNKNOWN',
        `Say which role: ${nationRolesOf(base.tax).join('; ')}.`,
        {
          roles: nationRolesOf(base.tax),
        },
      );
    const k = roleKey(row.displayName);
    const same = all.filter((r) => roleKey(r.displayName) === k);
    const skipped = same
      .filter((r) => r.decision !== null && r.id !== i.pageId)
      .map((r) => ({ id: r.id, reason: 'already_decided' }));
    const take = same.filter((r) => r.decision === null || r.id === i.pageId);
    const max = this.bulkMax();
    if (take.length > max)
      throw new NationTaxonomyError(
        'BULK_TOO_LARGE',
        `${take.length} pages are named “${row.displayName}”; at most ${max} are mapped in one request (NATION_SUBINDEX_BULK_MAX).`,
        { max },
      );
    const nations = new Map(base.nations.map((n) => [n.id, n]));
    const decisions = this.decisions.putMany(
      projectId,
      actor,
      take.map((r) => ({
        pageId: r.id,
        nationId: r.nation.id,
        pageName: r.name,
        action: 'map' as const,
        role,
        proposedName: unifiedName(nations.get(r.nation.id)!, role),
        via: 'map_all' as const,
        reason: i.reason ?? '',
      })),
    );
    this.d.audit(actor, 'nationsubindex.map_all', projectId, null, {
      name: row.displayName,
      role,
      pages: decisions.map((x) => x.pageId),
    });
    const ids = new Set(decisions.map((x) => x.pageId));
    return {
      decisions,
      rows: this.rows(projectId, this.baseNow(projectId)).filter((r) => ids.has(r.id)),
      skipped,
      max,
    };
  }

  /**
   * The rows "Accept all matched" takes: undecided, matched by a role name or an approved variant (never an owner's
   * mapping, which is a decision already), with no collision and an approved [NAV] classification. Never an unmatched,
   * colliding or unapproved row. Within the page's filter (its status aside).
   */
  acceptable(projectId: string, filter: Omit<SubindexFilter, 'status'> = {}): SubindexRow[] {
    const base = this.baseNow(projectId);
    return NationTaxonomyService.filtered(this.rows(projectId, base), {
      ...filter,
      status: ['proposed'],
    }).filter(
      (r) =>
        r.decision === null &&
        r.match !== null &&
        (r.match.via === 'role' || r.match.via === 'variant') &&
        r.collision.length === 0 &&
        r.classification === 'nav',
    );
  }

  /** Rows decided per transaction by "Accept all matched", with a yield to the event loop between batches. */
  static readonly ACCEPT_BATCH = 25;

  /**
   * "Accept all matched" (audited `nationsubindex.accept_all`): ONE request, by ids (the page sends the rows
   * its GET counted) or every acceptable row of the filter; at most NATION_SUBINDEX_BULK_MAX (the rest counted as
   * `remaining`). The rows are read ONCE at the start (F6a.1's lesson: no per-row rebuild); each batch is one transaction,
   * every row in it checked again against the decisions store (one decided meanwhile is skipped); a yield between
   * batches; the rows rebuilt ONCE at the end. Idempotent. Each decision is an ordinary accept (`via` `accept_all`), so
   * Undo works per row as for a single accept.
   */
  async acceptAllMatched(
    actor: string,
    projectId: string,
    o: Omit<SubindexFilter, 'status'> & { readonly ids?: readonly string[]; readonly reason?: string } = {},
  ): Promise<{
    readonly accepted: readonly SubindexDecision[];
    readonly rows: readonly SubindexRow[];
    readonly skipped: readonly { readonly id: string; readonly reason: string }[];
    readonly remaining: number;
    readonly max: number;
  }> {
    if (actor !== 'owner')
      throw new NationTaxonomyError('NOT_OWNER', 'Only the owner decides a nation’s subindexes.');
    const max = this.bulkMax();
    const base = this.baseNow(projectId);
    const eligible = this.acceptable(projectId, o);
    const byId = new Map(eligible.map((r) => [r.id, r]));
    const skipped: { id: string; reason: string }[] = [];
    let take: SubindexRow[];
    if (o.ids) {
      const all = new Map(this.rows(projectId, base).map((r) => [r.id, r]));
      take = [];
      for (const id of [...new Set(o.ids)]) {
        const r = byId.get(id);
        if (r) take.push(r);
        else {
          const x = all.get(id);
          skipped.push({
            id,
            reason: !x
              ? 'not_a_candidate'
              : x.decision
                ? 'already_decided'
                : !x.match
                  ? 'unmatched'
                  : x.collision.length > 0
                    ? 'collision'
                    : x.classification !== 'nav'
                      ? 'classification_not_approved'
                      : 'not_acceptable',
          });
        }
      }
    } else take = eligible;
    const now = take.slice(0, max);
    const nations = new Map(base.nations.map((n) => [n.id, n]));
    const accepted: SubindexDecision[] = [];
    for (let i = 0; i < now.length; i += NationTaxonomyService.ACCEPT_BATCH) {
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const batch = now.slice(i, i + NationTaxonomyService.ACCEPT_BATCH).filter((r) => {
        if (this.decisions.decision(projectId, r.id) === null) return true;
        skipped.push({ id: r.id, reason: 'already_decided' });
        return false;
      });
      accepted.push(
        ...this.decisions.putMany(
          projectId,
          actor,
          batch.map((r) => ({
            pageId: r.id,
            nationId: r.nation.id,
            pageName: r.name,
            action: 'accept' as const,
            role: r.match!.role,
            proposedName: unifiedName(nations.get(r.nation.id)!, r.match!.role),
            via: 'accept_all' as const,
            reason: o.reason ?? '',
          })),
        ),
      );
    }
    if (accepted.length > 0)
      this.d.audit(actor, 'nationsubindex.accept_all', projectId, null, {
        accepted: accepted.length,
        pages: accepted.map((x) => x.pageId),
      });
    const ids = new Set(accepted.map((x) => x.pageId));
    // ONE rebuild of the rows, at the end (from the cached base).
    const rows = this.rows(projectId, this.baseNow(projectId)).filter((r) => ids.has(r.id));
    return { accepted, rows, skipped, remaining: take.length - now.length, max };
  }

  /** Undoes a decision whose rename has not been applied. Audited `nationsubindex.undo`. */
  undo(actor: string, projectId: string, pageId: string): SubindexDecision {
    if (actor !== 'owner') throw new NationTaxonomyError('NOT_OWNER', 'Only the owner undoes a decision.');
    const d = this.decisions.decision(projectId, pageId);
    if (!d) throw new NationTaxonomyError('DECISION_NOT_FOUND', `No decision on ${pageId}.`);
    const applied = this.decisions.appliedWrites(projectId, d.id);
    if (applied > 0)
      throw new NationTaxonomyError(
        'DECISION_APPLIED',
        `${d.pageName} was renamed by this decision already: it cannot be undone (Revert that write on the Review page first, if that is what you want).`,
      );
    this.decisions.remove(projectId, pageId);
    this.d.audit(actor, 'nationsubindex.undo', projectId, d, null);
    return d;
  }

  /** A decision as it stands now, for the rename fix's stale check (null: none). */
  decisionNow(projectId: string, pageId: string): SubindexDecision | null {
    return this.decisions.decision(projectId, pageId);
  }

  // ============================================================================================ F6b's classifier

  /** The owner's mappings, specialist names and short names, for F6b's nation subindex rule. */
  classifierInput(projectId: string): {
    readonly key: string;
    readonly mappings: readonly { readonly name: string; readonly role: string }[];
    readonly specialists: readonly string[];
    readonly shortNames: ReadonlyMap<string, string>;
  } | null {
    const ds = this.decisions.decisions(projectId);
    const shortNames = this.shortNames(projectId);
    if (ds.length === 0 && shortNames.size === 0) return null;
    const display = (raw: string) => classifyName(raw).displayName;
    return {
      key: `${this.decisions.version()}:${ds.length}:${[...shortNames.entries()].map(([a, b]) => `${a}=${b}`).join(',')}`,
      mappings: ds
        .filter((x) => x.action === 'map' && x.role)
        .map((x) => ({ name: display(x.pageName), role: x.role! })),
      specialists: ds.filter((x) => x.action === 'specialist').map((x) => display(x.pageName)),
      shortNames,
    };
  }

  // ============================================================================================ the checks

  /** What the three checks read: from the APPROVED pack only (null: it carries no nation roles). */
  async auditInput(projectId: string): Promise<NationAuditInput | null> {
    const r = this.rulesFor(projectId);
    if (!r || !r.approved || !hasNationRoles(r.tax)) return null;
    const settings = this.d.projectSettings?.(projectId) ?? {};
    const on = (k: string) => settings[k] !== false;
    const store = this.store(projectId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const tt = store.typeByKind('territory');
    const view = this.roleView(projectId);
    const territories =
      tt?.taxonomySeededAt != null
        ? store.entries(tt.id).map((e) => ({
            entryId: e.id,
            nodeId: e.sourceNodeId,
            name: e.plural,
            bindings: new Map(store.bindings(e.id).map((b) => [b.role, b.nodeId])),
          }))
        : [];
    return {
      rules: r.rules,
      tax: r.tax,
      decisions: this.decisions
        .decisions(projectId)
        .filter((x) => (x.action === 'accept' || x.action === 'map') && x.role !== null),
      shortNames: this.shortNames(projectId),
      roles: view,
      territories,
      homeRulings: new Map(this.rulings.rulings(projectId).map((x) => [x.pageId, x.stateHash])),
      checks: {
        nonstandard: on('checkNationSubindexNames'),
        categoryMissing: on('checkTerritoryCategories'),
        categoryHome: on('checkCategoryHomes'),
      },
    };
  }

  /** The owner's "keep it here" for a `category_home_mismatch` page. Audited `audits.keep_home`. */
  keepHome(
    actor: string,
    projectId: string,
    r: { pageId: string; pageName: string; tags: readonly string[]; parentId: string | null; reason: string },
  ) {
    if (actor !== 'owner')
      throw new NationTaxonomyError('NOT_OWNER', 'Only the owner rules where a page stays.');
    const why = r.reason.trim();
    if (why === '') throw new NationTaxonomyError('REASON_REQUIRED', '“Keep it here” needs a reason.');
    const ruling = this.rulings.keep(projectId, actor, { ...r, reason: why });
    this.d.audit(actor, 'audits.keep_home', projectId, null, {
      page: { id: r.pageId, name: r.pageName },
      parentId: r.parentId,
      reason: why.slice(0, 200),
    });
    return ruling;
  }
}

/** F6b's approved classification by page: `nav` or `subject` (approved or changed). */
export function classificationOf(
  decisions: readonly { readonly pageId: string; readonly action: string; readonly role: string | null }[],
): Map<string, 'nav' | 'subject'> {
  const out = new Map<string, 'nav' | 'subject'>();
  for (const d of decisions)
    if (d.action !== 'undecided' && (d.role === 'nav' || d.role === 'subject')) out.set(d.pageId, d.role);
  return out;
}

function childrenOf(scan: readonly NodeScanRow[]): Map<string, NodeScanRow[]> {
  const kids = new Map<string, NodeScanRow[]>();
  for (const n of scan)
    if (n.parentId !== null) {
      const l = kids.get(n.parentId);
      if (l) l.push(n);
      else kids.set(n.parentId, [n]);
    }
  return kids;
}
