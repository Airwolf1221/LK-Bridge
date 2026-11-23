/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK and tool results are untyped JSON */
/**
 * v3 F7b (ADR 0071), opt-in, WRITES then cleans up: `arkona_get_art` end to end on the real API and the real asset host,
 * on the test world only. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7b-art
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`, as F5c's check); it never writes to the bridge's database. The tool is
 * called as the MCP server calls it, for a temporary read-scope principal. Each step prints PASS or FAIL, and what the
 * owner should look at:
 *
 * - **A0** the asset tree built; the Arkona pack attached to this project (deploy F7b first);
 * - **A1** one small image uploaded into a throwaway folder `lk-bridge f7b check <time>`, and a throwaway page
 *   `lk-bridge f7b probe <time>` under the AI REPOSITORY embedding it under a heading, with its alt text and a paragraph
 *   (the authority text), found by the tree's sweep;
 * - **A2** `delivery: "link"`: the `url` exactly as `getAsset` gives it (read live), `howToView`, no image block, no
 *   download. PRINTS the URL (open it in a browser: it is the ChatGPT route);
 * - **A3** `delivery: "inline"` by the page: one image block, read live from the asset host and resized. PRINTS the
 *   inline block's size, format and dimensions, and the authority found (the page's label and text);
 * - **A4** `delivery: "both"` by the asset, again: the url AND the image, from the cache (`cached: true`, no download).
 *   PRINTS the cache hit.
 *
 * Clean-up: the throwaway asset folder and page, even after a failure (test/sandbox/steps.ts). Cost: about 6 writes and
 * 12 reads, and one download from the asset host.
 */
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { ProjectStore } from '../../src/projects/index.js';
import type { RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface ArtViewCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const LABEL = 'Primary Reference - F7b Probe';
const TEXT = 'Establishes the probe’s colours only; it establishes nothing else (a sandbox check).';

export async function runArtViewCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<ArtViewCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f7b-art', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: ArtViewCheckItem[] = [];
  const origin = { kind: 'test' as const, client: 'sandbox-f7b', tool: 'sandbox-f7b' };
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: wholeError(e) });
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: o.bridgeDbPath,
    target: sb.db,
    projectId: pid,
    runtime: rt,
  });

  // A temporary read-scope principal, as the MCP server's.
  const profile = rt.policy.commands.createProfile('owner', {
    label: `f7b check ${Date.now()}`,
    kind: 'other',
    scope: 'read',
  });
  const pats = new PatService({
    store: new AuthStore(sb.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const who: Principal = rt.policy.store.lookupPrincipal(
    pats.create({ name: 'f7b check', profileId: profile.id, expiresInDays: 1 }).pat.id,
  )!.principal;
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (args: Obj): Promise<{ body: Obj; images: { mimeType: string; data: string }[] }> => {
    const provider = rt.tools.find((x) => x.name === 'arkona_get_art');
    if (!provider) throw new Error('arkona_get_art is not a tool of this bridge (deploy F7b first)');
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(parsed.error.message);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(5 * 60_000),
      log: silent,
      principal: who,
      scope: 'read',
      showLowLevelTools: false,
    });
    const content = res.content as readonly {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }[];
    const text = content[0]?.text ?? '';
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true) throw new Error(`${String(body.error?.code)} ${String(body.error?.message)}`);
    return {
      body,
      images: content
        .filter((c) => c.type === 'image')
        .map((c) => ({ mimeType: c.mimeType ?? '', data: c.data ?? '' })),
    };
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = `lk-bridge f7b check ${stamp}`;
  const made: { page: string | null } = { page: null };
  const ids = { asset: '', url: '', page: '' };
  steps.defer('the throwaway asset folder and page deleted', async () => {
    const left: string[] = [];
    for (const f of rt.assets.queries
      .findFoldersByName(pid, folder)
      .data.filter((x) => x.parentId === null)) {
      try {
        await raw.request('deleteAsset', 'DELETE', `/assets/${f.id}`);
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${folder} (${f.id}): ${m}`);
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

  try {
    const a0 = await check('A0', 'the asset tree built; the Arkona pack attached here', async () => {
      if (!copied.packs.includes('arkona'))
        throw new Error(
          `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F7b (the seed arkona-2026-11-23-f7b) first`,
        );
      if (rt.assets.meta(pid).status === 'not_built') {
        rt.assets.prepareBuild(pid, { trigger: 'sandbox-f7b', autoConfirm: true });
        for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
          await new Promise((r) => setTimeout(r, 500));
      }
      return `asset tree ${rt.assets.meta(pid).status}; packs attached: ${copied.packs.join(', ')}`;
    });
    if (!a0) return items;
    const a1 = await check(
      'A1',
      'one small image uploaded, and a page embedding it with its authority text',
      async () => {
        const img = await rt.images.convert(fixture('alpha.png'));
        const plan = rt.images.plan(pid, { folder: [folder] });
        if (!plan.ok) throw new Error(`${plan.error.code}: ${plan.error.message}`);
        const started = await rt.images.startUpload({
          projectId: pid,
          image: img,
          name: `F7b Probe - ${LABEL}`,
          plan: plan.plan,
          staged: false,
          source: 'data_base64',
          origin,
        });
        if (!started.row) throw new Error('the upload was not accepted');
        await waitForJob(rt.engine, pid, started.row.jobId!, 'upload the probe image', o.wait);
        const row = rt.images.settle(rt.images.store.upload(pid, started.row.id)!);
        if (row.state !== 'uploaded' || !row.assetId)
          throw new Error(`upload: ${row.state} ${row.error ?? ''}`);
        ids.asset = row.assetId;
        const live = await raw.request('getAsset', 'GET', `/assets/${ids.asset}`);
        ids.url = String(live.url);
        const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)
          ?.aiRepositoryRootId as string | undefined;
        if (!rootId) throw new Error('the project has no AI REPOSITORY root in its settings');
        const page = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f7b probe ${stamp}`,
          parentId: rootId,
          documents: [{ name: 'Main', type: 'page' }],
        });
        made.page = String(page.id);
        ids.page = made.page;
        const doc = String(((page.documents ?? []) as Obj[])[0]?.id ?? '');
        const path = `/resources/${made.page}/docs/${doc}/blocks`;
        const before = await raw.request('getDocumentBlocks', 'GET', path);
        await raw.request(
          'replaceDocumentBlocks',
          'PUT',
          path,
          {
            blocks: [
              { kind: 'heading', level: 2, content: [{ text: 'Reference Images' }] },
              { kind: 'image', url: ids.url, alt: LABEL },
              { kind: 'paragraph', content: [{ text: TEXT }] },
            ],
          },
          { ifMatch: String(before.version) },
        );
        await rt.tree.sweep(pid, 'sandbox-f7b');
        await rt.tree.whenIdle();
        if (!rt.tree.queries.node(pid, made.page).data)
          throw new Error('the tree’s sweep did not find the probe page');
        return `asset ${ids.asset} in ${folder}; page ${made.page}`;
      },
    );
    if (!a1) return items;
    await check(
      'A2',
      'link: the url exactly as getAsset gives it, howToView, nothing downloaded',
      async () => {
        const r = await tool({ asset: [ids.asset], delivery: 'link' });
        const im = r.body.images?.[0];
        if (!im) throw new Error(`no image: ${JSON.stringify(r.body).slice(0, 500)}`);
        if (im.url !== ids.url) throw new Error(`url ${String(im.url)} is not getAsset's ${ids.url}`);
        if (!r.body.howToView) throw new Error('no howToView');
        if (r.images.length !== 0 || r.body.reads?.downloads !== 0)
          throw new Error('something was downloaded');
        return `URL ${String(im.url)} (open it in a browser: the ChatGPT route); authority ${String(im.authority?.status)}`;
      },
    );
    await check(
      'A3',
      'inline by the page: one image block, resized; the authority from the page',
      async () => {
        const r = await tool({ page: ids.page, delivery: 'inline' });
        const im = r.body.images?.[0];
        if (!im?.inline?.ok)
          throw new Error(`not inline: ${JSON.stringify(im?.inline ?? r.body).slice(0, 500)}`);
        if (r.images.length !== 1) throw new Error(`${r.images.length} image blocks`);
        const blockBytes = Buffer.from(r.images[0]!.data, 'base64').length;
        const page = (im.authority?.pages ?? [])[0];
        if (im.authority?.status !== 'found' || page?.label !== LABEL || page?.text !== TEXT)
          throw new Error(`authority: ${JSON.stringify(im.authority).slice(0, 500)}`);
        return `inline block ${blockBytes} bytes (${r.images[0]!.mimeType}, ${String(im.inline.width)} × ${String(im.inline.height)}, cached ${String(im.inline.cached)}); original ${String(im.bytes)} bytes; authority found on “${String(page.page?.name)}”: label “${String(page.label)}”, text “${String(page.text)}”`;
      },
    );
    await check('A4', 'both by the asset, again: from the cache (no download)', async () => {
      const r = await tool({ asset: [ids.asset], delivery: 'both' });
      const im = r.body.images?.[0];
      if (im?.inline?.cached !== true) throw new Error(`not from the cache: ${JSON.stringify(im?.inline)}`);
      if (r.body.reads?.downloads !== 0 || r.body.reads?.cacheHits !== 1)
        throw new Error(JSON.stringify(r.body.reads));
      if (im.url !== ids.url || !r.body.howToView) throw new Error('the link is missing');
      return `cache hit: cached ${String(im.inline.cached)}, downloads ${String(r.body.reads.downloads)}, cacheHits ${String(r.body.reads.cacheHits)}; the url and the image both delivered`;
    });
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatArtViewReport(items: readonly ArtViewCheckItem[]): string {
  return [
    'sandbox f7b-art report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
