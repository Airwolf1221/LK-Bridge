/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F5c (ADR 0069; the owner-approved design docs/design/F5-orchestration.md, H6 to H8), opt-in, WRITES then cleans
 * up: `arkona_identity_reconcile`, `query_facts` and the workstream report end to end on the real API, on the test world
 * only. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- identity-f5c
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. In the TEMPORARY database
 * only, the Arkona pack's governance sources are pointed at a throwaway governance page the check makes (the test
 * project cannot read Arkona's governance, and the tagging policy check reads it) and the pack is approved there, as the
 * owner would. The tools are called as the MCP server calls them, for a temporary write-scope principal with the rails
 * off. Each step reports PASS or FAIL:
 *
 * - **I1** a throwaway index `lk-bridge f5c check <time>` and its governance page (every pinned heading); the pack
 *   approved in the temporary database;
 * - **I2** two throwaway characters (raw client): `[BSRC] lk-bridge f5c Alpha <time> - Character Core` (Human,
 *   Menkheti) and `… Beta …` (Human, Canthan), each tagged in grammar order, found by the tree's sweep;
 * - **I3** the dry run: both planned (Naming Culture Menkheti → Velaran, Canthan → Fujimatsuan), the tags recomputed
 *   (CANON, Character, Human, Velaran / Fujimatsuan); nothing written (both read back live unchanged);
 * - **I4** the run, under the workstream `lk-bridge f5c <time>`: both items done and verified;
 * - **I5** read back live (raw client): both facts and both tag arrays exactly as planned;
 * - **I6** `query_facts` over the index (characters: true): both rows with the new Naming Culture and tags, free;
 * - **I7** `bridge_workstream_report`: both pages written and verified, nothing awaiting, nothing unknown; free.
 *
 * Clean-up: the throwaway index deleted with everything under it, with the raw client, even after a failure or a step's
 * timeout (test/sandbox/steps.ts), and again from the test file's `afterAll`; the report names what must be deleted by
 * hand. Cost: about 16 writes and 40 reads.
 */
import { pino } from 'pino';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { ProjectStore } from '../../src/projects/index.js';
import { deleteProbe, type RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { SUPPLEMENTARY_SENTENCE } from './tagging-f5a.js';
import { SWEEP_SENTENCE } from './automation-f5b.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface IdentityCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

const CANON_ROWS = [
  { key: 'Status', text: 'Authoritative' },
  { key: 'Continuity Type', text: 'CANON' },
  { key: 'Continuity', text: 'Main' },
  { key: 'Inheritance', text: 'None' },
];

/** The two probe characters: their culture before and after (values the seed's culture map already holds). */
const PROBES = [
  { key: 'Alpha', from: 'Menkheti', to: 'Velaran' },
  { key: 'Beta', from: 'Canthan', to: 'Fujimatsuan' },
] as const;

const same = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

export async function runIdentityCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun },
): Promise<IdentityCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'identity-f5c', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: IdentityCheckItem[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: o.bridgeDbPath,
    target: sb.db,
    projectId: pid,
    runtime: rt,
  });
  const pack = rt.packs.get('arkona');
  if (!copied.packs.includes('arkona') || !pack?.rules.retag) {
    items.push({
      id: 'I0',
      title: 'the Arkona pack, with its retag rules, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F5c (the seed arkona-2026-11-23-f5c) first`,
    });
    return items;
  }
  // A temporary write-scope principal, the rails off (as the write-scope rehearsal's).
  const profile = rt.policy.commands.createProfile('owner', {
    label: `f5c check ${Date.now()}`,
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
    pats.create({ name: 'f5c check', profileId: profile.id, expiresInDays: 1 }).pat.id,
  )!.principal;
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (t: string, args: Obj): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === t);
    if (!provider) throw new Error(`${t} is not a tool of this bridge (deploy F5c first)`);
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${t}: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: who,
      scope: 'write',
      showLowLevelTools: true,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true)
      throw new Error(`${t}: ${String(body.error?.code)} ${String(body.error?.message)}`);
    return body;
  };
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workstream = `lk-bridge f5c ${stamp}`.slice(0, 80);
  const made: { index: string | null } = { index: null };
  const page = { gov: '', govDoc: '' };
  const chars: { key: string; from: string; to: string; id: string; name: string }[] = [];
  steps.defer('the throwaway index deleted with everything under it', async () => {
    if (!made.index) return;
    try {
      await deleteProbe(raw, made.index);
    } catch (e) {
      items.push({
        id: 'cleanup',
        title: 'the throwaway index deleted',
        verdict: 'fail',
        detail: `${made.index}: ${(e as Error).message}. Delete it by hand.`,
      });
      throw e;
    }
  });
  const live = async (id: string): Promise<{ tags: string[]; culture: string | null }> => {
    const res = await raw.request('getResource', 'GET', `/resources/${id}`);
    const kv = ((res.properties ?? []) as Obj[]).find(
      (p) => p.kind === 'keyValue' && p.title === 'PROPERTIES',
    );
    const row = ((kv?.rows ?? []) as Obj[]).find((r) => r.key === 'Naming Culture');
    const text =
      typeof row?.text === 'string'
        ? row.text
        : ((row?.content ?? []) as Obj[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
    return { tags: (res.tags ?? []) as string[], culture: row ? text : null };
  };
  try {
    const ok1 = await check(
      'I1',
      'a throwaway governance page; the pack approved in the temporary database',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5c check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const gov = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5c governance ${stamp}`,
          parentId: made.index,
          documents: [{ name: 'Main', type: 'page' }],
        });
        page.gov = String(gov.id);
        const docs = (gov.documents ?? []) as Obj[];
        page.govDoc = String((docs.find((d) => d.name === 'Main') ?? docs[0])?.id ?? '');
        if (page.govDoc === '') throw new Error(`the governance page ${page.gov} came back with no document`);
        const sources = [
          ...pack.governance,
          ...ARKONA_PACK.governance.filter((g) => !pack.governance.some((x) => x.key === g.key)),
        ];
        const headings = [...new Set(sources.flatMap((g) => g.sections ?? []))];
        const blocks: Obj[] = [
          { kind: 'heading', level: 1, content: [{ text: 'lk-bridge f5c governance' }] },
        ];
        for (const h of headings)
          blocks.push(
            { kind: 'heading', level: 2, content: [{ text: h }] },
            {
              kind: 'paragraph',
              content: [
                {
                  text:
                    h === pack.rules.retag?.supplementary?.section
                      ? SUPPLEMENTARY_SENTENCE
                      : h === (pack.rules.automation?.section ?? ARKONA_PACK.rules.automation?.section)
                        ? SWEEP_SENTENCE
                        : `The rules of ${h}.`,
                },
              ],
            },
          );
        const doc = await raw.request(
          'getDocumentBlocks',
          'GET',
          `/resources/${page.gov}/docs/${page.govDoc}/blocks`,
        );
        await raw.request(
          'replaceDocumentBlocks',
          'PUT',
          `/resources/${page.gov}/docs/${page.govDoc}/blocks`,
          { blocks },
          { ifMatch: String(doc.version) },
        );
        rt.packs.store.setGovernance(
          'arkona',
          sources.map((g) => ({ ...g, project: name, resourceId: page.gov, documentId: page.govDoc })),
        );
        await rt.packs.commands.approve('owner', 'arkona');
        const g = await rt.packs.governance('arkona');
        if (g.state !== 'current') throw new Error(`the pack is ${g.state}: ${g.message}`);
        return `index ${made.index}, governance ${page.gov}; pack version ${rt.packs.get('arkona')!.approved!.version} approved (temporary database)`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check(
      'I2',
      'two throwaway characters (Human; Menkheti and Canthan), found by the tree',
      async () => {
        for (const p of PROBES) {
          const display = `lk-bridge f5c ${p.key} ${stamp}`;
          const r = await raw.request('createResource', 'POST', '/resources', {
            name: `[BSRC] ${display} - Character Core`,
            parentId: made.index,
            tags: ['CANON', 'Character', 'Human', p.from],
          });
          await raw.request('createProperty', 'POST', `/resources/${String(r.id)}/properties`, {
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: [
              ...CANON_ROWS,
              { key: 'Subject', text: display },
              { key: 'Reference Type', text: 'Character Core' },
              { key: 'Race / Species', text: 'Human' },
              { key: 'Naming Culture', text: p.from },
              { key: 'Life State', text: 'Alive' },
            ],
          });
          chars.push({ ...p, id: String(r.id), name: display });
        }
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
        for (const c of chars) {
          const n = rt.tree.queries.node(pid, c.id).data;
          if (!n) throw new Error(`the tree’s sweep did not find ${c.id}`);
          if (n.referenceType !== 'Character Core')
            throw new Error(`${c.id}: Reference Type ${String(n.referenceType)}`);
        }
        return chars.map((c) => `${c.id} (${c.from})`).join(', ');
      },
    );
    if (!ok2) return items;

    const items0 = () => chars.map((c) => ({ character: c.id, facts: { 'Naming Culture': c.to } }));
    const ok3 = await check('I3', 'the dry run: both planned with their tags; nothing written', async () => {
      const b = await tool('arkona_identity_reconcile', { items: items0(), dryRun: true, workstream });
      if (b.status !== 'dry_run') throw new Error(`status ${String(b.status)}: ${JSON.stringify(b)}`);
      for (const c of chars) {
        const it = (b.items as Obj[]).find((x) => x.page?.id === c.id);
        const want = ['CANON', 'Character', 'Human', c.to];
        if (it?.status !== 'planned' || it.tags?.status !== 'write' || !same(it.tags.proposed, want))
          throw new Error(`${c.id}: ${JSON.stringify(it)}`);
        const now = await live(c.id);
        if (now.culture !== c.from || !same(now.tags, ['CANON', 'Character', 'Human', c.from]))
          throw new Error(`${c.id} changed by the dry run: ${JSON.stringify(now)}`);
      }
      return chars
        .map((c) => `${c.id}: ${c.from} → ${c.to}; tags CANON, Character, Human, ${c.to}`)
        .join('; ');
    });
    if (!ok3) return items;

    let jobId = '';
    const ok4 = await check('I4', 'the run under a workstream: both items done and verified', async () => {
      const b = await tool('arkona_identity_reconcile', { items: items0(), workstream });
      if (b.status !== 'finished') throw new Error(`status ${String(b.status)}: ${JSON.stringify(b)}`);
      jobId = String(b.jobId);
      for (const c of chars) {
        const it = (b.items as Obj[]).find((x) => x.page?.id === c.id);
        if (it?.status !== 'done' || it.facts?.verified !== true || it.tags?.verified !== true)
          throw new Error(`${c.id}: ${JSON.stringify(it)}`);
      }
      if (b.workstream !== workstream) throw new Error(`the workstream echoed: ${String(b.workstream)}`);
      return `job ${jobId}: ${String(b.summary)}`;
    });
    if (!ok4) return items;

    const ok5 = await check(
      'I5',
      'read back live: both facts and both tag arrays exactly as planned',
      async () => {
        for (const c of chars) {
          const now = await live(c.id);
          if (now.culture !== c.to || !same(now.tags, ['CANON', 'Character', 'Human', c.to]))
            throw new Error(`${c.id}: ${JSON.stringify(now)}`);
        }
        return chars.map((c) => `${c.id}: ${c.to}`).join('; ');
      },
    );
    if (!ok5) return items;

    const ok6 = await check(
      'I6',
      'query_facts over the index: both rows with the new values, free',
      async () => {
        const b = await tool('query_facts', {
          characters: true,
          under: made.index,
          fields: ['id', 'Naming Culture', 'tags'],
        });
        if (b.cost !== 'none') throw new Error(`cost ${String(b.cost)}`);
        const rows = b.rows as unknown[][];
        for (const c of chars) {
          const row = rows.find((r) => r[0] === c.id);
          if (!row || row[1] !== c.to || !same(row[2] as unknown[], ['CANON', 'Character', 'Human', c.to]))
            throw new Error(`${c.id}: ${JSON.stringify(row)}; the whole answer: ${JSON.stringify(b)}`);
        }
        return `${rows.length} row(s); columns ${(b.columns as string[]).join(', ')}`;
      },
    );
    if (!ok6) return items;

    await check(
      'I7',
      'the workstream report: both pages written and verified, nothing waiting, free',
      async () => {
        const b = await tool('bridge_workstream_report', { workstream });
        const written = (b.groups?.writtenAndVerified ?? []) as Obj[];
        for (const c of chars) {
          const p = written.find((x) => x.page?.id === c.id);
          if (!p || p.verified !== true) throw new Error(`${c.id}: ${JSON.stringify(p ?? null)}`);
        }
        if (
          (b.groups.awaitingJudgement as unknown[]).length > 0 ||
          (b.groups.residualInconsistencies.unknownOutcomes as unknown[]).length > 0
        )
          throw new Error(`something waits or is unknown: ${JSON.stringify(b.groups)}`);
        return `${String(b.counts.pagesChanged)} page(s) changed, ${String(b.counts.pagesVerified)} verified; ${String(b.cost)}`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatIdentityReport(items: readonly IdentityCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: identity reconcile, query_facts and workstreams (F5c, ADR 0069)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
