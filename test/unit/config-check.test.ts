/**
 * `npm run config:check` (src/config/check.ts, OPS1): the boot check deploy.sh and env-sync.sh run before a restart.
 * It must run every loader the server runs, check project keys by format only, and never print a value.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkConfig, CONFIG_LOADERS, parseEnvFile, redact } from '../../src/config/check.js';

const KEY = 'TESTKEY-lk-api-key-0123456789abcdefXYZ';
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';
const SESSION = 'TESTSESSION-0123456789-0123456789-0123456789';
const JWT = 'TESTJWT-abcdefghij-abcdefghij-abcdefghij-abcd';

const valid = (extra: Record<string, string> = {}): Record<string, string> => ({
  BRIDGE_PUBLIC_URL: 'https://lk.example.com',
  LK_PROJECTS: 'test',
  LK_PROJECT_TEST_API_KEY: KEY,
  LK_DEFAULT_PROJECT: 'test',
  SESSION_SECRET: SESSION,
  JWT_SIGNING_KEY: JWT,
  OWNER_PASSWORD_HASH: HASH,
  SECRETS_MASTER_KEY: 'TESTMASTER-0123456789-0123456789-0123456789',
  ...extra,
});

describe('checkConfig', () => {
  it('accepts a complete configuration', () => {
    expect(checkConfig(valid())).toEqual({ ok: true, issues: [], warnings: [] });
  });

  it('runs every loader src/server.ts runs at start-up', () => {
    const server = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const main = /async function main\(\)[\s\S]*?\n\}/.exec(server)?.[0] ?? '';
    const called = [...main.matchAll(/= (load[A-Za-z]*Config)\(\)/g)].map((m) => m[1]).sort();
    expect(called.length).toBeGreaterThanOrEqual(6);
    expect(CONFIG_LOADERS.map(([n]) => n).sort()).toEqual(called);
  });

  it('reports problems from each loader by name, and never a value', () => {
    const r = checkConfig(
      valid({
        SESSION_SECRET: 'short-secret-value',
        WRITERS_MAX: '99',
        POLICY_PROPOSAL_EXPIRY_DAYS: '0',
        MAINTENANCE_DEFER_SECONDS: 'x',
        ADMIN_STREAM_REPLAY_EVENTS: '-1',
        UPLOAD_MAX_BYTES: '1',
        OWNER_PASSWORD_HASH: 'not-a-hash-value',
      }),
    );
    expect(r.ok).toBe(false);
    const text = r.issues.join('\n');
    for (const name of [
      'SESSION_SECRET',
      'WRITERS_MAX',
      'POLICY_PROPOSAL_EXPIRY_DAYS',
      'MAINTENANCE_DEFER_SECONDS',
      'ADMIN_STREAM_REPLAY_EVENTS',
      'UPLOAD_MAX_BYTES',
      'OWNER_PASSWORD_HASH',
    ]) {
      expect(text, name).toMatch(new RegExp(name));
    }
    expect(text).not.toMatch(/short-secret-value|not-a-hash-value/);
  });

  it('checks each project key by format only (no network), naming the variable', () => {
    for (const bad of ['has a space in it 1234567', `"${KEY}"`, 'short', `${KEY}\nx`]) {
      const r = checkConfig(valid({ LK_PROJECT_TEST_API_KEY: bad }));
      expect(r.issues.join('\n'), bad).toMatch(/LK_PROJECT_TEST_API_KEY: not a valid API key/);
      expect(r.issues.join('\n')).not.toContain(bad);
    }
    // The single-project form's key too, with its warning.
    const single = checkConfig({
      ...valid(),
      LK_PROJECTS: '',
      LK_PROJECT_TEST_API_KEY: '',
      LK_DEFAULT_PROJECT: '',
      LK_API_KEY: 'bad key',
      LK_PROJECT_ID: 'p1',
    });
    expect(single.issues.join('\n')).toMatch(/LK_API_KEY: not a valid API key/);
    expect(single.warnings.join('\n')).toMatch(/single-project form/);
  });

  it('OPS2: a listed project without an env key is a warning (its key may be in the encrypted store)', () => {
    const r = checkConfig(valid({ LK_PROJECTS: 'test,arkona' }));
    expect(r.issues.join('\n')).not.toMatch(/LK_PROJECT_ARKONA_API_KEY/);
    expect(r.warnings.join('\n')).toMatch(/LK_PROJECT_ARKONA_API_KEY is not set/);
  });

  it('OPS2: a short master key, or one equal to another secret, is an issue here (the bridge itself only warns)', () => {
    const short = checkConfig(valid({ SECRETS_MASTER_KEY: 'short-but-set' }));
    expect(short.issues.join('\n')).toMatch(/SECRETS_MASTER_KEY: at least 32 characters/);
    const env = valid({});
    const same = checkConfig({ ...env, SECRETS_MASTER_KEY: env.SESSION_SECRET });
    expect(same.issues.join('\n')).toMatch(
      /SECRETS_MASTER_KEY: must differ from SESSION_SECRET and JWT_SIGNING_KEY/,
    );
    const prev = checkConfig(
      valid({ SECRETS_MASTER_KEY: 'a'.repeat(44), SECRETS_MASTER_KEY_PREVIOUS: 'a'.repeat(44) }),
    );
    expect(prev.issues.join('\n')).toMatch(/SECRETS_MASTER_KEY_PREVIOUS: must differ/);
    for (const r of [short, same, prev]) expect(r.issues.join('\n')).not.toMatch(/short-but-set|aaaaaaaa/);
  });
});

describe('parseEnvFile and redact', () => {
  it('parses like systemd and env_file_get: last wins, quotes and whitespace stripped, comments ignored', () => {
    expect(parseEnvFile(`# A=commented\nA=1\nA=2\n  B = x\nC='$x y'\nD="q"\r\nE=\nnot a line\n`)).toEqual({
      A: '2',
      C: '$x y',
      D: 'q',
      E: '',
    });
  });

  it('redacts every credential value, longest first', () => {
    const env = { SESSION_SECRET: 'abcdef', LK_PROJECT_TEST_API_KEY: 'abcdefgh', PORT: '8787' };
    expect(redact('x abcdefgh y abcdef z 8787', env)).toBe('x [redacted] y [redacted] z 8787');
  });
});

describe('dist/config/check.js as a program (run with tsx here)', () => {
  const run = (file: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/config/check.ts', '--file', file], {
      encoding: 'utf8',
      cwd: new URL('../../', import.meta.url).pathname,
    });

  it('exits 0 for a valid file, 1 with one issue line per problem, 2 for an unreadable file; never a value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-config-check-'));
    try {
      const file = join(dir, 'env');
      const lines = (o: Record<string, string>) =>
        Object.entries(o)
          .map(([k, v]) => `${k}='${v}'`)
          .join('\n');
      writeFileSync(file, lines(valid()));
      const ok = run(file);
      expect(ok.stdout).toMatch(/config check: OK/);
      expect(ok.status).toBe(0);
      writeFileSync(
        file,
        lines(valid({ SESSION_SECRET: 'short-secret-value', LK_PROJECT_TEST_API_KEY: 'bad key value!' })),
      );
      const bad = run(file);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/^issue: SESSION_SECRET/m);
      expect(bad.stdout).toMatch(/^issue: LK_PROJECT_TEST_API_KEY: not a valid API key/m);
      expect(bad.stdout).toMatch(/config check: FAILED/);
      for (const v of ['short-secret-value', 'bad key value!', JWT, HASH]) {
        expect(bad.stdout + bad.stderr).not.toContain(v);
      }
      expect(run(join(dir, 'missing')).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
