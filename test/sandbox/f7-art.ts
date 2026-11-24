/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F7 (ADR 0070; design G2, G9, G10), opt-in, WRITES then cleans up, on the test world only. Written for the owner;
 * never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-art
 *
 * Each step prints PASS, FAIL or NOTED:
 *
 * - **B0** the asset tree built (about one request a folder);
 * - **B1** ONE outfit piece uploaded into a throwaway character folder's Wardrobe (`lk-bridge f7 check <time> / F7 Probe /
 *   Wardrobe`): read LIVE, it is loose in Wardrobe, and the bridge's placement for a second piece of the same outfit is
 *   "a new folder, the loose piece moved";
 * - **B2** the second piece uploaded into `Wardrobe / Probe Outfit` (the folder made by the upload's job) and the first
 *   piece moved into it (`updateAsset`, the step the art job uses): read back LIVE, both are in the new folder, nothing is
 *   loose in Wardrobe, and the bridge's asset tree followed the move (G9);
 * - **B3** (G10) the titled-block probe: a throwaway page `lk-bridge f7 probe <time>`, and for each titled block kind
 *   (image, embed, keyValue, meter, resourceCollection, resourceLink, map, textField) ONE block written WITHOUT `title`
 *   and `isTitleHidden`, read back, and what LegendKeeper stored printed as NOTED:
 *   `F7 PROBE <kind>: title=<…> isTitleHidden=<…>`. The owner pastes the values into `TITLED_BLOCK_DEFAULTS`
 *   (src/jobs/verify-blocks.ts); a kind LegendKeeper refuses in this minimal form says so.
 *
 * Clean-up: the throwaway asset folder (everything inside goes with it) and the throwaway page, even after a failure
 * (test/sandbox/steps.ts). Cost: about 20 writes and 40 reads.
 */
import { readFileSync } from 'node:fs';
import { readLayout } from '../../src/art/layout.js';
import { decidePlacement } from '../../src/art/placement.js';
import { queriesView } from '../../src/art/seed.js';
import { TITLED_BLOCK_KINDS } from '../../src/jobs/verify-blocks.js';
import type { RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';

type Obj = Record<string, any>;
export interface ArtCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const CHARACTER = 'F7 Probe';
const OUTFIT = 'Probe Outfit';

/** One block of each titled kind, in its minimal form, WITHOUT title and isTitleHidden. */
export function probeBlock(kind: string, o: { imageUrl: string; pageId: string }): Obj {
  switch (kind) {
    case 'image':
      return { kind, url: o.imageUrl };
    case 'embed':
      return { kind, provider: 'youtube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' };
    case 'keyValue':
      return { kind, rows: [{ key: 'Probe', content: [{ text: 'value' }] }] };
    case 'meter':
      // v3 F7b: the spec's MeterBlock requires `mode` and each item's `name`, `icon`, `current` and `max`. The first live
      // run (23 November 2026) sent no `icon` and was refused (Validation error); with `icon` the probe printed
      // `title="Meter" isTitleHidden=false` the same day, recorded in TITLED_BLOCK_DEFAULTS by v3 F6a (ADR 0076).
      return { kind, mode: 'bar', items: [{ name: 'Probe', icon: 'heart', current: 1, max: 2 }] };
    case 'resourceCollection':
      return { kind };
    case 'resourceLink':
      return { kind, items: [{ resourceId: o.pageId }] };
    case 'map':
      return { kind };
    case 'textField':
      return { kind, children: [{ kind: 'paragraph', content: [{ text: 'Probe.' }] }] };
    default:
      throw new Error(`no probe for ${kind}`);
  }
}

export async function runArtCheck(
  sb: SoakRuntime,
  raw: RawLk,
  o: { readonly run?: SandboxRun; readonly wait?: WaitOptions } = {},
): Promise<ArtCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f7-art', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: ArtCheckItem[] = [];
  const origin = { kind: 'test' as const, client: 'sandbox-f7', tool: 'sandbox-f7' };
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: wholeError(e) });
      return false;
    }
  };
  const run = (op: string, params: Record<string, unknown>) =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid },
      o.wait,
    );
  const upload = async (name: string, file: string, folder: string[]) => {
    const img = await rt.images.convert(fixture(file));
    const plan = rt.images.plan(pid, { folder });
    if (!plan.ok) throw new Error(`${plan.error.code}: ${plan.error.message}`);
    const started = await rt.images.startUpload({
      projectId: pid,
      image: img,
      name,
      plan: plan.plan,
      staged: false,
      source: 'data_base64',
      origin,
    });
    if (!started.row) throw new Error('the upload was not accepted');
    await waitForJob(rt.engine, pid, started.row.jobId!, `upload ${name}`, o.wait);
    const row = rt.images.settle(rt.images.store.upload(pid, started.row.id)!);
    if (row.state !== 'uploaded' || !row.assetId) throw new Error(`${name}: ${row.state} ${row.error ?? ''}`);
    return row.assetId;
  };
  const liveAsset = async (id: string) => raw.request('getAsset', 'GET', `/assets/${id}`);
  const liveList = async (folderId: string) =>
    ((await raw.request('listAssets', 'GET', `/assets?folderId=${encodeURIComponent(folderId)}&limit=100`))
      .data ?? []) as Obj[];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = `lk-bridge f7 check ${stamp}`;
  const made: { page: string | null } = { page: null };
  steps.defer('the throwaway asset folder and page deleted', async () => {
    const left: string[] = [];
    for (const f of rt.assets.queries.findFoldersByName(pid, root).data.filter((x) => x.parentId === null)) {
      try {
        await run('deleteAsset', { path: { assetId: f.id } });
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${root} (${f.id}): ${m}`);
      }
    }
    if (made.page)
      try {
        await raw.request('deleteResource', 'DELETE', `/resources/${made.page}?cascade=true`);
      } catch (e) {
        left.push(`page ${made.page}: ${(e as Error).message}`);
      }
    items.push({
      id: 'cleanup',
      title: 'the throwaway asset folder and page deleted (404 counts as cleaned)',
      verdict: left.length === 0 ? 'pass' : 'fail',
      detail: left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`,
    });
  });

  const ids = { first: '', second: '', character: '', wardrobe: '', outfit: '', firstUrl: '' };
  try {
    await steps.step('B0', 'the asset tree built (about one request a folder)', async () => {
      if (rt.assets.meta(pid).status === 'not_built') {
        rt.assets.prepareBuild(pid, { trigger: 'sandbox-f7', autoConfirm: true });
        for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
          await new Promise((r) => setTimeout(r, 500));
      }
      return rt.assets.meta(pid).status;
    });
    const b1 = await check(
      'B1',
      'one outfit piece goes loose in Wardrobe; a second would make its folder',
      async () => {
        ids.first = await upload(`${CHARACTER} - ${OUTFIT} - Outfit Reference - Front`, 'alpha.png', [
          root,
          CHARACTER,
          'Wardrobe',
        ]);
        const a = await liveAsset(ids.first);
        ids.wardrobe = String(a.folderId);
        ids.firstUrl = String(a.url ?? '');
        const w = await liveAsset(ids.wardrobe);
        if (w.name !== 'Wardrobe') throw new Error(`the piece is in “${String(w.name)}”, not Wardrobe`);
        ids.character = String(w.folderId);
        const r = await rt.assets.refreshFolder(pid, ids.character, { depth: 3 });
        if (!r.ok) throw new Error(`the live read failed: ${r.error ?? ''}`);
        const layout = readLayout(queriesView(rt.assets.queries, pid), ids.character);
        if (!layout?.loose.some((x) => x.id === ids.first))
          throw new Error('the live layout does not show it loose');
        const next = decidePlacement({
          character: CHARACTER,
          layout,
          records: [],
          outfit: OUTFIT,
          arriving: 1,
        });
        if (!next.ok || next.kind !== 'outfit' || next.into !== 'folder' || next.moves.length !== 1)
          throw new Error(`a second piece would not make the folder: ${JSON.stringify(next)}`);
        return `loose in Wardrobe (${ids.wardrobe}); the next piece makes Wardrobe / ${OUTFIT} and moves this one (${r.requests} live reads)`;
      },
    );
    if (b1)
      await check(
        'B2',
        'the second piece makes Wardrobe / Probe Outfit and the first is moved in',
        async () => {
          ids.second = await upload(
            `${CHARACTER} - ${OUTFIT} - Outfit Reference - Back`,
            'orientation-6.jpg',
            [root, CHARACTER, 'Wardrobe', OUTFIT],
          );
          ids.outfit = String((await liveAsset(ids.second)).folderId);
          await run('updateAsset', { path: { assetId: ids.first }, body: { folderId: ids.outfit } });
          const first = await liveAsset(ids.first);
          if (first.folderId !== ids.outfit)
            throw new Error(`the first piece is in ${String(first.folderId)}`);
          const loose = (await liveList(ids.wardrobe)).filter((x) => x.type !== 'FOLDER');
          if (loose.length > 0)
            throw new Error(`still loose in Wardrobe: ${loose.map((x) => String(x.name)).join(', ')}`);
          const cached = rt.assets.queries.asset(pid, ids.first).data?.folderId;
          if (cached !== ids.outfit) throw new Error(`the asset tree still has it in ${String(cached)} (G9)`);
          return `both pieces in Wardrobe / ${OUTFIT} (${ids.outfit}); nothing loose; the asset tree followed the move`;
        },
      );
    await check(
      'B3',
      'the titled-block probe (G10): what LegendKeeper stores without title fields',
      async () => {
        const page = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f7 probe ${stamp}`,
          documents: [{ name: 'Main', type: 'page' }],
        });
        made.page = String(page.id);
        const doc = String(((page.documents ?? []) as Obj[])[0]?.id ?? '');
        if (!doc) throw new Error('the probe page came back with no document');
        const path = `/resources/${made.page}/docs/${doc}/blocks`;
        const lines: string[] = [];
        for (const kind of TITLED_BLOCK_KINDS) {
          try {
            const before = await raw.request('getDocumentBlocks', 'GET', path);
            await raw.request(
              'replaceDocumentBlocks',
              'PUT',
              path,
              { blocks: [probeBlock(kind, { imageUrl: ids.firstUrl, pageId: made.page })] },
              { ifMatch: String(before.version) },
            );
            const after = await raw.request('getDocumentBlocks', 'GET', path);
            const b = ((after.blocks ?? []) as Obj[]).find((x) => x.kind === kind) ?? {};
            lines.push(
              `F7 PROBE ${kind}: title=${JSON.stringify(b.title ?? null)} isTitleHidden=${JSON.stringify(b.isTitleHidden ?? null)}`,
            );
          } catch (e) {
            lines.push(`F7 PROBE ${kind}: refused in its minimal form (${(e as Error).message})`);
          }
        }
        for (const l of lines)
          items.push({ id: 'B3', title: 'titled-block default', verdict: 'noted', detail: l });
        return `${lines.length} kinds probed (each printed as NOTED)`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatArtReport(items: readonly ArtCheckItem[]): string {
  return [
    'sandbox f7-art report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
