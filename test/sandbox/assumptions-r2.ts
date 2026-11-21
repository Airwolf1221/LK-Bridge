/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * Round 2 of the sandbox assumptions (opt-in; `npm run test:sandbox -- assumptions-r2`): what the bridge's newer code
 * assumes about LegendKeeper and no sandbox check confirms yet, checked on a REAL sandbox project. Each check (W1 … W18)
 * reports PASS, FAIL, INCONCLUSIVE or NOTED with what LegendKeeper answered; NOTED is a fact the run records, never a
 * failure.
 *
 * - The asset library (the image placement, src/images/service.ts; Revert's asset moves, src/review/revert-plan.ts; the
 *   "only if empty" folder delete and the folder find-or-create, src/jobs/step-exec.ts; the bytes kept before a delete,
 *   src/images/kept.ts): W1 a move keeps the image and its file and the listings follow; W2 updateAsset is partial and
 *   needs no If-Match (a made-up one: ignored, or 412 NOTED); W3 a hidden image is listed in its folder; W4 deleting a
 *   folder that holds a sub-folder (NOTED, informational); W5 an image delete is immediate; W6 the root listing gives a
 *   top-level folder with folderId null or absent (NOTED: the root's children only, or the whole library).
 * - Table rows and nested blocks, written exactly as the chronology (src/chronology/plan.ts, checkers.ts, table.ts) and
 *   Revert (src/review/revert-chronology.ts) write them, with ids minted by the bridge (src/jobs/ids.ts): W7 insertBlock
 *   of a row `after` row 1; W8 moveBlock of a row (and a stale If-Match: 412, nothing moved); W9 replaceBlock of a row,
 *   every id kept, and deleteBlock of a row (stale 412, current 204); W10 getBlock of a paragraph inside a table cell
 *   answers the document's version (the read before an updateBlock, ADR 0055 decision E); W11 updateBlock with only
 *   `content` changes nothing else. W7 to W11 run in order on one table; each reads the table first and judges its own
 *   write, so one that fails does not make the next fail.
 * - W12 listEvents pages (src/chronology/check.ts readEvents, src/snapshots/restore.ts planFinish): two events of three
 *   with limit 2, then the cursor; the last two share a start, so the page boundary falls between equal starts.
 * - What the second review's own fixes (docs/reviews/CR-2026-11-R2.md) assume: W13 a template saved from a page carries
 *   its tags, getResource answers the template (its tags; parentId null or "templates") and a copy takes the template's
 *   tags (the lifecycle guard's copy check, R2-13; the recovery's "as planned", R2-05); W14 createManyResources with an
 *   id already held is refused whole, the item before the duplicate not created (R2-05); W15 a template that does not
 *   exist reads 404 and a copy of it makes nothing (the guard's "nothing copied"); W16 an event reads back as createEvent
 *   and updateEvent answered it, every stored field (Revert's exact comparison, R2-16); W17 moveResource answers the
 *   page's new rank, the one getResource then gives (Revert's move comparison, R2-19); W18 getResource of `templates`
 *   answers 404 (the guards read that virtual parent live, WS-C3), and what a move of a page there does (NOTED).
 *
 * Safety, as assumptions.ts: it refuses to run unless the key's own project (listProjects) is exactly the sandbox project
 * (SandboxGuardError, before anything is written); every call goes through the bridge's own engine and governor (as the
 * system, at P1; the raw calls, which need LegendKeeper's exact status, headers or a stale If-Match the engine would never
 * send, through the governor's `call` and `fetch`; the signed PUT and the downloads from the asset host through the
 * governor too). Writes parked for budget or queued behind the pacing are waited for, never sent again (wait.ts).
 *
 * What it creates: ONE throwaway root resource `lk-bridge assumptions-r2 <time>` with these pages under it: `W7 table` (its
 * Main gets a paragraph and a table of three rows, then a fourth), `W12 timeline` (a timeline document on the project's
 * first calendar: one lane, three events), `W13 source` (tagged `lkb-w13`) and `W13 copy`, `W14 held`, `W17 parent`
 * with `W17 a` and `W17 b`, and `W18 page` (which W18 tries to move to `templates`); ONE template `lk-bridge assumptions-r2 template W13` (saved from `W13 source`: a top-level
 * template, outside the root); and in the asset library four folders
 * `lk-bridge assumptions-r2 F1 <time>` to `… F4 <time>` (F1, F2 and F3 at the top level, F4 inside F3) and one 70-byte
 * PNG (`lk-bridge assumptions-r2 W1 image`, renamed by W2). Plain names only: no `[BSRC]`, `[BWRK]`, `[BARC]` or
 * `[INDEX]` prefix, no Status and no status tag (`lkb-w13` is none), so the canon and lifecycle guards never stand in the
 * way. W14 and W15 send a create LegendKeeper should refuse (a page either makes anyway is under the root), and W18 a
 * move it may refuse; whatever they leave, the clean-up deletes by id.
 * What it cleans up: everything, at the end, even after a failure: the assets by id, the deepest first (W4 and W5 delete
 * theirs on the way), then each page (one small cascade each), the template and the root. Already gone (404, "already
 * deleted") counts as cleaned; any other failure is confirmed by a read before it is reported, and the report names each
 * id to delete by hand (pages in the tree, the template among the templates, assets in the asset library).
 * Cost (counted against the mock by test/tools/assumptions-r2-dryrun.test.ts, with the sandbox test's own runtime: no
 * repository or asset tree): 52 writes and 121 reads, 3 downloads from the asset host (4 if a move changes the file's URL)
 * and 1 PUT to the upload host (neither draws on an API tier); W6 adds a read per 100 assets if the root listing turns
 * out to be the whole library. On the asset routes' own limits (ADR 0047): 6 creates (four folders, the upload, the
 * image; about 20 a minute) and 4 deletes (about 60 a minute; 5 if a folder delete leaves its sub-folder), plus 4
 * updateAsset. About a minute at the bridge's write pacing.
 */
import { sandboxRun, StepTimeoutError, type SandboxRun } from './steps.js';
import { createHash } from 'node:crypto';
import { EVENT_STORED_FIELDS, replaceCells } from '../../src/chronology/plan.js';
import { buildRow, runsText } from '../../src/chronology/table.js';
import { downloadAsset } from '../../src/images/download.js';
import { UPLOAD_PUT_STEP } from '../../src/jobs/custom-steps.js';
import { mintClientId } from '../../src/jobs/ids.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { DEFAULT_LK_ASSET_HOSTS } from '../../src/lk/constants.js';
import { BridgeLkError, BudgetWaitError } from '../../src/lk/errors.js';
import { parseEtag } from '../../src/lk/governor/headers.js';
import { SandboxGuardError, type Finding, type SmokeTarget, type Verdict } from './smoke.js';
import { runSettled } from './wait.js';
import { wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface AssumptionsR2Options {
  /** The hosts asset files are downloaded from: the runtime's LK_ASSET_HOSTS (default: LegendKeeper's two). */
  readonly assetHosts?: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  /** Counted as the run goes: downloads from the asset host and PUTs to the upload host (neither is an API request). */
  readonly tally?: { downloads: number; puts: number };
  /** R4.1: the run that prints each step and holds the clean-up (the test file's, for its `afterAll`). */
  readonly run?: SandboxRun;
}

/** Thrown inside a check: the assumption does not hold (a FAIL with this message). */
class Fails extends Error {}
/** Thrown inside a check: it could not tell (INCONCLUSIVE with this message). */
class Unclear extends Error {}

const fail = (m: string): never => {
  throw new Fails(m);
};

/** A 1×1 PNG (70 bytes), as LIM1 uploads. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);
/** The report lists the checks by id (W6 runs right after W1, while the image is still in a folder). */
const ORDER = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
  'W10',
  'W11',
  'W12',
  'W13',
  'W14',
  'W15',
  'W16',
  'W17',
  'W18',
  'cleanup',
];
/** The columns of the throwaway table, as an age table's: event, date, KCY. */
const COLS = { event: 0, date: 1, kcy: 2 } as const;

interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly headers?: Headers;
  readonly body?: any;
  readonly errors?: readonly Obj[];
}
/** A write's answered version: in its body, as its ETag, and the one the bridge chains (the body's, else the ETag). */
interface Versions {
  readonly body: string | null;
  readonly etag: string | null;
  readonly chained: string | null;
}

export async function runAssumptionsR2(
  t: SmokeTarget,
  expectedProjectId: string,
  o: AssumptionsR2Options = {},
): Promise<Finding[]> {
  const steps = o.run ?? sandboxRun({ name: 'assumptions-r2', out: () => undefined });
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hosts = o.assetHosts ?? DEFAULT_LK_ASSET_HOSTS;
  const tally = o.tally ?? { downloads: 0, puts: 0 };
  const origin = { kind: 'test' as const, client: 'sandbox-assumptions-r2', tool: 'sandbox-assumptions-r2' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });

  // A read refused for budget is made again once the budget allows; a write parked for budget or queued behind the
  // pacing is waited for (at most 10 minutes) and never sent again (test/sandbox/wait.ts).
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(t, op, params, { origin, priority: 'P1', project: t.projectId, ...extra }, { sleep });
  /** A raw call through the governor: the status, headers and body LegendKeeper answered, or its error. */
  const raw = async (
    operationId: string,
    method: string,
    suffix: string,
    x: { body?: unknown; ifMatch?: string; idempotencyKey?: string } = {},
  ): Promise<Answer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawOnce(operationId, method, suffix, x);
      } catch (e) {
        if (!(e instanceof BudgetWaitError) || attempt >= 5) throw e;
        await sleep(Math.max(1000, e.retryAtMs - Date.now()));
      }
    }
  };
  const rawOnce = async (
    operationId: string,
    method: string,
    suffix: string,
    x: { body?: unknown; ifMatch?: string; idempotencyKey?: string },
  ): Promise<Answer> => {
    try {
      const res = await t.lk.call<Response>({
        operationId,
        priority: 'P1',
        ...(x.body !== undefined ? { input: { body: x.body } } : {}),
        ...(x.idempotencyKey ? { idempotencyKey: x.idempotencyKey } : {}),
        run: () =>
          t.lk.fetch(`${t.baseUrl}/api/v3/projects/${t.projectId}${suffix}`, {
            method,
            headers: {
              authorization: `Bearer ${t.apiKey}`,
              ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(x.ifMatch ? { 'if-match': x.ifMatch } : {}),
            },
            ...(x.body !== undefined ? { body: JSON.stringify(x.body) } : {}),
          }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    } catch (e) {
      if (e instanceof BudgetWaitError) throw e;
      if (e instanceof BridgeLkError)
        return {
          status: e.status ?? 0,
          ...(e.code ? { code: e.code } : {}),
          ...(e.errors.length > 0 ? { errors: e.errors } : {}),
        };
      throw e;
    }
  };
  const answered = (r: Answer) =>
    `${r.status}${r.code ? ` ${r.code}` : ''}${r.errors ? ` ${JSON.stringify(r.errors)}` : ''}`;
  const ok2xx = (r: Answer) => r.status >= 200 && r.status <= 299;
  const check = async (
    id: string,
    title: string,
    fn: () => Promise<string | { readonly verdict: Verdict; readonly detail: string }>,
  ) => {
    try {
      const r = await steps.step(id, title, fn);
      if (typeof r === 'string') record(id, title, 'pass', r);
      else record(id, title, r.verdict, r.detail);
    } catch (e) {
      if (e instanceof Fails || e instanceof StepTimeoutError) record(id, title, 'fail', e.message);
      else if (e instanceof Unclear) record(id, title, 'inconclusive', e.message);
      else record(id, title, 'inconclusive', `the check could not complete: ${wholeError(e)}`);
    }
  };

  // ---- guard: the key must belong to exactly the sandbox project --------------------------------------------------
  const projects = (await steps.step('guard', 'the key belongs to exactly the sandbox project', () =>
    run('listProjects'),
  )) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${ids.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  // ---- the throwaway root, and what the run makes -------------------------------------------------------------------
  const stamp = new Date().toISOString();
  /** One per run, in every idempotency key the raw POSTs send. */
  const tag = mintClientId(8);
  const root = (await steps.step('root', 'the throwaway root', () =>
    run('createResource', {
      body: { name: `lk-bridge assumptions-r2 ${stamp}` },
    }),
  )) as Obj;
  const rootId = root.id as string;
  /** The pages made directly under the root, deleted one at a time at the end (small cascades). */
  const topLevel: string[] = [];
  const mk = async (name: string): Promise<Obj> => {
    const made = (await run('createResource', { body: { name, parentId: rootId } })) as Obj;
    topLevel.push(made.id as string);
    return made;
  };
  /** Every asset the run made, in the order made: the clean-up deletes them in reverse (the deepest first). */
  const made: { id: string; what: string }[] = [];
  /** Assets a check deleted and a read then confirmed gone. */
  const gone = new Set<string>();

  // ---- asset helpers ------------------------------------------------------------------------------------------------
  const mkFolder = async (n: string, parent?: string): Promise<string> => {
    const f = (await run('createAssetFolder', {
      body: { name: `lk-bridge assumptions-r2 ${n} ${stamp}`, ...(parent ? { folderId: parent } : {}) },
    })) as Obj;
    if (typeof f?.id !== 'string') throw new Unclear(`createAssetFolder (${n}) answered no id`);
    made.push({ id: f.id, what: `folder ${n}` });
    return f.id;
  };
  const getAsset = async (id: string): Promise<Obj> =>
    (await run('getAsset', { path: { assetId: id } })) as Obj;
  const assetGone = (r: Answer) =>
    r.status === 404 || r.code === 'NOT_FOUND' || (r.status === 200 && r.body?.deletedAt != null);
  /** A folder's contents (null: the root) as findFolder reads them: 100 a page, the cursor followed. */
  const listFolder = async (folderId: string | null): Promise<Obj[]> => {
    const out: Obj[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = (await run('listAssets', {
        query: { limit: 100, ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) },
      })) as Obj;
      out.push(...((page.data ?? []) as Obj[]));
      if (page.hasMore !== true || typeof page.nextCursor !== 'string') break;
      cursor = page.nextCursor;
    }
    return out;
  };
  /** An asset's file from the asset host, as the bridge downloads it (anonymous GET through the governor). */
  const download = async (url: unknown) => {
    tally.downloads++;
    return downloadAsset(t.lk, url, { hosts, priority: 'P1', opId: 'sandbox.download' });
  };
  /** The signed PUT, through the governor as the bridge's upload step sends it; the URL is never printed. */
  const putSigned = async (created: Obj, bytes: Buffer): Promise<{ status: number; code?: string }> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries((created.headers ?? {}) as Obj))
      if (typeof v === 'string') headers.set(k, v);
    if (!headers.has('content-type')) headers.set('content-type', 'image/png');
    tally.puts++;
    try {
      const res = await t.lk.governor.execute<Response>({
        opId: UPLOAD_PUT_STEP,
        kind: 'upload',
        costs: { tiers: ['upload'] },
        priority: 'P1',
        run: (signal) =>
          t.lk.fetch(String(created.uploadUrl), {
            method: 'PUT',
            headers,
            body: new Uint8Array(bytes),
            signal,
          }),
      });
      await res.arrayBuffer().catch(() => undefined);
      return { status: res.status };
    } catch (e) {
      if (e instanceof BridgeLkError) return { status: e.status ?? 0, ...(e.code ? { code: e.code } : {}) };
      throw e;
    }
  };
  /** createImageUpload, the signed PUT, createImageAsset into `folderId` (the bridge's upload, as LIM1 sends it). */
  const uploadImage = async (name: string, folderId: string): Promise<{ id: string; sha256: string }> => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const sha256 = createHash('sha256').update(png).digest('hex');
    const up = await raw('createImageUpload', 'POST', '/assets/uploads', {
      body: { contentType: 'image/png', contentLength: png.length, contentHash: sha256 },
      idempotencyKey: `lkb.sandbox.r2.upload.${tag}`,
    });
    if (!ok2xx(up) || typeof up.body?.uploadUrl !== 'string')
      throw new Unclear(`createImageUpload answered ${answered(up)} without an upload URL`);
    const put = await putSigned(up.body as Obj, png);
    if (put.status < 200 || put.status >= 300) throw new Unclear(`the signed PUT answered ${put.status}`);
    const asset = await raw('createImageAsset', 'POST', '/assets/images', {
      body: { uploadKey: up.body.uploadKey, name, folderId },
      idempotencyKey: `lkb.sandbox.r2.asset.${tag}`,
    });
    if (!ok2xx(asset) || typeof asset.body?.id !== 'string')
      throw new Unclear(`createImageAsset answered ${answered(asset)}`);
    made.push({ id: asset.body.id as string, what: 'image' });
    return { id: asset.body.id as string, sha256 };
  };

  /** W12's timeline and what createEvent answered for each event, for W16. */
  let w12: { readonly tpath: Obj; readonly answers: ReadonlyMap<string, Obj> } | null = null;
  /** Templates the run saved (outside the root): deleted at the end, after the pages. */
  const templates: { id: string; what: string }[] = [];
  let F1: string | null = null;
  let F2: string | null = null;
  let image: string | null = null;
  const imageName = 'lk-bridge assumptions-r2 W1 image';

  // ---- block helpers ------------------------------------------------------------------------------------------------
  /** A data row as the chronology builds one (buildRow): three cells of one paragraph each, every id minted (8). */
  const newRow = (label: string): Obj =>
    buildRow({
      ids: {
        row: mintClientId(8),
        cells: [mintClientId(8), mintClientId(8), mintClientId(8)],
        paragraphs: [mintClientId(8), mintClientId(8), mintClientId(8)],
      },
      width: 3,
      columns: COLS,
      descriptionRuns: [{ text: `${label} event` }],
      dateText: `${label} date`,
      kcyText: `${label} kcy`,
    });
  const findBlock = (list: unknown, id: string): Obj | null => {
    for (const b of Array.isArray(list) ? (list as Obj[]) : []) {
      if (b?.id === id) return b;
      const hit = findBlock(b?.children, id);
      if (hit) return hit;
    }
    return null;
  };
  /** What "kept its ids and cells" compares: the row's, its cells' and their paragraphs' ids, kinds and texts. */
  const shapeOf = (row: Obj | null | undefined) =>
    row
      ? {
          id: row.id,
          kind: row.kind,
          cells: (Array.isArray(row.children) ? (row.children as Obj[]) : []).map((c) => ({
            id: c.id,
            kind: c.kind,
            children: (Array.isArray(c.children) ? (c.children as Obj[]) : []).map((p) => ({
              id: p.id,
              kind: p.kind,
              text: runsText(p.content),
            })),
          })),
        }
      : null;
  const versionsOf = (r: Answer): Versions => {
    const body =
      typeof r.body?.version === 'string' && r.body.version !== '' ? (r.body.version as string) : null;
    const etag = r.headers ? (parseEtag(r.headers) ?? null) : null;
    return { body, etag, chained: body ?? etag };
  };
  /** (src/jobs/engine.ts bindIfMatch) the version a write answers is what the next write of the job sends. */
  const versionProblems = (what: string, v: Versions, before: string, next: string): string[] => {
    const out: string[] = [];
    if (next === before) out.push(`the document's version did not move (${before})`);
    if (v.chained === null) out.push(`${what} answered no version (none in its body, no ETag)`);
    else if (v.chained !== next)
      out.push(
        `${what} answered version ${v.chained} (${v.body !== null ? 'in its body' : 'as its ETag'}), but the next read gives ${next}`,
      );
    return out;
  };
  const versionNote = (v: Versions, next: string) =>
    `answered version ${v.chained ?? 'none'} (body ${v.body ?? 'none'}, ETag ${v.etag ?? 'none'}${
      v.body !== null && v.etag !== null && v.body !== v.etag
        ? ': they differ, and the bridge chains the body’s'
        : ''
    }), the next read’s ${next}`;
  let tbl: {
    readonly pageId: string;
    readonly docId: string;
    readonly tableId: string;
    readonly rows: { readonly R1: string; readonly R2: string; readonly R3: string; readonly R4: string };
    readonly labels: ReadonlyMap<string, string>;
  } | null = null;
  const label = (id: string) => tbl?.labels.get(id) ?? id;
  const names = (order: readonly string[]) => order.map(label).join(', ');
  const blocksPath = () => `/resources/${tbl!.pageId}/docs/${tbl!.docId}/blocks`;
  /** The table's document as read now: its version, the table (null when it is gone) and the row ids in order. */
  const readTable = async () => {
    if (!tbl) throw new Unclear('W7 did not set up the table');
    const d = (await run('getDocumentBlocks', {
      path: { resourceId: tbl.pageId, documentId: tbl.docId },
    })) as Obj;
    const table = findBlock(d.blocks, tbl.tableId);
    return {
      version: d.version as string,
      table,
      order: ((table?.children ?? []) as Obj[]).map((r) => r.id as string),
    };
  };
  /** Each row named still holds the same ids and texts as before. */
  const keptRows = (before: Obj, after: Obj, rowIds: readonly string[]): string[] =>
    rowIds
      .filter((id) => !same(shapeOf(findBlock(after.children, id)), shapeOf(findBlock(before.children, id))))
      .map((id) => `${label(id)} changed: ${JSON.stringify(shapeOf(findBlock(after.children, id)))}`);

  steps.defer('the assets by id, then the throwaway pages and root deleted', async () => {
    // ---- clean-up: the assets by id, the deepest first; then each page (one small cascade each), then the root ------
    // C2d's rule: already gone (404, "already deleted") counts as cleaned; any other failure is confirmed by a read
    // before it is reported. A delete the canon guard could not judge for lack of budget is tried again after a minute.
    const left: string[] = [];
    for (const a of [...made].reverse()) {
      if (gone.has(a.id)) continue;
      try {
        const del = await raw('deleteAsset', 'DELETE', `/assets/${a.id}`);
        if (ok2xx(del) || assetGone(del) || del.code === 'ALREADY_DELETED') continue;
        const now = await raw('getAsset', 'GET', `/assets/${a.id}`);
        if (!assetGone(now)) left.push(`${a.what} ${a.id} (${answered(del)}; in the asset library)`);
      } catch (e) {
        left.push(`${a.what} ${a.id} (${(e as Error).message}; in the asset library)`);
      }
    }
    const goneAlready = (e: unknown): boolean => {
      const m = (e as Error).message ?? '';
      const lk = (e as { lk?: { status?: number; code?: string } }).lk;
      const codes = [(e as { code?: string }).code, lk?.code];
      return (
        /\b404\b|NOT_FOUND|ALREADY_DELETED|already deleted|is deleted|was deleted|not found/i.test(m) ||
        lk?.status === 404 ||
        codes.includes('NOT_FOUND') ||
        codes.includes('ALREADY_DELETED')
      );
    };
    const isGone = async (id: string): Promise<boolean> => {
      try {
        const r = await raw('getResource', 'GET', `/resources/${id}`);
        return r.status === 404 || r.code === 'NOT_FOUND' || (r.status === 200 && r.body?.deletedAt != null);
      } catch {
        return false;
      }
    };
    const remove = async (id: string): Promise<string | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await run(
            'deleteResource',
            { path: { resourceId: id }, query: { cascade: true } },
            { confirm: 'cascade' },
          );
          return null;
        } catch (e) {
          if (goneAlready(e)) return null;
          const m = (e as Error).message;
          if (attempt >= 3 || !/could not (be read|be listed|all be checked)|budget/i.test(m))
            return (await isGone(id)) ? null : m;
          await sleep(65_000);
        }
      }
    };
    for (const id of [...topLevel].reverse()) {
      const why = await remove(id);
      if (why) left.push(`page ${id} (${why})`);
    }
    for (const x of templates) {
      const why = await remove(x.id);
      if (why) left.push(`${x.what} ${x.id} (${why}; a template, outside the root)`);
    }
    const why = await remove(rootId);
    if (why) left.push(`root ${rootId} (${why})`);
    if (left.length === 0)
      record(
        'cleanup',
        'the throwaway root, its pages, the template and every asset made deleted',
        'pass',
        `root ${rootId} and ${topLevel.length} page(s); ${templates.length} template(s)${templates.length > 0 ? `: ${templates.map((x) => x.id).join(', ')}` : ''}; ${made.length} asset(s): ${made.map((a) => `${a.what} ${a.id}`).join(', ') || 'none'}`,
      );
    else
      record(
        'cleanup',
        'throwaway pages, templates and assets deleted',
        'fail',
        `left: ${left.join('; ')}. Delete them by hand.`,
      );
  });
  try {
    // ================================================================================================ the asset library
    await check(
      'W1',
      'updateAsset { folderId } moves an image: getAsset shows the new folder with name and hidden flag unchanged, the listings follow, the file is the same',
      async () => {
        F1 = await mkFolder('F1');
        F2 = await mkFolder('F2');
        const up = await uploadImage(imageName, F1);
        image = up.id;
        const a0 = await getAsset(image);
        if (a0.folderId !== F1)
          throw new Unclear(`the new image reads folderId ${JSON.stringify(a0.folderId)}, not F1 (${F1})`);
        const facts: string[] = [];
        let d0: Awaited<ReturnType<typeof download>>;
        try {
          d0 = await download(a0.url);
        } catch (e) {
          throw new Unclear(`its file could not be downloaded before the move: ${(e as Error).message}`);
        }
        facts.push(
          d0.sha256 === up.sha256
            ? 'stored as uploaded (the same SHA-256)'
            : `NOTED: the stored file is not the bytes uploaded (SHA-256 ${d0.sha256.slice(0, 12)}…)`,
        );
        // As the placement and Revert send it (the body is partial: the folder alone).
        await run('updateAsset', { path: { assetId: image }, body: { folderId: F2 } });
        const a1 = await getAsset(image);
        const problems: string[] = [];
        if (a1.folderId !== F2)
          problems.push(`getAsset reads folderId ${JSON.stringify(a1.folderId)}, not F2 (${F2})`);
        if (a1.name !== a0.name)
          problems.push(`the name changed: ${JSON.stringify(a0.name)} → ${JSON.stringify(a1.name)}`);
        if (a1.isHidden !== a0.isHidden)
          problems.push(`isHidden changed: ${JSON.stringify(a0.isHidden)} → ${JSON.stringify(a1.isHidden)}`);
        if (!(await listFolder(F2)).some((x) => x.id === image))
          problems.push('listAssets(F2) does not list it');
        if ((await listFolder(F1)).some((x) => x.id === image))
          problems.push('listAssets(F1) still lists it');
        try {
          const d1 = await download(a1.url);
          if (d1.sha256 !== d0.sha256)
            problems.push(
              `the file downloaded after the move differs (SHA-256 ${d0.sha256.slice(0, 12)}… → ${d1.sha256.slice(0, 12)}…)`,
            );
        } catch (e) {
          problems.push(`its file could not be downloaded after the move: ${(e as Error).message}`);
        }
        if (a1.url !== a0.url) {
          // Pages show an image by its URL: a move that changes it would leave them pointing at the old one.
          let old: string;
          try {
            const d = await download(a0.url);
            old = `still answers with the file (${d.sha256 === d0.sha256 ? 'the same' : 'a DIFFERENT'} SHA-256)`;
          } catch (e) {
            old = `answers: ${(e as Error).message}`;
          }
          facts.push(
            `NOTED: the file URL CHANGED with the move (the old URL ${old}); pages show an image by its URL`,
          );
        } else facts.push('the file URL unchanged');
        if (problems.length > 0) fail(`${problems.join('; ')} (${facts.join('; ')})`);
        return `F1 → F2; name and isHidden unchanged; listed in F2, not in F1; the same file (SHA-256 ${d0.sha256.slice(0, 12)}…) before and after; ${facts.join('; ')}`;
      },
    );

    // W6 runs here, while the image is in F2 (not hidden): whether the root listing also gives items inside folders.
    await check(
      'W6',
      'the root listing (listAssets with no folderId, as findFolder reads it) gives the top-level folder F1 with folderId null or absent',
      async () => {
        if (!F1) throw new Unclear('W1 did not make F1');
        const items = await listFolder(null);
        const f1 = items.find((x) => x.id === F1);
        if (!f1) fail(`F1 (${F1}) is not in the root listing (${items.length} items read)`);
        const problems: string[] = [];
        if (f1!.folderId != null) problems.push(`F1 is listed with folderId ${JSON.stringify(f1!.folderId)}`);
        if (f1!.type !== 'FOLDER')
          problems.push(`F1 is listed as type ${JSON.stringify(f1!.type)}, not FOLDER`);
        if (f1!.name !== `lk-bridge assumptions-r2 F1 ${stamp}`)
          problems.push(`F1 is listed as ${JSON.stringify(f1!.name)}, not by the name written`);
        if (problems.length > 0) fail(`${problems.join('; ')}: findFolder would not match it`);
        const inner = items.filter((x) => x.folderId != null);
        const imageListed = image !== null && items.some((x) => x.id === image);
        const scope =
          inner.length > 0 || imageListed
            ? `NOTED: the root listing ALSO gives items inside folders (${inner.length} of ${items.length}; the image in F2 ${imageListed ? 'among them' : 'not among them'}): the whole library, not the root's children (findFolder still matches by folderId, but pages through it all)`
            : `NOTED: the root's children only (${items.length} items, none inside a folder; the image in F2 not among them)`;
        return `F1 listed at the root with folderId ${'folderId' in f1! ? 'null' : 'absent'}, type FOLDER and its name as written; ${scope}`;
      },
    );

    await check(
      'W2',
      'updateAsset is partial and unversioned: { name } keeps the folder and hidden flag, without If-Match; a made-up If-Match is ignored (412: NOTED)',
      async () => {
        if (!image) throw new Unclear('W1 did not make the image');
        const before = await getAsset(image);
        // The plain call, as the bridge sends it (the registry has updateAsset unversioned): no If-Match.
        const plain = await raw('updateAsset', 'PATCH', `/assets/${image}`, {
          body: { name: 'lk-bridge assumptions-r2 W2 renamed' },
        });
        if (!ok2xx(plain))
          fail(
            `updateAsset { name } without If-Match answered ${answered(plain)}: LegendKeeper wants a version the bridge never sends`,
          );
        const after = await raw('getAsset', 'GET', `/assets/${image}`);
        if (after.status !== 200) throw new Unclear(`getAsset answered ${answered(after)}`);
        const problems: string[] = [];
        if (after.body?.name !== 'lk-bridge assumptions-r2 W2 renamed')
          problems.push(`the name reads ${JSON.stringify(after.body?.name)} after the rename`);
        if (after.body?.folderId !== before.folderId)
          problems.push(
            `the folder changed: ${JSON.stringify(before.folderId)} → ${JSON.stringify(after.body?.folderId)}`,
          );
        if (after.body?.isHidden !== before.isHidden)
          problems.push(
            `isHidden changed: ${JSON.stringify(before.isHidden)} → ${JSON.stringify(after.body?.isHidden)}`,
          );
        const v = versionsOf(after);
        const renameEtag = plain.headers?.get('etag') ?? null;
        const versioned = `getAsset answers ${v.body !== null ? `a version (${v.body})` : 'no version'} and ${v.etag !== null ? `an ETag (${v.etag})` : 'no ETag'}${renameEtag !== null ? `; the rename answered an ETag (${renameEtag})` : ''}`;
        const madeUp = await raw('updateAsset', 'PATCH', `/assets/${image}`, {
          body: { name: 'lk-bridge assumptions-r2 W2 renamed again' },
          ifMatch: `lkb-made-up-${tag}`,
        });
        let probe: string;
        let verdict: Verdict = 'pass';
        if (ok2xx(madeUp)) {
          const n = ((await getAsset(image)).name as string | undefined) ?? '';
          probe = `a made-up If-Match was ignored (${madeUp.status}; the write ${n.endsWith('renamed again') ? 'applied' : 'did NOT apply'})`;
        } else if (madeUp.status === 412) {
          verdict = 'noted';
          probe = `NOTED: a made-up If-Match answered 412 ${madeUp.code ?? ''}: LegendKeeper versions assets, so the bridge could send the version getAsset gives`;
        } else {
          verdict = 'noted';
          probe = `NOTED: a made-up If-Match answered ${answered(madeUp)} (the bridge never sends one on updateAsset)`;
        }
        if (problems.length > 0) fail(`${problems.join('; ')} (${versioned}; ${probe})`);
        const detail = `{ name } alone, without If-Match, answered ${plain.status} and kept the folder and isHidden; ${versioned}; ${probe}`;
        return verdict === 'pass' ? detail : { verdict, detail };
      },
    );

    await check(
      'W3',
      'a hidden image is still listed in its folder (listAssets { folderId, limit: 1 }, as the "only if empty" folder delete reads it)',
      async () => {
        if (!image) throw new Unclear('W1 did not make the image');
        await run('updateAsset', { path: { assetId: image }, body: { isHidden: true } });
        const a = await getAsset(image);
        if (a.isHidden !== true)
          throw new Unclear(
            `updateAsset { isHidden: true } did not hide it (getAsset isHidden ${JSON.stringify(a.isHidden)})`,
          );
        const folder = typeof a.folderId === 'string' ? a.folderId : null;
        if (!folder) throw new Unclear('the image is not in a folder');
        // Exactly folderNotEmpty's read: the folder holds only this image, so the one-item page must be it.
        const page = (await run('listAssets', { query: { limit: 1, folderId: folder } })) as Obj;
        const data = (page.data ?? []) as Obj[];
        const listed = data.find((x) => x.id === image);
        if (!listed)
          fail(
            `listAssets { folderId, limit: 1 } answered ${data.length} item(s) without the hidden image: a folder holding only hidden images would look empty, and the "only if empty" delete would delete them with it`,
          );
        if (listed!.isHidden !== true)
          fail(`it is listed, but with isHidden ${JSON.stringify(listed!.isHidden)} (getAsset says true)`);
        return 'listed in its folder while hidden, with isHidden true: a folder holding only hidden images is not empty to the bridge';
      },
    );

    await check(
      'W4',
      'deleting a folder that holds a sub-folder (informational: what LegendKeeper answers, and whether the sub-folder survives)',
      async () => {
        const F3 = await mkFolder('F3');
        const F4 = await mkFolder('F4', F3);
        const del = await raw('deleteAsset', 'DELETE', `/assets/${F3}`);
        const f3 = await raw('getAsset', 'GET', `/assets/${F3}`);
        const f4 = await raw('getAsset', 'GET', `/assets/${F4}`);
        if (assetGone(f3)) gone.add(F3);
        if (assetGone(f4)) gone.add(F4);
        const what = ok2xx(del)
          ? assetGone(f4)
            ? 'F3 and its sub-folder F4 are both gone (a folder delete takes what is inside it, as the spec says)'
            : `F3 is ${assetGone(f3) ? 'gone' : 'STILL THERE'} but its sub-folder F4 STILL EXISTS (getAsset ${f4.status}, folderId ${JSON.stringify(f4.body?.folderId ?? null)})`
          : `F3 is ${assetGone(f3) ? 'gone anyway' : 'still there'} and F4 ${assetGone(f4) ? 'gone' : 'still there'}: LegendKeeper refused to delete a folder that is not empty`;
        // Clean up whatever is left: F4, then F3.
        const cleaned: string[] = [];
        const left: string[] = [];
        for (const [n, id] of [
          ['F4', F4],
          ['F3', F3],
        ] as const) {
          if (gone.has(id)) continue;
          const r = await raw('deleteAsset', 'DELETE', `/assets/${id}`);
          const after = ok2xx(r) || assetGone(r) ? r : await raw('getAsset', 'GET', `/assets/${id}`);
          if (ok2xx(r) || assetGone(after)) {
            gone.add(id);
            cleaned.push(n);
          } else left.push(`${n} (${answered(r)})`);
        }
        const tidy =
          left.length > 0
            ? `left for the clean-up: ${left.join(', ')}`
            : cleaned.length > 0
              ? `then deleted here: ${cleaned.join(', ')}`
              : 'nothing left to delete';
        return {
          verdict: 'noted' as const,
          detail: `NOTED: deleteAsset(F3) answered ${answered(del)}; ${what}. The bridge deletes a folder it made only when it is empty as the job runs (folderNotEmpty), so either answer is safe; ${tidy}`,
        };
      },
    );

    await check(
      'W5',
      'an image delete is immediate: deleteAsset answers 204, getAsset then 404 (or a deletedAt), its folder no longer lists it',
      async () => {
        if (!image) throw new Unclear('W1 did not make the image');
        const a = await getAsset(image);
        const folder = typeof a.folderId === 'string' ? a.folderId : null;
        const url = a.url as unknown;
        const del = await raw('deleteAsset', 'DELETE', `/assets/${image}`);
        if (!(del.status === 204 || del.status === 200)) fail(`deleteAsset answered ${answered(del)}`);
        const after = await raw('getAsset', 'GET', `/assets/${image}`);
        if (assetGone(after)) gone.add(image);
        const problems: string[] = [];
        if (!assetGone(after)) problems.push(`getAsset still answers ${after.status} with no deletedAt`);
        if (folder && (await listFolder(folder)).some((x) => x.id === image))
          problems.push('its folder still lists it');
        // Why the bytes are kept before a delete (src/images/kept.ts): what the old file URL answers now.
        let file: string;
        try {
          const d = await download(url);
          file = `the old file URL still answers with the file (${d.bytes.length} bytes)`;
        } catch (e) {
          file = `the old file URL now answers: ${(e as Error).message}`;
        }
        if (problems.length > 0) fail(`${problems.join('; ')}; NOTED: ${file}`);
        return `deleteAsset answered ${del.status}; getAsset then ${after.status === 404 ? '404' : `${after.status} with a deletedAt`}; its folder no longer lists it; NOTED: ${file}`;
      },
    );

    // ======================================================================================= table rows and nested blocks
    await check(
      'W7',
      'insertBlock of a table row placed after row 1, as the chronology binds it: rows R1, R4, R2, R3; R4 keeps its ids and cells; the answered version is the next read’s',
      async () => {
        const page = await mk('W7 table');
        const docId = page.documents?.[0]?.id as string | undefined;
        if (!docId) throw new Unclear('the new page has no first document');
        const R = { R1: newRow('R1'), R2: newRow('R2'), R3: newRow('R3'), R4: newRow('R4') };
        const tableId = mintClientId(8);
        const dpath = { resourceId: page.id, documentId: docId };
        const v0 = ((await run('getDocumentBlocks', { path: dpath })) as Obj).version as string;
        await run('replaceDocumentBlocks', {
          path: dpath,
          body: {
            blocks: [
              { id: mintClientId(8), kind: 'paragraph', content: [{ text: 'W7 to W11: a throwaway table' }] },
              { id: tableId, kind: 'table', children: [R.R1, R.R2, R.R3] },
            ],
          },
          ifMatch: v0,
        });
        tbl = {
          pageId: page.id as string,
          docId,
          tableId,
          rows: { R1: R.R1.id, R2: R.R2.id, R3: R.R3.id, R4: R.R4.id },
          labels: new Map(Object.entries(R).map(([k, b]) => [b.id as string, k])),
        };
        const d1 = await readTable();
        const sent = [R.R1, R.R2, R.R3];
        if (!d1.table || !sent.every((r) => same(shapeOf(findBlock(d1.table!.children, r.id)), shapeOf(r)))) {
          const read = d1.table
            ? JSON.stringify(((d1.table.children ?? []) as Obj[]).map(shapeOf))
            : 'no table';
          tbl = null;
          throw new Unclear(`the table did not read back as replaceDocumentBlocks wrote it: ${read}`);
        }
        // As the chronology's table check binds it: { block, after: the row it follows } (src/chronology/checkers.ts).
        const r = await raw('insertBlock', 'POST', blocksPath(), {
          body: { block: R.R4, after: R.R1.id },
          ifMatch: d1.version,
          idempotencyKey: `lkb.sandbox.r2.w7.${tag}`,
        });
        if (!ok2xx(r)) fail(`insertBlock answered ${answered(r)}`);
        const v = versionsOf(r);
        const d2 = await readTable();
        const problems: string[] = [];
        const want = [R.R1.id, R.R4.id, R.R2.id, R.R3.id];
        if (!d2.table) problems.push('the table is gone');
        else {
          if (!same(d2.order, want)) problems.push(`the rows read ${names(d2.order)}, not R1, R4, R2, R3`);
          const r4 = findBlock(d2.table.children, R.R4.id);
          if (!r4) problems.push('R4 is not in the table');
          else if (!same(shapeOf(r4), shapeOf(R.R4)))
            problems.push(`R4 read back as ${JSON.stringify(shapeOf(r4))}, not as sent`);
          problems.push(...keptRows(d1.table, d2.table, [R.R1.id, R.R2.id, R.R3.id]));
        }
        problems.push(...versionProblems('insertBlock', v, d1.version, d2.version));
        if (problems.length > 0) fail(problems.join('; '));
        return `rows R1, R4, R2, R3; R4 kept its row, cell and paragraph ids and its texts, the others unchanged; ${versionNote(v, d2.version)}`;
      },
    );

    await check(
      'W8',
      'moveBlock of a table row to after row 1 (a chronology date edit; Revert moves a row back the same way): ids and cells kept; a stale If-Match answers 412 and changes nothing',
      async () => {
        if (!tbl) throw new Unclear('W7 did not set up the table');
        const { R1, R2, R3 } = tbl.rows;
        const d0 = await readTable();
        if (!d0.table || ![R1, R2, R3].every((id) => d0.order.includes(id)))
          throw new Unclear(`the table holds ${d0.table ? names(d0.order) : 'nothing'}`);
        const want = d0.order.filter((x) => x !== R3);
        want.splice(want.indexOf(R1) + 1, 0, R3);
        // As the chronology's date edit binds it: { after: the row it now follows } (src/chronology/checkers.ts).
        const mv = await raw('moveBlock', 'POST', `${blocksPath()}/${R3}/move`, {
          body: { after: R1 },
          ifMatch: d0.version,
          idempotencyKey: `lkb.sandbox.r2.w8.${tag}`,
        });
        if (!ok2xx(mv)) fail(`moveBlock answered ${answered(mv)}`);
        const v = versionsOf(mv);
        const d1 = await readTable();
        const problems: string[] = [];
        if (!d1.table) problems.push('the table is gone after the move');
        else {
          if (!same(d1.order, want)) problems.push(`the rows read ${names(d1.order)}, not ${names(want)}`);
          problems.push(...keptRows(d0.table, d1.table, d0.order));
        }
        problems.push(...versionProblems('moveBlock', v, d0.version, d1.version));
        // A stale If-Match (the version from before the move): refused, and nothing moves.
        const stale = await raw('moveBlock', 'POST', `${blocksPath()}/${R2}/move`, {
          body: { after: R1 },
          ifMatch: d0.version,
          idempotencyKey: `lkb.sandbox.r2.w8s.${tag}`,
        });
        const d2 = await readTable();
        if (stale.status !== 412)
          problems.push(`a moveBlock with a stale If-Match answered ${answered(stale)}`);
        if (!same(d2.order, d1.order) || d2.version !== d1.version)
          problems.push(
            `the stale move changed the table (rows ${names(d2.order)}; version ${d1.version} → ${d2.version})`,
          );
        if (problems.length > 0) fail(problems.join('; '));
        return `rows ${names(d1.order)}; every row kept its ids and texts; ${versionNote(v, d1.version)}; a stale If-Match answered 412 ${stale.code ?? ''} and changed nothing`;
      },
    );

    await check(
      'W9',
      'replaceBlock of a table row (cells changed, every id kept as the bridge sends them) and deleteBlock of a row (only it goes; a stale If-Match 412, a current one 204)',
      async () => {
        if (!tbl) throw new Unclear('W7 did not set up the table');
        const { R2, R3, R4 } = tbl.rows;
        const d0 = await readTable();
        const r2 = d0.table ? findBlock(d0.table.children, R2) : null;
        if (!d0.table || !r2) throw new Unclear(`the table holds ${d0.table ? names(d0.order) : 'nothing'}`);
        // As a chronology date edit builds it: the row as read, its date and KCY cells' paragraphs given new text.
        const sent = replaceCells(
          r2,
          COLS,
          { date: 'R2 date, changed by W9', kcy: 'R2 kcy, changed by W9' },
          () => mintClientId(8),
        );
        const put = await raw('replaceBlock', 'PUT', `${blocksPath()}/${R2}`, {
          body: sent,
          ifMatch: d0.version,
        });
        if (!ok2xx(put)) fail(`replaceBlock answered ${answered(put)}`);
        const v = versionsOf(put);
        const d1 = await readTable();
        const problems: string[] = [];
        if (!d1.table) problems.push('the table is gone after the replace');
        else {
          if (!same(d1.order, d0.order))
            problems.push(`the rows read ${names(d1.order)}, not ${names(d0.order)}`);
          const back = findBlock(d1.table.children, R2);
          if (!same(shapeOf(back), shapeOf(sent)))
            problems.push(`R2 read back as ${JSON.stringify(shapeOf(back))}, not as sent`);
          problems.push(
            ...keptRows(
              d0.table,
              d1.table,
              d0.order.filter((x) => x !== R2),
            ),
          );
        }
        problems.push(...versionProblems('replaceBlock', v, d0.version, d1.version));
        // deleteBlock of W7's row R4 (R3 if it is not there): first with the version from before the replace.
        const victim = d1.order.includes(R4) ? R4 : R3;
        const stale = await raw('deleteBlock', 'DELETE', `${blocksPath()}/${victim}`, {
          ifMatch: d0.version,
        });
        const dS = await readTable();
        if (stale.status !== 412)
          problems.push(`a deleteBlock with a stale If-Match answered ${answered(stale)}`);
        if (!same(dS.order, d1.order)) problems.push(`the stale delete changed the rows: ${names(dS.order)}`);
        const del = await raw('deleteBlock', 'DELETE', `${blocksPath()}/${victim}`, { ifMatch: dS.version });
        const d2 = await readTable();
        if (del.status !== 204 && del.status !== 200)
          problems.push(`a current deleteBlock answered ${answered(del)}`);
        const want = dS.order.filter((x) => x !== victim);
        if (!d2.table || !dS.table) problems.push('the table is gone after the delete');
        else {
          if (!same(d2.order, want))
            problems.push(`after the delete the rows read ${names(d2.order)}, not ${names(want)}`);
          problems.push(...keptRows(dS.table, d2.table, want));
        }
        const dv = versionsOf(del);
        const delNote = `the delete answered ${del.status}${dv.etag !== null ? ` with ETag ${dv.etag} (${dv.etag === d2.version ? 'the next read’s version' : `not the next read’s ${d2.version}`})` : ' with no ETag'}`;
        if (problems.length > 0) fail(`${problems.join('; ')} (${delNote})`);
        return `R2's date and KCY changed with every row, cell and paragraph id kept; ${versionNote(v, d1.version)}; deleting ${label(victim)}: a stale If-Match answered 412 ${stale.code ?? ''} and removed nothing, a current one removed only ${label(victim)} (rows now ${names(d2.order)}); ${delNote}`;
      },
    );

    /** W10's paragraph, for W11. */
    let w10: string | null = null;
    await check(
      'W10',
      'getBlock of a paragraph inside a table cell answers the block and the document’s version (the read before an updateBlock, ADR 0055 decision E)',
      async () => {
        if (!tbl) throw new Unclear('W7 did not set up the table');
        const d0 = await readTable();
        const para = d0.table
          ? (findBlock(d0.table.children, tbl.rows.R1)?.children?.[0]?.children?.[0] as Obj | undefined)
          : undefined;
        if (!para || typeof para.id !== 'string') throw new Unclear('R1 has no paragraph in its first cell');
        w10 = para.id;
        const g = await raw('getBlock', 'GET', `${blocksPath()}/${para.id}`);
        if (g.status !== 200) fail(`getBlock answered ${answered(g)}`);
        const d1 = await readTable();
        const v = versionsOf(g);
        const problems: string[] = [];
        if (g.body?.id !== para.id) problems.push(`it answered id ${JSON.stringify(g.body?.id)}`);
        if (g.body?.kind !== 'paragraph') problems.push(`it answered kind ${JSON.stringify(g.body?.kind)}`);
        if (runsText(g.body?.content) !== runsText(para.content))
          problems.push(`it answered the text ${JSON.stringify(runsText(g.body?.content))}`);
        if (v.body === null)
          problems.push(
            `no version in its body${v.etag !== null ? ` (only an ETag, ${v.etag}; the engine reads the body's version)` : ''}`,
          );
        else if (v.body !== d0.version)
          problems.push(
            `its version ${v.body} is not the document's ${d0.version} (the bridge would see a conflict)`,
          );
        if (d1.version !== d0.version)
          problems.push(`the document's version moved with no write (${d0.version} → ${d1.version})`);
        if (problems.length > 0) fail(problems.join('; '));
        return `the paragraph (its id, kind and text) with version ${v.body}, the document's; ETag ${v.etag ?? 'none'}${v.etag !== null && v.etag !== v.body ? ' (differs; not used)' : ''}`;
      },
    );

    await check(
      'W11',
      'updateBlock with only content, on that nested paragraph, changes only its text (kind, id and the rest of the table kept) and answers a new version',
      async () => {
        if (!tbl) throw new Unclear('W7 did not set up the table');
        const d0 = await readTable();
        if (!d0.table) throw new Unclear('the table is gone');
        const pid =
          w10 ?? (findBlock(d0.table.children, tbl.rows.R1)?.children?.[0]?.children?.[0]?.id as unknown);
        if (typeof pid !== 'string' || !findBlock(d0.table.children, pid))
          throw new Unclear('R1 has no paragraph in its first cell');
        // As the engine sends it (readBefore): the block read first, the version it answers sent as If-Match.
        const g = await raw('getBlock', 'GET', `${blocksPath()}/${pid}`);
        const read = versionsOf(g).body;
        const text = 'R1 event, changed by W11';
        const p = await raw('updateBlock', 'PATCH', `${blocksPath()}/${pid}`, {
          body: { content: [{ text }] },
          ifMatch: read ?? d0.version,
        });
        if (!ok2xx(p))
          fail(
            `updateBlock answered ${answered(p)}${read === null ? ' (sent with the document’s version: getBlock gave none)' : ''}`,
          );
        const v = versionsOf(p);
        const d1 = await readTable();
        const problems: string[] = [];
        if (!d1.table) problems.push('the table is gone after the update');
        else {
          const para = findBlock(d1.table.children, pid);
          if (!para) problems.push('the paragraph is gone');
          else {
            if (para.kind !== 'paragraph') problems.push(`it reads as kind ${JSON.stringify(para.kind)}`);
            if (runsText(para.content) !== text)
              problems.push(`it reads ${JSON.stringify(runsText(para.content))}`);
          }
          // Everything else as it was: the paragraph's old content put back, the two reads must then be identical.
          const restored = structuredClone(d1.table);
          const rp = findBlock(restored.children, pid);
          const op = findBlock(d0.table.children, pid);
          if (rp && op) rp.content = structuredClone(op.content);
          if (stableJson(restored) !== stableJson(d0.table)) {
            const rows = d0.order.filter(
              (id) =>
                stableJson(findBlock(restored.children, id)) !==
                stableJson(findBlock(d0.table!.children, id)),
            );
            problems.push(
              `something else in the table changed (${rows.length > 0 ? `rows ${names(rows)}` : 'the table block itself'})`,
            );
          }
        }
        problems.push(...versionProblems('updateBlock', v, d0.version, d1.version));
        if (problems.length > 0) fail(problems.join('; '));
        return `only the paragraph's text changed (its id and kind, every other cell and row as before); sent with If-Match ${read !== null ? 'from getBlock' : 'from the document (getBlock gave no version)'}; ${versionNote(v, d1.version)}`;
      },
    );

    // ============================================================================================== timeline events
    await check(
      'W12',
      'listEvents pages: limit 2 of 3 answers hasMore and a nextCursor, the next page the third; every event once (equal starts across the page boundary)',
      async () => {
        const page = await mk('W12 timeline');
        const cals = (((await run('listCalendars')) as Obj).data ?? []) as Obj[];
        const cal = cals[0]?.id as string | undefined;
        const doc = (await run('createDocument', {
          path: { resourceId: page.id },
          body: { name: 'W12 timeline', type: 'time', ...(cal ? { calendarId: cal } : {}) },
        })) as Obj;
        if (typeof doc?.id !== 'string') throw new Unclear('createDocument answered no id');
        const tpath = { resourceId: page.id, documentId: doc.id };
        // As create_timeline_lane sends a timeline's first lane (src/mcp/tools/timelines.ts).
        const laneId = mintClientId(24);
        const lane = (await run('createLane', {
          path: tpath,
          body: { id: laneId, name: 'W12 lane', rank: 'aV', size: 'sm' },
        })) as Obj;
        if (lane?.id !== laneId)
          throw new Unclear(`createLane answered id ${JSON.stringify(lane?.id)}, not the ${laneId} sent`);
        const sent: string[] = [];
        const answers = new Map<string, Obj>();
        for (const [name, start] of [
          ['W12 first', 100_000],
          ['W12 second', 200_000],
          ['W12 third', 200_000],
        ] as const) {
          const id = mintClientId(24);
          const e = (await run('createEvent', {
            path: tpath,
            body: { id, laneId, type: 'event', name, start, detail: 1 },
          })) as Obj;
          if (e?.id !== id)
            throw new Unclear(`createEvent answered id ${JSON.stringify(e?.id)}, not the ${id} sent`);
          sent.push(id);
          answers.set(id, e);
        }
        w12 = { tpath, answers };
        // As readEvents and the restore follow it: { limit, cursor } until hasMore is false.
        const pages: Obj[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 4; i++) {
          const p = (await run('listEvents', {
            path: tpath,
            query: { limit: 2, ...(cursor ? { cursor } : {}) },
          })) as Obj;
          if (!Array.isArray(p?.data)) throw new Unclear(`listEvents answered no list: ${JSON.stringify(p)}`);
          pages.push(p);
          if (p.hasMore !== true || typeof p.nextCursor !== 'string') break;
          cursor = p.nextCursor;
        }
        const pageIds = pages.map((p) => (p.data as Obj[]).map((e) => e.id as string));
        const seen = pageIds.flat();
        const problems: string[] = [];
        const first = pages[0]!;
        if (pageIds[0]!.length !== 2)
          problems.push(`the first page holds ${pageIds[0]!.length} events, not 2`);
        if (first.hasMore !== true)
          problems.push(`the first page answered hasMore ${JSON.stringify(first.hasMore)}`);
        if (typeof first.nextCursor !== 'string' || first.nextCursor === '')
          problems.push(`the first page answered nextCursor ${JSON.stringify(first.nextCursor)}`);
        else if (pageIds.length < 2 || pageIds[1]!.length !== 1)
          problems.push(`the next page holds ${pageIds[1]?.length ?? 0} events, not the third`);
        const twice = seen.filter((id, i) => seen.indexOf(id) !== i);
        if (twice.length > 0) problems.push(`listed twice: ${[...new Set(twice)].join(', ')}`);
        const missing = sent.filter((id) => !seen.includes(id));
        if (missing.length > 0) problems.push(`never listed: ${missing.join(', ')}`);
        const other = seen.filter((id) => !sent.includes(id));
        if (other.length > 0) problems.push(`events it did not make: ${other.join(', ')}`);
        const last = pages[pages.length - 1]!;
        if (pages.length > 1 && last.hasMore === true)
          problems.push('the last page read still answers hasMore true');
        const starts = pages.flatMap((p) => p.data as Obj[]).map((e) => Number(e.start));
        const byStart = starts.every((s, i) => i === 0 || s >= starts[i - 1]!);
        if (problems.length > 0) fail(`${problems.join('; ')} (pages: ${JSON.stringify(pageIds)})`);
        return `page 1: 2 events, hasMore true and a nextCursor; page 2: the third, hasMore ${JSON.stringify(last.hasMore ?? null)}; each of the 3 once; ${byStart ? 'in start order' : `NOTED: not in start order (starts ${starts.join(', ')})`}${cal ? '' : ' (no calendar offered: the timeline has none)'}`;
      },
    );

    // ===================================================================== templates and batch creates (the fixes' own)
    // CR-2026-11-R2: R2-13's lifecycle guard judges a template copy by the tags getResource gives for its template; R2-05
    // takes DUPLICATE_ID on a batch's first send as a refusal that made nothing; the guard takes a template getResource
    // cannot find (404) as one LegendKeeper will not copy.
    const W13_TAG = 'lkb-w13';
    await check(
      'W13',
      'a template saved from a page carries its tags; getResource answers the template (its tags; parentId null or "templates"); a copy takes the template’s tags',
      async () => {
        const src = (await run('createResource', {
          body: { name: 'W13 source', parentId: rootId, tags: [W13_TAG] },
        })) as Obj;
        topLevel.push(src.id as string);
        const tid = mintClientId();
        const saved = (await run('saveResourceAsTemplate', {
          path: { resourceId: src.id },
          body: { id: tid, name: 'lk-bridge assumptions-r2 template W13' },
        })) as Obj;
        const tplId = typeof saved?.id === 'string' ? saved.id : tid;
        templates.push({ id: tplId, what: 'template W13' });
        // As the lifecycle guard reads it (src/lifecycle/guard.ts): a 404 there means "no such template, nothing copied".
        const read = await raw('getResource', 'GET', `/resources/${tplId}`);
        if (!ok2xx(read))
          fail(
            `getResource answered ${answered(read)} for the template just saved: the lifecycle guard reads a 404 as "no such template" (at entry and inside the lock), so a copy of a CANON-tagged template would be judged as taking no tags`,
          );
        const cid = mintClientId();
        const copy = (await run('createResourceFromTemplate', {
          body: { templateId: tplId, id: cid, name: 'W13 copy', parentId: rootId },
        })) as Obj;
        const copyId = typeof copy?.id === 'string' ? copy.id : cid;
        topLevel.push(copyId);
        const copyRead = (await run('getResource', { path: { resourceId: copyId } })) as Obj;
        const want = [W13_TAG];
        const problems: string[] = [];
        if (!same(read.body?.tags, want))
          problems.push(
            `the template reads with tags ${JSON.stringify(read.body?.tags ?? null)}, not its page’s ${JSON.stringify(want)}`,
          );
        if (!same(copyRead.tags, want))
          problems.push(
            `the copy reads with tags ${JSON.stringify(copyRead.tags ?? null)}, not the template’s (if a copy never takes tags, the guard's check of them is only stricter than needed)`,
          );
        const parent = (read.body?.parentId as unknown) ?? null;
        if (parent !== null && parent !== 'templates')
          problems.push(
            `the template reads with parentId ${JSON.stringify(parent)}, not null or "templates": a saved template found after a lost answer would be taken as not the one planned (the step uncertain)`,
          );
        if (problems.length > 0) fail(problems.join('; '));
        return `the template and its copy carry ${JSON.stringify(want)}; the template reads with parentId ${JSON.stringify(parent)}`;
      },
    );

    await check(
      'W14',
      'createManyResources with an id already held is refused whole (409 DUPLICATE_ID): the item before the duplicate is not created',
      async () => {
        const held = await mk('W14 held');
        const fresh = mintClientId();
        // The duplicate second: a batch that creates as it goes would make the first item before it meets it.
        const r = await raw('createManyResources', 'POST', '/resources/batch', {
          body: {
            resources: [
              { id: fresh, name: 'W14 fresh', parentId: rootId },
              { id: held.id, name: 'W14 duplicate', parentId: rootId },
            ],
          },
        });
        const now = await raw('getResource', 'GET', `/resources/${fresh}`);
        const made = ok2xx(now) && now.body?.deletedAt == null;
        if (made) topLevel.push(fresh);
        if (ok2xx(r)) fail(`the batch was accepted (${answered(r)}) although ${held.id as string} is held`);
        if (made)
          fail(
            `refused ${answered(r)}, but the item before the duplicate was created: a first send refused DUPLICATE_ID can leave pages, which the engine (taking it as a refusal) leaves as orphans`,
          );
        return `refused ${answered(r)}; the item before the duplicate was not created (getResource ${now.status})${
          r.code === 'DUPLICATE_ID'
            ? ''
            : '. NOTED: not DUPLICATE_ID, so the engine never treats it as a duplicate'
        }`;
      },
    );

    await check(
      'W15',
      'getResource of a template id that does not exist answers 404, and a copy of it is refused, making nothing',
      async () => {
        const missing = mintClientId();
        const looked = await raw('getResource', 'GET', `/resources/${missing}`);
        const cid = mintClientId();
        const r = await raw('createResourceFromTemplate', 'POST', '/resources/from-template', {
          body: { templateId: missing, id: cid, name: 'W15 copy', parentId: rootId },
        });
        const now = await raw('getResource', 'GET', `/resources/${cid}`);
        const made = ok2xx(now) && now.body?.deletedAt == null;
        if (made) topLevel.push(cid);
        if (ok2xx(r) || made)
          fail(
            `the copy answered ${answered(r)} and ${made ? 'a page was made' : 'no page was made'}: the lifecycle guard takes a template it cannot find as copying nothing`,
          );
        if (looked.status !== 404)
          return {
            verdict: 'noted',
            detail: `getResource of the missing id answered ${answered(looked)}, not 404 (the guard then refuses the copy as unreadable: safe); the copy was refused ${answered(r)}, nothing made`,
          };
        return `getResource 404; the copy refused ${answered(r)}; nothing made`;
      },
    );

    // ============================================================================== events and moves, as Revert reads them
    // CR-2026-11-R2: R2-16 records each event as the job's last write answered it and compares every stored field with
    // what LegendKeeper reads back (an absent field as null); R2-19 records the rank a move answered and compares it with
    // getResource's.
    await check(
      'W16',
      'an event reads back (listEvents, getEvent) exactly as createEvent and updateEvent answered it, field for field (an absent field as null)',
      async () => {
        if (!w12) throw new Unclear('W12 did not set up the timeline');
        const { tpath, answers } = w12;
        const diff = (a: Obj, b: Obj) =>
          EVENT_STORED_FIELDS.filter((k) => !same(a[k], b[k])).map(
            (k) => `${k}: ${JSON.stringify(a[k] ?? null)} answered, ${JSON.stringify(b[k] ?? null)} read`,
          );
        const listAll = async (): Promise<Map<string, Obj>> => {
          const out = new Map<string, Obj>();
          let cursor: string | undefined;
          for (let i = 0; i < 4; i++) {
            const p = (await run('listEvents', {
              path: tpath,
              query: { limit: 100, ...(cursor ? { cursor } : {}) },
            })) as Obj;
            for (const e of (Array.isArray(p?.data) ? p.data : []) as Obj[]) out.set(e.id as string, e);
            if (p?.hasMore !== true || typeof p.nextCursor !== 'string') break;
            cursor = p.nextCursor;
          }
          return out;
        };
        const ids = [...answers.keys()];
        const firstId = ids[0];
        if (!firstId) throw new Unclear('W12 made no event');
        const problems: string[] = [];
        const before = await listAll();
        for (const id of ids.slice(1)) {
          const a = answers.get(id)!;
          const l = before.get(id);
          if (!l) problems.push(`${String(a.name)} is not listed`);
          else {
            const d = diff(a, l);
            if (d.length > 0) problems.push(`${String(a.name)}, created: ${d.join('; ')}`);
          }
        }
        // The first event, updated as the chronology's repair and Revert update one (its name and detail).
        const upd = (await run('updateEvent', {
          path: { ...tpath, eventId: firstId },
          body: { name: 'W12 first, renamed by W16', detail: 2 },
        })) as Obj;
        const got = (await run('getEvent', { path: { ...tpath, eventId: firstId } })) as Obj;
        const d1 = diff(upd, got);
        if (d1.length > 0) problems.push(`updated, getEvent: ${d1.join('; ')}`);
        const after = (await listAll()).get(firstId);
        if (!after) problems.push('the updated event is not listed');
        else {
          const d2 = diff(upd, after);
          if (d2.length > 0) problems.push(`updated, listEvents: ${d2.join('; ')}`);
        }
        if (problems.length > 0)
          fail(
            `${problems.join(' | ')}. Revert would count such an event as changed since the job and refuse to revert it (safe, but no event a job wrote could be reverted)`,
          );
        return `${ids.length - 1} created events listed as createEvent answered them; the updated one read (getEvent and listEvents) as updateEvent answered it; ${EVENT_STORED_FIELDS.length} fields compared, an absent one as null`;
      },
    );

    await check(
      'W17',
      'moveResource answers the page with its parent and its new rank, and getResource then gives the same rank',
      async () => {
        const P = await mk('W17 parent');
        const a = (await run('createResource', { body: { name: 'W17 a', parentId: P.id } })) as Obj;
        const b = (await run('createResource', { body: { name: 'W17 b', parentId: P.id } })) as Obj;
        // A re-order under the same parent (the case R2-19 is about: the owner re-ordering a page the job moved).
        const moved = (await run('moveResource', {
          path: { resourceId: b.id },
          body: { parentId: P.id, before: a.id },
        })) as Obj;
        const read = (await run('getResource', { path: { resourceId: b.id } })) as Obj;
        const problems: string[] = [];
        if (typeof moved?.rank !== 'string' || moved.rank === '')
          problems.push(
            `the move answered no rank (${JSON.stringify(moved?.rank ?? null)}): Revert takes a move with no recorded rank as not revertible`,
          );
        else if (moved.rank !== read.rank)
          problems.push(
            `the move answered rank ${JSON.stringify(moved.rank)}, getResource gives ${JSON.stringify(read.rank ?? null)}: Revert would find every move changed since the job`,
          );
        if ((moved?.parentId ?? null) !== P.id)
          problems.push(
            `the move answered parentId ${JSON.stringify(moved?.parentId ?? null)}, not ${String(P.id)}`,
          );
        if (problems.length > 0) fail(problems.join('; '));
        const order =
          typeof read.rank === 'string' && typeof a.rank === 'string'
            ? read.rank < a.rank
              ? ', now before W17 a'
              : `; NOTED: its rank ${read.rank} is not before W17 a's ${a.rank}`
            : '';
        return `answered rank ${JSON.stringify(moved.rank)} and parent ${String(P.id)}; getResource gives the same rank${order}`;
      },
    );

    // CR-2026-11-R2 (WS-C3): a move or create under `templates` (the templates' virtual parent) is judged by reading that
    // parent live; the guards take a 404 as "no such parent". Answered as a page, it would be read as one in no lifecycle
    // area, and a move of an Authoritative page there judged as a move inside the repository.
    await check(
      'W18',
      'getResource of "templates" answers 404 (a virtual parent, not a resource), as the guards read it; and what a move of a page to "templates" does (NOTED)',
      async () => {
        const looked = await raw('getResource', 'GET', '/resources/templates');
        const page = await mk('W18 page');
        const moved = await raw('moveResource', 'POST', `/resources/${String(page.id)}/move`, {
          body: { parentId: 'templates' },
        });
        const now = await raw('getResource', 'GET', `/resources/${String(page.id)}`);
        const where = ok2xx(now)
          ? ((now.body?.parentId as unknown) ?? null)
          : `(getResource ${answered(now)})`;
        const moveNote = ok2xx(moved)
          ? `NOTED: the move was accepted (${answered(moved)}): the page reads with parentId ${JSON.stringify(where)}, so the guards' refusal is what keeps a page in the repository`
          : `the move was refused (${answered(moved)}); the page reads with parentId ${JSON.stringify(where)}`;
        if (looked.status !== 404)
          fail(
            `getResource of "templates" answered ${answered(looked)}${
              looked.body !== undefined ? ` (${JSON.stringify(looked.body)})` : ''
            }, not 404: the guards would read "templates" as a page in no lifecycle area. ${moveNote}`,
          );
        return ok2xx(moved)
          ? { verdict: 'noted', detail: `getResource 404; ${moveNote}` }
          : `getResource 404; ${moveNote}`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return [...findings].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

export function formatAssumptionsR2Report(findings: readonly Finding[]): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const count = (v: Verdict) => findings.filter((f) => f.verdict === v && f.id !== 'cleanup').length;
  return [
    '',
    'LK-Bridge sandbox: the newer code’s assumptions about LegendKeeper, round 2 (W1–W18: assets, table rows, nested blocks, events, templates, batch creates, moves)',
    '=================================================================================================================================================================',
    ...findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${count('pass')} PASS, ${count('fail')} FAIL, ${count('inconclusive')} INCONCLUSIVE${count('noted') > 0 ? `, ${count('noted')} NOTED` : ''}`,
    '',
  ].join('\n');
}
