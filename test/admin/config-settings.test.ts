/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed JSON replies in tests */
/**
 * v3 F8 (ADR 0073): every setting on the dashboard. The real bridge (admin stack) with the mock LegendKeeper:
 *
 * - precedence: default → environment → dashboard → reset, on the page and where the configuration is loaded;
 * - the six settings that existed before F8 keep their stored values, keys and behaviour;
 * - validation: ranges, whole numbers, enums, rules between settings, and display-unit conversions;
 * - apply modes: two `now` settings change behaviour at once (an image limit, a timeout); a `next_start` one is pending;
 * - bootstrap settings and secrets cannot be edited through the API; no admin response carries a secret's value;
 * - every change is in Recent changes with its old and new value (ADR 0081: no fresh authenticator code);
 * - "Restart the bridge": drain, exit 75 (a fake exit), recorded as the owner's request; disabled outside systemd.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEffectiveConfiguration } from '../../src/config/effective.js';
import { loadToolsConfig } from '../../src/config/tools.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { NOT_UNDER_SYSTEMD, RESTART_EXIT_CODE } from '../../src/admin/restart.js';
import { ownerCredentials, throwawaySecret } from '../auth/helpers.js';
import { PUBLIC_URL, startAdminStack, type AdminStack } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const entry = (view: any, key: string) => view.entries.find((e: any) => e.key === key);
const config = async (s: AdminStack) => {
  const r = await s.get('/api/admin/settings/config');
  expect(r.status, r.text).toBe(200);
  return r.json;
};
const put = (s: AdminStack, key: string, body: Record<string, unknown>) =>
  s.put(`/api/admin/settings/config/${key}`, { ...body, confirm: true });
const reset = (s: AdminStack, key: string) =>
  s.post(`/api/admin/settings/config/${key}/reset`, { confirm: true });

describe('the Settings page’s model, on the real bridge', () => {
  let s: AdminStack;
  beforeAll(async () => {
    const env = { IMAGE_MAX_FRAMES: '200', LOG_LEVEL: 'warn' };
    s = await startAdminStack({ processEnv: env, toolsSettings: loadToolsConfig(env) });
    await s.runtime.ready;
  });
  afterAll(async () => s?.close());

  it('lists every registry entry by group, with value, source, range, unit and how it applies', async () => {
    const v = await config(s);
    expect(v.groups.map((g: any) => g.label)).toContain('Images and uploads');
    expect(v.entries.length).toBeGreaterThan(100);
    const upload = entry(v, 'UPLOAD_MAX_BYTES');
    expect(upload).toMatchObject({
      group: 'images',
      label: 'Largest image upload',
      value: 10 * 1024 * 1024,
      source: 'default',
      min: 1024,
      max: 100 * 1024 * 1024,
      unit: { base: 'bytes', display: 'MB', factor: 1024 * 1024 },
      applies: 'next_start',
      editable: true,
      pendingRestart: false,
    });
    expect(entry(v, 'DB_PATH')).toMatchObject({ applies: 'bootstrap', editable: false, editedOn: 'server' });
    expect(entry(v, 'imageStagingMaxDays')).toMatchObject({
      editedOn: 'projects',
      managedAt: { href: '/ui/projects' },
    });
    expect(entry(v, 'IMAGE_STAGING_MAX_DAYS').projectSetting).toBe('imageStagingMaxDays');
    expect(v.pendingRestart).toBe(0);
  });

  it('precedence: default → environment → dashboard → reset (back to the environment)', async () => {
    // Default (no variable): source default.
    expect(entry(await config(s), 'IMAGE_MAX_PIXELS')).toMatchObject({
      value: 100_000_000,
      source: 'default',
    });
    // Environment.
    expect(entry(await config(s), 'IMAGE_MAX_FRAMES')).toMatchObject({
      value: 200,
      source: 'environment',
      environment: 200,
      dashboard: null,
    });
    // Dashboard wins.
    const set = await put(s, 'IMAGE_MAX_FRAMES', { value: 150 });
    expect(set.status, set.text).toBe(200);
    expect(set.json.entry).toMatchObject({
      value: 150,
      source: 'dashboard',
      environment: 200,
      dashboard: 150,
    });
    // Reset: back to the environment's value.
    const back = await reset(s, 'IMAGE_MAX_FRAMES');
    expect(back.json.entry).toMatchObject({ value: 200, source: 'environment', dashboard: null });
    // A key with no variable resets to its default.
    await put(s, 'IMAGE_MAX_PIXELS', { value: 5000 });
    expect((await reset(s, 'IMAGE_MAX_PIXELS')).json.entry).toMatchObject({
      value: 100_000_000,
      source: 'default',
    });
  });

  it('validation: ranges, whole numbers, types, enums, rules between settings and display units', async () => {
    const refused = async (key: string, body: Record<string, unknown>, re: RegExp) => {
      const r = await put(s, key, body);
      expect(r.status, `${key} ${JSON.stringify(body)}: ${r.text}`).toBe(400);
      expect(r.json.error.message).toMatch(re);
    };
    await refused('IMAGE_MAX_FRAMES', { value: 0 }, /at least 1/);
    await refused('IMAGE_MAX_FRAMES', { value: 10_001 }, /at most 10000/);
    await refused('IMAGE_MAX_FRAMES', { value: 2.5 }, /whole number/);
    await refused('IMAGE_MAX_FRAMES', { value: '30' }, /takes a number/);
    await refused('UPLOAD_ALLOW_URL_SOURCE', { value: 'yes' }, /takes a boolean/);
    await refused('LOG_LEVEL', { value: 'loud' }, /one of fatal, error/);
    // A rule between two settings (AUTH_REFRESH_FAMILY_MAX_SECONDS ≥ AUTH_REFRESH_TOKEN_TTL_SECONDS).
    await refused(
      'AUTH_REFRESH_FAMILY_MAX_SECONDS',
      { value: 3600 },
      /at least AUTH_REFRESH_TOKEN_TTL_SECONDS/,
    );
    // Reserve floors must rise (a pre-F8 setting, through its own action).
    await refused('RESERVE_FLOOR_JOB', { value: 0.9 }, /interactive <= job <= maintenance/);
    // v3 F9 (ADR 0074): the bulk floor below the maintenance floor, refused with both named.
    await refused(
      'RESERVE_FLOOR_BULK',
      { amount: 40, unit: '%' },
      /The bulk floor \(40%\) is below the maintenance floor \(50%\)/,
    );
    // Display units: MB → bytes, seconds → ms, % → fraction; another unit, or one that is not whole, is refused.
    const mb = await put(s, 'UPLOAD_MAX_BYTES', { amount: 20, unit: 'MB' });
    expect(mb.json.entry).toMatchObject({ value: 20 * 1024 * 1024, source: 'dashboard' });
    await refused('UPLOAD_MAX_BYTES', { amount: 1, unit: 'GB' }, /given in MB, not GB/);
    await refused('UPLOAD_FETCH_TIMEOUT_MS', { amount: 0.0001, unit: 'seconds' }, /not a whole number/);
    await refused('UPLOAD_MAX_BYTES', { amount: 0.0001, unit: 'MB' }, /not a whole number/);
    await refused('UPLOAD_MAX_BYTES', { amount: 200, unit: 'MB' }, /at most 104857600/);
    const secs = await put(s, 'UPLOAD_FETCH_TIMEOUT_MS', { amount: 2.5, unit: 'seconds' });
    expect(secs.json.entry.value).toBe(2500);
    const pct = await put(s, 'RESERVE_FLOOR_INTERACTIVE', { amount: 5, unit: '%' });
    expect(pct.status, pct.text).toBe(200);
    expect(pct.json.entry).toMatchObject({ value: 0.05, source: 'dashboard' });
    for (const k of ['UPLOAD_MAX_BYTES', 'UPLOAD_FETCH_TIMEOUT_MS', 'RESERVE_FLOOR_INTERACTIVE'])
      expect((await reset(s, k)).status).toBe(200);
  });

  it('`now`: an image limit and a timeout change behaviour at once; reset puts them back', async () => {
    const images = s.runtime.images;
    const big = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#808080' } })
      .png()
      .toBuffer();
    await expect(images.convert(big)).resolves.toBeTruthy();
    await expect(images.convert(fixture('animated.gif'))).resolves.toBeTruthy();
    expect((await put(s, 'IMAGE_MAX_PIXELS', { value: 2000 })).status).toBe(200);
    expect((await put(s, 'IMAGE_MAX_FRAMES', { value: 2 })).status).toBe(200);
    // No restart: the very next conversion uses the new limits.
    await expect(images.convert(big)).rejects.toThrow(/at most 2,000 are accepted/);
    await expect(images.convert(fixture('animated.gif'))).rejects.toThrow(/at most 2 are accepted/);
    // A timeout: the conversion deadline each conversion is given, and the URL fetch deadline the tools read.
    expect(images.limits().timeoutMs).toBe(60_000);
    expect((await put(s, 'IMAGE_CONVERT_TIMEOUT_MS', { amount: 5, unit: 'seconds' })).status).toBe(200);
    expect(images.limits().timeoutMs).toBe(5_000);
    expect((await put(s, 'UPLOAD_FETCH_TIMEOUT_MS', { value: 3000 })).status).toBe(200);
    expect(images.settings.upload.fetchTimeoutMs).toBe(3000);
    // The Staging page's own report reads the live value too.
    await put(s, 'IMAGE_STAGING_REPORT_DAYS', { value: 7 });
    expect((await s.get('/api/admin/staging?project=test')).json.reportDays).toBe(7);
    for (const k of [
      'IMAGE_MAX_PIXELS',
      'IMAGE_MAX_FRAMES',
      'IMAGE_CONVERT_TIMEOUT_MS',
      'UPLOAD_FETCH_TIMEOUT_MS',
      'IMAGE_STAGING_REPORT_DAYS',
    ])
      await reset(s, k);
    await expect(images.convert(big)).resolves.toBeTruthy();
    await expect(images.convert(fixture('animated.gif'))).resolves.toBeTruthy();
    expect(images.limits().timeoutMs).toBe(60_000);
    const v = await config(s);
    expect(entry(v, 'IMAGE_MAX_FRAMES')).toMatchObject({ value: 200, source: 'environment', running: 200 });
  });

  it('`next_start`: the change is stored and shown pending; the running value is unchanged', async () => {
    const before = s.runtime.images.settings.upload.maxBytes;
    const r = await put(s, 'UPLOAD_MAX_BYTES', { amount: 30, unit: 'MB' });
    expect(r.json.entry).toMatchObject({
      value: 30 * 1024 * 1024,
      running: 10 * 1024 * 1024,
      pendingRestart: true,
    });
    expect(s.runtime.images.settings.upload.maxBytes).toBe(before);
    await put(s, 'POLICY_PROPOSAL_EXPIRY_DAYS', { value: 7 });
    const v = await config(s);
    expect(v.pendingRestart).toBe(2);
    expect(
      v.entries
        .filter((e: any) => e.pendingRestart)
        .map((e: any) => e.key)
        .sort(),
    ).toEqual(['POLICY_PROPOSAL_EXPIRY_DAYS', 'UPLOAD_MAX_BYTES']);
    // Resetting to the value it started with: nothing pending.
    await reset(s, 'UPLOAD_MAX_BYTES');
    await reset(s, 'POLICY_PROPOSAL_EXPIRY_DAYS');
    expect((await config(s)).pendingRestart).toBe(0);
  });

  it('bootstrap settings, secrets and per-project settings cannot be set or reset here', async () => {
    const cases: [string, number, string][] = [
      ['DB_PATH', 409, 'SETTING_BOOTSTRAP'],
      ['BRIDGE_PUBLIC_URL', 409, 'SETTING_BOOTSTRAP'],
      ['LK_ASSET_HOSTS', 409, 'SETTING_BOOTSTRAP'],
      ['OUTBOUND_EXTRA_PORTS_ALLOWLIST', 409, 'SETTING_BOOTSTRAP'],
      ['PORT', 409, 'SETTING_BOOTSTRAP'],
      ['SESSION_SECRET', 409, 'SETTING_SECRET'],
      ['OWNER_PASSWORD_HASH', 409, 'SETTING_SECRET'],
      ['imageStagingMaxDays', 409, 'SETTING_PER_PROJECT'],
      ['LK_PROJECT_TEST_API_KEY', 404, 'SETTING_NOT_FOUND'],
      ['NO_SUCH_SETTING', 404, 'SETTING_NOT_FOUND'],
    ];
    for (const [key, status, code] of cases) {
      const a = await put(s, key, { value: key === 'PORT' ? 9999 : 'x' });
      const b = await reset(s, key);
      expect([a.status, a.json?.error?.code], key).toEqual([status, code]);
      expect([b.status, b.json?.error?.code], key).toEqual([status, code]);
    }
    expect(
      s.db.prepare("SELECT count(*) AS n FROM runtime_settings WHERE key LIKE 'dash.cfg.%'").get(),
    ).toEqual({ n: 0 });
    expect((await put(s, 'DB_PATH', { value: '/tmp/x' })).json.error.message).toMatch(
      /Change on the server: the env file, via env-sync/,
    );
  });

  it('every change is in Recent changes with its old and new value, and needs no step-up (ADR 0081)', async () => {
    await put(s, 'MAINTENANCE_DEFER_SECONDS', { value: 30 });
    await reset(s, 'MAINTENANCE_DEFER_SECONDS');
    const audit = (await s.get('/api/admin/audit?limit=5')).json.entries;
    expect(audit[0]).toMatchObject({
      action: 'settings.config_reset',
      target: 'MAINTENANCE_DEFER_SECONDS',
      before: { value: 30, source: 'dashboard' },
      after: { value: 15, source: 'default', applies: 'next_start' },
    });
    expect(audit[1]).toMatchObject({
      action: 'settings.config',
      target: 'MAINTENANCE_DEFER_SECONDS',
      before: { value: 15, source: 'default' },
      after: { value: 30, source: 'dashboard' },
    });
    s.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = NULL WHERE session_hash = ?')
      .run(s.services.sessionHash(s.sessionToken));
    const changed = await put(s, 'MAINTENANCE_DEFER_SECONDS', { value: 30 });
    const restored = await reset(s, 'MAINTENANCE_DEFER_SECONDS');
    const restart = await s.post('/api/admin/bridge/restart', { confirm: true });
    expect([changed.status, restored.status], changed.text).toEqual([200, 200]);
    expect([restart.status, restart.json.error.code]).toEqual([409, 'RESTART_UNAVAILABLE']); // not under systemd
    s.services.store.setReauth(s.services.sessionHash(s.sessionToken), Math.floor(Date.now() / 1000));
  });

  it('outside systemd (no INVOCATION_ID) the restart button is disabled and says why', async () => {
    const v = await config(s);
    expect(v.restart).toMatchObject({ available: false, reason: NOT_UNDER_SYSTEMD, inProgress: false });
    const r = await s.post('/api/admin/bridge/restart', { confirm: true });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('RESTART_UNAVAILABLE');
    expect(s.runtime.restarting).toBe(false);
  });
});

describe('the six settings that existed before F8', () => {
  let s: AdminStack;
  let dbPath: string;
  beforeAll(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'lkb-f8-')), 'bridge.db');
    const db = openDatabase(dbPath);
    runMigrations(db);
    const row = db.prepare(
      "INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, 1, 'owner')",
    );
    row.run('dash.expose_per_op_tools', 'true');
    row.run('dash.allow_member_admin', 'true');
    row.run('dash.journal_retention', JSON.stringify({ retentionDays: 12, maxBytes: 3 * 1024 ** 3 }));
    row.run('dash.tier_limits', JSON.stringify({ 'write-min': 100 }));
    row.run('dash.contact_email', JSON.stringify('owner@example.test'));
    row.run('dash.reserve_floors', JSON.stringify({ interactive: 0.2, job: 0.3, maintenance: 0.6 }));
    db.close();
    s = await startAdminStack({ dbPath });
    await s.runtime.ready;
  });
  afterAll(async () => s?.close());

  it('keep their stored values, applied as before, and show them as dashboard values', async () => {
    expect(s.runtime.config.mcp.exposePerOpTools).toBe(true);
    expect(s.runtime.config.lk.allowMemberAdmin).toBe(true);
    expect(s.runtime.config.journal).toEqual({ retentionDays: 12, maxBytes: 3 * 1024 ** 3 });
    expect(s.runtime.config.lk.tierLimits['write-min']).toBe(100);
    expect(s.runtime.projects.clients()[0]!.client.governor.settings.reserveFloors).toMatchObject({
      P1: 0.2,
      P2: 0.3,
      P3: 0.6,
    });
    const v = await config(s);
    const want: Record<string, unknown> = {
      MCP_EXPOSE_PER_OP_TOOLS: true,
      LK_ALLOW_MEMBER_ADMIN: true,
      JOURNAL_RETENTION_DAYS: 12,
      JOURNAL_MAX_BYTES: 3 * 1024 ** 3,
      LK_TIER_LIMITS: { 'write-min': 100 },
      CONTACT_EMAIL: 'owner@example.test',
      RESERVE_FLOOR_INTERACTIVE: 0.2,
      RESERVE_FLOOR_JOB: 0.3,
      RESERVE_FLOOR_MAINTENANCE: 0.6,
    };
    for (const [k, value] of Object.entries(want))
      expect(entry(v, k), k).toMatchObject({
        dashboard: value,
        value,
        source: 'dashboard',
        pendingRestart: false,
      });
    // The old route still reads them.
    const old = (await s.get('/api/admin/settings')).json.settings;
    expect(old.exposePerOpTools).toMatchObject({ stored: true, running: true, pendingRestart: false });
    expect(old.contactEmail.stored).toBe('owner@example.test');
  });

  it('are edited through their own actions, under their own keys and audit lines', async () => {
    const r = await put(s, 'MCP_EXPOSE_PER_OP_TOOLS', { value: false });
    expect(r.json.entry).toMatchObject({ value: false, running: true, pendingRestart: true });
    expect(
      s.db.prepare("SELECT value FROM runtime_settings WHERE key = 'dash.expose_per_op_tools'").get(),
    ).toEqual({
      value: 'false',
    });
    expect(s.audit('settings.expose_per_op_tools')[0]).toBeTruthy();
    await put(s, 'JOURNAL_RETENTION_DAYS', { value: 40 });
    expect(
      JSON.parse(
        (
          s.db.prepare("SELECT value FROM runtime_settings WHERE key = 'dash.journal_retention'").get() as {
            value: string;
          }
        ).value,
      ),
    ).toEqual({ retentionDays: 40, maxBytes: 3 * 1024 ** 3 });
    // v3 F9 (ADR 0074): the bulk floor, in the Governor and budgets group: unset it follows the maintenance floor
    // (0.6 here, below its 70% default, so 70%); set, it applies at once and is stored with the others.
    const gov = () => s.runtime.projects.clients()[0]!.client.governor.settings.reserveFloors;
    expect(entry(await config(s), 'RESERVE_FLOOR_BULK')).toMatchObject({
      group: 'governor',
      applies: 'now',
      value: 0.7,
      source: 'default',
      dashboard: null,
    });
    const b = await put(s, 'RESERVE_FLOOR_BULK', { amount: 85, unit: '%' });
    expect(b.status, b.text).toBe(200);
    expect(gov().P4).toBe(0.85);
    expect(entry(await config(s), 'RESERVE_FLOOR_BULK')).toMatchObject({ value: 0.85, source: 'dashboard' });
    expect(s.audit('budget.set_reserve_floors')[0]).toBeTruthy();
    await reset(s, 'RESERVE_FLOOR_BULK');
    expect(gov().P4).toBe(0.7);
    expect(gov().P3).toBe(0.6); // the others kept
    // A reserve floor: applies at once (the governor), stored as the trio.
    await put(s, 'RESERVE_FLOOR_JOB', { amount: 40, unit: '%' });
    expect(s.runtime.projects.clients()[0]!.client.governor.settings.reserveFloors.P2).toBe(0.4);
    // Read-only and writers: the engine's controls.
    await put(s, 'WRITERS_MAX', { value: 3 });
    expect(s.runtime.engine.queries.controls().writersMax).toBe(3);
    expect(entry(await config(s), 'WRITERS_MAX')).toMatchObject({ value: 3, source: 'dashboard' });
    await reset(s, 'WRITERS_MAX');
    expect(entry(await config(s), 'WRITERS_MAX')).toMatchObject({
      value: 2,
      source: 'default',
      dashboard: null,
    });
    await put(s, 'LK_READ_ONLY', { value: true });
    expect(s.runtime.engine.queries.controls().readOnly).toBe(true);
    await reset(s, 'LK_READ_ONLY');
    expect(s.runtime.engine.queries.controls().readOnlyOverride).toBeNull();
    // Tier limits as JSON; the contact email; their resets clear the stored value.
    await put(s, 'LK_TIER_LIMITS', { value: '{"write-min":90}' });
    expect(entry(await config(s), 'LK_TIER_LIMITS')).toMatchObject({ dashboard: { 'write-min': 90 } });
    expect((await put(s, 'LK_TIER_LIMITS', { value: '{"write-min":-1}' })).status).toBe(400);
    await reset(s, 'CONTACT_EMAIL');
    expect(
      s.db.prepare("SELECT count(*) AS n FROM runtime_settings WHERE key = 'dash.contact_email'").get(),
    ).toEqual({
      n: 0,
    });
  });
});

describe('precedence where the configuration is loaded (server.ts)', () => {
  it('dashboard → environment → default; bootstrap, secret and unknown rows ignored; a value that no longer loads left out', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const env = {
      BRIDGE_PUBLIC_URL: PUBLIC_URL,
      SESSION_SECRET: throwawaySecret(),
      JWT_SIGNING_KEY: throwawaySecret(),
      IMAGE_MAX_FRAMES: '200',
      AUTH_REFRESH_TOKEN_TTL_SECONDS: '7200',
    };
    const row = db.prepare(
      "INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, 1, 'owner')",
    );
    let loaded = loadEffectiveConfiguration(env, db);
    expect(loaded.bundle.toolsSettings.images.maxFrames).toBe(200); // environment
    expect(loaded.bundle.toolsSettings.images.maxPixels).toBe(100_000_000); // default
    row.run('dash.cfg.IMAGE_MAX_FRAMES', '120');
    row.run('dash.cfg.POLICY_PROPOSAL_EXPIRY_DAYS', '3');
    row.run('dash.cfg.DB_PATH', JSON.stringify('/tmp/elsewhere.db')); // bootstrap: never applied
    row.run('dash.cfg.SESSION_SECRET', JSON.stringify('x'.repeat(40))); // secret: never applied
    row.run('dash.cfg.NOT_A_SETTING', '1');
    // Valid when saved (family max ≥ TTL 7200), but the environment's TTL has since grown past it.
    row.run('dash.cfg.AUTH_REFRESH_FAMILY_MAX_SECONDS', '7300');
    loaded = loadEffectiveConfiguration({ ...env, AUTH_REFRESH_TOKEN_TTL_SECONDS: '8000' }, db);
    expect(loaded.bundle.toolsSettings.images.maxFrames).toBe(120); // dashboard
    expect(loaded.bundle.policySettings.proposalExpiryMs).toBe(3 * 86_400_000);
    expect(loaded.bundle.config.server.dbPath).toBe('./data/bridge.db');
    expect(loaded.bundle.config.auth.sessionSecret).toBe(env.SESSION_SECRET);
    expect(loaded.dropped).toEqual(['AUTH_REFRESH_FAMILY_MAX_SECONDS']);
    expect(loaded.bundle.authConfig.ttl.refreshFamilyMaxSeconds).toBe(90 * 86400);
    expect([...loaded.applied].sort()).toEqual(['IMAGE_MAX_FRAMES', 'POLICY_PROPOSAL_EXPIRY_DAYS']);
    db.close();
  });
});

describe('no admin response carries a secret’s value', () => {
  let s: AdminStack;
  const secrets: Record<string, string> = {};
  beforeAll(async () => {
    const { hash } = await ownerCredentials();
    Object.assign(secrets, {
      SECRETS_MASTER_KEY_PREVIOUS: throwawaySecret(),
      LK_PROJECT_ARKONA_API_KEY: `lkp_${throwawaySecret().replace(/[^A-Za-z0-9]/g, '')}`,
      OWNER_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      OWNER_PASSWORD_HASH: hash,
    });
    s = await startAdminStack({ processEnv: secrets });
    await s.runtime.ready;
  });
  afterAll(async () => s?.close());

  it('walks every GET route the admin plugin registers (and the settings edits) for every secret value', async () => {
    const env = s.runtime.configSettings.env;
    const values = Object.entries(env)
      .filter(([k]) => /SECRET|_KEY$|_KEY_|HASH|PASSWORD/.test(k) && !k.startsWith('LK_PROJECT_TEST_'))
      .map(([k, v]) => [k, v] as const)
      .filter((x): x is readonly [string, string] => typeof x[1] === 'string' && x[1].length >= 8);
    expect(values.map(([k]) => k).sort()).toEqual(
      [
        'JWT_SIGNING_KEY',
        'LK_API_KEY',
        'LK_PROJECT_ARKONA_API_KEY',
        'OWNER_PASSWORD_HASH',
        'OWNER_TOTP_SECRET',
        'SECRETS_MASTER_KEY',
        'SECRETS_MASTER_KEY_PREVIOUS',
        'SESSION_SECRET',
      ].sort(),
    );
    const bodies: string[] = [];
    const skipped: string[] = [];
    for (const r of s.routes.filter((x) => x.method === 'GET')) {
      if (r.url === '/api/admin/stream') {
        skipped.push(r.url);
        continue;
      }
      const path = r.url.replace(/:([A-Za-z]+)/g, (_, k: string) => (k === 'name' ? 'test' : 'f8x'));
      const res = await s.get(path);
      bodies.push(`${r.url} ${res.status} ${res.text}`);
    }
    bodies.push((await put(s, 'IMAGE_MAX_FRAMES', { value: 5 })).text);
    bodies.push((await reset(s, 'IMAGE_MAX_FRAMES')).text);
    bodies.push((await put(s, 'SESSION_SECRET', { value: 'y'.repeat(40) })).text);
    bodies.push((await s.get('/api/admin/audit?limit=50')).text);
    expect(bodies.length).toBeGreaterThan(50);
    const leaks = values.filter(([, v]) => bodies.some((b) => b.includes(v))).map(([k]) => k);
    expect(leaks).toEqual([]);
    // The secrets are listed by name, set or not set, with where they are managed.
    const v = await config(s);
    expect(entry(v, 'SESSION_SECRET')).toMatchObject({ secret: true, isSet: true, setIn: 'environment' });
    expect(entry(v, 'SESSION_SECRET').value).toBeUndefined();
    expect(entry(v, 'LK_PROJECT_<NAME>_API_KEY')).toMatchObject({
      isSet: true,
      managedAt: { href: '/ui/projects' },
    });
    expect(entry(v, 'OWNER_TOTP_SECRET')).toMatchObject({ isSet: true, managedAt: { href: '/ui/account' } });
    expect(skipped).toEqual(['/api/admin/stream']);
  });
});

describe('"Restart the bridge" under systemd', () => {
  let s: AdminStack;
  const exits: number[] = [];
  let dbPath: string;
  beforeAll(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'lkb-f8r-')), 'bridge.db');
    s = await startAdminStack({
      dbPath,
      processEnv: { INVOCATION_ID: '0123456789abcdef0123456789abcdef' },
      exit: (code) => exits.push(code),
      captureLogs: true,
    });
    await s.runtime.ready;
  });
  afterAll(async () => {
    try {
      await s?.close();
    } catch {
      // already stopped by the restart
    }
  });

  it('shows the pending count with the button; drains, flushes and exits 75, logged as the owner’s request', async () => {
    await put(s, 'UPLOAD_MAX_BYTES', { amount: 12, unit: 'MB' });
    const v = await config(s);
    expect(v.pendingRestart).toBe(1);
    expect(v.restart).toMatchObject({ available: true, reason: null, last: null });
    const r = await s.post('/api/admin/bridge/restart', { confirm: true });
    expect(r.status, r.text).toBe(202);
    for (let i = 0; i < 200 && exits.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect(s.runtime.restarting).toBe(true);
    const lines = s.logs.join('');
    expect(lines).toMatch(/restart requested by the owner/);
    expect(lines).toMatch(/restart requested by the owner: stopped, exiting for systemd/);
    expect(lines).not.toMatch(/"level":50.*restart/);
    // The database is closed by the stop: read the audit from the file.
    const db = openDatabase(dbPath);
    expect(
      db.prepare("SELECT actor, action FROM audit_log WHERE action = 'bridge.restart_requested'").all(),
    ).toEqual([{ actor: 'owner', action: 'bridge.restart_requested' }]);
    db.close();
  });

  it('after it comes back: recorded as restarted at the owner’s request, and the pending value applied', async () => {
    const again = await startAdminStack({ dbPath, processEnv: { INVOCATION_ID: 'next' } });
    try {
      await again.runtime.ready;
      expect(again.audit('bridge.restarted')[0]).toMatchObject({
        actor: 'system',
        after: { reason: 'restart requested by the owner' },
      });
      const v = await config(again);
      expect(v.restart.last).toMatchObject({ by: 'owner' });
      expect(v.restart.last.backAt as number).toBeGreaterThanOrEqual(v.restart.last.requestedAt as number);
      // The admin stack applies dashboard values only through the runtime, so the page's start snapshot is the stored
      // value: nothing is pending any more.
      expect(entry(v, 'UPLOAD_MAX_BYTES')).toMatchObject({ value: 12 * 1024 * 1024, pendingRestart: false });
      expect(v.pendingRestart).toBe(0);
    } finally {
      await again.close();
    }
  });
});
