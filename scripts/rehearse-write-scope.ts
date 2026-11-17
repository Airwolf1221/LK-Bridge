/**
 * `npm run rehearse:write-scope -- --project NAME`: the write-scope rehearsal (v3 F3.4, ADR 0055 decision G) against a
 * LegendKeeper SANDBOX project, run by the owner before an agent's profile is raised to scope `write`. As a temporary
 * write-scoped agent it edits a sentence, changes a fact, fixes a chronology event and places a staged image (each a
 * direct write), checks a pack package is still a proposal, reverts the four writes and reads each target back, and
 * checks that a delete and an 11-page batch become proposals under the default rails; then it cleans up. It prints
 * PASS, FAIL, NOTED, INCONCLUSIVE or SKIPPED for each step (test/sandbox/write-scope.ts).
 *
 * As the soak: `--project` names a project registered in the bridge's database (DB_PATH) and marked as a sandbox there;
 * any other project is refused (test/sandbox/target.ts). Its key is found as the bridge finds it: the key in the
 * bridge's encrypted store, or, only when none is stored, the env file's LK_PROJECT_<NAME>_API_KEY (on the server,
 * deploy/rehearse-write-scope.sh passes the project, DB_PATH and the env file's path, never a key). It also refuses
 * unless the key's own project is exactly the registered one. It runs on a temporary database that starts as a
 * READ-ONLY copy of the project's settings, repository tree and setting packs from the bridge's database; it never
 * writes to the bridge's database, and it never reads another project.
 *
 * Exit code: 0 when no step failed, 1 when one did, 2 when it refused to run.
 */
import { SandboxGuardError } from '../test/sandbox/smoke.js';
import { createSoakRuntime, type SoakRuntime } from '../test/sandbox/soak.js';
import {
  keySourceLine,
  projectFlag,
  resolveSandboxTarget,
  type SandboxTarget,
} from '../test/sandbox/target.js';
import {
  copyBridgeState,
  formatRehearsalReport,
  runWriteScopeRehearsal,
} from '../test/sandbox/write-scope.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('usage: npm run rehearse:write-scope -- --project NAME (a sandbox project)\n');
    return;
  }
  let target: SandboxTarget;
  let soak: SoakRuntime | undefined;
  try {
    target = resolveSandboxTarget(projectFlag(process.argv.slice(2)));
    process.stderr.write(keySourceLine(target));
    soak = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    if (soak.projectId !== target.projectId)
      throw new SandboxGuardError(
        `Refusing to run: the key of project "${target.name}" belongs to another LegendKeeper project.`,
      );
    const copied = copyBridgeState({
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      target: soak.db,
      projectId: soak.projectId,
      runtime: soak.runtime,
    });
    process.stdout.write(
      `Copied from the bridge's database (read-only): ${copied.settings.length} settings, ${copied.treeNodes} repository tree nodes, packs: ${copied.packs.join(', ') || 'none'}.\n`,
    );
  } catch (e) {
    if (e instanceof SandboxGuardError) {
      process.stderr.write(`${e.message}\n`);
      await soak?.close();
      process.exit(2);
    }
    throw e;
  }
  let code: number;
  try {
    process.stdout.write(
      `Write-scope rehearsal against sandbox project "${target.name}": it writes, reverts, then cleans up.\n`,
    );
    const report = await runWriteScopeRehearsal(
      {
        runtime: soak.runtime,
        db: soak.db,
        projectId: soak.projectId,
        projectName: target.name,
        counters: soak.counters,
      },
      { log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`) },
    );
    process.stdout.write(formatRehearsalReport(report, soak.counters));
    code = report.passed ? 0 : 1;
  } catch (e) {
    if (e instanceof SandboxGuardError) {
      process.stderr.write(`${e.message}\n`);
      code = 2;
    } else throw e;
  } finally {
    await soak.close();
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
