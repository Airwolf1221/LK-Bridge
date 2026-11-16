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
import { PACK_SEEDS } from './arkona.js';
import { PackStore } from './store.js';
import {
  PackError,
  packRulesSchema,
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
  readonly audit: (actor: string, action: string, target: string | null, before?: unknown, after?: unknown) => void;
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
  readonly attachments: readonly (PackAttachment & { readonly projectName: string; readonly served: boolean })[];
  readonly tools: readonly string[];
}

const ACTOR_OWNER = 'owner';

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
      },
    ): Pack;
    /** Attaches a pack to a project (bridge code and tests; the dashboard does not offer it in F3a). Audited. */
    attach(
      actor: string,
      packId: string,
      projectId: string,
      templates?: Readonly<Record<string, string | null>>,
    ): PackAttachment;
    /** Replaces a pack's rules (tests and a newer seed; never an agent). A new version. Audited. */
    replaceRules(actor: string, packId: string, rules: PackRules, reason: string): Pack;
  };
}

/** The digest of a document's blocks (stable JSON, SHA-256). */
export function blocksDigest(blocks: unknown): string {
  return createHash('sha256').update(stableJson(blocks ?? [])).digest('hex');
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
  ): { templates: Record<string, string | null>; notes: string[] } => {
    const notes: string[] = [];
    const templates: Record<string, string | null> = {};
    const home = seed ? projectByName(seed.home) : undefined;
    const homeSnapshot =
      home?.id != null ? d.registry.forProject(home.id).store.templates().templates : [];
    const target = d.registry.forProject(projectId).store.templates();
    for (const [role, homeId] of Object.entries(homeTemplates)) {
      const g = given?.[role];
      if (g) {
        templates[role] = g;
        continue;
      }
      if (!homeId) {
        templates[role] = null;
        notes.push(`${role}: the home project has no template for this role.`);
        continue;
      }
      const name = homeSnapshot.find((t) => t.id === homeId)?.name ?? null;
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
      let pack = store.get(s.id);
      if (!pack) {
        pack = store.insert({
          id: s.id,
          name: s.name,
          prefix: s.prefix,
          rules: s.rules,
          governance: s.governance,
          seed: s.seed,
        });
        d.audit('system', 'pack.seed', s.id, undefined, { version: 1, seed: s.seed });
        any = true;
      }
      const homeGiven = s.projects.find((p) => p.name.toLowerCase() === s.home.toLowerCase())?.templates ?? {};
      for (const p of s.projects) {
        const view = projectByName(p.name);
        if (!view || view.id === null) continue;
        if (store.attachment(s.id, view.id)) continue;
        const { templates, notes } = deriveTemplates(s, homeGiven, view.id, p.templates);
        store.attach(s.id, view.id, templates, notes, 'seed');
        d.audit('system', 'pack.attach', s.id, undefined, { project: view.name, templates, notes });
        any = true;
      }
    }
    if (any) changed();
  };

  const toolsOf = (pack: Pack) => pack.rules.types.map((t) => `${pack.prefix}${t.tool}`);

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
    };
  };

  const readSource = async (
    src: GovernanceSource,
    signal?: AbortSignal,
  ): Promise<{ version: string | null; digest: string | null; reason?: string }> => {
    const p = projectByName(src.project);
    if (!p || p.id === null) return { version: null, digest: null, reason: `project ${src.project} is not registered` };
    if (!d.projects.activeIds().includes(p.id))
      return { version: null, digest: null, reason: `project ${src.project} is not served now` };
    try {
      const r = (await d.engine.internalRead(
        p.id,
        'getDocumentBlocks',
        { path: { resourceId: src.resourceId, documentId: src.documentId } },
        { priority: 'P1', notFoundIsAnswer: true, ...(signal ? { signal } : {}) },
      )) as { version?: unknown; blocks?: unknown } | null;
      if (!r || typeof r.version !== 'string')
        return { version: null, digest: null, reason: 'the document is gone or has no version' };
      return { version: r.version, digest: blocksDigest(r.blocks) };
    } catch (e) {
      return { version: null, digest: null, reason: e instanceof Error ? e.message : String(e) };
    }
  };

  const governance = async (packId: string, o: { signal?: AbortSignal } = {}): Promise<GovernanceStatus> => {
    const pack = store.get(packId);
    if (!pack) throw new PackError('PACK_NOT_FOUND', `No pack ${packId}.`);
    const approved = pack.approved;
    const sources: SourceStatus[] = [];
    for (const src of pack.governance) {
      const read = await readSource(src, o.signal);
      const was = approved?.sources.find((x) => x.key === src.key)?.version ?? null;
      const state: SourceStatus['state'] =
        read.version === null ? 'unreadable' : !approved ? 'unapproved' : was === read.version ? 'same' : 'changed';
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
      });
    }
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
        message: `Arkona's governance changed since the owner approved the ${pack.name} pack: ${changed.map((s) => s.name).join(', ')}. Tags are not computed until the owner checks the rules and approves the pack again on the Packs page.`,
      };
    } else if (sources.some((s) => s.state === 'unreadable')) {
      out = {
        ...base,
        state: 'unreadable',
        message: `The ${pack.name} pack's governance sources could not all be read (${sources
          .filter((s) => s.state === 'unreadable')
          .map((s) => `${s.name}: ${s.reason ?? 'unreadable'}`)
          .join('; ')}), so the bridge cannot tell whether they changed. No tags are computed until they can be read.`,
      };
    } else {
      out = { ...base, state: 'current', message: 'The pack is approved and its governance sources are as approved.' };
    }
    // A drift seen is recorded (the Packs page shows it); an approved, current pack clears an old one.
    if (out.state === 'changed') {
      const drift: PackDrift = {
        at: now(),
        changed: sources
          .filter((s) => s.state === 'changed')
          .map((s) => ({ key: s.key, name: s.name, approved: s.approved, current: s.current })),
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
        // Work out the templates again for every attachment whose template ids are not all known.
        const seed = seedOf(pack.id);
        const homeGiven = seed?.projects.find((p) => p.name.toLowerCase() === seed.home.toLowerCase())?.templates;
        for (const a of store.attachments(pack.id)) {
          if (Object.values(a.templates).every((v) => v !== null) && Object.keys(a.templates).length > 0) continue;
          const given = Object.fromEntries(
            Object.entries(a.templates).filter((e): e is [string, string] => e[1] !== null),
          );
          const derived = deriveTemplates(seed, homeGiven ?? a.templates, a.projectId, given);
          store.setTemplates(pack.id, a.projectId, derived.templates, derived.notes);
        }
        const approval: PackApproval = {
          version: pack.version,
          at: now(),
          by: actor,
          sources: status.sources.map((s) => ({ key: s.key, version: s.current! })),
        };
        const before = pack.approved;
        const after = store.approve(pack.id, approval);
        d.audit(actor, 'pack.approve', pack.id, before, {
          ...approval,
          sources: status.sources.map((s) => ({ key: s.key, name: s.name, version: s.current, digest: s.digest })),
        });
        changed();
        return { pack: after, governance: await governance(pack.id) };
      },
      setTokens(actor, packId, maps) {
        if (actor !== ACTOR_OWNER) throw new PackError('NOT_OWNER', 'Only the owner edits a pack.');
        const pack = requirePack(packId);
        const race = maps.race !== undefined ? tokenMap(maps.race, 'race') : pack.rules.tags.race;
        const culture = maps.culture !== undefined ? tokenMap(maps.culture, 'culture') : pack.rules.tags.culture;
        const never = new Set(pack.rules.tags.never.map((t) => t.toLowerCase()));
        for (const [k, v] of [...Object.entries(race), ...Object.entries(culture)]) {
          if (never.has(v.toLowerCase()))
            throw new PackError('INVALID_TOKEN', `“${k}” maps to “${v}”, which is never a tag.`);
        }
        if (stableJson(race) === stableJson(pack.rules.tags.race) && stableJson(culture) === stableJson(pack.rules.tags.culture))
          return pack;
        const rules = packRulesSchema.parse({ ...pack.rules, tags: { ...pack.rules.tags, race, culture } });
        const after = store.newVersion(pack.id, rules, 'token maps edited on the Packs page');
        d.audit(
          actor,
          'pack.set_tokens',
          pack.id,
          { version: pack.version, race: pack.rules.tags.race, culture: pack.rules.tags.culture },
          { version: after.version, race, culture },
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
      replaceRules(actor, packId, rules, reason) {
        const pack = requirePack(packId);
        const after = store.newVersion(pack.id, rules, reason);
        d.audit(actor, 'pack.replace_rules', pack.id, { version: pack.version }, { version: after.version, reason });
        changed();
        return after;
      },
    },
  };
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
      throw new PackError('INVALID_TOKEN', `A ${what} token needs a value (1 to 200 characters) and a token (1 to 100).`);
    if (/[–—]/.test(key + tok))
      throw new PackError('INVALID_TOKEN', `“${key}”: no em or en dashes in tokens (use a hyphen).`);
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw new PackError('INVALID_TOKEN', `“${key}” is in the ${what} map twice.`);
    seen.add(lower);
    out[key] = tok;
  }
  return out;
}
