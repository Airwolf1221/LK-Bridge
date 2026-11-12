/**
 * The owner's full sandbox run of 12 November 2026: all five sandbox files failed in their first second with
 * `EACCES: mkdir '/opt/lk-bridge/app/data/images/upload-tmp'`. `createSoakRuntime` passed the default tool settings
 * (`images.dataDir: null`, "`images/` next to the database"), and the runtime resolved "the database" from the config's
 * default path, relative to the working directory (the app folder, owned by the build user), not from the temporary
 * database it was really given. The live bridge (`/var/lib/lk-bridge`) was unaffected, and CI did not notice because its
 * working directory is writable.
 *
 * This runs test/sandbox/soak-runtime-readonly.test.ts (the inner half) under Node's permission model, as
 * test/tools/sandbox-config-readonly.test.ts does for the loader: every file write outside one temporary directory is
 * refused (`--permission`, which holds even for root, where a read-only directory would not), so the working directory
 * IS a read-only app folder. The inner half first proves the harness refuses a write there, then builds the sandbox
 * runtime and the real boot path with default settings, and checks neither tries to create anything outside it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const vitestBin = join(root, 'node_modules/vitest/vitest.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'lkb-sandbox-runtime-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the sandbox runtime with a read-only app folder', () => {
  it('starts, and creates no folder outside its own temporary directory', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: scratch,
      NO_COLOR: '1',
      CI: '1',
      LKB_FS_RESTRICTED: '1',
    };
    for (const k of [
      'LKB_SANDBOX_PROJECT',
      'LKB_ENV_FILE',
      'VITEST',
      'VITEST_WORKER_ID',
      'VITEST_POOL_ID',
      'GITHUB_ACTIONS',
      'GITHUB_STEP_SUMMARY',
      'SECRETS_MASTER_KEY',
      'DB_PATH',
      'IMAGE_DATA_DIR',
    ])
      delete env[k];
    const r = spawnSync(
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
        'run',
        '--config',
        'vitest.sandbox.config.ts',
        '--configLoader',
        'runner',
        'test/sandbox/soak-runtime-readonly.test.ts',
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 150_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toMatch(/EACCES|mkdir .*upload-tmp/);
    // 3 inner tests ran (none skipped), and passed
    expect(out).toMatch(/3 passed/);
    expect(out).not.toMatch(/skipped/);
    expect(r.status, out).toBe(0);
    // and nothing was left under the app folder by the run
    expect(existsSync(join(root, 'data', 'images', 'upload-tmp'))).toBe(false);
  }, 180_000);
});
