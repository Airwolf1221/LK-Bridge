/**
 * The project registry (v2 A1, docs/projects.md): which LegendKeeper projects this bridge serves, each with its OWN
 * governor (its key's tiers and its project tier), and whether each may be served right now.
 *
 * Start-up check, per configured project (`verifyAll`): its key must authenticate, and the project the key belongs to
 * (`listProjects`, which a project key answers with exactly its own project) must be the one stored under that name
 * (and, in the single-project form, the one LK_PROJECT_ID names). A new name is registered with the id its key proves.
 * - A refused key, a key of another project, or a LegendKeeper project already registered under another name STOPS
 *   that project: it is not served, the reason shows on the dashboard and in the log. The others keep working.
 * - When LegendKeeper cannot be asked (unreachable, 5xx, budget), the project is `unverified` and checked again with a
 *   growing delay (15 s up to 10 minutes). It is not served meanwhile.
 * Keys are never logged or shown: only the name of the variable that holds one, or the last four characters.
 *
 * OPS2 (ADR 0028): keys live in the encrypted secret store. The projects served are those listed in the env file plus
 * those stored (and not archived) with a key in the store. An env key is imported into the store once (by name in the
 * log); when the env file and the store disagree, the stored key wins and the project shows the conflict. Projects are
 * added, given a new key, drained and removed (archived) at runtime from the dashboard, without a restart: each added
 * project gets its own governor at once; a replaced key keeps the project's governor, so its counts (the project tier
 * above all, which every key of the project shares) carry on.
 */
import { safeEqual } from '../auth/crypto.js';
import { PROJECT_NAME_PATTERN, type Config, type ProjectKeyConfig } from '../config/index.js';
import { lkSettingsFor } from '../config/lk.js';
import type { Db } from '../db/open.js';
import { writeDurationSource } from '../jobs/durations.js';
import { callOp } from '../jobs/lk-call.js';
import { BridgeLkError, BudgetWaitError } from '../lk/errors.js';
import { createLkClient, type LkClient } from '../lk/client.js';
import { systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
import type { Governor, Transport } from '../lk/governor/governor.js';
import { createSqliteCounterStore } from '../lk/governor/persist.js';
import { requireOperation } from '../lk/registry.js';
import { keyHint } from '../secrets/crypto.js';
import type { SecretStore } from '../secrets/store.js';
import type { SelectableProjects } from './selection.js';
import { ProjectStore } from './store.js';
import type { ProjectRecord, ProjectStatus, ProjectView } from './types.js';

export interface RegistryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const quiet: RegistryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** What the job engine, the tools and the dashboard need from the registry. `ProjectRegistry` implements it. */
export interface ProjectsRuntime {
  /** The LK client of an ACTIVE project; undefined when the project is unknown or not served now. */
  client(projectId: string): LkClient | undefined;
  /** The client of a configured project whatever its status (budget views); undefined when it has none. */
  anyClient(projectId: string): LkClient | undefined;
  /** Whether `projectId` is a project stored in this database. */
  known(projectId: string): boolean;
  /** The project's name, for messages (its id when unknown). */
  nameOf(projectId: string): string;
  /** The per-project read-only flag (true overrides the bridge-wide flag for this project). */
  readOnly(projectId: string): boolean;
  /** Why the project is not served now, or null when it is. */
  unavailableReason(projectId: string): string | null;
  /** Ids of the projects served now, in configuration order. */
  activeIds(): string[];
  /** Calls `cb` whenever a project's status or flags change. Returns an unsubscribe function. */
  onChange(cb: (view: ProjectView) => void): () => void;
  /**
   * OPS2: why the project takes no NEW work now although it is served (paused and draining before its removal), or
   * null. Work already queued or running carries on.
   */
  admissionRefusal?(projectId: string): string | null;
}

/** OPS2: what a candidate key proved (the bridge asks LegendKeeper before anything is stored). */
export interface KeyProbe {
  /** The LegendKeeper project id the key belongs to. */
  readonly id: string;
  readonly displayName: string | null;
  /** From listMembers: LegendKeeper shows member emails to ADMIN keys only. */
  readonly role: 'ADMIN' | 'MEMBER' | 'unknown';
}

export type ProjectChangeCode =
  | 'INVALID_NAME'
  | 'NAME_TAKEN'
  | 'ALREADY_SERVED'
  | 'RESTORE_UNDER_NAME'
  | 'NOT_FOUND'
  | 'NOT_REGISTERED'
  | 'KEY_WRONG_PROJECT'
  | 'STORE_UNAVAILABLE'
  | 'KEY_REFUSED'
  | 'PAID_PLAN_REQUIRED'
  | 'KEY_SEES_SEVERAL'
  | 'LK_UNREACHABLE'
  | 'KEY_CHECK_FAILED';

/** OPS2: a refused project change or key check. The message never contains a key. */
export class ProjectChangeError extends Error {
  override readonly name = 'ProjectChangeError';
  constructor(
    readonly code: ProjectChangeCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateProjectRegistryOptions {
  readonly db: Db;
  readonly config: Config;
  readonly clock?: Clock;
  /** Network transport under every governor (tests point it at a mock LegendKeeper). */
  readonly transport?: Transport;
  readonly random?: () => number;
  readonly log?: RegistryLogger;
  /** Keep each governor's counts across restarts (default true; table governor_counters, one row per project). */
  readonly persistCounters?: boolean;
  /**
   * v2 E5 hotfix: the only registry operations every project's governor may send (the Markdown round trip's read-only
   * runtime). Unset for the bridge: every operation.
   */
  readonly allowedOperations?: ReadonlySet<string>;
  /** First and largest delay before an `unverified` project is checked again. */
  readonly retryMs?: { readonly first: number; readonly max: number };
  /**
   * OPS2: the encrypted secret store holding each project's key. Without it (tools and tests that pass keys directly)
   * the env file's keys are the only ones, as in v2 A1, and projects cannot be added or re-keyed at runtime.
   */
  readonly secrets?: SecretStore;
  /** OPS2: called whenever an env key is imported into the store (names and last four characters only), to audit it. */
  readonly onImport?: (i: {
    readonly project: string;
    readonly variable: string;
    readonly hint: string;
  }) => void;
}

interface Entry {
  /** The key in use is `config.apiKey` (from the store when one is stored, else from the env file). */
  config: ProjectKeyConfig;
  source: 'env' | 'store';
  keyHint: string | null;
  keyConflict: string | null;
  /** Why this project cannot be served at all (its stored key cannot be read); the check stops it with this. */
  blocked: string | null;
  draining: boolean;
  id: string | null;
  client: LkClient | null;
  status: ProjectStatus;
  reason: string | null;
  keyValid: boolean | null;
  checkedAt: number | null;
  retryTimer: TimerHandle | null;
  retryDelay: number;
  checking: Promise<void> | null;
}

export class ProjectRegistry implements ProjectsRuntime, SelectableProjects {
  readonly store: ProjectStore;
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly log: RegistryLogger;
  private readonly listeners = new Set<(v: ProjectView) => void>();
  private records = new Map<string, ProjectRecord>();
  private closed = false;
  /** OPS2: keys imported from the env file at this start (names only), for the audit log. */
  readonly imports: { readonly project: string; readonly variable: string; readonly hint: string }[] = [];
  /** OPS2: start-up notes about the env file's project lines (names only). */
  readonly notes: string[] = [];

  constructor(private readonly o: CreateProjectRegistryOptions) {
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? quiet;
    this.store = new ProjectStore(o.db, () => this.clock.now());
    this.reload();
    const envNames = new Set(o.config.lk.projects.map((p) => p.name));
    for (const p of o.config.lk.projects) {
      const stored = this.byName(p.name);
      if (stored?.archivedAt != null) {
        const note = `${p.keyVariable ?? 'The env file'} lists project "${p.name}", which was removed on the dashboard (archived), so it is not served. Remove its lines from the env file (env-sync.sh --retire-imported-keys).`;
        this.notes.push(note);
        this.log.warn({ project: p.name }, note);
        continue;
      }
      const entry = this.newEntry(p, 'env', stored?.id ?? null);
      if (stored) this.adoptStoredKey(entry, stored.id);
      // A stored project gets its governor at once, so its saved counts are restored before anything is sent.
      if (entry.id !== null && entry.blocked === null) entry.client = this.newClient(entry.config, entry.id);
      this.entries.set(p.name, entry);
    }
    // OPS2: stored projects the env file does not list, served with their key from the encrypted store.
    for (const r of this.records.values()) {
      if (r.archivedAt !== null || envNames.has(r.name) || !o.secrets) continue;
      const key = o.secrets.read(r.id, 'lk_api_key');
      if (key.ok) {
        const entry = this.newEntry(
          { name: r.name, apiKey: key.value, expectedProjectId: null, keyVariable: null },
          'store',
          r.id,
        );
        entry.client = this.newClient(entry.config, r.id);
        this.entries.set(r.name, entry);
      } else if (key.reason !== 'not_stored') {
        const entry = this.newEntry(
          { name: r.name, apiKey: '', expectedProjectId: null, keyVariable: null },
          'store',
          r.id,
        );
        entry.blocked = `Its key is kept in the encrypted store, which cannot be read: ${key.message}`;
        this.entries.set(r.name, entry);
      }
      // Nothing stored: a project with data and no key (shown as such; "Replace key" gives it one).
    }
    const wanted = o.config.lk.defaultProject;
    if (wanted && !this.entries.has(wanted)) {
      const note = `LK_DEFAULT_PROJECT names "${wanted}", which this bridge does not serve; the stored default applies.`;
      this.notes.push(note);
      this.log.warn({}, note);
    }
    // v3 F2 (ADR 0049 decision 3): the stored default is the dashboard's choice ("Make default") and is never
    // overwritten from the env file; LK_DEFAULT_PROJECT only overrides it while it is set. A database with no stored
    // default yet (a first start, or one from before F2) takes the effective one, so the choice starts where it was.
    if (this.storedDefault === null && this.defaultName) this.store.setDefault(this.defaultName);
    this.reload();
  }

  /** v3 F2: the default the dashboard stored ("Make default"), when it names a project that is not archived. */
  get storedDefault(): string | null {
    for (const r of this.records.values()) if (r.isDefault && r.archivedAt === null) return r.name;
    return null;
  }

  /**
   * v3 F2: LK_DEFAULT_PROJECT when it is set, names a served project and DISAGREES with the stored default: it then
   * overrides the dashboard's choice (the Projects page says so). Null otherwise.
   */
  get envOverride(): string | null {
    const env = this.o.config.lk.defaultProject;
    if (!env || !this.entries.has(env)) return null;
    return env === this.storedDefault ? null : env;
  }

  /**
   * v3 F2 (ADR 0049 decision 3): stores `name` as the default project (the Projects page's "Make default"; owner
   * commands audit it). Takes effect at once, without a restart, unless LK_DEFAULT_PROJECT overrides it. Returns the
   * project's view, or undefined when it is not a served project.
   */
  makeDefault(name: string): ProjectView | undefined {
    const key = name.trim().toLowerCase();
    const entry = this.entries.get(key);
    const record = [...this.records.values()].find((r) => r.name === key);
    if (!entry || !record || record.archivedAt !== null) return undefined;
    this.store.setDefault(key);
    this.reload();
    const v = this.view(entry);
    this.emit(v);
    return v;
  }

  /**
   * The default project's name: LK_DEFAULT_PROJECT when it names a served project, else the stored default, else the
   * first project. Empty when the bridge serves no project at all (OPS2: projects are then added on the dashboard).
   */
  get defaultName(): string {
    const env = this.o.config.lk.defaultProject;
    if (env && this.entries.has(env)) return env;
    for (const r of this.records.values()) {
      if (r.isDefault && r.archivedAt === null && this.entries.has(r.name)) return r.name;
    }
    return this.entries.keys().next().value ?? '';
  }

  // ============================================================================================ queries

  /** Every project: configured ones in configuration order, then stored ones the env file no longer lists. */
  list(): ProjectView[] {
    const out: ProjectView[] = [];
    for (const e of this.entries.values()) out.push(this.view(e));
    for (const r of this.records.values()) {
      if (!this.entries.has(r.name)) out.push(this.storedOnlyView(r));
    }
    return out;
  }

  /** Configured project names, in configuration order (what an agent may pass as `project`). */
  configuredNames(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * A configured project by name (any case) or by LegendKeeper id, once its id is known. Names win over ids. Undefined
   * for anything else (not configured, or configured but never verified).
   */
  resolve(ref: string): ProjectView | undefined {
    const name = ref.trim().toLowerCase();
    const byName = this.entries.get(name);
    if (byName) return byName.id !== null ? this.view(byName) : undefined;
    for (const e of this.entries.values()) if (e.id !== null && e.id === ref.trim()) return this.view(e);
    return undefined;
  }

  /** A configured project by name, even before its id is known (dashboard). */
  byConfiguredName(name: string): ProjectView | undefined {
    const e = this.entries.get(name.trim().toLowerCase());
    return e ? this.view(e) : undefined;
  }

  /** Any project this bridge knows (configured or only stored), by name or id. */
  find(ref: string): ProjectView | undefined {
    return (
      this.resolve(ref) ??
      this.byConfiguredName(ref) ??
      this.list().find((p) => p.name === ref.trim().toLowerCase() || p.id === ref.trim())
    );
  }

  /**
   * The default project (LK_DEFAULT_PROJECT, or the stored default). With no project at all (OPS2), a placeholder with
   * no id, whose reason says to add one on the dashboard.
   */
  defaultProject(): ProjectView {
    const e = this.entries.get(this.defaultName);
    return e ? this.view(e) : NO_PROJECT;
  }

  client(projectId: string): LkClient | undefined {
    const e = this.entryById(projectId);
    return e && e.status === 'active' && e.client ? e.client : undefined;
  }

  anyClient(projectId: string): LkClient | undefined {
    return this.entryById(projectId)?.client ?? undefined;
  }

  known(projectId: string): boolean {
    return this.records.has(projectId);
  }

  nameOf(projectId: string): string {
    return this.records.get(projectId)?.name ?? projectId;
  }

  readOnly(projectId: string): boolean {
    const r = this.records.get(projectId);
    return r?.readOnly === true || (r !== undefined && r.archivedAt !== null);
  }

  unavailableReason(projectId: string): string | null {
    const e = this.entryById(projectId);
    if (!e) {
      const r = this.records.get(projectId);
      if (!r) return `there is no project with id ${projectId}`;
      return r.archivedAt !== null
        ? `project "${r.name}" was removed on the dashboard (its history is kept, read-only), so it is not served`
        : `project "${r.name}" has no key, so it is not served`;
    }
    if (e.status === 'active') return null;
    return `project "${e.config.name}" is not available (${e.status}): ${e.reason ?? 'unknown reason'}`;
  }

  activeIds(): string[] {
    return [...this.entries.values()].filter((e) => e.status === 'active' && e.id).map((e) => e.id!);
  }

  admissionRefusal(projectId: string): string | null {
    const e = this.entryById(projectId);
    return e?.draining
      ? `project "${e.config.name}" is paused and draining before its removal, so it takes no new work (the owner can resume it on the dashboard's Projects page)`
      : null;
  }

  /** Every configured project that has a governor, with its client (budget views, the budget sampler). */
  clients(): { readonly id: string; readonly name: string; readonly client: LkClient }[] {
    return [...this.entries.values()]
      .filter((e) => e.id !== null && e.client !== null)
      .map((e) => ({ id: e.id!, name: e.config.name, client: e.client! }));
  }

  onChange(cb: (view: ProjectView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ============================================================================================ owner changes

  /** Sets a project's own read-only flag (owner commands audit it). Returns the new view. */
  setReadOnly(projectId: string, readOnly: boolean): ProjectView | undefined {
    if (!this.store.setReadOnly(projectId, readOnly)) return undefined;
    this.reload();
    const v = this.viewById(projectId);
    if (v) this.emit(v);
    return v;
  }

  /**
   * v2 A2: sets one project setting (`null` clears it). The value must already be validated (`parseSettingValue`);
   * owner commands audit it. Returns the new view.
   */
  setSetting(projectId: string, key: string, value: unknown): ProjectView | undefined {
    if (!this.store.setSetting(projectId, key, value)) return undefined;
    this.reload();
    const v = this.viewById(projectId);
    if (v) this.emit(v);
    return v;
  }

  /**
   * Re-reads the stored rows (flags and settings), for changes made outside this process: `npm run projects -- set`
   * on the server writes the database directly.
   */
  refresh(): void {
    this.reload();
  }

  // ============================================================================================ OPS2: keys at runtime

  /** Whether projects can be added or re-keyed now (the encrypted store needs SECRETS_MASTER_KEY). */
  get canManageKeys(): boolean {
    return this.o.secrets?.available === true;
  }

  /**
   * Asks LegendKeeper which project a candidate key belongs to and its role, through a throwaway governor of its own
   * (two reads at P0: listProjects, then listMembers). Nothing is stored. Throws `ProjectChangeError`.
   */
  async probeKey(apiKey: string): Promise<KeyProbe> {
    const cfg: ProjectKeyConfig = { name: 'new-key', apiKey, expectedProjectId: null, keyVariable: null };
    const probe = this.newClient(cfg, '', false);
    const prefix = `lkb.keycheck.${this.clock.now().toString(36)}`;
    try {
      let projects: { id?: unknown; name?: unknown }[];
      try {
        const r = (await callOp(
          probe,
          requireOperation('listProjects'),
          {},
          {
            priority: 'P0',
            requestIdPrefix: prefix,
          },
        )) as { data?: { id?: unknown; name?: unknown }[] } | undefined;
        projects = Array.isArray(r?.data) ? r.data : [];
      } catch (err) {
        throw keyCheckError(err);
      }
      if (projects.length !== 1 || typeof projects[0]?.id !== 'string' || projects[0].id === '') {
        throw new ProjectChangeError(
          'KEY_SEES_SEVERAL',
          `This key sees ${projects.length} LegendKeeper projects; a project key sees exactly one, its own. Create the key in the project's own settings (Developers, API keys).`,
        );
      }
      const id = projects[0].id;
      const displayName = typeof projects[0].name === 'string' ? projects[0].name.slice(0, 200) : null;
      let role: KeyProbe['role'] = 'unknown';
      try {
        const scoped = this.newClient(cfg, id, false, probe.governor);
        const m = (await callOp(
          scoped,
          requireOperation('listMembers'),
          {},
          {
            priority: 'P0',
            requestIdPrefix: `${prefix}.m`,
          },
        )) as { data?: { email?: unknown }[] } | undefined;
        const members = Array.isArray(m?.data) ? m.data : [];
        if (members.some((x) => typeof x?.email === 'string')) role = 'ADMIN';
        else if (members.length > 0) role = 'MEMBER';
      } catch {
        role = 'unknown';
      }
      return { id, displayName, role };
    } finally {
      probe.governor.close();
    }
  }

  /**
   * Adds a project whose key `probeKey` has just checked: registers it (or brings back an archived project of the same
   * LegendKeeper project, under its old name), stores the key encrypted, and starts serving it with a new governor at
   * once. All database changes are one transaction. Throws `ProjectChangeError`.
   */
  addProject(input: {
    readonly name: string;
    readonly apiKey: string;
    readonly probe: KeyProbe;
  }): ProjectView {
    const secrets = this.requireSecrets();
    const name = input.name.trim().toLowerCase();
    const { probe } = input;
    if (!PROJECT_NAME_PATTERN.test(name)) {
      throw new ProjectChangeError(
        'INVALID_NAME',
        'A project name is a lowercase letter, then lowercase letters, digits or underscores; at most 32 characters.',
      );
    }
    this.reload();
    const byName = this.byName(name);
    const byId = this.records.get(probe.id);
    if (this.entries.has(name)) {
      throw new ProjectChangeError('NAME_TAKEN', `There is already a project called "${name}".`);
    }
    for (const x of this.entries.values()) {
      if (x.id === probe.id) {
        throw new ProjectChangeError(
          'ALREADY_SERVED',
          `This key belongs to LegendKeeper project ${probe.id}, which this bridge already serves as "${x.config.name}". To change that project's key, use Replace key.`,
        );
      }
    }
    if (byId && byId.name !== name) {
      throw new ProjectChangeError(
        byId.archivedAt !== null ? 'RESTORE_UNDER_NAME' : 'ALREADY_SERVED',
        byId.archivedAt !== null
          ? `This key belongs to LegendKeeper project ${probe.id}, which this bridge served before as "${byId.name}" (removed, its history kept). Add it as "${byId.name}" to bring it back.`
          : `This key belongs to LegendKeeper project ${probe.id}, which is registered here as "${byId.name}". Use Replace key on that project.`,
      );
    }
    if (byName && byName.id !== probe.id) {
      throw new ProjectChangeError(
        'NAME_TAKEN',
        `The name "${name}" belongs to another LegendKeeper project${byName.archivedAt !== null ? ' (removed, its history kept)' : ''}. Choose another name.`,
      );
    }
    const now = this.clock.now();
    const hint = keyHint(input.apiKey);
    this.o.db.transaction(() => {
      if (!byId) this.store.insert({ id: probe.id, name, displayName: probe.displayName, verifiedAt: now });
      else {
        this.store.unarchive(probe.id);
        this.store.markVerified(probe.id, probe.displayName, now);
      }
      secrets.write(probe.id, 'lk_api_key', input.apiKey, { source: 'dashboard', hint });
    })();
    this.reload();
    const entry = this.newEntry(
      { name, apiKey: input.apiKey, expectedProjectId: null, keyVariable: null },
      'store',
      probe.id,
    );
    entry.client = this.newClient(entry.config, probe.id);
    this.markActive(entry, now);
    this.entries.set(name, entry);
    if (this.defaultName) this.store.setDefault(this.defaultName);
    this.reload();
    this.log.info({ project: name, lkProjectId: probe.id, keyHint: hint }, 'project added');
    const v = this.view(entry);
    this.emit(v);
    return v;
  }

  /**
   * Replaces a project's key with one `probeKey` has just checked, which must belong to the SAME LegendKeeper project.
   * The stored key is replaced in one statement and the project's client swapped at once (new calls use the new key;
   * a call already sent finishes with the old one). The project keeps its governor. Throws `ProjectChangeError`.
   */
  replaceKey(input: { readonly name: string; readonly apiKey: string; readonly probe: KeyProbe }): {
    readonly view: ProjectView;
    readonly oldHint: string | null;
  } {
    const secrets = this.requireSecrets();
    const name = input.name.trim().toLowerCase();
    this.reload();
    const rec = this.byName(name);
    if (!rec || rec.archivedAt !== null) {
      const e = this.entries.get(name);
      throw new ProjectChangeError(
        e ? 'NOT_REGISTERED' : 'NOT_FOUND',
        e
          ? `Project "${name}" has not been verified yet, so it has no LegendKeeper id to check a key against. Fix its env key, or remove it from the env file and add it here.`
          : `There is no project "${name}".`,
      );
    }
    if (input.probe.id !== rec.id) {
      throw new ProjectChangeError(
        'KEY_WRONG_PROJECT',
        `This key belongs to LegendKeeper project ${input.probe.id}, not to "${name}" (LegendKeeper project ${rec.id}). Nothing was changed. Create the new key in that project's own settings.`,
      );
    }
    const e = this.entries.get(name);
    const oldHint = e
      ? (e.keyHint ?? keyHint(e.config.apiKey))
      : (secrets.meta(rec.id, 'lk_api_key')?.hint ?? null);
    const hint = keyHint(input.apiKey);
    const now = this.clock.now();
    this.o.db.transaction(() => {
      secrets.write(rec.id, 'lk_api_key', input.apiKey, { source: 'dashboard', hint });
      this.store.markVerified(rec.id, input.probe.displayName ?? rec.displayName, now);
    })();
    this.reload();
    let entry = e;
    if (!entry) {
      entry = this.newEntry(
        { name, apiKey: input.apiKey, expectedProjectId: null, keyVariable: null },
        'store',
        rec.id,
      );
      entry.client = this.newClient(entry.config, rec.id);
      this.entries.set(name, entry);
    } else {
      const governor = entry.client?.governor;
      entry.config = { ...entry.config, apiKey: input.apiKey, expectedProjectId: null };
      entry.id = rec.id;
      entry.client = this.newClient(entry.config, rec.id, true, governor);
      entry.source = 'store';
      entry.keyHint = hint;
      entry.blocked = null;
      entry.keyConflict = entry.config.keyVariable
        ? `${entry.config.keyVariable} in the env file still holds the old key; the key stored on the dashboard is used. Retire the env line with \`env-sync.sh --retire-imported-keys\`.`
        : null;
    }
    this.markActive(entry, now);
    this.log.info({ project: name, keyHint: hint, oldKeyHint: oldHint }, 'project key replaced');
    const v = this.view(entry);
    this.emit(v);
    return { view: v, oldHint };
  }

  /** OPS2: pauses a project for removal: it takes no new work; queued and running work carries on. */
  setDraining(name: string, value: boolean): ProjectView {
    const e = this.entries.get(name.trim().toLowerCase());
    if (!e) throw new ProjectChangeError('NOT_FOUND', `There is no served project "${name}".`);
    e.draining = value;
    const v = this.view(e);
    this.emit(v);
    return v;
  }

  /**
   * Removes a project: archives its row (its history stays, read-only), deletes its stored key, stops its retries and
   * closes its governor (saving its counts). The caller has checked that nothing is pending. Throws
   * `ProjectChangeError`.
   */
  removeProject(name: string): ProjectView {
    const n = name.trim().toLowerCase();
    this.reload();
    const rec = this.byName(n);
    const e = this.entries.get(n);
    if (!rec || rec.archivedAt !== null) {
      throw new ProjectChangeError(
        e ? 'NOT_REGISTERED' : 'NOT_FOUND',
        e
          ? `Project "${n}" has never been verified, so it has no data to archive. Remove its lines from the env file instead.`
          : `There is no project "${n}" to remove.`,
      );
    }
    this.o.db.transaction(() => {
      this.store.archive(rec.id);
      this.o.secrets?.remove(rec.id, 'lk_api_key');
    })();
    if (e) {
      if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
      e.retryTimer = null;
      e.client?.governor.close();
      this.entries.delete(n);
    }
    if (this.defaultName) this.store.setDefault(this.defaultName);
    this.reload();
    this.log.info({ project: n, lkProjectId: rec.id }, 'project removed (archived)');
    const v = this.viewById(rec.id)!;
    this.emit(v);
    return v;
  }

  // ============================================================================================ checks

  /** Checks every configured project's key (in parallel). Never throws: a failure stops only that project. */
  async verifyAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.verify(n)));
  }

  /** Checks one configured project's key now. Resolves with its view afterwards. */
  async verify(name: string): Promise<ProjectView | undefined> {
    const e = this.entries.get(name);
    if (!e || this.closed) return e ? this.view(e) : undefined;
    if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
    e.retryTimer = null;
    e.checking ??= this.check(e).finally(() => {
      e.checking = null;
    });
    await e.checking;
    return this.view(e);
  }

  private async check(e: Entry): Promise<void> {
    if (e.blocked !== null) {
      e.checkedAt = this.clock.now();
      return this.stop(e, e.blocked);
    }
    const p = e.config;
    // The project's own governor when its id is known; otherwise a throwaway one, only to ask which project it is.
    const probe = e.client ?? this.newClient(p, '', false);
    let projects: { id?: unknown; name?: unknown }[];
    try {
      const r = (await callOp(
        probe,
        requireOperation('listProjects'),
        {},
        {
          priority: 'P0',
          requestIdPrefix: `lkb.verify.${p.name}.${this.clock.now().toString(36)}`,
        },
      )) as { data?: { id?: unknown; name?: unknown }[] } | undefined;
      projects = Array.isArray(r?.data) ? r.data : [];
    } catch (err) {
      if (probe !== e.client) probe.governor.close();
      this.failed(e, err);
      return;
    }
    if (probe !== e.client) probe.governor.close();
    e.checkedAt = this.clock.now();
    e.keyValid = true;

    if (projects.length !== 1 || typeof projects[0]?.id !== 'string' || projects[0].id === '') {
      return this.stop(
        e,
        `the key sees ${projects.length} LegendKeeper projects; a project key sees exactly one, its own`,
      );
    }
    const id = projects[0].id;
    const displayName = typeof projects[0].name === 'string' ? projects[0].name.slice(0, 200) : null;
    if (p.expectedProjectId !== null && p.expectedProjectId !== id) {
      return this.stop(
        e,
        `${keyLabel(e)} belongs to LegendKeeper project ${id}, not ${p.expectedProjectId} (LK_PROJECT_ID)`,
      );
    }
    const stored = this.byName(p.name);
    if (stored && stored.id !== id) {
      return this.stop(
        e,
        `${keyLabel(e)} belongs to LegendKeeper project ${id}, but project "${p.name}" is LegendKeeper project ` +
          `${stored.id} in this bridge's database. Give it that project's key (Replace key on the Projects page)`,
      );
    }
    const other = this.records.get(id);
    if (!stored && other && other.name !== p.name) {
      return this.stop(
        e,
        `${keyLabel(e)} belongs to LegendKeeper project ${id}, which this bridge ${other.archivedAt !== null ? 'served' : 'already serves'} as "${other.name}"${other.archivedAt !== null ? ' (removed, its history kept)' : ''}`,
      );
    }
    for (const x of this.entries.values()) {
      if (x !== e && x.id === id && x.status !== 'stopped') {
        return this.stop(
          e,
          `${keyLabel(e)} belongs to the same LegendKeeper project as "${x.config.name}" (${id}); a project can be ` +
            'registered once',
        );
      }
    }

    const now = this.clock.now();
    if (stored) this.store.markVerified(id, displayName, now);
    else this.store.insert({ id, name: p.name, displayName, verifiedAt: now });
    if (p.name === this.defaultName) this.store.setDefault(p.name);
    this.reload();
    // OPS2: a new env project's key moves into the encrypted store once its project id is known.
    if (!stored && e.source === 'env') this.importEnvKey(e, id);
    if (e.id === null || e.client === null) {
      e.id = id;
      e.client = this.newClient(p, id);
    }
    e.status = 'active';
    e.reason = null;
    e.retryDelay = this.o.retryMs?.first ?? 15_000;
    this.log.info({ project: p.name, lkProjectId: id }, 'project verified');
    this.emit(this.view(e));
  }

  private failed(e: Entry, err: unknown): void {
    const lk = err instanceof BridgeLkError ? err : undefined;
    e.checkedAt = this.clock.now();
    const status = lk?.status;
    if (status === 401 || status === 403) {
      e.keyValid = false;
      return this.stop(e, `LegendKeeper refused ${keyLabel(e)} (${status} ${lk?.code ?? ''})`.trim());
    }
    if (status === 402) {
      e.keyValid = true;
      return this.stop(e, 'LegendKeeper says the project owner needs a paid plan (402)');
    }
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return this.stop(e, `LegendKeeper answered the key check with ${status} ${lk?.code ?? ''}`.trim());
    }
    // Unreachable, timed out, 5xx or out of budget: try again later; not served meanwhile.
    const why =
      err instanceof BudgetWaitError
        ? 'the request budget is exhausted for now'
        : typeof status === 'number'
          ? `LegendKeeper answered ${status}`
          : 'LegendKeeper could not be reached';
    e.status = 'unverified';
    e.reason = `The key could not be checked: ${why}. Checking again in ${Math.round(e.retryDelay / 1000)} s.`;
    this.log.warn({ project: e.config.name, reason: e.reason }, 'project key could not be checked');
    this.emit(this.view(e));
    if (!this.closed) {
      const delay = e.retryDelay;
      e.retryDelay = Math.min(delay * 2, this.o.retryMs?.max ?? 600_000);
      e.retryTimer = this.clock.setTimeout(() => {
        e.retryTimer = null;
        void this.verify(e.config.name);
      }, delay);
    }
  }

  private stop(e: Entry, reason: string): void {
    e.status = 'stopped';
    e.reason = `${reason}. Project "${e.config.name}" is not served; the other projects are unaffected.`;
    this.log.error({ project: e.config.name, reason: e.reason }, 'project stopped');
    this.emit(this.view(e));
  }

  /** Stops every retry timer and closes every governor (saving its counts). */
  /**
   * CR-2026-11-R3 (fix A): a restart: every project's governor ends its waits at once and lets nothing new wait
   * (`Governor.stopWaits`); requests in flight finish. `close()` follows at the end of the shutdown.
   */
  stopWaits(): void {
    for (const e of this.entries.values()) e.client?.governor.stopWaits();
  }

  close(): void {
    this.closed = true;
    for (const e of this.entries.values()) {
      if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
      e.retryTimer = null;
      e.client?.governor.close();
    }
  }

  // ============================================================================================ internals

  private newEntry(config: ProjectKeyConfig, source: 'env' | 'store', id: string | null): Entry {
    return {
      config,
      source,
      keyHint: config.apiKey ? keyHint(config.apiKey) : null,
      keyConflict: null,
      blocked: null,
      draining: false,
      id,
      client: null,
      status: 'verifying',
      reason: 'The key has not been checked yet.',
      keyValid: null,
      checkedAt: null,
      retryTimer: null,
      retryDelay: this.o.retryMs?.first ?? 15_000,
      checking: null,
    };
  }

  /**
   * An env project already stored: the stored key wins (with a conflict note when the env key differs); with nothing
   * stored, the env key is imported once; a stored key that cannot be read blocks the project (never the env key
   * instead: that one may be the old, revoked key the dashboard replaced).
   */
  private adoptStoredKey(e: Entry, id: string): void {
    const secrets = this.o.secrets;
    if (!secrets) return;
    const r = secrets.read(id, 'lk_api_key');
    const variable = e.config.keyVariable ?? 'the env file';
    if (r.ok) {
      e.source = 'store';
      e.keyHint = keyHint(r.value);
      if (!safeEqual(r.value, e.config.apiKey)) {
        e.keyConflict = `${variable} in the env file is not the key in use: the key stored on the dashboard wins. Retire the env line with \`env-sync.sh --retire-imported-keys\`.`;
        e.config = { ...e.config, apiKey: r.value };
        this.log.warn(
          { project: e.config.name, variable },
          'env key differs from the stored key; the stored key is used',
        );
      }
      return;
    }
    if (r.reason === 'not_stored') {
      this.importEnvKey(e, id);
      return;
    }
    e.blocked = `Its key is kept in the encrypted store, which cannot be read: ${r.message}`;
  }

  /** Imports an env project's key into the store, once per variable (never again after a removal or a replacement). */
  private importEnvKey(e: Entry, id: string): void {
    const secrets = this.o.secrets;
    const variable = e.config.keyVariable;
    if (!secrets?.available || !variable || secrets.imported(variable) !== undefined) return;
    if (secrets.has(id, 'lk_api_key')) return;
    const hint = keyHint(e.config.apiKey);
    this.o.db.transaction(() => {
      secrets.write(id, 'lk_api_key', e.config.apiKey, { source: 'env_import', hint });
      secrets.recordImport(variable, id, 'lk_api_key', e.config.apiKey);
    })();
    e.source = 'store';
    e.keyHint = hint;
    const record = { project: e.config.name, variable, hint };
    this.imports.push(record);
    this.o.onImport?.(record);
    this.log.info(
      { project: e.config.name, variable },
      'project key imported from the env file into the encrypted store',
    );
  }

  private markActive(e: Entry, now: number): void {
    if (e.retryTimer) this.clock.clearTimeout(e.retryTimer);
    e.retryTimer = null;
    e.status = 'active';
    e.reason = null;
    e.keyValid = true;
    e.checkedAt = now;
    e.retryDelay = this.o.retryMs?.first ?? 15_000;
  }

  private requireSecrets(): SecretStore {
    const s = this.o.secrets;
    if (!s?.available) {
      throw new ProjectChangeError(
        'STORE_UNAVAILABLE',
        s?.state().problem ??
          'This bridge has no encrypted secret store (SECRETS_MASTER_KEY is missing), so keys cannot be managed on the dashboard.',
      );
    }
    return s;
  }

  private newClient(p: ProjectKeyConfig, projectId: string, persist = true, governor?: Governor): LkClient {
    return createLkClient({
      ...lkSettingsFor(this.o.config, { apiKey: p.apiKey, projectId }),
      ...(governor ? { governorInstance: governor } : {}),
      ...(this.o.clock ? { clock: this.o.clock } : {}),
      ...(this.o.transport ? { transport: this.o.transport } : {}),
      ...(this.o.random ? { random: this.o.random } : {}),
      ...(this.o.allowedOperations ? { allowedOperations: this.o.allowedOperations } : {}),
      // v2 E5.5: a limit LegendKeeper reports for an operation group is logged once, naming the project; estimates
      // use the project's measured per-write duration (the median of its recent write steps).
      log: { info: (obj, msg) => this.log.info({ ...obj, project: p.name }, msg) },
      ...(projectId !== ''
        ? { writeDuration: writeDurationSource(this.o.db, projectId, () => this.clock.now()) }
        : {}),
      ...(persist && projectId !== '' && this.o.persistCounters !== false
        ? {
            persistence: {
              store: createSqliteCounterStore(this.o.db, projectId),
              warn: (message: string, err: unknown) => this.log.warn({ err, project: p.name }, message),
            },
          }
        : {}),
    });
  }

  private reload(): void {
    this.records = new Map(this.store.list().map((r) => [r.id, r]));
  }

  private byName(name: string): ProjectRecord | undefined {
    for (const r of this.records.values()) if (r.name === name) return r;
    return undefined;
  }

  private entryById(projectId: string): Entry | undefined {
    for (const e of this.entries.values()) if (e.id === projectId) return e;
    return undefined;
  }

  private viewById(projectId: string): ProjectView | undefined {
    const e = this.entryById(projectId);
    if (e) return this.view(e);
    const r = this.records.get(projectId);
    return r ? this.storedOnlyView(r) : undefined;
  }

  private view(e: Entry): ProjectView {
    const r = e.id !== null ? this.records.get(e.id) : undefined;
    return {
      name: e.config.name,
      id: e.id,
      displayName: r?.displayName ?? null,
      isDefault: e.config.name === this.defaultName,
      isSandbox: r?.isSandbox ?? false,
      readOnly: r?.readOnly ?? false,
      configured: true,
      registered: r !== undefined,
      status: e.status,
      reason: e.reason,
      keyVariable: e.config.keyVariable,
      keyValid: e.keyValid,
      verifiedAt: r?.verifiedAt ?? null,
      checkedAt: e.checkedAt,
      settings: r?.settings ?? {},
      settingsProblem: r?.settingsProblem ?? null,
      keySource: e.blocked !== null ? null : e.source,
      keyHint: e.blocked !== null ? null : e.keyHint,
      keyConflict: e.keyConflict,
      draining: e.draining,
      archivedAt: null,
    };
  }

  private storedOnlyView(r: ProjectRecord): ProjectView {
    const archived = r.archivedAt !== null;
    return {
      name: r.name,
      id: r.id,
      displayName: r.displayName,
      isDefault: false,
      isSandbox: r.isSandbox,
      readOnly: archived || r.readOnly,
      configured: false,
      registered: true,
      status: archived ? 'archived' : 'not_configured',
      reason: archived
        ? 'Removed on the dashboard: not served. Its history is kept and shown read-only.'
        : this.o.secrets
          ? 'It has no key, so it is not served. Its stored data is kept. Give it a key with Replace key, or remove it.'
          : 'Not listed in the env file, so it is not served. Its stored data is kept.',
      keyVariable: null,
      keyValid: null,
      verifiedAt: r.verifiedAt,
      checkedAt: null,
      settings: r.settings,
      settingsProblem: r.settingsProblem,
      keySource: null,
      keyHint: null,
      keyConflict: null,
      draining: false,
      archivedAt: r.archivedAt,
    };
  }

  private emit(v: ProjectView): void {
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch (err) {
        this.log.warn({ err }, 'a project change listener failed');
      }
    }
  }
}

/** The key's name for messages: its env variable, or "the stored key". Never the key. */
function keyLabel(e: Entry): string {
  return e.config.keyVariable && e.source === 'env'
    ? e.config.keyVariable
    : `the stored key of "${e.config.name}"`;
}

/** OPS2: a key check that LegendKeeper refused or could not answer, in the owner's terms. */
function keyCheckError(err: unknown): ProjectChangeError {
  const lk = err instanceof BridgeLkError ? err : undefined;
  const status = lk?.status;
  if (status === 401 || status === 403) {
    return new ProjectChangeError(
      'KEY_REFUSED',
      `LegendKeeper refused this key (${status}${lk?.code ? ` ${lk.code}` : ''}). Check that it was copied whole and has not been revoked.`,
    );
  }
  if (status === 402) {
    return new ProjectChangeError(
      'PAID_PLAN_REQUIRED',
      'LegendKeeper says the project owner needs a paid plan (402), so the key cannot be used.',
    );
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new ProjectChangeError(
      'KEY_CHECK_FAILED',
      `LegendKeeper answered the key check with ${status}${lk?.code ? ` ${lk.code}` : ''}.`,
    );
  }
  return new ProjectChangeError(
    'LK_UNREACHABLE',
    err instanceof BudgetWaitError
      ? 'The key could not be checked: the request budget is exhausted for now. Try again shortly.'
      : 'LegendKeeper could not be reached to check the key. Nothing was stored. Try again shortly.',
  );
}

/** OPS2: what `defaultProject()` returns when the bridge serves no project at all. */
const NO_PROJECT: ProjectView = Object.freeze({
  name: '',
  id: null,
  displayName: null,
  isDefault: true,
  isSandbox: false,
  readOnly: false,
  configured: false,
  registered: false,
  status: 'not_configured',
  reason: "This bridge serves no project yet: the owner adds one on the dashboard's Projects page.",
  keyVariable: null,
  keyValid: null,
  verifiedAt: null,
  checkedAt: null,
  settings: {},
  settingsProblem: null,
  keySource: null,
  keyHint: null,
  keyConflict: null,
  draining: false,
  archivedAt: null,
});

export function createProjectRegistry(o: CreateProjectRegistryOptions): ProjectRegistry {
  return new ProjectRegistry(o);
}
