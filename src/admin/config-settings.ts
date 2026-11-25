/**
 * v3 F8 (ADR 0073): the Settings page's model. Every registry entry (src/config/registry.ts) with its effective value,
 * where that value comes from (default, environment or dashboard), its range and unit, how a change applies, and
 * whether one is pending until the next restart; and the edits: set (validated against the registry and the loaders)
 * and reset (back to the environment's value, or the default).
 *
 * - Settings that existed before F8 (read-only mode, writer slots, reserve floors, per-operation tools, member
 *   administration, journal retention, tier limits, the contact email) are edited through the actions they always
 *   had, under their own stored keys, with their own audit lines: their behaviour is unchanged.
 * - Every other editable setting is stored under `dash.cfg.<KEY>` and audited `settings.config` with its old and new
 *   value and source.
 * - Bootstrap settings and secrets are never stored here: a set or reset of one is refused. A secret's value is never
 *   read into a view: only whether it is set.
 */
import { WRITERS_LIMIT, WRITERS_MIN, type Config } from '../config/index.js';
import { SettingValueError, validateSettingValue } from '../config/effective.js';
import { storesUnderCfg, type LiveOverrides, type OverrideValue } from '../config/live.js';
import {
  CONFIG_REGISTRY,
  SETTING_GROUPS,
  editableHere,
  registryEntry,
  schemaField,
  type SettingEntry,
} from '../config/registry.js';
import { UnitConversionError, fromDisplay } from '../config/units.js';
import type { Db } from '../db/open.js';
import type { createAdminActions } from './actions.js';
import { AdminHttpError } from './http.js';
import type { RestartControl, RestartStatus } from './restart.js';
import {
  LIMITED_TIERS,
  dayFloorsSchema,
  readStoredSettings,
  reserveFloorsSchema,
  tierLimitsSchema,
  type DayReserveFloors,
  type ReserveFloors,
} from './runtime-settings.js';
import type { AdminRuntime } from './types.js';

/** What the runtime keeps for the Settings page (src/runtime.ts). */
export interface ConfigSettingsRuntime {
  /** The `dash.cfg.` values (current, and as they were at this start). */
  readonly live: LiveOverrides;
  /** The process environment the configuration was loaded from (read for registry names only). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly restart: RestartControl;
  /** Dashboard values left out at this start because they no longer loaded (names only). */
  readonly dropped?: readonly string[];
}

export type Source = 'default' | 'environment' | 'dashboard';

export interface ConfigEntryView {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingEntry['type'];
  readonly unit: SettingEntry['unit'];
  readonly default: unknown;
  readonly min: number | null;
  readonly max: number | null;
  readonly enum: readonly string[] | null;
  readonly integer: boolean;
  readonly applies: SettingEntry['applies'];
  readonly secret: boolean;
  readonly editedOn: SettingEntry['editedOn'];
  /** The Settings page may set and reset it. */
  readonly editable: boolean;
  readonly bootstrapReason: string | null;
  readonly managedAt: SettingEntry['managedAt'];
  readonly projectSetting: string | null;
  readonly scope: SettingEntry['scope'];
  /** Not for secrets (absent). */
  readonly value?: unknown;
  readonly source?: Source;
  readonly environment?: unknown;
  readonly dashboard?: unknown;
  /** The value the running components were built with (differs from `value` while a change is pending). */
  readonly running?: unknown;
  readonly pendingRestart: boolean;
  /** Secrets only: whether a value is set, and where. */
  readonly isSet?: boolean;
  readonly setIn?: 'environment' | 'secret store' | null;
}

export interface ConfigView {
  readonly groups: readonly { id: string; label: string }[];
  readonly entries: readonly ConfigEntryView[];
  readonly pendingRestart: number;
  readonly restart: RestartStatus;
  readonly dropped: readonly string[];
}

type Actions = ReturnType<typeof createAdminActions>;

/** The input of a set: a value in the base unit, or an amount in the setting's display unit. */
export type SetInput = { readonly value: unknown } | { readonly amount: number; readonly unit: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createConfigSettings(d: {
  readonly runtime: AdminRuntime;
  readonly cfg: ConfigSettingsRuntime;
  readonly actions: Actions;
  readonly db: Db;
  readonly now: () => number;
  /** Whether the owner's password and authenticator are kept in the encrypted store (for secrets' "set"). */
  readonly ownerStored?: () => { password: boolean; totp: boolean };
}) {
  const { runtime, cfg, actions, db } = d;
  const { engine } = runtime;
  const envConfig: Config = runtime.envConfig;
  const config: Config = runtime.config;
  const env = cfg.env;
  const audit = (action: string, target: string | null, before?: unknown, after?: unknown) =>
    runtime.policy.store.audit('owner', action, target, before, after);

  /** A variable's value from the environment, typed as the registry describes it (null: unset or unreadable). */
  const fromEnv = (e: SettingEntry): unknown => {
    const raw = env[e.key];
    if (raw === undefined || raw.trim() === '') return null;
    if (e.type === 'integer' || e.type === 'number' || e.type === 'boolean') {
      const schema = e.schemas[0];
      const r = schema ? schemaField(schema, e.key)?.safeParse(raw) : undefined;
      return r?.success ? r.data : null;
    }
    return raw;
  };

  const rawSetting = (key: string): unknown => {
    try {
      const r = db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      return r ? (JSON.parse(r.value) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };

  const runningFloors = () => {
    const g = runtime.projects.clients()[0]?.client.governor.settings.reserveFloors;
    return g
      ? { interactive: g.P1, job: g.P2, maintenance: g.P3, bulk: g.P4 }
      : { ...config.governor.reserveFloors };
  };
  const FLOOR_PART: Record<string, 'interactive' | 'job' | 'maintenance' | 'bulk'> = {
    RESERVE_FLOOR_INTERACTIVE: 'interactive',
    RESERVE_FLOOR_JOB: 'job',
    RESERVE_FLOOR_MAINTENANCE: 'maintenance',
    // v3 F9 (ADR 0074): stored only when the owner sets it; otherwise the environment's, or the default raised to P3.
    RESERVE_FLOOR_BULK: 'bulk',
  };
  // v3 F9 amendment 1 (ADR 0074): the daily tier's floors, stored together under their own key.
  const runningDayFloors = (): DayReserveFloors => {
    const g = runtime.projects.clients()[0]?.client.governor.settings.dayReserveFloors;
    return g
      ? { interactive: g.P1, job: g.P2, maintenance: g.P3, bulk: g.P4 }
      : { ...config.governor.dayReserveFloors };
  };
  const DAY_PARTS: Record<keyof DayReserveFloors, true> = {
    interactive: true,
    job: true,
    maintenance: true,
    bulk: true,
  };
  const DAY_FLOOR_PART: Record<string, keyof DayReserveFloors> = {
    RESERVE_DAY_FLOOR_INTERACTIVE: 'interactive',
    RESERVE_DAY_FLOOR_JOB: 'job',
    RESERVE_DAY_FLOOR_MAINTENANCE: 'maintenance',
    RESERVE_DAY_FLOOR_BULK: 'bulk',
  };
  const JOURNAL_PART: Record<string, 'retentionDays' | 'maxBytes'> = {
    JOURNAL_RETENTION_DAYS: 'retentionDays',
    JOURNAL_MAX_BYTES: 'maxBytes',
  };

  /** The pre-F8 settings: their environment, dashboard and running values, read where they always lived. */
  const legacyValues = (
    e: SettingEntry,
  ): { environment: unknown; dashboard: unknown; running: unknown; pending: boolean } => {
    const stored = readStoredSettings(db);
    const controls = engine.queries.controls();
    switch (e.legacy) {
      case 'readOnly':
        return {
          environment: envConfig.lk.readOnly,
          dashboard: controls.readOnlyOverride,
          running: controls.readOnly,
          pending: false,
        };
      case 'writersMax': {
        const v = rawSetting('jobs.writers_max');
        return {
          environment: envConfig.writers.max,
          dashboard: typeof v === 'number' ? v : null,
          running: controls.writersMax,
          pending: false,
        };
      }
      case 'reserveFloors': {
        const part = FLOOR_PART[e.key]!;
        return {
          environment: envConfig.governor.reserveFloors[part],
          dashboard: stored.reserveFloors?.[part] ?? null,
          running: runningFloors()[part],
          pending: false,
        };
      }
      case 'dayReserveFloors': {
        const part = DAY_FLOOR_PART[e.key]!;
        return {
          environment: envConfig.governor.dayReserveFloors[part],
          dashboard: stored.dayReserveFloors?.[part] ?? null,
          running: runningDayFloors()[part],
          pending: false,
        };
      }
      case 'exposePerOpTools':
        return {
          environment: envConfig.mcp.exposePerOpTools,
          dashboard: stored.exposePerOpTools,
          running: config.mcp.exposePerOpTools,
          pending:
            (stored.exposePerOpTools ?? envConfig.mcp.exposePerOpTools) !== config.mcp.exposePerOpTools,
        };
      case 'allowMemberAdmin':
        return {
          environment: envConfig.lk.allowMemberAdmin,
          dashboard: stored.allowMemberAdmin,
          running: config.lk.allowMemberAdmin,
          pending: (stored.allowMemberAdmin ?? envConfig.lk.allowMemberAdmin) !== config.lk.allowMemberAdmin,
        };
      case 'journal': {
        const part = JOURNAL_PART[e.key]!;
        return {
          environment: envConfig.journal[part],
          dashboard: stored.journal?.[part] ?? null,
          running: config.journal[part],
          pending: (stored.journal ?? envConfig.journal)[part] !== config.journal[part],
        };
      }
      case 'tierLimits': {
        const pick = (l: Config['lk']['tierLimits']) =>
          Object.fromEntries(LIMITED_TIERS.map((t) => [t, l[t] ?? null]));
        const running = pick(config.lk.tierLimits);
        const wanted = pick({ ...envConfig.lk.tierLimits, ...(stored.tierLimits ?? {}) });
        return {
          environment: pick(envConfig.lk.tierLimits),
          dashboard: stored.tierLimits,
          running,
          pending: !same(wanted, running),
        };
      }
      case 'contactEmail':
        return {
          environment: null,
          dashboard: stored.contactEmail,
          running: stored.contactEmail,
          pending: false,
        };
      default:
        return { environment: null, dashboard: null, running: null, pending: false };
    }
  };

  const secretSet = (e: SettingEntry): { isSet: boolean; setIn: 'environment' | 'secret store' | null } => {
    const inEnv = e.pattern
      ? Object.keys(env).some((k) => e.pattern!.test(k) && (env[k] ?? '').trim() !== '')
      : (env[e.key] ?? '').trim() !== '';
    if (inEnv) return { isSet: true, setIn: 'environment' };
    const stored = d.ownerStored?.();
    if (e.key === 'OWNER_PASSWORD_HASH' && stored?.password) return { isSet: true, setIn: 'secret store' };
    if (e.key === 'OWNER_TOTP_SECRET' && stored?.totp) return { isSet: true, setIn: 'secret store' };
    if (e.pattern && runtime.projects.list().length > 0) {
      // Project keys added on the dashboard live in the encrypted store only.
      return { isSet: true, setIn: 'secret store' };
    }
    return { isSet: false, setIn: null };
  };

  const viewOf = (e: SettingEntry): ConfigEntryView => {
    const base = {
      key: e.key,
      group: e.group,
      label: e.label,
      description: e.description,
      type: e.type,
      unit: e.unit,
      default: e.default,
      min: e.min,
      max: e.max,
      enum: e.enum,
      integer: e.integer,
      applies: e.applies,
      secret: e.secret,
      editedOn: e.editedOn,
      editable: editableHere(e),
      bootstrapReason: e.bootstrapReason,
      managedAt: e.managedAt,
      projectSetting: e.projectSetting,
      scope: e.scope,
    };
    if (e.secret) return { ...base, pendingRestart: false, ...secretSet(e) };
    if (e.scope === 'project') {
      return { ...base, value: e.default, source: 'default', running: e.default, pendingRestart: false };
    }
    if (e.legacy) {
      const l = legacyValues(e);
      const dashboard = l.dashboard ?? null;
      const environment = l.environment ?? null;
      const source: Source =
        dashboard !== null
          ? 'dashboard'
          : env[e.key] !== undefined && env[e.key] !== ''
            ? 'environment'
            : 'default';
      // v3 F9 (ADR 0074): a bulk floor set nowhere follows the maintenance floor up: shown as it runs.
      const derived = e.key === 'RESERVE_FLOOR_BULK' && source === 'default';
      const value = derived ? l.running : (dashboard ?? environment ?? e.default);
      return {
        ...base,
        value,
        source,
        environment,
        dashboard,
        running: l.running,
        pendingRestart: l.pending,
      };
    }
    const environment = fromEnv(e);
    const dashboard = storesUnderCfg(e) ? (cfg.live.get(e.key) ?? null) : null;
    const startDash = storesUnderCfg(e) ? (cfg.live.atStart(e.key) ?? null) : null;
    const source: Source =
      dashboard !== null ? 'dashboard' : environment !== null ? 'environment' : 'default';
    const value = dashboard ?? environment ?? e.default;
    const running = e.applies === 'now' ? value : (startDash ?? environment ?? e.default);
    return {
      ...base,
      value,
      source,
      environment,
      dashboard,
      running,
      pendingRestart: e.applies === 'next_start' && !same(dashboard, startDash),
    };
  };

  const list = (): ConfigView => {
    const entries = CONFIG_REGISTRY.map(viewOf);
    return {
      groups: SETTING_GROUPS,
      entries,
      pendingRestart: entries.filter((x) => x.pendingRestart).length,
      restart: cfg.restart.status(),
      dropped: cfg.dropped ?? [],
    };
  };

  const entryOr404 = (key: string): SettingEntry => {
    const e = registryEntry(key);
    if (!e || e.pattern) throw new AdminHttpError(404, 'SETTING_NOT_FOUND', `No setting ${key.slice(0, 80)}`);
    return e;
  };

  const refuseIfNotEditable = (e: SettingEntry) => {
    if (e.secret)
      throw new AdminHttpError(
        409,
        'SETTING_SECRET',
        `${e.key} is secret: it is never shown or changed here. Change it on ${e.managedAt?.label ?? 'the server'}.`,
      );
    if (e.applies === 'bootstrap' || e.editedOn === 'server')
      throw new AdminHttpError(
        409,
        'SETTING_BOOTSTRAP',
        `${e.key} is a bootstrap setting. Change on the server: the env file, via env-sync. (${e.bootstrapReason ?? ''})`,
      );
    if (e.editedOn === 'projects')
      throw new AdminHttpError(
        409,
        'SETTING_PER_PROJECT',
        `${e.key} is set per project, on the Projects page.`,
      );
  };

  /** The input in the base unit (an amount in the display unit is converted, exactly, or refused). */
  const baseValue = (e: SettingEntry, input: SetInput): unknown => {
    if ('amount' in input) {
      if (!e.unit) throw new AdminHttpError(400, 'INVALID_INPUT', `${e.key} has no unit; send "value".`);
      try {
        return fromDisplay(input.amount, input.unit, e.unit, e.integer);
      } catch (err) {
        if (err instanceof UnitConversionError) throw new AdminHttpError(400, 'INVALID_INPUT', err.message);
        throw err;
      }
    }
    return input.value;
  };

  const bad = (err: unknown): never => {
    if (err instanceof SettingValueError) throw new AdminHttpError(400, 'INVALID_INPUT', err.message);
    throw err;
  };

  const number = (e: SettingEntry, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new AdminHttpError(400, 'INVALID_INPUT', `${e.key} takes a number.`);
    if (e.integer && !Number.isInteger(v))
      throw new AdminHttpError(400, 'INVALID_INPUT', `${e.key} must be a whole number.`);
    if ((e.min !== null && v < e.min) || (e.max !== null && v > e.max))
      throw new AdminHttpError(
        400,
        'INVALID_INPUT',
        `${e.key} must be from ${e.min ?? '−∞'} to ${e.max ?? '∞'}.`,
      );
    return v;
  };
  const boolean = (e: SettingEntry, v: unknown): boolean => {
    if (typeof v !== 'boolean')
      throw new AdminHttpError(400, 'INVALID_INPUT', `${e.key} takes true or false.`);
    return v;
  };

  /** A pre-F8 setting, through its own action (null: back to the environment's value). */
  /** `v` null: back to the environment's value. */
  const setLegacy = (e: SettingEntry, v: unknown): void => {
    const stored = readStoredSettings(db);
    switch (e.legacy) {
      case 'readOnly':
        actions.setReadOnly(v === null ? null : boolean(e, v));
        return;
      case 'writersMax':
        if (v === null) {
          actions.setWritersMax(envConfig.writers.max);
          db.prepare("DELETE FROM runtime_settings WHERE key = 'jobs.writers_max'").run();
        } else {
          const n = number(e, v);
          if (n < WRITERS_MIN || n > WRITERS_LIMIT) number(e, Number.NaN);
          actions.setWritersMax(n);
        }
        return;
      case 'reserveFloors': {
        const part = FLOOR_PART[e.key]!;
        // v3 F9: the bulk floor is carried only when it was saved; the three others as they run.
        const run = runningFloors();
        const from: ReserveFloors = stored.reserveFloors ?? {
          interactive: run.interactive,
          job: run.job,
          maintenance: run.maintenance,
        };
        let next: ReserveFloors;
        if (part === 'bulk') {
          const { bulk: _bulk, ...rest } = from;
          next = v === null ? rest : { ...rest, bulk: number(e, v) };
        } else next = { ...from, [part]: v === null ? envConfig.governor.reserveFloors[part] : number(e, v) };
        const ok = reserveFloorsSchema.safeParse(next);
        if (!ok.success)
          throw new AdminHttpError(400, 'INVALID_INPUT', ok.error.issues.map((i) => i.message).join('; '));
        const env = envConfig.governor.reserveFloors;
        const asEnv =
          next.bulk === undefined &&
          same([next.interactive, next.job, next.maintenance], [env.interactive, env.job, env.maintenance]);
        actions.setReserveFloors(asEnv ? null : next);
        return;
      }
      case 'dayReserveFloors': {
        // v3 F9 amendment 1: the four day floors are saved together; the others as they run.
        const part = DAY_FLOOR_PART[e.key]!;
        const from = stored.dayReserveFloors ?? runningDayFloors();
        const env = envConfig.governor.dayReserveFloors;
        const next = { ...from, [part]: v === null ? env[part] : number(e, v) };
        const ok = dayFloorsSchema.safeParse(next);
        if (!ok.success)
          throw new AdminHttpError(400, 'INVALID_INPUT', ok.error.issues.map((i) => i.message).join('; '));
        const asEnv = (Object.keys(DAY_PARTS) as (keyof DayReserveFloors)[]).every((k) => next[k] === env[k]);
        actions.setDayReserveFloors(asEnv ? null : next);
        return;
      }
      case 'exposePerOpTools':
        actions.setExposePerOpTools(v === null ? null : boolean(e, v));
        return;
      case 'allowMemberAdmin':
        actions.setAllowMemberAdmin(v === null ? null : boolean(e, v));
        return;
      case 'journal': {
        const part = JOURNAL_PART[e.key]!;
        const from = stored.journal ?? envConfig.journal;
        const next = { ...from, [part]: v === null ? envConfig.journal[part] : number(e, v) };
        actions.setJournalRetention(same(next, envConfig.journal) ? null : next);
        return;
      }
      case 'tierLimits': {
        if (v === null) {
          actions.setTierLimits(null);
          return;
        }
        let obj: unknown = v;
        if (typeof v === 'string') {
          try {
            obj = JSON.parse(v);
          } catch {
            throw new AdminHttpError(400, 'INVALID_INPUT', 'LK_TIER_LIMITS must be valid JSON.');
          }
        }
        const r = tierLimitsSchema.safeParse(obj);
        if (!r.success) throw new AdminHttpError(400, 'INVALID_INPUT', `LK_TIER_LIMITS: ${r.error.message}`);
        actions.setTierLimits(r.data);
        return;
      }
      case 'contactEmail':
        if (v !== null && typeof v !== 'string')
          throw new AdminHttpError(400, 'INVALID_INPUT', 'CONTACT_EMAIL takes an email address.');
        try {
          actions.setContactEmail(v);
        } catch {
          throw new AdminHttpError(400, 'INVALID_INPUT', 'Not an email address.');
        }
        return;
      default:
        return;
    }
  };

  const describe = (e: SettingEntry) => {
    const v = viewOf(e);
    return { value: v.value ?? null, source: v.source ?? null };
  };

  const set = (key: string, input: SetInput): ConfigEntryView => {
    const e = entryOr404(key);
    refuseIfNotEditable(e);
    const value = baseValue(e, input);
    if (value === null || value === undefined)
      throw new AdminHttpError(
        400,
        'INVALID_INPUT',
        'No value: use Reset to go back to the environment’s value.',
      );
    if (e.legacy) {
      setLegacy(e, value);
      return viewOf(e);
    }
    const before = describe(e);
    let v: OverrideValue;
    try {
      v = validateSettingValue(e, value, env, cfg.live.all());
    } catch (err) {
      return bad(err);
    }
    cfg.live.set(e.key, v, 'owner', d.now());
    const after = describe(e);
    audit('settings.config', e.key, before, { ...after, applies: e.applies });
    return viewOf(e);
  };

  const reset = (key: string): ConfigEntryView => {
    const e = entryOr404(key);
    refuseIfNotEditable(e);
    if (e.legacy) {
      setLegacy(e, null);
      return viewOf(e);
    }
    const before = describe(e);
    cfg.live.set(e.key, null, 'owner', d.now());
    const after = describe(e);
    audit('settings.config_reset', e.key, before, { ...after, applies: e.applies });
    return viewOf(e);
  };

  return { list, set, reset, entry: (key: string) => viewOf(entryOr404(key)) };
}

export type ConfigSettings = ReturnType<typeof createConfigSettings>;
