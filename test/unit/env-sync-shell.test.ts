/**
 * deploy/env-sync.sh end to end, on a fake server (OPS1, ADR 0024): markers, removed variables, idempotency, the
 * multi-project migration and its refusals, backup and restore around the boot check, owner/group/mode, --check exit
 * codes, and, in every test (through `run`), that no secret value ever reaches stdout or stderr.
 */
import {
  chmodSync,
  chownSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeRoot,
  generatedValues,
  inStepEnv,
  makeFakeRoot,
  ownership,
  run,
  SECRETS,
} from './deploy-fake-root.js';

/** A small template with one variable of each kind (and a required and an optional secret). */
const TEMPLATE = [
  '# A small template for the tests.',
  '',
  '# ---------------------------------------------------------------- Server',
  '# Where the bridge listens.',
  '# @default',
  'PORT=8787',
  '# @default',
  'WRITERS_MAX=1',
  '# Two different random values.',
  '# @generate:base64:48',
  'SESSION_SECRET=',
  '# @generate:hex:32',
  'JWT_SIGNING_KEY=',
  '# The owner hash, from setup:owner.',
  '# @secret',
  'OWNER_PASSWORD_HASH=',
  '# @secret',
  '# OWNER_TOTP_SECRET=                   # optional',
  '# Tuning.',
  '# @optional',
  '# JOURNAL_RETENTION_DAYS=30',
  '',
].join('\n');

let root: FakeRoot | undefined;
afterEach(() => {
  root?.cleanup();
  root = undefined;
});

function fake(template = TEMPLATE): FakeRoot {
  root = makeFakeRoot({ template });
  return root;
}

describe('env-sync.sh: the markers', () => {
  it('adds @default and @generate, placeholders for @secret, comments for @optional; never invents a secret', () => {
    const r = fake();
    r.writeEnv(`PORT=9999\nOWNER_PASSWORD_HASH='${SECRETS.hash}'\n`);
    const check = run(r, 'env-sync.sh', ['--check']);
    expect(check.status).toBe(1);
    expect(check.out).toMatch(/will add: WRITERS_MAX/);
    expect(check.out).toMatch(
      /will generate \(random; the value is never shown\): SESSION_SECRET, JWT_SIGNING_KEY/,
    );
    expect(check.out).toMatch(/will add, commented out \(optional\): JOURNAL_RETENTION_DAYS/);
    expect(check.out).toMatch(/will add a commented-out placeholder: OWNER_TOTP_SECRET/);
    expect(check.out).toMatch(/ACTION NEEDED: fill in OWNER_TOTP_SECRET/);
    expect(check.out).not.toMatch(/^status:/m);
    expect(r.backups()).toEqual([]); // --check changes nothing

    const apply = run(r, 'env-sync.sh', ['--yes']);
    expect(apply.status).toBe(1); // written, but a new secret placeholder still needs the owner
    const text = r.readEnv();
    expect(text).toMatch(/^PORT=9999$/m); // an existing value is never changed
    expect(text).toMatch(/^WRITERS_MAX=1$/m);
    expect(text).toMatch(/^# OWNER_TOTP_SECRET= {19}# optional$/m);
    expect(text).not.toMatch(/^OWNER_TOTP_SECRET=/m);
    expect(text).toMatch(/^# JOURNAL_RETENTION_DAYS=30$/m);
    expect(text).toContain(`OWNER_PASSWORD_HASH='${SECRETS.hash}'`);
    // The template's comment comes with each added line; the markers stay in the template.
    expect(text).toMatch(/# Two different random values\.\nSESSION_SECRET=/);
    expect(text).not.toMatch(/@default|@generate|@secret|@optional/);
    // Generated: base64 of 48 bytes and hex of 32 bytes, different, from a secure source (and never printed: run()).
    const session = /^SESSION_SECRET=(.+)$/m.exec(text)?.[1] ?? '';
    const jwt = /^JWT_SIGNING_KEY=(.+)$/m.exec(text)?.[1] ?? '';
    expect(Buffer.from(session, 'base64')).toHaveLength(48);
    expect(jwt).toMatch(/^[0-9a-f]{64}$/);
    expect(generatedValues(text)).toHaveLength(2);
  });

  it('fills in a blank @generate line in place, and says ACTION NEEDED for a blank required @secret', () => {
    const r = fake();
    r.writeEnv(
      'PORT=1\nWRITERS_MAX=1\nSESSION_SECRET=\nJWT_SIGNING_KEY=\nOWNER_PASSWORD_HASH=\n# OWNER_TOTP_SECRET=\n# JOURNAL_RETENTION_DAYS=30\n',
    );
    const res = run(r, 'env-sync.sh', ['--yes']);
    expect(res.out).toMatch(/needs you: OWNER_PASSWORD_HASH/);
    expect(res.out).toMatch(/ACTION NEEDED: fill in OWNER_PASSWORD_HASH .*required/);
    const lines = r.readEnv().split('\n');
    expect(lines[2]).toMatch(/^SESSION_SECRET=.{64}$/);
    expect(lines[3]).toMatch(/^JWT_SIGNING_KEY=[0-9a-f]{64}$/);
    expect(lines[4]).toBe('OWNER_PASSWORD_HASH='); // never invented
    expect(r.readEnv()).not.toMatch(/Added by env-sync/); // nothing appended
  });

  it('two runs generate different values', () => {
    const a = fake();
    a.writeEnv('');
    run(a, 'env-sync.sh', ['--yes']);
    const first = generatedValues(a.readEnv());
    a.writeEnv('');
    run(a, 'env-sync.sh', ['--yes']);
    const second = generatedValues(a.readEnv());
    expect(first).toHaveLength(2);
    expect(new Set([...first, ...second]).size).toBe(4);
  });
});

describe('env-sync.sh: removed variables, idempotency, confirmation', () => {
  it('comments out a variable the template no longer lists, with a dated note, never deleting it', () => {
    const r = fake();
    r.writeEnv(inStepEnv(r, TEMPLATE) + `OLD_SETTING=${SECRETS.old}\n`);
    const res = run(r, 'env-sync.sh', ['--yes', '--release', 'v9.9.9']);
    expect(res.out).toMatch(/will comment out \(no longer in the template\): OLD_SETTING/);
    const text = r.readEnv();
    expect(text).toMatch(
      /^# removed in v9\.9\.9 \(\d{4}-\d{2}-\d{2}\): OLD_SETTING is no longer in deploy\/env\.template.*\n# OLD_SETTING=TESTOLD/m,
    );
    expect(text).not.toMatch(/^OLD_SETTING=/m);
  });

  it('is idempotent: a second run changes nothing and makes no backup', () => {
    const r = fake();
    r.writeEnv(`PORT=1\nOLD=1\nOWNER_PASSWORD_HASH='${SECRETS.hash}'\n`);
    expect(run(r, 'env-sync.sh', ['--yes']).status).toBe(1); // the optional TOTP placeholder is new: ACTION NEEDED once
    const once = r.readEnv();
    const backups = r.backups();
    const again = run(r, 'env-sync.sh', ['--yes']);
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/in step: nothing to change/);
    expect(r.readEnv()).toBe(once);
    expect(r.backups()).toEqual(backups);
    expect(run(r, 'env-sync.sh', ['--check']).status).toBe(0);
  });

  it('asks before writing; anything but yes changes nothing', () => {
    const r = fake();
    r.writeEnv(inStepEnv(r, TEMPLATE).replace(/^WRITERS_MAX=1\n/m, ''));
    const before = r.readEnv();
    const no = run(r, 'env-sync.sh', [], 'n\n');
    expect(no.status).toBe(1);
    expect(no.out).toMatch(
      /Apply these changes to .*\? A backup is made first\. \[y\/N\] Nothing was changed\./,
    );
    expect(r.readEnv()).toBe(before);
    expect(run(r, 'env-sync.sh', [], '').status).toBe(1); // no answer at all: no
    expect(r.readEnv()).toBe(before);
    const yes = run(r, 'env-sync.sh', [], 'y\n');
    expect(yes.status).toBe(0);
    expect(r.readEnv()).toMatch(/^WRITERS_MAX=1$/m);
  });
});

describe('env-sync.sh --check exit codes', () => {
  it('0 in step, 1 changes needed, 2 error (a bad template, an unreadable file, a bad option)', () => {
    const r = fake();
    r.writeEnv(inStepEnv(r, TEMPLATE) + '# OWNER_TOTP_SECRET=\n# JOURNAL_RETENTION_DAYS=30\n');
    expect(run(r, 'env-sync.sh', ['--check']).status).toBe(0);
    r.writeEnv(r.readEnv().replace(/^PORT=.*\n/m, ''));
    expect(run(r, 'env-sync.sh', ['--check']).status).toBe(1);
    // A template variable without a marker: error, nothing changed.
    writeFileSync(join(r.app, 'deploy', 'env.template'), `${TEMPLATE}NO_MARKER=1\n`);
    const bad = run(r, 'env-sync.sh', ['--check']);
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/the template is not valid: line \d+: NO_MARKER has no marker/);
    // A template may never set what changes how Node runs.
    writeFileSync(
      join(r.app, 'deploy', 'env.template'),
      `${TEMPLATE}# @default\nNODE_OPTIONS=--require=/tmp/x.js\n`,
    );
    expect(run(r, 'env-sync.sh', ['--check']).err).toMatch(/NODE_OPTIONS may not be set from the template/);
    expect(run(r, 'env-sync.sh', ['--check', '--template', join(r.dir, 'missing')]).status).toBe(2);
    expect(run(r, 'env-sync.sh', ['--bogus']).status).toBe(2);
  });

  it('refuses an env file that is a symbolic link, and a directory others can write', () => {
    const r = fake();
    r.writeEnv(inStepEnv(r, TEMPLATE));
    writeFileSync(join(r.dir, 'elsewhere.env'), r.readEnv());
    unlinkSync(r.envFile);
    symlinkSync(join(r.dir, 'elsewhere.env'), r.envFile);
    const link = run(r, 'env-sync.sh', ['--check']);
    expect(link.status).toBe(2);
    expect(link.err).toMatch(/is not a regular file/);
    unlinkSync(r.envFile);
    r.writeEnv(readFileSync(join(r.dir, 'elsewhere.env'), 'utf8'));
    chmodSync(join(r.dir, 'etc'), 0o770);
    expect(run(r, 'env-sync.sh', ['--check']).err).toMatch(/writable by its group or by others/);
  });

  it('refuses to run from inside the checkout', () => {
    const r = fake();
    r.writeEnv('');
    r.env.LKB_APP_DIR = r.dir; // the installed bin/ now sits inside the "checkout"
    const res = run(r, 'env-sync.sh', ['--check']);
    expect(res.status).toBe(2);
    expect(res.err).toMatch(/This is the copy inside the checkout/);
  });
});

describe('env-sync.sh: backup, atomic write, boot check', () => {
  it('keeps owner, group and mode, and so does the timestamped backup', () => {
    const r = fake();
    r.writeEnv(inStepEnv(r, TEMPLATE).replace(/^WRITERS_MAX=1\n/m, ''));
    chmodSync(r.envFile, 0o640);
    if (process.getuid?.() === 0) chownSync(r.envFile, 0, 65534); // root:<another group>, as root:lkbridge on the server
    const before = ownership(r.envFile);
    const original = r.readEnv();
    expect(run(r, 'env-sync.sh', ['--yes']).status).toBe(0);
    expect(ownership(r.envFile)).toEqual(before);
    const [backup, ...rest] = r.backups();
    expect(rest).toEqual([]);
    expect(backup).toMatch(/lk-bridge\.env\.bak\.\d{8}T\d{6}Z$/);
    expect(ownership(backup!)).toEqual(before);
    expect(readFileSync(backup!, 'utf8')).toBe(original);
    // No temporary file is left beside it: just the file and its backup.
    expect(readdirSync(join(r.dir, 'etc')).sort()).toEqual(['lk-bridge.env', backup!.split('/').pop()]);
  });

  it('restores the backup when the edit makes the boot check fail', () => {
    const r = fake(`${TEMPLATE}# @default\nBREAK_ME=invalid\n`);
    r.writeEnv(inStepEnv(r, TEMPLATE) + '# OWNER_TOTP_SECRET=\n# JOURNAL_RETENTION_DAYS=30\n');
    chmodSync(r.envFile, 0o640);
    const before = r.readEnv();
    const owner = ownership(r.envFile);
    const res = run(r, 'env-sync.sh', ['--yes']);
    expect(res.status).toBe(2);
    expect(res.err).toMatch(/issue: BREAK_ME: invalid/);
    expect(res.err).toMatch(/New since the edit:\nissue: BREAK_ME: invalid/);
    expect(res.err).toMatch(/Boot check FAILED after the edit, so .* was restored from .*\.bak\./);
    expect(r.readEnv()).toBe(before);
    expect(ownership(r.envFile)).toEqual(owner);
    expect(r.backups()).toHaveLength(1); // the backup is kept
  });

  it('keeps an edit that made nothing worse when the file was already invalid, and says so', () => {
    const r = fake();
    // A new install: no secrets yet, so the boot check fails before and after; the edit adds the generated ones.
    r.writeEnv(`PORT=1\nWRITERS_MAX=invalid\n`);
    const res = run(r, 'env-sync.sh', ['--yes']);
    expect(res.status).toBe(1);
    expect(res.err).toMatch(/would still refuse to start, for the same reasons as before this edit/);
    expect(r.readEnv()).toMatch(/^SESSION_SECRET=.{64}$/m);
  });

  it('will not edit when the built bridge has no configuration check, unless told the file is not in use', () => {
    const r = fake();
    unlinkSync(join(r.app, 'dist', 'config', 'check.js'));
    r.writeEnv('PORT=1\n');
    const before = r.readEnv();
    const res = run(r, 'env-sync.sh', ['--yes']);
    expect(res.status).toBe(2);
    expect(res.err).toMatch(/has no configuration check .* Deploy this release first/);
    expect(r.readEnv()).toBe(before);
    expect(run(r, 'env-sync.sh', ['--yes', '--no-boot-check']).status).toBe(1);
    expect(r.readEnv()).toMatch(/^WRITERS_MAX=1$/m);
  });

  it('--placeholders-only adds only the commented-out secret placeholders', () => {
    const r = fake();
    r.writeEnv('PORT=1\n');
    run(r, 'env-sync.sh', ['--yes', '--placeholders-only', '--no-boot-check']);
    const text = r.readEnv();
    expect(text).toMatch(/^# OWNER_PASSWORD_HASH=$/m);
    expect(text).toMatch(/^# OWNER_TOTP_SECRET=/m);
    expect(text).not.toMatch(/^WRITERS_MAX|^SESSION_SECRET|JOURNAL_RETENTION_DAYS/m);
  });
});

describe('env-sync.sh --migrate-projects', () => {
  const template = () => readFileSync(new URL('../../deploy/env.template', import.meta.url), 'utf8');
  /** The live file of v1: the single-project form, with the sandbox settings. */
  const single = (r: FakeRoot, extra = '') =>
    inStepEnv(r)
      .replace(/^LK_PROJECTS=test\n/m, '')
      .replace(/^LK_DEFAULT_PROJECT=test\n/m, '')
      .replace(
        /^LK_PROJECT_TEST_API_KEY=.*$/m,
        `LK_API_KEY='${SECRETS.key}'\nLK_PROJECT_ID=proj_test_123\nLK_SANDBOX_API_KEY=${SECRETS.sandbox}\nLK_SANDBOX_PROJECT_ID=proj_sbx_9`,
      ) + extra;

  it('moves the key to LK_PROJECT_<NAME>_API_KEY, adds the project lines, comments out the old ones; twice is once', () => {
    const r = fake(template());
    r.writeEnv(single(r));
    const res = run(r, 'env-sync.sh', ['--yes', '--migrate-projects', '--release', 'v9.9.9']);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(
      /will migrate to the multi-project form: LK_API_KEY -> LK_PROJECT_TEST_API_KEY \(the value is moved, never shown\), add LK_PROJECTS \(project "test"\), add LK_DEFAULT_PROJECT, comment out LK_PROJECT_ID, comment out LK_SANDBOX_API_KEY, comment out LK_SANDBOX_PROJECT_ID/,
    );
    const text = r.readEnv();
    expect(text).toContain(`LK_PROJECT_TEST_API_KEY='${SECRETS.key}'`); // exactly the old value, quotes and all
    expect(text).toMatch(/^LK_PROJECTS=test$/m);
    expect(text).toMatch(/^LK_DEFAULT_PROJECT=test$/m);
    expect(text).not.toMatch(/^LK_API_KEY=|^LK_PROJECT_ID=|^LK_SANDBOX/m);
    expect(text).toMatch(
      /^# migrated to the multi-project form by env-sync \(v9\.9\.9, .*\): LK_PROJECT_ID is no longer used\.\n# LK_PROJECT_ID=proj_test_123$/m,
    );
    expect(text).toContain(`# LK_SANDBOX_API_KEY=${SECRETS.sandbox}`); // commented out, never deleted
    // The migrated file is what the template describes, and a second run changes nothing.
    const once = r.readEnv();
    const again = run(r, 'env-sync.sh', ['--yes', '--migrate-projects']);
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/already in the multi-project form/);
    expect(r.readEnv()).toBe(once);
    expect(run(r, 'env-sync.sh', ['--check']).status).toBe(0);
  });

  it('uses LK_PROJECT_NAME (lower-cased) for the new names', () => {
    const r = fake(template());
    r.writeEnv(single(r, 'LK_PROJECT_NAME=Arkona\n'));
    expect(run(r, 'env-sync.sh', ['--yes', '--migrate-projects']).status).toBe(0);
    const text = r.readEnv();
    expect(text).toContain(`LK_PROJECT_ARKONA_API_KEY='${SECRETS.key}'`);
    expect(text).toMatch(/^LK_PROJECTS=arkona$/m);
    expect(text).toMatch(/^LK_DEFAULT_PROJECT=arkona$/m);
    expect(text).toMatch(/^# LK_PROJECT_NAME=Arkona$/m);
  });

  it.each([
    [
      'both forms',
      (s: string) => `${s}LK_PROJECTS=test\n`,
      /mixed state: it sets LK_PROJECTS and also LK_API_KEY/,
    ],
    [
      'a new-form key without LK_PROJECTS',
      (s: string) => `${s}LK_PROJECT_TEST_API_KEY=${SECRETS.key2}\n`,
      /mixed state: it sets LK_API_KEY and also LK_PROJECT_TEST_API_KEY/,
    ],
    [
      'LK_API_KEY twice',
      (s: string) => `${s}LK_API_KEY=${SECRETS.key2}\n`,
      /LK_API_KEY is set more than once/,
    ],
    ['an empty key', (s: string) => s.replace(/^LK_API_KEY=.*$/m, 'LK_API_KEY='), /LK_API_KEY is empty/],
    ['an empty LK_PROJECTS', (s: string) => `${s}LK_PROJECTS=\n`, /LK_PROJECTS is present but empty/],
    [
      'another default project',
      (s: string) => `${s}LK_DEFAULT_PROJECT=arkona\n`,
      /LK_DEFAULT_PROJECT names another project/,
    ],
    [
      'a bad project name',
      (s: string) => `${s}LK_PROJECT_NAME=9lives\n`,
      /LK_PROJECT_NAME is not a valid project name/,
    ],
    [
      'no key at all',
      (s: string) => s.replace(/^LK_API_KEY=.*\n/m, ''),
      /neither LK_PROJECTS nor LK_API_KEY/,
    ],
  ])('refuses %s, and changes nothing', (_label, mutate, message) => {
    const r = fake(template());
    r.writeEnv(mutate(single(r)));
    const before = r.readEnv();
    const res = run(r, 'env-sync.sh', ['--yes', '--migrate-projects']);
    expect(res.status).toBe(2);
    expect(res.err).toMatch(/refusing to migrate: /);
    expect(res.err).toMatch(message);
    expect(r.readEnv()).toBe(before);
    expect(r.backups()).toEqual([]);
  });

  it('without --migrate-projects, leaves the single-project form alone and says how to move', () => {
    const r = fake(template());
    r.writeEnv(single(r));
    const res = run(r, 'env-sync.sh', ['--check']);
    expect(res.out).toMatch(/note: the file uses the single-project form .* --migrate-projects/);
    expect(res.out).not.toMatch(/LK_PROJECTS|LK_DEFAULT_PROJECT|placeholder: LK_PROJECT_TEST_API_KEY/);
    // The retired sandbox settings are not in the template any more: they are commented out like any removed variable.
    expect(res.out).toMatch(
      /will comment out \(no longer in the template\): LK_SANDBOX_API_KEY, LK_SANDBOX_PROJECT_ID/,
    );
  });
});
