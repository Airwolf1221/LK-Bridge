/**
 * `npm run soak:sandbox [-- --writes N] [-- --writers N]`: the sandbox soak (chunk 8). About 1,000 writes (or N) and a
 * matching mix of reads against the LegendKeeper SANDBOX project, through the real engine and governor, then a report:
 * total time, writes per minute, 429 responses (target zero), retries, budget waits and peak memory.
 *
 * Needs LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID in the environment (on the server, deploy/soak-sandbox.sh reads
 * them from the env file, and refuses when the sandbox project is the bridge's own unless told otherwise). It refuses to
 * run unless the key's own project is exactly LK_SANDBOX_PROJECT_ID. It uses a temporary database and cleans up.
 * Exit code: 0 when the report passes, 1 when it fails, 2 when it refused to run.
 */
import { SandboxGuardError } from '../test/sandbox/smoke.js';
import { createSoakRuntime, formatSoakReport, runSoak } from '../test/sandbox/soak.js';

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
      'usage: npm run soak:sandbox -- [--writes N (8-5000, default 1000)] [--writers N (1-8, default 2)]\n',
    );
    return;
  }
  const writes = argValue('--writes', 1000, 8, 5000);
  const writers = argValue('--writers', 2, 1, 8);
  const key = process.env.LK_SANDBOX_API_KEY;
  const project = process.env.LK_SANDBOX_PROJECT_ID;
  if (!key || !project) {
    process.stderr.write(
      'LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID must be set (sandbox project only). On the server use deploy/soak-sandbox.sh.\n',
    );
    process.exit(2);
  }
  const soak = createSoakRuntime({ apiKey: key, projectId: project, writersMax: writers });
  let code: number;
  try {
    process.stdout.write(
      `Soak: about ${writes} writes with ${writers} writer(s) against the sandbox project.\n`,
    );
    const report = await runSoak(
      { engine: soak.runtime.engine, lk: soak.runtime.lk, projectId: project, counters: soak.counters },
      project,
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
