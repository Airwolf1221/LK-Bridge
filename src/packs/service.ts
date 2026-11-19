/**
 * The setting packs service (v3 F3a, ADR 0050; PLAN-v2 section 10). It keeps each pack's rules as data, attaches packs to
 * projects, works out each project's template ids, checks the governance sources the rules were derived from, and holds
 * the owner's commands (approve a version, edit the token maps), each audited.
 *
 * Derived, never competing (the Controlled Native Tagging Standard: a machine-readable translation must be "explicitly
 * identified as derived" and must "compare policy version/digest before writing"): the owner's approval records each
 * source's document version; a preview reads the current ones; a job reads them again before it writes. When any differs
 * the pack is "drifted" and tag computation fails closed until the owner approves again.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/index.js';
import { stableJson } from '../jobs/sidebar-state.js';
import type { ProjectView } from '../projects/types.js';
import type { Registry } from '../registry/index.js';
import { cleanPrefixes, templateBaseKey } from '../registry/names.js';
import { DEFAULT_TAG_RULES, type LifecycleTagRules } from '../lifecycle/tags.js';
import { PACK_SEEDS } from './arkona.js';
import { hookFor } from './hooks.js';
import {
  headingKey,
  headingsOf,
  outlineOf,
  pinnedSections,
  type FoundSection,
  type OutlineHeading,
} from './sections.js';
import { PackStore } from './store.js';
import {
  PackError,
  packRulesSchema,
  packToolMode,
  type PackToolMode,
  type GovernanceSource,
  type Pack,
  type PackApproval,
  type PackAttachment,
  type PackDrift,
  type PackRules,
  type PackSeed,
} from './types.js';

export interface PacksDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'internalRead'>;
  /** The bridge's projects (names, ids, whether served). */
  readonly projects: { list(): ProjectView[]; activeIds(): string[] };
  readonly registry: Pick<Registry, 'forProject'>;
  /** The audit log (`PolicyStore.audit`). */
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now?: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** The seeds offered (default: the bridge's own, the Arkona pack). Tests pass their own. */
  readonly seeds?: readonly PackSeed[];
}

/** One governance source as checked now. */
export interface SourceStatus {
  readonly key: string;
  readonly name: string;
  readonly label?: string;
  readonly project: string;
  readonly resourceId: string;
  readonly documentId: string;
  readonly approved: string | null;
  readonly current: string | null;
  /** A SHA-256 of the document's blocks as read now (its digest), when read. */
  readonly digest: string | null;
  readonly state: 'same' | 'changed' | 'unreadable' | 'unapproved';
  readonly reason?: string;
  /**
   * v3 F3b (ADR 0052): the pinned sections, each as read now: `same`, `changed` (its digest differs from the approved
   * one), `missing` (no such heading now), `unapproved` (no approved digest yet). Absent when the source pins none.
   */
  readonly sections?: readonly {
    readonly heading: string;
    readonly found: string | null;
    /** CR-2026-11-R2 (R2-33): `ambiguous`: two or more headings of the page match the pin (no section is chosen). */
    readonly state: 'same' | 'changed' | 'missing' | 'unapproved' | 'ambiguous';
  }[];
  /**
   * ADR 0052 amendment (16 November 2026): the document's headings in order, with their levels, when a pinned section
   * is missing: the Packs page offers them in a picker so the owner can re-map the pin.
   */
  readonly outline?: readonly OutlineHeading[];
}

export interface GovernanceStatus {
  /** `current`: approved and every source as approved. Anything else fails tag computation closed. */
  readonly state: 'current' | 'changed' | 'unapproved' | 'rules_changed' | 'unreadable';
  readonly message: string;
  readonly sources: readonly SourceStatus[];
  /** The pack version the status is about, and the approved one. */
  readonly version: number;
  readonly approvedVersion: number | null;
}

export interface PackView extends Pack {
  readonly attachments: readonly (PackAttachment & {
    readonly projectName: string;
    readonly served: boolean;
  })[];
  readonly tools: readonly string[];
  /**
   * v3 F3.4 (ADR 0055 decision D): each write tool's switch, as the Packs page shows it: `propose` (every package is a
   * proposal whatever the agent's scope) or `scope` (it follows the agent's scope), and whether that is the tool's own
   * switch or `alwaysPropose` (the default for a tool not named).
   */
  readonly toolModes: readonly {
    readonly tool: string;
    readonly mode: PackToolMode;
    readonly source: 'switch' | 'default';
  }[];
}

const ACTOR_OWNER = 'owner';

/** v3 F3.4: pack tools that never write (their switch would mean nothing), by the name after the prefix. */
const READ_ONLY_PACK_TOOLS: ReadonlySet<string> = new Set(['character_brief']);

export interface Packs {
  readonly store: PackStore;
  /** Told after a pack is stored, attached, or its rules or approval change (the runtime keeps its tools in step). */
  onChange(fn: () => void): () => void;
  /** Stores missing packs from their seeds and attaches them to the projects the seeds name (idempotent). */
  ensureSeeded(): void;
  list(): PackView[];
  get(id: string): Pack | null;
  view(id: string): PackView | null;
  /** The packs attached to a project. */
  forProject(projectId: string): Pack[];
  attachment(packId: string, projectId: string): PackAttachment | null;
  /**
   * v3 F3d (ADR 0053): the lifecycle tag rules of a project, from the APPROVED version of the packs attached to it (the
   * first by pack id that says anything): where the lifecycle tag goes (`lifecycleTagPosition`, by the project's name)
   * and the AU ruling (`tags.au`). A project with no attached pack, or none approved yet, gets the defaults (`append`,
   * no AU ruling: ADR 0035 exactly). Read by the lifecycle tools, the lifecycle guard and the audit. Never throws.
   */
  lifecycleRules(projectId: string): LifecycleTagRules;
  /**
   * v3 F3.4 (ADR 0055 decision D): a write tool's switch in the version of the pack the owner APPROVED (a newer version
   * waiting for approval does not apply yet); `propose` while none is approved or the pack is not known (fails closed).
   * For the tools that do not refuse a pack waiting for approval (`arkona_appraisal_fix`); the package tools use the
   * current rules, which they run only once approved.
   */
  toolMode(packId: string, tool: string): PackToolMode;
  /**
   * CR-2026-11-R2 (R2-29, R2-35): the stricter of the approved version's switch and the current version's (one waiting
   * for approval): `propose` when either says so. A switch the owner tightened applies at once; one loosened waits for
   * the approval. `propose` while none is approved or the pack is not known (fails closed).
   */
  strictToolMode(packId: string, tool: string): PackToolMode;
  /** The full tool names of a pack (`arkona_create_character`). */
  toolsOf(pack: Pack): string[];
  /** Whether a pack tool is listed: its pack is attached to at least one project served now. */
  toolListed(packId: string): boolean;
  /** Reads every governance source's current version (one read each) and records any drift. */
  governance(packId: string, o?: { signal?: AbortSignal }): Promise<GovernanceStatus>;
  readonly commands: {
    /** The owner approves the CURRENT version: governance versions recorded, templates worked out again. Audited. */
    approve(actor: string, packId: string): Promise<{ pack: Pack; governance: GovernanceStatus }>;
    /** The owner edits the race and culture token maps: a new version, waiting for approval. Audited. */
    setTokens(
      actor: string,
      packId: string,
      maps: {
        readonly race?: Readonly<Record<string, string>>;
        readonly culture?: Readonly<Record<string, string>>;
        /** v3 F3f (ADR 0060): the Tagging Standard's Excluded Routine Tags, as the owner lists them. */
        readonly excludedRoutineTags?: readonly string[];
      },
    ): Pack;
    /** Attaches a pack to a project (bridge code and tests; the dashboard does not offer it in F3a). Audited. */
    attach(
      actor: string,
      packId: string,
      projectId: string,
      templates?: Readonly<Record<string, string | null>>,
    ): PackAttachment;
    /**
     * ADR 0052 amendment (16 November 2026): the owner re-maps a pinned heading of a governance source to one of the
     * document's actual headings (read now; matched whole, never by prefix). A new version with the new mapping, which
     * waits for the owner's approval with the rest of the version. Audited with the old heading and the new one.
     */
    remapSection(
      actor: string,
      packId: string,
      change: { readonly source: string; readonly from: string; readonly to: string },
    ): Promise<{ pack: Pack; governance: GovernanceStatus }>;
    /** Replaces a pack's rules (the owner's command, used by the tests; never an agent). A new version. Audited. */
    replaceRules(actor: string, packId: string, rules: PackRules, reason: string): Pack;
    /**
     * v3 F3d (renames), ADR 0058 decision D3: the token change of a culture or race rename the owner approved: the map's
     * entry for the old value renamed to the new value, with the new token. A new version, waiting for the owner's
     * approval on the Packs page like any other (the rename's job waits for it). Audited as `pack.rename_token`.
     */
    renameToken(
      actor: string,
      packId: string,
      change: {
        readonly map: 'race' | 'culture';
        readonly from: string;
        readonly to: string;
        readonly token: string;
        readonly reason: string;
      },
    ): Pack;
    /**
     * v3 F3.4 (ADR 0055 decision D): the owner sets write tools' switches (`propose`: always a proposal; `scope`: the
     * agent's scope). A new version, waiting for approval as usual (until then every package is refused, as for any
     * new version). Audited as `pack.set_tool_modes` with the switches before and after. Unchanged: the pack as it is.
     */
    setToolModes(actor: string, packId: string, modes: Readonly<Record<string, PackToolMode>>): Pack;
  };
}

/** The digest of a document's blocks (stable JSON, SHA-256). */
export function blocksDigest(blocks: unknown): string {
  return createHash('sha256')
    .update(stableJson(blocks ?? []))
    .digest('hex');
}

export function createPacks(d: PacksDeps): Packs {
  const now = d.now ?? (() => Date.now());
  const store = new PackStore(d.db, now);
  const seeds = d.seeds ?? PACK_SEEDS;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        d.log?.warn({ err: e }, 'a pack change listener failed');
      }
    }
  };

  const projectByName = (name: string): ProjectView | undefined =>
    d.projects.list().find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status !== 'archived');
  const projectName = (id: string): string => d.projects.list().find((p) => p.id === id)?.name ?? id;

  /**
   * A project's template ids for a pack, by role: given ids where the seed has them, else worked out from the home
   * project's: each home template's name (from the registry's last read of the home project's templates) matched,
   * exactly and ignoring the word "Template", against this project's templates. Names come from data, never code.
   */
  const deriveTemplates = (
    seed: PackSeed | undefined,
    homeTemplates: Readonly<Record<string, string | null>>,
    projectId: string,
    given?: Readonly<Record<string, string>>,
    /** v3 F3b: only these roles (an attachment's missing ones); default every role the home ids and seed name. */
    only?: readonly string[],
  ): { templates: Record<string, string | null>; notes: string[] } => {
    const notes: string[] = [];
    const templates: Record<string, string | null> = {};
    const home = seed ? projectByName(seed.home) : undefined;
    const homeSnapshot = home?.id != null ? d.registry.forProject(home.id).store.templates().templates : [];
    const target = d.registry.forProject(projectId).store.templates();
    const named = seed?.templateNames ?? {};
    const roles = only ?? [...new Set([...Object.keys(homeTemplates), ...Object.keys(named)])];
    for (const role of roles) {
      const homeId = homeTemplates[role] ?? null;
      const g = given?.[role];
      if (g) {
        templates[role] = g;
        continue;
      }
      if (!homeId && !named[role]) {
        templates[role] = null;
        notes.push(`${role}: the home project has no template for this role.`);
        continue;
      }
      // v3 F3b (ADR 0052): a role the seed names by template name is worked out by that name, in every project.
      const name =
        (homeId ? homeSnapshot.find((t) => t.id === homeId)?.name : undefined) ?? named[role] ?? null;
      if (!name) {
        templates[role] = null;
        notes.push(
          `${role}: the home project's template ${homeId} is not in its templates as last read (Repository Mappings: refresh templates on ${seed?.home ?? 'the home project'}), so this project's could not be worked out.`,
        );
        continue;
      }
      const want = templateBaseKey(cleanPrefixes(name).name);
      const hits = target.templates.filter((t) => templateBaseKey(cleanPrefixes(t.name).name) === want);
      if (hits.length === 1) templates[role] = hits[0]!.id;
      else {
        templates[role] = null;
        notes.push(
          hits.length === 0
            ? `${role}: no template named like “${name}” in this project${target.readAt === null ? ' (its templates have not been read: Repository Mappings, refresh templates)' : ''}.`
            : `${role}: ${hits.length} templates are named like “${name}” in this project.`,
        );
      }
    }
    return { templates, notes };
  };

  const seedOf = (packId: string) => seeds.find((s) => s.id === packId);

  const ensureSeeded = (): void => {
    let any = false;
    for (const s of seeds) {
      const stored = store.get(s.id);
      if (!stored) {
        store.insert({
          id: s.id,
          name: s.name,
          prefix: s.prefix,
          rules: s.rules,
          governance: s.governance,
          seed: s.seed,
        });
        d.audit('system', 'pack.seed', s.id, undefined, { version: 1, seed: s.seed });
        any = true;
      } else if (
        stored.seed !== s.seed &&
        stored.seed !== null &&
        (s.supersedes ?? []).includes(stored.seed)
      ) {
        // v3 F3b (ADR 0052): a newer seed is OFFERED as a new version, never approved here: the owner's token maps are
        // kept, the governance sources keep their stored places and take the seed's names and pinned sections.
        const rules = packRulesSchema.parse({
          ...s.rules,
          tags: { ...s.rules.tags, race: stored.rules.tags.race, culture: stored.rules.tags.culture },
        });
        const governance = mergeGovernance(stored.governance, s.governance);
        const after = store.upgrade(
          s.id,
          rules,
          governance,
          s.seed,
          `seed ${s.seed} (replaces ${stored.seed}): offered for the owner's approval; the token maps kept`,
        );
        d.audit(
          'system',
          'pack.seed_upgrade',
          s.id,
          { version: stored.version, seed: stored.seed },
          { version: after.version, seed: s.seed },
        );
        any = true;
      }
      const homeGiven =
        s.projects.find((p) => p.name.toLowerCase() === s.home.toLowerCase())?.templates ?? {};
      const needed = templateRolesOf(store.get(s.id)!.rules);
      for (const p of s.projects) {
        const view = projectByName(p.name);
        if (!view || view.id === null) continue;
        const had = store.attachment(s.id, view.id);
        if (had) {
          // v3 F3b: a role the rules now need that the attachment does not map yet is worked out (or noted).
          const missing = needed.filter((r) => !(r in had.templates));
          if (missing.length === 0) continue;
          const extra = deriveTemplates(s, homeGiven, view.id, p.templates, missing);
          store.setTemplates(s.id, view.id, { ...had.templates, ...extra.templates }, [
            ...had.notes,
            ...extra.notes,
          ]);
          d.audit('system', 'pack.attach', s.id, had, {
            project: view.name,
            templates: extra.templates,
            notes: extra.notes,
          });
          any = true;
          continue;
        }
        const { templates, notes } = deriveTemplates(s, homeGiven, view.id, p.templates);
        store.attach(s.id, view.id, templates, notes, 'seed');
        d.audit('system', 'pack.attach', s.id, undefined, { project: view.name, templates, notes });
        any = true;
      }
    }
    if (any) changed();
  };

  /** v3 F3b: the tools a pack offers: its types' tools, the owners' tool and its hooks' own tools (each once). */
  const toolsOf = (pack: Pack) => {
    const out: string[] = [];
    const add = (t: string) => {
      const n = `${pack.prefix}${t}`;
      if (!out.includes(n)) out.push(n);
    };
    for (const t of pack.rules.types) {
      add(t.tool);
      for (const extra of hookFor(t)?.tools ?? []) add(extra);
    }
    if (pack.rules.owners) add(pack.rules.owners.tool);
    return out;
  };

  const viewOf = (pack: Pack): PackView => {
    const active = new Set(d.projects.activeIds());
    return {
      ...pack,
      attachments: store.attachments(pack.id).map((a) => ({
        ...a,
        projectName: projectName(a.projectId),
        served: active.has(a.projectId),
      })),
      tools: toolsOf(pack),
      toolModes: toolModesOf(pack),
    };
  };

  /** v3 F3.4: the write tools' switches (the pack's own write tools, then any other tool a switch names). */
  const toolModesOf = (pack: Pack): PackView['toolModes'] => {
    const named = pack.rules.settings.tools ?? {};
    const names = [
      ...toolsOf(pack).filter((t) => !READ_ONLY_PACK_TOOLS.has(t.slice(pack.prefix.length))),
      ...Object.keys(named),
    ];
    return [...new Set(names)].map((tool) => ({
      tool,
      mode: packToolMode(pack.rules, tool),
      source: named[tool] !== undefined ? ('switch' as const) : ('default' as const),
    }));
  };

  const readSource = async (
    src: GovernanceSource,
    signal?: AbortSignal,
  ): Promise<{
    version: string | null;
    digest: string | null;
    reason?: string;
    /** v3 F3b: each pinned section as read now (empty when the source pins none or could not be read). */
    sections: FoundSection[];
    headings: string[];
    /** ADR 0052 amendment: the document's outline (empty when the source pins none or could not be read). */
    outline: OutlineHeading[];
  }> => {
    const none = {
      sections: [] as FoundSection[],
      headings: [] as string[],
      outline: [] as OutlineHeading[],
    };
    const p = projectByName(src.project);
    if (!p || p.id === null)
      return { version: null, digest: null, reason: `project ${src.project} is not registered`, ...none };
    if (!d.projects.activeIds().includes(p.id))
      return { version: null, digest: null, reason: `project ${src.project} is not served now`, ...none };
    try {
      const r = (await d.engine.internalRead(
        p.id,
        'getDocumentBlocks',
        { path: { resourceId: src.resourceId, documentId: src.documentId } },
        { priority: 'P1', notFoundIsAnswer: true, ...(signal ? { signal } : {}) },
      )) as { version?: unknown; blocks?: unknown } | null;
      if (!r || typeof r.version !== 'string')
        return { version: null, digest: null, reason: 'the document is gone or has no version', ...none };
      return {
        version: r.version,
        digest: blocksDigest(r.blocks),
        sections: pinnedSections(r.blocks, src.sections ?? []),
        headings: (src.sections ?? []).length > 0 ? headingsOf(r.blocks) : [],
        outline: (src.sections ?? []).length > 0 ? outlineOf(r.blocks) : [],
      };
    } catch (e) {
      return { version: null, digest: null, reason: e instanceof Error ? e.message : String(e), ...none };
    }
  };

  /** The pinned sections read at the last governance check, by source key (for the owner's approval). */
  const lastSections = new Map<string, { sections: FoundSection[]; headings: string[] }>();

  const governance = async (packId: string, o: { signal?: AbortSignal } = {}): Promise<GovernanceStatus> => {
    const pack = store.get(packId);
    if (!pack) throw new PackError('PACK_NOT_FOUND', `No pack ${packId}.`);
    const approved = pack.approved;
    const sources: SourceStatus[] = [];
    for (const src of pack.governance) {
      const read = await readSource(src, o.signal);
      lastSections.set(src.key, { sections: read.sections, headings: read.headings });
      const approvedSource = approved?.sources.find((x) => x.key === src.key);
      const was = approvedSource?.version ?? null;
      const state: SourceStatus['state'] =
        read.version === null
          ? 'unreadable'
          : !approved
            ? 'unapproved'
            : was === read.version
              ? 'same'
              : 'changed';
      // v3 F3b (ADR 0052): each pinned section against the digest the approval recorded. The document's version alone
      // decides the source's state (fail closed, as F3a); this says which pinned part moved.
      const sections =
        (src.sections ?? []).length === 0 || read.version === null
          ? undefined
          : read.sections.map((s) => {
              const had = approvedSource?.sections?.find((x) => x.heading === s.heading)?.digest ?? null;
              return {
                heading: s.heading,
                found: s.found,
                state:
                  s.matches > 1
                    ? ('ambiguous' as const)
                    : s.digest === null
                      ? ('missing' as const)
                      : had === null
                        ? ('unapproved' as const)
                        : had === s.digest
                          ? ('same' as const)
                          : ('changed' as const),
              };
            });
      sources.push({
        key: src.key,
        name: src.name,
        ...(src.label ? { label: src.label } : {}),
        project: src.project,
        resourceId: src.resourceId,
        documentId: src.documentId,
        approved: was,
        current: read.version,
        digest: read.digest,
        state,
        ...(read.reason ? { reason: read.reason } : {}),
        ...(sections ? { sections } : {}),
        ...(sections?.some((x) => x.state === 'missing' || x.state === 'ambiguous')
          ? { outline: read.outline }
          : {}),
      });
    }
    /** The changed pinned sections of a changed source, in words. */
    const sectionWords = (s: SourceStatus): string => {
      const moved = (s.sections ?? []).filter(
        (x) => x.state === 'changed' || x.state === 'missing' || x.state === 'ambiguous',
      );
      if (!s.sections || s.sections.length === 0) return s.name;
      if (moved.length === 0) return `${s.name} (outside its pinned sections)`;
      return `${s.name} (pinned section${moved.length === 1 ? '' : 's'} ${moved
        .map(
          (x) =>
            `“${x.heading}”${x.state === 'missing' ? ' gone' : x.state === 'ambiguous' ? ' now appears more than once' : ''}`,
        )
        .join(', ')})`;
    };
    const base = { sources, version: pack.version, approvedVersion: approved?.version ?? null };
    let out: GovernanceStatus;
    if (!approved) {
      out = {
        ...base,
        state: 'unapproved',
        message: `The ${pack.name} pack has not been approved yet. The owner approves it on the Packs page; until then no tags are computed.`,
      };
    } else if (approved.version !== pack.version) {
      out = {
        ...base,
        state: 'rules_changed',
        message: `The ${pack.name} pack's rules changed since the owner approved version ${approved.version} (now version ${pack.version}). The owner approves the new version on the Packs page; until then no tags are computed.`,
      };
    } else if (sources.some((s) => s.state === 'changed')) {
      const changed = sources.filter((s) => s.state === 'changed');
      out = {
        ...base,
        state: 'changed',
        message: `Arkona's governance changed since the owner approved the ${pack.name} pack: ${changed.map(sectionWords).join(', ')}. Tags are not computed until the owner checks the rules and approves the pack again on the Packs page.`,
      };
    } else if (sources.some((s) => s.state === 'unreadable')) {
      out = {
        ...base,
        state: 'unreadable',
        message: `The ${pack.name} pack's governance sources could not all be read (${sources
          .filter((s) => s.state === 'unreadable')
          .map((s) => `${s.name}: ${s.reason ?? 'unreadable'}`)
          .join(
            '; ',
          )}), so the bridge cannot tell whether they changed. No tags are computed until they can be read.`,
      };
    } else {
      out = {
        ...base,
        state: 'current',
        message: 'The pack is approved and its governance sources are as approved.',
      };
    }
    // A drift seen is recorded (the Packs page shows it); an approved, current pack clears an old one.
    if (out.state === 'changed') {
      const drift: PackDrift = {
        at: now(),
        changed: sources
          .filter((s) => s.state === 'changed')
          .map((s) => ({
            key: s.key,
            name: s.name,
            approved: s.approved,
            current: s.current,
            ...(s.sections
              ? {
                  sections: s.sections
                    .filter((x) => x.state === 'changed' || x.state === 'missing' || x.state === 'ambiguous')
                    .map((x) => x.heading),
                }
              : {}),
          })),
      };
      const had = pack.drift;
      if (!had || stableJson(had.changed) !== stableJson(drift.changed)) {
        store.setDrift(pack.id, drift);
        d.audit('system', 'pack.drift', pack.id, undefined, drift);
      }
    } else if (out.state === 'current' && pack.drift) store.setDrift(pack.id, null);
    return out;
  };

  const requirePack = (packId: string): Pack => {
    const p = store.get(packId);
    if (!p) throw new PackError('PACK_NOT_FOUND', `No pack ${packId}.`);
    return p;
  };

  const tokenMap = z_tokenMap;

  /** v3 F3.4 (ADR 0055 decision D): a write tool's switch in the APPROVED version (see `Packs.toolMode`). */
  const approvedToolMode = (packId: string, tool: string): PackToolMode => {
    try {
      const pack = store.get(packId);
      if (!pack?.approved) return 'propose';
      const rules =
        pack.approved.version === pack.version ? pack.rules : store.rulesAt(pack.id, pack.approved.version);
      return rules ? packToolMode(rules, tool) : 'propose';
    } catch (e) {
      d.log?.warn({ err: e, packId, tool }, 'a pack tool switch could not be read; the tool proposes');
      return 'propose';
    }
  };

  return {
    store,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ensureSeeded,
    list: () => store.list().map(viewOf),
    get: (id) => store.get(id),
    view: (id) => {
      const p = store.get(id);
      return p ? viewOf(p) : null;
    },
    forProject: (projectId) =>
      store
        .attachments()
        .filter((a) => a.projectId === projectId)
        .map((a) => store.get(a.packId))
        .filter((p): p is Pack => p !== null),
    attachment: (packId, projectId) => store.attachment(packId, projectId),
    toolMode: approvedToolMode,
    strictToolMode: (packId, tool) => {
      if (approvedToolMode(packId, tool) === 'propose') return 'propose';
      try {
        const pack = store.get(packId);
        return pack ? packToolMode(pack.rules, tool) : 'propose';
      } catch {
        return 'propose';
      }
    },
    lifecycleRules: (projectId) => {
      try {
        const name = projectName(projectId).toLowerCase();
        let position: LifecycleTagRules['position'] | null = null;
        let au: LifecycleTagRules['au'] = null;
        let source: LifecycleTagRules['source'] = null;
        for (const a of store.attachments().filter((x) => x.projectId === projectId)) {
          const pack = store.get(a.packId);
          if (!pack?.approved) continue;
          // The rules the owner approved (a newer version waiting for approval does not apply yet).
          const rules =
            pack.approved.version === pack.version
              ? pack.rules
              : store.rulesAt(pack.id, pack.approved.version);
          if (!rules) continue;
          const here = Object.entries(rules.lifecycleTagPosition ?? {}).find(
            ([k]) => k.toLowerCase() === name,
          )?.[1];
          if (position === null && here !== undefined) position = here;
          if (au === null && rules.tags.au) au = { ...rules.tags.au };
          if (source === null && (here !== undefined || rules.tags.au))
            source = { pack: pack.id, version: pack.approved.version };
        }
        return { position: position ?? 'append', au, source };
      } catch (e) {
        d.log?.warn({ err: e, projectId }, 'the lifecycle tag rules could not be read; the defaults apply');
        return DEFAULT_TAG_RULES;
      }
    },
    toolsOf,
    toolListed: (packId) => {
      const active = new Set(d.projects.activeIds());
      return store.attachments(packId).some((a) => active.has(a.projectId));
    },
    governance,
    commands: {
      async approve(actor, packId) {
        if (actor !== ACTOR_OWNER) throw new PackError('NOT_OWNER', 'Only the owner approves a pack.');
        const pack = requirePack(packId);
        const status = await governance(packId);
        const unreadable = status.sources.filter((s) => s.current === null);
        if (unreadable.length > 0) {
          throw new PackError(
            'GOVERNANCE_UNREADABLE',
            `The pack cannot be approved: ${unreadable.map((s) => `${s.name} (${s.reason ?? 'unreadable'})`).join('; ')}. The approval records each source's version, so each must be read.`,
            { sources: status.sources },
          );
        }
        // v3 F3b (ADR 0052): every pinned section must be found, or there is nothing to pin (fail closed).
        const missing = status.sources.flatMap((s) =>
          (s.sections ?? [])
            .filter((x) => x.state === 'missing')
            .map((x) => ({ source: s.name, key: s.key, heading: x.heading })),
        );
        if (missing.length > 0) {
          throw new PackError(
            'GOVERNANCE_SECTION_MISSING',
            `The pack cannot be approved: ${missing.map((m) => `${m.source} has no section “${m.heading}”`).join('; ')}. The pack's rules were derived from these sections; check the governance page, or pick the section's heading as the page has it now (Packs page: re-map the pinned heading).`,
            {
              missing,
              headings: Object.fromEntries(
                [...new Set(missing.map((m) => m.key))].map((k) => [k, lastSections.get(k)?.headings ?? []]),
              ),
              // ADR 0052 amendment: each source's outline (headings in order, with levels) for the Packs page's
              // picker, and the governance status it was read in.
              outline: Object.fromEntries(
                status.sources.filter((s) => s.outline).map((s) => [s.key, s.outline]),
              ),
              governance: status,
            },
          );
        }
        // CR-2026-11-R2 (R2-33): a pin must be unambiguous: a heading the page has twice or more is refused until one is
        // left (the owner renames the other on the page, or re-maps the pin to a heading the page has once).
        const ambiguous = status.sources.flatMap((s) =>
          (s.sections ?? [])
            .filter((x) => x.state === 'ambiguous')
            .map((x) => ({ source: s.name, key: s.key, heading: x.heading })),
        );
        if (ambiguous.length > 0) {
          throw new PackError(
            'GOVERNANCE_SECTION_AMBIGUOUS',
            `The pack cannot be approved: ${ambiguous.map((m) => `${m.source} has more than one section “${m.heading}”`).join('; ')}. A pinned section must be unambiguous: rename the other heading on the governance page, or re-map the pin on the Packs page to a heading the page has once.`,
            {
              ambiguous,
              outline: Object.fromEntries(
                status.sources.filter((s) => s.outline).map((s) => [s.key, s.outline]),
              ),
              governance: status,
            },
          );
        }
        // Work out the templates again for every attachment whose template ids are not all known (v3 F3b: and every
        // role the rules now need that it does not map yet).
        const seed = seedOf(pack.id);
        const homeGiven = seed?.projects.find(
          (p) => p.name.toLowerCase() === seed.home.toLowerCase(),
        )?.templates;
        const needed = templateRolesOf(pack.rules);
        for (const a of store.attachments(pack.id)) {
          const unmapped = needed.filter((r) => !(r in a.templates));
          if (
            unmapped.length === 0 &&
            Object.values(a.templates).every((v) => v !== null) &&
            Object.keys(a.templates).length > 0
          )
            continue;
          const given = Object.fromEntries(
            Object.entries(a.templates).filter((e): e is [string, string] => e[1] !== null),
          );
          const roles = [...new Set([...Object.keys(a.templates), ...needed])];
          const derived = deriveTemplates(seed, homeGiven ?? a.templates, a.projectId, given, roles);
          store.setTemplates(pack.id, a.projectId, derived.templates, derived.notes);
        }
        const approval: PackApproval = {
          version: pack.version,
          at: now(),
          by: actor,
          sources: status.sources.map((s) => {
            const pinned = (lastSections.get(s.key)?.sections ?? []).filter(
              (x): x is FoundSection & { digest: string } => x.digest !== null,
            );
            return {
              key: s.key,
              version: s.current!,
              ...(pinned.length > 0
                ? { sections: pinned.map((x) => ({ heading: x.heading, digest: x.digest })) }
                : {}),
            };
          }),
        };
        const before = pack.approved;
        const after = store.approve(pack.id, approval);
        d.audit(actor, 'pack.approve', pack.id, before, {
          ...approval,
          sources: status.sources.map((s) => ({
            key: s.key,
            name: s.name,
            version: s.current,
            digest: s.digest,
          })),
        });
        changed();
        return { pack: after, governance: await governance(pack.id) };
      },
      setTokens(actor, packId, maps) {
        if (actor !== ACTOR_OWNER) throw new PackError('NOT_OWNER', 'Only the owner edits a pack.');
        const pack = requirePack(packId);
        const race = maps.race !== undefined ? tokenMap(maps.race, 'race') : pack.rules.tags.race;
        const culture =
          maps.culture !== undefined ? tokenMap(maps.culture, 'culture') : pack.rules.tags.culture;
        const never = new Set(pack.rules.tags.never.map((t) => t.toLowerCase()));
        for (const [k, v] of [...Object.entries(race), ...Object.entries(culture)]) {
          if (never.has(v.toLowerCase()))
            throw new PackError('INVALID_TOKEN', `“${k}” maps to “${v}”, which is never a tag.`);
        }
        // v3 F3f (ADR 0060): the Excluded Routine Tags (the retag's only removable tags outside the grammar).
        const routineBefore = pack.rules.retag?.excludedRoutineTags ?? [];
        let routine: string[] = [...routineBefore];
        if (maps.excludedRoutineTags !== undefined) {
          if (!pack.rules.retag)
            throw new PackError(
              'INVALID_INPUT',
              'This pack version has no retag rules, so it has no Excluded Routine Tags.',
            );
          routine = [];
          for (const t of maps.excludedRoutineTags) {
            const v = t.trim();
            if (v === '' || v.length > 100) throw new PackError('INVALID_TOKEN', `“${t}” is not a tag.`);
            if (!routine.some((x) => x.toLowerCase() === v.toLowerCase())) routine.push(v);
          }
        }
        if (
          stableJson(race) === stableJson(pack.rules.tags.race) &&
          stableJson(culture) === stableJson(pack.rules.tags.culture) &&
          stableJson(routine) === stableJson(routineBefore)
        )
          return pack;
        const rules = packRulesSchema.parse({
          ...pack.rules,
          tags: { ...pack.rules.tags, race, culture },
          ...(pack.rules.retag ? { retag: { ...pack.rules.retag, excludedRoutineTags: routine } } : {}),
        });
        const after = store.newVersion(pack.id, rules, 'token maps edited on the Packs page');
        d.audit(
          actor,
          'pack.set_tokens',
          pack.id,
          {
            version: pack.version,
            race: pack.rules.tags.race,
            culture: pack.rules.tags.culture,
            ...(pack.rules.retag ? { excludedRoutineTags: routineBefore } : {}),
          },
          {
            version: after.version,
            race,
            culture,
            ...(pack.rules.retag ? { excludedRoutineTags: routine } : {}),
          },
        );
        changed();
        return after;
      },
      setToolModes(actor, packId, modes) {
        if (actor !== ACTOR_OWNER) throw new PackError('NOT_OWNER', 'Only the owner edits a pack.');
        const pack = requirePack(packId);
        const known = new Set(toolModesOf(pack).map((t) => t.tool));
        const before = pack.rules.settings.tools ?? {};
        const next: Record<string, PackToolMode> = { ...before };
        for (const [tool, mode] of Object.entries(modes)) {
          if (!known.has(tool))
            throw new PackError(
              'UNKNOWN_TOOL',
              `${pack.name} has no write tool “${tool}”. Its write tools: ${[...known].join(', ')}.`,
            );
          if (mode !== 'propose' && mode !== 'scope')
            throw new PackError(
              'INVALID_INPUT',
              `${tool}: “propose” (always a proposal) or “scope” (the agent's scope).`,
            );
          next[tool] = mode;
        }
        if (stableJson(next) === stableJson(before)) return pack;
        const rules = packRulesSchema.parse({
          ...pack.rules,
          settings: { ...pack.rules.settings, tools: next },
        });
        const after = store.newVersion(pack.id, rules, 'tool switches changed on the Packs page');
        d.audit(
          actor,
          'pack.set_tool_modes',
          pack.id,
          { version: pack.version, tools: before },
          { version: after.version, tools: next },
        );
        changed();
        return after;
      },
      attach(actor, packId, projectId, templates) {
        const pack = requirePack(packId);
        const had = store.attachment(pack.id, projectId);
        const seed = seedOf(pack.id);
        const homeGiven =
          seed?.projects.find((p) => p.name.toLowerCase() === seed.home.toLowerCase())?.templates ?? {};
        const derived = templates
          ? { templates: { ...templates }, notes: [] as string[] }
          : deriveTemplates(seed, homeGiven, projectId);
        if (had) store.setTemplates(pack.id, projectId, derived.templates, derived.notes);
        else store.attach(pack.id, projectId, derived.templates, derived.notes, actor);
        d.audit(actor, 'pack.attach', pack.id, had ?? undefined, {
          project: projectName(projectId),
          templates: derived.templates,
          notes: derived.notes,
        });
        changed();
        return store.attachment(pack.id, projectId)!;
      },
      async remapSection(actor, packId, change) {
        if (actor !== ACTOR_OWNER)
          throw new PackError('NOT_OWNER', 'Only the owner re-maps a pinned section.');
        const pack = requirePack(packId);
        const src = pack.governance.find((g) => g.key === change.source);
        if (!src)
          throw new PackError(
            'SOURCE_NOT_FOUND',
            `The ${pack.name} pack has no governance source ${change.source}.`,
          );
        const pinned = src.sections ?? [];
        const at = pinned.indexOf(change.from);
        if (at < 0)
          throw new PackError(
            'SECTION_NOT_PINNED',
            `${src.name} has no pinned section “${change.from}” (pinned: ${pinned.join('; ') || 'none'}).`,
          );
        // The new heading must be one of the document's headings as read now, matched whole (no prefix, no guess).
        const read = await readSource(src);
        if (read.version === null)
          throw new PackError(
            'GOVERNANCE_UNREADABLE',
            `${src.name} could not be read (${read.reason ?? 'unreadable'}), so its headings cannot be checked.`,
          );
        const outline = read.outline;
        const hits = outline.filter((h) => headingKey(h.heading) === headingKey(change.to));
        if (hits.length === 0)
          throw new PackError(
            'HEADING_NOT_FOUND',
            `${src.name} has no heading “${change.to}” now; pick one of its headings.`,
            { outline },
          );
        // CR-2026-11-R2 (R2-33): never re-map to a heading the page has more than once (the pin would be ambiguous).
        if (hits.length > 1)
          throw new PackError(
            'HEADING_AMBIGUOUS',
            `${src.name} has ${hits.length} headings “${change.to}”; a pin must be unambiguous: pick a heading the page has once.`,
            { outline },
          );
        const to = hits[0]!.heading;
        if (pinned.some((h, i) => i !== at && headingKey(h) === headingKey(to)))
          throw new PackError('SECTION_ALREADY_PINNED', `${src.name}'s “${to}” is already pinned.`);
        if (pinned[at] === to) return { pack, governance: await governance(pack.id) };
        const sections = pinned.map((h, i) => (i === at ? to : h));
        const nextGovernance = pack.governance.map((g) => (g.key === src.key ? { ...g, sections } : g));
        const after = store.newGovernanceVersion(
          pack.id,
          nextGovernance,
          `pinned section of ${src.name} re-mapped on the Packs page: “${change.from}” → “${to}”`,
        );
        d.audit(
          actor,
          'pack.remap_section',
          pack.id,
          { version: pack.version, source: src.key, heading: change.from },
          { version: after.version, source: src.key, heading: to },
        );
        changed();
        return { pack: after, governance: await governance(pack.id) };
      },
      renameToken(actor, packId, change) {
        if (actor !== ACTOR_OWNER) throw new PackError('NOT_OWNER', 'Only the owner edits a pack.');
        const pack = requirePack(packId);
        const before = pack.rules.tags[change.map];
        const next: Record<string, string> = {};
        const fromKey = (k: string) => k.trim().toLowerCase() === change.from.trim().toLowerCase();
        for (const [k, v] of Object.entries(before)) if (!fromKey(k)) next[k] = v;
        next[change.to] = change.token;
        const map = tokenMap(next, change.map);
        if (pack.rules.tags.never.some((t) => t.toLowerCase() === change.token.toLowerCase()))
          throw new PackError('INVALID_TOKEN', `“${change.token}” is never a tag.`);
        if (stableJson(map) === stableJson(before)) return pack;
        const rules = packRulesSchema.parse({
          ...pack.rules,
          tags: { ...pack.rules.tags, [change.map]: map },
        });
        const after = store.newVersion(pack.id, rules, change.reason);
        d.audit(
          actor,
          'pack.rename_token',
          pack.id,
          { version: pack.version, map: change.map, [change.map]: before },
          {
            version: after.version,
            from: change.from,
            to: change.to,
            token: change.token,
            reason: change.reason,
          },
        );
        changed();
        return after;
      },
      replaceRules(actor, packId, rules, reason) {
        const pack = requirePack(packId);
        const after = store.newVersion(pack.id, rules, reason);
        d.audit(
          actor,
          'pack.replace_rules',
          pack.id,
          { version: pack.version },
          { version: after.version, reason },
        );
        changed();
        return after;
      },
    },
  };
}

/** v3 F3b: every template role a pack's rules use (its types' roles, the owners' types and their index). */
export function templateRolesOf(rules: PackRules): string[] {
  const out = new Set<string>();
  for (const t of rules.types) for (const r of t.roles) out.add(r.template);
  if (rules.owners) {
    out.add(rules.owners.index.template);
    for (const t of rules.owners.types) out.add(t.template);
  }
  return [...out];
}

/**
 * v3 F3b: a newer seed's governance sources over the stored ones: a source the pack already has keeps its stored place
 * (project, resource, document: a test world points them at its own documents) and takes the seed's name, label and
 * pinned sections; a new source is added; a stored source the seed no longer names is kept.
 */
export function mergeGovernance(
  stored: readonly GovernanceSource[],
  seed: readonly GovernanceSource[],
): GovernanceSource[] {
  const out: GovernanceSource[] = seed.map((s) => {
    const had = stored.find((x) => x.key === s.key);
    return had
      ? { ...s, project: had.project, resourceId: had.resourceId, documentId: had.documentId }
      : { ...s };
  });
  for (const s of stored) if (!out.some((x) => x.key === s.key)) out.push({ ...s });
  return out;
}

/** A token map from the dashboard: keys and tokens trimmed, 1 to 200 characters, at most 500 entries. */
function z_tokenMap(m: Readonly<Record<string, string>>, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(m);
  if (entries.length > 500) throw new PackError('INVALID_TOKEN', `At most 500 ${what} tokens.`);
  const seen = new Set<string>();
  for (const [k, v] of entries) {
    const key = k.replace(/\s+/g, ' ').trim();
    const tok = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (key === '' || key.length > 200 || tok === '' || tok.length > 100)
      throw new PackError(
        'INVALID_TOKEN',
        `A ${what} token needs a value (1 to 200 characters) and a token (1 to 100).`,
      );
    if (/[–—]/.test(key + tok))
      throw new PackError('INVALID_TOKEN', `“${key}”: no em or en dashes in tokens (use a hyphen).`);
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw new PackError('INVALID_TOKEN', `“${key}” is in the ${what} map twice.`);
    seen.add(lower);
    out[key] = tok;
  }
  return out;
}
