/**
 * The env-sync planner (deploy/env-sync.mjs, OPS1): pure functions, no files. The shell wrapper is tested end to end in
 * env-sync-shell.test.ts; the template's markers in deploy-env-template.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actionNeeded, parseTemplate, planSync, summarise, unquote } from '../../deploy/env-sync.mjs';

const shipped = readFileSync(new URL('../../deploy/env.template', import.meta.url), 'utf8');
const fixedRandom = (n: number) => Buffer.alloc(n, 7);
const KEY = 'TESTKEY-lk-api-key-0123456789abcdefXYZ';
const KEY2 = 'TESTKEY2-second-project-key-9876543210';

function plan(template: string, live: string, extra: Partial<Parameters<typeof planSync>[0]> = {}) {
  const p = planSync({
    template,
    live,
    release: 'v9.9.9',
    date: '2026-11-09',
    random: fixedRandom,
    ...extra,
  });
  if ('error' in p) throw new Error(p.error);
  return p;
}

describe('parseTemplate', () => {
  it('reads the shipped template with no errors, one marker per variable', () => {
    const t = parseTemplate(shipped);
    expect(t.errors).toEqual([]);
    expect(t.vars.length).toBeGreaterThan(50);
    const kinds = Object.fromEntries(t.vars.map((v) => [v.name, v.marker.kind]));
    expect(kinds.SESSION_SECRET).toBe('generate');
    expect(kinds.OWNER_PASSWORD_HASH).toBe('secret');
    expect(kinds.SECRETS_MASTER_KEY).toBe('generate');
    expect(kinds.LK_PROJECTS).toBe('optional');
    expect(kinds.BRIDGE_PUBLIC_URL).toBe('default');
    expect(kinds.MAINTENANCE_ENABLED).toBe('optional');
  });

  it.each([
    ['a variable without a marker', 'A=1\n', /A has no marker/],
    ['an unknown marker', '# @maybe\nA=1\n', /unknown marker "@maybe"/],
    [
      'a marker not directly above its variable',
      '# @default\n\nA=1\n',
      /must be followed directly by its variable/,
    ],
    ['two markers', '# @default\n# @optional\n# A=1\n', /must be followed directly/],
    ['a secret with a value', '# @secret\nA=abc\n', /@secret A must not carry a value/],
    [
      'a commented secret with a value',
      '# @secret\n# A=abc   # explained\n',
      /@secret A must not carry a value/,
    ],
    ['a commented @default', '# @default\n# A=1\n', /@default A must be an uncommented/],
    ['an active @optional', '# @optional\nA=1\n', /@optional A must be commented out/],
    ['a @generate with a value', '# @generate:base64:48\nA=x\n', /@generate A must be a blank/],
    ['a too-small @generate', '# @generate:base64:8\nA=\n', /unknown marker/],
    ['NODE_OPTIONS', '# @default\nNODE_OPTIONS=--require=x\n', /NODE_OPTIONS may not be set/],
    ['LD_PRELOAD', '# @optional\n# LD_PRELOAD=/x.so\n', /LD_PRELOAD may not be set/],
    ['HTTPS_PROXY', '# @default\nHTTPS_PROXY=http://x\n', /HTTPS_PROXY may not be set/],
    ['a duplicate', '# @default\nA=1\n# @default\nA=2\n', /A appears twice/],
    ['a stray line', 'just text\n', /not a comment, a marker or a NAME=value line/],
  ])('refuses %s', (_label, text, message) => {
    expect(parseTemplate(text).errors.join('\n')).toMatch(message);
    const p = planSync({ template: text, live: '' });
    expect('error' in p && p.error).toMatch(/the template is not valid/);
  });

  it('accepts NODE_ENV and TRUST_PROXY (not everything that looks like a dangerous name is one)', () => {
    expect(
      parseTemplate('# @default\nNODE_ENV=production\n# @default\nTRUST_PROXY=loopback\n').errors,
    ).toEqual([]);
  });
});

describe('planSync', () => {
  it('leaves a file that is in step byte for byte alone', () => {
    const live = 'A=1\n# B=2\n';
    const p = plan('# @default\nA=1\n# @optional\n# B=2\n', live);
    expect(p.changes).toBe(0);
    expect(p.text).toBe(live);
    expect(summarise(p)).toEqual(['  in step: nothing to change.']);
  });

  it('never changes a value, a commented-out choice, or a line it does not own', () => {
    const live = "A=custom\n# B=\nweird line kept\nC='quoted value'\n";
    const p = plan('# @default\nA=1\n# @default\nB=2\n# @optional\n# C=3\n', live);
    expect(p.changes).toBe(0);
    expect(p.text).toBe(live);
  });

  it('generates base64, base64url and hex values of the size asked', () => {
    const p = plan('# @generate:base64:48\nA=\n# @generate:base64url:32\nB=\n# @generate:hex:16\nC=\n', '');
    expect(p.generate).toEqual(['A', 'B', 'C']);
    expect(p.text).toContain(`A=${Buffer.alloc(48, 7).toString('base64')}\n`);
    expect(p.text).toContain(`B=${Buffer.alloc(32, 7).toString('base64url')}\n`);
    expect(p.text).toContain(`C=${'07'.repeat(16)}\n`);
  });

  it('uses crypto.randomBytes when no source is given, and refuses a short one', () => {
    const p = planSync({ template: '# @generate:hex:32\nA=\n', live: '' });
    expect('error' in p).toBe(false);
    if (!('error' in p)) expect(p.text).toMatch(/^A=[0-9a-f]{64}$/m);
    expect(() =>
      planSync({ template: '# @generate:hex:32\nA=\n', live: '', random: () => Buffer.alloc(3) }),
    ).toThrow(/random source failed/);
  });

  it('reports required and optional secrets differently', () => {
    const t = '# @secret\nREQ=\n# @secret\n# OPT=\n';
    const fresh = plan(t, '');
    expect(fresh.placeholders).toEqual(['REQ', 'OPT']);
    expect(fresh.needs.map((n) => [n.name, n.required])).toEqual([
      ['REQ', true],
      ['OPT', false],
    ]);
    // Once the placeholders are there, only the required one still needs the owner.
    const later = plan(t, fresh.text);
    expect(later.changes).toBe(0);
    expect(later.needs.map((n) => n.name)).toEqual(['REQ']);
    expect(plan(t, `${fresh.text}REQ=set\n`).needs).toEqual([]);
    expect(actionNeeded(fresh.needs, '/etc/x.env')[0]).toMatch(
      /^ACTION NEEDED: fill in REQ in \/etc\/x\.env \(required.*placeholder line is at the end/,
    );
  });

  it('keeps a file without a trailing newline intact and appends cleanly', () => {
    const p = plan('# @default\nA=1\n# @default\nB=2\n', 'A=1');
    expect(p.text).toMatch(/^A=1\n\n# -+ Added by env-sync \(v9\.9\.9, 2026-11-09\)\n.*\nB=2\n$/);
  });

  it('comments out every active line of a removed variable, and leaves project key lines to the project rules', () => {
    const p = plan(
      '# @default\nA=1\n',
      'A=1\nGONE=x\nGONE=y\nLK_PROJECT_OLD_API_KEY=k\n# ALREADY=commented\n',
    );
    expect(p.commentOut).toEqual(['GONE']);
    expect(p.text).not.toMatch(/^GONE=/m);
    expect(p.text.match(/^# GONE=/gm)).toHaveLength(2);
    expect(p.text).toMatch(/^LK_PROJECT_OLD_API_KEY=k$/m);
  });
});

describe('planSync: the project variables (v2 A1)', () => {
  it('in the multi-project form, wants a key per listed project and a default when there are several', () => {
    const live = `LK_PROJECTS=test,arkona\nLK_PROJECT_TEST_API_KEY=${KEY}\n`;
    const p = plan(shipped, live);
    expect(p.placeholders).toContain('LK_PROJECT_ARKONA_API_KEY');
    expect(p.needs.map((n) => n.name)).toEqual(
      expect.arrayContaining(['LK_PROJECT_ARKONA_API_KEY', 'LK_DEFAULT_PROJECT']),
    );
    expect(p.add).not.toContain('LK_DEFAULT_PROJECT'); // the owner chooses
    expect(p.add).not.toContain('LK_PROJECTS');
    expect(p.text).toMatch(/^# LK_PROJECT_ARKONA_API_KEY=$/m);
    expect(p.text).not.toMatch(/LK_API_KEY|LK_PROJECT_ID=|LK_PROJECT_NAME/); // the old form's names are never added
  });

  it('adds LK_DEFAULT_PROJECT for a single listed project, and never asks for the test key when test is not listed', () => {
    const p = plan(shipped, `LK_PROJECTS=arkona\nLK_PROJECT_ARKONA_API_KEY=${KEY2}\n`);
    expect(p.add).toContain('LK_DEFAULT_PROJECT');
    expect(p.text).toMatch(/^LK_DEFAULT_PROJECT=arkona$/m);
    expect(p.needs.map((n) => n.name)).not.toContain('LK_PROJECT_TEST_API_KEY');
    expect(p.placeholders).not.toContain('LK_PROJECT_TEST_API_KEY');
  });

  it('notes, but never touches, single-project leftovers and keys of unlisted projects', () => {
    const p = plan(
      shipped,
      `LK_PROJECTS=test\nLK_PROJECT_TEST_API_KEY=${KEY}\nLK_API_KEY=${KEY2}\nLK_PROJECT_OLD_API_KEY=${KEY2}\n`,
    );
    expect(p.notes.join('\n')).toMatch(/LK_API_KEY is set but ignored/);
    expect(p.notes.join('\n')).toMatch(
      /LK_PROJECT_OLD_API_KEY is set but LK_PROJECTS does not list its project/,
    );
    expect(p.commentOut).not.toContain('LK_API_KEY');
    expect(p.text).toContain(`LK_API_KEY=${KEY2}`);
  });

  it('flags a default project that is not listed, and an invalid project name', () => {
    expect(
      plan(shipped, `LK_PROJECTS=test\nLK_DEFAULT_PROJECT=arkona\nLK_PROJECT_TEST_API_KEY=${KEY}\n`).needs,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'LK_DEFAULT_PROJECT' })]));
    expect(plan(shipped, 'LK_PROJECTS=9bad\n').needs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'LK_PROJECTS' })]),
    );
  });

  it('gives a new file (neither form) the template project lines like any other: commented out (OPS2)', () => {
    const p = plan(shipped, '');
    expect(p.addOptional).toEqual(expect.arrayContaining(['LK_PROJECTS', 'LK_DEFAULT_PROJECT']));
    expect(p.text).toMatch(/^# LK_PROJECTS=$/m);
    // No project key placeholder, so no ACTION NEEDED for a project a new install may never have.
    expect(p.placeholders.filter((n) => /^LK_PROJECT_/.test(n))).toEqual([]);
    expect(p.generate).toContain('SECRETS_MASTER_KEY');
    expect(Buffer.from(/^SECRETS_MASTER_KEY=(.*)$/m.exec(p.text)?.[1] ?? '', 'base64')).toHaveLength(32);
  });

  it('OPS2: a listed project whose key line is commented out (retired) or blank needs nothing; one never mentioned does', () => {
    const live = `LK_PROJECTS=test,arkona\nLK_DEFAULT_PROJECT=test\n# LK_PROJECT_TEST_API_KEY='${KEY}'\nLK_PROJECT_ARKONA_API_KEY=\n`;
    const p = plan(shipped, live);
    expect(p.needs.map((n) => n.name).filter((n) => n.startsWith('LK_'))).toEqual([]);
    expect(p.notes.join('\n')).toMatch(
      /LK_PROJECT_TEST_API_KEY is not set: project test is served with its key from/,
    );
    const q = plan(shipped, 'LK_PROJECTS=test\nLK_DEFAULT_PROJECT=test\n');
    expect(q.placeholders).toContain('LK_PROJECT_TEST_API_KEY');
    expect(q.needs.map((n) => n.name).filter((n) => n.startsWith('LK_'))).toEqual([
      'LK_PROJECT_TEST_API_KEY',
    ]);
  });

  it('OPS2: a file whose LK_PROJECTS is commented out leaves the projects to the dashboard (nothing added)', () => {
    const live = `# LK_PROJECTS=test\n# LK_PROJECT_TEST_API_KEY=x\nLK_DEFAULT_PROJECT=test\n`;
    const p = plan(shipped, live);
    expect(
      [...p.add, ...p.addOptional, ...p.placeholders].filter((n) => /^LK_(PROJECT|DEFAULT)/.test(n)),
    ).toEqual([]);
    expect(p.needs.filter((n) => /^LK_/.test(n.name))).toEqual([]);
  });

  it('migrates without reading the key out: the moved line keeps its exact text', () => {
    const live = `X=1\n  LK_API_KEY= "${KEY}"  \nLK_PROJECT_ID=p1\n`;
    const p = plan(shipped, live, { migrateProjects: true });
    expect(p.text).toContain(`LK_PROJECT_TEST_API_KEY= "${KEY}"  \n`);
    expect(p.text.indexOf('LK_PROJECTS=test')).toBeLessThan(p.text.indexOf('LK_PROJECT_TEST_API_KEY='));
  });
});

describe('planSync: retiring imported keys (OPS2)', () => {
  const live = [
    'LK_PROJECTS=test,arkona',
    'LK_DEFAULT_PROJECT=test',
    `LK_PROJECT_TEST_API_KEY='${KEY}'`,
    `LK_PROJECT_ARKONA_API_KEY=${KEY2}`,
    "OWNER_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'",
    '',
  ].join('\n');

  it('comments out exactly the names it is given, keeping each value text, with a note; never reads a value', () => {
    const p = plan(shipped, live, { retireEqual: ['LK_PROJECT_TEST_API_KEY', 'OWNER_PASSWORD_HASH'] });
    expect(p.retire).toEqual(['LK_PROJECT_TEST_API_KEY', 'OWNER_PASSWORD_HASH']);
    expect(p.text).toMatch(
      /^# retired by env-sync \(v9\.9\.9, 2026-11-09\): the bridge keeps LK_PROJECT_TEST_API_KEY in its encrypted store/m,
    );
    expect(p.text).toContain(`# LK_PROJECT_TEST_API_KEY='${KEY}'`);
    expect(p.text).toMatch(/^LK_PROJECT_ARKONA_API_KEY=/m); // not given: untouched
    expect(p.text).toMatch(/^LK_PROJECTS=test,arkona$/m); // arkona still keeps its key here
    expect(p.needs.filter((n) => n.name.startsWith('LK_'))).toEqual([]);
    const summary = summarise(p).join('\n');
    expect(summary).toMatch(
      /will retire \(in the encrypted store now; values are never shown\): LK_PROJECT_TEST_API_KEY, OWNER_PASSWORD_HASH/,
    );
    expect(summary).not.toContain(KEY);
  });

  it('retires LK_PROJECTS too once no listed project keeps a key in the file; superseded values get their own note', () => {
    const p = plan(shipped, live, {
      retireEqual: ['LK_PROJECT_TEST_API_KEY'],
      retireSuperseded: ['LK_PROJECT_ARKONA_API_KEY'],
    });
    expect(p.text).toMatch(/^# LK_PROJECTS=test,arkona$/m);
    expect(p.text).toMatch(
      /LK_PROJECT_ARKONA_API_KEY is no longer in use|LK_PROJECT_ARKONA_API_KEY was replaced on the dashboard/,
    );
    expect(p.retire).toContain('LK_PROJECTS (no listed project keeps a key in this file)');
    expect(p.text).toMatch(/^LK_DEFAULT_PROJECT=test$/m);
    // Running again with the same names: nothing left to do.
    const again = plan(shipped, p.text, {
      retireEqual: ['LK_PROJECT_TEST_API_KEY'],
      retireSuperseded: ['LK_PROJECT_ARKONA_API_KEY'],
    });
    expect(again.retire).toEqual([]);
    expect(again.notes.join('\n')).toMatch(
      /LK_PROJECT_TEST_API_KEY is not set in the file: nothing to retire/,
    );
  });

  it('refuses any other name, and the single-project form', () => {
    expect(planSync({ template: shipped, live, retireEqual: ['SESSION_SECRET'] })).toEqual({
      error: expect.stringMatching(/refusing to retire: SESSION_SECRET cannot be retired/),
    });
    expect(
      planSync({
        template: shipped,
        live: `LK_API_KEY=${KEY}\nLK_PROJECT_ID=p\n`,
        retireEqual: ['OWNER_PASSWORD_HASH'],
      }),
    ).toEqual({ error: expect.stringMatching(/single-project form/) });
  });
});

describe('planSync: rotating the master key (OPS2)', () => {
  const OLD = 'TESTMASTER-0123456789-0123456789-0123456789';
  it('moves the current key to SECRETS_MASTER_KEY_PREVIOUS (value text moved) and generates a new one', () => {
    const p = plan(shipped, `PORT=1\nSECRETS_MASTER_KEY=${OLD}\n`, { rotateMasterKey: true });
    expect(p.text).toContain(`SECRETS_MASTER_KEY_PREVIOUS=${OLD}\n`);
    const fresh = /^SECRETS_MASTER_KEY=(.*)$/m.exec(p.text)?.[1] ?? '';
    expect(fresh).toBe(Buffer.alloc(32, 7).toString('base64'));
    expect(p.rotate).toEqual([
      'SECRETS_MASTER_KEY -> SECRETS_MASTER_KEY_PREVIOUS (the value is moved, never shown)',
      'generate a new SECRETS_MASTER_KEY (random; never shown)',
    ]);
    expect(summarise(p).join('\n')).not.toContain(OLD);
    // A second rotation keeps the older previous key, commented out, rather than losing it.
    const twice = plan(shipped, p.text, { rotateMasterKey: true, random: (n) => Buffer.alloc(n, 9) });
    expect(twice.text).toContain(`# SECRETS_MASTER_KEY_PREVIOUS=${OLD}`);
    expect(twice.text).toContain(`SECRETS_MASTER_KEY_PREVIOUS=${fresh}\n`);
  });

  it('refuses without a master key, or with two', () => {
    expect(planSync({ template: shipped, live: 'PORT=1\n', rotateMasterKey: true })).toEqual({
      error: expect.stringMatching(/nothing to rotate/),
    });
    expect(
      planSync({
        template: shipped,
        live: `SECRETS_MASTER_KEY=${OLD}\nSECRETS_MASTER_KEY=${OLD}\n`,
        rotateMasterKey: true,
      }),
    ).toEqual({ error: expect.stringMatching(/set more than once/) });
  });
});

describe('the summary', () => {
  it('names variables, never values: not old, moved, removed or generated ones', () => {
    const live = `LK_API_KEY='${KEY}'\nLK_PROJECT_ID=proj_secretish_id\nLK_SANDBOX_API_KEY=${KEY2}\nREMOVED_THING=${KEY2}-x\n`;
    const p = plan(shipped, live, { migrateProjects: true, random: (n) => Buffer.alloc(n, 0xab) });
    const text = [...summarise(p), ...actionNeeded(p.needs, '/etc/lk-bridge/lk-bridge.env'), ...p.notes].join(
      '\n',
    );
    for (const v of [KEY, KEY2, 'proj_secretish_id', Buffer.alloc(48, 0xab).toString('base64')]) {
      expect(text).not.toContain(v);
    }
    expect(text).toMatch(/LK_API_KEY -> LK_PROJECT_TEST_API_KEY/);
    expect(text).toMatch(/REMOVED_THING/);
  });

  it('unquote matches systemd and lib.sh env_file_get', () => {
    expect(unquote(`  'a b'  `)).toBe('a b');
    expect(unquote('"x"')).toBe('x');
    expect(unquote(`'x"`)).toBe(`'x"`);
    expect(unquote('')).toBe('');
  });
});
