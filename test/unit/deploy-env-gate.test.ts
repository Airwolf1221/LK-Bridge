/**
 * deploy.sh with env-sync and the self-check (OPS1, ADR 0024), run end to end on a fake server: a git "origin" and a
 * checkout under a temporary directory, the installed scripts in bin/, and stand-ins for npm, runuser, systemctl and
 * curl (test/unit/deploy-fake-root.ts). Each deploy really fetches, compares, builds (a stub build), runs the boot
 * check and migrations (stubs), starts and health-checks (stubs). No secret may appear in any output.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeRoot,
  INSTALLED,
  inStepEnv,
  makeFakeRoot,
  repoDeployDir,
  run,
  STUB_CHECK,
  STUB_MIGRATE,
} from './deploy-fake-root.js';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Server extends FakeRoot {
  /** The developer's working copy, which pushes to origin. */
  readonly work: string;
  /** Changes files in the working copy and pushes a commit to origin/main. */
  release(files: Record<string, string>, message?: string): void;
}

/**
 * A fake server with a deployable repository: origin (bare), the checkout in app/ (on main, clean), and bin/ holding
 * the same deploy scripts as the repository. The env file is in step with the shipped template.
 */
function makeServer(): Server {
  const root = makeFakeRoot();
  rmSync(root.app, { recursive: true, force: true });
  const work = join(root.dir, 'work');
  const origin = join(root.dir, 'origin.git');
  mkdirSync(join(work, 'deploy'), { recursive: true });
  mkdirSync(join(work, 'stub'), { recursive: true });
  for (const f of [...INSTALLED, 'env.template', 'lk-bridge.service'])
    copyFileSync(join(repoDeployDir, f), join(work, 'deploy', f));
  for (const f of ['deploy.sh', 'env-sync.sh']) chmodSync(join(work, 'deploy', f), 0o755);
  writeFileSync(
    join(work, 'package.json'),
    '{ "name": "lk-bridge", "version": "9.9.9", "type": "module" }\n',
  );
  writeFileSync(join(work, '.gitignore'), 'dist/\nui/dist/\nnode_modules/\n');
  writeFileSync(join(work, 'stub', 'check.js'), STUB_CHECK);
  writeFileSync(join(work, 'stub', 'migrate.js'), STUB_MIGRATE);
  writeFileSync(
    join(work, 'deploy', 'healthcheck.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "PASS stub health check"\n',
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    join(work, 'deploy', 'backup.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "stub backup"\n',
    {
      mode: 0o755,
    },
  );
  git(root.dir, 'init', '-q', '-b', 'main', work);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'first');
  git(root.dir, 'clone', '-q', '--bare', work, origin);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'fetch', '-q', 'origin');
  git(root.dir, 'clone', '-q', origin, root.app);
  // The stub npm: `ci` does nothing; `run build` lays out the build from the checkout's stub/ directory.
  writeFileSync(
    join(root.dir, 'node', 'bin', 'npm'),
    [
      '#!/bin/bash',
      'case "$1 ${2:-}" in',
      '  "ci "*) exit 0 ;;',
      '  "run build") mkdir -p dist/config dist/db ui/dist && echo > dist/server.js && echo "<html>" > ui/dist/index.html \\',
      '    && cp stub/check.js dist/config/check.js && cp stub/migrate.js dist/db/migrate.js ;;',
      '  *) echo "stub npm: $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  root.writeEnv(inStepEnv(root));
  // Two users, as on the server: the build user (us) must not be in the service user's group. `nobody` stands in for
  // lkbridge; LKB_RUNAS runs its commands as us.
  root.env.LKB_SERVICE_USER = 'nobody';
  return {
    ...root,
    work,
    release(files, message = 'release') {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
      git(work, 'add', '-A');
      git(work, 'commit', '-qm', message);
      git(work, 'push', '-q', 'origin', 'main');
    },
  };
}

const template = () => readFileSync(join(repoDeployDir, 'env.template'), 'utf8');
/** The shipped template plus one more variable. */
const withVar = (marker: string, line: string, comment = '# A setting this release adds.') =>
  `${template()}\n${comment}\n# @${marker}\n${line}\n`;

let server: Server | undefined;
afterEach(() => {
  server?.cleanup();
  server = undefined;
});

function deploy(s: Server, ...args: string[]) {
  return run(s, 'deploy.sh', args);
}

describe('deploy.sh and the env file (OPS1)', () => {
  it('deploys when the env file is in step, and runs the boot check before the migrations and the start', () => {
    const s = (server = makeServer());
    s.release({ 'README.md': 'new\n' });
    const r = deploy(s);
    expect(r.err).not.toMatch(/ERROR/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/in step: nothing to change/);
    expect(r.out).toMatch(/DEPLOY SUCCEEDED/);
    const boot = r.out.indexOf('Boot check: the new build');
    expect(boot).toBeGreaterThan(0);
    expect(r.out.indexOf('config check: OK')).toBeGreaterThan(boot);
    expect(r.out.indexOf('stub migrate: applied')).toBeGreaterThan(boot);
    expect(s.systemctlLog()).toBe('stop lk-bridge\nstart lk-bridge\n');
  });

  it('stops before changing anything when the release needs env changes, and prints the exact command', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/env.template': withVar('default', 'NEW_SETTING=on') });
    const before = s.readEnv();
    const r = deploy(s, '--local-health');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/will add: NEW_SETTING/);
    expect(r.err).toMatch(
      /not in step with this release's env.template .* run: sudo .*\/bin\/deploy\.sh --local-health --sync-env/,
    );
    expect(r.err).toMatch(/Nothing was changed; the service was not touched\./);
    expect(s.readEnv()).toBe(before);
    expect(s.systemctlLog()).toBe('');
    expect(git(s.app, 'rev-parse', 'HEAD')).not.toBe(git(s.work, 'rev-parse', 'HEAD')); // the checkout did not move
  });

  it('--sync-env --yes updates the env file after the build (backup, boot check) and carries on', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/env.template': withVar('default', 'NEW_SETTING=on') });
    const r = deploy(s, '--sync-env', '--yes');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/DEPLOY SUCCEEDED/);
    expect(s.readEnv()).toMatch(/# A setting this release adds\.\nNEW_SETTING=on\n/);
    expect(s.backups()).toHaveLength(1);
    // The update happens after the build, while the service is stopped, and before the migrations.
    const updated = r.out.indexOf('Updated ');
    expect(updated).toBeGreaterThan(r.out.indexOf('Building'));
    expect(updated).toBeLessThan(r.out.indexOf('stub migrate: applied'));
    expect(r.out).not.toMatch(/systemctl restart/); // the deploy starts it; no "restart to apply" hint
  });

  it('--sync-env asks first, and a "no" changes nothing', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/env.template': withVar('default', 'NEW_SETTING=on') });
    const before = s.readEnv();
    const r = run(s, 'deploy.sh', ['--sync-env'], 'n\n');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Apply these changes to .* after the build\? \[y\/N\]/);
    expect(s.readEnv()).toBe(before);
    expect(s.systemctlLog()).toBe('');
  });

  it('a missing secret always stops it with ACTION NEEDED; --sync-env adds only the placeholder', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/env.template': withVar('secret', 'NEW_TOKEN=', '# A token only the owner has.') });
    const before = s.readEnv();
    const plain = deploy(s);
    expect(plain.status).toBe(1);
    expect(plain.out).toMatch(/ACTION NEEDED: fill in NEW_TOKEN/);
    expect(plain.err).toMatch(/ACTION NEEDED \(above\)/);
    expect(s.readEnv()).toBe(before);

    const synced = deploy(s, '--sync-env', '--yes');
    expect(synced.status).toBe(1);
    expect(synced.err).toMatch(/ACTION NEEDED \(above\).*the placeholder lines are at the end/);
    expect(s.readEnv()).toMatch(/# A token only the owner has\.\n# NEW_TOKEN=\n/);
    expect(s.systemctlLog()).toBe('');
    // Still missing: it stops again. Filled in: it deploys.
    expect(deploy(s, '--sync-env', '--yes').status).toBe(1);
    s.writeEnv(s.readEnv().replace(/^# NEW_TOKEN=$/m, 'NEW_TOKEN=TESTKEY-lk-api-key-0123456789abcdefXYZ'));
    const done = deploy(s);
    expect(done.status).toBe(0);
    expect(done.out).toMatch(/DEPLOY SUCCEEDED/);
  });

  it('restores the env file and stops before the migrations and the start when the boot check fails', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/env.template': withVar('default', 'BREAK_ME=invalid') });
    const before = s.readEnv();
    const r = deploy(s, '--sync-env', '--yes');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/Boot check FAILED after the edit, so .* was restored/);
    expect(r.err).toMatch(/DEPLOY FAILED \(during: updating the env file \(env-sync\)\)/);
    expect(r.out).not.toMatch(/stub migrate: applied/);
    expect(s.readEnv()).toBe(before);
    expect(s.systemctlLog()).toBe('stop lk-bridge\n'); // stopped for the build, never started on a bad file
  });

  it('stops before the migrations when the new build refuses the env file, even with no edit', () => {
    const s = (server = makeServer());
    s.writeEnv(`${s.readEnv()}# set by hand\nWRITERS_MAX=invalid\n`);
    s.release({ 'README.md': 'new\n' });
    const r = deploy(s);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/issue: WRITERS_MAX: invalid/);
    expect(r.err).toMatch(/The new build would refuse the env file/);
    expect(r.out).not.toMatch(/stub migrate: applied/);
    expect(s.systemctlLog()).toBe('stop lk-bridge\n');
  });
});

describe('deploy.sh self-check of the installed scripts (OPS1)', () => {
  const marked = (f: string) =>
    `${readFileSync(join(repoDeployDir, f), 'utf8')}${f.endsWith('.mjs') ? '//' : '#'} release marker 9.9.10\n`;

  it('stops with the difference when the release changes a deploy script', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/lib.sh': marked('lib.sh') });
    const r = deploy(s);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\+# release marker 9\.9\.10/); // the diff, in full
    expect(r.err).toMatch(
      /installed deploy scripts \(lib\.sh\) differ .* run: sudo .*\/deploy\.sh --update-self/,
    );
    expect(readFileSync(join(s.bin, 'lib.sh'), 'utf8')).not.toMatch(/release marker/);
    expect(s.systemctlLog()).toBe('');
  });

  it('--update-self installs the release copies with their modes and re-runs the new deploy.sh with the same options', () => {
    const s = (server = makeServer());
    s.release({
      'deploy/deploy.sh': marked('deploy.sh').replace(
        /^step="starting"$/m,
        'step="starting"\nlog "THIS IS THE NEW DEPLOY.SH"',
      ),
      'deploy/env-sync.mjs': marked('env-sync.mjs'),
    });
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.err).not.toMatch(/ERROR/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Installed .*\/bin\/deploy\.sh\./);
    expect(r.out).toMatch(/Installed .*\/bin\/env-sync\.mjs\./);
    expect(r.out).toMatch(/Running the new .*\/deploy\.sh with the same options/);
    expect(r.out).toMatch(/THIS IS THE NEW DEPLOY.SH/);
    expect(r.out).toMatch(/DEPLOY SUCCEEDED/);
    expect(readFileSync(join(s.bin, 'deploy.sh'), 'utf8')).toMatch(/THIS IS THE NEW DEPLOY.SH/);
    expect(readFileSync(join(s.bin, 'env-sync.mjs'), 'utf8')).toMatch(/release marker/);
    const mode = (f: string) =>
      spawnSync('stat', ['-c', '%a', join(s.bin, f)], { encoding: 'utf8' }).stdout.trim();
    expect(mode('deploy.sh')).toBe('755');
    expect(mode('env-sync.mjs')).toBe('644');
  });

  it('--update-self asks first; "no" installs nothing', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/lib.sh': marked('lib.sh') });
    const r = run(s, 'deploy.sh', ['--update-self'], 'n\n');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/Nothing was installed or changed/);
    expect(readFileSync(join(s.bin, 'lib.sh'), 'utf8')).not.toMatch(/release marker/);
  });

  it('treats a broken env-sync as an error, never as "in step" or "changes needed"', () => {
    const s = (server = makeServer());
    writeFileSync(join(s.bin, 'env-sync.mjs'), 'process.exit(1);\n');
    s.release({ 'README.md': 'new\n' });
    // The self-check notices first; skip it by making the release's copy the broken one too.
    s.release({ 'deploy/env-sync.mjs': 'process.exit(1);\n' });
    const r = deploy(s);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/env-sync could not check the env file/);
    expect(s.systemctlLog()).toBe('');
  });

  it('installs a deploy script that is missing from bin/ (env-sync, the first time)', () => {
    const s = (server = makeServer());
    rmSync(join(s.bin, 'env-sync.mjs'));
    s.release({ 'README.md': 'new\n' });
    const stopped = deploy(s);
    expect(stopped.status).toBe(1);
    expect(stopped.err).toMatch(/\(env-sync\.mjs\) differ/);
    expect(deploy(s, '--update-self', '--yes').status).toBe(0);
    expect(readFileSync(join(s.bin, 'env-sync.mjs'), 'utf8')).toBe(
      readFileSync(join(repoDeployDir, 'env-sync.mjs'), 'utf8'),
    );
  });

  it('with --current (a rollback), warns and keeps the installed scripts', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/lib.sh': marked('lib.sh') });
    git(s.app, 'pull', '-q', '--ff-only');
    const r = deploy(s, '--current', '--force');
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/Carrying on with the installed ones \(--current\)/);
    expect(readFileSync(join(s.bin, 'lib.sh'), 'utf8')).not.toMatch(/release marker/);
  });
});

describe('deploy.sh --update-self and the systemd unit', () => {
  const UNIT = 'lk-bridge.service';
  /** The release's unit, changed (a comment is enough: the file is compared byte for byte). */
  const changedUnit = () => `${readFileSync(join(repoDeployDir, UNIT), 'utf8')}# release marker 9.9.10\n`;
  const installed = (s: Server) => join(s.unitDir, UNIT);
  const backupsOf = (s: Server) => readdirSync(s.unitDir).filter((f) => f.startsWith(`${UNIT}.bak.`));
  const calls = (s: Server) => s.systemctlLog().trim().split('\n').filter(Boolean);

  it('without the flag, only warns at the end: the installed unit is not touched, systemd is not reloaded', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/lk-bridge.service': changedUnit() });
    const r = deploy(s, '--local-health');
    expect(r.status).toBe(0);
    expect(r.err).toMatch(
      /lk-bridge\.service differs from deploy\/lk-bridge\.service\. An administrator should reinstall it/,
    );
    expect(readFileSync(installed(s), 'utf8')).not.toMatch(/release marker/);
    expect(backupsOf(s)).toEqual([]);
    expect(calls(s)).toEqual(['stop lk-bridge', 'start lk-bridge']);
  });

  it('--update-self shows the difference, backs up the installed copy, installs the release’s (0644), reloads systemd, then starts', () => {
    const s = (server = makeServer());
    const before = readFileSync(installed(s), 'utf8');
    s.release({ 'deploy/lk-bridge.service': changedUnit() });
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.err).not.toMatch(/ERROR|WARNING/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/The installed .*lk-bridge\.service differs from the one in/);
    expect(r.out).toMatch(/^\+# release marker 9\.9\.10$/m); // the diff, in full
    expect(r.out).toMatch(/Backed up .*lk-bridge\.service to .*lk-bridge\.service\.bak\.\d{8}T\d{6}Z\./);
    expect(r.out).toMatch(/Installed .*lk-bridge\.service\./);
    expect(r.out).toMatch(/Reloaded systemd \(daemon-reload\)/);
    expect(r.out).toMatch(/DEPLOY SUCCEEDED/);
    expect(readFileSync(installed(s), 'utf8')).toBe(changedUnit());
    const [backup, ...more] = backupsOf(s);
    expect(more).toEqual([]);
    expect(readFileSync(join(s.unitDir, backup!), 'utf8')).toBe(before);
    expect(statSync(installed(s)).mode & 0o7777).toBe(0o644);
    // The deploy's own restart picks it up: the unit is installed and systemd reloaded after the stop and before the start.
    expect(calls(s)).toEqual(['stop lk-bridge', 'daemon-reload', 'start lk-bridge']);
    expect(r.out.indexOf('Reloaded systemd')).toBeLessThan(r.out.indexOf('Starting lk-bridge'));
    expect(readdirSync(s.unitDir).filter((f) => f.endsWith('.new'))).toEqual([]);
  });

  it('asks first; "no" installs nothing and changes nothing', () => {
    const s = (server = makeServer());
    s.release({ 'deploy/lk-bridge.service': changedUnit() });
    const r = run(s, 'deploy.sh', ['--update-self'], 'n\n');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^\+# release marker 9\.9\.10$/m);
    expect(r.err).toMatch(/Nothing was installed or changed/);
    expect(readFileSync(installed(s), 'utf8')).not.toMatch(/release marker/);
    expect(backupsOf(s)).toEqual([]);
    expect(calls(s)).toEqual([]); // the service was never touched
  });

  it('with the code already at origin/main it still restarts, to apply the unit', () => {
    const s = (server = makeServer());
    // First deploy of the only release; then the administrator's installed unit is out of date.
    expect(deploy(s, '--local-health').status).toBe(0);
    writeFileSync(installed(s), `${readFileSync(installed(s), 'utf8')}# an old local edit\n`);
    writeFileSync(join(s.dir, 'systemctl.log'), '');
    const nothing = deploy(s, '--local-health');
    expect(nothing.out).toMatch(/Nothing to deploy/);
    expect(calls(s)).toEqual([]);
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Already at origin\/main, but the unit changes: the service is restarted/);
    expect(r.out).not.toMatch(/Nothing to deploy/);
    expect(readFileSync(installed(s), 'utf8')).toBe(readFileSync(join(repoDeployDir, UNIT), 'utf8'));
    expect(calls(s)).toEqual(['stop lk-bridge', 'daemon-reload', 'start lk-bridge']);
  });

  it('a unit that is already the release’s is left alone: no backup, no reload', () => {
    const s = (server = makeServer());
    s.release({ 'README.md': 'new\n' });
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/systemd/);
    expect(backupsOf(s)).toEqual([]);
    expect(calls(s)).toEqual(['stop lk-bridge', 'start lk-bridge']);
  });

  it('a unit that is not installed at all is not installed by the deploy', () => {
    const s = (server = makeServer());
    rmSync(installed(s));
    s.release({ 'deploy/lk-bridge.service': changedUnit() });
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.status).toBe(0);
    expect(existsSync(installed(s))).toBe(false);
    expect(calls(s)).toEqual(['stop lk-bridge', 'start lk-bridge']);
  });

  it('a deploy that fails before the start leaves the installed unit exactly as it was', () => {
    const s = (server = makeServer());
    const before = readFileSync(installed(s), 'utf8');
    s.release({ 'deploy/lk-bridge.service': changedUnit() });
    // The new build would refuse the env file (the boot check), after the stop and before the migrations.
    s.writeEnv(`${s.readEnv()}\nWRITERS_MAX=invalid\n`);
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.status).toBe(1);
    expect(readFileSync(installed(s), 'utf8')).toBe(before);
    expect(backupsOf(s)).toEqual([]);
    expect(calls(s)).not.toContain('daemon-reload');
  });

  it('a changed deploy script and a changed unit together: the new deploy.sh installs the unit, once', () => {
    const s = (server = makeServer());
    s.release({
      'deploy/lib.sh': `${readFileSync(join(repoDeployDir, 'lib.sh'), 'utf8')}# release marker 9.9.10\n`,
      'deploy/lk-bridge.service': changedUnit(),
    });
    const r = deploy(s, '--update-self', '--yes', '--local-health');
    expect(r.err).not.toMatch(/ERROR/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Running the new .*\/deploy\.sh with the same options/);
    expect(readFileSync(installed(s), 'utf8')).toBe(changedUnit());
    expect(backupsOf(s)).toHaveLength(1);
    expect(calls(s).filter((c) => c === 'daemon-reload')).toHaveLength(1);
    expect(r.out.match(/differs from the one in/g)).toHaveLength(1);
  });
});
