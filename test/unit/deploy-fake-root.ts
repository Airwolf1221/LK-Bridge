/**
 * A fake server for the deploy-script tests (OPS1): the /opt/lk-bridge, /etc/lk-bridge and /var/lib/lk-bridge layout
 * under a temporary directory, so env-sync.sh and deploy.sh run end to end without real users, systemd or a network.
 *
 * - `bin/` holds the INSTALLED copies of deploy.sh, lib.sh, env-sync.sh and env-sync.mjs (from the repository).
 * - `node/bin/node` stands in for the private Node 24 (it answers `--version` with v24 and runs this Node otherwise);
 *   `node/bin/npm` stands in for npm (`ci` does nothing, `run build` copies the stub build out of the checkout).
 * - `runas` replaces `runuser -u USER --`: it runs the command as the current user (LKB_RUNAS, the scripts' test seam).
 * - `stubs/` holds curl and systemctl stand-ins that log what they were asked.
 * - The built bridge's configuration check is a stub (`dist/config/check.js`): it reports `issue: NAME: invalid` for
 *   every `NAME=invalid` line and requires SESSION_SECRET to be at least 32 characters. The real one is tested in
 *   test/unit/config-check.test.ts.
 *
 * Every run goes through `run()`, which fails the test if any test secret, or any value env-sync generated, appears in
 * stdout or stderr.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

export const repoDeployDir = new URL('../../deploy/', import.meta.url).pathname;
export const INSTALLED = ['deploy.sh', 'lib.sh', 'env-sync.sh', 'env-sync.mjs'] as const;

/** Values that must never appear in any output. Each is distinctive, so a leak cannot hide in other text. */
export const SECRETS = {
  key: 'TESTKEY-lk-api-key-0123456789abcdefXYZ',
  key2: 'TESTKEY2-second-project-key-9876543210',
  sandbox: 'TESTSANDBOX-sandbox-key-55555555555555',
  hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$TESTHASHaGFzaGhhc2hoYXNo',
  session: 'TESTSESSION-0123456789-0123456789-0123456789',
  jwt: 'TESTJWT-abcdefghij-abcdefghij-abcdefghij-abcd',
  totp: 'TESTTOTPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  old: 'TESTOLD-a-removed-secret-value-1234567890',
} as const;

export const STUB_CHECK = `import { readFileSync } from 'node:fs';
const i = process.argv.indexOf('--file');
let text;
try { text = readFileSync(process.argv[i + 1], 'utf8'); } catch { console.log('config check: cannot read'); process.exit(2); }
const issues = [];
let session = '';
for (const line of text.split('\\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) continue;
  if (m[2] === 'invalid') issues.push('issue: ' + m[1] + ': invalid');
  if (m[1] === 'SESSION_SECRET') session = m[2];
}
if (session.length < 32) issues.push('issue: SESSION_SECRET: must be at least 32 characters');
for (const x of issues) console.log(x);
console.log(issues.length ? 'config check: FAILED' : 'config check: OK');
process.exit(issues.length ? 1 : 0);
`;

export const STUB_MIGRATE = `console.log('stub migrate: applied');\n`;

export interface FakeRoot {
  readonly dir: string;
  readonly bin: string;
  readonly app: string;
  readonly envFile: string;
  readonly env: NodeJS.ProcessEnv;
  /** Writes the live env file (mode 0640). */
  writeEnv(text: string): void;
  readEnv(): string;
  /** The backups env-sync made, oldest first. */
  backups(): string[];
  /** What the systemctl stand-in was asked, one action per line. */
  systemctlLog(): string;
  cleanup(): void;
}

/** Values env-sync generated in `text` (SESSION_SECRET and JWT_SIGNING_KEY lines that are not test secrets). */
export function generatedValues(text: string): string[] {
  const known = new Set<string>(Object.values(SECRETS));
  return [...text.matchAll(/^(?:SESSION_SECRET|JWT_SIGNING_KEY|[A-Z_]*GENERATED[A-Z_]*)=(.+)$/gm)]
    .map((m) => m[1] ?? '')
    .filter((v) => v !== '' && !known.has(v));
}

export function makeFakeRoot(o: { template?: string; checkScript?: string } = {}): FakeRoot {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-fake-root-'));
  chmodSync(dir, 0o755);
  const bin = join(dir, 'bin');
  const app = join(dir, 'app');
  const etc = join(dir, 'etc');
  const nodeBin = join(dir, 'node', 'bin');
  const stubs = join(dir, 'stubs');
  for (const d of [
    bin,
    join(app, 'deploy'),
    join(app, 'dist', 'config'),
    nodeBin,
    stubs,
    join(dir, 'data'),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
  }
  mkdirSync(etc, { mode: 0o750 });
  chmodSync(etc, 0o750);
  for (const f of INSTALLED) {
    copyFileSync(join(repoDeployDir, f), join(bin, f));
    chmodSync(join(bin, f), f.endsWith('.sh') && f !== 'lib.sh' ? 0o755 : 0o644);
  }
  writeFileSync(
    join(nodeBin, 'node'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.99.0; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'runas'),
    '#!/bin/bash\n# runas USER -- CMD...: runs CMD as the current user\nshift 2\nexec "$@"\n',
    {
      mode: 0o755,
    },
  );
  writeFileSync(join(stubs, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(stubs, 'systemctl'),
    `#!/bin/sh\necho "$*" >> '${join(dir, 'systemctl.log')}'\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(app, 'deploy', 'env.template'),
    o.template ?? readFileSync(join(repoDeployDir, 'env.template'), 'utf8'),
  );
  writeFileSync(join(app, 'package.json'), '{ "name": "lk-bridge", "version": "9.9.9", "type": "module" }\n');
  writeFileSync(join(app, 'dist', 'config', 'check.js'), o.checkScript ?? STUB_CHECK);
  const envFile = join(etc, 'lk-bridge.env');
  const me = userInfo().username;
  const env: NodeJS.ProcessEnv = {
    PATH: `${stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? '/',
    LANG: 'C.UTF-8',
    LKB_ROOT: dir,
    LKB_NODE_DIR: join(dir, 'node'),
    LKB_RUNTIME_DIR: join(dir, 'node'),
    LKB_ENV_FILE: envFile,
    LKB_APP_DIR: app,
    LKB_BIN_DIR: bin,
    LKB_DATA_DIR: join(dir, 'data'),
    LKB_RUNAS: join(dir, 'runas'),
    LKB_SERVICE_USER: me,
    LKB_BUILD_USER: me,
    LKB_SUDO: '',
    LKB_SYSTEMCTL: join(stubs, 'systemctl'),
  };
  return {
    dir,
    bin,
    app,
    envFile,
    env,
    writeEnv(text) {
      writeFileSync(envFile, text, { mode: 0o640 });
      chmodSync(envFile, 0o640);
    },
    readEnv: () => readFileSync(envFile, 'utf8'),
    backups: () =>
      readdirSync(etc)
        .filter((f) => f.startsWith('lk-bridge.env.bak.'))
        .sort()
        .map((f) => join(etc, f)),
    systemctlLog: () =>
      existsSync(join(dir, 'systemctl.log')) ? readFileSync(join(dir, 'systemctl.log'), 'utf8') : '',
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface RunResult {
  status: number | null;
  out: string;
  err: string;
  all: string;
}

/**
 * Runs a script of the fake root and checks that no secret leaked into its output: every test secret, every value in
 * the env file before and after (other than names and the harmless ones listed), and every generated value.
 */
export function run(root: FakeRoot, script: string, args: string[] = [], input = ''): RunResult {
  const before = existsSync(root.envFile) ? root.readEnv() : '';
  const r = spawnSync(join(root.bin, script), args, {
    encoding: 'utf8',
    env: root.env,
    input,
    timeout: 60_000,
  });
  const after = existsSync(root.envFile) ? root.readEnv() : '';
  const all = `${r.stdout}\n${r.stderr}`;
  assertNoSecrets(all, [before, after]);
  return { status: r.status, out: r.stdout, err: r.stderr, all };
}

/** Fails if `output` contains any test secret, or any secret-shaped value found in `files`. */
export function assertNoSecrets(output: string, files: readonly string[] = []): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(output.includes(value), `secret ${name} leaked into the output`).toBe(false);
  }
  for (const text of files) {
    for (const v of generatedValues(text)) {
      expect(output.includes(v), 'a generated value leaked into the output').toBe(false);
    }
    for (const m of text.matchAll(/^#?\s*[A-Z_]*(?:KEY|SECRET|HASH|TOKEN|PASSWORD)[A-Z_]*=(.+)$/gm)) {
      const v = (m[1] ?? '').trim().replace(/^'(.*)'$/, '$1');
      if (v.length >= 8) expect(output.includes(v), 'a credential value leaked into the output').toBe(false);
    }
  }
}

/** Owner, group and permission bits of a file. */
export const ownership = (path: string) => {
  const s = statSync(path);
  return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
};

/** The shipped template with every secret and required value filled in: a live file that is in step. */
export function inStepEnv(
  root: FakeRoot,
  template = readFileSync(join(repoDeployDir, 'env.template'), 'utf8'),
): string {
  return template
    .split('\n')
    .filter((l) => !/^#\s*@/.test(l))
    .join('\n')
    .replace(/^LK_PROJECT_TEST_API_KEY=$/m, `LK_PROJECT_TEST_API_KEY=${SECRETS.key}`)
    .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${SECRETS.session}`)
    .replace(/^JWT_SIGNING_KEY=$/m, `JWT_SIGNING_KEY=${SECRETS.jwt}`)
    .replace(/^OWNER_PASSWORD_HASH=$/m, `OWNER_PASSWORD_HASH='${SECRETS.hash}'`)
    .replace(/^DB_PATH=.*$/m, `DB_PATH=${join(root.dir, 'data', 'bridge.db')}`);
}
