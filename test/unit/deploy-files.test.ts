/**
 * Static checks on the deployment files (chunk 7a). Nothing here touches a server. shellcheck and systemd-analyze are
 * used when they are installed (CI has shellcheck; both are skipped, with a reason, where they are not).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const deployDir = new URL('../../deploy/', import.meta.url).pathname;
const read = (name: string) => readFileSync(join(deployDir, name), 'utf8');
const scripts = readdirSync(deployDir).filter((f) => f.endsWith('.sh'));

const has = (cmd: string, args: string[] = ['--version']) =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const haveShellcheck = has('shellcheck');
const haveSystemdAnalyze = has('systemd-analyze', ['--version']);

describe('deploy scripts', () => {
  it('finds the scripts the runbook names', () => {
    for (const s of [
      'install-node.sh',
      'deploy.sh',
      'backup.sh',
      'healthcheck.sh',
      'lib.sh',
      'lk-run.sh',
      'sandbox-test.sh',
      'soak-sandbox.sh', // chunk 8
      'spike-v2.sh', // v2 phase 0
      'restore.sh', // chunk 8
      'migrate-to-build-user.sh', // v1.0.1
      'env-sync.sh', // OPS1
    ]) {
      expect(scripts, s).toContain(s);
    }
  });

  it.each(scripts)('%s is bash, strict, and executable', (name) => {
    const text = read(name);
    expect(text.startsWith('#!/usr/bin/env bash\n'), 'shebang').toBe(true);
    if (name !== 'lib.sh') expect(text).toMatch(/^set -euo pipefail$/m);
    // git keeps the executable bit; the systemd backup unit and the runbook run these directly.
    expect(statSync(join(deployDir, name)).mode & 0o111, 'executable bit').not.toBe(0);
  });

  it.skipIf(!haveShellcheck)(
    'passes shellcheck',
    () => {
      const r = spawnSync('shellcheck', ['-x', ...scripts.map((s) => join(deployDir, s))], {
        encoding: 'utf8',
      });
      expect(r.stdout + r.stderr).toBe('');
      expect(r.status).toBe(0);
    },
    30_000,
  ); // about 4 s alone: close to the 5 s default when the whole suite runs

  it('never prints or traces secrets', () => {
    for (const name of scripts) {
      const text = read(name);
      expect(text, name).not.toMatch(/^\s*set -[a-z]*x/m); // no xtrace: it would echo exported secrets
      expect(text, name).not.toMatch(/\bsource\b[^\n]*lk-bridge\.env|\.\s+\/etc\/lk-bridge/); // the env file is parsed, never sourced
    }
  });

  it('deploy.sh refuses a dirty checkout and pulls fast-forward only', () => {
    const t = read('deploy.sh');
    expect(t).toMatch(/git status --porcelain/);
    expect(t).toMatch(/merge --ff-only/);
    expect(t).not.toMatch(/--force-with-lease|push\b|reset --hard|git clean|checkout -f|pull --rebase/);
  });

  it('every systemctl call goes through the four commands the sudoers rule allows', () => {
    const t = read('deploy.sh');
    // svc() is the only caller and passes start|stop; no other action reaches sudo.
    expect(t).toMatch(/svc stop/);
    expect(t).toMatch(/svc start/);
    expect(t).not.toMatch(/svc (enable|disable|daemon-reload|mask|edit|reload)/);
    // ... and it runs as the service user, through its narrow rule (v1.0.1).
    expect(t).toMatch(/as_service sudo -n "\$systemctl_bin" "\$1" "\$LKB_SERVICE"/);
  });
});

describe('deploy.sh with a separate build user (v1.0.1, ADR 0020, F-17)', () => {
  const t = read('deploy.sh');
  const code = t
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('runs as root, only from the installed copy, which must be root-owned and not writable by others', () => {
    expect(code).toMatch(/\[\[ "\$\(id -u\)" -ne 0 && -z "\$\{LKB_RUNAS:-\}" \]\]/);
    expect(code).toMatch(/Run this as root, from the installed copy/);
    expect(code).toMatch(/"\$app_dir"\/\*\) die "This is the copy inside the checkout/);
    expect(code).toMatch(/is not owned by root/);
    expect(code).toMatch(/is writable by its group or by others/);
    // It sources only its own neighbour (the installed lib.sh), never the checkout's.
    expect(code.match(/^\s*source .*/gm)).toEqual(['source "${here}/lib.sh"']);
  });

  it('runs git and npm only as the build user, and migrations, backup and health check only as the service user', () => {
    const lines = code.split('\n');
    for (const l of lines.filter((x) => /(^|[\s(])(git|npm) /.test(x) && !/die |log |echo |warn /.test(x))) {
      expect(l, l).toMatch(/as_build (git|npm) /);
    }
    for (const l of lines.filter(
      (x) => /\bnode dist\/|backup\.sh|healthcheck\.sh"/.test(x) && !/die |log |echo /.test(x),
    )) {
      expect(l, l).toMatch(/as_service /);
    }
    expect(code).toMatch(/as_build npm ci --no-audit --no-fund/);
    expect(code).toMatch(/as_build npm run build/);
    // v2 A1: the migrations also get the single-project form's project id and name (migration 0600), never a key.
    expect(code).toMatch(
      /as_service env DB_PATH="\$db_path" LK_PROJECT_ID="\$legacy_project_id" LK_PROJECT_NAME="\$legacy_project_name" node dist\/db\/migrate\.js/,
    );
    expect(code).toMatch(/legacy_project_id="\$\(env_file_get LK_PROJECT_ID\)"/);
    expect(
      code
        .split('\n')
        .filter((l) => /migrate\.js/.test(l))
        .join('\n'),
    ).not.toMatch(/KEY|SECRET/);
    expect(code).toMatch(/as_service env DB_PATH="\$db_path" "\$\{app_dir\}\/deploy\/backup\.sh" pre-deploy/);
    expect(code).toMatch(/as_service "\$\{app_dir\}\/deploy\/healthcheck\.sh"/);
  });

  it('drops privileges with runuser and a clean environment, and the build user gets no secret', () => {
    const asBuild = /as_build\(\) \{[\s\S]*?\n\}/.exec(code)![0];
    const asService = /as_service\(\) \{[\s\S]*?\n\}/.exec(code)![0];
    for (const f of [asBuild, asService]) {
      expect(f).toMatch(/\$\{LKB_RUNAS:-runuser -u\}/);
      expect(f).toMatch(/ -- env -i /);
    }
    expect(asBuild).toMatch(/umask 022/);
    expect(asBuild).not.toMatch(/LKB_ENV_FILE|DB_PATH|LK_API_KEY|SECRET/);
    // Before building, it checks the build user cannot read the env file, and after, that the service user cannot
    // write the app.
    expect(code).toMatch(/as_build test -r "\$LKB_ENV_FILE"; then\s*\n\s*die/);
    expect(code).toMatch(/lkb_writable_by "\$svc_user" "\$app_dir"/);
    expect(code).toMatch(/lkb_in_group "\$build_user" "\$svc_user" && die/);
  });

  it('refuses to run from inside the checkout (where the build user could have changed it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-deploy-'));
    try {
      const app = join(dir, 'app');
      spawnSync('mkdir', ['-p', join(app, 'deploy')]);
      for (const f of ['deploy.sh', 'lib.sh']) copyFileSync(join(deployDir, f), join(app, 'deploy', f));
      spawnSync('chmod', ['+x', join(app, 'deploy', 'deploy.sh')]);
      const r = spawnSync(join(app, 'deploy', 'deploy.sh'), [], {
        encoding: 'utf8',
        env: { ...process.env, LKB_APP_DIR: app, LKB_RUNAS: 'true' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/This is the copy inside the checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('refuses to run as anyone but root', () => {
    const r = spawnSync(join(deployDir, 'deploy.sh'), [], { encoding: 'utf8', env: { ...process.env } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Run this as root, from the installed copy/);
  });
});

describe('deploy.sh, env-sync and the self-check: order and separation (OPS1)', () => {
  const code = read('deploy.sh')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const at = (re: RegExp) => {
    const i = code.search(re);
    expect(i, String(re)).toBeGreaterThan(0);
    return i;
  };

  it('checks the installed scripts and the env file before stopping the service, and boots-checks before migrating', () => {
    const selfCheck = at(/as_build git show "\$\{new_sha\}:deploy\/\$\{f\}"/);
    const gate = at(/"\$\{here\}\/env-sync\.sh" --check/);
    const stop = at(/\nsvc stop/);
    const build = at(/as_build npm run build/);
    const apply = at(/"\$\{here\}\/env-sync\.sh" --yes/);
    const boot = at(/lkb_config_check "\$LKB_ENV_FILE"/);
    const migrate = at(/node dist\/db\/migrate\.js/);
    const start = at(/\nsvc start/);
    expect(selfCheck).toBeLessThan(gate);
    expect(gate).toBeLessThan(stop);
    expect(build).toBeLessThan(apply);
    expect(apply).toBeLessThan(boot);
    expect(boot).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(start);
  });

  it('runs the installed env-sync (never the checkout copy), and the build user only reads the template out of git', () => {
    expect(code).not.toMatch(/app_dir\}?\/deploy\/env-sync/);
    for (const l of code
      .split('\n')
      .filter((x) => /env-sync\.sh"/.test(x) && !/die |log |echo |warn |\[\[/.test(x))) {
      expect(l, l).toMatch(/"\$\{here\}\/env-sync\.sh"/);
    }
    // The build user's part: git show of the template and package.json into root's scratch directory. It is never
    // given the env file (beyond the pre-flight check that it cannot read it).
    for (const l of code.split('\n').filter((x) => /as_build/.test(x) && /LKB_ENV_FILE/.test(x))) {
      expect(l).toMatch(/as_build test -r "\$LKB_ENV_FILE"; then/);
    }
    expect(code).toMatch(
      /as_build git show "\$\{new_sha\}:deploy\/env\.template" >"\$\{work_dir\}\/env\.template"/,
    );
  });

  it('installs itself only with --update-self, root-owned and with fixed modes, then re-runs the new copy', () => {
    expect(code).toMatch(/self_files=\(deploy\.sh:0755 lib\.sh:0644 env-sync\.sh:0755 env-sync\.mjs:0644\)/);
    expect(code).toMatch(
      /install -o root -g root -m "\$\{spec##\*:\}" -- "\$\{work_dir\}\/\$\{f\}" "\$\{here\}\/\$\{f\}\.new"/,
    );
    expect(code).toMatch(/exec "\$\{here\}\/deploy\.sh" "\$\{orig_args\[@\]\}"/);
    expect(code).toMatch(/LKB_SELF_UPDATED/); // never a loop
  });

  it('installs the systemd unit only with --update-self: backup first, root:root 0644, daemon-reload, all before the start', () => {
    expect(code).toMatch(/if \(\(update_self\)\) && \[\[ -f "\$unit_installed" \]\]/);
    const backup = code.indexOf(
      'cp --preserve=mode,ownership,timestamps -- "$unit_installed" "$unit_backup"',
    );
    const install = code.indexOf(
      'install -o root -g root -m 0644 -- "${work_dir}/${unit_name}" "${unit_installed}.new"',
    );
    const rename = code.indexOf('mv -f -- "${unit_installed}.new" "$unit_installed"');
    const reload = code.indexOf('"$systemctl_bin" daemon-reload');
    const start = code.indexOf('step="starting the service"');
    expect(backup).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(backup);
    expect(rename).toBeGreaterThan(install);
    expect(reload).toBeGreaterThan(rename);
    expect(start).toBeGreaterThan(reload);
    // The release's copy is read out of git by the build user as text (like the other self files), never run.
    expect(code).toMatch(
      /as_build git show "\$\{new_sha\}:deploy\/\$\{unit_name\}" >"\$\{work_dir\}\/\$\{unit_name\}"/,
    );
    // Without the flag the existing warning stays.
    expect(code).toMatch(
      /warn "\$\{LKB_UNIT_DIR\}\/\$\{unit\} differs from deploy\/\$\{unit\}\. An administrator should reinstall it/,
    );
  });

  it('env-sync.sh writes atomically beside the file after a backup, and checks with the bridge as the service user', () => {
    const e = read('env-sync.sh');
    const backup = e.indexOf('cp --preserve=mode,ownership,timestamps -- "$env_file" "$backup"');
    const rename = e.indexOf('mv -f -- "$tmp" "$env_file"');
    expect(backup).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(backup);
    expect(e).toMatch(/chown --reference="\$env_file" -- "\$tmp"/);
    expect(e).toMatch(/chmod --reference="\$env_file" -- "\$tmp"/);
    expect(e).toMatch(/^umask 077$/m);
    expect(e).toMatch(/env -i PATH=/); // the planner gets an empty environment
    const lib = read('lib.sh');
    expect(lib).toMatch(/\$\{LKB_RUNAS:-runuser -u\} "\$LKB_SERVICE_USER" -- env -i /);
  });
});

describe('migrate-to-build-user.sh (v1.0.1)', () => {
  const t = read('migrate-to-build-user.sh');

  it('runs as root from a root-owned copy outside the checkout, and has a read-only --check mode', () => {
    expect(t).toMatch(/\[\[ "\$\(id -u\)" -eq 0 \]\] \|\| die "Run this as root/);
    expect(t).toMatch(/This copy is inside the checkout/);
    expect(t).toMatch(/must be owned by root and writable only by root/);
    expect(t).toMatch(/--check\) check=1/);
    // In --check mode every change goes through act(), which only reports; step 5 and 6 never run.
    expect(t).toMatch(/if \(\(check\)\); then\s*\n\s*log " {2}would: \$\{what\}"/);
    expect(t).toMatch(/Check finished: .* Nothing was changed\.[\s\S]*exit 0/);
    expect(t).not.toMatch(/\bsource\b|^\s*\. /m); // self-contained: it never loads code from the checkout
  });

  it('creates lkbuild without a login shell or sudo, and never in group lkbridge', () => {
    expect(t).toMatch(
      /useradd --system --user-group --create-home --home-dir "\/home\/\$\{B\}" --shell \/usr\/sbin\/nologin "\$B"/,
    );
    expect(t).toMatch(/for g in "\$S" sudo admin adm wheel; do/);
    expect(t).toMatch(/has sudo rights \(sudo -l -U/);
  });

  it('moves the deploy key only after lkbuild has proved it can reach GitHub with it', () => {
    const copy = t.indexOf('copy the key to');
    const proof = t.indexOf('github_ok || die', copy);
    const remove = t.indexOf('remove the key, its config and known_hosts', copy);
    expect(copy).toBeGreaterThan(0);
    expect(proof).toBeGreaterThan(copy);
    expect(remove).toBeGreaterThan(proof);
    expect(t).toMatch(/No deploy key at .* Add a new read-only deploy key for \$\{B\}/);
  });

  it('validates the sudoers file with visudo -cf before it goes live, and verifies as each user', () => {
    expect(t).toMatch(
      /visudo -cf "\$\{LKB_SUDOERS_FILE\}\.new"[\s\S]*mv -f -- "\$\{LKB_SUDOERS_FILE\}\.new" "\$LKB_SUDOERS_FILE"/,
    );
    for (const check of [
      'must_not "${B} cannot read ${LKB_ENV_FILE}" as "$B" test -r "$LKB_ENV_FILE"',
      'must_not "${B} cannot read the database" as "$B" test -r "$db"',
      'must "${S} cannot write anything in the checkout" test -z "$(as "$S" find "$LKB_APP_DIR" -writable -print -quit 2>/dev/null)"',
    ]) {
      expect(t).toContain(check);
    }
    expect(t).toMatch(/"\$\{LKB_BIN_DIR\}\/deploy\.sh" --force/);
    expect(t).not.toMatch(/rm -rf|rm -fr|chmod -R 777|chmod 777/);
  });

  it('stops with a clear message when there is no existing install', () => {
    // Read-only: the first checks run before anything is changed.
    const r = spawnSync(join(deployDir, 'migrate-to-build-user.sh'), ['--check'], {
      encoding: 'utf8',
      env: { ...process.env, LKB_SERVICE_USER: 'no-such-user-lkb' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /STOPPED: (Run this as root|.*inside the checkout|.*must be owned by root|There is no user no-such-user-lkb)/,
    );
    expect(r.stderr).toMatch(/Nothing after this point was changed/);
  });
});

describe('permission helpers in lib.sh (v1.0.1)', () => {
  const sh = (script: string, ...args: string[]) =>
    spawnSync('bash', ['-c', `source "${join(deployDir, 'lib.sh')}" && ${script}`, 'x', ...args], {
      encoding: 'utf8',
    });

  it('judges another user (nobody) by the class that applies, along the whole path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-perm-'));
    try {
      spawnSync('chmod', ['0755', dir]);
      const f = (name: string, mode: string) => {
        writeFileSync(join(dir, name), 'x');
        spawnSync('chmod', [mode, join(dir, name)]);
        return join(dir, name);
      };
      const open = f('open', '0644');
      const secret = f('secret', '0600');
      const groupOnly = f('group-only', '0640');
      const worldWritable = f('world-writable', '0666');
      spawnSync('mkdir', ['-m', '0700', join(dir, 'private')]);
      writeFileSync(join(dir, 'private', 'inside'), 'x');
      spawnSync('chmod', ['0644', join(dir, 'private', 'inside')]);
      const can = (mode: string, p: string) => sh('lkb_user_can nobody "$1" "$2"', mode, p).status === 0;
      expect(can('r', open)).toBe(true);
      expect(can('r', secret)).toBe(false);
      expect(can('r', groupOnly)).toBe(false); // nobody is not in the file's group
      expect(can('w', open)).toBe(false);
      expect(can('w', worldWritable)).toBe(true);
      expect(can('r', join(dir, 'private', 'inside'))).toBe(false); // a parent without x stops it
      expect(can('r', join(dir, 'missing'))).toBe(false);
      expect(sh('lkb_writable_by nobody "$1"', dir).stdout.trim()).toBe(worldWritable);
      spawnSync('chmod', ['0644', worldWritable]);
      expect(sh('lkb_writable_by nobody "$1"', dir).stdout.trim()).toBe('');
      expect(sh('lkb_in_group root root').status).toBe(0);
      expect(sh('lkb_in_group nobody root').status).not.toBe(0);
      // Where we may ask the kernel (as root), it agrees.
      if (process.getuid?.() === 0) {
        for (const [mode, p] of [
          ['r', open],
          ['r', secret],
          ['r', groupOnly],
          ['r', join(dir, 'private', 'inside')],
        ] as const) {
          const kernel = spawnSync('runuser', ['-u', 'nobody', '--', 'test', `-${mode}`, p]).status === 0;
          expect(can(mode, p), p).toBe(kernel);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('healthcheck.sh reports the permission checks as PASS/FAIL lines', () => {
    const h = read('healthcheck.sh');
    for (const name of [
      'exists and is not in group',
      'cannot read the secrets',
      'cannot read the database',
      'cannot write the app',
      'can read the app and the env file',
      "is root's and writable by neither user",
    ]) {
      expect(h).toContain(name);
    }
    expect(h).toMatch(/^check_permissions$/m);
    // It runs before the --local-only exit, so every mode checks permissions.
    expect(h.indexOf('\ncheck_permissions\n')).toBeLessThan(h.indexOf('if ((local_only)); then'));
  });
});

describe('env drift check (chunk 8, F-10)', () => {
  const run = (template: string, live: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-drift-'));
    try {
      writeFileSync(join(dir, 'env.template'), template);
      writeFileSync(join(dir, 'live.env'), live);
      const r = spawnSync(
        'bash',
        [
          '-c',
          `source "${join(deployDir, 'lib.sh')}" && env_drift_report "$1" "$2"`,
          'x',
          join(dir, 'env.template'),
          join(dir, 'live.env'),
        ],
        { encoding: 'utf8' },
      );
      return { status: r.status, out: r.stdout, err: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('is quiet for a live file made from the shipped template', () => {
    const r = run(read('env.template'), read('env.template'));
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/matches deploy\/env.template/);
  });

  it('warns by name, never by value, about missing, new optional and removed variables, and never fails', () => {
    // (v2 A1: the project variables follow their own rules, below; SESSION_SECRET stands in for "a secret set in both
    // files", which LK_API_KEY was before.)
    const template = [
      '# A comment with NAME=value inside prose is not a variable',
      'SESSION_SECRET=',
      'WRITERS_MAX=1',
      '# UPLOAD_MAX_BYTES=10485760',
      '# BRAND_NEW_OPTION=on',
      '',
    ].join('\n');
    const live = [
      "SESSION_SECRET='the-real-secret-value'",
      '# UPLOAD_MAX_BYTES=10485760',
      'ADMIN_BUDGET_SAMPLE_SECONDS=10',
      "OLD_SECRET='another-secret-value'",
      '',
    ].join('\n');
    const r = run(template, live);
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/does not set WRITERS_MAX/);
    expect(r.err).toMatch(/optional setting BRAND_NEW_OPTION/);
    expect(r.err).toMatch(/sets ADMIN_BUDGET_SAMPLE_SECONDS, which deploy\/env.template no longer lists/);
    expect(r.err).toMatch(/sets OLD_SECRET/);
    expect(r.err).not.toMatch(/UPLOAD_MAX_BYTES|SESSION_SECRET|NAME/);
    expect(r.err + r.out).not.toMatch(/the-real-secret-value|another-secret-value|10485760/);
  });

  it('judges the project variables by the project rules (v2 A1), by name only', () => {
    // OPS2: the template's project lines are commented out (projects are added on the dashboard); a live file that
    // uses them, as the server's does, is built from it here.
    const template = read('env.template')
      .replace(/^# LK_PROJECTS=$/m, 'LK_PROJECTS=test\nLK_PROJECT_TEST_API_KEY=')
      .replace(/^# LK_DEFAULT_PROJECT=$/m, 'LK_DEFAULT_PROJECT=test');
    // The shipped template with a second project, its key, and nothing else: quiet.
    const two = template
      .replace(/^LK_PROJECTS=test$/m, 'LK_PROJECTS=test,arkona')
      .replace(
        /^LK_PROJECT_TEST_API_KEY=$/m,
        "LK_PROJECT_TEST_API_KEY='k1-secret'\nLK_PROJECT_ARKONA_API_KEY='k2-secret'",
      );
    const quiet = run(template, two);
    expect(quiet.err).toBe('');
    expect(quiet.out).toMatch(/matches deploy\/env.template/);
    // A listed project without its key, a key for a project not listed, the old form left behind, and the retired
    // sandbox settings: each named, no value ever printed.
    const messy = template
      .replace(/^LK_PROJECTS=test$/m, 'LK_PROJECTS=test,arkona')
      .replace(
        /^LK_PROJECT_TEST_API_KEY=$/m,
        "LK_PROJECT_TEST_API_KEY='k1-secret'\nLK_PROJECT_OLD_API_KEY='k3-secret'",
      )
      .concat("LK_API_KEY='k4-secret'\nLK_SANDBOX_API_KEY='k5-secret'\n");
    const r = run(template, messy);
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/lists project arkona but the file does not set LK_PROJECT_ARKONA_API_KEY/);
    expect(r.err).toMatch(/sets LK_PROJECT_OLD_API_KEY, but LK_PROJECTS does not list project old/);
    expect(r.err).toMatch(/sets LK_API_KEY, which the bridge ignores because LK_PROJECTS is set/);
    expect(r.err).toMatch(/sets LK_SANDBOX_API_KEY, which is retired/);
    expect(r.err + r.out).not.toMatch(/k[1-5]-secret/);
    // The single-project form on its own: one warning recommending the move, no "missing key" noise.
    const legacy = template
      .replace(/^LK_PROJECTS=test$/m, '')
      .replace(/^LK_PROJECT_TEST_API_KEY=$/m, "LK_API_KEY='k6-secret'\nLK_PROJECT_ID=proj_x")
      .replace(/^LK_DEFAULT_PROJECT=test$/m, '');
    const old = run(template, legacy);
    expect(old.err).toMatch(
      /uses the single-project form \(LK_API_KEY, LK_PROJECT_ID\), which still works but is deprecated/,
    );
    expect(old.err).not.toMatch(/LK_PROJECT_TEST_API_KEY/);
    expect(old.err + old.out).not.toMatch(/k6-secret|proj_x/);
  });

  it('is called by healthcheck.sh; deploy.sh checks with env-sync against the release being deployed (OPS1)', () => {
    expect(read('healthcheck.sh')).toMatch(/env_drift_report /);
    // deploy.sh used to warn against the checkout's (old) template; it now runs env-sync --check against the new one.
    expect(read('deploy.sh')).not.toMatch(/^env_drift_report /m);
    expect(read('deploy.sh')).toMatch(/"\$\{here\}\/env-sync\.sh" --check "\$\{sync_args\[@\]\}"/);
  });
});

describe('sudoers.lk-bridge', () => {
  const text = read('sudoers.lk-bridge');
  const rules = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

  it('allows exactly restart, stop, start and status of lk-bridge, to lkbridge, and nothing else', () => {
    const joined = rules.join(' ').replace(/\\/g, ' ');
    const commands = [...joined.matchAll(/\/usr\/bin\/systemctl [a-z-]+ [a-z.-]+/g)].map((m) => m[0]).sort();
    expect(commands).toEqual([
      '/usr/bin/systemctl restart lk-bridge',
      '/usr/bin/systemctl start lk-bridge',
      '/usr/bin/systemctl status lk-bridge',
      '/usr/bin/systemctl stop lk-bridge',
    ]);
    expect(rules.filter((l) => l.startsWith('lkbridge'))).toEqual([
      'lkbridge ALL=(root) NOPASSWD: LKBRIDGE_SERVICE',
    ]);
    expect(joined).not.toMatch(/NOPASSWD: *ALL\b/); // never a blanket grant
    expect(joined).not.toMatch(/\*/); // no wildcard arguments
  });

  it.skipIf(!has('visudo', ['-V']))('is valid sudoers syntax (visudo -c)', () => {
    const r = spawnSync('visudo', ['-cf', join(deployDir, 'sudoers.lk-bridge')], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('systemd units', () => {
  const service = read('lk-bridge.service');

  it('runs the private Node 24 as lkbridge from the app directory with the env file', () => {
    expect(service).toMatch(/^User=lkbridge$/m);
    expect(service).toMatch(/^Group=lkbridge$/m);
    expect(service).toMatch(/^WorkingDirectory=\/opt\/lk-bridge\/app$/m);
    expect(service).toMatch(/^EnvironmentFile=\/etc\/lk-bridge\/lk-bridge\.env$/m);
    expect(service).toMatch(/^ExecStart=\/opt\/lk-bridge\/runtime\/node\/bin\/node dist\/server\.js$/m);
    expect(service).toMatch(/^Restart=on-failure$/m);
  });

  it('is hardened and can write only to /var/lib/lk-bridge', () => {
    for (const line of [
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'ReadWritePaths=/var/lib/lk-bridge',
    ]) {
      expect(service).toContain(`\n${line}\n`);
    }
    expect(service).toMatch(/^MemoryMax=\d+[MG]$/m);
  });

  it('waits longer than the engine drain (20 s) before killing the process', () => {
    const m = /^TimeoutStopSec=(\d+)$/m.exec(service);
    expect(Number(m?.[1])).toBeGreaterThan(20);
  });

  it('runs the nightly backup at 04:15 London time', () => {
    const timer = read('lk-bridge-backup.timer');
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 04:15:00 Europe\/London$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(read('lk-bridge-backup.service')).toMatch(
      /^ExecStart=\/opt\/lk-bridge\/app\/deploy\/backup\.sh nightly$/m,
    );
  });

  it.skipIf(!haveSystemdAnalyze)(
    'passes systemd-analyze verify (paths that only exist on the server stubbed)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'lkb-units-'));
      try {
        for (const f of ['lk-bridge.service', 'lk-bridge-backup.service', 'lk-bridge-backup.timer']) {
          copyFileSync(join(deployDir, f), join(dir, f));
        }
        // The Node binary and the checkout exist only on the server; point those two at /bin/true.
        for (const [f, from] of [
          ['lk-bridge.service', '/opt/lk-bridge/runtime/node/bin/node'],
          ['lk-bridge-backup.service', '/opt/lk-bridge/app/deploy/backup.sh'],
        ] as const) {
          writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8').replace(from, '/bin/true'));
        }
        const r = spawnSync(
          'systemd-analyze',
          [
            'verify',
            '--man=no',
            ...['lk-bridge.service', 'lk-bridge-backup.service', 'lk-bridge-backup.timer'].map((f) =>
              join(dir, f),
            ),
          ],
          { encoding: 'utf8' },
        );
        // Other units on the machine (CI runners have some) may warn about themselves; only our own matter.
        const ours = (r.stdout + r.stderr).split('\n').filter((l) => l.includes('lk-bridge'));
        expect(ours).toEqual([]);
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('Caddyfile.lk-bridge', () => {
  const text = read('Caddyfile.lk-bridge');
  const directives = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  it('is one site block that proxies to the loopback port with flushing on', () => {
    expect(directives[0]).toBe('lk.ottomoons.co.uk {');
    expect(directives).toContain('reverse_proxy 127.0.0.1:8787 {');
    expect(directives).toContain('flush_interval -1');
    expect(directives.filter((d) => d.endsWith('{'))).toHaveLength(2);
  });

  it('adds no redirect, rewrite, compression or header directive', () => {
    for (const forbidden of [
      'redir',
      'rewrite',
      'handle_path',
      'uri',
      'try_files',
      'encode',
      'header',
      'file_server',
    ]) {
      expect(
        directives.filter((d) => d === forbidden || d.startsWith(`${forbidden} `)),
        forbidden,
      ).toEqual([]);
    }
  });
});

describe('migrate-to-build-user.sh: the GitHub check (v1.0.1 hotfix)', () => {
  const migrate = read('migrate-to-build-user.sh');
  const deploy = read('deploy.sh');
  const block = /# >>> github check[^\n]*\n([\s\S]*?)# <<< github check/.exec(migrate)![1]!;

  /**
   * A stand-in GitHub on a temporary directory: `ssh` answers `-T` exactly like GitHub (the success message on stderr
   * and exit status 1) and serves a local bare repository to git's upload-pack request; `runuser` just runs the
   * command (no second user is needed). The stub ssh sits first on the check's PATH (the private Node's bin), as the
   * private Node would. `mode: 'deny'` makes ssh refuse the key, as GitHub does.
   */
  function stubGithub(mode: 'ok' | 'deny') {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-gh-'));
    const run = (cmd: string, args: string[], cwd?: string) => {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
    };
    run('git', ['init', '-q', join(dir, 'src')]);
    writeFileSync(join(dir, 'src', 'README'), 'x');
    run('git', ['-C', join(dir, 'src'), 'add', 'README']);
    run('git', [
      '-C',
      join(dir, 'src'),
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      'commit',
      '-qm',
      'one',
    ]);
    run('git', ['clone', '-q', '--bare', join(dir, 'src'), join(dir, 'LK-Bridge.git')]);
    const nodeBin = join(dir, 'node', 'bin');
    const stubs = join(dir, 'stubs');
    run('mkdir', ['-p', nodeBin, stubs, join(dir, 'home')]);
    writeFileSync(
      join(nodeBin, 'ssh'),
      [
        '#!/bin/bash',
        `printf '%s\\n' "$*" >> '${join(dir, 'ssh-args.log')}'`,
        mode === 'deny'
          ? 'echo "git@github.com: Permission denied (publickey)." >&2; exit 255'
          : `for a; do case "$a" in git-upload-pack*) exec git upload-pack '${join(dir, 'LK-Bridge.git')}' ;; esac; done`,
        'echo "Hi Airwolf1221/LK-Bridge! You\'ve successfully authenticated, but GitHub does not provide shell access." >&2',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    // runuser -u USER -- CMD...: runs CMD as the current user.
    writeFileSync(join(stubs, 'runuser'), '#!/bin/bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
    return { dir, nodeBin, stubs, args: () => readFileSync(join(dir, 'ssh-args.log'), 'utf8') };
  }

  /** Runs the script's own check block under `set -euo pipefail`, as the script does. */
  function runCheck(gh: ReturnType<typeof stubGithub>, extra = 'github_ok') {
    return spawnSync('bash', ['-c', `set -euo pipefail\n${block}\n${extra}`], {
      encoding: 'utf8',
      env: {
        PATH: `${gh.stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        LKB_NODE_DIR: join(gh.dir, 'node'),
        B: 'lkbuild',
        B_HOME: join(gh.dir, 'home'),
        remote: 'git@github.com:Airwolf1221/LK-Bridge.git',
      },
    });
  }

  it('passes when ssh -T exits 1 with the success message and git ls-remote succeeds', () => {
    const gh = stubGithub('ok');
    try {
      // The stub behaves like GitHub: `ssh -T` reports success on stderr with exit status 1 ...
      const t = spawnSync(join(gh.nodeBin, 'ssh'), ['-T', 'git@github.com'], { encoding: 'utf8' });
      expect(t.status).toBe(1);
      expect(t.stderr).toMatch(/successfully authenticated/);
      // ... which is why the old check (a pipe into grep under pipefail) always failed:
      const old = runCheck(
        gh,
        `ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -q 'successfully authenticated'`,
      );
      expect(old.status).not.toBe(0);
      // The check now passes, through git's own SSH, with the deploy's options.
      const r = runCheck(gh);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // git ran ssh with the deploy's options (git may add its own, such as -o SendEnv=GIT_PROTOCOL, between them).
      const fetchLine = gh
        .args()
        .split('\n')
        .find((l) => l.includes('git-upload-pack'));
      expect(fetchLine).toMatch(/^-o BatchMode=yes -o ConnectTimeout=15 /);
      expect(fetchLine).toMatch(/git@github\.com git-upload-pack 'Airwolf1221\/LK-Bridge\.git'$/);
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });

  it("fails when git ls-remote fails, and prints git's own error", () => {
    const gh = stubGithub('deny');
    try {
      const r = runCheck(gh);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /git ls-remote git@github\.com:Airwolf1221\/LK-Bridge\.git HEAD, run as lkbuild, failed:/,
      );
      expect(r.stderr).toMatch(/Permission denied \(publickey\)/);
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });

  it('uses exactly the environment deploy.sh uses for git as the build user', () => {
    const def = (text: string, name: string) => new RegExp(`^${name}=.*$`, 'm').exec(text)?.[0];
    for (const name of ['node_path', 'git_ssh_command']) {
      expect(def(block, name), name).toBeDefined();
      expect(def(block, name), name).toBe(def(deploy, name));
    }
    const envOf = (text: string) =>
      /-- (env -i HOME="\$build_home"[\s\S]*?bash -c 'umask 022 && cd "\$1" && shift && exec "\$@"')/.exec(
        text,
      )?.[1];
    const asBuild = /as_build\(\) \{[\s\S]*?\n\}/.exec(deploy)![0];
    expect(envOf(block)).toBeDefined();
    expect(envOf(block)).toBe(envOf(asBuild));
    expect(envOf(asBuild)).toMatch(/GIT_SSH_COMMAND="\$git_ssh_command"/);
  });

  it('nothing in deploy/ or the runbook relies on the exit status of ssh -T', () => {
    for (const name of scripts) {
      const code = read(name)
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code, name).not.toMatch(/ssh\b[^\n]*\s-T\b/);
    }
    const runbook = readFileSync(new URL('../../docs/runbook-deploy.md', import.meta.url), 'utf8');
    for (const line of runbook.split('\n').filter((l) => /ssh\b.*\s-T\b/.test(l))) {
      expect(line, line).not.toMatch(/&&|\|\||; *then|\bif\b/);
    }
  });
});
