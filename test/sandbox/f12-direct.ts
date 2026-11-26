/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results and tool results are untyped JSON */
/**
 * v3 F12 (ADR 0081), opt-in, WRITES then cleans up: an agent at scope `write` makes canon and lifecycle changes and
 * deletes directly, each on the owner's Review page, and Revert brings a delete back from the copy kept before it.
 * Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f12-direct
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance,
 * when the pack is attached, is pointed in the TEMPORARY database only at a throwaway governance page under the check's
 * own index (`ensureSandboxGovernance`). Two temporary principals exist there only: an AGENT at scope `write` and a
 * PROPOSER at scope `propose` (so the proposal path stays covered). Each step reports PASS or FAIL:
 *
 * - **D0** a throwaway index `[INDEX] lk-bridge f12 check <time>` at the top of the AI REPOSITORY; a throwaway Working
 *   page `[BWRK] lk-bridge f12 page <time>` under `[INDEX] Working` with PROPERTIES (Status Working, Continuity Type
 *   CANON, Continuity Main); a page to delete with one child under the index; a throwaway asset folder;
 * - **D1** the agent promotes the Working page into the throwaway index (`promote_page`): direct (a job, no proposal),
 *   read back `[BSRC]`, and on the Review page;
 * - **D2** the agent takes CANON off it (`set_facts` Continuity Type `AU`), then puts it back (`CANON`): both direct,
 *   read back, both on the Review page;
 * - **D3** the agent deletes the page with its child (`delete_resource`, cascade): direct, the copy of both pages kept
 *   (`delete_copies`); the owner's Revert from the Review page: both pages back, read live;
 * - **D4** the agent uploads a tiny image into the throwaway folder (`lk_upload_image`), then deletes it (`lk_api_write`
 *   `deleteAsset`): direct, its bytes kept; the owner's Revert: an asset of the same name back in the folder, read live;
 * - **D5** the PROPOSER's write (`set_facts` on the promoted page) is a proposal (then rejected): the proposal path.
 *
 * Clean-up: the throwaway index deleted with everything under it (the promoted page, the governance page, what Revert
 * brought back), the asset folder with what is in it, even after a failure, and again from the test file's `afterAll`.
 * Cost: about 40 writes and 120 reads.
 */
import { pino } from 'pino';
import sharp from 'sharp';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { mintClientId, type Principal } from '../../src/jobs/index.js';
import { lifecycleFrom } from '../../src/lifecycle/settings.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { ProjectStore } from '../../src/projects/index.js';
import { treeSettingsFrom } from '../../src/tree/index.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;

export interface F12CheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

export async function runF12Check(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<F12CheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f12-direct', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const wait = o.wait ?? {};
  const items: F12CheckItem[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  copyBridgeState({ bridgeDbPath: o.bridgeDbPath, target: sb.db, projectId: pid, runtime: rt });
  const settings = (new ProjectStore(sb.db).byId(pid)?.settings ?? {}) as Obj;
  const rootId = typeof settings.aiRepositoryRootId === 'string' ? settings.aiRepositoryRootId : null;
  const lifecycle = lifecycleFrom(settings);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const made: { index: string | null; folder: string | null; page: string; doomed: string; child: string } = {
    index: null,
    folder: null,
    page: '',
    doomed: '',
    child: '',
  };
  steps.defer('the throwaway index and asset folder deleted', async () => {
    const problems: string[] = [];
    for (const [what, id, del] of [
      // Deepest first: the pages a Revert brought back (LegendKeeper's restore) are under the index again.
      ['child page', made.child, () => deleteProbe(raw, made.child)],
      ['deleted page', made.doomed, () => deleteProbe(raw, made.doomed)],
      ['index', made.index, () => deleteProbe(raw, made.index!)],
      ['page', made.page, () => deleteProbe(raw, made.page)],
      ['folder', made.folder, () => raw.request('deleteAsset', 'DELETE', `/assets/${made.folder}`)],
    ] as const) {
      if (!id) continue;
      try {
        await del();
      } catch (e) {
        if (!/404|NOT_FOUND|ALREADY_DELETED/.test((e as Error).message))
          problems.push(`${what} ${id}: ${(e as Error).message}`);
      }
    }
    if (problems.length > 0) {
      items.push({
        id: 'cleanup',
        title: 'the throwaway pages and folder deleted',
        verdict: 'fail',
        detail: `${problems.join('; ')}. Delete them by hand.`,
      });
      throw new Error(problems.join('; '));
    }
    items.push({
      id: 'cleanup',
      title: 'the throwaway pages and folder deleted',
      verdict: 'pass',
      detail: 'nothing left',
    });
  });

  // ------------------------------------------------------------------------------------------ the script's own writes
  const origin = { kind: 'test' as const, client: 'sandbox-f12', tool: 'sandbox-f12' };
  const run = async (op: string, params: Obj = {}): Promise<any> =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid },
      wait,
    );
  const read = async (op: string, params: Obj = {}): Promise<any> => {
    try {
      return await run(op, params);
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------------------------------------ the principals
  const pats = new PatService({
    store: new AuthStore(sb.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const principal = (label: string, scope: 'write' | 'propose'): Principal => {
    const profile = rt.policy.commands.createProfile('owner', { label, kind: 'other', scope });
    const created = pats.create({ name: label, profileId: profile.id, expiresInDays: 1 });
    const found = rt.policy.store.lookupPrincipal(created.pat.id);
    if (!found) throw new Error(`the temporary principal ${label} could not be resolved`);
    return found.principal;
  };
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (who: Principal, scope: string, toolName: string, args: Obj): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === toolName);
    if (!provider) throw new Error(`the bridge has no tool ${toolName}`);
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${toolName}: the arguments were refused: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: who,
      scope,
      showLowLevelTools: true,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const lines = text.split('\n');
    try {
      return JSON.parse(lines.slice(0, -1).join('\n')) as Obj;
    } catch {
      try {
        return JSON.parse(text) as Obj;
      } catch {
        return { text };
      }
    }
  };
  /** A write that must run directly: its job, settled and succeeded, and on the Review page. */
  const direct = async (who: Principal, toolName: string, args: Obj): Promise<string> => {
    const body = await tool(who, 'write', toolName, args);
    if (body.status === 'proposal_captured')
      throw new Error(
        `${toolName} became a proposal at scope write (${String(body.reason ?? body.hint ?? '')})`,
      );
    if (body.error) throw new Error(`${toolName} was refused: ${JSON.stringify(body.error)}`);
    const jobId = typeof body.jobId === 'string' ? body.jobId : String(body.job?.id ?? '');
    if (!jobId) throw new Error(`${toolName} started no job (status ${String(body.status)})`);
    const job = await waitForJob(rt.engine, pid, jobId, toolName, wait);
    if (job.status !== 'succeeded')
      throw new Error(`${toolName}: job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
    const listed = rt.review.list(pid, { state: 'all', limit: 500 }).some((i) => i.jobId === jobId);
    if (!listed) throw new Error(`${toolName}: job ${jobId} is not on the Review page`);
    return jobId;
  };
  /** The owner's Revert from the Review page; waits for its job and its follow-ups. */
  const revert = async (jobId: string): Promise<Obj> => {
    const r = await rt.reverts.revert('owner', pid, jobId);
    if (r.status !== 'submitted') throw new Error(`Revert of job ${jobId} ${r.status}: ${r.message}`);
    const job = await waitForJob(rt.engine, pid, r.revertJobId, 'the revert', wait);
    if (job.status !== 'succeeded') throw new Error(`the revert job ${job.id} ${job.status}`);
    for (let i = 0; i < 1200; i++) {
      const row = sb.db
        .prepare('SELECT targets FROM job_reverts WHERE revert_job_id = ?')
        .get(r.revertJobId) as { targets: string } | undefined;
      const note = row ? (JSON.parse(row.targets) as Obj) : {};
      if (!note.followUps || note.followUpsDone) return note;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('the revert’s follow-ups did not finish within ten minutes');
  };
  const live = async (id: string): Promise<Obj | null> => {
    const r = await read('getResource', { path: { resourceId: id } });
    return r && !r.deletedAt ? (r as Obj) : null;
  };
  let agent: Principal | undefined;
  let proposer: Principal | undefined;

  try {
    // ============================================================================================ D0: setup
    const ok = await check(
      'D0',
      'the throwaway index, Working page, page to delete and asset folder',
      async () => {
        if (!rootId) throw new Error('the project has no AI REPOSITORY root in its settings');
        if (!lifecycle.workingIndexId)
          throw new Error('the project’s [INDEX] Working is not confirmed (Projects page)');
        agent = principal(`f12 agent ${stamp}`, 'write');
        proposer = principal(`f12 proposer ${stamp}`, 'propose');
        const index = await run('createResource', {
          body: { name: `[INDEX] lk-bridge f12 check ${stamp}`, parentId: rootId },
        });
        made.index = String(index.id);
        const pack = rt.packs.forProject(pid).find((p) => p.id === 'arkona');
        if (pack)
          await ensureSandboxGovernance({
            rt,
            raw,
            projectName: name,
            packId: pack.id,
            parentId: made.index,
            label: `lk-bridge f12 governance ${stamp}`,
          });
        // The Working page and its sidebar in one job that declares its lifecycle (bridge code may; an agent's body never).
        made.page = mintClientId();
        const submitted = await rt.engine.submit({
          kind: 'batch_ops',
          project: pid,
          steps: [
            {
              op: 'createResource',
              params: {
                body: {
                  id: made.page,
                  name: `[BWRK] lk-bridge f12 page ${stamp}`,
                  parentId: lifecycle.workingIndexId,
                  tags: [lifecycle.tags.working],
                },
              },
            },
            {
              op: 'createProperty',
              params: {
                path: { resourceId: made.page },
                body: {
                  kind: 'keyValue',
                  title: treeSettingsFrom(settings).propertiesName,
                  rows: [
                    { key: lifecycle.fields.status, text: lifecycle.status.working },
                    { key: lifecycle.fields.continuityType, text: lifecycle.continuityTypes.canon },
                    { key: 'Continuity', text: 'Main' },
                  ],
                },
              },
            },
          ],
          onError: 'stop',
          priority: 'P1',
          origin,
          title: 'sandbox f12: a throwaway Working page',
          lifecycle: { tool: 'sandbox-f12', canonical: false, pages: [{ id: made.page, to: 'working' }] },
        });
        if (!('jobId' in submitted)) throw new Error('the Working page was not made (no job)');
        const madeJob = await waitForJob(rt.engine, pid, submitted.jobId, 'the Working page', wait);
        if (madeJob.status !== 'succeeded')
          throw new Error(
            `the Working page: job ${madeJob.id} ${madeJob.status} ${JSON.stringify(madeJob.lastError)}`,
          );
        const doomed = await run('createResource', {
          body: { name: `lk-bridge f12 delete me ${stamp}`, parentId: made.index },
        });
        made.doomed = String(doomed.id);
        const child = await run('createResource', {
          body: { name: `lk-bridge f12 delete me too ${stamp}`, parentId: made.doomed },
        });
        made.child = String(child.id);
        const folder = await run('createAssetFolder', { body: { name: `lk-bridge f12 ${stamp}` } });
        made.folder = String(folder.id);
        // The tree learns of the new pages from the bridge's own writes (the tools resolve pages through it).
        return `index ${made.index}, Working page ${made.page}, page ${made.doomed} with child ${made.child}, folder ${made.folder}${pack ? '; the pack’s governance pointed at the throwaway page (temporary database)' : ''}`;
      },
    );
    if (!ok || !agent || !proposer) return items;
    const a = agent;
    const p = proposer;

    // ============================================================================================ D1: promote, direct
    await check('D1', 'promote_page at scope write: direct, on the Review page', async () => {
      const job = await direct(a, 'promote_page', { page: made.page, destination: made.index });
      const now = await live(made.page);
      if (!now?.name?.startsWith('[BSRC]')) throw new Error(`the page is named “${String(now?.name)}”`);
      if (now.parentId !== made.index) throw new Error(`the page is under ${String(now.parentId)}`);
      return `job ${job}: “${now.name}”, under the throwaway index`;
    });

    // ============================================================================================ D2: CANON off and on
    await check(
      'D2',
      'CANON taken off, then put back (set_facts Continuity Type): direct, both on Review',
      async () => {
        const off = await direct(a, 'set_facts', { page: made.page, facts: { 'Continuity Type': 'AU' } });
        const on = await direct(a, 'set_facts', { page: made.page, facts: { 'Continuity Type': 'CANON' } });
        const props = await read('listProperties', { path: { resourceId: made.page } });
        const rows = ((props?.data ?? []) as Obj[]).flatMap((x) => (Array.isArray(x.rows) ? x.rows : []));
        const ct = rows.find((r: Obj) => r.key === 'Continuity Type');
        const text = JSON.stringify(ct?.content ?? ct?.text ?? null);
        if (!text.includes('CANON')) throw new Error(`Continuity Type reads ${text}`);
        return `jobs ${off} (off) and ${on} (on): Continuity Type CANON again`;
      },
    );

    // ============================================================================================ D3: a delete and Revert
    await check(
      'D3',
      'a page with one child deleted directly, its copy kept; Revert brings both back',
      async () => {
        const job = await direct(a, 'delete_resource', { page: made.doomed, confirm: true, cascade: true });
        const copy = sb.db
          .prepare('SELECT snapshot_id, pages, reads FROM delete_copies WHERE job_id = ?')
          .get(job) as { snapshot_id: string; pages: string; reads: number } | undefined;
        if (!copy) throw new Error(`job ${job} deleted the pages with no copy recorded`);
        const copied = (JSON.parse(copy.pages) as { id: string }[]).map((x) => x.id);
        if (copied.join(',') !== [made.doomed, made.child].join(','))
          throw new Error(`the copy holds ${copied.join(', ')}`);
        if (await live(made.doomed)) throw new Error('the page is still there after the delete');
        const note = await revert(job);
        const done = (note.followUpsDone as Obj[] | undefined)?.[0] ?? {};
        for (const id of [made.doomed, made.child]) {
          if (await live(id)) continue;
          // Recreated from the copy (LegendKeeper no longer held it): look for the new ids.
          const fresh = (done.recreated as Obj[] | undefined)?.find((x) => x.oldId === id)?.newId;
          if (!fresh || !(await live(String(fresh))))
            throw new Error(`${id} is not back: ${JSON.stringify(done)}`);
        }
        return `job ${job}: copy ${copy.snapshot_id} (2 pages, ${copy.reads} reads); Revert: back ${String(done.restoredBy ?? '')}`;
      },
    );

    // ============================================================================================ D4: an asset and Revert
    await check(
      'D4',
      'a tiny asset uploaded then deleted directly; Revert: an asset of its name back in its folder',
      async () => {
        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#4a7' } })
          .png()
          .toBuffer();
        const assetName = `lk-bridge f12 image ${stamp}`;
        const up = await tool(a, 'write', 'lk_upload_image', {
          name: assetName,
          base64: png.toString('base64'),
          folderId: made.folder,
          waitSeconds: 25,
        });
        const assetId = String(up.assetId ?? up.asset?.id ?? up.result?.id ?? '');
        if (!assetId) throw new Error(`the upload made no asset: ${JSON.stringify(up).slice(0, 400)}`);
        const del = await direct(a, 'lk_api_write', {
          operationId: 'deleteAsset',
          params: { path: { assetId } },
        });
        const note = await revert(del);
        const done = (note.followUpsDone as Obj[] | undefined)?.[0] ?? {};
        if (done.problem) throw new Error(`the re-upload: ${String(done.problem)}`);
        const list = await read('listAssets', { query: { folderId: made.folder, limit: 100 } });
        const back = ((list?.data ?? []) as Obj[]).find((x) => x.name === assetName && !x.deletedAt);
        if (!back)
          throw new Error(
            `no asset named “${assetName}” in the folder after Revert (the re-upload: ${JSON.stringify(done).slice(0, 600)}; the folder holds ${JSON.stringify(((list?.data ?? []) as Obj[]).map((x) => x.name))})`,
          );
        return `deleted by job ${del} (bytes kept); back as asset ${String(back.id)} in the folder`;
      },
    );

    // ============================================================================================ D5: the proposal path
    await check('D5', 'at scope propose a write is a proposal (then rejected)', async () => {
      const body = await tool(p, 'propose', 'set_facts', {
        page: made.page,
        facts: { 'Continuity Type': 'AU' },
      });
      if (body.status !== 'proposal_captured')
        throw new Error(`status ${String(body.status)}, not a proposal`);
      rt.policy.commands.reject('owner', String(body.proposalId), 'f12 sandbox: not wanted');
      return `proposal ${String(body.proposalId)} (rejected)`;
    });
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatF12Report(items: readonly F12CheckItem[]): string {
  return [
    'LK-Bridge sandbox: F12 direct writes at scope write (docs/adr/0081-v3-f12-direct-writes-review-safety-net.md)',
    ...items.map((i) => `${i.verdict.toUpperCase()} (${i.id}) ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
