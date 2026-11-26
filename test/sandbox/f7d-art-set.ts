/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- LK and tool results are untyped JSON */
/**
 * v3 F7d (ADR 0077), opt-in, WRITES then cleans up, on the test world only: a character's whole art set in ONE
 * `arkona_add_character_art` call with `groups`, and ONE proposal. Written for the owner; never run by an agent or in
 * CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7d-art-set
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The tools are called as the
 * MCP server calls them, for two temporary principals, one at scope `propose` and one at scope `write`; the proposals
 * are approved as the owner in the temporary database. The pack's switch for `arkona_add_character_art` is the seed's,
 * "follow the scope" (ADR 0077, the tool's description): at `propose` the call is one proposal, at `write` it runs as a
 * job unless it makes an Authoritative Art page or upgrades an Authoritative Core. Each step prints PASS or FAIL:
 *
 * - **D0** the Arkona pack attached here, the asset tree built, the pack's governance current in the temporary database
 *   (a throwaway governance page, as f7-1-core's C0);
 * - **D1** a throwaway Working compact character `Probe <Letters>` (no index yet);
 * - **D2** a zip of 5 tiny images taken in as an image archive: `portrait.png` at the top level (a design piece),
 *   `Probe Gala/front.png` and `Probe Gala/back.png` (an outfit of two), `Probe Hunt/front.png` (an outfit of one),
 *   `Probe Ride/front.png` (D3b's outfit of one);
 * - **D3** at scope `propose`, ONE groups call naming four entries (`{ archive: { id, entry } }`): ONE proposal of four
 *   items ("Art page", "Design pieces", "Outfit Probe Gala", "Outfit Probe Hunt"), PRINTED as `F7D PLAN …`; the entries
 *   staged by the archive worker; the proposal approved whole; its job succeeded and verified;
 * - **D3b** at scope `write`, a second, smaller groups call on the same Working character, now that its Art page exists:
 *   one new outfit (`Probe Ride`, one piece). It runs DIRECTLY as a job (no proposal), places its piece and verifies;
 *   PRINTED as `F7D DIRECT …`;
 * - **D4** read back LIVE and PRINTED as `F7D SET …`: the index and the Core upgrade (`[BWRK] Probe <Letters> - Character
 *   Core`, Reference Type `Character Core`); the folders (`Wardrobe`, `Wardrobe / Probe Gala` holding both its pieces,
 *   `Probe Hunt`'s and `Probe Ride`'s pieces loose in Wardrobe, the portrait in the character's own folder); ONE Art page
 *   with four headings (`Reference Images`, `Probe Gala`, `Probe Hunt`, `Probe Ride`) and five images; its sidebar's
 *   identity copies (Canonical Display Name, Personal / Given Name and Family / Surname equal to the Core's) and the Core
 *   in its Dependencies.
 *
 * Clean-up: the throwaway index (everything under it goes with it), the character's asset folder, the archive and the
 * throwaway governance page, even after a failure (test/sandbox/steps.ts). Cost: about 50 writes and 80 reads.
 */
import { writeFile } from 'node:fs/promises';
import { pino } from 'pino';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { tinyImage, zip } from '../f7c/zip.js';
import type { RawLk } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface ArtSetCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

function letters(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
  return s[0]!.toUpperCase() + s.slice(1);
}

const textOf = (b: Obj): string =>
  Array.isArray(b.content)
    ? (b.content as Obj[]).map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
    : typeof b.text === 'string'
      ? b.text
      : '';

const GALA = 'Probe Gala';
const HUNT = 'Probe Hunt';
const RIDE = 'Probe Ride';

export async function runArtSetCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<ArtSetCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f7d-art-set', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: ArtSetCheckItem[] = [];
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
    registry: true,
  });
  const pats = new PatService({
    store: new AuthStore(sb.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const principalAt = (scope: 'write' | 'propose'): Principal => {
    const profile = rt.policy.commands.createProfile('owner', {
      label: `f7d check ${scope} ${Date.now()}`,
      kind: 'other',
      scope,
    });
    return rt.policy.store.lookupPrincipal(
      pats.create({ name: `f7d check ${scope}`, profileId: profile.id, expiresInDays: 1 }).pat.id,
    )!.principal;
  };
  // Step 0 of F10 (25 November 2026): D3 is the proposal path, so it runs at `propose`; D3b is the direct path at `write`.
  const who: Principal = principalAt('write');
  const proposer: Principal = principalAt('propose');
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (
    t: string,
    args: Obj,
    as: { readonly principal: Principal; readonly scope: 'write' | 'propose' } = {
      principal: who,
      scope: 'write',
    },
  ): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === t);
    if (!provider) throw new Error(`${t} is not a tool of this bridge (deploy F7d first)`);
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${t}: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: as.principal,
      scope: as.scope,
      showLowLevelTools: false,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true)
      throw new Error(`${t}: ${String(body.error?.code)} ${String(body.error?.message)}`);
    return body;
  };
  const blocksOf = async (resourceId: string): Promise<Obj[]> => {
    const docs = await raw.request('listDocuments', 'GET', `/resources/${resourceId}/docs`);
    const main = ((docs.data ?? []) as Obj[]).find((d) => d.name === 'Main');
    if (!main) return [];
    return ((await raw.request('getDocumentBlocks', 'GET', `/resources/${resourceId}/docs/${main.id}/blocks`))
      .blocks ?? []) as Obj[];
  };
  const listAssets = async (folderId: string): Promise<Obj[]> =>
    ((await raw.request('listAssets', 'GET', `/assets?folderId=${encodeURIComponent(folderId)}&limit=100`))
      .data ?? []) as Obj[];
  const rowOf = (res: Obj, key: string): string => {
    const kv = ((res.properties ?? []) as Obj[]).find(
      (p) => p.kind === 'keyValue' && p.title === 'PROPERTIES',
    );
    const row = ((kv?.rows ?? []) as Obj[]).find((r) => r.key === key);
    return row ? textOf(row) : '?';
  };

  const subject = `Probe ${letters()}`;
  const made: {
    identity: string | null;
    index: string | null;
    governance: string | null;
    archive: string | null;
  } = { identity: null, index: null, governance: null, archive: null };
  steps.defer('the throwaway character, its asset folder and the archive deleted', async () => {
    const left: string[] = [];
    const del = async (what: string, path: string, op = 'deleteResource') => {
      try {
        await raw.request(op, 'DELETE', path);
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${what}: ${m}`);
      }
    };
    if (made.index) await del(`index ${made.index}`, `/resources/${made.index}?cascade=true`);
    else if (made.identity) await del(`page ${made.identity}`, `/resources/${made.identity}?cascade=true`);
    if (made.governance)
      await del(`governance page ${made.governance}`, `/resources/${made.governance}?cascade=true`);
    for (const f of rt.assets.queries.findFoldersByName(pid, subject).data)
      await del(`folder ${subject} (${f.id})`, `/assets/${f.id}`, 'deleteAsset');
    if (made.archive)
      try {
        await rt.images.archives.discard(made.archive, 'owner');
      } catch (e) {
        left.push(`archive ${made.archive}: ${(e as Error).message}`);
      }
    items.push({
      id: 'cleanup',
      title:
        'the throwaway character, its asset folder, the archive and the throwaway governance deleted (404 counts as cleaned)',
      verdict: left.length === 0 ? 'pass' : 'fail',
      detail: left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`,
    });
  });

  try {
    const d0 = await check(
      'D0',
      'the Arkona pack attached here; the asset tree built; its governance current',
      async () => {
        if (!copied.packs.includes('arkona'))
          throw new Error(`packs attached: ${copied.packs.join(', ') || 'none'}; deploy F7d first`);
        if (rt.assets.meta(pid).status === 'not_built') {
          rt.assets.prepareBuild(pid, { trigger: 'sandbox-f7d', autoConfirm: true });
          for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
            await new Promise((r) => setTimeout(r, 500));
        }
        const root = rt.projects.list().find((p) => p.id === pid)?.settings.aiRepositoryRootId;
        const governance = (
          await ensureSandboxGovernance({
            rt,
            raw,
            projectName: name,
            packId: 'arkona',
            ...(root ? { parentId: root } : {}),
            label: `lk-bridge f7d governance ${subject}`,
            made: (id) => {
              made.governance = id;
            },
          })
        ).detail;
        return `asset tree ${rt.assets.meta(pid).status}; packs attached: ${copied.packs.join(', ')}; ${governance}`;
      },
    );
    if (!d0) return items;
    const d1 = await check('D1', `a throwaway Working compact character (${subject})`, async () => {
      const gap = { value: 'Unestablished', reason: 'a sandbox probe, deleted when the check ends' };
      const body = await tool('arkona_create_character', {
        name: subject,
        depth: 'compact',
        status: 'working',
        identity: {
          givenName: 'Probe',
          surname: subject.slice('Probe '.length),
          race: gap,
          namingCulture: gap,
          lifeState: gap,
          temporalScope: gap,
        },
        pages: [
          {
            role: 'compact',
            scope: 'A sandbox probe of the one-call art set',
            markdown: `## Purpose\n\nThe compact reference for ${subject}, a sandbox probe.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nEverything else.\n`,
          },
        ],
      });
      await settle(body, 'make the probe character');
      const hit = rt.tree.queries
        .findByDisplayName(pid, `${subject} - Character Reference`)
        .data.find((e) => e.node.kind === 'bwrk');
      if (!hit) throw new Error(`[BWRK] ${subject} - Character Reference was not found in the tree`);
      made.identity = hit.node.id;
      return `[BWRK] ${subject} - Character Reference (${made.identity})`;
    });
    if (!d1) return items;
    const d2 = await check(
      'D2',
      'a zip of 5 tiny images (1 loose, 4 in three folders) taken in as an archive',
      async () => {
        const a = rt.images.archives;
        const bytes = zip([
          { name: 'portrait.png', data: await tinyImage('png') },
          { name: `${GALA}/` },
          { name: `${GALA}/front.png`, data: await tinyImage('png') },
          { name: `${GALA}/back.png`, data: await tinyImage('png') },
          { name: `${HUNT}/` },
          { name: `${HUNT}/front.png`, data: await tinyImage('png') },
          { name: `${RIDE}/` },
          { name: `${RIDE}/front.png`, data: await tinyImage('png') },
        ]);
        const tmp = await a.tempPath();
        await writeFile(tmp, bytes);
        const got = await a.ingest({
          projectId: pid,
          principalId: who.principalId,
          source: 'dashboard',
          fileName: 'f7d-probe.zip',
          tmpPath: tmp,
        });
        made.archive = got.archive.id;
        const rows = a.archiveView(got.archive).rows as Obj[];
        if (rows.length !== 5)
          throw new Error(`expected 5 entries, got ${rows.map((r) => String(r.path)).join(', ')}`);
        return `archive ${got.archive.id}: ${rows.map((r) => String(r.path)).join(', ')}`;
      },
    );
    if (!d2) return items;
    const ref = (entry: string, label: string) => ({
      archive: { id: made.archive, entry },
      label,
      interpretation: `Establishes nothing: a sandbox probe (${label}).`,
    });
    // The entries a call uses are staged by the archive worker (the job would wait for them otherwise).
    const staged = async (paths: readonly string[]): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const left = rt.images.archives.store
          .entries(made.archive!)
          .filter((e) => paths.includes(e.path) && e.status !== 'staged');
        if (left.length === 0) return;
        await rt.images.archives.work();
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const d3 = await check(
      'D3',
      'at scope propose: ONE groups call, ONE proposal of four items, approved whole',
      async () => {
        const body = await tool(
          'arkona_add_character_art',
          {
            character: made.identity,
            groups: [
              { images: [ref('portrait.png', 'Primary Reference - Probe Portrait')] },
              {
                outfit: GALA,
                images: [
                  ref(`${GALA}/front.png`, 'Outfit Reference - Front'),
                  ref(`${GALA}/back.png`, 'Outfit Reference - Back'),
                ],
              },
              { outfit: HUNT, images: [ref(`${HUNT}/front.png`, 'Outfit Reference - Front')] },
            ],
            artPage: { visualState: 'A sandbox probe' },
          },
          { principal: proposer, scope: 'propose' },
        );
        if (typeof body.proposalId !== 'string')
          throw new Error(`not one proposal: ${JSON.stringify(body).slice(0, 600)}`);
        const list = rt.policy.proposals.itemsOf(body.proposalId)?.items ?? [];
        const plan = `F7D PLAN items=${list.map((i) => i.group + (i.group === 'Outfits' ? `(${i.label.split(':')[0]!.replace(/^Outfit /, '')})` : '')).join(' | ')}`;
        if (list.length !== 4) throw new Error(`${plan} (expected 4 items)`);
        await staged(['portrait.png', `${GALA}/front.png`, `${GALA}/back.png`, `${HUNT}/front.png`]);
        const job = await settle(body, 'place the art set');
        if ((job.result as Obj | undefined)?.verified !== true)
          throw new Error(`the job did not verify: ${JSON.stringify(job.result).slice(0, 800)}`);
        const groups = ((job.result as Obj).artGroups ?? []) as Obj[];
        return `${plan}; job ${String(job.id)} succeeded and verified; placed ${groups.map((g) => `${String(g.group)} ${(g.placed as unknown[]).length}`).join(', ')}`;
      },
    );
    if (!d3) return items;
    const d3b = await check(
      'D3b',
      'at scope write: a smaller groups call (a new outfit, the Art page existing) runs directly as a job and verifies',
      async () => {
        const body = await tool('arkona_add_character_art', {
          character: made.identity,
          groups: [{ outfit: RIDE, images: [ref(`${RIDE}/front.png`, 'Outfit Reference - Front')] }],
        });
        if (typeof body.proposalId === 'string' || typeof body.jobId !== 'string')
          throw new Error(
            `expected a direct job, not a proposal (proposedBecause: ${JSON.stringify(body.proposedBecause ?? null)}): ${JSON.stringify(body).slice(0, 600)}`,
          );
        await staged([`${RIDE}/front.png`]);
        const job = await settle(body, 'place the new outfit');
        if ((job.result as Obj | undefined)?.verified !== true)
          throw new Error(`the job did not verify: ${JSON.stringify(job.result).slice(0, 800)}`);
        const groups = ((job.result as Obj).artGroups ?? []) as Obj[];
        const placed = groups.reduce((n, g) => n + (g.placed as unknown[]).length, 0);
        if (placed !== 1)
          throw new Error(`placed ${placed} pieces, not 1: ${JSON.stringify(groups).slice(0, 600)}`);
        return `F7D DIRECT job ${String(job.id)} succeeded and verified; placed ${groups.map((g) => `${String(g.group)} ${(g.placed as unknown[]).length}`).join(', ')}`;
      },
    );
    if (!d3b) return items;
    await check(
      'D4',
      'read back live: the Core upgrade, the folders, one Art page with four headings, the sidebar copies',
      async () => {
        const core = await raw.request('getResource', 'GET', `/resources/${made.identity}`);
        const index = core.parentId
          ? await raw.request('getResource', 'GET', `/resources/${core.parentId}`)
          : null;
        if (index?.name === `[INDEX] ${subject}`) made.index = String(index.id);
        const kids = made.index
          ? (((await raw.request('listResources', 'GET', `/resources?parentId=${made.index}&limit=100`))
              .data ?? []) as Obj[])
          : [];
        const artNode = kids.find((k) => k.name === `[BWRK] ${subject} - Character Art`);
        const art = artNode
          ? await raw.request('getResource', 'GET', `/resources/${String(artNode.id)}`)
          : null;
        const blocks = art ? await blocksOf(String(art.id)) : [];
        const headings = blocks.filter((b) => b.kind === 'heading').map(textOf);
        const images = blocks.filter((b) => b.kind === 'image').length;
        const folder = rt.assets.queries.findFoldersByName(pid, subject).data[0];
        const top = folder ? await listAssets(folder.id) : [];
        const wardrobe = top.find((x) => x.type === 'FOLDER' && x.name === 'Wardrobe');
        const inWardrobe = wardrobe ? await listAssets(String(wardrobe.id)) : [];
        const gala = inWardrobe.find((x) => x.type === 'FOLDER' && x.name === GALA);
        const inGala = gala ? await listAssets(String(gala.id)) : [];
        const deps = art
          ? (
              (((art.properties ?? []) as Obj[]).find((p) => p.title === 'Dependencies')?.items ??
                []) as Obj[]
            ).map((i) => String(i.resourceId))
          : [];
        const copies = ['Canonical Display Name', 'Personal / Given Name', 'Family / Surname'].map((k) => ({
          k,
          art: art ? rowOf(art, k) : '?',
          core: rowOf(core, k),
        }));
        const line = `F7D SET index=${index?.name ?? '-'} core=${String(core.name)} referenceType=${rowOf(core, 'Reference Type')} folders=${[wardrobe ? 'Wardrobe' : null, gala ? `Wardrobe / ${GALA} (${inGala.filter((x) => x.type !== 'FOLDER').length})` : null].filter(Boolean).join(', ')} looseInWardrobe=${inWardrobe.filter((x) => x.type !== 'FOLDER').length} designPieces=${top.filter((x) => x.type !== 'FOLDER').length} art=${art ? String(art.name) : '-'} headings=${headings.join(' / ')} images=${images} copies=${copies.map((c) => `${c.k}:${c.art}`).join('; ')} dependsOnCore=${deps.includes(String(made.identity))}`;
        const problems = [
          ...(made.index ? [] : ['no index']),
          ...(core.name === `[BWRK] ${subject} - Character Core` ? [] : ['not upgraded to its Core']),
          ...(rowOf(core, 'Reference Type') === 'Character Core'
            ? []
            : ['Reference Type not Character Core']),
          ...(wardrobe && gala && inGala.filter((x) => x.type !== 'FOLDER').length === 2
            ? []
            : ['the folders are not Wardrobe / Probe Gala with two pieces']),
          ...(inWardrobe.filter((x) => x.type !== 'FOLDER').length === 2
            ? []
            : ['Probe Hunt’s and Probe Ride’s pieces are not loose in Wardrobe']),
          ...(art ? [] : ['no Art page under the index']),
          ...(['Reference Images', GALA, HUNT, RIDE].every((h) => headings.includes(h))
            ? []
            : ['the Art page lacks one of its four headings']),
          ...(images === 5 ? [] : [`${images} images on the Art page, not 5`]),
          ...copies
            .filter((c) => c.core !== '?' && c.art !== c.core)
            .map((c) => `${c.k} not copied (${c.art} vs ${c.core})`),
          ...(deps.includes(String(made.identity)) ? [] : ['the Core is not in its Dependencies']),
        ];
        if (problems.length > 0) throw new Error(`${line} (${problems.join('; ')})`);
        return line;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;

  async function settle(body: Obj, what: string): Promise<Obj> {
    let jobId = typeof body.jobId === 'string' ? body.jobId : null;
    if (typeof body.proposalId === 'string') {
      const p = rt.policy.proposals.get(body.proposalId)!;
      if (p.requiresCanonicalApproval) await rt.policy.commands.approveAsCanon('owner', p.id);
      else await rt.policy.commands.approve('owner', p.id);
      for (let i = 0; i < 600 && !jobId; i++) {
        jobId = rt.policy.proposals.get(p.id)?.jobId ?? null;
        if (!jobId) await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!jobId) throw new Error(`${what}: no job (${JSON.stringify(body).slice(0, 400)})`);
    const job = await waitForJob(rt.engine, pid, jobId, what, o.wait);
    if (job.status !== 'succeeded')
      throw new Error(`${what}: job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
    return job;
  }
}

export function formatArtSetReport(items: readonly ArtSetCheckItem[]): string {
  return [
    'sandbox f7d-art-set report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
