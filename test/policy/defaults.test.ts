/**
 * Defaults and data model: the `legacy` migration of grants and PATs from before chunk 2b, PAT profiles from the
 * CLI, the default scope for new connections, and profile label rules.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { runPatCommand } from '../../src/auth/cli/pat.js';
import { defaultMigrationsDir, runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { createPolicy, suggestKind } from '../../src/policy/index.js';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lkb-policy-'));
  dirs.push(d);
  return d;
};
const silent = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  }) as unknown as pino.DestinationStream;

describe('migration 0300', () => {
  it('moves grants and PATs from before this chunk to a `legacy` profile at read', () => {
    const before = join(tmp(), 'migrations');
    mkdirSync(before);
    for (const f of ['0100_auth_init.sql', '0200_jobs_init.sql'])
      copyFileSync(join(defaultMigrationsDir(), f), join(before, f));
    const db = openDatabase(':memory:');
    dbs.push(db);
    runMigrations(db, before);
    db.prepare(
      `INSERT INTO auth_clients (client_id, kind, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, metadata, created_at, updated_at) VALUES ('c1', 'dcr', 'Old Claude', '[]', '[]', '[]', 'none', '{}', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO auth_token_families (family_id, client_id, scope, resource, created_at, expires_at)
       VALUES ('grant_old', 'c1', 'mcp', 'https://x/mcp', 1, 9999999999)`,
    ).run();
    db.prepare(
      `INSERT INTO auth_pats (id, name, token_hash, token_hint, scope, created_at) VALUES ('pat_old', 'laptop', 'h', 'abcd', 'mcp', 1)`,
    ).run();
    // Chunk 6 added migration 0400, chunk 8 0201, v1.0.1 0500, v1.0.2 0101, v2 A2 0700, v2 A3 0800 and v2 A1 0600 (which needs no project id
    // here: this database holds no LegendKeeper data); the point here is that 0300 is applied on top of an older
    // database.
    expect(runMigrations(db).applied).toEqual([
      '0101_client_assertion_jti.sql',
      '0201_journal_every_write.sql',
      '0300_policy_init.sql',
      '0400_maintenance_mappings.sql',
      '0500_governor_counters.sql',
      '0600_projects.sql',
      '0700_repository_tree.sql',
      '0800_type_registry.sql',
      '0900_asset_tree.sql',
    ]);
    const policy = createPolicy({ db, allowMemberAdmin: false });
    expect(policy.store.listProfiles()).toMatchObject([
      { id: 'prof_legacy', label: 'legacy', scope: 'read' },
    ]);
    expect(policy.store.lookupPrincipal('grant_old')).toMatchObject({
      principal: { principalId: 'grant_old', profile: 'legacy', label: 'Old Claude (OAuth)' },
      scope: 'read',
    });
    expect(policy.store.lookupPrincipal('pat_old')).toMatchObject({
      profileId: 'prof_legacy',
      scope: 'read',
    });
  });

  it('creates no legacy profile on a fresh database; the default scope is read', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    runMigrations(db);
    const policy = createPolicy({ db, allowMemberAdmin: false });
    expect(policy.store.listProfiles()).toEqual([]);
    expect(policy.commands.getDefaultScope('owner')).toBe('read');
    expect(policy.commands.createProfile('owner', { label: 'claude', kind: 'claude' }).scope).toBe('read');
    policy.commands.setDefaultScope('owner', 'propose');
    expect(policy.commands.createProfile('owner', { label: 'other one', kind: 'other' }).scope).toBe(
      'propose',
    );
    expect(policy.commands.listAudit('owner').map((a) => a.action)).toEqual([
      'profile.create',
      'policy.set_default_scope',
      'profile.create',
    ]);
  });

  it('validates labels, kinds and scopes', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    runMigrations(db);
    const { commands } = createPolicy({ db, allowMemberAdmin: false });
    for (const label of ['', ' ', 'system', 'Owner', '<b>', 'x'.repeat(65)]) {
      expect(() => commands.createProfile('owner', { label, kind: 'other' }), label).toThrow();
    }
    expect(() => commands.createProfile('owner', { label: 'ok', kind: 'robot' as never })).toThrow();
    expect(() =>
      commands.createProfile('owner', { label: 'ok', kind: 'other', scope: 'admin' as never }),
    ).toThrow();
    commands.createProfile('owner', { label: 'Claude', kind: 'claude' });
    expect(() => commands.createProfile('owner', { label: 'claude', kind: 'claude' })).toThrow(
      /already exists/,
    );
    expect(() => commands.listProfiles('agent' as never)).toThrow(/owner/);
  });

  it('suggests a kind from the redirect host only', () => {
    expect(suggestKind('https://claude.ai/api/mcp/auth_callback')).toBe('claude');
    expect(suggestKind('https://claude.com/api/mcp/auth_callback')).toBe('claude');
    expect(suggestKind('https://chatgpt.com/connector/oauth/abc')).toBe('chatgpt');
    expect(suggestKind('http://localhost:1234/callback')).toBe('claude-code');
    expect(suggestKind('http://127.0.0.1:1/callback')).toBe('claude-code');
    expect(suggestKind('https://claude.ai.evil.example/cb')).toBe('other');
  });
});

describe('npm run pat -- create --profile', () => {
  it('creates the profile if absent (default scope unless --scope), and lists it', () => {
    const path = join(tmp(), 'bridge.db');
    const out: string[] = [];
    const run = (...argv: string[]) => runPatCommand(argv, path, (s) => out.push(s), silent());
    expect(run('create', '--name', 'laptop')).toBe(0);
    expect(out.at(-1)).toContain('on profile "claude-code" (scope read)');
    expect(run('create', '--name', 'ci', '--profile', 'automation', '--scope', 'propose')).toBe(0);
    expect(out.at(-1)).toContain('on profile "automation" (scope propose)');
    expect(run('create', '--name', 'bad', '--scope', 'root')).toBe(2);
    out.length = 0;
    expect(run('list')).toBe(0);
    expect(out.join('\n')).toMatch(/profile claude-code \(read\).*laptop/);
    expect(out.join('\n')).toMatch(/profile automation \(propose\).*ci/);
    const db = openDatabase(path);
    dbs.push(db);
    const kinds = db.prepare('SELECT label, kind FROM agent_profiles ORDER BY label').all();
    expect(kinds).toEqual([
      { label: 'automation', kind: 'other' },
      { label: 'claude-code', kind: 'claude-code' },
    ]);
  });
});
