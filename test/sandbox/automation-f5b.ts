/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F5b (ADR 0068; the owner-approved design docs/design/F5-orchestration.md, H5), opt-in, WRITES then cleans up: the
 * automation framework end to end on the real API, on the test world only. Written for the owner; never run by an agent
 * or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- automation-f5b
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. In the TEMPORARY database
 * only, the Arkona pack's governance sources (Repository Automation's three pinned sections among them) are pointed at
 * a throwaway governance page the check makes, and the pack is approved there as the owner would. The run is limited to
 * the check's two probe pages (`onlyPages`), and only they are snapshotted (R4.1), so nothing else of the test world is
 * read as a finding or written. Each step reports PASS or FAIL:
 *
 * - **A1** a throwaway index `lk-bridge f5b check <time>` and its governance page (every pinned heading; "Approved
 *   Narrow Automations" holding the block-id sweep's paragraph); the pack approved in the temporary database;
 * - **A2** two probe pages (raw client): `[BSRC] lk-bridge f5b blanks <time>` (a decorative blank paragraph between two
 *   paragraphs) and `[BSRC] lk-bridge f5b order <time>` tagged `Law, CANON` (the wrong order); both Authoritative Main
 *   CANON; only the probe pages snapshotted;
 * - **A3** both codes (`blank_paragraphs`, `retag_correction`) set to Apply by the owner: each paragraph written after
 *   the sweep's, read back live; the pack still current (its approval carried over the bridge's own writes);
 * - **A4** the run: both pages applied, as the Automation principal, each on the Review page;
 * - **A5** read back live: the blank paragraph gone and every other block as it was; the tags exactly `CANON, Law`;
 * - **A6** both codes switched Off: each paragraph amended to say so (never deleted), read back live; the pack current.
 *
 * Clean-up: the throwaway index deleted with everything under it, with the raw client, even after a failure or a step's
 * timeout (test/sandbox/steps.ts), and again from the test file's `afterAll`; the report names what must be deleted by
 * hand. Cost: about 14 writes and 60 reads.
 */
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { ProjectStore } from '../../src/projects/index.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { SUPPLEMENTARY_SENTENCE } from './tagging-f5a.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface AutomationCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

/** The block-id sweep's paragraph, in the words the owner's brief quotes. */
export const SWEEP_SENTENCE =
  'Assign Block IDs Sweep (owner approval, 17 November 2026): enabling it is the activation, and this approval establishes no wider repair whitelist.';

const CANON_ROWS = [
  { key: 'Status', text: 'Authoritative' },
  { key: 'Continuity Type', text: 'CANON' },
  { key: 'Continuity', text: 'Main' },
  { key: 'Inheritance', text: 'None' },
];

const CODES = ['blank_paragraphs', 'retag_correction'] as const;

const runsText = (b: Obj): string =>
  (Array.isArray(b.content) ? (b.content as Obj[]) : [])
    .map((r) => (typeof r.text === 'string' ? r.text : ''))
    .join('');

export async function runAutomationCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun },
): Promise<AutomationCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'automation-f5b', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: AutomationCheckItem[] = [];
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
  if (!copied.packs.includes('arkona') || !pack?.rules.automation) {
    items.push({
      id: 'A0',
      title: 'the Arkona pack, with the automation rules, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F5b (the seed arkona-2026-11-23-f5b) first`,
    });
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const made: { index: string | null } = { index: null };
  const page = { blanks: '', order: '', gov: '', govDoc: '' };
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
  const a = rt.automation;
  const govBlocks = async (): Promise<Obj[]> =>
    ((await raw.request('getDocumentBlocks', 'GET', `/resources/${page.gov}/docs/${page.govDoc}/blocks`))
      .blocks ?? []) as Obj[];
  const paragraphs = async (code: string) =>
    (await govBlocks()).filter((b) => runsText(b).startsWith(`Bridge automation ${code}:`)).map(runsText);
  try {
    const ok1 = await check(
      'A1',
      'a throwaway governance page; the pack approved in the temporary database',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5b check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const gov = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5b governance ${stamp}`,
          parentId: made.index,
          documents: [{ name: 'Main', type: 'page' }],
        });
        page.gov = String(gov.id);
        const docs = (gov.documents ?? []) as Obj[];
        page.govDoc = String((docs.find((d) => d.name === 'Main') ?? docs[0])?.id ?? '');
        if (page.govDoc === '') throw new Error(`the governance page ${page.gov} came back with no document`);
        const automation = pack.rules.automation!;
        // The pack's sources and the seed's (Repository Automation is the seed's since F5b), by key.
        const sources = [
          ...pack.governance,
          ...ARKONA_PACK.governance.filter((g) => !pack.governance.some((x) => x.key === g.key)),
        ];
        const headings = [...new Set(sources.flatMap((g) => g.sections ?? []))];
        const blocks: Obj[] = [
          { kind: 'heading', level: 1, content: [{ text: 'lk-bridge f5b governance' }] },
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
                      : h === automation.section
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
        // The temporary database only: every governance source pointed at the throwaway page, then approved.
        rt.packs.store.setGovernance(
          'arkona',
          sources.map((g) => ({ ...g, project: name, resourceId: page.gov, documentId: page.govDoc })),
        );
        await rt.packs.commands.approve('owner', 'arkona');
        const g = await rt.packs.governance('arkona');
        if (g.state !== 'current') throw new Error(`the pack is ${g.state}: ${g.message}`);
        const state = await a.governanceState(pid);
        if (!state.ok) throw new Error(`automation’s governance: ${state.message}`);
        return `index ${made.index}, governance ${page.gov}; pack version ${rt.packs.get('arkona')!.approved!.version} approved (temporary database)`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check(
      'A2',
      'two probe pages (a blank paragraph; tags in the wrong order), snapshotted',
      async () => {
        const blanks = await raw.request('createResource', 'POST', '/resources', {
          name: `[BSRC] lk-bridge f5b blanks ${stamp}`,
          parentId: made.index,
          tags: ['CANON', 'Law'],
          documents: [{ name: 'Main', type: 'page' }],
        });
        page.blanks = String(blanks.id);
        const order = await raw.request('createResource', 'POST', '/resources', {
          name: `[BSRC] lk-bridge f5b order ${stamp}`,
          parentId: made.index,
          tags: ['Law', 'CANON'],
        });
        page.order = String(order.id);
        for (const id of [page.blanks, page.order])
          await raw.request('createProperty', 'POST', `/resources/${id}/properties`, {
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: CANON_ROWS,
          });
        const docId = String(((blanks.documents ?? []) as Obj[])[0]?.id ?? '');
        const doc = await raw.request(
          'getDocumentBlocks',
          'GET',
          `/resources/${page.blanks}/docs/${docId}/blocks`,
        );
        await raw.request(
          'replaceDocumentBlocks',
          'PUT',
          `/resources/${page.blanks}/docs/${docId}/blocks`,
          {
            blocks: [
              { kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
              { kind: 'paragraph', content: [{ text: 'A probe page of the F5b sandbox check.' }] },
              { kind: 'paragraph', content: [] },
              { kind: 'paragraph', content: [{ text: 'Its last paragraph.' }] },
            ],
          },
          { ifMatch: String(doc.version) },
        );
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
        for (const id of [page.blanks, page.order])
          if (!rt.tree.queries.node(pid, id).data) throw new Error(`the tree’s sweep did not find ${id}`);
        const snap = await snapshotPagesOnly(sb, [made.index!, page.blanks, page.order], 'automation-f5b');
        return `${page.blanks}, ${page.order}; ${snap}`;
      },
    );
    if (!ok2) return items;

    const ok3 = await check(
      'A3',
      'both codes set to Apply: each paragraph written after the sweep’s; the pack current',
      async () => {
        for (const code of CODES) {
          const r = await a.setMode('owner', pid, code, 'apply');
          if (r.governance !== 'written') throw new Error(`${code}: the governance write ${r.governance}`);
        }
        const texts = (await govBlocks()).map(runsText);
        const sweepAt = texts.indexOf(SWEEP_SENTENCE);
        const at = CODES.map((c) => texts.findIndex((t) => t.startsWith(`Bridge automation ${c}:`)));
        if (sweepAt < 0 || at[0] !== sweepAt + 1 || at[1] !== sweepAt + 2)
          throw new Error(
            `the paragraphs are not after the sweep’s: sweep ${sweepAt}, ${CODES.join(', ')} ${at.join(', ')}`,
          );
        for (const c of CODES) {
          const [p] = await paragraphs(c);
          if (
            !p?.includes('Setting: Apply automatically') ||
            !p.includes('owner approval through the bridge dashboard')
          )
            throw new Error(`${c}: ${p ?? 'no paragraph'}`);
        }
        const g = await rt.packs.governance('arkona');
        if (g.state !== 'current')
          throw new Error(`the pack drifted on the bridge’s own write: ${g.message}`);
        return `paragraphs ${at.join(', ')} after the sweep’s (${sweepAt}); the pack current`;
      },
    );
    if (!ok3) return items;

    let runId = '';
    const ok4 = await check(
      'A4',
      'the run: both pages applied by the Automation principal, on the Review page',
      async () => {
        const run = await a.run(pid, 'manual', { onlyPages: new Set([page.blanks, page.order]) });
        runId = run.id;
        const got = a.store.items(run.id);
        const applied = got.filter((i) => i.outcome === 'applied');
        if (applied.length !== 2)
          throw new Error(
            `run ${run.state}: ${got.map((i) => `${i.code} ${i.pageId} ${i.outcome} ${i.reason ?? ''}`).join('; ')}`,
          );
        for (const i of applied) {
          const job = rt.engine.queries.getJob(pid, i.jobId!);
          if (job?.principalId !== 'automation') throw new Error(`${i.jobId}: principal ${job?.principalId}`);
          if (!rt.review.store.get(pid, i.jobId!)) throw new Error(`${i.jobId} is not on the Review page`);
        }
        return `run ${run.id}: ${applied.map((i) => `${i.code} on ${i.pageId} (job ${i.jobId})`).join('; ')}`;
      },
    );
    if (!ok4) return items;

    const ok5 = await check(
      'A5',
      'read back live: the blank paragraph gone, the rest as it was; tags CANON, Law',
      async () => {
        const res = await raw.request('getResource', 'GET', `/resources/${page.blanks}`);
        const docId = String(((res.documents ?? []) as Obj[]).find((d) => d.type === 'page')?.id ?? '');
        const doc = await raw.request(
          'getDocumentBlocks',
          'GET',
          `/resources/${page.blanks}/docs/${docId}/blocks`,
        );
        const texts = ((doc.blocks ?? []) as Obj[]).map((b) => `${String(b.kind)}:${runsText(b)}`);
        const want = [
          'heading:Purpose',
          'paragraph:A probe page of the F5b sandbox check.',
          'paragraph:Its last paragraph.',
        ];
        if (JSON.stringify(texts) !== JSON.stringify(want))
          throw new Error(`the page reads ${JSON.stringify(texts)}`);
        const tags = ((await raw.request('getResource', 'GET', `/resources/${page.order}`)).tags ??
          []) as string[];
        if (JSON.stringify(tags) !== JSON.stringify(['CANON', 'Law']))
          throw new Error(`tags ${tags.join(', ')}`);
        return `blanks: ${texts.length} blocks, none blank; order: ${tags.join(', ')} (run ${runId})`;
      },
    );
    if (!ok5) return items;

    await check(
      'A6',
      'both codes switched Off: each paragraph amended (never deleted); the pack current',
      async () => {
        for (const code of CODES) {
          const r = await a.setMode('owner', pid, code, 'off');
          if (r.governance !== 'written')
            throw new Error(`${code}: the governance amendment ${r.governance}`);
        }
        for (const c of CODES) {
          const ps = await paragraphs(c);
          if (
            ps.length !== 1 ||
            !/Setting: Off since .*\(switched off by the owner\): not running/.test(ps[0]!)
          )
            throw new Error(`${c}: ${ps.join(' | ') || 'no paragraph'}`);
        }
        const g = await rt.packs.governance('arkona');
        if (g.state !== 'current') throw new Error(`the pack drifted: ${g.message}`);
        return 'both paragraphs say Off; the pack current';
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatAutomationReport(items: readonly AutomationCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: automatic actions for audits (F5b, ADR 0068)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
