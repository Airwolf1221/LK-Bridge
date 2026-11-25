/**
 * v3 F8 (ADR 0073, S5): the settings registry is complete and agrees with the schemas, so every setting stays
 * reachable from the Settings page. This fails when:
 *
 * - a key in any config schema (or one `projectsFrom` reads) has no registry entry;
 * - an entry names a key that does not exist;
 * - `.env.example` or `deploy/env.template` lacks a non-secret key, or lists one the registry does not know;
 * - an entry's default or range disagrees with its schema.
 *
 * Plus the rules the registry itself relies on: bootstrap entries say why, secrets are marked, the `now` settings are
 * read live, the pre-F8 settings keep their stored keys, and CLAUDE.md tells the next session.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '../../src/admin/runtime-settings.js';
import { DYNAMIC_ENV_KEYS } from '../../src/config/index.js';
import { LIVE_KEYS, LIVE_TOOL_SETTINGS, envString } from '../../src/config/live.js';
import {
  CONFIG_REGISTRY,
  SCHEMAS,
  SETTING_GROUPS,
  registryEntry,
  schemaField,
  type EnvSchemaName,
} from '../../src/config/registry.js';
import { UNITS, fromDisplay, toDisplay } from '../../src/config/units.js';
import { PROJECT_SETTING_KEYS } from '../../src/projects/settings.js';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const envEntries = CONFIG_REGISTRY.filter((e) => e.scope === 'env');

/** Every `NAME=` line, set or commented out. */
function keysIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(line);
    if (m?.[1]) out.add(m[1]);
  }
  return [...out];
}

describe('the registry is complete', () => {
  it('every key of every config schema has an entry', () => {
    const missing: string[] = [];
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      for (const key of Object.keys(schema.shape)) {
        const e = registryEntry(key);
        if (!e || e.scope !== 'env') missing.push(`${name}: ${key}`);
        else if (!e.schemas.includes(name as EnvSchemaName)) missing.push(`${name}: ${key} (schemas)`);
      }
    }
    for (const key of DYNAMIC_ENV_KEYS) if (!registryEntry(key)) missing.push(`dynamic: ${key}`);
    expect(missing).toEqual([]);
  });

  it('every entry names a key that exists', () => {
    const known = new Set<string>([
      ...Object.values(SCHEMAS).flatMap((s) => Object.keys(s.shape)),
      ...DYNAMIC_ENV_KEYS,
    ]);
    expect(envEntries.filter((e) => !known.has(e.key)).map((e) => e.key)).toEqual([]);
    const projectKeys = new Set(PROJECT_SETTING_KEYS.map((p) => p.key));
    expect(
      CONFIG_REGISTRY.filter((e) => e.scope === 'project' && !projectKeys.has(e.key as never)).map(
        (e) => e.key,
      ),
    ).toEqual([]);
    // S6: every per-project setting is listed, edited on the Projects page.
    for (const p of PROJECT_SETTING_KEYS) {
      const e = registryEntry(p.key);
      expect(e?.editedOn, p.key).toBe('projects');
      expect(e?.managedAt?.href, p.key).toBe('/ui/projects');
    }
    expect(new Set(CONFIG_REGISTRY.map((e) => e.key)).size).toBe(CONFIG_REGISTRY.length);
  });

  for (const file of ['.env.example', 'deploy/env.template']) {
    it(`${file} lists every non-secret key and nothing the registry does not know`, () => {
      const listed = keysIn(read(file));
      const missing = envEntries
        .filter((e) => !e.secret && e.pattern === null && !listed.includes(e.key))
        .map((e) => e.key);
      const unknown = listed.filter((k) => !registryEntry(k));
      expect({ missing, unknown }).toEqual({ missing: [], unknown: [] });
    });
  }
});

describe('the registry agrees with the schemas', () => {
  const withField = envEntries.flatMap((e) =>
    e.schemas.map((s) => ({ e, schema: s, field: schemaField(s, e.key)! })),
  );

  it('each default is the schema’s', () => {
    const wrong: string[] = [];
    for (const { e, schema, field } of withField) {
      const unset = field.safeParse(undefined);
      if (e.default === null) {
        const empty =
          !unset.success ||
          unset.data === undefined ||
          (Array.isArray(unset.data) && unset.data.length === 0) ||
          (typeof unset.data === 'object' && unset.data !== null && Object.keys(unset.data).length === 0);
        if (!empty) wrong.push(`${schema}.${e.key}: the schema has a default, the registry none`);
        continue;
      }
      const given = field.safeParse(envString(e.default));
      if (!unset.success || !given.success || JSON.stringify(unset.data) !== JSON.stringify(given.data))
        wrong.push(`${schema}.${e.key}: registry ${String(e.default)}, schema ${JSON.stringify(unset.data)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('each range, whole-number rule and enum is the schema’s', () => {
    const wrong: string[] = [];
    const ok = (f: (typeof withField)[number]['field'], v: string) => f.safeParse(v).success;
    for (const { e, schema, field } of withField) {
      const at = `${schema}.${e.key}`;
      const step = e.integer ? 1 : 1e-6;
      if (e.min !== null) {
        if (!ok(field, String(e.min))) wrong.push(`${at}: min ${e.min} refused`);
        if (ok(field, String(e.min - step))) wrong.push(`${at}: below min accepted`);
      }
      if (e.max !== null) {
        if (!ok(field, String(e.max))) wrong.push(`${at}: max ${e.max} refused`);
        if (ok(field, String(e.max + step))) wrong.push(`${at}: above max accepted`);
      }
      if (e.integer && e.min !== null && ok(field, String(e.min + 0.5)))
        wrong.push(`${at}: a fraction accepted`);
      if (e.type === 'integer' || e.type === 'number') {
        if (e.min === null) wrong.push(`${at}: a number with no minimum`);
        if (ok(field, 'not-a-number')) wrong.push(`${at}: text accepted`);
      }
      if (e.enum) {
        for (const opt of e.enum) if (!ok(field, opt)) wrong.push(`${at}: ${opt} refused`);
        if (ok(field, 'not-an-option')) wrong.push(`${at}: an unknown option accepted`);
      }
      if (e.type === 'boolean' && !(ok(field, 'true') && ok(field, 'false')))
        wrong.push(`${at}: not a boolean`);
    }
    expect(wrong).toEqual([]);
  });

  it('the refactor kept every default and range (frozen as of F8)', () => {
    const table = Object.fromEntries(
      envEntries
        .filter((e) => e.type === 'integer' || e.type === 'number')
        .map((e) => [e.key, [e.default, e.min, e.max]]),
    );
    expect(table).toEqual({
      UPLOAD_MAX_BYTES: [10485760, 1024, 104857600],
      UPLOAD_FETCH_TIMEOUT_MS: [15000, 1000, 120000],
      UPLOAD_PUT_TIMEOUT_MS: [120000, 5000, 600000],
      IMAGE_MAX_PIXELS: [100000000, 1000, 1000000000],
      IMAGE_MAX_FRAMES: [300, 1, 10000],
      IMAGE_CONVERT_TIMEOUT_MS: [60000, 1000, 600000],
      IMAGE_CONVERT_CONCURRENCY: [1, 1, 4],
      // v3 F7c (ADR 0075, Z3): a runaway brake now (30 → 1,000 an hour; the range up to 100,000).
      IMAGE_UPLOAD_RATE_PER_PRINCIPAL: [1000, 1, 100000],
      IMAGE_UPLOAD_RATE_PER_IP: [60, 1, 100000],
      IMAGE_UPLOAD_BODY_TIMEOUT_MS: [120000, 5000, 1800000],
      IMAGE_UPLOAD_IDLE_TIMEOUT_MS: [15000, 1000, 300000],
      IMAGE_STAGING_REPORT_DAYS: [30, 1, 3650],
      IMAGE_STAGING_MAX_DAYS: [90, 1, 3650],
      IMAGE_STAGING_MIN_FREE_GB: [5, 0, 100000],
      ASSET_BYTES_RETENTION_DAYS: [90, 1, 3650],
      // v3 F7c (ADR 0075): image archives and the staging capacity.
      IMAGE_ARCHIVE_MAX_ENTRIES: [300, 1, 10000],
      IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES: [2147483648, 1048576, 21474836480],
      IMAGE_STAGED_MAX_BYTES: [5368709120, 1048576, 1099511627776],
      ART_CACHE_MAX_MB: [500, 1, 1000000],
      // v3 F7d (ADR 0077, A1): one groups call's limits.
      ART_CALL_MAX_IMAGES: [120, 1, 1000],
      ART_CALL_MAX_GROUPS: [40, 1, 200],
      WRITERS_MAX: [2, 1, 8],
      RESERVE_FLOOR_INTERACTIVE: [0.1, 0, 1],
      RESERVE_FLOOR_JOB: [0.25, 0, 1],
      RESERVE_FLOOR_MAINTENANCE: [0.5, 0, 1],
      RESERVE_FLOOR_BULK: [0.7, 0, 1], // v3 F9 (ADR 0074)
      // v3 F9 amendment 1 (ADR 0074): the daily tier's floors.
      RESERVE_DAY_FLOOR_INTERACTIVE: [0.02, 0, 1],
      RESERVE_DAY_FLOOR_JOB: [0.05, 0, 1],
      RESERVE_DAY_FLOOR_MAINTENANCE: [0.1, 0, 1],
      RESERVE_DAY_FLOOR_BULK: [0.15, 0, 1],
      WRITE_SPACING_MS: [500, 0, 60000],
      WRITE_SPACING_STRETCHED_MS: [1200, 0, 60000],
      POLICY_PROPOSAL_EXPIRY_DAYS: [14, 1, 365],
      POLICY_EXPIRY_SWEEP_SECONDS: [300, 10, 86400],
      POLICY_PROPOSAL_RETENTION_DAYS: [90, 1, 3650],
      MAINTENANCE_DEFER_SECONDS: [15, 1, 3600],
      MAINTENANCE_HISTORY_RUNS: [50, 1, 10000],
      SNAPSHOT_MIN_FREE_GB: [10, 0, 100000],
      SNAPSHOT_KEEP_FULL_DAYS: [30, 1, 3650],
      SNAPSHOT_KEEP_WEEKLY: [8, 0, 520],
      SNAPSHOT_KEEP_DAYS: [30, 1, 3650],
      SNAPSHOT_SOFT_DELETE_DAYS: [30, 1, 3650],
      JOURNAL_RETENTION_DAYS: [30, 1, 3650],
      JOURNAL_MAX_BYTES: [2147483648, 1048576, null],
      MCP_RESULT_MAX_CHARS: [40000, 4000, 400000],
      // v3 F6a.1 (ADR 0076 amendment 1, ADR 0061 amendment 1): the bulk accept's bound and the hang warnings.
      REFTYPE_BULK_MAX: [500, 1, 5000],
      // v3 F6b (ADR 0079).
      INDEX_CLASSIFY_BULK_MAX: [500, 1, 5000],
      // v3 F10 (ADR 0078): the chronology check after an edit (10 minutes).
      CHRONOLOGY_CHECK_DELAY_MS: [600000, 1000, 86400000],
      SLOW_REQUEST_WARN_MS: [30000, 1000, 3600000],
      SLOW_REQUEST_REPEAT_MS: [60000, 1000, 3600000],
      EVENT_LOOP_LAG_WARN_MS: [2000, 50, 600000],
      MEMORY_WARN_FRACTION: [0.7, 0, 1],
      AUTH_ACCESS_TOKEN_TTL_SECONDS: [3600, 60, 86400],
      AUTH_REFRESH_TOKEN_TTL_SECONDS: [2592000, 3600, 31536000],
      AUTH_REFRESH_FAMILY_MAX_SECONDS: [7776000, 3600, 63072000],
      AUTH_CODE_TTL_SECONDS: [300, 30, 600],
      AUTH_SESSION_TTL_SECONDS: [2592000, 300, 2592000],
      AUTH_REFRESH_GRACE_SECONDS: [10, 0, 60],
      AUTH_CIMD_TIMEOUT_MS: [4000, 100, 8000],
      AUTH_CIMD_MAX_BYTES: [8192, 512, 65536],
      ADMIN_STREAM_HEARTBEAT_SECONDS: [15, 1, 120],
      ADMIN_STREAM_REPLAY_EVENTS: [500, 0, 10000],
      ADMIN_BUDGET_PUSH_SECONDS: [2, 1, 60],
      PORT: [8787, 1, 65535],
    });
  });
});

describe('the registry’s own rules', () => {
  it('every group is known and has entries', () => {
    const ids = new Set<string>(SETTING_GROUPS.map((g) => g.id));
    expect(CONFIG_REGISTRY.filter((e) => !ids.has(e.group)).map((e) => e.key)).toEqual([]);
    for (const g of SETTING_GROUPS)
      expect(
        CONFIG_REGISTRY.some((e) => e.group === g.id),
        g.id,
      ).toBe(true);
  });

  it('bootstrap entries say why and are edited on the server; secrets are marked and never stored here', () => {
    for (const e of CONFIG_REGISTRY) {
      if (e.applies === 'bootstrap') {
        expect(e.bootstrapReason, e.key).toBeTruthy();
        expect(e.editedOn, e.key).toBe('server');
        expect(e.storedAs, e.key).toBeNull();
      }
      if (e.secret) {
        expect(e.applies, e.key).toBe('bootstrap');
        expect(e.managedAt, e.key).not.toBeNull();
      }
    }
    // A credential-shaped name is always secret.
    const credential = /(SECRET|_KEY$|_KEY_|HASH|PASSWORD)/;
    expect(envEntries.filter((e) => credential.test(e.key) && !e.secret).map((e) => e.key)).toEqual([]);
    expect(
      envEntries
        .filter((e) => e.secret)
        .map((e) => e.key)
        .sort(),
    ).toEqual([
      'JWT_SIGNING_KEY',
      'LK_API_KEY',
      'LK_PROJECT_<NAME>_API_KEY',
      'OWNER_PASSWORD_HASH',
      'OWNER_TOTP_SECRET',
      'SECRETS_MASTER_KEY',
      'SECRETS_MASTER_KEY_PREVIOUS',
      'SESSION_SECRET',
    ]);
    expect(registryEntry('LK_PROJECT_ARKONA_API_KEY')?.secret).toBe(true);
  });

  it('the bootstrap list (ADR 0073 decision 5)', () => {
    expect(
      CONFIG_REGISTRY.filter((e) => e.applies === 'bootstrap' && !e.secret)
        .map((e) => e.key)
        .sort(),
    ).toEqual(
      [
        'ART_CACHE_DIR',
        'AUTH_MCP_ALLOWED_ORIGINS',
        'BRIDGE_PUBLIC_URL',
        'DB_PATH',
        'HOST',
        'IMAGE_DATA_DIR',
        'LK_ASSET_HOSTS',
        'LK_BASE_URL',
        'LK_DEFAULT_PROJECT',
        'LK_PROJECTS',
        'LK_PROJECT_ID',
        'LK_PROJECT_NAME',
        'NODE_ENV',
        'OAUTH_EXTRA_REDIRECT_URIS',
        'OUTBOUND_EXTRA_PORTS_ALLOWLIST',
        'OWNER_USERNAME',
        'PORT',
        'SNAPSHOT_DIR',
        'TRUST_PROXY',
      ].sort(),
    );
  });

  it('every `now` setting is read live, and every live getter is a `now` setting', () => {
    expect([...LIVE_KEYS].sort()).toEqual(Object.keys(LIVE_TOOL_SETTINGS).sort());
  });

  it('the settings that existed before F8 keep their stored keys', () => {
    const stored = new Set(CONFIG_REGISTRY.map((e) => e.storedAs));
    for (const k of Object.values(SETTING_KEYS)) expect(stored.has(k), k).toBe(true);
    expect(registryEntry('LK_READ_ONLY')?.storedAs).toBe('jobs.read_only_override');
    expect(registryEntry('WRITERS_MAX')?.storedAs).toBe('jobs.writers_max');
    expect(registryEntry('UPLOAD_MAX_BYTES')?.storedAs).toBe('dash.cfg.UPLOAD_MAX_BYTES');
  });

  it('CLAUDE.md tells every session', () => {
    expect(read('CLAUDE.md')).toContain(
      'Every new setting goes in `src/config/registry.ts` (it then appears on the Settings page); secrets and bootstrap settings are marked so.',
    );
  });
});

describe('display units', () => {
  it('converts exactly, and refuses what does not come out whole or names another unit', () => {
    expect(toDisplay(10 * 1024 * 1024, UNITS.bytesAsMb)).toBe(10);
    expect(fromDisplay(1.5, 'MB', UNITS.bytesAsMb, true)).toBe(1572864);
    expect(fromDisplay(2.5, 'seconds', UNITS.msAsSeconds, true)).toBe(2500);
    expect(fromDisplay(10, '%', UNITS.percent, false)).toBe(0.1);
    expect(toDisplay(0.25, UNITS.percent)).toBe(25);
    expect(() => fromDisplay(0.0001, 'seconds', UNITS.msAsSeconds, true)).toThrow(/not a whole number/);
    expect(() => fromDisplay(1, 'GB', UNITS.bytesAsMb, true)).toThrow(/given in MB, not GB/);
    expect(() => fromDisplay(Number.NaN, 'MB', UNITS.bytesAsMb, true)).toThrow(/Not a number/);
  });
});
