/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F6a (ADR 0076; design T1 to T3), opt-in, WRITES then cleans up: the Reference Type report, one owner mapping and the
 * noncanonical fix end to end on the real API, and the vocabulary written to a THROWAWAY governance page. Written for
 * the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6a-reftypes
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance
 * sources sit on Arkona, which this runtime does not serve, so in the TEMPORARY database only they are pointed at a
 * throwaway governance page the check makes under its own index (test/sandbox/governance.ts, as F7.1's harness fix
 * does), and the pack approved there. `test`'s own governance is never published to. Each step reports PASS or FAIL:
 *
 * - **F0** a throwaway index `lk-bridge f6a check <time>`, its governance page, the pack approved (temporary database);
 * - **F1** three probe pages (raw client), `[BSRC] lk-bridge f6a <n> <time>`, tagged CANON, Culture, Authoritative Main
 *   CANON, with the variant Reference Types "Historical Cultural Reference", "Regional Culture Reference" and "Culture &
 *   Naming Reference"; the tree swept; only the probe's own pages snapshotted (R4.1);
 * - **F2** the report (`arkona_reference_types`' rows, under the index), printed row by row: the first two suggest
 *   Culture Reference (their time and scope words named), the third has no confident suggestion;
 * - **F3** one mapping recorded as the owner's decision (temporary database): "Historical Cultural Reference" → Culture
 *   Reference;
 * - **F4** the audit, then the noncanonical fix through its job (a proposal, approved as the owner would, as canon when
 *   asked): one sidebar row written with If-Match, verified;
 * - **F5** the page read back live: its Reference Type is Culture Reference; the other two are unchanged;
 * - **F6** "Publish vocabulary" to the throwaway governance page: the section read back live parses to the vocabulary
 *   the bridge wrote (new blocks with no ids, a heading under Sidebar Metadata, a bold run).
 *
 * Clean-up: the throwaway index deleted with everything under it (its governance page included), even after a failure
 * or a step's timeout (test/sandbox/steps.ts), and again from the test file's `afterAll`. Cost: about 12 writes and 30
 * reads.
 */
import { ProjectStore } from '../../src/projects/index.js';
import { parseSection, sameVocabulary, vocabularySection } from '../../src/packs/reftypes/vocabulary.js';
import { effectiveVocabulary } from '../../src/packs/reftypes/service.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface RefTypesCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

export const VARIANTS = [
  'Historical Cultural Reference',
  'Regional Culture Reference',
  'Culture & Naming Reference',
] as const;

const CANON_ROWS = [
  { key: 'Status', text: 'Authoritative' },
  { key: 'Continuity Type', text: 'CANON' },
  { key: 'Continuity', text: 'Main' },
  { key: 'Inheritance', text: 'None' },
];

const rowText = (r: Obj): string =>
  typeof r.text === 'string'
    ? r.text
    : Array.isArray(r.content)
      ? (r.content as Obj[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
      : '';

export async function runRefTypesCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<RefTypesCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f6a-reftypes', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: RefTypesCheckItem[] = [];
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
  if (!copied.packs.includes('arkona') || !pack?.rules.referenceTypes) {
    items.push({
      id: 'F0',
      title: 'the Arkona pack, with its Reference Type vocabulary, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F6a (the seed arkona-2026-11-24-f6a) first`,
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
  const pages: string[] = [];
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
  const liveReferenceType = async (id: string): Promise<string> => {
    const r = await raw.request('getResource', 'GET', `/resources/${id}`);
    const kv = ((r.properties ?? []) as Obj[]).find((p) => p.kind === 'keyValue' && p.title === 'PROPERTIES');
    const row = ((kv?.rows ?? []) as Obj[]).find((x) => x.key === 'Reference Type');
    return row ? rowText(row) : '';
  };
  try {
    const ok0 = await check(
      'F0',
      'a throwaway index and governance page; the pack approved (temporary database)',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `lk-bridge f6a check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const g = await ensureSandboxGovernance({
          rt,
          raw,
          projectName: name,
          packId: 'arkona',
          parentId: made.index,
          label: `lk-bridge f6a governance ${stamp}`,
          // Always a throwaway page: F6 publishes to it, never to the project's own governance.
          always: true,
        });
        if (g.resourceId && g.documentId)
          made.governance = { resourceId: g.resourceId, documentId: g.documentId };
        const status = await rt.packs.governance('arkona');
        return `index ${made.index}; ${g.detail}; vocabulary ${status.referenceTypes?.state ?? 'not read'}`;
      },
    );
    if (!ok0) return items;

    const ok1 = await check(
      'F1',
      'three probe pages with variant Reference Types, swept and snapshotted',
      async () => {
        for (const [i, v] of VARIANTS.entries()) {
          const r = await raw.request('createResource', 'POST', '/resources', {
            name: `[BSRC] lk-bridge f6a ${['one', 'two', 'three'][i]} ${stamp}`,
            parentId: made.index,
            tags: ['CANON', 'Culture'],
          });
          pages.push(String(r.id));
          await raw.request('createProperty', 'POST', `/resources/${String(r.id)}/properties`, {
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: [...CANON_ROWS, { key: 'Reference Type', text: v }],
          });
        }
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
        for (const id of pages) {
          const n = rt.tree.queries.node(pid, id).data;
          if (!n) throw new Error(`the tree's sweep did not find ${id}`);
          if (n.propertiesPending) throw new Error(`the tree has not read ${id}'s sidebar`);
        }
        const snap = await snapshotPagesOnly(sb, [made.index!, ...pages], 'f6a-reftypes');
        return `${pages.join(', ')}; ${snap}`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check('F2', 'the report, row by row', async () => {
      await rt.tree.whenIdle();
      const report = rt.referenceTypes.report(pid, { underId: made.index! }, { limit: 50 });
      const lines = report.rows.map(
        (r) =>
          `ROW value="${r.value}" category=${r.category || 'none'} count=${r.count} status=${r.status} suggestion=${r.suggestion.value ?? 'none'} reason="${r.suggestion.reason}"`,
      );
      const by = (v: string) => report.rows.find((r) => r.value === v);
      if (by(VARIANTS[0])?.suggestion.value !== 'Culture Reference') throw new Error(lines.join('\n'));
      if (by(VARIANTS[1])?.suggestion.value !== 'Culture Reference') throw new Error(lines.join('\n'));
      if (by(VARIANTS[2])?.suggestion.kind !== 'none') throw new Error(lines.join('\n'));
      return [
        `${report.rows.length} row(s); coverage ok=${report.coverage.ok} stale=${report.coverage.stale} missing=${report.coverage.missing}`,
        ...lines,
      ].join('\n        ');
    });
    if (!ok2) return items;

    const ok3 = await check(
      'F3',
      'one mapping recorded (the owner’s decision, temporary database)',
      async () => {
        await rt.tree.whenIdle();
        const d = rt.referenceTypes.decide('owner', pid, {
          value: VARIANTS[0],
          category: 'Culture',
          action: 'accept',
          reason: 'the F6a sandbox check',
        });
        return `${d.id}: “${d.value}” → “${d.target}”`;
      },
    );
    if (!ok3) return items;

    const ok4 = await check('F4', 'the audit, then the noncanonical fix through its job', async () => {
      await rt.audits.run(pid, 'manual');
      const f = rt.audits.store
        .list(pid, { code: ['reference_type_noncanonical'], state: 'open', limit: 500 })
        .findings.find((x) => x.pageId === pages[0]);
      if (!f) throw new Error(`no reference_type_noncanonical finding for ${pages[0]}`);
      if (f.fix?.kind !== 'reference_type')
        throw new Error(`the finding has no fix: ${JSON.stringify(f.evidence)}`);
      const r = await rt.audits.proposeFix('owner', pid, f.id, {});
      if (r.status !== 'proposal_captured') throw new Error(`the fix was ${r.status}`);
      const p = rt.policy.proposals.get(r.proposalId)!;
      if (p.requiresCanonicalApproval) await rt.policy.commands.approveAsCanon('owner', p.id);
      else await rt.policy.commands.approve('owner', p.id);
      let jobId: string | null = null;
      for (let i = 0; i < 600 && !jobId; i++) {
        jobId = rt.policy.proposals.get(p.id)?.jobId ?? null;
        if (!jobId) await new Promise((res) => setTimeout(res, 200));
      }
      if (!jobId) throw new Error('the approved proposal made no job');
      const job = await waitForJob(rt.engine, pid, jobId, 'the Reference Type fix', o.wait);
      if (job.status !== 'succeeded')
        throw new Error(`job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
      return `proposal ${p.id}${p.requiresCanonicalApproval ? ' (approved as canon)' : ''}, job ${jobId} succeeded`;
    });
    if (!ok4) return items;

    const ok5 = await check(
      'F5',
      'read back live: the mapped page holds Culture Reference, the others unchanged',
      async () => {
        const live = await Promise.all(pages.map(liveReferenceType));
        if (live[0] !== 'Culture Reference' || live[1] !== VARIANTS[1] || live[2] !== VARIANTS[2])
          throw new Error(`live: ${live.join(' | ')}`);
        return `LIVE ${pages.map((id, i) => `${id}="${live[i]}"`).join(' ')}`;
      },
    );
    if (!ok5) return items;

    await check(
      'F6',
      'the vocabulary published to the THROWAWAY governance page, read back and parsed',
      async () => {
        if (!made.governance) throw new Error('no throwaway governance page: nothing published');
        const r = await rt.referenceTypes.publish('owner', pid);
        if (!r.jobId) throw new Error('the publication made no job');
        const job = await waitForJob(rt.engine, pid, r.jobId, 'the publication', o.wait);
        if (job.status !== 'succeeded')
          throw new Error(`job ${r.jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
        const doc = await raw.request(
          'getDocumentBlocks',
          'GET',
          `/resources/${made.governance.resourceId}/docs/${made.governance.documentId}/blocks`,
        );
        const rtRules = rt.packs.get('arkona')!.rules.referenceTypes!;
        const parsed = parseSection(vocabularySection(doc.blocks, rtRules.section));
        if (!parsed.ok) throw new Error(`the section read back does not parse: ${parsed.reason}`);
        const wrote = effectiveVocabulary(rtRules, rt.referenceTypes.store.decisions(pid)).lists;
        if (!sameVocabulary(parsed.vocabulary, wrote))
          throw new Error('the section read back differs from what was written');
        return `job ${r.jobId}; ${r.lines.length} lines; parsed back: ${parsed.vocabulary.categories.length} categories`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatRefTypesReport(items: readonly RefTypesCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: Reference Types, a mapping and its fix (F6a, ADR 0076)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
