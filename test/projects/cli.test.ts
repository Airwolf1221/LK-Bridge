/**
 * `npm run projects` (v2 A1): lists the registered projects and sets the sandbox flag, which only the server's shell
 * can change (the dashboard shows it read-only). Every change is audited.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { runProjectsCommand } from '../../src/projects/cli.js';
import { ProjectStore } from '../../src/projects/index.js';

const dir = mkdtempSync(join(tmpdir(), 'lkb-projects-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(dbPath: string, ...argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = runProjectsCommand(argv, dbPath, (s) => lines.push(s));
  return { code, out: lines.join('\n') };
}

describe('npm run projects', () => {
  const dbPath = join(dir, 'bridge.db');

  it('says so when no project is registered yet', () => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();
    expect(run(dbPath, 'list')).toEqual({
      code: 0,
      out: expect.stringMatching(/No project is registered yet/) as string,
    });
  });

  it('lists projects and marks one as a sandbox, audited; refuses an unknown name and bad usage', () => {
    const db = openDatabase(dbPath);
    const store = new ProjectStore(db, () => 1_000);
    store.insert({ id: 'lkp_test', name: 'test', displayName: 'Test world', verifiedAt: 1_000 });
    store.insert({ id: 'lkp_arkona', name: 'arkona', displayName: 'Arkona', verifiedAt: 1_000 });
    db.close();

    expect(run(dbPath, 'list').out).toMatch(
      /test {2}id lkp_test {2}"Test world" {2}default no {2}sandbox no/,
    );
    const on = run(dbPath, 'sandbox', 'Test', 'on');
    expect(on.code).toBe(0);
    expect(on.out).toMatch(/is now a sandbox/);
    expect(run(dbPath, 'sandbox', 'test', 'on').out).toMatch(/already a sandbox. Nothing changed/);
    expect(run(dbPath, 'list').out).toMatch(/test .*sandbox yes/);
    expect(run(dbPath, 'list').out).toMatch(/arkona .*sandbox no/);
    expect(run(dbPath, 'sandbox', 'nope', 'on')).toMatchObject({ code: 1 });
    expect(run(dbPath, 'sandbox', 'test')).toMatchObject({ code: 2 });
    expect(run(dbPath, 'frobnicate')).toMatchObject({ code: 2 });
    expect(run(dbPath, 'sandbox', 'test', 'off').out).toMatch(/no longer a sandbox/);

    const check = openDatabase(dbPath);
    const audit = check
      .prepare("SELECT actor, action, target FROM audit_log WHERE action = 'project.set_sandbox' ORDER BY id")
      .all();
    expect(audit).toEqual([
      { actor: 'owner', action: 'project.set_sandbox', target: 'test' },
      { actor: 'owner', action: 'project.set_sandbox', target: 'test' },
    ]);
    check.close();
  });

  it('v2 A2: shows and sets a project setting (validated, audited); "-" clears it', () => {
    expect(run(dbPath, 'settings', 'test')).toEqual({
      code: 0,
      out: expect.stringMatching(
        /aiRepositoryRootId {2}not set[\s\S]*treePropertiesName {2}PROPERTIES \(default\)/,
      ) as string,
    });
    expect(run(dbPath, 'set', 'test', 'aiRepositoryRootId', 'h0gczxh7')).toEqual({
      code: 0,
      out: expect.stringMatching(
        /aiRepositoryRootId of "test" is now h0gczxh7\. The repository tree .* first build/,
      ) as string,
    });
    expect(run(dbPath, 'set', 'test', 'aiRepositoryRootId', 'h0gczxh7').out).toMatch(/already h0gczxh7/);
    expect(run(dbPath, 'set', 'test', 'treeSweepEnabled', 'off')).toMatchObject({ code: 0 });
    expect(run(dbPath, 'set', 'test', 'treeCanonicalNameRow', 'Canonical', 'Name')).toMatchObject({
      code: 0,
    });
    // Refused: an id that is not a LegendKeeper id, an unknown key, a setting not editable here.
    expect(run(dbPath, 'set', 'test', 'aiRepositoryRootId', 'Not An Id')).toMatchObject({
      code: 2,
      out: expect.stringMatching(/must be a LegendKeeper resource id/) as string,
    });
    expect(run(dbPath, 'set', 'test', 'rootId', 'x')).toMatchObject({
      code: 2,
      out: expect.stringMatching(/Unknown setting "rootId"/) as string,
    });
    expect(run(dbPath, 'set', 'test', 'templateIds', 'x').out).toMatch(/cannot be edited here/);
    expect(run(dbPath, 'set', 'nope', 'treeScopeRow', 'x')).toMatchObject({ code: 1 });

    const db = openDatabase(dbPath);
    const p = new ProjectStore(db).byName('test')!;
    expect(p.settings).toMatchObject({
      aiRepositoryRootId: 'h0gczxh7',
      treeSweepEnabled: false,
      treeCanonicalNameRow: 'Canonical Name',
    });
    // The arkona project is untouched.
    expect(new ProjectStore(db).byName('arkona')!.settings).toEqual({});
    const audit = db
      .prepare(
        `SELECT target, "before", "after" FROM audit_log WHERE action = 'project.set_setting' ORDER BY id`,
      )
      .all() as { target: string; before: string; after: string }[];
    expect(audit).toHaveLength(3);
    expect(audit[0]!.target).toBe('test');
    expect(JSON.parse(audit[0]!.after)).toEqual({
      key: 'aiRepositoryRootId',
      value: 'h0gczxh7',
      via: 'projects-cli',
    });
    db.close();

    expect(run(dbPath, 'set', 'test', 'treeSweepEnabled', '-')).toMatchObject({ code: 0 });
    const db2 = openDatabase(dbPath);
    expect(new ProjectStore(db2).byName('test')!.settings).not.toHaveProperty('treeSweepEnabled');
    db2.close();
  });
});
