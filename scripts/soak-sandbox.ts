/**
 * `npm run soak:sandbox -- --project NAME [--writes N] [--writers N]`: the sandbox soak (chunk 8). About 1,000 writes
 * (or N) and a matching mix of reads against a LegendKeeper SANDBOX project, through the real engine and governor, then
 * a report: total time, writes per minute, 429 responses (target zero), retries, budget waits and peak memory.
 *
 * v2 A1: `--project` names a project registered in the bridge's database (DB_PATH) and marked as a sandbox there; any
 * other project is refused (test/sandbox/target.ts). Its key is found as the bridge finds it:
 * the key in the bridge's encrypted store (OPS2), or, only when none is stored, the env file's LK_PROJECT_<NAME>_API_KEY
 * (on the server, deploy/soak-sandbox.sh passes the project, DB_PATH and the env file's path, never a key). It also
 * refuses unless the key's own project is exactly the registered one. It uses a temporary database and cleans up.
 * Exit code: 0 when the report passes, 1 when it fails, 2 when it refused to run.
 */
import { SandboxGuardError } from '../test/sandbox/smoke.js';
import { createSoakRuntime, formatSoakReport, runSoak } from '../test/sandbox/soak.js';
import { keySourceLine, projectFlag, resolveSandboxTarget } from '../test/sandbox/target.js';

function argValue(name: string, fallback: number, min: number, max: number): number {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return fallback;
  const raw = args[i]!.includes('=') ? args[i]!.split('=')[1] : args[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    process.stderr.write(`${name} must be a whole number from ${min} to ${max}\n`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'usage: npm run soak:sandbox -- --project NAME [--writes N (8-5000, default 1000)] [--writers N (1-8, default 2)]\n',
    );
    return;
  }
  const writes = argValue('--writes', 1000, 8, 5000);
  const writers = argValue('--writers', 2, 1, 8);
  let target;
  let soak;
  try {
    target = resolveSandboxTarget(projectFlag(process.argv.slice(2)));
    process.stderr.write(keySourceLine(target));
    soak = await createSoakRuntime({ apiKey: target.apiKey, project: target.name, writersMax: writers });
  } catch (e) {
    if (e instanceof SandboxGuardError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  let code: number;
  try {
    process.stdout.write(
      `Soak: about ${writes} writes with ${writers} writer(s) against sandbox project "${target.name}".\n`,
    );
    const report = await runSoak(
      { engine: soak.runtime.engine, lk: soak.lk, projectId: soak.projectId, counters: soak.counters },
      target.projectId,
      { writes, log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`) },
    );
    process.stdout.write(formatSoakReport(report));
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
