/**
 * `npm run roundtrip -- --project NAME [flags]`: the Markdown round trip over every page of a project (docs/PLAN-v2.md
 * 4.7, and the go-live gate in section 7, step 4). READ-ONLY: it sends only listProjects, listResources and
 * getDocumentBlocks, through the real job engine and governor at priority P3, so it gives way to agents and jobs.
 *
 * v2 A1: `--project NAME` names a project registered in the bridge's database (DB_PATH). v2 E5 hotfix (ADR 0046): any
 * registered, not removed project, sandbox or not (Arkona included: `resolveReadOnlyTarget` in test/sandbox/target.ts),
 * because the runtime is read-only by construction (`createReadOnlyRuntime`): LK_READ_ONLY=true, the governor's
 * allow-list (ROUNDTRIP_OPS: listProjects, listResources, getDocumentBlocks; anything else is refused before a request)
 * and a transport that sends only GET. An unregistered or removed project is still refused before any request. Its key is
 * found as the bridge finds it: the key in the bridge's encrypted store (OPS2), or, only when none is stored, the env
 * file's `LK_PROJECT_<NAME>_API_KEY` (`LK_API_KEY` in the single-project form). It refuses to run unless the key's own
 * project is exactly the registered one, uses a temporary database, and never prints a secret. On the server,
 * deploy/markdown-roundtrip.sh passes the project, DB_PATH and the env file's path (LKB_ENV_FILE), never a key.
 *
 * Output: the Markdown report on stdout (progress on stderr) and in <out-dir>/roundtrip-<timestamp>.md; for every
 * failing page, a minimal reproduction in <out-dir>/roundtrip-<timestamp>/<resourceId>-<documentId>.json.
 * Exit code: 0 when every page passed, 1 when a page failed or could not be read (or the report could not be written),
 * 2 when the script refused to run.
 */
import { mkdirSync } from 'node:fs';
import { fileStamp } from '../test/sandbox/spike-report.js';
import { SandboxGuardError } from '../test/sandbox/smoke.js';
import { createReadOnlyRuntime, type SoakRuntime } from '../test/sandbox/soak.js';
import { keySourceLine, resolveReadOnlyTarget, type ReadOnlyTarget } from '../test/sandbox/target.js';
import {
  ROUNDTRIP_OPS,
  formatRoundTripReport,
  runRoundTrip,
  writeRoundTripReport,
} from './markdown-roundtrip-core.js';

const USAGE = `usage: npm run roundtrip -- --project NAME [flags]
  --project NAME   the project to check (any project registered by the bridge, sandbox or not; always read-only)
  --root ID        only pages of this resource and everything under it (default: the whole project)
  --max-pages N    stop after N pages (a quick trial)
  --out-dir DIR    where the report and reproductions go (default /var/lib/lk-bridge/roundtrip)
  --list-keep KIND also list every keep region of this block kind (paragraph, heading, … or all): page, document,
                   block id and the characters that made it read-only, as escapes (\n, \u0007). Still read-only.
`;

const VALUE_FLAGS = new Set(['--project', '--root', '--max-pages', '--out-dir', '--list-keep']);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

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

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const flags = parseArgs(process.argv.slice(2));
  let target: ReadOnlyTarget;
  try {
    target = resolveReadOnlyTarget(flags.get('--project'));
  } catch (e) {
    if (e instanceof SandboxGuardError) fail(e.message);
    throw e;
  }
  process.stderr.write(keySourceLine(target));
  let maxPages: number | undefined;
  if (flags.has('--max-pages')) {
    maxPages = Number(flags.get('--max-pages'));
    if (!Number.isInteger(maxPages) || maxPages < 1) fail('--max-pages must be a whole number of 1 or more');
  }
  const root = flags.get('--root');
  const listKeep = flags.get('--list-keep');
  if (listKeep !== undefined && !/^[A-Za-z]{1,40}$/.test(listKeep))
    fail('--list-keep takes a block kind such as paragraph, or all');
  const outDir = flags.get('--out-dir') ?? '/var/lib/lk-bridge/roundtrip';
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o750 });
  } catch (e) {
    fail(`Cannot create the output directory ${outDir}: ${(e as Error).message}. Use --out-dir.`);
  }

  const abort = new AbortController();
  let interrupts = 0;
  const onSignal = (name: string) => {
    if (++interrupts > 1) process.exit(130);
    process.stderr.write(
      `\n${name}: stopping after the current page; the report covers what was checked. Press again to quit at once.\n`,
    );
    abort.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let rt: SoakRuntime;
  try {
    rt = await createReadOnlyRuntime({
      apiKey: target.apiKey,
      project: target.name,
      allowedOperations: ROUNDTRIP_OPS,
    });
  } catch (e) {
    if (e instanceof SandboxGuardError) fail(e.message);
    throw e;
  }
  let code = 0;
  try {
    const started = new Date();
    const stamp = fileStamp(started);
    process.stderr.write(
      `Markdown round trip of project "${target.name}" (${target.isSandbox ? 'a sandbox' : 'not a sandbox'}): ` +
        `read-only, only ${[...ROUNDTRIP_OPS].join(', ')}, every read at P3.\n`,
    );
    const out = await runRoundTrip(
      { engine: rt.runtime.engine, lk: rt.lk, projectId: rt.projectId, counters: rt.counters },
      target.projectId,
      {
        ...(root !== undefined ? { root } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(listKeep !== undefined ? { listKeep } : {}),
        outDir,
        stamp,
        signal: abort.signal,
        log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
      },
    );
    const report = formatRoundTripReport(out, {
      generatedAt: started.toISOString(),
      projectId: `${target.name} (${target.projectId})`,
      access: {
        isSandbox: target.isSandbox,
        readOnly: rt.runtime.engine.queries.controls(rt.projectId).readOnly,
        allowedOperations: [...ROUNDTRIP_OPS],
      },
      ...(root !== undefined ? { root } : {}),
      ...(listKeep !== undefined ? { listKeep } : {}),
      requests: { total: rt.counters.requests, reads: rt.counters.reads, writes: rt.counters.writes },
      budgetFooter: rt.lk.budgetFooter(target.name),
    });
    process.stdout.write(report);
    try {
      process.stderr.write(`Written: ${writeRoundTripReport(outDir, stamp, report)}\n`);
    } catch (e) {
      process.stderr.write(
        `Could not write the report file: ${(e as Error).message}. The report above is complete.\n`,
      );
      code = 1;
    }
    if (out.pages.some((p) => p.readError || (p.result && !p.result.ok)) || out.interrupted) code = 1;
  } catch (e) {
    if (e instanceof SandboxGuardError) {
      process.stderr.write(`${e.message}\n`);
      code = 2;
    } else throw e;
  } finally {
    await rt.close();
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
