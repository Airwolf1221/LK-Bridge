/**
 * `set_facts` (v2 C2a, ADR 0032; PLAN-v2 section 5 Facts row, 10.2, 10.3, 10.6 and section 9's link collections):
 * changes a page's sidebar facts (key-value rows) and relationship links (link collections).
 *
 * 1. Plan, before anything is queued: one `listProperties` (it gives each property and its rows), values converted
 *    (plain text, or inline Markdown with `[[Name]]` mentions resolved inside the AI REPOSITORY), links resolved, new
 *    template facts placed in template order (src/facts/plan.ts). Every refusal is typed; an empty plan writes nothing;
 *    `dryRun` stops here.
 * 2. Write: ONE job holding the page's lock throughout: the bridge's own check of every property it changes, the row
 *    writes with chained If-Match, the collection writes, the verify read (src/facts/expand.ts).
 * 3. The protected canonical facts: the engine's write guard judges the plan like any other write; a protected change
 *    becomes a proposal flagged for canonical approval whatever the scope (src/facts/canonical.ts).
 */
import * as z from 'zod';
import { assessFactChange, canonConfigFrom, factRows, sidebarFrom } from '../../facts/index.js';
import { expandFacts, planCounts } from '../../facts/expand.js';
import { FactsPlanError, planFacts, type FactsPlan, type LinkTarget } from '../../facts/plan.js';
import { templateFor, templateKeysFrom } from '../../facts/templates.js';
import { factValueRuns, FactValueError } from '../../facts/values.js';
import { factsDifferences, factsVersionFrom } from '../../facts/version.js';
import type { SidebarPropertyState } from '../../jobs/sidebar-state.js';
import { mentionChoices, pageConverterContext } from '../../pages/index.js';
import type { TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool } from './define.js';
import { finish, liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';

export const SET_FACTS_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DEFAULT_PROPERTY = 'PROPERTIES';
const WAIT_MS = 25_000;

export const factValue = z.union([
  z.string().max(100_000),
  z.object({ markdown: z.string().max(100_000) }).strict(),
  z.null(),
]);
export const pageRef = z.string().min(1).max(500);
export const linkRef = z.union([
  pageRef,
  z.object({ page: pageRef, document: z.string().min(1).max(500) }).strict(),
]);
export const linkEdit = z
  .object({ add: z.array(linkRef).max(256).optional(), remove: z.array(linkRef).max(256).optional() })
  .strict();

export type LinkRef = z.infer<typeof linkRef>;

const refText = (r: LinkRef) => (typeof r === 'string' ? r : `${r.page} / ${r.document}`);

/** A link reference to one page (or one of its documents) inside the AI REPOSITORY. */
export function resolveLink(
  ctx: RepoCtx,
  ref: LinkRef,
  o: { allowRawId?: (id: string) => boolean } = {},
): { ok: true; target: LinkTarget } | { ok: false; result: McpToolResult } {
  const pageQ = typeof ref === 'string' ? ref : ref.page;
  const raw = pageQ.trim().replace(/^lk:\/\/resources\//, '');
  // A remove may name an item by the id it holds even when the page is gone from the tree.
  if (o.allowRawId?.(raw) && typeof ref === 'string') {
    const n = ctx.tree.node(ctx.projectId, raw).data;
    return { ok: true, target: { resourceId: raw, name: n?.displayName ?? raw } };
  }
  const r = resolvePage(ctx, pageQ, { what: `the link “${refText(ref)}”` });
  if (!r.ok) return r;
  const node = r.node;
  if (typeof ref === 'string') return { ok: true, target: { resourceId: node.id, name: node.displayName } };
  const want = ref.document.trim();
  const byId = node.documents.find((d) => d.id === want);
  const named = byId
    ? [byId]
    : node.documents.filter((d) => (d.name ?? '').toLowerCase() === want.toLowerCase());
  if (named.length !== 1) {
    return {
      ok: false,
      result: errorResult(
        {
          code: named.length === 0 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_AMBIGUOUS',
          message:
            named.length === 0
              ? `“${node.displayName}” has no document named or numbered “${want}”.`
              : `“${node.displayName}” has ${named.length} documents named “${want}”. Pass the id of the one you mean.`,
          page: { id: node.id, name: node.displayName },
          documents: node.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
        },
        ctx.pd,
      ),
    };
  }
  const doc = named[0]!;
  return {
    ok: true,
    target: {
      resourceId: node.id,
      name: node.displayName,
      documentId: doc.id,
      ...(doc.name ? { documentName: doc.name } : {}),
    },
  };
}

const linkName = (t: LinkTarget) => (t.documentName ? `${t.name} / ${t.documentName}` : t.name);

/** What the plan does, as the result shows it. */
function changesBody(plan: FactsPlan): Record<string, unknown> {
  const pick = (c: string) => plan.facts.filter((f) => f.change === c);
  const facts = {
    added: pick('added').map((f) => ({ key: f.key, value: f.after })),
    changed: pick('changed').map((f) => ({ key: f.key, before: f.before, after: f.after })),
    removed: pick('removed').map((f) => ({ key: f.key, before: f.before })),
    unchanged: pick('unchanged').map((f) => f.key),
    notPresent: pick('not_present').map((f) => f.key),
  };
  const links: Record<string, unknown> = {};
  for (const l of plan.links) {
    links[l.title] = {
      added: l.added.map(linkName),
      removed: l.removed.map(linkName),
      alreadyLinked: l.alreadyLinked.map(linkName),
      ...(l.notLinked.length ? { notLinked: l.notLinked.map(linkName) } : {}),
      ...(l.filtered
        ? { note: 'This collection has a filter, kept as it is: it may show pages its items do not list.' }
        : {}),
    };
  }
  return {
    ...(plan.property ? { property: plan.property.title } : {}),
    facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v.length > 0)),
    ...(plan.links.length > 0 ? { links } : {}),
  };
}

export function setFactsTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'set_facts',
    title: 'Set facts and links',
    access: 'write',
    description:
      'Changes a page’s sidebar FACTS (the key-value rows of PROPERTIES) and LINKS (collections such as Dependencies and Related Sources). Page text is write_page; name, tags and aliases are update_resource. `facts` maps a key to a plain string, { "markdown": "…" } (inline Markdown and [[mentions]]) or null to remove the row; keys match without case and keep their place, new template facts go in template order, others at the bottom. `links` maps a collection title to { add, remove }: page names or ids, or { page, document }. Read the page first with get_resource and pass its factsVersion as baseFactsVersion whenever a value rests on what you read: if the sidebar changed since, nothing is written (VERSION_CONFLICT: read again, redo). Change all the facts you need in ONE call. dryRun shows the plan. Protected canon is always a proposal the owner accepts as canon, whatever your scope (setting Status to or from Authoritative; changing an existing Continuity Type or Continuity): never retry it or route around it; lifecycle changes use promote_page, archive_page and move_to_working. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Example: { "page": "Asagiri Miyabi", "facts": { "Scope": "Shrine maiden", "Sister": { "markdown": "[[Asagiri Kaede]]" }, "Old Note": null }, "links": { "Dependencies": { "add": ["Fourth Age - Table"] } }, "baseFactsVersion": "fv2_…", "project": "test" }. Cost: about 4 reads, then 1 write per fact and per collection changed.',
    inputSchema: z.object({
      page: pageRef.describe('Page name or id (inside the AI REPOSITORY).'),
      facts: z
        .record(z.string().min(1).max(256), factValue)
        .optional()
        .describe('Key → value (string, { markdown }, or null to remove the row).'),
      links: z
        .record(z.string().min(1).max(256), linkEdit)
        .optional()
        .describe('Collection title → { add, remove }: page names or ids, or { page, document }.'),
      property: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('The key-value property’s title. Default: the project’s setting (normally "PROPERTIES").'),
      baseFactsVersion: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          'The factsVersion get_resource (or an earlier set_facts) gave when you read the page. Pass it whenever a value is based on what you read: if ANY sidebar fact or link changed since, nothing is written (VERSION_CONFLICT, with what changed).',
        ),
      dryRun: z.boolean().optional().describe('Show the plan; write nothing.'),
      project: projectArg,
    }),
    annotations: SET_FACTS_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const factEntries = Object.entries(args.facts ?? {});
        const linkEntries = Object.entries(args.links ?? {});
        if (factEntries.length === 0 && linkEntries.every(([, l]) => !l.add?.length && !l.remove?.length)) {
          return errorResult(
            { code: 'INVALID_PARAMS', message: 'Give facts, or links with something to add or remove.' },
            pd,
          );
        }
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const resolved = resolvePage(ctx, args.page);
        if (!resolved.ok) return resolved.result;
        const node = resolved.node;
        const choices: Parameters<typeof mentionChoices>[0][number][] = [];
        const converter = pd.services
          ? pageConverterContext(pd.services, ctx.projectId, { onMentionChoice: (c) => choices.push(c) })
          : undefined;
        if (!converter) {
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The repository tree cannot resolve names now.' },
            pd,
          );
        }
        const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
        const propertyTitle =
          args.property ??
          (typeof settings.factsPropertyName === 'string' ? settings.factsPropertyName : DEFAULT_PROPERTY);

        // 1. Values, before any read: a value that cannot be written is refused for nothing.
        const facts: { key: string; value: Record<string, unknown>[] | null }[] = [];
        for (const [key, value] of factEntries) {
          if (value === null) {
            facts.push({ key, value: null });
            continue;
          }
          try {
            facts.push({ key, value: factValueRuns(value, converter) });
          } catch (e) {
            if (e instanceof FactValueError) {
              return errorResult({ code: e.code, message: `${key}: ${e.message}`, key, ...e.details }, pd);
            }
            return errorFromThrown(e, pd);
          }
        }

        // 2. The page's sidebar: one read.
        const path = { resourceId: node.id };
        const read = await liveRead(pd, mctx, 'set_facts', 'listProperties', { path });
        if (!read.ok) return read.result;
        const sidebar = sidebarFrom(read.value);
        // v2 C2b: the bridge's own version of the whole sidebar, checked against the agent's base before anything else.
        const before = factsVersionFrom(node.id, read.value);
        pd.services?.factsVersions?.store(ctx.projectId, node.id, before.version, before.state);
        if (args.baseFactsVersion !== undefined && args.baseFactsVersion !== before.version) {
          return staleBase(pd, node, args.baseFactsVersion, before);
        }

        // 3. Links: every page resolved inside the AI REPOSITORY.
        const links = [];
        for (const [title, edit] of linkEntries) {
          const coll = sidebar.find(
            (p) =>
              (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
              p.title.trim().toLowerCase() === title.trim().toLowerCase(),
          );
          const held = new Set(
            (Array.isArray(coll?.raw.items) ? (coll.raw.items as { resourceId?: unknown }[]) : [])
              .map((i) => i.resourceId)
              .filter((x): x is string => typeof x === 'string'),
          );
          const add: LinkTarget[] = [];
          const remove: LinkTarget[] = [];
          for (const ref of edit.add ?? []) {
            const r = resolveLink(ctx, ref);
            if (!r.ok) return r.result;
            add.push(r.target);
          }
          for (const ref of edit.remove ?? []) {
            const r = resolveLink(ctx, ref, { allowRawId: (id) => held.has(id) });
            if (!r.ok) return r.result;
            remove.push(r.target);
          }
          links.push({ title, add, remove });
        }

        // 4. The template's order, only when a new fact needs it.
        const kv = sidebar.filter(
          (p) => p.kind === 'keyValue' && p.title.trim().toLowerCase() === propertyTitle.trim().toLowerCase(),
        );
        const existingKeys = new Set(
          (kv.length === 1 ? (kv[0]!.rows ?? []) : []).map((r) => r.key.trim().toLowerCase()),
        );
        const needsTemplate = facts.some(
          (f) => f.value !== null && !existingKeys.has(f.key.trim().toLowerCase()),
        );
        let templateKeys: readonly string[] | null = null;
        let templateNote: string | null = null;
        if (needsTemplate) {
          const t = await templateKeysFor(pd, mctx, ctx, node, facts, kv[0]?.rows ?? [], propertyTitle);
          if (!t.ok) return t.result;
          templateKeys = t.keys;
          templateNote = t.note;
        }

        // 5. The plan.
        let plan: FactsPlan;
        try {
          plan = planFacts({ resourceId: node.id, sidebar, propertyTitle, facts, links, templateKeys });
        } catch (e) {
          if (e instanceof FactsPlanError)
            return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
          return errorFromThrown(e, pd);
        }
        const page = { id: node.id, name: node.displayName, path: node.path.names.join(' / ') };
        const notes = [...(templateNote ? [templateNote] : []), ...plan.notes];
        const rules = canonConfigFrom(settings).active;
        const canon = assessFactChange(
          rules,
          factRows(sidebar).map((r) => ({ key: r.key, content: r.content })),
          factRows(plan.sidebarAfter).map((r) => ({ key: r.key, content: r.content })),
        );
        const head = {
          page,
          factsVersion: before.version,
          ...changesBody(plan),
          ...(choices.length > 0 ? { mentions: mentionChoices(choices) } : {}),
          ...(notes.length ? { notes } : {}),
        };
        if (plan.empty) {
          return render(
            {
              ...head,
              status: 'no_change',
              message: 'Nothing to write: the page already holds this. Nothing was sent.',
            },
            pd,
          );
        }
        const canonical =
          canon.length > 0
            ? {
                requiresCanonicalApproval: true,
                protectedChanges: canon.map((c) => c.text),
              }
            : {};
        const { parts } = planCounts(plan);
        const preview = () => ({ page, summary: parts.join(', ') });
        if (args.dryRun === true) {
          return finish(
            pd,
            mctx,
            'set_facts',
            {
              ...head,
              status: 'dry_run',
              summary: parts.join(', '),
              writes: plan.writes.map((w) => w.label),
              ...canonical,
              message:
                canon.length > 0
                  ? 'Dry run: nothing was written. This change touches protected canon, so it would become a proposal that only the owner can accept as canon.'
                  : 'Dry run: nothing was written and nothing was proposed.',
            },
            preview,
          );
        }

        // 6. Write: one job under the page's lock (check, chained writes, verify).
        const job = expandFacts(
          plan,
          page,
          sidebar,
          { facts: args.facts ?? {}, links: args.links ?? {} },
          args.baseFactsVersion !== undefined
            ? { wholeSidebar: { factsVersion: before.version, state: before.state } }
            : {},
        );
        let r;
        try {
          r = await pd.engine.submit({
            kind: 'batch_ops',
            project: pd.project.id,
            steps: job.steps,
            onError: 'stop',
            priority: 'P1',
            origin: mcpOrigin(mctx, 'set_facts'),
            title: job.summary.slice(0, 300),
            holdLock: { resourceId: node.id },
            internal: true,
            proposal: {
              operation: job.operation,
              operations: [job.operation],
              summary: job.summary,
              prefetched: [{ op: 'listProperties', path, body: read.value }],
            },
          });
        } catch (e) {
          return errorFromThrown(e, pd);
        }
        if ('proposalId' in r) {
          return finish(
            pd,
            mctx,
            'set_facts',
            {
              ...head,
              status: 'proposal_captured',
              proposalId: r.proposalId,
              ...(r.summary !== undefined ? { summary: r.summary } : {}),
              ...(r.canonical
                ? {
                    requiresCanonicalApproval: true,
                    reason: r.canonical.reason,
                    hint:
                      'This change touches protected canon, so it was NOT made: it waits for the owner, who alone can accept it as canon. ' +
                      'This happens whatever your scope. Never retry it or work around it; tell the user, and follow it with bridge_proposal_status.',
                  }
                : {
                    hint:
                      'The change needs the owner’s approval and was NOT made. The owner sees this plan; if the sidebar changes before approval, ' +
                      'the proposal becomes conflicted rather than being applied. Never retry it; follow it with bridge_proposal_status.',
                  }),
            },
            preview,
          );
        }
        // Held (writes paused, read-only): it runs when they resume; say so at once rather than wait.
        const view =
          r.eta === null
            ? (pd.engine.queries.getJob(pd.project.id, r.jobId) ??
              (await pd.engine.wait(pd.project.id, r.jobId, 0)))
            : await pd.engine.wait(pd.project.id, r.jobId, WAIT_MS);
        const labels = ['check', ...plan.writes.map((w) => w.label), 'verify'];
        if (view.status === 'succeeded') {
          const res = (view.result ?? {}) as { verified?: unknown; verification?: Record<string, unknown> };
          const verified = typeof res.verified === 'boolean' ? res.verified : null;
          const ver = res.verification ?? {};
          const after = factsVersionAfter(ver);
          return finish(
            pd,
            mctx,
            'set_facts',
            {
              ...head,
              status: 'written',
              verified,
              jobId: view.id,
              factsVersion: { before: before.version, ...(after ? { after } : {}) },
              ...(verified === false
                ? {
                    warning:
                      'written but not as planned: the sidebar read back after the writes differs from the plan; something else probably ' +
                      'edited the page at the same moment. Nothing was retried. The journal holds what each write changed ' +
                      `(bridge_journal_lookup with jobId ${view.id}). Read the page and check it.`,
                    verification: ver,
                  }
                : verified === null
                  ? { verification: { status: ver.status, reason: ver.reason } }
                  : {}),
            },
            preview,
          );
        }
        if (view.status === 'failed' || view.status === 'cancelled') {
          return failedBody(pd, head, view, labels);
        }
        return render(
          {
            ...head,
            status: view.status === 'waiting_budget' ? 'waiting_budget' : 'queued',
            jobId: view.id,
            hint:
              'The change is accepted and has NOT failed: it runs by itself, checking the sidebar again inside the page’s lock. ' +
              'Never submit it again: follow it with bridge_job_status or bridge_job_wait.',
          },
          pd,
        );
      }),
  });
}

/** The result of a job that did not finish well: a conflict (nothing written), or what was written before it stopped. */
function failedBody(
  pd: ProjectDeps,
  head: Record<string, unknown>,
  view: Awaited<ReturnType<ProjectDeps['engine']['wait']>>,
  labels: readonly string[],
): McpToolResult {
  const err = (view.lastError ?? {}) as { code?: unknown; message?: unknown; stepNo?: unknown };
  const why = typeof err.message === 'string' ? err.message : null;
  const steps = pd.engine.stepResults(pd.project.id, view.id) ?? [];
  const written = steps
    .filter((s) => s.status === 'succeeded' && s.stepNo > 1 && s.stepNo < labels.length)
    .map((s) => labels[s.stepNo - 1]!);
  // CR-2026-11 (CR-07): a write whose answer was lost, and whose check could not tell, may have been made.
  const uncertain = steps
    .filter((s) => s.status === 'uncertain' && s.stepNo > 1 && s.stepNo < labels.length)
    .map((s) => labels[s.stepNo - 1]!);
  if (uncertain.length > 0) {
    return errorResult(
      {
        code: 'OUTCOME_UNKNOWN',
        message:
          `Not known whether ${uncertain.join('; ')} ${uncertain.length === 1 ? 'was' : 'were'} written: LegendKeeper's answer ` +
          `was lost and the read that should have told failed too (${why ?? view.status}). ` +
          (written.length > 0 ? `Written: ${written.join('; ')}. ` : '') +
          'Nothing after it was written, and nothing was retried.',
        jobId: view.id,
        written,
        uncertain,
        hint: `Read the page with get_resource to see what it holds before doing anything else; do not repeat this call. bridge_journal_lookup with jobId ${view.id} shows each write (its outcome "unknown").`,
        ...head,
      },
      pd,
    );
  }
  if (written.length === 0 && err.code === 'VERSION_CONFLICT') {
    const differences = (view.lastError as { differences?: unknown } | null)?.differences;
    return errorResult(
      {
        code: 'VERSION_CONFLICT',
        message: why ?? 'The sidebar changed since it was read.',
        ...(Array.isArray(differences) ? { differences } : {}),
        jobId: view.id,
        hint: 'Nothing was written. Do not retry the same call: read the page again with get_resource, and redo the change on what it holds now.',
        ...head,
      },
      pd,
    );
  }
  if (written.length === 0) {
    return errorResult(
      {
        code: typeof err.code === 'string' ? err.code : 'JOB_FAILED',
        message: `Nothing was written: ${why ?? `the job ended ${view.status}`}`,
        jobId: view.id,
        ...head,
      },
      pd,
    );
  }
  return errorResult(
    {
      code: 'WRITTEN_IN_PART',
      message:
        `Written in part: ${written.join('; ')} were written, then the job stopped (${why ?? view.status}). ` +
        'The rest was not written and nothing was retried. The journal holds what each write changed.',
      jobId: view.id,
      written,
      hint: `Read the page with get_resource before doing anything else; bridge_journal_lookup with jobId ${view.id} shows each write.`,
      ...head,
    },
    pd,
  );
}

/** v2 C2b: a `baseFactsVersion` that is not the sidebar's version now: nothing written, with what changed when known. */
function staleBase(
  pd: ProjectDeps,
  node: TreeNode,
  base: string,
  now: { readonly version: string; readonly state: readonly SidebarPropertyState[] },
): McpToolResult {
  const remembered = pd.services?.factsVersions?.recall(pd.project.id, node.id, base) ?? null;
  const differences = remembered ? factsDifferences(remembered, now.state) : null;
  return errorResult(
    {
      code: 'VERSION_CONFLICT',
      reason: remembered ? 'changed_since_base' : 'base_unknown',
      message: remembered
        ? `The sidebar of “${node.displayName}” changed since factsVersion ${base} (${differences!.length} difference(s)). Nothing was written.`
        : `The sidebar of “${node.displayName}” is not at factsVersion ${base} (the bridge does not remember that version, so it cannot say what changed). Nothing was written.`,
      page: { id: node.id, name: node.displayName },
      baseFactsVersion: base,
      factsVersion: now.version,
      ...(differences ? { differences: differences.slice(0, 20) } : {}),
      hint: 'Read the page again with get_resource, redo the change on what it holds now, and pass the new factsVersion.',
    },
    pd,
  );
}

/** v2 C2b: the factsVersion the verify step read back (its sidebar or facts target), if it read one. */
export function factsVersionAfter(verification: Record<string, unknown>): string | null {
  const targets = Array.isArray(verification.targets)
    ? (verification.targets as Record<string, unknown>[])
    : [];
  for (const t of targets) if (typeof t.factsVersion === 'string') return t.factsVersion;
  return null;
}

/** The template's fact keys (cached for a day), or null with the reason as a note. */
export async function templateKeysFor(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  node: TreeNode,
  facts: readonly { key: string; value: unknown }[],
  rows: readonly { key: string; content: readonly Record<string, unknown>[] }[],
  propertyTitle: string,
): Promise<
  | { readonly ok: true; readonly keys: readonly string[] | null; readonly note: string | null }
  | { readonly ok: false; readonly result: McpToolResult }
> {
  // The Reference Type this call leaves the page with (it may set it), else the one it has.
  const refKey = 'reference type';
  const setRef = facts.find((f) => f.key.trim().toLowerCase() === refKey);
  const liveRef = rows.find((r) => r.key.trim().toLowerCase() === refKey);
  const refType =
    setRef && Array.isArray(setRef.value)
      ? (setRef.value as { text?: unknown }[]).map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
      : liveRef
        ? liveRef.content.map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
        : null;
  const choice = templateFor(node, ctx.types.store.listTypes(), refType);
  if (!choice) return { ok: true, keys: null, note: null };
  const cache = pd.services?.templateKeys;
  const cached = cache?.cached(ctx.projectId, choice.templateId, propertyTitle);
  if (cached !== undefined) {
    return cached === null
      ? {
          ok: true,
          keys: null,
          note: `The template (${choice.detail}) has no key-value property titled “${propertyTitle}”, so new facts were put at the bottom.`,
        }
      : { ok: true, keys: cached, note: null };
  }
  const read = await liveRead(pd, mctx, 'set_facts', 'listProperties', {
    path: { resourceId: choice.templateId },
  });
  if (!read.ok) {
    return {
      ok: true,
      keys: null,
      note: `The template ${choice.templateId} could not be read, so new facts were put at the bottom.`,
    };
  }
  const keys = cache
    ? cache.store(ctx.projectId, choice.templateId, propertyTitle, read.value)
    : templateKeysFrom(read.value, propertyTitle);
  return keys === null
    ? {
        ok: true,
        keys: null,
        note: `The template (${choice.detail}) has no key-value property titled “${propertyTitle}”, so new facts were put at the bottom.`,
      }
    : { ok: true, keys, note: null };
}
