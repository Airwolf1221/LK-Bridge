/**
 * A set_facts plan as ONE job (v2 C2a, ADR 0032; PLAN-v2 10.6), the same for a direct write and for an approved
 * proposal (the proposal stores exactly these steps):
 *
 * 1. `bridge.expect`, inside the page's lock (the job holds it from its first step to its end): every property the plan
 *    changes is read again and compared with the state the plan was built on; any difference is a conflict and nothing
 *    is written. It returns the key-value rows' version.
 * 2. The row writes (changes, additions, removals), each chaining its If-Match from the write before it (the first from
 *    the check). A write with nothing to chain from (after a removal, which answers without a version) reads the rows in
 *    the lock and compares them with the plan instead (`expectCurrent`).
 * 3. The collection writes: one `updateProperty` each, which LegendKeeper does not version, so the bridge compares the
 *    collection read in the lock with the plan first (`expectCurrent`).
 * 4. `bridge.verify`: the sidebar read back and compared with the planned state (keys, values, order, links, filter).
 *    A difference is "written but not as planned", never retried.
 *
 * Every write is journalled with the high-level operation; the first write to the key-value property keeps the property
 * as the plan saw it (the check confirmed it) as its pre-image; `updateProperty` keeps its own. The tree re-reads the
 * page once, when the job ends.
 */
import { EXPECT_STEP, VERIFY_STEP, type ExpectCheck, type VerifyTarget } from '../jobs/internal-steps.js';
import { rowsContentHash, stateHash, type SidebarPropertyState } from '../jobs/sidebar-state.js';
import type { StepSpec } from '../jobs/types.js';
import { rowStates, type FactsPlan, type LinkTarget } from './plan.js';
import type { SidebarProperty } from './sidebar.js';

export interface FactsPage {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
}

export interface FactsJob {
  readonly steps: readonly StepSpec[];
  /** The high-level operation, as the proposal keeps it (its facts table and links for the dashboard). */
  readonly operation: Record<string, unknown>;
  readonly summary: string;
  readonly pageParts: readonly string[];
  readonly journalOperation: Record<string, unknown>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const linkView = (t: LinkTarget) => ({
  resourceId: t.resourceId,
  name: t.name,
  ...(t.documentId ? { documentId: t.documentId, document: t.documentName ?? t.documentId } : {}),
});

/** The counts of a plan, as words: "2 facts changed, 1 link added". */
export function planCounts(plan: FactsPlan): { parts: string[]; counts: Record<string, number> } {
  const counts = {
    factsAdded: plan.facts.filter((f) => f.change === 'added').length,
    factsChanged: plan.facts.filter((f) => f.change === 'changed').length,
    factsRemoved: plan.facts.filter((f) => f.change === 'removed').length,
    linksAdded: plan.links.reduce((n, l) => n + l.added.length, 0),
    linksRemoved: plan.links.reduce((n, l) => n + l.removed.length, 0),
  };
  const parts = [
    counts.factsChanged ? `${plural(counts.factsChanged, 'fact')} changed` : '',
    counts.factsAdded ? `${plural(counts.factsAdded, 'fact')} added` : '',
    counts.factsRemoved ? `${plural(counts.factsRemoved, 'fact')} removed` : '',
    counts.linksAdded ? `${plural(counts.linksAdded, 'link')} added` : '',
    counts.linksRemoved ? `${plural(counts.linksRemoved, 'link')} removed` : '',
  ].filter(Boolean);
  return { parts, counts };
}

export function expandFacts(
  plan: FactsPlan,
  page: FactsPage,
  sidebar: readonly SidebarProperty[],
  inputs: { readonly facts: unknown; readonly links: unknown },
  o: {
    /**
     * v2 C2b: the agent passed `baseFactsVersion`, so the WHOLE sidebar must still be the state the plan was built on
     * inside the lock too (a direct write only: capture leaves it out of a proposal).
     */
    readonly wholeSidebar?: {
      readonly factsVersion: string;
      readonly state: readonly SidebarPropertyState[];
    };
  } = {},
): FactsJob {
  const { parts, counts } = planCounts(plan);
  const pageParts = ['sidebar', ...parts];
  const journalOperation = {
    tool: 'set_facts',
    page: { id: page.id, name: page.name },
    ...(plan.property ? { property: plan.property.title } : {}),
    counts,
    plannedFrom: 'listProperties',
  };
  const kvLabel = plan.property ? plan.property.title : 'facts';
  const rowWrites = plan.writes.filter((w) => w.op !== 'updateProperty');
  const collWrites = plan.writes.filter((w) => w.op === 'updateProperty');
  const checks: ExpectCheck[] = [];
  if (o.wholeSidebar) {
    checks.push({
      label: 'sidebar',
      kind: 'sidebar',
      resourceId: page.id,
      factsVersion: o.wholeSidebar.factsVersion,
      properties: o.wholeSidebar.state,
      directOnly: true,
    });
  }
  if (rowWrites.length > 0 && plan.property) {
    checks.push({
      label: kvLabel,
      kind: 'propertyRows',
      resourceId: page.id,
      propertyId: plan.property.id,
      rows: rowStates(plan.rowsBefore),
    });
  }
  for (const w of collWrites) {
    const raw = sidebar.find((p) => p.id === w.propertyId)?.raw;
    const title = plan.links.find((l) => l.propertyId === w.propertyId)?.title ?? w.propertyId;
    checks.push({
      label: title,
      kind: 'collection',
      resourceId: page.id,
      propertyId: w.propertyId,
      collection: w.collectionBefore!,
      ...(typeof raw?.version === 'string' && raw.version !== '' ? { version: raw.version } : {}),
    });
  }
  const steps: StepSpec[] = [{ op: EXPECT_STEP, params: { body: { checks } } }];
  const preImage = plan.property ? sidebar.find((p) => p.id === plan.property!.id)?.raw : undefined;
  rowWrites.forEach((w, i) => {
    steps.push({
      op: w.op,
      params: w.params,
      ifMatchFrom: i === 0 ? { step: 1, key: kvLabel } : { step: steps.length },
      expectCurrent: { state: 'rows', hash: rowsContentHash(rowStates(w.rowsBefore ?? [])), label: kvLabel },
      deferTreeReread: true,
      journalOperation: { ...journalOperation, write: w.label },
      ...(i === 0 && preImage ? { journalPreImage: preImage } : {}),
    });
  });
  for (const w of collWrites) {
    const title = plan.links.find((l) => l.propertyId === w.propertyId)?.title ?? w.propertyId;
    steps.push({
      op: w.op,
      params: w.params,
      expectCurrent: { state: 'collection', hash: stateHash(w.collectionBefore!), label: title },
      deferTreeReread: true,
      journalOperation: { ...journalOperation, write: w.label },
    });
  }
  const properties = [
    ...(plan.property && rowWrites.length > 0
      ? [{ id: plan.property.id, title: plan.property.title, rows: rowStates(plan.rowsAfter) }]
      : []),
    ...plan.links
      .filter((l) => collWrites.some((w) => w.propertyId === l.propertyId))
      .map((l) => ({ id: l.propertyId, title: l.title, collection: l.after })),
  ];
  steps.push({
    op: VERIFY_STEP,
    params: { body: { targets: [{ kind: 'sidebar', label: page.name, resourceId: page.id, properties }] } },
  });

  const table = plan.facts.map((f) => ({ key: f.key, before: f.before, after: f.after, change: f.change }));
  const operation: Record<string, unknown> = {
    tool: 'set_facts',
    page,
    ...(plan.property ? { property: plan.property.title } : {}),
    pageParts,
    counts,
    facts: table,
    rowsBefore: plan.rowsBefore.map((r) => ({ key: r.key, value: rowText(r.content) })),
    rowsAfter: plan.rowsAfter.map((r) => ({ key: r.key, value: rowText(r.content) })),
    links: plan.links.map((l) => ({
      title: l.title,
      added: l.added.map(linkView),
      removed: l.removed.map(linkView),
      alreadyLinked: l.alreadyLinked.map(linkView),
      notLinked: l.notLinked.map(linkView),
      filtered: l.filtered,
    })),
    ...(plan.notes.length > 0 ? { notes: plan.notes } : {}),
    inputs,
  };
  return {
    steps,
    operation,
    summary: `set_facts on “${page.name}”: ${parts.join(', ') || 'no change'}`.slice(0, 500),
    pageParts,
    journalOperation,
  };
}

function rowText(content: readonly Record<string, unknown>[]): string {
  return content
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      if (r.break === true) return '\n';
      const m = r.mention as Record<string, unknown> | undefined;
      if (!m) return '';
      const s = (v: unknown) => (typeof v === 'string' ? v : '');
      const label = s(m.text) || s(m.name) || s(m.resourceId);
      const doc = s(m.documentId);
      return `[${label}](lk://resources/${s(m.resourceId)}${doc ? `/docs/${doc}` : ''})`;
    })
    .join('');
}

// ============================================================================================ v2 C2b: a new page

export interface NewPageFacts {
  /** The copy check (a `bridge.expect` step), then the writes; empty when the plan writes nothing. */
  readonly steps: readonly StepSpec[];
  /** The `facts` target for the job's verify step (null when nothing is written). */
  readonly verify: VerifyTarget | null;
  /** "6 facts", "1 link": what the page gets, in words. */
  readonly parts: readonly string[];
  readonly counts: Record<string, number>;
  /** The facts table (key, value), for results and the proposal. */
  readonly facts: readonly { readonly key: string; readonly value: string | null }[];
  readonly links: readonly Record<string, unknown>[];
}

/**
 * The facts and links of a page created from a template in the SAME job (v2 C2b, ADR 0034). `plan` was made by
 * `planFacts` on the TEMPLATE's sidebar with the new page's id, so its writes name the template's property, row and
 * item ids. The steps:
 *
 * 1. `bridge.expect` with a `copy` check (step `copyStepNo` of the job): the new page's sidebar, read in the job, must
 *    be the template's layout (kinds, titles, keys and values in rank order); its result maps each template id to the
 *    copy's, else a conflict and nothing is written;
 * 2. the row writes, each with `bindIds` (the copy's ids, bound just before it runs), the If-Match chain and the in-step
 *    check of the rows (by key and value, so no id is needed) as set_facts has them; then the collection writes.
 *
 * Every write is journalled with the high-level operation; the tree re-reads the page once, when the job ends.
 */
export function expandNewPageFacts(input: {
  readonly plan: FactsPlan;
  readonly page: FactsPage;
  readonly templateId: string;
  readonly templateSidebar: readonly SidebarProperty[];
  readonly copyStepNo: number;
  readonly journalOperation: Record<string, unknown>;
}): NewPageFacts {
  const { plan, page } = input;
  const { parts, counts } = planCounts(plan);
  const facts = plan.rowsAfter.map((r) => ({ key: r.key, value: rowText(r.content) || null }));
  const links = plan.links.map((l) => ({
    title: l.title,
    added: l.added.map(linkView),
    ...(l.filtered ? { filtered: true } : {}),
  }));
  if (plan.empty) return { steps: [], verify: null, parts, counts, facts, links };
  const label = `${page.name} (new)`;
  const rowWrites = plan.writes.filter((w) => w.op !== 'updateProperty');
  const collWrites = plan.writes.filter((w) => w.op === 'updateProperty');
  const touched = new Set(plan.writes.map((w) => w.propertyId));
  const properties = input.templateSidebar
    .filter((p) => touched.has(p.id))
    .map((p) =>
      p.kind === 'keyValue'
        ? {
            id: p.id,
            kind: p.kind,
            title: p.title,
            rows: (p.rows ?? []).map((r) => ({ id: r.id ?? '', key: r.key, content: r.content })),
          }
        : {
            id: p.id,
            kind: p.kind,
            title: p.title,
            items: (Array.isArray(p.raw.items) ? (p.raw.items as { id?: unknown }[]) : [])
              .map((i) => i.id)
              .filter((x): x is string => typeof x === 'string'),
          },
    );
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [{ label, kind: 'copy', resourceId: page.id, templateId: input.templateId, properties }],
        },
      },
    },
  ];
  const bind = { step: input.copyStepNo };
  const journal = { ...input.journalOperation, page: { id: page.id, name: page.name }, counts };
  rowWrites.forEach((w, i) => {
    steps.push({
      op: w.op,
      params: w.params,
      bindIds: bind,
      ifMatchFrom: i === 0 ? { step: input.copyStepNo, key: label } : { step: input.copyStepNo + i },
      expectCurrent: { state: 'rows', hash: rowsContentHash(rowStates(w.rowsBefore ?? [])), label },
      deferTreeReread: true,
      journalOperation: { ...journal, write: w.label },
    });
  });
  for (const w of collWrites) {
    steps.push({
      op: w.op,
      params: w.params,
      bindIds: bind,
      deferTreeReread: true,
      journalOperation: { ...journal, write: w.label },
    });
  }
  const verify: VerifyTarget = {
    kind: 'facts',
    label: page.name,
    resourceId: page.id,
    ...(plan.property && rowWrites.length > 0
      ? {
          property: {
            title: plan.property.title,
            rows: plan.rowsAfter.map((r) => ({ key: r.key, content: [...r.content] })),
          },
        }
      : {}),
    ...(collWrites.length > 0
      ? {
          collections: plan.links
            .filter((l) => collWrites.some((w) => w.propertyId === l.propertyId))
            .map((l) => ({
              title: l.title,
              items: l.after.items.map((it) => ({ resourceId: it.resourceId, documentId: it.documentId })),
            })),
        }
      : {}),
  };
  return { steps, verify, parts, counts, facts, links };
}
