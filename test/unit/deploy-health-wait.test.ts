/**
 * healthcheck.sh waits for the bridge before its first check (a check straight after a restart must not report false
 * failures): it retries /healthz every second for up to 30 s (--wait or LKB_HEALTH_WAIT), and prints one line saying how
 * long it waited. Run on the fake server (test/unit/deploy-fake-root.ts) with a curl stand-in that fails the first
 * calls to the loopback address, as a bridge that is still starting would.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeRoot, makeFakeRoot, repoDeployDir } from './deploy-fake-root.js';

let root: FakeRoot | undefined;
afterEach(() => {
  root?.cleanup();
  root = undefined;
});

/**
 * A curl that answers /healthz on 127.0.0.1 with {"ok":true} only from its `readyAt`-th call on (1 = at once); `0`
 * means never. Every other request fails, so only the local checks and the wait can pass.
 */
function fakeCurl(r: FakeRoot, readyAt: number): () => number {
  const counter = join(r.dir, 'healthz-calls');
  writeFileSync(counter, '0');
  writeFileSync(
    join(r.dir, 'stubs', 'curl'),
    [
      '#!/bin/bash',
      'url="${*: -1}"',
      'if [[ "$url" == http://127.0.0.1:*/healthz ]]; then',
      `  n=$(( $(cat '${counter}') + 1 )); echo "$n" > '${counter}'`,
      `  if (( ${readyAt} > 0 && n >= ${readyAt} )); then`,
      '    if [[ " $* " == *" --write-out "* ]]; then printf \'{"ok":true}\\n200\'; else printf \'{"ok":true}\'; fi',
      '    exit 0',
      '  fi',
      '  exit 7',
      'fi',
      'exit 7',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return () => Number(readFileSync(counter, 'utf8'));
}

function health(r: FakeRoot, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const started = Date.now();
  const res = spawnSync(join(repoDeployDir, 'healthcheck.sh'), ['--local-only', ...args], {
    encoding: 'utf8',
    env: { ...r.env, ...env },
    timeout: 60_000,
  });
  return { out: res.stdout, err: res.stderr, status: res.status, seconds: (Date.now() - started) / 1000 };
}

const waitLine = (out: string) => out.split('\n').filter((l) => /for the bridge|Did not wait/.test(l));
const check1 = (out: string) => out.split('\n').find((l) => /bridge answers on 127\.0\.0\.1/.test(l));

describe('healthcheck.sh waits for the bridge', () => {
  it('a bridge that is already up: one line, 0 s, no delay', () => {
    root = makeFakeRoot();
    const calls = fakeCurl(root, 1);
    const r = health(root);
    expect(waitLine(r.out)).toEqual(['Waited 0 s for the bridge to answer on 127.0.0.1:8787 (ready).']);
    expect(r.out.indexOf('Waited 0 s')).toBeLessThan(r.out.indexOf('PASS  bridge answers'));
    expect(check1(r.out)).toMatch(/^PASS /);
    expect(calls()).toBe(2); // the wait, then check 1
    expect(r.seconds).toBeLessThan(5);
  });

  it('a bridge that is still starting: retries every second, says how long it waited, and the first check passes', () => {
    root = makeFakeRoot();
    const calls = fakeCurl(root, 3); // answers from the third call
    const r = health(root);
    expect(waitLine(r.out)).toEqual(['Waited 2 s for the bridge to answer on 127.0.0.1:8787 (ready).']);
    expect(check1(r.out)).toMatch(/^PASS /);
    expect(calls()).toBe(4); // two failures, the call that answered, then check 1
    expect(r.seconds).toBeGreaterThanOrEqual(2);
  });

  it('a bridge that never answers: gives up after the wait (--wait), says so, and check 1 reports it', () => {
    root = makeFakeRoot();
    fakeCurl(root, 0);
    const r = health(root, ['--wait', '2']);
    expect(waitLine(r.out)).toEqual([
      'Waited 2 s for the bridge to answer on 127.0.0.1:8787; it did not (the checks below will say).',
    ]);
    expect(check1(r.out)).toMatch(/^FAIL /);
    expect(r.status).toBe(1);
    expect(r.seconds).toBeGreaterThanOrEqual(2);
    expect(r.seconds).toBeLessThan(15);
  });

  it('the wait is configurable with LKB_HEALTH_WAIT, and --wait overrides it', () => {
    root = makeFakeRoot();
    fakeCurl(root, 0);
    const viaEnv = health(root, [], { LKB_HEALTH_WAIT: '1' });
    expect(waitLine(viaEnv.out)[0]).toMatch(/^Waited 1 s .* it did not/);
    const flag = health(root, ['--wait', '0'], { LKB_HEALTH_WAIT: '20' });
    expect(waitLine(flag.out)).toEqual([
      'Did not wait for the bridge (--wait 0); it is not answering on 127.0.0.1:8787 yet.',
    ]);
    expect(flag.seconds).toBeLessThan(5);
  });

  it('uses the PORT of the env file', () => {
    root = makeFakeRoot();
    root.writeEnv('PORT=9911\n');
    const calls = fakeCurl(root, 1);
    const r = health(root);
    expect(waitLine(r.out)).toEqual(['Waited 0 s for the bridge to answer on 127.0.0.1:9911 (ready).']);
    expect(calls()).toBeGreaterThan(0);
  });

  it('refuses a wait that is not a whole number of seconds', () => {
    root = makeFakeRoot();
    fakeCurl(root, 1);
    for (const bad of ['abc', '-1', '1.5', '']) {
      const r = health(root, ['--wait', bad]);
      expect(r.status, bad).toBe(1);
      expect(r.err).toMatch(/--wait \(or LKB_HEALTH_WAIT\) must be a whole number of seconds/);
    }
  });
});
