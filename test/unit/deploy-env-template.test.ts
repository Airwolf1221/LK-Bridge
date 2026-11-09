/**
 * deploy/env.template must list every variable the production bridge reads, and hold no secret. The lists are derived
 * from the zod schemas themselves, so a variable added to a loader later fails this test until the template (and
 * therefore the runbook) mentions it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadAdminConfig,
  loadAuthConfig,
  loadConfig,
  loadPolicyConfig,
  loadToolsConfig,
} from '../../src/config/index.js';

const root = new URL('../../', import.meta.url);
const template = readFileSync(new URL('deploy/env.template', root), 'utf8');
const envExample = readFileSync(new URL('.env.example', root), 'utf8');

const loaders: readonly (readonly [string, (env: NodeJS.ProcessEnv) => unknown])[] = [
  ['loadConfig', loadConfig],
  ['loadAuthConfig', loadAuthConfig],
  ['loadPolicyConfig', loadPolicyConfig],
  ['loadToolsConfig', loadToolsConfig],
  ['loadAdminConfig', loadAdminConfig],
];

/**
 * Runs every loader against an empty environment that records each name read. `read` is every variable any loader looks
 * at; `required` is every variable whose absence makes a loader fail (the issues name them).
 */
function inspectLoaders(given: Readonly<Record<string, string>> = {}): {
  read: Set<string>;
  required: Set<string>;
} {
  const read = new Set<string>();
  const required = new Set<string>();
  for (const [name, load] of loaders) {
    const env = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get: (_t, key) => {
          if (typeof key === 'string') read.add(key);
          return typeof key === 'string' ? given[key] : undefined;
        },
        has: (_t, key) => {
          if (typeof key === 'string') read.add(key);
          return typeof key === 'string' && key in given;
        },
      },
    );
    try {
      load(env);
    } catch (err) {
      const issues = (err as { issues?: readonly string[] }).issues;
      if (!Array.isArray(issues))
        throw new Error(`${name} failed in an unexpected way: ${String(err)}`, { cause: err });
      for (const issue of issues as string[]) {
        const m = /^([A-Z][A-Z0-9_]*)\b/.exec(issue);
        if (m?.[1]) required.add(m[1]);
      }
    }
  }
  return { read, required };
}

interface Parsed {
  /** NAME=value lines that are in force. */
  active: Map<string, string>;
  /** Names that appear only as `# NAME=…`. */
  commented: Set<string>;
  /** Every value on every line, commented or not. */
  values: string[];
}

function parse(text: string): Parsed {
  const active = new Map<string, string>();
  const commented = new Set<string>();
  const values: string[] = [];
  for (const line of text.split('\n')) {
    const a = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (a?.[1] !== undefined && a[2] !== undefined) {
      active.set(a[1], a[2]);
      values.push(a[2]);
      continue;
    }
    const c = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (c?.[1] !== undefined && c[2] !== undefined) {
      commented.add(c[1]);
      values.push(c[2]);
    }
  }
  return { active, commented, values };
}

/** The only variables that carry a value in the template: safe, documented production defaults. */
const PRODUCTION_DEFAULTS: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  HOST: '127.0.0.1',
  PORT: '8787',
  BRIDGE_PUBLIC_URL: 'https://lk.ottomoons.co.uk',
  TRUST_PROXY: 'loopback',
  DB_PATH: '/var/lib/lk-bridge/bridge.db',
  LK_READ_ONLY: 'true',
  LK_ALLOW_MEMBER_ADMIN: 'false',
  WRITERS_MAX: '1',
  MCP_EXPOSE_PER_OP_TOOLS: 'false',
  OWNER_USERNAME: 'owner',
  // v2 A1: the projects (names, not secrets); each project's key line stays blank.
  LK_PROJECTS: 'test',
  LK_DEFAULT_PROJECT: 'test',
};

describe('deploy/env.template', () => {
  const parsed = parse(template);
  // v2 A1: the template uses the multi-project form, so what it must set is derived with its own LK_PROJECTS (which
  // makes each project's LK_PROJECT_<NAME>_API_KEY required). What the loaders read is collected in both forms: the
  // single-project form's names (LK_API_KEY, LK_PROJECT_ID, LK_PROJECT_NAME) must still be mentioned, commented out.
  const multi = inspectLoaders({ LK_PROJECTS: parsed.active.get('LK_PROJECTS') ?? '' });
  const single = inspectLoaders();
  const required = multi.required;
  const read = new Set([...multi.read, ...single.read]);

  it('the derivation finds the variables we know are required (guards against an empty list)', () => {
    for (const name of [
      'BRIDGE_PUBLIC_URL',
      'LK_PROJECT_TEST_API_KEY',
      'SESSION_SECRET',
      'JWT_SIGNING_KEY',
      'OWNER_PASSWORD_HASH',
    ]) {
      expect(required, name).toContain(name);
    }
    // The single-project form is still recognised: without LK_PROJECTS, its key and id are what is required.
    for (const name of ['LK_API_KEY', 'LK_PROJECT_ID']) expect(single.required, name).toContain(name);
    for (const name of [
      'LK_PROJECTS',
      'LK_DEFAULT_PROJECT',
      'REQUIRE_PROJECT_FOR_WRITES',
      'LK_PROJECT_NAME',
    ]) {
      expect(read, name).toContain(name);
    }
    for (const name of [
      'TRUST_PROXY',
      'LK_READ_ONLY',
      'WRITERS_MAX',
      'DB_PATH',
      'ADMIN_STREAM_REPLAY_EVENTS',
    ]) {
      expect(read, name).toContain(name);
    }
  });

  it('sets every required variable (an uncommented NAME= line)', () => {
    const missing = [...required].filter((n) => !parsed.active.has(n));
    expect(missing).toEqual([]);
  });

  it('mentions every variable any config loader reads, set or commented out', () => {
    const missing = [...read].filter((n) => !parsed.active.has(n) && !parsed.commented.has(n));
    expect(missing).toEqual([]);
  });

  it('mentions every variable in .env.example', () => {
    const example = parse(envExample);
    const names = [...example.active.keys(), ...example.commented];
    const missing = names.filter((n) => !parsed.active.has(n) && !parsed.commented.has(n));
    expect(missing).toEqual([]);
  });

  it('carries the production defaults the runbook relies on', () => {
    expect(parsed.active.get('BRIDGE_PUBLIC_URL')).toBe('https://lk.ottomoons.co.uk');
    expect(parsed.active.get('TRUST_PROXY')).toBe('loopback');
    expect(parsed.active.get('LK_READ_ONLY')).toBe('true');
    expect(parsed.active.get('WRITERS_MAX')).toBe('1');
    expect(parsed.active.get('DB_PATH')).toBe('/var/lib/lk-bridge/bridge.db');
    expect(parsed.active.get('HOST')).toBe('127.0.0.1');
    // v2 A1: the projects, one key line each (blank), and no sandbox settings any more.
    expect(parsed.active.get('LK_PROJECTS')).toBe('test');
    expect(parsed.active.get('LK_DEFAULT_PROJECT')).toBe('test');
    expect(parsed.active.get('LK_PROJECT_TEST_API_KEY')).toBe('');
    expect(parsed.active.has('LK_SANDBOX_API_KEY')).toBe(false);
    expect(parsed.active.has('LK_SANDBOX_PROJECT_ID')).toBe(false);
    expect(parsed.commented.has('LK_SANDBOX_API_KEY')).toBe(false);
    // The single-project form's names are documented, commented out.
    for (const n of ['LK_API_KEY', 'LK_PROJECT_ID', 'LK_PROJECT_NAME'])
      expect(parsed.commented.has(n), n).toBe(true);
  });

  it('holds no values except the documented production defaults', () => {
    const withValues = [...parsed.active].filter(([, v]) => v !== '').map(([k]) => k);
    expect(withValues.filter((k) => !(k in PRODUCTION_DEFAULTS))).toEqual([]);
    for (const [k, v] of Object.entries(PRODUCTION_DEFAULTS)) {
      if (parsed.active.has(k)) expect(parsed.active.get(k), k).toBe(v);
    }
  });

  it('leaves every required variable and every credential-shaped name blank, except the public URL', () => {
    const secretish = [...parsed.active.keys(), ...parsed.commented].filter((n) =>
      /(SECRET|KEY|HASH|TOKEN|PASSWORD)/.test(n),
    );
    for (const name of new Set([...required, ...secretish])) {
      if (name in PRODUCTION_DEFAULTS) continue;
      expect(parsed.active.get(name) ?? '', name).toBe('');
    }
  });

  it('contains nothing that looks like a real secret, even in a comment', () => {
    for (const v of parsed.values) {
      expect(v).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
      expect(v).not.toMatch(/\$argon2/);
      expect(v).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
      expect(v).not.toMatch(/lkb_(rt|ac|pat|cs)_/);
    }
    expect(template).not.toMatch(/\$argon2|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
