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
});
