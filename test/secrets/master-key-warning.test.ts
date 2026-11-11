/**
 * C2d, Part 0: only a runtime that keeps no secrets (`secretStore: 'unused'`, the sandbox scripts) is quiet about a
 * missing SECRETS_MASTER_KEY. The bridge itself still warns, twice (the configuration and the secret store).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS, loadConfig } from '../../src/config/index.js';
import { defaultMaintenanceSettings } from '../../src/config/maintenance.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { createRuntime } from '../../src/runtime.js';

async function warningsAbout(secretStore?: 'required' | 'unused'): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-mk-'));
  const db = openDatabase(join(dir, 'b.db'));
  runMigrations(db);
  const lines: string[] = [];
  const secret = () => randomBytes(32).toString('base64url');
  const runtime = createRuntime({
    config: loadConfig({
      BRIDGE_PUBLIC_URL: 'https://mk.invalid',
      LK_PROJECTS: 'test',
      LK_PROJECT_TEST_API_KEY: 'lk_not_a_real_key',
      LK_BASE_URL: 'http://127.0.0.1:9',
      SESSION_SECRET: secret(),
      JWT_SIGNING_KEY: secret(),
      LOG_LEVEL: 'warn',
    }),
    toolsSettings: DEFAULT_TOOLS_SETTINGS,
    db,
    version: 'test',
    instanceGuard: false,
    projectRetryMs: { first: 3_600_000, max: 3_600_000 },
    maintenanceSettings: defaultMaintenanceSettings({ enabled: false }),
    logLevel: 'warn',
    logStream: new Writable({
      write(chunk: Buffer, _e, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    }),
    ...(secretStore ? { secretStore } : {}),
  });
  await runtime.shutdown(100);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return lines.filter((l) => l.includes('SECRETS_MASTER_KEY'));
}

describe('SECRETS_MASTER_KEY warnings at start-up', () => {
  it('the bridge warns when the master key is missing', async () => {
    expect(await warningsAbout()).toHaveLength(2);
  });

  it('a runtime that keeps no secrets (the sandbox scripts) does not', async () => {
    expect(await warningsAbout('unused')).toEqual([]);
  });
});
