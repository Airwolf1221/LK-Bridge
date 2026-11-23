/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H1, H2 and H3), opt-in, WRITES then
 * cleans up: the Approved Supplementary Tags and the owner's "Keep this tag here" ruling end to end on the real API.
 * Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- tagging-f5a
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance
 * sources sit on Arkona, which this runtime does not serve, so in the TEMPORARY database only they are pointed at a
 * throwaway governance page the check makes (every pinned heading, the Tagging Standard's "Approved Supplementary Tags"
 * sentence verbatim) and the pack is approved there as the owner would: the retag job's policy check reads it, as on
 * Arkona. Each step reports PASS or FAIL:
 *
 * - **T1** a throwaway index `lk-bridge f5a check <time>`, its governance page, and the pack approved in the temporary
 *   database: its Approved Supplementary Tags read from the section (Cosmology, Chronology, Setting Framework);
 * - **T2** two probe pages (raw client): `[BSRC] lk-bridge f5a cosmology <time>` tagged CANON, Cosmology, and
 *   `[BSRC] lk-bridge f5a keep <time>` tagged CANON, Law, lkbf5aprobe; both Authoritative Main CANON, classified Law by
 *   the owner; only the probe's own pages snapshotted (R4.1);
 * - **T3** the audit: the first page is a correction, CANON, Law, Cosmology (Cosmology kept after the grammar, not an
 *   exception);
 * - **T4** the apply: one proposal, approved as the owner would; its job writes the array, reads it back, and the page
 *   read live holds exactly CANON, Law, Cosmology;
 * - **T5** "Keep this tag here" on the second page: the audit finds it compliant;
 * - **T6** its tags changed (reordered, with the raw client): the ruling lapses and the audit shows the exception again.
 *
 * Clean-up: the throwaway index deleted with everything under it, with the raw client, even after a failure or a step's
 * timeout (test/sandbox/steps.ts), and again from the test file's `afterAll`; the report names what must be deleted by
 * hand. Cost: about 12 writes and 25 reads.
 */
import { ProjectStore } from '../../src/projects/index.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface TaggingCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

/** The Tagging Standard's section as Arkona's page has it (23 November 2026), verbatim. */
export const SUPPLEMENTARY_SENTENCE =
  'Under the Exact Tag Grammar’s provision for a deliberately approved exception, the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework. A permitted supplementary tag is kept, after the grammar’s slots, wherever it appears. It is not a primary category or a specialist function, it is never added to a page by inference or by an audit, and it is never proposed for removal as incidental. Adding a tag to this list, or removing one, is an author decision recorded here.';

/** The incidental tag on the second probe page (an exception everywhere: no rule lists it). */
export const PROBE_TAG = 'lkbf5aprobe';

const CANON_ROWS = [
  { key: 'Status', text: 'Authoritative' },
  { key: 'Continuity Type', text: 'CANON' },
  { key: 'Continuity', text: 'Main' },
  { key: 'Inheritance', text: 'None' },
];

export async function runTaggingCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun },
): Promise<TaggingCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'tagging-f5a', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: TaggingCheckItem[] = [];
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
  if (!copied.packs.includes('arkona') || !pack?.rules.retag?.supplementary) {
    items.push({
      id: 'T0',
      title: 'the Arkona pack, with its Approved Supplementary Tags, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F5a (the seed arkona-2026-11-23-f5a) first`,
    });
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const made: { index: string | null } = { index: null };
  const page = { cosmology: '', keep: '' };
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
  const liveTags = async (id: string): Promise<string[]> =>
    ((await raw.request('getResource', 'GET', `/resources/${id}`)).tags ?? []) as string[];
  const audit = async (id: string) => {
    const r = await rt.retag.audit({ projectId: pid, actor: 'owner', scope: { pageId: id } });
    const v = r.verdicts.find((x) => x.pageId === id);
    if (!v) throw new Error(`the audit has no verdict for ${id}`);
    return { run: r.run, v };
  };
  try {
    const ok1 = await check(
      'T1',
      'a throwaway governance page; the pack approved in the temporary database',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5a check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const gov = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f5a governance ${stamp}`,
          parentId: made.index,
          documents: [{ name: 'Main', type: 'page' }],
        });
        const govId = String(gov.id);
        const docs = (gov.documents ?? []) as Obj[];
        const docId = String((docs.find((d) => d.name === 'Main') ?? docs[0])?.id ?? '');
        if (docId === '') throw new Error(`the governance page ${govId} came back with no document`);
        const headings = [...new Set(pack.governance.flatMap((g) => g.sections ?? []))];
        const blocks: Obj[] = [
          { kind: 'heading', level: 1, content: [{ text: 'lk-bridge f5a governance' }] },
        ];
        for (const h of headings)
          blocks.push(
            { kind: 'heading', level: 2, content: [{ text: h }] },
            {
              kind: 'paragraph',
              content: [
                {
                  text:
                    h === pack.rules.retag!.supplementary!.section
                      ? SUPPLEMENTARY_SENTENCE
                      : `The rules of ${h}.`,
                },
              ],
            },
          );
        const doc = await raw.request('getDocumentBlocks', 'GET', `/resources/${govId}/docs/${docId}/blocks`);
        await raw.request(
          'replaceDocumentBlocks',
          'PUT',
          `/resources/${govId}/docs/${docId}/blocks`,
          { blocks },
          {
            ifMatch: String(doc.version),
          },
        );
        // The temporary database only: every governance source pointed at the throwaway page, then approved.
        rt.packs.store.setGovernance(
          'arkona',
          pack.governance.map((g) => ({ ...g, project: name, resourceId: govId, documentId: docId })),
        );
        await rt.packs.commands.approve('owner', 'arkona');
        const g = await rt.packs.governance('arkona');
        if (g.state !== 'current') throw new Error(`the pack is ${g.state}: ${g.message}`);
        if (g.supplementary?.state !== 'same')
          throw new Error(`the Approved Supplementary Tags read ${JSON.stringify(g.supplementary ?? null)}`);
        return `index ${made.index}, governance ${govId}; pack version ${rt.packs.get('arkona')!.approved!.version} approved (temporary database); supplementary: ${g.supplementary.tags.join(', ')}`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check('T2', 'two probe pages, classified Law by the owner, snapshotted', async () => {
      for (const [key, tags] of [
        ['cosmology', ['CANON', 'Cosmology']],
        ['keep', ['CANON', 'Law', PROBE_TAG]],
      ] as const) {
        const r = await raw.request('createResource', 'POST', '/resources', {
          name: `[BSRC] lk-bridge f5a ${key} ${stamp}`,
          parentId: made.index,
          tags: [...tags],
        });
        page[key] = String(r.id);
        await raw.request('createProperty', 'POST', `/resources/${page[key]}/properties`, {
          kind: 'keyValue',
          title: 'PROPERTIES',
          rows: CANON_ROWS,
        });
      }
      await rt.tree.sweep(pid, 'manual');
      await rt.tree.whenIdle();
      for (const id of [page.cosmology, page.keep]) {
        if (!rt.tree.queries.node(pid, id).data) throw new Error(`the tree's sweep did not find ${id}`);
        rt.retag.classify('owner', pid, {
          pageId: id,
          pageName: rt.tree.queries.node(pid, id).data!.rawName,
          primary: 'Law',
          specialist: null,
          reason: 'the F5a sandbox check',
        });
      }
      const snap = await snapshotPagesOnly(sb, [made.index!, page.cosmology, page.keep], 'tagging-f5a');
      return `${page.cosmology}, ${page.keep}; ${snap}`;
    });
    if (!ok2) return items;

    let runId = '';
    const ok3 = await check(
      'T3',
      'the audit: CANON, Cosmology is a correction to CANON, Law, Cosmology',
      async () => {
        const { run, v } = await audit(page.cosmology);
        runId = run.id;
        if (v.disposition !== 'correction')
          throw new Error(
            `${v.disposition ?? v.scope}: ${JSON.stringify({ holds: v.holds, exceptions: v.exceptions })}`,
          );
        if (JSON.stringify(v.proposed) !== JSON.stringify(['CANON', 'Law', 'Cosmology']))
          throw new Error(`proposed ${v.proposed.join(', ')}`);
        return `run ${run.id}: ${v.current.join(', ')} → ${v.proposed.join(', ')}`;
      },
    );
    if (!ok3) return items;

    const ok4 = await check(
      'T4',
      'the apply: one proposal, approved; the page read live holds exactly the array',
      async () => {
        const plan = rt.retag.planApply({ projectId: pid, runId, pageIds: [page.cosmology] });
        const sub = await rt.retag.submitApply(plan, {
          projectId: pid,
          origin: { kind: 'ui', client: 'owner', tool: 'tagging.sandbox' },
          actor: 'owner',
        });
        if (!sub.proposalId) throw new Error('the apply was not a proposal');
        await rt.policy.commands.approve('owner', sub.proposalId);
        const end = Date.now() + 10 * 60_000;
        let state = '';
        while (Date.now() < end) {
          state = rt.policy.proposals.get(sub.proposalId)?.state ?? '';
          if (['executed', 'failed', 'conflicted'].includes(state)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (state !== 'executed') throw new Error(`the proposal ended ${state}`);
        const b = rt.retag.store.batchByProposal(sub.proposalId)!;
        const disp = b.dispositions?.[page.cosmology];
        if (disp?.outcome !== 'applied' || disp.verified !== true)
          throw new Error(`disposition ${JSON.stringify(disp ?? null)}`);
        const live = await liveTags(page.cosmology);
        if (JSON.stringify(live) !== JSON.stringify(['CANON', 'Law', 'Cosmology']))
          throw new Error(`live tags ${live.join(', ')}`);
        return `applied and read back: ${live.join(', ')}`;
      },
    );
    if (!ok4) return items;

    const ok5 = await check('T5', '"Keep this tag here" on the second page: compliant', async () => {
      const before = await audit(page.keep);
      if (before.v.disposition !== 'exception')
        throw new Error(`before the ruling: ${before.v.disposition ?? before.v.scope}`);
      await rt.retag.keepHere('owner', pid, {
        pageId: page.keep,
        tag: PROBE_TAG,
        reason: 'the F5a sandbox check',
      });
      const after = await audit(page.keep);
      if (after.v.disposition !== 'compliant')
        throw new Error(`after the ruling: ${after.v.disposition ?? after.v.scope}`);
      return `${PROBE_TAG}: exception → compliant (kept on this page)`;
    });
    if (!ok5) return items;

    await check('T6', 'its tags changed: the ruling lapses, the exception is back', async () => {
      await raw.request('updateResource', 'PATCH', `/resources/${page.keep}`, {
        tags: ['CANON', PROBE_TAG, 'Law'],
      });
      await snapshotPagesOnly(sb, [page.keep], 'tagging-f5a');
      const { v } = await audit(page.keep);
      if (v.disposition !== 'exception') throw new Error(`after the change: ${v.disposition ?? v.scope}`);
      const reason = v.exceptions.find((x) => x.tag === PROBE_TAG)?.reason ?? '';
      if (!/lapsed/.test(reason)) throw new Error(`the exception does not say the ruling lapsed: ${reason}`);
      return reason;
    });
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatTaggingReport(items: readonly TaggingCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: the Approved Supplementary Tags and a ruling (F5a, ADR 0067)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
