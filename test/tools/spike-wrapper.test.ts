/**
 * deploy/spike-v2.sh (v2 phase 0): the same safety rules as the soak wrapper, checked by running it against a temporary
 * env file. It must read only the two sandbox variables, refuse to run against the project the bridge serves unless told
 * (`--allow-bridge-project`), put the report in the data directory, and never print a key.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileStamp, writeReportFiles } from '../sandbox/spike-report.js';

const wrapper = new URL('../../deploy/spike-v2.sh', import.meta.url).pathname;
const SANDBOX_KEY = 'sandbox-key-SECRET-1234';
const REAL_KEY = 'real-key-SECRET-5678';

let dir: string;
let nodeLog: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-spike-sh-'));
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

describe('deploy/spike-v2.sh', () => {
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
    expect(existsSync(nodeLog)).toBe(false); // it never got as far as running anything
  });

  it('with the flag it runs the spike with the report directory in the data directory, and the flag is not passed on', () => {
    const f = envFile('d.env', [
      `LK_SANDBOX_API_KEY=${SANDBOX_KEY}`,
      'LK_SANDBOX_PROJECT_ID=proj_test',
      `LK_API_KEY=${REAL_KEY}`,
      'LK_PROJECT_ID=proj_test',
    ]);
    const r = run(f, ['--allow-bridge-project', '--skip', '1', '--help']);
    expect(r.out).toMatch(/Spiking the project the bridge serves/);
    expect(r.out).toMatch(/usage: npm run spike:v2/); // --help reached the script
    expect(r.out).not.toContain(SANDBOX_KEY);
    expect(r.out).not.toContain(REAL_KEY);
    const logged = readFileSync(nodeLog, 'utf8');
    expect(logged).toContain(`--out-dir ${join(dir, 'data')}/spike`);
    expect(logged).toContain('--skip 1');
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
    expect(logged).not.toContain(`${join(dir, 'data')}/spike`);
  }, 30_000);
});

describe('the report files', () => {
  it('are named by UTC time and written next to each other, owner and group only', () => {
    const when = new Date('2026-11-09T14:05:09.123Z');
    expect(fileStamp(when)).toBe('20261109-140509');
    const out = join(dir, 'reports', 'spike');
    const files = writeReportFiles(out, when, '# report', { calendar: { id: 'c' } });
    expect(files).toEqual([
      join(out, 'spike-v2-20261109-140509.md'),
      join(out, 'spike-v2-20261109-140509-oracle.json'),
    ]);
    expect(readFileSync(files[0]!, 'utf8')).toBe('# report\n');
    expect(JSON.parse(readFileSync(files[1]!, 'utf8'))).toEqual({ calendar: { id: 'c' } });
    expect(writeReportFiles(join(dir, 'reports', 'two'), when, '# r', null)).toHaveLength(1);
  });
});
