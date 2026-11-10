/**
 * deploy/markdown-roundtrip.sh (v2 B1, on A1's project mechanism): checked by running it against a temporary env file,
 * as deploy/spike-v2.sh is. It takes `--project <name>`, exports only DB_PATH and the env file's path (OPS2 hotfix: no
 * key; the script finds the key as the bridge does, test/unit/sandbox-wrappers.test.ts), passes the project on, puts
 * the report in the data directory, and never prints a key. There is no `--allow-bridge-project` and no LK_SANDBOX_*
 * any more. The refusal of a project that is not a registered sandbox is the script's own (resolveSandboxTarget;
 * test/unit/sandbox-target.test.ts), shown here end to end once.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const wrapper = new URL('../../deploy/markdown-roundtrip.sh', import.meta.url).pathname;
const TEST_KEY = 'test-key-SECRET-1234';
const REAL_KEY = 'real-key-SECRET-5678';

let dir: string;
let nodeLog: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-roundtrip-sh-'));
  // A "private Node" that reports v24 (the wrapper checks), logs what it was asked to run and the NAMES of the LK and
  // DB variables it was given (never a value), then runs the real one.
  mkdirSync(join(dir, 'node/bin'), { recursive: true });
  nodeLog = join(dir, 'node.log');
  writeFileSync(
    join(dir, 'node/bin/node'),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo v24.0.0; exit 0; fi\nprintf '%s\\n' "$*" >> '${nodeLog}'\nenv | grep -oE '^(LK_[A-Z0-9_]+|SECRETS_[A-Z0-9_]+|DB_PATH|LKB_ENV_FILE|LKB_SANDBOX_PROJECT)=' | sort | tr '\\n' ' ' >> '${nodeLog}'\necho >> '${nodeLog}'\nexec '${process.execPath}' "$@"\n`,
  );
  chmodSync(join(dir, 'node/bin/node'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envFile(name: string, lines: string[]): string {
  const f = join(dir, name);
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
}
function run(envPath: string, args: string[] = []) {
  const r = spawnSync('bash', [wrapper, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
      HOME: dir,
      LKB_ENV_FILE: envPath,
      LKB_NODE_DIR: join(dir, 'node'),
      LKB_DATA_DIR: join(dir, 'data'),
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const MULTI = [
  'LK_PROJECTS=arkona,test',
  `LK_PROJECT_ARKONA_API_KEY=${REAL_KEY}`,
  `LK_PROJECT_TEST_API_KEY=${TEST_KEY}`,
  'LK_DEFAULT_PROJECT=arkona',
];

describe('deploy/markdown-roundtrip.sh', () => {
  it('refuses without --project, with a malformed name, or without a readable env file, without printing a key', () => {
    rmSync(nodeLog, { force: true });
    const noProject = run(envFile('a.env', MULTI));
    expect(noProject.status).not.toBe(0);
    expect(noProject.out).toMatch(/--project <name>/);
    const bad = run(envFile('b.env', MULTI), ['--project', 'Not A Name']);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toMatch(/is not a project name/);
    // OPS2 hotfix: the wrapper reads no key (the script finds it, store first); it needs to read the env file.
    const noFile = run(join(dir, 'no-such.env'), ['--project', 'test']);
    expect(noFile.status).not.toBe(0);
    expect(noFile.out).toMatch(/Cannot read .*no-such\.env: run this as the service user/);
    for (const r of [noProject, bad, noFile]) {
      expect(r.out).not.toContain(TEST_KEY);
      expect(r.out).not.toContain(REAL_KEY);
    }
    expect(existsSync(nodeLog)).toBe(false); // it never got as far as running anything
  });

  it('runs the round trip for the named project, exporting no key, the report in the data directory', () => {
    rmSync(nodeLog, { force: true });
    const r = run(envFile('d.env', [...MULTI, 'DB_PATH=/var/lib/lk-bridge/bridge.db']), [
      '--project',
      'test',
      '--max-pages',
      '5',
      '--help',
    ]);
    expect(r.out).toMatch(/usage: npm run roundtrip -- --project NAME/); // --help reached the script
    expect(r.out).not.toContain(TEST_KEY);
    expect(r.out).not.toContain(REAL_KEY);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).toContain('--project test');
    expect(logged).toContain(`--out-dir ${join(dir, 'data')}/roundtrip`);
    expect(logged).toContain('--max-pages 5');
    // OPS2 hotfix: only DB_PATH and the env file's path were exported, never a key (the script finds the key as the
    // bridge does: test/unit/sandbox-wrappers.test.ts).
    expect(logged).not.toMatch(/LK_PROJECT_[A-Z0-9_]+_API_KEY=/);
    expect(logged).toContain('LKB_ENV_FILE=');
    expect(logged).toContain('DB_PATH=');
    expect(logged).not.toMatch(/LK_SANDBOX_/);
    expect(logged).not.toContain('--allow-bridge-project');
  }, 30_000);

  it('exports no key in the single-project form either (the script reads LK_API_KEY from the file when needed)', () => {
    rmSync(nodeLog, { force: true });
    run(envFile('e.env', [`LK_API_KEY=${TEST_KEY}`, 'LK_PROJECT_ID=proj_test']), [
      '--project',
      'test',
      '--help',
    ]);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).not.toContain('LK_API_KEY=');
    expect(logged).toContain('LKB_ENV_FILE=');
    expect(logged).not.toContain(TEST_KEY);
  }, 30_000);

  it('keeps an --out-dir the owner gave', () => {
    rmSync(nodeLog, { force: true });
    run(envFile('f.env', MULTI), ['--project=test', '--out-dir', '/tmp/somewhere', '--help']);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).toContain('--out-dir /tmp/somewhere');
    expect(logged).not.toContain(`${join(dir, 'data')}/roundtrip`);
  }, 30_000);

  it('the script refuses a project the bridge has not registered as a sandbox, before any request', () => {
    // No bridge database at DB_PATH: nothing is registered, so nothing may be read.
    const r = run(envFile('g.env', [...MULTI, `DB_PATH=${join(dir, 'no-such.db')}`]), ['--project', 'test']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/There is no bridge database/);
    expect(r.out).not.toContain(TEST_KEY);
    expect(r.out).not.toContain(REAL_KEY);
  }, 30_000);
});
