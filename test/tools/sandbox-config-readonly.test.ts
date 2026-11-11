/**
 * C2d, Part 0 (the owner's first server run, 11 November 2026): `npm run test:sandbox` runs as the service user
 * (`lkbridge`), which cannot write to `node_modules` (it belongs to the build user, ADR 0020). Vite's default config
 * loader writes a bundled copy of `vitest.sandbox.config.ts` to `node_modules/.vite-temp` and failed with EACCES; the
 * transformed-module cache wrote to `node_modules/.vitest-cache`.
 *
 * This runs the sandbox command exactly as `package.json` spells it, under Node's permission model with every file
 * write outside one temporary directory refused (`--permission`, which holds even for root, where a read-only
 * directory would not), and checks it starts, loads the config and skips its suites (no project named). The control
 * run, without `--configLoader runner`, must be refused at `.vite-temp`, which proves the harness really refuses writes.
 * The soak, spike and round-trip wrappers run `tsx` with no TypeScript config (tsx caches in the system's temporary
 * directory), so only this script needs the flag.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const vitestBin = join(root, 'node_modules/vitest/vitest.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'lkb-sandbox-readonly-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The `test:sandbox` script's vitest arguments, as package.json gives them. */
function sandboxArgs(): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts['test:sandbox']!;
  const words = script.trim().split(/\s+/);
  expect(words[0]).toBe('vitest');
  return words.slice(1);
}

/** Runs vitest with `args` where only `scratch` may be written. */
function runRestricted(args: readonly string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch, NO_COLOR: '1', CI: '1' };
  delete env.LKB_SANDBOX_PROJECT; // the suites must skip: nothing is sent anywhere
  delete env.LKB_ENV_FILE;
  delete env.VITEST; // a nested run, not a worker of this one
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  return spawnSync(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=*',
      `--allow-fs-write=${scratch}`,
      '--allow-worker',
      '--allow-child-process',
      '--allow-addons',
      '--no-warnings',
      vitestBin,
      ...args,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 90_000 },
  );
}

describe('the sandbox command with a read-only node_modules', () => {
  it('package.json loads the sandbox config with the runner loader', () => {
    const args = sandboxArgs();
    expect(args).toContain('--config');
    expect(args[args.indexOf('--config') + 1]).toBe('vitest.sandbox.config.ts');
    expect(args[args.indexOf('--configLoader') + 1]).toBe('runner');
  });

  it('the sandbox config switches off the file-system caches', async () => {
    const file = pathToFileURL(join(root, 'vitest.sandbox.config.ts')).href;
    const cfg = ((await import(file)) as { default: unknown }).default as {
      test: { fsModuleCache?: boolean; cache?: boolean };
    };
    expect(cfg.test.fsModuleCache).toBe(false);
    expect(cfg.test.cache).toBe(false);
  });

  it('starts, loads the config and skips its suites without writing outside a temporary directory', () => {
    const r = runRestricted(sandboxArgs());
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toMatch(/ERR_ACCESS_DENIED|Access to this API has been restricted|EACCES/);
    expect(out).not.toMatch(/could not create .*vitest-cache/i);
    expect(out).toMatch(/skipped/);
    expect(r.status, out).toBe(0);
  }, 120_000);

  it('control: the default loader is refused at node_modules/.vite-temp (the harness does refuse writes)', () => {
    const args = sandboxArgs().filter(
      (a, i, all) => a !== '--configLoader' && all[i - 1] !== '--configLoader',
    );
    const r = runRestricted(args);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out).toMatch(/ERR_ACCESS_DENIED/);
    expect(out).toMatch(/\.vite-temp/);
  }, 120_000);
});
