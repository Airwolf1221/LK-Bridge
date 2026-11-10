/**
 * v2 A1 configuration: the projects and their keys come from the env (LK_PROJECTS, LK_PROJECT_<NAME>_API_KEY,
 * LK_DEFAULT_PROJECT); the single-project form (LK_API_KEY, LK_PROJECT_ID, LK_PROJECT_NAME) still works as one project.
 * Errors and warnings name variables, never values.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, projectKeyVariable, projectsFrom } from '../../src/config/index.js';
import { ProjectSelector } from '../../src/projects/selection.js';
import type { ProjectView } from '../../src/projects/types.js';

const secrets = { SESSION_SECRET: 'x'.repeat(32), JWT_SIGNING_KEY: 'y'.repeat(32) };
const base = { BRIDGE_PUBLIC_URL: 'https://lk.example.test', ...secrets };
const KEY_A = 'key-a-not-real';
const KEY_B = 'key-b-not-real';
const multi = {
  ...base,
  SECRETS_MASTER_KEY: 'k'.repeat(44),
  LK_PROJECTS: 'arkona, Sandbox',
  LK_PROJECT_ARKONA_API_KEY: KEY_A,
  LK_PROJECT_SANDBOX_API_KEY: KEY_B,
  LK_DEFAULT_PROJECT: 'arkona',
};

function issues(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const msg = (e as Error).message;
    // Never a key in a message.
    expect(msg).not.toContain(KEY_A);
    expect(msg).not.toContain(KEY_B);
    return msg;
  }
  throw new Error('expected a ConfigError');
}

describe('LK_PROJECTS', () => {
  it('lists projects (trimmed, lowercased) with one key each, and a default', () => {
    const c = loadConfig(multi);
    expect(c.lk.projects).toEqual([
      { name: 'arkona', apiKey: KEY_A, expectedProjectId: null, keyVariable: 'LK_PROJECT_ARKONA_API_KEY' },
      { name: 'sandbox', apiKey: KEY_B, expectedProjectId: null, keyVariable: 'LK_PROJECT_SANDBOX_API_KEY' },
    ]);
    expect(c.lk.defaultProject).toBe('arkona');
    expect(c.lk.singleProjectForm).toBe(false);
    expect(c.lk.requireProjectForWrites).toBe(true);
    expect(c.warnings).toEqual([]);
    expect(c.secrets).toEqual({ masterKey: 'k'.repeat(44) });
  });

  it('a single listed project is the default without LK_DEFAULT_PROJECT', () => {
    const c = loadConfig({ ...base, LK_PROJECTS: 'arkona', LK_PROJECT_ARKONA_API_KEY: KEY_A });
    expect(c.lk.defaultProject).toBe('arkona');
  });

  it('REQUIRE_PROJECT_FOR_WRITES can be turned off', () => {
    expect(loadConfig({ ...multi, REQUIRE_PROJECT_FOR_WRITES: 'false' }).lk.requireProjectForWrites).toBe(
      false,
    );
  });

  it('names each key variable after the project', () => {
    expect(projectKeyVariable('arkona')).toBe('LK_PROJECT_ARKONA_API_KEY');
    expect(projectKeyVariable('test_2')).toBe('LK_PROJECT_TEST_2_API_KEY');
  });

  it('OPS2: a listed project without an env key is a warning (its key may be in the encrypted store), never a value', () => {
    const c = loadConfig({ ...multi, LK_PROJECT_SANDBOX_API_KEY: '' });
    expect(c.lk.projects.map((p) => p.name)).toEqual(['arkona']);
    expect(c.warnings.join('\n')).toMatch(
      /LK_PROJECT_SANDBOX_API_KEY is not set: project "sandbox" is served with the key in the encrypted store/,
    );
    expect(c.warnings.join('\n')).not.toContain(KEY_A);
    expect(projectsFrom({ ...multi, LK_PROJECT_SANDBOX_API_KEY: '' }).listedWithoutKey).toEqual(['sandbox']);
  });

  it('OPS2: with neither form, there are no env projects (they are managed on the dashboard); a default may be named', () => {
    const c = loadConfig({ ...base });
    expect(c.lk.projects).toEqual([]);
    expect(c.lk.defaultProject).toBe('');
    expect(c.lk.singleProjectForm).toBe(false);
    expect(loadConfig({ ...base, LK_DEFAULT_PROJECT: 'Arkona' }).lk.defaultProject).toBe('arkona');
    expect(issues({ ...base, LK_DEFAULT_PROJECT: 'no spaces' })).toMatch(/LK_DEFAULT_PROJECT: not a valid/);
  });

  it('OPS2: reads SECRETS_MASTER_KEY leniently (a warning, never an issue), and never shows it', () => {
    expect(loadConfig({ ...multi, SECRETS_MASTER_KEY: '' }).warnings.join('\n')).toMatch(
      /SECRETS_MASTER_KEY is not set/,
    );
    const short = loadConfig({ ...multi, SECRETS_MASTER_KEY: 'short-master-key' });
    expect(short.warnings.join('\n')).toMatch(/shorter than 32/);
    expect(short.warnings.join('\n')).not.toContain('short-master-key');
    const ok = loadConfig({
      ...multi,
      SECRETS_MASTER_KEY: 'm'.repeat(44),
      SECRETS_MASTER_KEY_PREVIOUS: 'p'.repeat(44),
    });
    expect(ok.secrets).toEqual({ masterKey: 'm'.repeat(44), previousMasterKey: 'p'.repeat(44) });
    expect(ok.warnings.join('\n')).not.toMatch(/SECRETS_MASTER_KEY/);
  });

  it('refuses a bad or repeated name, and a missing or unlisted default, naming variables only', () => {
    expect(issues({ ...multi, LK_PROJECTS: 'arkona,9lives' })).toMatch(
      /"9lives" is not a valid project name/,
    );
    expect(issues({ ...multi, LK_PROJECTS: 'arkona,has-dash' })).toMatch(/not a valid project name/);
    expect(issues({ ...multi, LK_PROJECTS: 'arkona,ARKONA' })).toMatch(/"arkona" is listed twice/);
    expect(issues({ ...multi, LK_PROJECTS: ' , ' })).toMatch(/list at least one project name/);
    const { LK_DEFAULT_PROJECT: _d, ...noDefault } = multi;
    expect(issues(noDefault)).toMatch(/LK_DEFAULT_PROJECT: required when LK_PROJECTS lists more than one/);
    expect(issues({ ...multi, LK_DEFAULT_PROJECT: 'other' })).toMatch(/"other" is not listed in LK_PROJECTS/);
    expect(issues({ ...multi, LK_PROJECTS: `a${'b'.repeat(32)}` })).toMatch(/not a valid project name/);
  });

  it('warns (by name) when the single-project variables are also set, and ignores them', () => {
    const c = loadConfig({ ...multi, LK_API_KEY: 'old-key-not-real', LK_PROJECT_ID: 'proj_old' });
    expect(c.lk.projects.map((p) => p.name)).toEqual(['arkona', 'sandbox']);
    expect(c.warnings.join('\n')).toMatch(
      /LK_API_KEY and LK_PROJECT_ID are ignored because LK_PROJECTS is set/,
    );
    expect(c.warnings.join('\n')).not.toContain('old-key-not-real');
  });
});

describe('the single-project form (v1, backwards compatible)', () => {
  const single = { ...base, LK_API_KEY: KEY_A, LK_PROJECT_ID: 'proj_live' };

  it('becomes one project named "test" (or LK_PROJECT_NAME), checked against LK_PROJECT_ID, with a warning', () => {
    const c = loadConfig(single);
    expect(c.lk.projects).toEqual([
      { name: 'test', apiKey: KEY_A, expectedProjectId: 'proj_live', keyVariable: 'LK_API_KEY' },
    ]);
    expect(c.lk.defaultProject).toBe('test');
    expect(c.lk.singleProjectForm).toBe(true);
    expect(c.warnings.join('\n')).toMatch(/single-project form/);
    expect(c.warnings.join('\n')).toMatch(
      /LK_PROJECTS=test, LK_PROJECT_TEST_API_KEY and LK_DEFAULT_PROJECT=test/,
    );
    expect(c.warnings.join('\n')).not.toContain(KEY_A);
    expect(loadConfig({ ...single, LK_PROJECT_NAME: 'Arkona' }).lk.projects[0]!.name).toBe('arkona');
  });

  it('refuses without a key or a project id, with a bad name, or with a different default', () => {
    expect(issues({ ...base, LK_PROJECT_ID: 'proj_live' })).toMatch(
      /LK_API_KEY: required \(or set LK_PROJECTS/,
    );
    expect(issues({ ...base, LK_API_KEY: KEY_A })).toMatch(/LK_PROJECT_ID: required/);
    expect(issues({ ...single, LK_PROJECT_NAME: 'no spaces' })).toMatch(
      /LK_PROJECT_NAME: not a valid project name/,
    );
    expect(issues({ ...single, LK_DEFAULT_PROJECT: 'other' })).toMatch(/must be "test"/);
  });

  it('projectsFrom reports issues instead of throwing', () => {
    const r = projectsFrom({ LK_PROJECTS: 'a,b', LK_PROJECT_A_API_KEY: KEY_A });
    // OPS2: b's missing key is a warning; the missing default (two listed) is the one issue.
    expect(r.issues.length).toBe(1);
    expect(r.warnings.join('\n')).toMatch(/LK_PROJECT_B_API_KEY is not set/);
    expect(r.projects.map((p) => p.name)).toEqual(['a']);
  });
});

describe('the project selector', () => {
  const view = (name: string, id: string | null, isDefault = false): ProjectView =>
    ({
      name,
      id,
      isDefault,
      status: id ? 'active' : 'verifying',
      reason: id ? null : 'not checked yet',
    }) as ProjectView;
  const projects = (views: ProjectView[]) => ({
    configuredNames: () => views.map((v) => v.name),
    resolve: (ref: string) =>
      views.find((v) => v.name === ref.toLowerCase()) ?? views.find((v) => v.id !== null && v.id === ref),
    byConfiguredName: (n: string) => views.find((v) => v.name === n.toLowerCase()),
    defaultProject: () => views.find((v) => v.isDefault)!,
  });
  const two = projects([view('arkona', 'lkp_a', true), view('sandbox', 'lkp_s')]);

  it('resolves names (any case) and ids; refuses unknown names with the registered ones', () => {
    const s = new ProjectSelector(two, true);
    expect(s.select('Sandbox', 'read')).toMatchObject({
      ok: true,
      project: { id: 'lkp_s', name: 'sandbox' },
    });
    expect(s.select('lkp_s', 'write')).toMatchObject({ ok: true, project: { name: 'sandbox' } });
    expect(s.select('nope', 'read')).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_PROJECT', registered: ['arkona', 'sandbox'] },
    });
  });

  it('reads default; writes need a project when several are served, unless turned off', () => {
    expect(new ProjectSelector(two, true).select(undefined, 'read')).toMatchObject({
      project: { name: 'arkona' },
    });
    expect(new ProjectSelector(two, true).select(undefined, 'write')).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_REQUIRED' },
    });
    expect(new ProjectSelector(two, false).select(undefined, 'write')).toMatchObject({
      project: { name: 'arkona' },
    });
    const one = projects([view('arkona', 'lkp_a', true)]);
    expect(new ProjectSelector(one, true).select(undefined, 'write')).toMatchObject({
      project: { name: 'arkona' },
    });
  });

  it('a project whose key was never verified (no id yet) is refused as unavailable, with the reason', () => {
    const pending = projects([view('arkona', 'lkp_a', true), view('sandbox', null)]);
    expect(new ProjectSelector(pending, true).select('sandbox', 'read')).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_UNAVAILABLE', project: 'sandbox' },
    });
  });
});
