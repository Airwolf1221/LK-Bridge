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
      'restore.sh', // chunk 8
      'migrate-to-build-user.sh', // v1.0.1
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

  it.skipIf(!haveShellcheck)('passes shellcheck', () => {
    const r = spawnSync('shellcheck', ['-x', ...scripts.map((s) => join(deployDir, s))], {
      encoding: 'utf8',
    });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

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
    expect(code).toMatch(/as_service env DB_PATH="\$db_path" node dist\/db\/migrate\.js/);
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
    const template = [
      '# A comment with NAME=value inside prose is not a variable',
      'LK_API_KEY=',
      'WRITERS_MAX=1',
      '# UPLOAD_MAX_BYTES=10485760',
      '# BRAND_NEW_OPTION=on',
      '',
    ].join('\n');
    const live = [
      "LK_API_KEY='the-real-secret-value'",
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
    expect(r.err).not.toMatch(/UPLOAD_MAX_BYTES|LK_API_KEY|NAME/);
    expect(r.err + r.out).not.toMatch(/the-real-secret-value|another-secret-value|10485760/);
  });

  it('is called by deploy.sh and healthcheck.sh', () => {
    expect(read('deploy.sh')).toMatch(/^env_drift_report /m);
    expect(read('healthcheck.sh')).toMatch(/env_drift_report /);
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
