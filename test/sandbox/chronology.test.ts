/**
 * v2 D1 (ADR 0038), opt-in and READ-ONLY: the calendar engine and the chronology on the real test world, every age
 * (test/sandbox/chronology.ts). Runs with `npm run test:sandbox` when LKB_SANDBOX_PROJECT names the sandbox project (on
 * the server, `deploy/sandbox-test.sh --project test`); `npm run test:sandbox -- chronology` runs it alone. The same
 * guard as the other sandbox tests (a registered sandbox project, its own key). It writes nothing.
 *
 * Two date styles (v2 D1.1, ADR 0039): LegendKeeper writes a year with no thousands separator on events (`AA 1988119`);
 * the tables write one (`AA 1,988,119`). The report compares event text in LegendKeeper's style and table cells in the
 * table style, so the separator alone is never a failure (the owner's run of 11 November 2026 had 242 of those). Drift
 * between the tables and the timelines is reported under its own heading, apart from the engine's failures: the test
 * fails on the engine's and structure's failures only.
 *
 * The chronology resource is the one the owner confirmed on the dashboard (the bridge's stored settings), else
 * LKB_CHRONOLOGY_RESOURCE, else the test world's Universal Chronology (`h0gczxh7`, PLAN-v2 section 2).
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runChronologySandbox } from './chronology.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

/** The confirmed chronology resource of the project in the bridge's database, if any. */
function storedResource(projectId: string): string | null {
  const path = process.env.DB_PATH ?? './data/bridge.db';
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT settings FROM projects WHERE id = ?').get(projectId) as
      { settings?: string } | undefined;
    const s = row?.settings
      ? (JSON.parse(row.settings) as { chronology?: { resourceId?: string }; chronologyResourceId?: string })
      : {};
    return s.chronology?.resourceId ?? s.chronologyResourceId ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: the calendar engine and the chronology (read-only)',
  () => {
    it('reads every age table and timeline and checks them against the engine', async () => {
      const target = resolveSandboxTarget(projectName);
      const resourceId =
        storedResource(target.projectId) ?? process.env.LKB_CHRONOLOGY_RESOURCE ?? 'h0gczxh7';
      const sandbox = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const report = await runChronologySandbox({
          resourceId,
          read: (op, params) =>
            sandbox.runtime.engine.internalRead(sandbox.projectId, op, params, {
              priority: 'P2',
              notFoundIsAnswer: true,
            }),
        });
        process.stdout.write(`${report.text}\n`);
        process.stdout.write(
          `requests: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport)\n`,
        );
        process.stdout.write(
          `drift between the tables and the timelines: ${report.drift.length} finding${report.drift.length === 1 ? '' : 's'}\n`,
        );
        expect(sandbox.counters.writes).toBe(0);
        expect(report.failures, report.text).toEqual([]);
      } finally {
        await sandbox.close();
      }
    }, 900_000);
  },
);
