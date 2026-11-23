/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- LK and tool results are untyped JSON */
/**
 * v3 F7.1 (ADR 0072, decision 7), opt-in, WRITES then cleans up, on the test world only: a Compact Character Reference
 * becomes the Character Core when its character gains an index with several owners. Written for the owner; never run
 * by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-1-core
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The tools are called as the
 * MCP server calls them, for a temporary write-scope principal; a proposal is approved as the owner in the temporary
 * database. Each step prints PASS or FAIL:
 *
 * - **C0** the Arkona pack attached here, the asset tree built, [INDEX] Working confirmed;
 * - **C1** a throwaway Working compact character `Probe <Letters>` (`arkona_create_character`, depth compact, status
 *   working), its text saying "The compact reference for …";
 * - **C2** one art piece added (`upload_image { stage: true }`, then `arkona_add_character_art`), its proposal approved,
 *   its job succeeded and verified;
 * - **C3** read back LIVE and PRINTED as `F7.1 CORE index=… core=… referenceType=… wording=… art=… images=…`: the index
 *   `[INDEX] Probe <Letters>` (the Reference under it), the Character Core (`[BWRK] Probe <Letters> - Character Core`,
 *   Reference Type `Character Core`, its text saying "Character Core", no longer "compact reference") and
 *   `[BWRK] Probe <Letters> - Character Art` under the index with its image.
 *
 * Clean-up: the throwaway index with everything under it (or the Reference, if no index was made) and the character's
 * asset folder, even after a failure (test/sandbox/steps.ts). Cost: about 20 writes and 40 reads.
 */
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import type { RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface CoreCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));

/** Five letters, capitalised (a page name takes no digits or dates). */
function letters(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
  return s[0]!.toUpperCase() + s.slice(1);
}

const textOf = (b: Obj): string =>
  Array.isArray(b.content)
    ? (b.content as Obj[]).map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
    : '';

export async function runCoreUpgradeCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<CoreCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f7-1-core', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: CoreCheckItem[] = [];
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

  // A temporary write-scope principal, the rails off (as the write-scope rehearsal's).
  const profile = rt.policy.commands.createProfile('owner', {
    label: `f7.1 check ${Date.now()}`,
    kind: 'other',
    scope: 'write',
  });
  rt.policy.commands.setRails('owner', profile.id, {
    deletes: false,
    bulk: false,
    renamesMoves: false,
    assets: false,
  });
  const pats = new PatService({
    store: new AuthStore(sb.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const who: Principal = rt.policy.store.lookupPrincipal(
    pats.create({ name: 'f7.1 check', profileId: profile.id, expiresInDays: 1 }).pat.id,
  )!.principal;
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (t: string, args: Obj): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === t);
    if (!provider) throw new Error(`${t} is not a tool of this bridge (deploy F7.1 first)`);
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${t}: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: who,
      scope: 'write',
      showLowLevelTools: false,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true)
      throw new Error(`${t}: ${String(body.error?.code)} ${String(body.error?.message)}`);
    return body;
  };
  /** A proposal approved as the owner (as canon when it is), or the direct job; then its job waited for. */
  const settle = async (body: Obj, what: string): Promise<Obj> => {
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
  };

  const subject = `Probe ${letters()}`;
  const made: { identity: string | null; index: string | null } = { identity: null, index: null };
  steps.defer('the throwaway character and its asset folder deleted', async () => {
    const left: string[] = [];
    const del = async (what: string, path: string) => {
      try {
        await raw.request('deleteResource', 'DELETE', path);
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${what}: ${m}`);
      }
    };
    if (made.index) await del(`index ${made.index}`, `/resources/${made.index}?cascade=true`);
    else if (made.identity) await del(`page ${made.identity}`, `/resources/${made.identity}?cascade=true`);
    for (const f of rt.assets.queries.findFoldersByName(pid, subject).data) {
      try {
        await raw.request('deleteAsset', 'DELETE', `/assets/${f.id}`);
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`folder ${subject} (${f.id}): ${m}`);
      }
    }
    items.push({
      id: 'cleanup',
      title: 'the throwaway character and its asset folder deleted (404 counts as cleaned)',
      verdict: left.length === 0 ? 'pass' : 'fail',
      detail: left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`,
    });
  });

  try {
    const c0 = await check('C0', 'the Arkona pack attached here; the asset tree built', async () => {
      if (!copied.packs.includes('arkona'))
        throw new Error(`packs attached: ${copied.packs.join(', ') || 'none'}; deploy F7.1 first`);
      if (rt.assets.meta(pid).status === 'not_built') {
        rt.assets.prepareBuild(pid, { trigger: 'sandbox-f7-1', autoConfirm: true });
        for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
          await new Promise((r) => setTimeout(r, 500));
      }
      return `asset tree ${rt.assets.meta(pid).status}; packs attached: ${copied.packs.join(', ')}`;
    });
    if (!c0) return items;
    const c1 = await check('C1', `a throwaway Working compact character (${subject})`, async () => {
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
            scope: 'A sandbox probe of the Core upgrade',
            markdown: `## Purpose\n\nThe compact reference for ${subject}, a sandbox probe.\n\n## Identity\n\nA probe.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nEverything else.\n`,
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
    if (!c1) return items;
    const c2 = await check('C2', 'one art piece added (arkona_add_character_art)', async () => {
      const staged = await tool('upload_image', {
        data_base64: fixture('alpha.png').toString('base64'),
        name: `${subject} probe`,
        stage: true,
      });
      const body = await tool('arkona_add_character_art', {
        character: made.identity,
        images: [
          {
            staged_id: String(staged.staged_id),
            label: 'Primary Reference - Probe',
            interpretation: 'Establishes nothing: a sandbox probe.',
          },
        ],
      });
      const job = await settle(body, 'add the art');
      if ((job.result as Obj | undefined)?.verified !== true)
        throw new Error(`the job did not verify: ${JSON.stringify(job.result).slice(0, 600)}`);
      return `job ${String(job.id)} succeeded and verified`;
    });
    if (!c2) return items;
    await check('C3', 'read back live: the index, the Character Core and the Art page', async () => {
      const core = await raw.request('getResource', 'GET', `/resources/${made.identity}`);
      const index = core.parentId
        ? await raw.request('getResource', 'GET', `/resources/${core.parentId}`)
        : null;
      if (index?.name === `[INDEX] ${subject}`) made.index = String(index.id);
      const kv = ((core.properties ?? []) as Obj[]).find(
        (p) => p.kind === 'keyValue' && p.title === 'PROPERTIES',
      );
      const rtRow = ((kv?.rows ?? []) as Obj[]).find((r) => r.key === 'Reference Type');
      const referenceType = rtRow ? textOf(rtRow) || String(rtRow.text ?? '') : '?';
      const docs = await raw.request('listDocuments', 'GET', `/resources/${made.identity}/docs`);
      const main = ((docs.data ?? []) as Obj[]).find((d) => d.name === 'Main');
      const blocks = main
        ? (((
            await raw.request(
              'getDocumentBlocks',
              'GET',
              `/resources/${made.identity}/docs/${main.id}/blocks`,
            )
          ).blocks ?? []) as Obj[])
        : [];
      const words = blocks.map(textOf).join(' ');
      const wording = /compact reference/i.test(words)
        ? 'still compact'
        : /Character Core/.test(words)
          ? 'Core'
          : '?';
      const kids = made.index
        ? (((await raw.request('listResources', 'GET', `/resources?parentId=${made.index}&limit=100`)).data ??
            []) as Obj[])
        : [];
      const art = kids.find((k) => k.name === `[BWRK] ${subject} - Character Art`);
      let images = 0;
      if (art) {
        const ad = await raw.request('listDocuments', 'GET', `/resources/${String(art.id)}/docs`);
        const am = ((ad.data ?? []) as Obj[]).find((d) => d.name === 'Main');
        if (am)
          images = (
            ((
              await raw.request(
                'getDocumentBlocks',
                'GET',
                `/resources/${String(art.id)}/docs/${am.id}/blocks`,
              )
            ).blocks ?? []) as Obj[]
          ).filter((b) => b.kind === 'image').length;
      }
      const line = `F7.1 CORE index=${index?.name ?? '-'} core=${String(core.name)} referenceType=${referenceType} wording=${wording} art=${art ? String(art.name) : '-'} images=${images}`;
      const problems = [
        ...(made.index ? [] : ['no index']),
        ...(core.name === `[BWRK] ${subject} - Character Core` ? [] : ['not renamed to its Core']),
        ...(referenceType === 'Character Core' ? [] : ['Reference Type not Character Core']),
        ...(wording === 'Core' ? [] : ['its wording still compact']),
        ...(art && images >= 1 ? [] : ['no Art page with its image under the index']),
      ];
      if (problems.length > 0) throw new Error(`${line} (${problems.join('; ')})`);
      return line;
    });
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatCoreUpgradeReport(items: readonly CoreCheckItem[]): string {
  return [
    'sandbox f7-1-core report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
