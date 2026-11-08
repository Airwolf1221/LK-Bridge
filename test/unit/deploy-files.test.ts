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

  it('deploy.sh refuses to run as root and over a dirty checkout, and pulls fast-forward only', () => {
    const t = read('deploy.sh');
    expect(t).toMatch(/id -u/);
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
