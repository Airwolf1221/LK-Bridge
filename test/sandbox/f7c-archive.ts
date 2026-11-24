/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F7c (ADR 0075), opt-in, WRITES then cleans up, on the test world only. Written for the owner; never run by an agent
 * or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7c-archive
 *
 * Each step prints PASS or FAIL, and the rows and the placement as NOTED lines:
 *
 * - **C0** the asset tree built (about one request a folder);
 * - **C1** a small zip of 3 images (`alpha.png`, `orientation-6.jpg` in `Probe Outfit/`, `already.webp`) taken in as an
 *   image archive: listed at once, nothing converted, nothing in LegendKeeper. Each row is printed:
 *   `F7C ROW <entry> folder=<…> suggestedOutfit=<…> <format> <w>×<h> <status>`;
 * - **C2** ONE entry (`Probe Outfit/orientation-6.jpg`) asked for as an art call asks: converted and staged by the
 *   archive worker; the other two stay listed;
 * - **C3** that staged entry placed as an outfit piece by the art job's own steps (createImageUpload, the signed PUT,
 *   createImageAsset, the stored-file check, the read back) into a throwaway character folder's Wardrobe
 *   (`lk-bridge f7c check <time> / F7c Probe / Wardrobe`): read LIVE, it is there, named
 *   `F7c Probe - Probe Outfit - Outfit Reference - Front`, and its stored file's SHA-256 is the staged WebP's;
 * - **C4** the archive discarded: its server copy removed, the two listed entries discarded.
 *
 * Clean-up: the throwaway asset folder (everything inside goes with it) and the archive, even after a failure
 * (test/sandbox/steps.ts). Cost: about 7 writes, 10 reads and one download from the asset host.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';
import { zip } from '../f7c/zip.js';

type Obj = Record<string, any>;
export interface ArchiveCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const CHARACTER = 'F7c Probe';
const OUTFIT = 'Probe Outfit';
const ENTRY = `${OUTFIT}/orientation-6.jpg`;

export async function runArchiveCheck(
  sb: SoakRuntime,
  raw: RawLk,
  o: { readonly run?: SandboxRun; readonly wait?: WaitOptions } = {},
): Promise<ArchiveCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f7c-archive', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: ArchiveCheckItem[] = [];
  const origin = { kind: 'test' as const, client: 'sandbox-f7c', tool: 'sandbox-f7c' };
  const noted = (id: string, detail: string) => items.push({ id, title: 'noted', verdict: 'noted', detail });
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: wholeError(e) });
      return false;
    }
  };
  const archives = rt.images.archives;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = `lk-bridge f7c check ${stamp}`;
  const ids = { archive: '', staged: '', asset: '' };
  steps.defer('the throwaway asset folder and the archive removed', async () => {
    const left: string[] = [];
    for (const f of rt.assets.queries.findFoldersByName(pid, root).data.filter((x) => x.parentId === null)) {
      try {
        await rt.engine.run(
          'deleteAsset',
          { path: { assetId: f.id } },
          { origin, priority: 'P1', project: pid },
        );
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${root} (${f.id}): ${m}`);
      }
    }
    if (ids.archive && archives.store.archive(ids.archive)?.serverFile)
      await archives
        .discard(ids.archive, 'sandbox')
        .catch((e: unknown) => left.push(`archive: ${String(e)}`));
    items.push({
      id: 'cleanup',
      title: 'the throwaway asset folder deleted and the archive discarded (404 counts as cleaned)',
      verdict: left.length === 0 ? 'pass' : 'fail',
      detail: left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`,
    });
  });

  try {
    await steps.step('C0', 'the asset tree built (about one request a folder)', async () => {
      if (rt.assets.meta(pid).status === 'not_built') {
        rt.assets.prepareBuild(pid, { trigger: 'sandbox-f7c', autoConfirm: true });
        for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
          await new Promise((r) => setTimeout(r, 500));
      }
      return rt.assets.meta(pid).status;
    });
    const c1 = await check('C1', 'a zip of 3 images taken in: listed, nothing converted', async () => {
      const bytes = zip([
        { name: 'alpha.png', data: fixture('alpha.png'), method: 'deflate' },
        { name: `${OUTFIT}/` },
        { name: ENTRY, data: fixture('orientation-6.jpg') },
        { name: 'already.webp', data: fixture('already.webp') },
      ]);
      const tmp = await archives.tempPath();
      await writeFile(tmp, bytes);
      const got = await archives.ingest({
        projectId: pid,
        principalId: 'sandbox-f7c',
        source: 'dashboard',
        fileName: 'f7c-probe.zip',
        tmpPath: tmp,
      });
      ids.archive = got.archive.id;
      const view = archives.archiveView(got.archive).rows as Obj[];
      for (const r of view)
        noted(
          'C1',
          `F7C ROW ${String(r.entry)} folder=${JSON.stringify(r.folder)} suggestedOutfit=${JSON.stringify(r.suggestedOutfit)} ${String(r.format)} ${String(r.width)}×${String(r.height)} ${String(r.status)}`,
        );
      if (view.length !== 3 || view.some((r) => r.status !== 'listed'))
        throw new Error(
          `expected 3 listed rows, got ${view.map((r) => `${String(r.path)}:${String(r.status)}`).join(', ')}`,
        );
      return `archive ${got.archive.id}: 3 entries listed (${got.archive.bytes} bytes), none converted`;
    });
    const c2 =
      c1 &&
      (await check('C2', 'one entry asked for as an art call asks: converted and staged', async () => {
        const r = archives.forArt(pid, { id: ids.archive, entry: ENTRY });
        if (r.kind === 'unavailable') throw new Error(`${r.code}: ${r.message}`);
        for (let i = 0; i < 20 && archives.store.byStagedId(pid, r.stagedId)?.status !== 'staged'; i++)
          await archives.work();
        const e = archives.store.byStagedId(pid, r.stagedId);
        if (e?.status !== 'staged')
          throw new Error(`the entry is ${String(e?.status)} (${String(e?.reason)})`);
        ids.staged = r.stagedId;
        const others = archives.store.entries(ids.archive).filter((x) => x.path !== ENTRY);
        if (others.some((x) => x.status !== 'listed')) throw new Error('another entry was converted');
        const row = rt.images.store.upload(pid, r.stagedId)!;
        return `${ENTRY} staged as ${r.stagedId} (${row.webp.bytes} bytes of WebP, ${row.width}×${row.height}); the other two still listed`;
      }));
    if (c2)
      await check('C3', 'the staged entry placed as an outfit piece by the art job’s steps', async () => {
        const row = rt.images.store.upload(pid, ids.staged)!;
        const plan = rt.images.plan(pid, { folder: [root, CHARACTER, 'Wardrobe'] });
        if (!plan.ok) throw new Error(`${plan.error.code}: ${plan.error.message}`);
        const name = `${CHARACTER} - ${OUTFIT} - Outfit Reference - Front`;
        const placed = await rt.images.place({
          projectId: pid,
          row,
          plan: plan.plan,
          rename: name,
          origin,
          tool: 'sandbox-f7c',
        });
        if (!('jobId' in placed.submitted)) throw new Error('the placement became a proposal');
        await waitForJob(rt.engine, pid, placed.submitted.jobId, 'place the entry', o.wait);
        const after = rt.images.settle(rt.images.store.upload(pid, ids.staged)!);
        if (!after.assetId) throw new Error(`not placed: ${after.error ?? after.state}`);
        ids.asset = after.assetId;
        const live = await raw.request('getAsset', 'GET', `/assets/${after.assetId}`);
        const wardrobe = await raw.request('getAsset', 'GET', `/assets/${String(live.folderId)}`);
        if (wardrobe.name !== 'Wardrobe')
          throw new Error(`it is in “${String(wardrobe.name)}”, not Wardrobe`);
        if (live.name !== name) throw new Error(`it is named “${String(live.name)}”`);
        noted(
          'C3',
          `F7C PLACED ${String(live.name)} in ${root} / ${CHARACTER} / Wardrobe (asset ${after.assetId}); storedBytesVerified=${String(after.storedVerified)}`,
        );
        if (after.storedVerified !== true)
          throw new Error(`the stored file was not verified: ${after.verifyReason ?? ''}`);
        return `placed live in Wardrobe as “${name}”, its stored file verified`;
      });
    await check(
      'C4',
      'the archive discarded: its server copy removed, the listed entries discarded',
      async () => {
        if (!ids.archive) throw new Error('no archive was taken in');
        const r = await archives.discard(ids.archive, 'sandbox');
        const a = archives.store.archive(ids.archive)!;
        if (a.serverFile !== null) throw new Error('the server copy is still there');
        return `${r?.discarded ?? 0} entr${r?.discarded === 1 ? 'y' : 'ies'} discarded; state ${a.state}`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatArchiveReport(items: readonly ArchiveCheckItem[]): string {
  return [
    'sandbox f7c-archive report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
