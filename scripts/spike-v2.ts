/**
 * `npm run spike:v2 [-- flags]`: the v2 phase 0 spike (docs/PLAN-v2.md, section 6, session 0). Ten checks of the plan's
 * assumptions against the LegendKeeper TEST WORLD, through the real engine and governor at priority P3. Only check 1
 * writes, and only under one throwaway root resource that is deleted (cascade) at the end, even after a failure.
 *
 * v2 A1: `--project NAME` names a project registered in the bridge's database (DB_PATH) and marked as a sandbox there;
 * any other project is refused (test/sandbox/target.ts). Its key is the bridge's own variable for it,
 * LK_PROJECT_<NAME>_API_KEY (on the server, deploy/spike-v2.sh reads just that one from the env file). It also refuses
 * unless the key's own project is exactly the registered one, uses a temporary database, and never prints a secret.
 *
 * Output: the Markdown report on stdout (progress goes to stderr), and the same report written to
 * <out-dir>/spike-v2-<timestamp>.md, with the calendar oracle beside it as spike-v2-<timestamp>-oracle.json.
 * Exit code: 0 when the report was produced, 1 when the clean-up failed or the report could not be written, 2 when the
 * script refused to run.
 */
import { mkdirSync } from 'node:fs';
import { formatReport, writeReportFiles } from '../test/sandbox/spike-report.js';
import { DEFAULT_SPIKE_IDS, runSpike, type SpikeIds } from '../test/sandbox/spike-v2.js';
import { SandboxGuardError } from '../test/sandbox/smoke.js';
import { createSoakRuntime } from '../test/sandbox/soak.js';
import { resolveSandboxTarget } from '../test/sandbox/target.js';

const USAGE = `usage: npm run spike:v2 -- --project NAME [flags]
  --project NAME          the sandbox project (registered by the bridge and marked as a sandbox)
  --root ID               AI REPOSITORY root resource        (default ${DEFAULT_SPIKE_IDS.root})
  --chronology ID         Universal Chronology resource      (default ${DEFAULT_SPIKE_IDS.chronology})
  --main-doc ID           its Main page document             (default ${DEFAULT_SPIKE_IDS.mainDoc})
  --table-doc ID          its Fourth Arkonan Age table page  (default ${DEFAULT_SPIKE_IDS.tableDoc})
  --timeline-doc ID       its Fourth Arkonan Age timeline    (default ${DEFAULT_SPIKE_IDS.timelineDoc})
  --calendar ID           the calendar                       (default ${DEFAULT_SPIKE_IDS.calendar})
  --rare-query TEXT       check 2's rare query               (default: a word found in exactly one resource name)
  --common-query TEXT     check 2's very common word         (default: the)
  --skip N[,N...]         leave these checks out (1-10); --skip 1 makes the whole run read-only
  --out-dir DIR           where the report is written        (default /var/lib/lk-bridge/spike)
  --sample-lines N        longest fenced sample, in lines    (default 40)
  --max-asset-lists N     most listAssets calls in the walk  (default 600)
  --max-asset-bytes N     largest asset body fetched         (default 26214400)
  --max-event-pages N     extra event pages to find shapes   (default 8)
`;

const VALUE_FLAGS = new Set([
  '--project',
  '--root',
  '--chronology',
  '--main-doc',
  '--table-doc',
  '--timeline-doc',
  '--calendar',
  '--rare-query',
  '--common-query',
  '--skip',
  '--out-dir',
  '--sample-lines',
  '--max-asset-lists',
  '--max-asset-bytes',
  '--max-event-pages',
]);

function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!VALUE_FLAGS.has(name)) fail(`unknown flag ${name}\n${USAGE}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') fail(`${name} needs a value`);
    out.set(name, value);
  }
  return out;
}
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
function whole(flags: Map<string, string>, name: string, fallback: number, min: number, max: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const flags = parseArgs(process.argv.slice(2));
  let target;
  try {
    target = resolveSandboxTarget(flags.get('--project'));
  } catch (e) {
    if (e instanceof SandboxGuardError) fail(e.message);
    throw e;
  }
  const project = target.projectId;
  const skip = new Set<number>();
  for (const part of (flags.get('--skip') ?? '').split(',').filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 10)
      fail('--skip takes check numbers from 1 to 10, separated by commas');
    skip.add(n);
  }
  const ids: Partial<SpikeIds> = {
    ...(flags.has('--root') ? { root: flags.get('--root')! } : {}),
    ...(flags.has('--chronology') ? { chronology: flags.get('--chronology')! } : {}),
    ...(flags.has('--main-doc') ? { mainDoc: flags.get('--main-doc')! } : {}),
    ...(flags.has('--table-doc') ? { tableDoc: flags.get('--table-doc')! } : {}),
    ...(flags.has('--timeline-doc') ? { timelineDoc: flags.get('--timeline-doc')! } : {}),
    ...(flags.has('--calendar') ? { calendar: flags.get('--calendar')! } : {}),
  };
  const outDir = flags.get('--out-dir') ?? '/var/lib/lk-bridge/spike';

  // Make sure the report can be written BEFORE anything is sent to LegendKeeper.
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o750 });
  } catch (e) {
    fail(`Cannot create the output directory ${outDir}: ${(e as Error).message}. Use --out-dir.`);
  }

  const abort = new AbortController();
  let interrupts = 0;
  const onSignal = (name: string) => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    process.stderr.write(
      `\n${name}: stopping after the current call; the throwaway resource will be deleted. Press again to quit at once.\n`,
    );
    abort.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let spike;
  try {
    spike = await createSoakRuntime({ apiKey: target.apiKey, project: target.name, writersMax: 1 });
  } catch (e) {
    if (e instanceof SandboxGuardError) fail(e.message);
    throw e;
  }
  let code = 0;
  try {
    process.stderr.write(
      'Spike: ten checks against the test world (reads at P3; check 1 writes under one throwaway root).\n',
    );
    const started = new Date();
    const outcome = await runSpike(
      { engine: spike.runtime.engine, lk: spike.lk, projectId: spike.projectId, counters: spike.counters },
      project,
      {
        ids,
        skip,
        sampleLines: whole(flags, '--sample-lines', 40, 10, 400),
        maxAssetLists: whole(flags, '--max-asset-lists', 600, 1, 20000),
        maxAssetBytes: whole(flags, '--max-asset-bytes', 25 * 1024 * 1024, 1024, 500 * 1024 * 1024),
        maxEventPages: whole(flags, '--max-event-pages', 8, 0, 100),
        ...(flags.has('--rare-query') ? { rareQuery: flags.get('--rare-query')! } : {}),
        ...(flags.has('--common-query') ? { commonQuery: flags.get('--common-query')! } : {}),
        log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
        signal: abort.signal,
      },
    );
    const c = spike.counters;
    const report = formatReport(
      {
        generatedAt: started.toISOString(),
        projectId: project,
        durationMs: outcome.durationMs,
        ids: outcome.ids as unknown as Record<string, string>,
        stats: {
          requests: c.requests,
          reads: c.reads,
          writes: c.writes,
          byStatus: Object.fromEntries(
            [...c.byStatus].sort(([a], [b]) => a - b).map(([k, v]) => [String(k), v]),
          ),
          networkErrors: c.networkErrors,
          status429: c.byStatus.get(429) ?? 0,
          downloads: outcome.downloads,
        },
        cleanup: outcome.cleanup,
        budgetFooter: spike.lk.budgetFooter(target.name),
      },
      outcome.checks,
    );
    process.stdout.write(`${report}\n`);
    try {
      for (const file of writeReportFiles(outDir, started, report, outcome.oracle)) {
        process.stderr.write(`Written: ${file}\n`);
      }
    } catch (e) {
      process.stderr.write(
        `Could not write the report file: ${(e as Error).message}. The report above is complete.\n`,
      );
      code = 1;
    }
    if (outcome.cleanup.attempted && !outcome.cleanup.ok) {
      process.stderr.write(`CLEAN-UP FAILED: ${outcome.cleanup.detail}\n`);
      code = 1;
    }
  } catch (e) {
    if (e instanceof SandboxGuardError) {
      process.stderr.write(`${e.message}\n`);
      code = 2;
    } else throw e;
  } finally {
    await spike.close();
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
