/**
 * Dashboard values for registry settings (v3 F8, ADR 0073): stored in `runtime_settings` under `dash.cfg.<KEY>`, as
 * the JSON of a plain value (a number, a boolean or a string) in the setting's base unit.
 *
 * Precedence, the owner's: dashboard value → environment → default. It is applied where the configuration is loaded
 * (`./effective.ts`), so every component sees the effective value without knowing where it came from.
 *
 * Settings marked `applies: 'now'` are also read on each use: {@link liveToolsSettings} gives the tool settings getters
 * that return the current dashboard value, so a change applies at once (ADR 0073 decision 3). The settings that existed
 * before F8 keep their own keys and mechanisms (`src/admin/runtime-settings.ts`, the engine's controls).
 */
import type { Db } from '../db/open.js';
import { CFG_PREFIX, CONFIG_REGISTRY, editableHere, registryEntry, type SettingEntry } from './registry.js';
import {
  DEFAULT_ART_CACHE_SETTINGS,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_SNAPSHOT_SETTINGS,
  loadToolsConfig,
  type ToolsSettings,
} from './tools.js';

export type OverrideValue = number | boolean | string;

/** The text a value has as an environment variable (what the loaders parse). */
export function envString(v: OverrideValue): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

/** Registry keys a `dash.cfg.` value may exist for: editable here, and not one with its own pre-F8 mechanism. */
export function storesUnderCfg(e: SettingEntry): boolean {
  return editableHere(e) && e.legacy === null && e.scope === 'env';
}

function parseValue(raw: string): OverrideValue | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every stored `dash.cfg.` value whose key the registry knows and lets the dashboard store. A row for a bootstrap or
 * secret key, an unknown key, or a value that is not plain JSON is ignored (and reported in `ignored`, names only).
 */
export function readConfigOverrides(db: Pick<Db, 'prepare'>): {
  readonly values: Record<string, OverrideValue>;
  readonly ignored: readonly string[];
} {
  const values: Record<string, OverrideValue> = {};
  const ignored: string[] = [];
  let rows: { key: string; value: string }[];
  try {
    rows = db.prepare("SELECT key, value FROM runtime_settings WHERE key LIKE 'dash.cfg.%'").all() as {
      key: string;
      value: string;
    }[];
  } catch {
    return { values, ignored };
  }
  for (const r of rows) {
    const key = r.key.slice(CFG_PREFIX.length);
    const e = registryEntry(key);
    const v = parseValue(r.value);
    if (!e || !storesUnderCfg(e) || v === undefined) {
      ignored.push(key);
      continue;
    }
    values[key] = v;
  }
  return { values, ignored };
}

/** The environment with the dashboard's values on top (as strings, as the loaders read them). */
export function envWithOverrides(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, OverrideValue>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(overrides)) out[k] = envString(v);
  return out;
}

export interface LiveOverrides {
  /** The current dashboard value of `key`, or undefined. */
  get(key: string): OverrideValue | undefined;
  /** The value `key` had when this runtime was built (what the components were built with). */
  atStart(key: string): OverrideValue | undefined;
  /** Every current value. */
  all(): Readonly<Record<string, OverrideValue>>;
  /** Stores (or, with null, removes) one value. Returns the previous one. Validation is the caller's. */
  set(key: string, value: OverrideValue | null, by: string, nowMs: number): OverrideValue | undefined;
  /** Moves on with every change (what cached derived values compare against). */
  version(): number;
}

/** Reads the stored values once (the start), then keeps them in memory; every change is written through. */
export function createLiveOverrides(db: Pick<Db, 'prepare'>): LiveOverrides {
  const start = { ...readConfigOverrides(db).values };
  const current: Record<string, OverrideValue> = { ...start };
  let version = 0;
  return {
    get: (k) => current[k],
    atStart: (k) => start[k],
    all: () => ({ ...current }),
    version: () => version,
    set(key, value, by, nowMs) {
      const before = current[key];
      if (value === null) {
        db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(`${CFG_PREFIX}${key}`);
        delete current[key];
      } else {
        db.prepare(
          `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        ).run(`${CFG_PREFIX}${key}`, JSON.stringify(value), nowMs, by);
        current[key] = value;
      }
      version++;
      return before;
    },
  };
}

// --------------------------------------------------------------------------------------- the `now` settings

type Section = 'upload' | 'images' | 'snapshots' | null;

/**
 * Where each `applies: 'now'` tool setting lives in `ToolsSettings` (section, property). Every consumer reads these
 * through the shared settings object on each use (checked when F8 made them `now`, ADR 0073 decision 3), so a getter
 * there is enough.
 */
export const LIVE_TOOL_SETTINGS: Readonly<Record<string, readonly [Section, string]>> = {
  UPLOAD_FETCH_TIMEOUT_MS: ['upload', 'fetchTimeoutMs'],
  UPLOAD_PUT_TIMEOUT_MS: ['upload', 'putTimeoutMs'],
  IMAGE_MAX_PIXELS: ['images', 'maxPixels'],
  IMAGE_MAX_FRAMES: ['images', 'maxFrames'],
  IMAGE_CONVERT_TIMEOUT_MS: ['images', 'convertTimeoutMs'],
  IMAGE_UPLOAD_BODY_TIMEOUT_MS: ['images', 'bodyTimeoutMs'],
  IMAGE_UPLOAD_IDLE_TIMEOUT_MS: ['images', 'idleTimeoutMs'],
  IMAGE_STAGING_REPORT_DAYS: ['images', 'stagingReportDays'],
  IMAGE_STAGING_MAX_DAYS: ['images', 'stagingMaxDays'],
  IMAGE_STAGING_MIN_FREE_GB: ['images', 'stagingMinFreeBytes'],
  ASSET_BYTES_RETENTION_DAYS: ['images', 'keptBytesRetentionDays'],
  IMAGE_ARCHIVE_MAX_ENTRIES: ['images', 'archiveMaxEntries'],
  IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES: ['images', 'archiveMaxUncompressedBytes'],
  IMAGE_STAGED_MAX_BYTES: ['images', 'stagedMaxBytes'],
  SNAPSHOT_MIN_FREE_GB: ['snapshots', 'minFreeBytes'],
  SNAPSHOT_KEEP_FULL_DAYS: ['snapshots', 'keepFullDays'],
  SNAPSHOT_KEEP_WEEKLY: ['snapshots', 'keepWeekly'],
  SNAPSHOT_KEEP_DAYS: ['snapshots', 'keepDays'],
  SNAPSHOT_SOFT_DELETE_DAYS: ['snapshots', 'softDeleteDays'],
  MCP_RESULT_MAX_CHARS: [null, 'resultMaxChars'],
  // v3 F6a.1 (ADR 0076 amendment 1): read on each use by the Reference Type service and the watchdog.
  REFTYPE_BULK_MAX: [null, 'reftypeBulkMax'],
  SLOW_REQUEST_WARN_MS: [null, 'slowRequestWarnMs'],
  SLOW_REQUEST_REPEAT_MS: [null, 'slowRequestRepeatMs'],
  EVENT_LOOP_LAG_WARN_MS: [null, 'eventLoopLagWarnMs'],
  MEMORY_WARN_FRACTION: [null, 'memoryWarnFraction'],
};

/** The registry's `now` settings that are read through {@link liveToolsSettings} (the rest are the pre-F8 ones). */
export const LIVE_KEYS: readonly string[] = CONFIG_REGISTRY.filter(
  (e) => e.applies === 'now' && e.legacy === null && e.scope === 'env',
).map((e) => e.key);

/**
 * The tool settings with a getter for each `now` setting. A setting whose dashboard value is the one the runtime was
 * built with reads the built value; one changed since is worked out again, as the loader would at a start, from the
 * environment and the current dashboard values (cached until the next change). A value that no longer loads (it was
 * validated when stored, so only a changed environment could do this) falls back to the built value.
 */
export function liveToolsSettings(
  base: ToolsSettings,
  live: LiveOverrides,
  env: Readonly<Record<string, string | undefined>>,
): ToolsSettings {
  let cache: { version: number; settings: ToolsSettings | null } | null = null;
  const fresh = (): ToolsSettings | null => {
    if (cache?.version !== live.version()) {
      let settings: ToolsSettings | null;
      try {
        settings = loadToolsConfig(envWithOverrides(env, live.all()));
      } catch {
        settings = null;
      }
      cache = { version: live.version(), settings };
    }
    return cache.settings;
  };
  const sections = {
    upload: { ...base.upload },
    images: { ...(base.images ?? DEFAULT_IMAGE_SETTINGS) },
    snapshots: { ...(base.snapshots ?? DEFAULT_SNAPSHOT_SETTINGS) },
  };
  const top: Record<string, unknown> = {
    ...base,
    artCache: base.artCache ?? DEFAULT_ART_CACHE_SETTINGS,
  };
  for (const [key, [section, prop]] of Object.entries(LIVE_TOOL_SETTINGS)) {
    const target = (section === null ? top : sections[section]) as Record<string, unknown>;
    let built = target[prop];
    Object.defineProperty(target, prop, {
      enumerable: true,
      configurable: false,
      get: () => {
        if (live.get(key) === live.atStart(key)) return built;
        const f = fresh();
        if (!f) return built;
        const from = (section === null ? f : f[section]) as unknown as Record<string, unknown> | undefined;
        return from?.[prop] ?? built;
      },
      // An in-process assignment (a test seam, as before F8) replaces the built value.
      set: (v: unknown) => {
        built = v;
      },
    });
  }
  top.upload = sections.upload;
  top.images = sections.images;
  top.snapshots = sections.snapshots;
  return top as unknown as ToolsSettings;
}
