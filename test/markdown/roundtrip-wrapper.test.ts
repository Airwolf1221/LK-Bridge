/**
 * deploy/markdown-roundtrip.sh: the spike wrapper's rules, checked by running it against a temporary env file. It must
 * read only the two sandbox variables, refuse the project the bridge serves unless told (`--allow-bridge-project`), put
 * the report in the data directory, and never print a key.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const wrapper = new URL('../../deploy/markdown-roundtrip.sh', import.meta.url).pathname;
const SANDBOX_KEY = 'sandbox-key-SECRET-1234';
const REAL_KEY = 'real-key-SECRET-5678';

let dir: string;
let nodeLog: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-roundtrip-sh-'));
  // A "private Node" that reports v24 (the wrapper checks) and logs what it was asked to run, then runs the real one.
  mkdirSync(join(dir, 'node/bin'), { recursive: true });
  nodeLog = join(dir, 'node.log');
  writeFileSync(
    join(dir, 'node/bin/node'),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo v24.0.0; exit 0; fi\nprintf '%s\\n' "$*" >> '${nodeLog}'\nexec '${process.execPath}' "$@"\n`,
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

describe('deploy/markdown-roundtrip.sh', () => {
  it('refuses when the sandbox key or project is missing, without printing a key', () => {
    const noKey = run(envFile('a.env', ['LK_SANDBOX_PROJECT_ID=proj_test', `LK_API_KEY=${REAL_KEY}`]));
    expect(noKey.status).not.toBe(0);
    expect(noKey.out).toMatch(/LK_SANDBOX_API_KEY is empty/);
    const noProject = run(envFile('b.env', [`LK_SANDBOX_API_KEY=${SANDBOX_KEY}`]));
    expect(noProject.status).not.toBe(0);
    expect(noProject.out).toMatch(/LK_SANDBOX_PROJECT_ID is empty/);
    for (const r of [noKey, noProject]) {
      expect(r.out).not.toContain(SANDBOX_KEY);
      expect(r.out).not.toContain(REAL_KEY);
    }
  });

  it('refuses the project the bridge serves unless --allow-bridge-project is given', () => {
    const f = envFile('c.env', [
      `LK_SANDBOX_API_KEY=${SANDBOX_KEY}`,
      'LK_SANDBOX_PROJECT_ID=proj_test',
      `LK_API_KEY=${REAL_KEY}`,
      'LK_PROJECT_ID=proj_test',
    ]);
    const refused = run(f);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toMatch(/project the bridge serves/);
    expect(refused.out).toMatch(/--allow-bridge-project/);
    expect(refused.out).not.toContain(SANDBOX_KEY);
    expect(refused.out).not.toContain(REAL_KEY);
    expect(existsSync(nodeLog)).toBe(false);
  });

  it('with the flag it runs the round trip with the report directory in the data directory, and the flag is not passed on', () => {
    const f = envFile('d.env', [
      `LK_SANDBOX_API_KEY=${SANDBOX_KEY}`,
      'LK_SANDBOX_PROJECT_ID=proj_test',
      `LK_API_KEY=${REAL_KEY}`,
      'LK_PROJECT_ID=proj_test',
    ]);
    const r = run(f, ['--allow-bridge-project', '--max-pages', '5', '--help']);
    expect(r.out).toMatch(/Checking the project the bridge serves/);
    expect(r.out).toMatch(/usage: npm run roundtrip/); // --help reached the script
    expect(r.out).not.toContain(SANDBOX_KEY);
    expect(r.out).not.toContain(REAL_KEY);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).toContain(`--out-dir ${join(dir, 'data')}/roundtrip`);
    expect(logged).toContain('--max-pages 5');
    expect(logged).not.toContain('--allow-bridge-project');
  }, 30_000);

  it('keeps an --out-dir the owner gave', () => {
    const f = envFile('e.env', [
      `LK_SANDBOX_API_KEY=${SANDBOX_KEY}`,
      'LK_SANDBOX_PROJECT_ID=proj_test',
      'LK_PROJECT_ID=proj_other',
    ]);
    rmSync(nodeLog, { force: true });
    run(f, ['--out-dir', '/tmp/somewhere', '--help']);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).toContain('--out-dir /tmp/somewhere');
    expect(logged).not.toContain(`${join(dir, 'data')}/roundtrip`);
  }, 30_000);
});
