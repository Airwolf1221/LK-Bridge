/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results and tool results are untyped JSON */
/**
 * v3 F3.4 (ADR 0055 decision G), opt-in: the write-scope rehearsal on a REAL sandbox project, run by the owner before
 * raising an agent's profile to scope `write`: `npm run rehearse:write-scope -- --project test` (on the server,
 * `sudo -u lkbridge /opt/lk-bridge/app/deploy/rehearse-write-scope.sh --project test`). It WRITES, then cleans up what
 * it made. Each step prints PASS, FAIL, NOTED (a fact worth knowing, not a failure), INCONCLUSIVE or SKIPPED, with its
 * cost (requests to LegendKeeper).
 *
 * The runtime is the bridge's own code on a temporary database (createSoakRuntime). That database starts as a
 * READ-ONLY copy of the project's settings, repository tree and setting packs from the bridge's database
 * ({@link copyBridgeState}): the rehearsal sees the AI REPOSITORY, the confirmed chronology and the approved pack as the
 * bridge does, without building the tree again (about 1,470 reads on the test world) and without ever writing to the
 * bridge's database. Two temporary principals exist in that temporary database only:
 *
 * - the AGENT: a profile at scope `write` with the default safety rails, as a profile raised to write will have;
 * - a HELPER: scope `write`, rails off, which only makes and removes the throwaway chronology event (only the
 *   chronology tools write the chronology, and they take a principal).
 *
 * Setup (the bridge's own work, never on the Review page): a throwaway page `lk-bridge write-scope <time>` at the top
 * of the AI REPOSITORY, a page under it with a page document of three paragraphs and a PROPERTIES sidebar (Region,
 * Colour), a page to delete; the asset library's tree; and the HELPER's throwaway chronology event, dated like the
 * first dated row of the first age.
 *
 * 1. The agent edits one sentence of the page (read_document, then write_page): a direct write.
 * 2. The agent changes one fact (set_facts Colour): a direct write.
 * 3. The agent fixes the throwaway chronology event (update_timeline_event, its name and description): a direct write.
 * 4. The agent stages an image, then places it (upload_image): a direct write.
 * 5. A pack package is still a proposal by default: the approved version's tool switches (the three create tools:
 *    always propose), and a package-shaped job sent down the same path a package takes (`forceProposal` from the
 *    switch), captured as a proposal, then rejected. A real package is not sent: its tags need the pack's governance
 *    sources, which live in the Arkona project, and the rehearsal never reads another project.
 * Review: the four direct writes are on the Review queue.
 * R1–R4: each is reverted as the owner reverts it (one job, from the journal) and its target read back as it was. R4,
 * the image (decision B5): the asset is neither moved nor hidden and nothing is written to the staging folder; the image
 * is back on the Staging page (its file copied to the bridge's server), and deleting the placed asset is ONE proposal,
 * which the script approves as the owner would.
 * Rails: a delete and an 11-page batch become proposals under the default rails, saying why; both are rejected.
 * Clean-up: pending proposals rejected; the HELPER deletes the chronology event; the throwaway page (cascade) and the
 * image's folder are deleted. A 404 or "already deleted" counts as cleaned (only when a read says so).
 *
 * Every write of the script itself goes through test/sandbox/wait.ts (a write parked for budget or queued is waited
 * for, never sent again), and every agent tool's job is waited for the same way.
 */
import Database from 'better-sqlite3';
import { pino } from 'pino';
import sharp from 'sharp';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { readAgeTable } from '../../src/chronology/table.js';
import type { Db } from '../../src/db/open.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { packToolMode } from '../../src/packs/types.js';
import type { Runtime } from '../../src/runtime.js';
import { SandboxGuardError, type Finding, type Verdict } from './smoke.js';
import type { HttpCounters } from './soak.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';

type Obj = Record<string, any>;

// ================================================================================== the bridge's state, read-only

export interface CopyReport {
  /** The settings copied (their keys). */
  readonly settings: readonly string[];
  /** Repository tree nodes copied. */
  readonly treeNodes: number;
  /** The packs attached to the project, copied with their versions and this project's attachment. */
  readonly packs: readonly string[];
}

/** The repository tree's tables, parents first (the names and links hang on the nodes). */
const TREE_TABLES = ['tree_state', 'tree_nodes', 'tree_names', 'tree_node_links', 'tree_tombstones'] as const;

const columnsOf = (db: Pick<Db, 'prepare'>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Copies, READ-ONLY from the bridge's database (`bridgeDbPath`, opened read-only) into the rehearsal's temporary one:
 * the project's settings, its stored repository tree, and each setting pack attached to it (the pack, every version,
 * and this project's attachment). Refuses (SandboxGuardError) unless the bridge's database has the project registered
 * AND marked as a sandbox: the same guard as resolveSandboxTarget, checked again where the state comes from. The
 * project's key, its other projects, sessions, tokens and audit are never read.
 */
export function copyBridgeState(o: {
  readonly bridgeDbPath: string;
  readonly target: Db;
  readonly projectId: string;
  readonly runtime: Runtime;
}): CopyReport {
  const src = new Database(o.bridgeDbPath, { readonly: true, fileMustExist: true });
  try {
    const project = src.prepare('SELECT settings, is_sandbox FROM projects WHERE id = ?').get(o.projectId) as
      { settings?: string; is_sandbox?: number } | undefined;
    if (!project)
      throw new SandboxGuardError(
        `Refusing to run: project ${o.projectId} is not registered in the bridge's database.`,
      );
    if (project.is_sandbox !== 1)
      throw new SandboxGuardError(
        `Refusing to run: project ${o.projectId} is not marked as a sandbox in the bridge's database.`,
      );
    const pid = o.projectId;
    const copy = (table: string, where: string, params: readonly unknown[]): number => {
      const have = new Set(columnsOf(o.target, table));
      const cols = columnsOf(src, table).filter((c) => have.has(c));
      const rows = src
        .prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`)
        .all(...params) as Obj[];
      const insert = o.target.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      );
      for (const r of rows) insert.run(...cols.map((c): unknown => r[c]));
      return rows.length;
    };
    const packIds = (
      src.prepare('SELECT pack_id FROM pack_projects WHERE project_id = ?').all(pid) as { pack_id: string }[]
    ).map((r) => r.pack_id);
    let treeNodes = 0;
    o.target.transaction(() => {
      // The tree first, then the settings that name its root (a changed root would discard the stored tree).
      for (const t of [...TREE_TABLES].reverse())
        o.target.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(pid);
      for (const t of TREE_TABLES) {
        const n = copy(t, 'project_id = ?', [pid]);
        if (t === 'tree_nodes') treeNodes = n;
      }
      for (const id of packIds) {
        // The temporary runtime seeded its own copy at start: the bridge's, as the owner approved it, replaces it.
        o.target.prepare('DELETE FROM pack_projects WHERE pack_id = ?').run(id);
        o.target.prepare('DELETE FROM pack_versions WHERE pack_id = ?').run(id);
        o.target.prepare('DELETE FROM packs WHERE id = ?').run(id);
        copy('packs', 'id = ?', [id]);
        copy('pack_versions', 'pack_id = ?', [id]);
        copy('pack_projects', 'pack_id = ? AND project_id = ?', [id, pid]);
      }
      o.target.prepare('UPDATE projects SET settings = ? WHERE id = ?').run(project.settings ?? '{}', pid);
    })();
    o.runtime.projects.refresh();
    const settings = Object.keys(JSON.parse(project.settings ?? '{}') as Obj).sort();
    return { settings, treeNodes, packs: packIds };
  } finally {
    src.close();
  }
}

// ================================================================================== the rehearsal

export interface RehearsalTarget {
  readonly runtime: Runtime;
  /** The runtime's own temporary database (the temporary principals are made there only). */
  readonly db: Db;
  readonly projectId: string;
  /** The bridge's name for the project (the tools' `project`). */
  readonly projectName: string;
  readonly counters: HttpCounters;
}

export interface RehearsalOptions {
  readonly wait?: WaitOptions;
  /** Progress lines (the script prints them). */
  readonly log?: (line: string) => void;
}

export interface RehearsalReport {
  readonly findings: Finding[];
  /** No step failed (NOTED, SKIPPED and INCONCLUSIVE are reported, not failures). */
  readonly passed: boolean;
}

class Fails extends Error {}
class Unclear extends Error {}
class Skip extends Error {}
class Noted extends Error {}

const PROPERTY = 'PROPERTIES';
const SENTENCES = [
  'The rehearsal page holds three short paragraphs.',
  'The second paragraph is the one the agent edits.',
  'The third stays exactly as it is.',
] as const;
const EDITED = 'The second paragraph was edited at scope write.';

/** The text of a block's runs (a paragraph's, a row's value). */
const textOf = (runs: unknown): string =>
  Array.isArray(runs) ? (runs as Obj[]).map((r) => (typeof r.text === 'string' ? r.text : '')).join('') : '';

/** A sidebar row's value: its runs (`content`, which wins over `text` in LegendKeeper), else its plain text. */
const rowText = (row: Obj): string =>
  Array.isArray(row.content) ? textOf(row.content) : typeof row.text === 'string' ? row.text : '';

/** A small PNG (the image the agent stages and places). */
async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 160, g: 90, b: 30 } } })
    .png()
    .toBuffer();
}

export async function runWriteScopeRehearsal(
  t: RehearsalTarget,
  o: RehearsalOptions = {},
): Promise<RehearsalReport> {
  const rt = t.runtime;
  const pid = t.projectId;
  const wait: WaitOptions = o.wait ?? {};
  const log = o.log ?? (() => undefined);
  const findings: Finding[] = [];
  const origin = { kind: 'test' as const, client: 'rehearse-write-scope', tool: 'rehearse-write-scope' };
  const mark = () => ({ r: t.counters.reads, w: t.counters.writes });
  const costText = (b: { r: number; w: number }) =>
    `cost: ${t.counters.reads - b.r} reads, ${t.counters.writes - b.w} writes`;
  const record = (id: string, title: string, verdict: Verdict, detail: string) => {
    findings.push({ id, title, verdict, detail });
    log(`${verdict.toUpperCase()} (${id}) ${title}`);
  };
  /** Runs one step; a thrown Fails is FAIL, Skip SKIPPED, Noted NOTED, Unclear or anything else INCONCLUSIVE. */
  const check = async (id: string, title: string, fn: () => Promise<string> | string): Promise<boolean> => {
    const before = mark();
    try {
      record(id, title, 'pass', `${await fn()}; ${costText(before)}`);
      return true;
    } catch (e) {
      const verdict: Verdict =
        e instanceof Fails
          ? 'fail'
          : e instanceof Skip
            ? 'skipped'
            : e instanceof Noted
              ? 'noted'
              : 'inconclusive';
      const why =
        e instanceof Fails || e instanceof Skip || e instanceof Noted || e instanceof Unclear
          ? e.message
          : `could not complete: ${(e as Error).message}`;
      record(id, title, verdict, `${why}; ${costText(before)}`);
      return false;
    }
  };
  /** One governed operation of the script itself (never an agent's), at P1, settled (wait.ts). */
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid, ...extra },
      wait,
    );
  const attempt = async (op: string, params: Obj = {}, extra: Obj = {}) => {
    try {
      return { ok: true as const, body: await run(op, params, extra) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  };
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // ---------------------------------------------------------------------------------------------- the principals
  const pats = new PatService({
    store: new AuthStore(t.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const principal = (label: string, railsOff: boolean): Principal => {
    const profile = rt.policy.commands.createProfile('owner', { label, kind: 'other', scope: 'write' });
    if (railsOff)
      rt.policy.commands.setRails('owner', profile.id, {
        deletes: false,
        bulk: false,
        renamesMoves: false,
        assets: false,
      });
    const created = pats.create({ name: label, profileId: profile.id, expiresInDays: 1 });
    const found = rt.policy.store.lookupPrincipal(created.pat.id);
    if (!found) throw new Error(`the temporary principal ${label} could not be resolved`);
    return found.principal;
  };

  // ---------------------------------------------------------------------------------------------- the tools
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  /** Calls a tool as the bridge's MCP server would, at scope write, for `who`; returns its JSON and error flag. */
  const tool = async (who: Principal, name: string, args: Obj): Promise<{ body: Obj; text: string }> => {
    const provider = rt.tools.find((x) => x.name === name);
    if (!provider) throw new Error(`the bridge has no tool ${name}`);
    const parsed = provider.inputSchema.safeParse({ project: t.projectName, ...args });
    if (!parsed.success) throw new Error(`${name}: the arguments were refused: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: who,
      scope: 'write',
      showLowLevelTools: true,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const lines = text.split('\n');
    let body: Obj;
    try {
      body = JSON.parse(lines.slice(0, -1).join('\n')) as Obj;
    } catch {
      try {
        body = JSON.parse(text) as Obj;
      } catch {
        body = { text };
      }
    }
    if (res.isError === true) {
      const err = body.error as Obj | undefined;
      throw new Fails(`${name} answered ${String(err?.code ?? 'an error')}: ${String(err?.message ?? text)}`);
    }
    return { body, text };
  };
  /** A tool's write that must run directly (not a proposal), waited for; returns its job id. */
  const direct = async (who: Principal, name: string, args: Obj): Promise<{ jobId: string; body: Obj }> => {
    const { body } = await tool(who, name, args);
    if (body.status === 'proposal_captured')
      throw new Fails(
        `${name} became a proposal (${String(body.proposedBecause ?? 'no reason given')}), not a direct write`,
      );
    const jobId = typeof body.jobId === 'string' ? body.jobId : null;
    if (!jobId) throw new Fails(`${name} started no job (status ${String(body.status)})`);
    await waitForJob(rt.engine, pid, jobId, name, wait);
    return { jobId, body };
  };
  /** A tool's write that must become a proposal; returns the proposal's id and the reason it gives. */
  const proposed = async (who: Principal, name: string, args: Obj) => {
    const { body } = await tool(who, name, args);
    if (body.status !== 'proposal_captured') {
      if (typeof body.jobId === 'string') pending.jobs.push(body.jobId);
      throw new Fails(`${name} was not proposed: status ${String(body.status)}`);
    }
    const proposalId = String(body.proposalId);
    pending.proposals.push(proposalId);
    return { proposalId, because: typeof body.proposedBecause === 'string' ? body.proposedBecause : null };
  };
  const reject = (proposalId: string): void => {
    const p = rt.policy.proposals.get(proposalId);
    if (p?.state === 'pending')
      rt.policy.commands.reject('owner', proposalId, 'write-scope rehearsal: not wanted');
    pending.proposals = pending.proposals.filter((x) => x !== proposalId);
  };

  // ---------------------------------------------------------------------------------------------- state
  const base = `lk-bridge write-scope ${stamp}`;
  const pending = { proposals: [] as string[], jobs: [] as string[] };
  const made = { root: '', page: '', doc: '', deleteMe: '' };
  const chron: {
    ready: boolean;
    date: string;
    name: string;
    description: string;
    resourceId: string;
    tableDoc: string;
    timelineDoc: string;
    eventId: string;
    columns: { event: string; date: string; kcy: string } | null;
    made: boolean;
  } = {
    ready: false,
    date: '',
    name: `lk-bridge rehearsal ${stamp}`,
    description: `lk-bridge write-scope rehearsal ${stamp}: a throwaway event`,
    resourceId: '',
    tableDoc: '',
    timelineDoc: '',
    eventId: '',
    columns: null,
    made: false,
  };
  const fixedName = `${chron.name} (fixed)`;
  const fixedDescription = `${chron.description} (fixed)`;
  const image = { stagedId: '', assetId: '', jobId: '', folderId: null as string | null };
  const jobs: Record<'1' | '2' | '3' | '4', string> = { '1': '', '2': '', '3': '', '4': '' };
  const who: { agent?: Principal; helper?: Principal } = {};

  // ---------------------------------------------------------------------------------------------- read-backs
  /** The proposal a revert of `jobId` made to delete a placed image (the revert's audit records it), or null. */
  function deletionProposal(jobId: string): string | null {
    for (const a of rt.policy.store.listAudit({ action: 'job.revert', limit: 50 })) {
      const after = a.after as { outcome?: string; images?: { deletionProposalId?: string | null }[] } | null;
      if (a.target !== jobId || after?.outcome !== 'images') continue;
      return after.images?.find((x) => typeof x.deletionProposalId === 'string')?.deletionProposalId ?? null;
    }
    return null;
  }
  async function factValue(key: string): Promise<string> {
    const props = await run('listProperties', { path: { resourceId: made.page } });
    const kv = ((props?.data ?? []) as Obj[]).find((p) => p.kind === 'keyValue' && p.title === PROPERTY);
    const row = ((kv?.rows ?? []) as Obj[]).find((r) => r.key === key);
    return row ? rowText(row) : '(no row)';
  }
  async function chronologyState(): Promise<{ rowDescriptions: string[]; eventName: string }> {
    const blocks = await run('getDocumentBlocks', {
      path: { resourceId: chron.resourceId, documentId: chron.tableDoc },
    });
    const cal = rt.chronology.calendar(pid);
    const cfg = rt.chronology.config(pid);
    const table =
      cal && chron.columns
        ? readAgeTable((blocks?.blocks ?? []) as unknown[], cal.parser, cfg.style.date, cfg.columns)
        : null;
    const rowDescriptions = (table?.rows ?? [])
      .map((r) => r.description)
      .filter((d) => d.startsWith(chron.description));
    const event = await run('getEvent', {
      path: { resourceId: chron.resourceId, documentId: chron.timelineDoc, eventId: chron.eventId },
    });
    return { rowDescriptions, eventName: String(event?.name ?? '') };
  }

  try {
    // ============================================================================================ setup
    const setupOk = await check(
      'setup',
      'a throwaway page with text and facts, a page to delete, the asset tree, two temporary principals',
      async () => {
        const settings = rt.projects.find(pid)?.settings ?? {};
        const repoRoot = settings.aiRepositoryRootId;
        if (!repoRoot)
          throw new Unclear(
            'the project has no AI REPOSITORY root in its settings: set it on the dashboard (Projects) first',
          );
        if (!rt.tree.queries.node(pid, repoRoot).data)
          throw new Unclear(
            'the repository tree is not built on the bridge yet: build it on the dashboard (Repository tree) first',
          );
        who.agent = principal(`rehearsal agent ${stamp}`, false);
        who.helper = principal(`rehearsal helper ${stamp}`, true);
        const root = await run('createResource', { body: { name: base, parentId: repoRoot } });
        made.root = String(root.id);
        const page = await run('createResource', { body: { name: `${base} page`, parentId: made.root } });
        made.page = String(page.id);
        const doc = await run('createDocument', {
          path: { resourceId: made.page },
          body: { name: 'Rehearsal text', type: 'page' },
        });
        made.doc = String(doc.id);
        await run('replaceDocumentBlocks', {
          path: { resourceId: made.page, documentId: made.doc },
          body: { blocks: SENTENCES.map((s) => ({ kind: 'paragraph', content: [{ text: s }] })) },
        });
        await run('createProperty', {
          path: { resourceId: made.page },
          body: {
            kind: 'keyValue',
            title: PROPERTY,
            rows: [
              { key: 'Region', text: 'North' },
              { key: 'Colour', text: 'Blue' },
            ],
          },
        });
        const del = await run('createResource', { body: { name: `${base} delete me`, parentId: made.root } });
        made.deleteMe = String(del.id);
        // The asset library's tree (the image's destination is planned from it): about one read per 100 assets.
        rt.assets.prepareBuild(pid, { trigger: 'rehearse-write-scope', autoConfirm: true });
        for (let i = 0; i < 1200 && rt.assets.store.activePass(pid); i++) await sleep(500);
        return `root ${made.root}, page ${made.page} (document ${made.doc}, ${PROPERTY} Region and Colour), page to delete ${made.deleteMe}`;
      },
    );
    if (!setupOk || !who.agent || !who.helper) return { findings, passed: false };
    const a: Principal = who.agent;
    const h: Principal = who.helper;

    // The chronology fixture (the HELPER): dated like the first dated row of the first age that has one.
    await check('setup-chronology', 'a throwaway chronology event (the helper, rails off)', async () => {
      const ready = rt.chronology.readiness(pid);
      if (!ready.ok) throw new Skip(`the chronology tools refuse here (${ready.code}): ${ready.message}`);
      const cfg = ready.config;
      const cals = await run('listCalendars', {});
      const def = ((cals?.data ?? []) as Obj[]).find((c) => c.id === cfg.calendarId);
      if (!def) throw new Unclear(`the chronology's calendar ${String(cfg.calendarId)} was not found`);
      const cal = rt.chronology.remember(pid, def);
      for (const age of cfg.ages) {
        const blocks = await run('getDocumentBlocks', {
          path: { resourceId: cfg.resourceId, documentId: age.tableDocumentId },
        });
        const table = readAgeTable(
          (blocks?.blocks ?? []) as unknown[],
          cal.parser,
          cfg.style.date,
          cfg.columns,
        );
        const row = table?.rows.find((r) => r.date !== null && r.dateText.trim().length > 0);
        if (row) {
          chron.date = row.dateText.trim();
          chron.resourceId = cfg.resourceId!;
          chron.tableDoc = age.tableDocumentId;
          chron.timelineDoc = age.timelineDocumentId;
          chron.columns = cfg.columns;
          break;
        }
      }
      if (!chron.date) throw new Skip('no age table has a dated row to date the throwaway event by');
      const made1 = await direct(h, 'create_timeline_event', {
        date: chron.date,
        name: chron.name,
        description: chron.description,
      });
      chron.made = true;
      const steps = rt.engine.stepRecords(pid, made1.jobId) ?? [];
      const create = steps.find((s) => s.opId === 'createEvent');
      chron.eventId = String((create?.params as Obj | undefined)?.body?.id ?? '');
      if (!chron.eventId) throw new Unclear('the new event’s id was not found in its job');
      chron.ready = true;
      return `“${chron.name}” dated ${chron.date} (event ${chron.eventId})`;
    });

    // ============================================================================================ 1-4: direct writes
    await check(
      '1',
      'the agent edits one sentence of a page (read_document, then write_page): direct',
      async () => {
        const read = await tool(a, 'read_document', { resource: made.page, document: made.doc });
        const markdown = String(read.body.markdown ?? '');
        if (!markdown.includes(SENTENCES[1]))
          throw new Unclear(`the page reads back as: ${markdown.slice(0, 200)}`);
        const r = await direct(a, 'write_page', {
          page: made.page,
          document: made.doc,
          mode: 'replace',
          markdown: markdown.replace(SENTENCES[1], EDITED),
          ...(typeof read.body.version === 'string' ? { baseVersion: read.body.version } : {}),
        });
        jobs['1'] = r.jobId;
        const now = await run('getDocumentBlocks', { path: { resourceId: made.page, documentId: made.doc } });
        const texts = ((now?.blocks ?? []) as Obj[]).map((b) => textOf(b.content));
        if (JSON.stringify(texts) !== JSON.stringify([SENTENCES[0], EDITED, SENTENCES[2]]))
          throw new Fails(`the page reads back as ${JSON.stringify(texts)}`);
        return `job ${r.jobId}: one paragraph changed, the other two as they were`;
      },
    );

    await check('2', 'the agent changes one fact (set_facts): direct', async () => {
      const r = await direct(a, 'set_facts', {
        page: made.page,
        property: PROPERTY,
        facts: { Colour: 'Green' },
      });
      jobs['2'] = r.jobId;
      const colour = await factValue('Colour');
      if (colour !== 'Green') throw new Fails(`Colour reads back as “${colour}”`);
      return `job ${r.jobId}: Colour Blue → Green`;
    });

    await check(
      '3',
      'the agent fixes a chronology event (update_timeline_event, row and event in step): direct',
      async () => {
        if (!chron.ready) throw new Skip('no throwaway chronology event (see setup-chronology)');
        const r = await direct(a, 'update_timeline_event', {
          event: { date: chron.date, description: chron.description },
          name: fixedName,
          description: fixedDescription,
        });
        jobs['3'] = r.jobId;
        const now = await chronologyState();
        if (!now.rowDescriptions.includes(fixedDescription) || now.eventName !== fixedName)
          throw new Fails(`the row and event read back as ${JSON.stringify(now)}`);
        return `job ${r.jobId}: the row’s description and the event’s name changed together`;
      },
    );

    await check('4', 'the agent stages an image, then places it (upload_image): direct', async () => {
      const bytes = await png();
      const staged = await tool(a, 'upload_image', {
        data_base64: bytes.toString('base64'),
        name: `${base}.png`,
        stage: true,
        destination: { folder: [base] },
      });
      if (staged.body.status !== 'staged') throw new Fails(`staging answered ${String(staged.body.status)}`);
      image.stagedId = String(staged.body.staged_id);
      const placed = await tool(a, 'upload_image', { staged_id: image.stagedId });
      if (placed.body.status === 'proposal_captured')
        throw new Fails(`the placement became a proposal (${String(placed.body.proposedBecause ?? '')})`);
      const row = rt.images.staged(pid, image.stagedId);
      image.jobId = row?.placementJobId ?? (typeof placed.body.jobId === 'string' ? placed.body.jobId : '');
      if (!image.jobId)
        throw new Fails(`the placement started no job (status ${String(placed.body.status)})`);
      await waitForJob(rt.engine, pid, image.jobId, 'the placement', wait);
      jobs['4'] = image.jobId;
      image.assetId = rt.images.staged(pid, image.stagedId)?.assetId ?? '';
      if (!image.assetId) throw new Fails('the placed image has no asset');
      const asset = await run('getAsset', { path: { assetId: image.assetId } });
      if (asset?.isHidden === true) throw new Fails('the placed image is still hidden');
      image.folderId = typeof asset?.folderId === 'string' ? asset.folderId : null;
      return `job ${image.jobId}: asset ${image.assetId} placed in “${base}”`;
    });

    // ============================================================================================ 5: a package
    await check('5', 'a pack package is still a proposal by default', async () => {
      const attached = rt.packs.forProject(pid);
      if (attached.length === 0) throw new Noted('no setting pack is attached to this project');
      const pack = attached[0]!;
      if (pack.approved?.version !== pack.version)
        throw new Noted(
          `the ${pack.name} pack's current version (${pack.version}) is not approved yet (approved: ${String(pack.approved?.version ?? 'none')}): approve it on the Packs page, then run again`,
        );
      const modes = Object.fromEntries(
        ['create_character', 'create_owner', 'create_relationship', 'add_character_art', 'appraisal_fix'].map(
          (x) => [`${pack.id}_${x}`, packToolMode(pack.rules, `${pack.id}_${x}`)],
        ),
      );
      const creates = ['create_character', 'create_owner', 'create_relationship'].map(
        (x) => `${pack.id}_${x}`,
      );
      const off = creates.filter((x) => modes[x] !== 'propose');
      if (off.length > 0) throw new Fails(`these package tools follow the agent's scope: ${off.join(', ')}`);
      // The same path a package takes: the switch decides forceProposal, at scope write.
      const r = await rt.engine.submit({
        kind: 'batch_ops',
        project: pid,
        steps: [
          {
            op: 'createResource',
            params: { body: { name: `${base} package (never made)`, parentId: made.root } },
          },
        ],
        origin: { kind: 'mcp', tool: creates[0]!, principal: a },
        title: `${creates[0]!}: a rehearsal package (never made)`,
        forceProposal: modes[creates[0]!] === 'propose',
      });
      if (r.status !== 'proposal_captured') {
        if ('jobId' in r) pending.jobs.push(r.jobId);
        throw new Fails(`the package-shaped job was not proposed: status ${String(r.status)}`);
      }
      pending.proposals.push(r.proposalId);
      reject(r.proposalId);
      return `version ${pack.version} approved; ${Object.entries(modes)
        .map(([k, v]) => `${k}: ${v === 'propose' ? 'always propose' : 'follows scope'}`)
        .join(
          ', ',
        )}; a package-shaped job at scope write was captured as a proposal (then rejected). A real package is not sent: its tags need the governance sources in the Arkona project, which this script never reads`;
    });

    // ============================================================================================ the Review queue
    await check('review', 'the direct writes are on the Review queue', () => {
      const wanted = Object.entries(jobs).filter(([, id]) => id);
      if (wanted.length === 0) throw new Skip('no direct write ran');
      const listed = new Set(
        rt.review
          .list(pid, { state: 'unreviewed', principalId: a.principalId, limit: 200 })
          .map((i) => i.jobId),
      );
      const missing = wanted.filter(([, id]) => !listed.has(id)).map(([k]) => `step ${k}`);
      if (missing.length > 0) throw new Fails(`not on the Review queue: ${missing.join(', ')}`);
      return `${wanted.length} unreviewed, as the agent ran them`;
    });

    // ============================================================================================ R1-R4: reverts
    const revert = async (step: '1' | '2' | '3' | '4'): Promise<string> => {
      const jobId = jobs[step];
      if (!jobId) throw new Skip(`step ${step} did not run`);
      const r = await rt.reverts.revert('owner', pid, jobId);
      if (r.status !== 'submitted')
        throw new Fails(
          `the revert was refused: ${r.code}: ${r.message} (${r.targets.map((x) => `${x.what}: ${x.state}`).join('; ')})`,
        );
      await waitForJob(rt.engine, pid, r.revertJobId, `the revert of step ${step}`, wait);
      return r.revertJobId;
    };
    await check('R1', 'Revert puts the page text back as it was', async () => {
      const id = await revert('1');
      const now = await run('getDocumentBlocks', { path: { resourceId: made.page, documentId: made.doc } });
      const texts = ((now?.blocks ?? []) as Obj[]).map((b) => textOf(b.content));
      if (JSON.stringify(texts) !== JSON.stringify(SENTENCES))
        throw new Fails(`the page reads back as ${JSON.stringify(texts)}`);
      return `revert job ${id}: the three paragraphs read back as before`;
    });
    await check('R2', 'Revert puts the fact back as it was', async () => {
      const id = await revert('2');
      const colour = await factValue('Colour');
      if (colour !== 'Blue') throw new Fails(`Colour reads back as “${colour}”`);
      return `revert job ${id}: Colour is Blue again`;
    });
    await check('R3', 'Revert puts the chronology row and its event back as they were, in step', async () => {
      const id = await revert('3');
      const now = await chronologyState();
      if (!now.rowDescriptions.includes(chron.description) || now.rowDescriptions.includes(fixedDescription))
        throw new Fails(`the row reads back as ${JSON.stringify(now.rowDescriptions)}`);
      if (now.eventName !== chron.name) throw new Fails(`the event is named “${now.eventName}”`);
      return `revert job ${id}: the row’s description and the event’s name are as they were`;
    });
    await check(
      'R4',
      'Revert puts the placed image back on the Staging page and proposes deleting it; nothing goes to the staging folder',
      async () => {
        const id = await revert('4');
        // The bridge's follow-up comes right after the revert job: the staged record, then the deletion proposal.
        let proposalId: string | null = null;
        for (let i = 0; i < 300 && !proposalId; i++) {
          proposalId = deletionProposal(jobs['4']);
          if (!proposalId) await sleep(100);
        }
        const asset = await run('getAsset', { path: { assetId: image.assetId } });
        if (!asset?.id || asset.deletedAt) throw new Fails('the asset is gone: a revert never deletes it');
        if (asset.isHidden === true) throw new Fails('the asset was hidden');
        if ((typeof asset.folderId === 'string' ? asset.folderId : null) !== image.folderId)
          throw new Fails(`the asset was moved (to folder ${String(asset.folderId)})`);
        const row = rt.images.staged(pid, image.stagedId);
        if (row?.staged !== true || !row.serverSha256 || row.assetId !== null)
          throw new Fails('the image is not back on the Staging page from the bridge’s server');
        if (!proposalId) throw new Fails('no proposal to delete the placed image');
        const p = rt.policy.proposals.detail(proposalId);
        if (p?.state !== 'pending' || p.ops.map((o) => o.op).join(',') !== 'deleteAsset')
          throw new Fails(
            `the deletion proposal is not as expected: ${JSON.stringify(p?.ops.map((o) => o.op))}`,
          );
        // As the owner does on the Proposals page: approve it (the asset's bytes are kept first, as for every delete).
        await rt.policy.commands.approve('owner', proposalId);
        let state = rt.policy.proposals.get(proposalId)?.state;
        for (let i = 0; i < 600 && !['executed', 'failed', 'conflicted'].includes(state ?? ''); i++) {
          await sleep(100);
          state = rt.policy.proposals.get(proposalId)?.state;
        }
        const jobOfDelete = rt.policy.proposals.get(proposalId)?.jobId;
        if (state !== 'executed' || !jobOfDelete)
          throw new Fails(`the approved deletion ended ${String(state)}`);
        await waitForJob(rt.engine, pid, jobOfDelete, 'the approved deletion', wait);
        const after = await attempt('getAsset', { path: { assetId: image.assetId } });
        if (after.ok && after.body?.deletedAt == null)
          throw new Fails('the approved deletion did not delete the image');
        return `revert job ${id}: the image is back on the Staging page (its file on the bridge’s server), nothing written to the staging folder; proposal ${proposalId} deleted the placed image once approved`;
      },
    );

    // ============================================================================================ the rails
    await check('rail-delete', 'a delete becomes a proposal under the default rails', async () => {
      const p = await proposed(a, 'delete_resource', { page: made.deleteMe, confirm: true });
      if (!p.because?.includes('delete'))
        throw new Fails(`proposed, but not by the rail: ${String(p.because)}`);
      reject(p.proposalId);
      const still = await attempt('getResource', { path: { resourceId: made.deleteMe } });
      if (!still.ok || still.body?.deletedAt) throw new Fails('the page was deleted');
      return `${p.because} (rejected; the page is still there)`;
    });
    await check('rail-bulk', 'an 11-page batch becomes a proposal under the default rails', async () => {
      const p = await proposed(a, 'lk_api_batch', {
        calls: Array.from({ length: 11 }, (_, i) => ({
          operationId: 'createResource',
          params: { body: { name: `${base} batch ${i + 1}`, parentId: made.root } },
        })),
      });
      if (p.because !== 'proposed because: bulk change (11 pages > 10)')
        throw new Fails(`proposed, but not by the bulk rail: ${String(p.because)}`);
      reject(p.proposalId);
      return `${p.because} (rejected; nothing made)`;
    });
  } finally {
    // ============================================================================================ clean-up
    await check('cleanup', 'everything the rehearsal made is removed', async () => {
      const left: string[] = [];
      // A proposal lives in the temporary database only (nothing of it is in LegendKeeper): rejected, or gone with it.
      for (const id of [...pending.proposals]) {
        try {
          reject(id);
        } catch {
          // Gone with the temporary database.
        }
      }
      for (const id of pending.jobs) await rt.engine.wait(pid, id, 30_000).catch(() => undefined);
      if (chron.made && who.helper) {
        let answer: Obj;
        try {
          answer = (
            await tool(who.helper, 'delete_timeline_event', {
              event: { date: chron.date, description: chron.description },
              confirm: true,
            })
          ).body;
        } catch (e) {
          answer = { error: (e as Error).message };
        }
        const jobId = typeof answer.jobId === 'string' ? answer.jobId : null;
        if (jobId) {
          await waitForJob(rt.engine, pid, jobId, 'the chronology clean-up', wait).catch((e: Error) =>
            left.push(`chronology event “${chron.name}” (${e.message})`),
          );
        } else left.push(`chronology event “${chron.name}” dated ${chron.date} (${JSON.stringify(answer)})`);
      }
      /** After a refused delete: gone only when a read says so (404, or deleted), never from the message's words. */
      const gone = async (op: 'getResource' | 'getAsset', path: Obj): Promise<boolean> => {
        const r = await attempt(op, { path });
        return r.ok ? r.body?.deletedAt != null : /\b404\b|NOT_FOUND/.test(r.error);
      };
      if (made.root) {
        const r = await attempt(
          'deleteResource',
          { path: { resourceId: made.root }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
        if (!r.ok && !(await gone('getResource', { resourceId: made.root })))
          left.push(`page ${made.root} and the pages under it (${r.error})`);
      }
      // The image's folder (the destination the placement made), then the image itself, if it is still somewhere.
      for (const name of [base]) {
        const folder = rt.assets.queries.foldersByPath(pid, [name]).data[0];
        if (!folder) continue;
        const r = await attempt('deleteAsset', { path: { assetId: folder.id } });
        if (!r.ok && !(await gone('getAsset', { assetId: folder.id })))
          left.push(`asset folder “${name}” and what is in it (${r.error})`);
      }
      if (image.assetId && !(await gone('getAsset', { assetId: image.assetId }))) {
        const r = await attempt('deleteAsset', { path: { assetId: image.assetId } });
        if (!r.ok && !(await gone('getAsset', { assetId: image.assetId })))
          left.push(`image ${image.assetId} (${r.error})`);
      }
      if (left.length > 0) throw new Fails(`left behind, delete by hand: ${left.join('; ')}`);
      return `root ${made.root || '(none)'} with its pages, the run's asset folders${chron.made ? ', the chronology event' : ''}`;
    });
  }
  return { findings, passed: !findings.some((f) => f.verdict === 'fail') };
}

export function formatRehearsalReport(r: RehearsalReport, counters: HttpCounters): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const n = (v: Verdict) => r.findings.filter((f) => f.verdict === v).length;
  return [
    '',
    'LK-Bridge sandbox: the write-scope rehearsal (docs/adr/0055-write-scope-review-revert-rails.md)',
    '==============================================================================================',
    ...r.findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${n('pass')} PASS, ${n('fail')} FAIL, ${n('inconclusive')} INCONCLUSIVE, ${n('skipped')} SKIPPED, ${n('noted')} NOTED`,
    `requests to LegendKeeper: ${counters.reads} reads, ${counters.writes} writes`,
    '',
  ].join('\n');
}
