/**
 * v3 F4b (ADR 0064, design D6): "Pick the right value". The owner picks a value on the dashboard (or types one); the
 * bridge **proposes** edits to every page that disagrees with it: ONE ordinary proposal, made of items (F3d's selective
 * approval), one per page, each editing only the restated value:
 *
 * - **a sidebar field** (a Temporal Scope's date, a Life State's, an identity field): `set_facts`' plan, the date's text
 *   replaced inside the field (the rest of the field kept), or the identity field's whole value;
 * - **a sentence**: `write_page`'s block-by-block path, the date's text replaced in its one text run (a date split by a
 *   mention or by formatting is not planned, and said);
 * - **a chronology row**: `update_timeline_event`'s own plan (`planEventChange`), so the row's Date and KCY cells and its
 *   timeline event change together.
 *
 * Each page is read live first (the plan's reads); a value no longer there is not planned and is listed. It never edits
 * the side the owner picked, and never runs without the owner's pick: agents can only suggest. Approval, selective
 * approval, the rails ("bulk over 10 pages" asks for the step-up at approval) and Revert work as for any proposal; Last
 * Major Revision follows the owner's rule (the engine measures each page's change).
 */
import { createHash } from 'node:crypto';
import { unwritableIds } from '../appraisal/fixes.js';
import { buildJob } from '../chronology/plan.js';
import { expandFacts } from '../facts/expand.js';
import { FactsPlanError, planFacts } from '../facts/plan.js';
import { sidebarFrom } from '../facts/sidebar.js';
import { SYSTEM_PRINCIPAL, type JobOrigin, type StepSpec } from '../jobs/index.js';
import type { PlanItem } from '../jobs/items.js';
import { shiftStep } from '../packs/engine/job.js';
import { textKey } from '../packs/engine/text.js';
import { planBlockwise } from '../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../pages/blockwise-job.js';
import type { McpToolContext } from '../mcp/server.js';
import { liveRead } from '../mcp/tools/repo.js';
import type { ProjectDeps, ToolDeps } from '../mcp/tools/shape.js';
import { chrono, freshCalendar, planEventChange } from '../mcp/tools/timelines.js';
import { treeSettingsFrom } from '../tree/classify.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The job origin of every pick's proposal (Revert recognises its jobs by it). */
export const PICK_TOOL = 'consistency.pick';

/** One value to change, as the pick found it on its page. */
export type Edit =
  | {
      readonly kind: 'fact';
      readonly pageId: string;
      readonly pageName: string;
      /** The sidebar field (`Temporal Scope`). */
      readonly field: string;
      /** The value's text inside the field (a date), or the whole field's value. */
      readonly from: string;
      readonly to: string;
      /** The whole field is the value (an identity fact). */
      readonly whole: boolean;
    }
  | {
      readonly kind: 'prose';
      readonly pageId: string;
      readonly pageName: string;
      readonly documentId: string;
      readonly blockId: string;
      readonly from: string;
      readonly to: string;
      readonly context: string;
    }
  | {
      readonly kind: 'row';
      readonly pageId: string;
      readonly pageName: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly from: string;
      readonly to: string;
    };

export interface PickProposal {
  readonly proposalId: string;
  readonly summary: string | null;
  readonly items: readonly PlanItem[];
  /** Edits not planned, each with why (changed since the snapshot, a split date, a refusal of the row tools). */
  readonly notPlanned: readonly { readonly page: string; readonly from: string; readonly why: string }[];
  readonly reads: number;
  readonly proposedBecause?: string;
}

export class PickError extends Error {
  override readonly name = 'PickError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Makes ONE proposal of these edits (the owner's pick). */
export type Picker = (o: {
  readonly projectId: string;
  readonly edits: readonly Edit[];
  readonly title: string;
  readonly operation: Obj;
}) => Promise<PickProposal>;

const SILENT_LOG = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => SILENT_LOG,
} as unknown as McpToolContext['log'];

const ORIGIN: JobOrigin = { kind: 'ui', client: 'owner', tool: PICK_TOOL, principal: SYSTEM_PRINCIPAL };

/** Replaces the first occurrence of `from` in a text (case and spacing as written); null when it is not there. */
function replaceOnce(text: string, from: string, to: string): string | null {
  const i = text.indexOf(from);
  return i < 0 ? null : `${text.slice(0, i)}${to}${text.slice(i + from.length)}`;
}

/** A block and everything under it, with one block's text run edited (null: the value is not in one text run). */
function editBlocks(
  blocks: readonly unknown[],
  blockId: string,
  from: string,
  to: string,
): { blocks: Obj[]; done: boolean } {
  let done = false;
  const walk = (list: readonly unknown[]): Obj[] =>
    list.map((b) => {
      if (!isObj(b)) return b as Obj;
      let next: Obj = b;
      if (!done && b.id === blockId && Array.isArray(b.content)) {
        const runs = (b.content as unknown[]).map((r) => {
          if (done || !isObj(r) || typeof r.text !== 'string' || r.mention) return r;
          const t = replaceOnce(r.text, from, to);
          if (t === null) return r;
          done = true;
          return { ...r, text: t };
        });
        next = { ...b, content: runs };
      }
      if (Array.isArray(next.children)) next = { ...next, children: walk(next.children as unknown[]) };
      return next;
    });
  return { blocks: walk(blocks), done };
}

interface Planned {
  readonly steps: StepSpec[];
  readonly docs: string[];
  readonly resources: string[];
  readonly parts: string[];
}

/** Builds the picker over the tool layer (the chronology's row tools need its context), as the bridge's own work. */
export function bridgePicker(deps: ToolDeps): Picker {
  return async (o) => {
    const sel = deps.selector.select(o.projectId, 'write');
    if (!sel.ok) throw new PickError(sel.error.code, sel.error.message);
    // Every read of the plan is the owner's (the dashboard's), as the bridge's other owner-made proposals are.
    const engine = new Proxy(deps.engine, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === 'run')
          return (...a: Parameters<typeof t.run>) => t.run(a[0], a[1], { ...a[2], origin: ORIGIN });
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const pd: ProjectDeps = { ...deps, engine, project: sel.project };
    const mctx: McpToolContext = {
      caller: undefined,
      signal: new AbortController().signal,
      log: SILENT_LOG,
      principal: SYSTEM_PRINCIPAL,
      scope: 'write',
    };
    return proposeEdits(pd, mctx, o);
  };
}

async function proposeEdits(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: Parameters<Picker>[0],
): Promise<PickProposal> {
  const tool = 'arkona_consistency';
  const notPlanned: { page: string; from: string; why: string }[] = [];
  const items: PlanItem[] = [];
  const plans: { item: string; p: Planned }[] = [];
  let reads = 0;
  const propertiesName = treeSettingsFrom(pd.services?.projectSettings?.(o.projectId) ?? {}).propertiesName;
  const byPage = new Map<string, Edit[]>();
  for (const e of o.edits) byPage.set(e.pageId, [...(byPage.get(e.pageId) ?? []), e]);
  for (const [pageId, edits] of byPage) {
    const pageName = edits[0]!.pageName;
    const item = `page:${pageId}`;
    const steps: StepSpec[] = [];
    const docs: string[] = [];
    const resources: string[] = [];
    const parts: string[] = [];
    const changes: { what: string; before: string | null; after: string | null }[] = [];
    // Sidebar fields: one facts plan for the page.
    const facts = edits.filter((e): e is Extract<Edit, { kind: 'fact' }> => e.kind === 'fact');
    if (facts.length > 0) {
      const path = { resourceId: pageId };
      const read = await liveRead(pd, mctx, tool, 'listProperties', { path });
      reads++;
      if (!read.ok) {
        for (const e of facts)
          notPlanned.push({ page: pageName, from: e.from, why: 'its sidebar could not be read now' });
      } else {
        const sidebar = sidebarFrom(read.value);
        const kv = sidebar.find((x) => x.kind === 'keyValue' && textKey(x.title) === textKey(propertiesName));
        const requests: { key: string; value: Obj[] }[] = [];
        const shown: Record<string, string> = {};
        for (const e of facts) {
          const row = kv?.rows?.find((r) => textKey(r.key) === textKey(e.field));
          const runs = (row?.content ?? []) as Obj[];
          const now = runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
          if (!row || runs.some((r) => r.mention)) {
            notPlanned.push({
              page: pageName,
              from: e.from,
              why: row
                ? `${e.field} holds a mention: change it by hand`
                : `${e.field} is no longer on the page`,
            });
            continue;
          }
          const next = e.whole
            ? now.trim() === e.from.trim()
              ? e.to
              : null
            : replaceOnce(now, e.from, e.to);
          if (next === null) {
            notPlanned.push({
              page: pageName,
              from: e.from,
              why: `${e.field} no longer reads “${e.from}” (now “${now}”)`,
            });
            continue;
          }
          requests.push({ key: row.key, value: [{ text: next }] });
          shown[row.key] = next;
          changes.push({ what: e.field, before: now, after: next });
        }
        if (requests.length > 0)
          try {
            const plan = planFacts({
              resourceId: pageId,
              sidebar,
              propertyTitle: propertiesName,
              facts: requests,
              links: [],
              templateKeys: null,
            });
            if (!plan.empty) {
              const job = expandFacts(plan, { id: pageId, name: pageName }, sidebar, {
                facts: shown,
                links: {},
              });
              steps.push(...job.steps);
              resources.push(pageId);
              parts.push(...job.pageParts);
            }
          } catch (e) {
            if (!(e instanceof FactsPlanError)) throw e;
            for (const f of facts) notPlanned.push({ page: pageName, from: f.from, why: e.message });
          }
      }
    }
    // Sentences: one block-by-block plan per document.
    const prose = edits.filter((e): e is Extract<Edit, { kind: 'prose' }> => e.kind === 'prose');
    for (const documentId of [...new Set(prose.map((e) => e.documentId))]) {
      const path = { resourceId: pageId, documentId };
      const read = await liveRead(pd, mctx, tool, 'getDocumentBlocks', { path });
      reads++;
      const list = prose.filter((e) => e.documentId === documentId);
      const body =
        read.ok && isObj(read.value) && Array.isArray(read.value.blocks)
          ? (read.value.blocks as Obj[])
          : null;
      if (!body) {
        for (const e of list)
          notPlanned.push({ page: pageName, from: e.from, why: 'its document could not be read now' });
        continue;
      }
      let after: Obj[] = body;
      for (const e of list) {
        const r = editBlocks(after, e.blockId, e.from, e.to);
        if (!r.done) {
          notPlanned.push({
            page: pageName,
            from: e.from,
            why: `the sentence no longer holds “${e.from}” in one piece of text (changed since, or split by a mention or formatting)`,
          });
          continue;
        }
        after = r.blocks;
        changes.push({ what: `the sentence “${e.context.slice(0, 160)}”`, before: e.from, after: e.to });
      }
      if (after === body) continue;
      const plan = planBlockwise(body, after, {
        unwritable: unwritableIds(body),
        validate: (op) => validateBlockOp(pageId, documentId, op),
      });
      if (!plan.ok) {
        for (const e of list)
          notPlanned.push({
            page: pageName,
            from: e.from,
            why: `it cannot be written block by block: ${plan.refusal.message}`,
          });
        continue;
      }
      if (plan.empty) continue;
      const job = blockwiseJob({
        resourceId: pageId,
        documentId,
        before: body,
        after,
        ops: plan.ops,
        journalOperation: { tool: 'write_page', page: { id: pageId, name: pageName }, from: PICK_TOOL },
      });
      steps.push(...job.steps);
      docs.push(documentId);
      parts.push('page content');
    }
    // A chronology row: the row tools' own plan (its Date and KCY cells and its timeline event, in step).
    for (const e of edits.filter((x): x is Extract<Edit, { kind: 'row' }> => x.kind === 'row')) {
      const c = chrono(pd);
      if (!c.ok) {
        notPlanned.push({
          page: pageName,
          from: e.from,
          why: 'the chronology is not confirmed, so its row tools refuse',
        });
        continue;
      }
      const ch = c.value;
      const age = ch.config.ages.find((a) => a.tableDocumentId === e.documentId);
      const fc = await freshCalendar(pd, mctx, 'update_timeline_event', ch.config.calendarId!);
      reads++;
      if (!fc.ok || !age) {
        notPlanned.push({
          page: pageName,
          from: e.from,
          why: age
            ? 'the chronology’s calendar could not be read now'
            : 'the row’s table is not one of the chronology’s ages',
        });
        continue;
      }
      const requestKey = createHash('sha1')
        .update(JSON.stringify({ pick: o.title, row: e.rowId, to: e.to }))
        .digest('hex');
      const planned = await planEventChange(
        pd,
        mctx,
        'update_timeline_event',
        ch,
        fc.cal,
        { event: { row_id: e.rowId, age: age.name }, date: e.to },
        requestKey,
      );
      if (!planned.ok) {
        const r = planned.outcome.kind === 'answer' ? planned.outcome.result : null;
        const text = r?.content?.[0] && 'text' in r.content[0] ? String(r.content[0].text) : 'refused';
        notPlanned.push({ page: pageName, from: e.from, why: `the row tools refuse: ${text.slice(0, 300)}` });
        continue;
      }
      const s = planned.submit;
      const built = buildJob({
        tool: s.tool,
        config: s.ch.config,
        target: s.target,
        writes: s.writes,
        ctx: s.ctx,
        record: { requestKey: s.requestKey, ages: s.ages, summary: s.summary },
      });
      steps.push(...built.steps);
      docs.push(...built.holdDocuments);
      parts.push(`chronology row: ${e.from} → ${e.to}`);
      changes.push({
        what: 'chronology row (Date, KCY and its timeline event)',
        before: e.from,
        after: e.to,
      });
    }
    if (steps.length === 0) continue;
    plans.push({ item, p: { steps, docs, resources, parts } });
    items.push({
      id: item,
      kind: 'restatement',
      group: 'Pages that disagree with the picked value',
      label: `${pageName}: ${changes.map((c) => `${c.before ?? ''} → ${c.after ?? ''}`).join('; ')}`,
      page: { id: pageId, name: pageName },
      diff: { changes },
      dependsOn: [],
      selected: true,
    });
  }
  if (plans.length === 0)
    throw new PickError(
      'NOTHING_TO_PROPOSE',
      'No page could be planned: every value has changed since the snapshot, or cannot be written this way. Nothing was proposed.',
      { notPlanned },
    );
  // One job: each page's steps in turn, renumbered, each step naming its page's item; every write covered by the
  // job-level locks (the engine refuses a write a held lock does not cover).
  const steps: StepSpec[] = [];
  for (const { item, p } of plans) {
    const base = steps.length;
    for (const s of p.steps) steps.push({ ...shiftStep(s, base), items: [item] });
  }
  const resources = [...new Set(plans.flatMap((x) => x.p.resources))];
  const docs = [...new Set(plans.flatMap((x) => x.p.docs))];
  const lockPage = resources[0] ?? plans[0]!.item.slice('page:'.length);
  const r = await pd.engine.submit({
    kind: 'batch_ops',
    project: o.projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin: ORIGIN,
    title: o.title.slice(0, 300),
    internal: true,
    forceProposal: true,
    holdLock: { resourceId: lockPage },
    ...(resources.length > 1 ? { holdMore: { resources: resources.filter((x) => x !== lockPage) } } : {}),
    ...(docs.length > 0 ? { holdDocuments: docs } : {}),
    proposal: {
      summary: o.title,
      items,
      operation: { ...o.operation, ...(notPlanned.length ? { notPlanned } : {}) },
      operations: plans.map(({ item, p }) => {
        const it = items.find((i) => i.id === item)!;
        return { tool: 'arkona_consistency', page: it.page, pageParts: p.parts, summaryLabel: it.label };
      }),
    },
  });
  if (!('proposalId' in r) || typeof r.proposalId !== 'string')
    throw new PickError('NOT_PROPOSED', 'The pick was not captured as a proposal; nothing was done.');
  return {
    proposalId: r.proposalId,
    summary: typeof r.summary === 'string' ? r.summary : null,
    items,
    notPlanned,
    reads,
    ...('proposedBecause' in r && typeof r.proposedBecause === 'string'
      ? { proposedBecause: r.proposedBecause }
      : {}),
  };
}
