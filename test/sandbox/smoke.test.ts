/**
 * Opt-in: `npm run test:sandbox` with LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID set. Skipped otherwise. It talks to
 * a REAL LegendKeeper project and refuses to run against any project other than LK_SANDBOX_PROJECT_ID.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS, loadConfig } from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { createRuntime } from '../../src/runtime.js';
import { formatReport, runSmoke } from './smoke.js';

const key = process.env.LK_SANDBOX_API_KEY;
const project = process.env.LK_SANDBOX_PROJECT_ID;

describe.skipIf(!key || !project)('LegendKeeper sandbox smoke', () => {
  it('checks the open assumptions and walks every entity family', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-sandbox-'));
    const db = openDatabase(join(dir, 'bridge.db'));
    runMigrations(db);
    const config = loadConfig({
      BRIDGE_PUBLIC_URL: 'https://sandbox.invalid',
      LK_API_KEY: key!,
      LK_PROJECT_ID: project!,
      LK_READ_ONLY: 'false',
      LOG_LEVEL: 'warn',
      SESSION_SECRET: 'sandbox-only-session-secret-0123456789abcdef',
      JWT_SIGNING_KEY: 'sandbox-only-signing-key-0123456789abcdef',
      ...(process.env.LK_BASE_URL ? { LK_BASE_URL: process.env.LK_BASE_URL } : {}),
    });
    const runtime = createRuntime({ config, toolsSettings: DEFAULT_TOOLS_SETTINGS, db, version: 'sandbox' });
    try {
      const findings = await runSmoke(
        {
          engine: runtime.engine,
          lk: runtime.lk,
          projectId: config.lk.projectId,
          baseUrl: config.lk.baseUrl,
          apiKey: key!,
        },
        project!,
      );
      process.stdout.write(formatReport(findings));
      // The assumption checks (a, b) are reported either way; a broken family or a leftover fails the run.
      const broken = findings.filter((f) => f.verdict === 'fail' && !['a', 'b'].includes(f.id));
      expect(broken.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    } finally {
      await runtime.shutdown(1000);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
