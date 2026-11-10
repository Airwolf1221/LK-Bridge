/**
 * Opt-in: `npm run test:sandbox` with LKB_SANDBOX_PROJECT naming the sandbox project (on the server,
 * `deploy/sandbox-test.sh --project <name>` sets it, DB_PATH and LKB_ENV_FILE; the key is found as the bridge finds it,
 * in its encrypted store first, test/sandbox/target.ts). Skipped otherwise. It talks to a REAL
 * LegendKeeper project, and refuses to run unless the project is registered in the bridge's database (DB_PATH) and
 * marked as a sandbox there, and the key's own project is exactly the registered one (v2 A1, test/sandbox/target.ts).
 */
import { describe, expect, it } from 'vitest';
import { formatReport, runSmoke } from './smoke.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox smoke', () => {
  it('checks the open assumptions and walks every entity family', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sandbox = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    try {
      const findings = await runSmoke(
        {
          engine: sandbox.runtime.engine,
          lk: sandbox.lk,
          projectId: sandbox.projectId,
          baseUrl: sandbox.runtime.config.lk.baseUrl,
          apiKey: target.apiKey,
        },
        target.projectId,
      );
      process.stdout.write(formatReport(findings));
      // The assumption checks (a, b) are reported either way; a broken family or a leftover fails the run.
      const broken = findings.filter((f) => f.verdict === 'fail' && !['a', 'b'].includes(f.id));
      expect(broken.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    } finally {
      await sandbox.close();
    }
  });
});
