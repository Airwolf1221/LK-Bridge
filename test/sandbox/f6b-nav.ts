/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F6b (ADR 0079; design T11, T12), opt-in, WRITES then cleans up: a race index, a character index and a source in a
 * throwaway tree; the classification report; the owner's decisions; `index_prefix` and `index_tags` applied as the
 * automation's Apply submits them; T11's order; everything read back live. Written for the owner; never run by an agent
 * or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6b-nav
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance
 * is pointed, in the TEMPORARY database only, at a throwaway governance page under the check's own index
 * (test/sandbox/governance.ts, as F7.1's helper does). Each step reports PASS or FAIL:
 *
 * - **N0** a throwaway index `[INDEX] lk-bridge f6b check <time>` (an index, so its children are ordered), its governance page, the pack approved (temporary database);
 * - **N1** three probe pages (raw client), in this order: `[INDEX] lk-bridge f6b person <time>` (tags CANON, Character),
 *   `[INDEX] lk-bridge f6b race <time>` (tags Species, Navigation), `[BSRC] lk-bridge f6b source <time>`; the tree swept;
 *   only the probe's own pages snapshotted;
 * - **N2** the report (`arkona_index_classify`'s rows under the index), printed row by row;
 * - **N3** the owner's decisions (temporary database): the race `nav`, the person `subject` (character);
 * - **N4** the index tag rule published on the THROWAWAY governance page (the section as the report gives it), the
 *   governance check offering it, the pack approved again (temporary database); when the copied rule is already
 *   published, nothing is written: the section on the page must read back exactly (`already published (copied)`);
 * - **N5** the audit; `index_prefix` and `index_tags` applied as the automation's Apply submits them (a direct job every
 *   guard judges: taking CANON off the person is a canonical proposal, approved as canon as the owner would);
 * - **N6** T11's order: the `out_of_order` fix (the race first), approved;
 * - **N7** read back live: the race is `[NAV]` with exactly Navigation, the person `[INDEX]` with exactly Character, and
 *   the index's children ordered [NAV], then [INDEX], then the source.
 *
 * Clean-up: the throwaway index deleted with everything under it (its governance page included), even after a failure
 * or a step's timeout, and again from the test file's `afterAll`. Cost: about 15 writes and 40 reads.
 */
import { ProjectStore } from '../../src/projects/index.js';
import { AUTOMATION_PRINCIPAL } from '../../src/jobs/types.js';
import { indexTagSectionText } from '../../src/packs/indextax/rules.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import { indexTagSectionMatches } from './governance-blocks.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface NavCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

export async function runNavCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<NavCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f6b-nav', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: NavCheckItem[] = [];
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
  if (!copied.packs.includes('arkona') || !pack?.rules.indexTaxonomy) {
    items.push({
      id: 'N0',
      title: 'the Arkona pack, with its navigation and subject index rules, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F6b (the seed arkona-2026-11-25-f6b) first`,
    });
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const made: { index: string | null; governance: { resourceId: string; documentId: string } | null } = {
    index: null,
    governance: null,
  };
  const page = { person: '', race: '', source: '' };
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
  const approveAndWait = async (proposalId: string, what: string): Promise<string> => {
    const p = rt.policy.proposals.get(proposalId)!;
    if (p.requiresCanonicalApproval) await rt.policy.commands.approveAsCanon('owner', p.id);
    else await rt.policy.commands.approve('owner', p.id);
    let jobId: string | null = null;
    for (let i = 0; i < 600 && !jobId; i++) {
      jobId = rt.policy.proposals.get(p.id)?.jobId ?? null;
      if (!jobId) await new Promise((res) => setTimeout(res, 200));
    }
    if (!jobId) throw new Error(`${what}: the approved proposal made no job`);
    const job = await waitForJob(rt.engine, pid, jobId, what, o.wait);
    if (job.status !== 'succeeded')
      throw new Error(`${what}: job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
    return `proposal ${p.id}${p.requiresCanonicalApproval ? ' (approved as canon)' : ''}, job ${jobId}`;
  };
  const findingFor = (code: string, pageId: string) =>
    rt.audits.store
      .list(pid, { code: [code as never], state: 'open', limit: 500 })
      .findings.find((x) => x.pageId === pageId);
  /** As the automation's Apply submits a proposal-first code's fix: a direct job, every guard allowing or refusing it. */
  const apply = async (code: string, pageId: string): Promise<string> => {
    const f = findingFor(code, pageId);
    if (!f) throw new Error(`no ${code} finding for ${pageId}`);
    // As the automation's Apply submits it: the Automation principal's maintenance origin with its Apply marker (the
    // owner's ruling, F6d follow-up: direct, canon included).
    const r = await rt.audits.proposeFix('automation', pid, f.id, {
      direct: true,
      origin: {
        kind: 'maintenance',
        client: 'automation',
        tool: `automation.${code}`,
        principal: AUTOMATION_PRINCIPAL,
        automationApply: true,
      },
    });
    if (r.status === 'job_submitted') {
      const job = await waitForJob(rt.engine, pid, r.jobId, code, o.wait);
      if (job.status !== 'succeeded')
        throw new Error(`${code}: job ${r.jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
      return `${code}: job ${r.jobId} (Apply)`;
    }
    if (r.status === 'proposal_captured')
      return `${code}: a guard made it a proposal; ${await approveAndWait(r.proposalId, code)}`;
    throw new Error(`${code}: ${r.status}`);
  };
  try {
    const ok0 = await check(
      'N0',
      'a throwaway index and governance page; the pack approved (temporary database)',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `[INDEX] lk-bridge f6b check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const g = await ensureSandboxGovernance({
          rt,
          raw,
          projectName: name,
          packId: 'arkona',
          parentId: made.index,
          label: `lk-bridge f6b governance ${stamp}`,
          always: true,
        });
        if (g.resourceId && g.documentId)
          made.governance = { resourceId: g.resourceId, documentId: g.documentId };
        const status = await rt.packs.governance('arkona');
        return `index ${made.index}; ${g.detail}; index tags ${status.indexTags?.state ?? 'not read'}`;
      },
    );
    if (!ok0) return items;

    const ok1 = await check(
      'N1',
      'a character index, a race index and a source, swept and snapshotted',
      async () => {
        const mk = async (n: string, tags: string[]) =>
          String(
            (
              await raw.request('createResource', 'POST', '/resources', {
                name: n,
                parentId: made.index,
                tags,
              })
            ).id,
          );
        page.person = await mk(`[INDEX] lk-bridge f6b person ${stamp}`, ['CANON', 'Character']);
        page.race = await mk(`[INDEX] lk-bridge f6b race ${stamp}`, ['Species', 'Navigation']);
        page.source = await mk(`[BSRC] lk-bridge f6b source ${stamp}`, ['CANON', 'Culture']);
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
        for (const id of Object.values(page))
          if (!rt.tree.queries.node(pid, id).data) throw new Error(`the tree's sweep did not find ${id}`);
        const snap = await snapshotPagesOnly(sb, [made.index!, ...Object.values(page)], 'f6b-nav');
        return `person ${page.person}, race ${page.race}, source ${page.source}; ${snap}`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check('N2', 'the classification report, row by row', async () => {
      await rt.indexClassify.prepare(pid);
      const report = rt.indexClassify.report(pid, { underId: made.index! }, { limit: 50 });
      const lines = report.rows.map(
        (r) =>
          `ROW ${r.name} current=${r.currentRole} proposed=${r.proposed} rule=${r.rule} status=${r.status}`,
      );
      for (const id of [page.person, page.race])
        if (!report.rows.some((r) => r.id === id))
          throw new Error(`${id} is not in the report:\n${lines.join('\n')}`);
      return [`${report.rows.length} row(s)`, ...lines].join('\n        ');
    });
    if (!ok2) return items;

    const ok3 = await check('N3', 'the owner’s decisions (temporary database)', () => {
      const a = rt.indexClassify.decide('owner', pid, {
        pageId: page.race,
        action: 'change',
        role: 'nav',
        reason: 'the F6b sandbox check',
      });
      const b = rt.indexClassify.decide('owner', pid, {
        pageId: page.person,
        action: 'change',
        role: 'subject',
        subject: 'character',
        reason: 'the F6b sandbox check',
      });
      return Promise.resolve(
        `race → ${a.decision.role}; person → ${b.decision.role} (${b.decision.subject})`,
      );
    });
    if (!ok3) return items;

    const ok4 = await check(
      'N4',
      'the index tag rule published on the THROWAWAY governance page; the pack approved again',
      async () => {
        if (!made.governance) throw new Error('no throwaway governance page: nothing published');
        const rules = rt.packs.get('arkona')!.rules.indexTaxonomy!;
        const path = `/resources/${made.governance.resourceId}/docs/${made.governance.documentId}/blocks`;
        const doc = await raw.request('getDocumentBlocks', 'GET', path);
        if (rules.status === 'published') {
          // The owner has published the rule and approved the pack: the copy carries it, and the throwaway page was
          // written with the section as the pack holds it. Nothing to write; the section must still read back exactly.
          const same = indexTagSectionMatches(doc.blocks, rules);
          if (!same.ok) throw new Error(`the published section does not read back exactly: ${same.reason}`);
          const g = await rt.packs.governance('arkona');
          const approved = rt.packs.approvedRules('arkona')?.indexTaxonomy;
          if (approved?.status !== 'published')
            throw new Error(
              `the rule is ${approved?.status ?? 'absent'} in the approved pack (${g.indexTags?.state ?? 'not read'})`,
            );
          void g;
          return 'already published (copied); read back exactly';
        }
        const blocks = [
          ...(doc.blocks as Obj[]),
          { kind: 'heading', level: 2, content: [{ text: rules.section }] },
          ...indexTagSectionText(rules).map((text) => ({ kind: 'paragraph', content: [{ text }] })),
        ];
        await raw.request('replaceDocumentBlocks', 'PUT', path, { blocks }, { ifMatch: String(doc.version) });
        // The f6b seed pins the section on the Tagging Standard; a pack stored with older pins gets it here (temporary
        // database only), as the seed's upgrade gives it.
        const current = rt.packs.get('arkona')!;
        if (
          !current.governance.some(
            (g) => g.key === rules.source && (g.sections ?? []).includes(rules.section),
          )
        )
          rt.packs.store.setGovernance(
            'arkona',
            current.governance.map((g) =>
              g.key === rules.source ? { ...g, sections: [...(g.sections ?? []), rules.section] } : g,
            ),
          );
        const g = await rt.packs.governance('arkona');
        await rt.packs.commands
          .approve('owner', 'arkona')
          .catch(async () => rt.packs.commands.approve('owner', 'arkona'));
        const approved = rt.packs.approvedRules('arkona')?.indexTaxonomy;
        if (approved?.status !== 'published')
          throw new Error(
            `the rule is ${approved?.status ?? 'absent'} after approval (${g.indexTags?.state})`,
          );
        return `the section ${g.indexTags?.state ?? '?'}; pack version ${rt.packs.get('arkona')!.approved!.version} approved: published`;
      },
    );
    if (!ok4) return items;

    const ok5 = await check(
      'N5',
      'the audit; index_prefix and index_tags applied (the automation’s Apply)',
      async () => {
        await rt.audits.run(pid, 'manual');
        const out = [
          await apply('index_prefix', page.race),
          await apply('index_tags', page.race),
          await apply('index_tags', page.person),
        ];
        await rt.tree.whenIdle();
        return out.join('; ');
      },
    );
    if (!ok5) return items;

    const ok6 = await check('N6', 'T11’s order: the out_of_order fix, approved', async () => {
      await snapshotPagesOnly(sb, [made.index!, ...Object.values(page)], 'f6b-nav');
      await rt.audits.run(pid, 'manual');
      const f =
        findingFor('out_of_order', page.race) ??
        findingFor('out_of_order', page.person) ??
        findingFor('out_of_order', page.source);
      if (!f) return 'already in order: nothing to move';
      if (f.fix?.args.order !== 'nav') throw new Error(`the finding is not under T11's order: ${f.message}`);
      const r = await rt.audits.proposeFix('owner', pid, f.id, {});
      if (r.status !== 'proposal_captured') throw new Error(`the fix was ${r.status}`);
      return `${f.message}; ${await approveAndWait(r.proposalId, 'the move')}`;
    });
    if (!ok6) return items;

    await check(
      'N7',
      'read back live: [NAV] Navigation, [INDEX] Character, ordered NAV, INDEX, source',
      async () => {
        const get = async (id: string) => await raw.request('getResource', 'GET', `/resources/${id}`);
        const race = await get(page.race);
        const person = await get(page.person);
        const tags = (x: Obj) => ((x.tags ?? []) as string[]).join(', ');
        if (!String(race.name).startsWith('[NAV] ') || tags(race) !== 'Navigation')
          throw new Error(`race: ${String(race.name)} [${tags(race)}]`);
        if (!String(person.name).startsWith('[INDEX] ') || tags(person) !== 'Character')
          throw new Error(`person: ${String(person.name)} [${tags(person)}]`);
        const list = await raw.request('listResources', 'GET', `/resources?parentId=${made.index}&limit=100`);
        // In LegendKeeper's sibling order (by rank; a listing need not be).
        const order = ((list.data ?? []) as Obj[])
          .slice()
          .sort((a, b) => (String(a.rank) < String(b.rank) ? -1 : String(a.rank) > String(b.rank) ? 1 : 0))
          .map((x) => String(x.id))
          .filter((id) => Object.values(page).includes(id));
        const want = [page.race, page.person, page.source];
        if (order.join(',') !== want.join(','))
          throw new Error(`children in order ${order.join(', ')}, expected ${want.join(', ')}`);
        return `LIVE race "${String(race.name)}" [${tags(race)}]; person "${String(person.name)}" [${tags(person)}]; order NAV, INDEX, source`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatNavReport(items: readonly NavCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: navigation and subject indexes (F6b, ADR 0079)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
