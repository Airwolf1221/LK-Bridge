/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- LK results are untyped JSON */
/**
 * The Markdown round trip over a whole project (docs/PLAN-v2.md 4.7 "Tests" and section 7, step 4): read every page
 * document under a resource subtree (default: the whole project) and check each with the converter's
 * `checkRoundTrip`: blocks → Markdown → blocks must be identical and the unchanged write-back plan empty.
 *
 * Read-only by construction: the only operations it sends are listProjects, listResources and getDocumentBlocks, each
 * through the real job engine and governor at priority P3 (the lowest: it runs only when no agent or job is waiting).
 * About one read per page, plus one per 100 resources for the listing.
 *
 * The CLI is scripts/markdown-roundtrip.ts; the server wrapper is deploy/markdown-roundtrip.sh.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExhaustedError, TERMINAL_JOB_STATUSES, type JobEngine } from '../src/jobs/index.js';
import type { LkClient } from '../src/lk/index.js';
import { checkRoundTrip, minimalRepro, type RoundTripResult } from '../src/markdown/check.js';
import type { LkBlock } from '../src/markdown/types.js';
import type { HttpCounters } from '../test/sandbox/soak.js';
import { SandboxGuardError } from '../test/sandbox/smoke.js';

type Obj = Record<string, any>;

/** The only operations the round trip may send. */
export const ROUNDTRIP_OPS: ReadonlySet<string> = new Set([
  'listProjects',
  'listResources',
  'getDocumentBlocks',
]);

export interface RoundTripTarget {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface RoundTripOptions {
  /** Only pages of this resource and its descendants (default: every resource of the project, templates included). */
  readonly root?: string;
  /** Stop after this many pages (a quick trial). */
  readonly maxPages?: number;
  /** Where failing pages' reproductions are written (`<outDir>/roundtrip-<stamp>/…`). */
  readonly outDir: string;
  readonly stamp: string;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
  /** The check (replaceable in tests). */
  readonly check?: (blocks: readonly LkBlock[]) => RoundTripResult;
  /** How long to wait while the budget is paused or a read is queued (replaceable in tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * v2 C1: list every keep region of this kind (`paragraph`, `heading`…, or `all`) with its page, document, block id and
   * the characters that made it read-only, written as visible escapes (`\n`, `\u0007`).
   */
  readonly listKeep?: string;
}

/** v2 C1: one keep region listed by `--list-keep`. */
export interface KeepListing {
  readonly resourceId: string;
  readonly resourceName: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly blockId: string;
  readonly kind: string;
  readonly reason: string;
  /** The characters Markdown cannot carry in a line, as visible escapes, each once, in order of appearance. */
  readonly characters: readonly string[];
  /** A short piece of the text around the first one, with every such character escaped. */
  readonly context?: string;
}

export interface PageOutcome {
  readonly resourceId: string;
  readonly resourceName: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly result?: RoundTripResult;
  /** Why the page could not be read (it is counted, not checked). */
  readonly readError?: string;
  /** The reproduction file of a failing page. */
  readonly repro?: string;
}

export interface RoundTripOutcome {
  readonly pages: readonly PageOutcome[];
  /** v2 C1: the keep regions `listKeep` asked for (empty without it). */
  readonly keepListing: readonly KeepListing[];
  readonly resources: number;
  readonly otherDocuments: number;
  readonly interrupted: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly reproDir: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The characters the converter keeps out of a line of Markdown (src/markdown/model.ts: line breaks, control characters,
 * a byte-order mark, lone surrogates): a text run holding one is shown read-only, as a keep region.
 */
const BAD_CHAR =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\n\r\0\x01-\x08\x0b\x0c\x0e-\x1f\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\0': '\\0',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
};

/** A character as a visible escape: `\n`, `\r`, `\0`, or `\uXXXX`. */
export function visibleEscape(ch: string): string {
  return NAMED_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Every string inside a block (its runs' text, mention labels, titles, cells…), in order. */
function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 100) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as Obj))
      if (k !== 'id' && k !== 'kind') stringsIn(x, out, depth + 1);
  return out;
}

/** The offending characters of a block (escaped, each once) and a short context around the first. */
export function offendingCharacters(block: unknown): { characters: string[]; context?: string } {
  const characters: string[] = [];
  let context: string | undefined;
  for (const text of stringsIn(block)) {
    for (const m of text.matchAll(BAD_CHAR)) {
      const e = visibleEscape(m[0]);
      if (!characters.includes(e)) characters.push(e);
      if (context === undefined) {
        const at = m.index ?? 0;
        const piece = text.slice(Math.max(0, at - 30), at + 31);
        context = `${at > 30 ? '…' : ''}${piece.replace(BAD_CHAR, visibleEscape)}${at + 31 < text.length ? '…' : ''}`;
      }
    }
  }
  return { characters, ...(context !== undefined ? { context } : {}) };
}

function findBlock(blocks: readonly unknown[], id: string): unknown {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if ((b as Obj).id === id) return b;
    const children: unknown = (b as Obj).children;
    if (Array.isArray(children)) {
      const hit = findBlock(children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

class Reader {
  readonly origin = { kind: 'test' as const, client: 'markdown-roundtrip', tool: 'markdown-roundtrip' };
  constructor(
    private readonly t: RoundTripTarget,
    private readonly o: RoundTripOptions,
  ) {}

  /** One read through the engine at P3. Queued reads are cancelled and tried again; budget pauses are waited out. */
  async call(op: string, params: Obj = {}): Promise<any> {
    if (!ROUNDTRIP_OPS.has(op)) throw new Error(`round trip bug: ${op} is not a read it may send`);
    const sleep = this.o.sleep ?? realSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.t.engine.run(op, params, {
          project: this.t.projectId,
          origin: this.origin,
          priority: 'P3',
          title: `markdown-roundtrip: ${op}`,
        });
        if (r.status === 'succeeded') return r.result;
        if (r.status === 'proposal_captured') throw new Error(`${op} was captured as a proposal`);
        this.t.engine.controls.cancel(this.t.projectId, r.jobId);
        if (attempt >= 20) throw new Error(`${op} stayed queued (${r.reason})`);
        await sleep(Math.min(60_000, Math.max(2_000, (r.eta ?? Date.now()) - Date.now())));
      } catch (e) {
        if (e instanceof BudgetExhaustedError && attempt < 30) {
          this.o.log?.(`  budget paused; waiting until ${new Date(e.retryAtMs).toISOString()}`);
          await sleep(Math.min(120_000, Math.max(1_000, e.retryAtMs - Date.now())));
          continue;
        }
        throw e;
      }
    }
  }

  async listAll(op: string, params: Obj = {}): Promise<Obj[]> {
    const items: Obj[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10_000; pages++) {
      const page = await this.call(op, {
        ...params,
        query: { ...params.query, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      items.push(...arr(page?.data));
      const next: unknown = page?.nextCursor;
      if (!page?.hasMore || typeof next !== 'string' || next === cursor) return items;
      cursor = next;
    }
    return items;
  }
}

/**
 * Runs the round trip. `expectedProjectId` is the registered sandbox project's LegendKeeper id (resolveSandboxTarget);
 * throws SandboxGuardError (nothing read beyond the project list) if the key's own project is not exactly that one.
 */
export async function runRoundTrip(
  t: RoundTripTarget,
  expectedProjectId: string,
  o: RoundTripOptions,
): Promise<RoundTripOutcome> {
  const log = o.log ?? (() => undefined);
  const reader = new Reader(t, o);
  const check = o.check ?? checkRoundTrip;
  const started = Date.now();

  const projects = (await reader.call('listProjects')) as { data?: { id: string }[] };
  const projectIds = (projects.data ?? []).map((x) => x.id);
  if (projectIds.length !== 1 || projectIds[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${projectIds.join(', ')}], not the project ${expectedProjectId}.`,
    );
  }

  log('Listing resources…');
  const all = await reader.listAll('listResources');
  const byId = new Map(all.map((r) => [String(r.id), r]));
  const under = (r: Obj): boolean => {
    if (o.root === undefined) return true;
    let cur: Obj | undefined = r;
    for (let i = 0; i < 200 && cur; i++) {
      if (cur.id === o.root) return true;
      cur = typeof cur.parentId === 'string' ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  const resources = all.filter(under);
  if (o.root !== undefined && !byId.has(o.root))
    log(`The root ${o.root} is not among the project's resources; nothing to check.`);
  const queue: { res: Obj; doc: Obj }[] = [];
  let otherDocuments = 0;
  for (const res of resources) {
    for (const doc of arr(res.documents)) {
      if (doc.type === 'page') queue.push({ res, doc });
      else otherDocuments++;
    }
  }
  log(
    `${resources.length} resource(s), ${queue.length} page document(s) to check, ${otherDocuments} other document(s) skipped.`,
  );

  const reproDir = join(o.outDir, `roundtrip-${o.stamp}`);
  const pages: PageOutcome[] = [];
  const keepListing: KeepListing[] = [];
  let interrupted = false;
  let truncated = false;
  for (const [i, { res, doc }] of queue.entries()) {
    if (o.signal?.aborted) {
      interrupted = true;
      break;
    }
    if (o.maxPages !== undefined && i >= o.maxPages) {
      truncated = true;
      break;
    }
    const base = {
      resourceId: String(res.id),
      resourceName: String(res.name ?? ''),
      documentId: String(doc.id),
      documentName: String(doc.name ?? ''),
    };
    let blocks: LkBlock[];
    try {
      const page = await reader.call('getDocumentBlocks', {
        path: { resourceId: base.resourceId, documentId: base.documentId },
      });
      blocks = arr(page?.blocks) as LkBlock[];
    } catch (e) {
      pages.push({ ...base, readError: e instanceof Error ? e.message : String(e) });
      log(
        `  [${i + 1}/${queue.length}] ${base.resourceName}: could not read (${pages[pages.length - 1]!.readError})`,
      );
      continue;
    }
    const result = check(blocks);
    if (o.listKeep !== undefined) {
      for (const r of result.regions) {
        if (o.listKeep !== 'all' && r.kind !== o.listKeep) continue;
        const block = r.id.startsWith('anon-') ? undefined : findBlock(blocks, r.id);
        keepListing.push({
          ...base,
          blockId: r.id,
          kind: r.kind,
          reason: r.reason,
          ...(block !== undefined ? offendingCharacters(block) : { characters: [] }),
        });
      }
    }
    let repro: string | undefined;
    if (!result.ok) {
      mkdirSync(reproDir, { recursive: true, mode: 0o750 });
      repro = join(reproDir, `${base.resourceId}-${base.documentId}.json`);
      const minimal = minimalRepro(blocks, check);
      writeFileSync(
        repro,
        `${JSON.stringify(
          {
            resource: { id: base.resourceId, name: base.resourceName },
            document: { id: base.documentId, name: base.documentName },
            failure: result.failure,
            reproduction: {
              note:
                minimal.length < blocks.length
                  ? 'the first top-level block that fails on its own'
                  : 'the whole page',
              blocks: minimal,
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o640 },
      );
    }
    pages.push({ ...base, result, ...(repro ? { repro } : {}) });
    if ((i + 1) % 50 === 0 || !result.ok)
      log(
        `  [${i + 1}/${queue.length}] ${result.ok ? 'ok' : 'FAILED'}: ${base.resourceName} (${base.resourceId})`,
      );
  }
  return {
    pages,
    keepListing,
    resources: resources.length,
    otherDocuments,
    interrupted,
    truncated,
    durationMs: Date.now() - started,
    reproDir,
  };
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly projectId: string;
  readonly root?: string;
  /** v2 C1: the kind `--list-keep` asked for. */
  readonly listKeep?: string;
  readonly requests: { readonly total: number; readonly reads: number; readonly writes: number };
  readonly budgetFooter: string;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const clip = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** The Markdown report. Page content appears only in each failure's first difference (clipped). */
export function formatRoundTripReport(out: RoundTripOutcome, meta: ReportMeta): string {
  const checked = out.pages.filter((p) => p.result);
  const failed = checked.filter((p) => !p.result!.ok);
  const unread = out.pages.filter((p) => p.readError);
  const regions = new Map<string, number>();
  for (const p of checked)
    for (const r of p.result!.regions)
      regions.set(`${r.kind} (${r.reason})`, (regions.get(`${r.kind} (${r.reason})`) ?? 0) + 1);
  const fallbacks = checked.filter((p) => p.result!.fallbacks.length > 0);
  const slowest = [...checked].sort((a, b) => b.result!.ms - a.result!.ms).slice(0, 3);
  const lines: string[] = [
    `# Markdown round trip`,
    '',
    `- Generated ${meta.generatedAt} for project ${code(meta.projectId)}${meta.root ? `, subtree ${code(meta.root)}` : ', whole project'}.`,
    `- **Verdict: ${failed.length === 0 && unread.length === 0 && !out.interrupted ? 'PASS' : failed.length > 0 ? 'FAIL' : 'INCOMPLETE'}.** Pages checked: ${checked.length}; passed: ${checked.length - failed.length}; failed: ${failed.length}; could not be read: ${unread.length}.`,
    `- Resources scanned: ${out.resources}; other documents (maps, timelines, boards, blank) skipped: ${out.otherDocuments}.${out.truncated ? ' Stopped at --max-pages.' : ''}${out.interrupted ? ' **Interrupted before the end.**' : ''}`,
    `- Requests: ${meta.requests.total} (${meta.requests.reads} reads, ${meta.requests.writes} writes). Duration ${Math.round(out.durationMs / 1000)} s.`,
    `- Budget: ${meta.budgetFooter}`,
    `- Blocks checked: ${checked.reduce((n, p) => n + p.result!.blocks, 0)}; Markdown produced: ${checked.reduce((n, p) => n + p.result!.markdownLength, 0)} characters.`,
    `- Slowest pages: ${slowest.map((p) => `${p.resourceName} (${p.result!.blocks} blocks, ${p.result!.ms} ms)`).join('; ') || 'none'}.`,
    '',
    '## Keep regions (blocks Markdown shows read-only)',
    '',
    ...(regions.size > 0
      ? [...regions].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)
      : ['- none']),
    '',
    '## Self-check fallbacks (exact, but Markdown could not express the block)',
    '',
    ...(fallbacks.length > 0
      ? fallbacks.map(
          (p) =>
            `- ${p.resourceName} (${code(p.resourceId)}, document ${code(p.documentId)}): blocks ${p.result!.fallbacks.map(code).join(', ')}`,
        )
      : ['- none']),
    '',
    '## Failures',
    '',
  ];
  if (failed.length === 0) lines.push('- none');
  for (const p of failed) {
    const f = p.result!.failure!;
    lines.push(
      `### ${p.resourceName || '(unnamed)'} (${code(p.resourceId)}), document ${p.documentName || '(unnamed)'} (${code(p.documentId)})`,
      '',
      `- Stage: ${f.stage}${f.code ? ` (${f.code})` : ''}: ${clip(f.message, 300)}`,
      ...(f.path
        ? [
            `- First difference at ${code(f.path)}: expected ${code(clip(f.expected))}, got ${code(clip(f.actual))}`,
          ]
        : []),
      `- Reproduction: ${p.repro ? code(p.repro) : '(not written)'}`,
      '',
    );
  }
  if (meta.listKeep !== undefined) {
    lines.push(
      '',
      `## Keep regions of kind ${code(meta.listKeep)} (--list-keep)`,
      '',
      `${out.keepListing.length} block(s). Characters are shown as escapes (\\n is a line break, \\uXXXX a control character).`,
      '',
    );
    if (out.keepListing.length > 0) {
      lines.push(
        '| Page | Document | Block | Kind | Characters | Context | Why |',
        '| --- | --- | --- | --- | --- | --- | --- |',
      );
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'");
      for (const k of out.keepListing)
        lines.push(
          `| ${cell(k.resourceName)} (${code(k.resourceId)}) | ${cell(k.documentName)} (${code(k.documentId)}) | ${code(k.blockId)} | ${k.kind} | ${k.characters.length > 0 ? k.characters.map(code).join(' ') : '–'} | ${k.context !== undefined ? code(cell(clip(k.context, 80))) : '–'} | ${cell(k.reason)} |`,
        );
    } else lines.push('- none');
  }
  if (unread.length > 0) {
    lines.push('## Pages that could not be read', '');
    for (const p of unread)
      lines.push(
        `- ${p.resourceName} (${code(p.resourceId)}), document ${code(p.documentId)}: ${clip(p.readError, 200)}`,
      );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Writes the report next to the reproductions: `<outDir>/roundtrip-<stamp>.md`. */
export function writeRoundTripReport(outDir: string, stamp: string, report: string): string {
  mkdirSync(outDir, { recursive: true, mode: 0o750 });
  const file = join(outDir, `roundtrip-${stamp}.md`);
  writeFileSync(file, report, { mode: 0o640 });
  return file;
}

/** Waits for nothing: exported for tests that check the reader never writes. */
export const TERMINAL = TERMINAL_JOB_STATUSES;
