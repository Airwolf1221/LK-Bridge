/**
 * What the create tools share (v2 C2b, ADR 0034): parents inside the AI REPOSITORY, templates by name or id, names from
 * a template role's pattern, the facts a new page gets (identity facts, Status `Working`, the caller's facts and links)
 * planned on its template's sidebar, the ONE job that creates the pages, writes their facts and verifies everything,
 * and `operation_id` with duplicate-request claims around it.
 */
import { factKey, sidebarFrom, type SidebarProperty } from '../../facts/index.js';
import { expandNewPageFacts } from '../../facts/expand.js';
import { FactsPlanError, planFacts, type FactsPlan, type LinkTarget } from '../../facts/plan.js';
import { factValueRuns, FactValueError, rowTextRuns } from '../../facts/values.js';
import { VERIFY_STEP, type VerifyTarget } from '../../jobs/internal-steps.js';
import type { StepSpec } from '../../jobs/index.js';
import { mintClientId } from '../../jobs/ids.js';
import { pageConverterContext } from '../../pages/index.js';
import { cleanPrefixes, key, templateBaseKey } from '../../registry/names.js';
import type { RegistryType } from '../../registry/index.js';
import {
  CreatePlanError,
  SiblingSim,
  planCreates,
  type CreateItem,
  type CreatePlan,
} from '../../resources/plan.js';
import { requestHash } from '../../resources/requests.js';
import { classifyName } from '../../tree/classify.js';
import type { TreeNode } from '../../tree/index.js';
import type { LifecycleMarker } from '../../jobs/index.js';
import { lifecycleFrom, lifecycleIndexes, type LifecycleConfig } from '../../lifecycle/settings.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import { liveRead, resolvePage, type RepoCtx } from './repo.js';
import { resolveLink, type LinkRef } from './set-facts.js';
import { errorFromThrown, errorResult, mcpOrigin, render, type ProjectDeps } from './shape.js';
import { describeJob, type WriteJobOutcome } from './write-job.js';

type Obj = Record<string, unknown>;
export type FactInput = string | { readonly markdown: string } | null;
export type LinkEdits = Readonly<
  Record<string, { readonly add?: readonly LinkRef[]; readonly remove?: readonly LinkRef[] }>
>;

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: McpToolResult };
const fail = (result: McpToolResult) => ({ ok: false as const, result });

// ============================================================================================ parents

/**
 * A parent for new pages: an index (or the AI REPOSITORY root itself) inside the repository, by name or id. A page
 * that is not an index is refused: pages are made under indexes.
 */
export function resolveParent(
  ctx: RepoCtx,
  query: string,
  o: { readonly what?: string; readonly allowRoot?: boolean } = {},
): Result<TreeNode> {
  const r = resolvePage(ctx, query, { what: o.what ?? `the parent “${query}”` });
  if (!r.ok) return r;
  if (r.node.kind === 'index' || (r.node.kind === 'root' && o.allowRoot !== false))
    return { ok: true, value: r.node };
  return fail(
    errorResult(
      {
        code: 'PARENT_NOT_INDEX',
        message: `“${r.node.displayName}” is a ${r.node.kind === 'bsrc' ? '[BSRC] page' : `${r.node.kind} page`}, not an index; new pages go under an [INDEX] page.`,
        parent: { id: r.node.id, name: r.node.displayName, path: r.node.path.names.join(' / ') },
      },
      ctx.pd,
    ),
  );
}

// ============================================================================================ templates

export interface TemplateRef {
  readonly id: string;
  readonly name: string | null;
  /** The kind of page it makes: from its name's prefix, else from the registry role it fills. */
  readonly kind: 'index' | 'bsrc' | null;
  /** The type and role it fills in the registry, if any (`index`, `core`, `compact`, …). */
  readonly roles: readonly { readonly type: RegistryType; readonly role: string }[];
}

function rolesOf(types: readonly RegistryType[], id: string) {
  const out: { type: RegistryType; role: string }[] = [];
  for (const t of types) {
    if (t.indexTemplateId === id) out.push({ type: t, role: 'index' });
    for (const p of t.pageTemplates) if (p.templateId === id) out.push({ type: t, role: p.role });
  }
  return out;
}

function templateRef(types: readonly RegistryType[], id: string, name: string | null): TemplateRef {
  const roles = rolesOf(types, id);
  const byName = name ? classifyName(name).kind : 'unclassified';
  const kind =
    byName === 'index' || byName === 'bsrc'
      ? byName
      : roles.some((r) => r.role === 'index')
        ? 'index'
        : roles.length > 0
          ? 'bsrc'
          : null;
  return { id, name, kind, roles };
}

/**
 * A template by id or name: the project's templates as last read (the registry's snapshot), the templates the registry
 * names, and, when the snapshot has none, one live `listTemplates` read. Names match with the word "Template" and stray
 * prefixes ignored, as LegendKeeper's copies drop it.
 */
export async function resolveTemplate(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  tool: string,
  query: string,
): Promise<Result<TemplateRef>> {
  const types = ctx.types.store.listTypes();
  let list = ctx.types.store.templates().templates.map((t) => ({ id: t.id, name: t.name }));
  const q = query.trim().replace(/^lk:\/\/resources\//, '');
  const known = new Set([
    ...list.map((t) => t.id),
    ...types.flatMap((t) => [t.indexTemplateId, ...t.pageTemplates.map((p) => p.templateId)]),
  ]);
  const findByName = () => {
    const want = templateBaseKey(cleanPrefixes(q).name);
    return list.filter((t) => t.name && templateBaseKey(cleanPrefixes(t.name).name) === want);
  };
  if (known.has(q))
    return { ok: true, value: templateRef(types, q, list.find((t) => t.id === q)?.name ?? null) };
  let hits = findByName();
  if (hits.length === 0) {
    // The snapshot may be empty or old: read the templates once.
    const r = await liveRead(pd, mctx, tool, 'listTemplates', {});
    if (r.ok) {
      const data = (r.value as { data?: unknown }).data;
      list = (Array.isArray(data) ? (data as Obj[]) : [])
        .filter((t) => typeof t.id === 'string')
        .map((t) => ({ id: t.id as string, name: typeof t.name === 'string' ? t.name : '' }));
      if (list.some((t) => t.id === q)) {
        return { ok: true, value: templateRef(types, q, list.find((t) => t.id === q)!.name) };
      }
      hits = findByName();
    }
  }
  if (hits.length === 1) return { ok: true, value: templateRef(types, hits[0]!.id, hits[0]!.name) };
  return fail(
    errorResult(
      hits.length > 1
        ? {
            code: 'TEMPLATE_AMBIGUOUS',
            message: `${hits.length} templates are named “${query}”; pass the id of the one you mean.`,
            candidates: hits,
          }
        : {
            code: 'TEMPLATE_NOT_FOUND',
            message: `No template is named “${query}”. Templates: ${list.map((t) => t.name).join(', ') || 'none found'}. See list_templates.`,
            templates: list.slice(0, 50),
          },
      pd,
    ),
  );
}

/** The name pattern of the role a template fills (`{name} - Character Core`), else `{name}`. */
export function namePatternOf(t: TemplateRef): string {
  for (const r of t.roles) {
    const p = r.type.placement;
    if (p && (r.role === 'core' || r.role === 'compact')) return p.pageNames[r.role];
  }
  return '{name}';
}

/**
 * One governed read of a template (`getResource`: its sidebar and, v2 C2c, its tags), cached for the call. The tags are
 * kept in `tags` (a new page's status tag replaces the template's).
 */
export async function readSidebar(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  resourceId: string,
  cache: Map<string, SidebarProperty[]>,
  tags?: Map<string, string[]>,
): Promise<Result<SidebarProperty[]>> {
  const had = cache.get(resourceId);
  if (had) return { ok: true, value: had };
  const r = await liveRead(pd, mctx, tool, 'getResource', { path: { resourceId } });
  if (!r.ok) return r;
  const sb = sidebarFrom(r.value);
  cache.set(resourceId, sb);
  const t = (r.value as { tags?: unknown } | null)?.tags;
  tags?.set(resourceId, Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []);
  return { ok: true, value: sb };
}

// ============================================================================================ facts of a new page

export interface CreateCtx {
  readonly pd: ProjectDeps;
  readonly mctx: McpToolContext;
  readonly ctx: RepoCtx;
  readonly tool: string;
  readonly propertyTitle: string;
  /** v2 C2c: the project's lifecycle settings (status values, tags, the Working index). */
  readonly lifecycle: LifecycleConfig;
  readonly sidebars: Map<string, SidebarProperty[]>;
  /** v2 C2c: each template's tags, as read with its sidebar. */
  readonly templateTags: Map<string, string[]>;
}

export function createCtx(pd: ProjectDeps, mctx: McpToolContext, ctx: RepoCtx, tool: string): CreateCtx {
  const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
  const propertyTitle =
    typeof settings.factsPropertyName === 'string' && settings.factsPropertyName.trim() !== ''
      ? settings.factsPropertyName
      : 'PROPERTIES';
  return {
    pd,
    mctx,
    ctx,
    tool,
    propertyTitle,
    lifecycle: lifecycleFrom(settings),
    sidebars: new Map(),
    templateTags: new Map(),
  };
}

// ============================================================================================ v2 C2c: status

/** A new page's lifecycle status (Part 1, decided by the owner): Working by default. */
export type CreateStatus = 'working' | 'authoritative';

export const STATUS_DESCRIPTION =
  'The new page’s lifecycle status. "working" (the default): a [BWRK] page directly under [INDEX] Working, ' +
  'alphabetically, with Status Working and the Working tag. "authoritative": a [BSRC] page in its normal place, with ' +
  'Status Authoritative and the CANON tag: this is canon, so it always becomes a proposal only the owner can accept as ' +
  'canon (proposal_captured with requiresCanonicalApproval), whatever your scope.';

/** The Status value of a create status. */
export function statusValue(c: LifecycleConfig, status: CreateStatus): string {
  return status === 'working' ? c.status.working : c.status.authoritative;
}

/** `tags` with every status tag removed (any case) and the status's own added; tags of an index (null) as they are. */
export function withStatusTag(
  c: LifecycleConfig,
  tags: readonly string[],
  status: CreateStatus | 'archived' | null,
): string[] {
  if (status === null) return [...tags];
  const all = [c.tags.canon, c.tags.working, c.tags.archived].map((t) => t.toLocaleLowerCase('en-GB'));
  const keep = tags.filter((t) => !all.includes(t.toLocaleLowerCase('en-GB')));
  const own = status === 'working' ? c.tags.working : status === 'archived' ? c.tags.archived : c.tags.canon;
  const out: string[] = [];
  for (const t of [...keep, own])
    if (!out.some((x) => x.toLocaleLowerCase('en-GB') === t.toLocaleLowerCase('en-GB'))) out.push(t);
  return out;
}

/** The project's Working index (confirmed by the owner, checked against the tree now), or a clear refusal. */
export function workingIndex(cc: CreateCtx): Result<TreeNode> {
  const r = lifecycleIndexes(cc.lifecycle, (id) => cc.ctx.tree.node(cc.ctx.projectId, id).data);
  if (!r.ok) return fail(errorResult({ code: r.code, message: r.message }, cc.pd));
  return { ok: true, value: r.working };
}

/** Whether a node is the Working or Archive index, or under either (by the stored ids; none when unconfigured). */
export function lifecycleAreaOf(cc: CreateCtx, n: TreeNode): 'working' | 'archived' | null {
  const { workingIndexId: w, archiveIndexId: a } = cc.lifecycle;
  if (w && (n.id === w || n.path.ids.includes(w))) return 'working';
  if (a && (n.id === a || n.path.ids.includes(a))) return 'archived';
  return null;
}

/** The marker of a create job: the pages it gives a lifecycle state, and whether it makes canon. */
export function createMarker(
  tool: string,
  pages: readonly { readonly id: string; readonly to: 'working' | 'authoritative' | null }[],
): LifecycleMarker | undefined {
  if (pages.length === 0) return undefined;
  const canonical = pages.some((p) => p.to === 'authoritative');
  return {
    tool,
    canonical,
    pages,
    ...(canonical ? { reason: 'creates an Authoritative page (canon)' } : {}),
  };
}

export interface NewPageFactsPlan {
  readonly plan: FactsPlan;
  readonly templateSidebar: readonly SidebarProperty[];
  /** v2 C2c: the Status the bridge writes (the status's value, when the template has a Status row), or null. */
  readonly status: string | null;
}

/**
 * The facts a page created from a template gets in the same job, planned on the template's sidebar (one read, cached
 * for the call): the `identity` facts first (exactly as given), then Status (v2 C2c: the value of the page's lifecycle
 * status, when the template has a Status row; a caller's Status must be the same), then the caller's facts and links. A
 * caller fact that contradicts an identity fact is refused. Nothing is planned when there is nothing to write.
 */
export async function planNewPageFacts(
  cc: CreateCtx,
  input: {
    readonly pageId: string;
    readonly pageName: string;
    readonly templateId: string;
    readonly identity?: readonly { readonly key: string; readonly value: string }[];
    readonly facts?: Readonly<Record<string, FactInput>>;
    readonly links?: LinkEdits;
    /** v2 C2c: the Status to write (the status's value), or null for none (an index). */
    readonly status: string | null;
    readonly what: string;
  },
): Promise<Result<NewPageFactsPlan | null>> {
  const { pd } = cc;
  const sbr = await readSidebar(pd, cc.mctx, cc.tool, input.templateId, cc.sidebars, cc.templateTags);
  if (!sbr.ok) return sbr;
  const sidebar = sbr.value;
  const kv = sidebar.filter((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(cc.propertyTitle));
  const templateKeys = kv.length === 1 ? (kv[0]!.rows ?? []).map((r) => r.key) : null;
  const callerFacts = Object.entries(input.facts ?? {});
  const converter = pd.services ? pageConverterContext(pd.services, cc.ctx.projectId) : undefined;
  if (!converter) {
    return fail(
      errorResult({ code: 'TOOL_UNAVAILABLE', message: 'The repository tree cannot resolve names now.' }, pd),
    );
  }
  const identity = input.identity ?? [];
  // C2d: as LegendKeeper stores them (no leading or trailing break), so the copy check and verify agree with it.
  const facts: { key: string; value: Obj[] | null }[] = identity.map((f) => ({
    key: f.key,
    value: rowTextRuns(f.value),
  }));
  for (const [k, v] of callerFacts) {
    const id = identity.find((f) => factKey(f.key) === factKey(k));
    if (id) {
      const same = typeof v === 'string' && v.trim() === id.value;
      if (!same) {
        return fail(
          errorResult(
            {
              code: 'INVALID_FACTS',
              message: `${input.what}: “${k}” is set by the bridge to “${id.value}”; leave it out of facts (or give the same value).`,
              key: k,
            },
            pd,
          ),
        );
      }
    }
  }
  const statusKey = cc.lifecycle.fields.status;
  const callerStatus = callerFacts.find(([k]) => factKey(k) === factKey(statusKey));
  if (callerStatus && input.status !== null) {
    const [, v] = callerStatus;
    if (!(typeof v === 'string' && v.trim() === input.status)) {
      return fail(
        errorResult(
          {
            code: 'INVALID_FACTS',
            message: `${input.what}: ${statusKey} is set by \`status\` (“${input.status}” here); leave it out of facts. Pass status "working" or "authoritative" instead.`,
            key: callerStatus[0],
          },
          pd,
        ),
      );
    }
  }
  const hasStatusRow = templateKeys?.some((k) => factKey(k) === factKey(statusKey)) ?? false;
  const writeStatus = input.status !== null && !callerStatus && hasStatusRow;
  if (writeStatus) facts.push({ key: statusKey, value: rowTextRuns(input.status) });
  for (const [k, v] of callerFacts) {
    if (identity.some((f) => factKey(f.key) === factKey(k))) continue;
    if (v === null) {
      facts.push({ key: k, value: null });
      continue;
    }
    try {
      facts.push({ key: k, value: factValueRuns(v, converter) });
    } catch (e) {
      if (e instanceof FactValueError) {
        return fail(
          errorResult(
            { code: e.code, message: `${input.what}: ${k}: ${e.message}`, key: k, ...e.details },
            pd,
          ),
        );
      }
      return fail(errorFromThrown(e, pd));
    }
  }
  const links: { title: string; add: LinkTarget[]; remove: LinkTarget[] }[] = [];
  for (const [title, edit] of Object.entries(input.links ?? {})) {
    if ((edit.remove ?? []).length > 0) {
      return fail(
        errorResult(
          {
            code: 'INVALID_LINKS',
            message: `${input.what}: a new page has no links to remove (“${title}”).`,
          },
          pd,
        ),
      );
    }
    const add: LinkTarget[] = [];
    for (const ref of edit.add ?? []) {
      const r = resolveLink(cc.ctx, ref);
      if (!r.ok) return r;
      add.push(r.target);
    }
    links.push({ title, add, remove: [] });
  }
  if (facts.length === 0 && links.every((l) => l.add.length === 0)) return { ok: true, value: null };
  if (facts.length > 0 && kv.length !== 1 && callerFacts.length === 0 && identity.length === 0) {
    // Only Status would be written and there is no facts property: nothing to do.
    return { ok: true, value: null };
  }
  let plan: FactsPlan;
  try {
    plan = planFacts({
      resourceId: input.pageId,
      sidebar,
      propertyTitle: cc.propertyTitle,
      facts,
      links,
      templateKeys,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) {
      return fail(errorResult({ code: e.code, message: `${input.what}: ${e.message}`, ...e.details }, pd));
    }
    return fail(errorFromThrown(e, pd));
  }
  return {
    ok: true,
    value: {
      plan,
      templateSidebar: sidebar,
      status: writeStatus || (callerStatus && input.status !== null) ? input.status : null,
    },
  };
}

// ============================================================================================ the job

/** One page to create, with what the job does to it besides creating it. */
export interface NewPage extends CreateItem {
  /**
   * Its tags: in the create for a page without a template; a template copy gets them with one updateResource after it
   * (v2 C2c: the full list, the template's own with its status tag replaced, so they are sent whenever they are set).
   */
  readonly tags?: readonly string[];
  /** v2 C2c: the page's lifecycle status, or null (an index). */
  readonly status?: CreateStatus | null;
  readonly aliases?: readonly string[];
  readonly facts: NewPageFactsPlan | null;
  /** For summaries: the parent's name, and the template's. */
  readonly parentName: string;
  readonly templateName: string | null;
}

/** The template sidebars this call read, as the write guard can use them instead of reading again. */
export function prefetchedTemplates(
  cc: CreateCtx,
): { op: string; path: Record<string, string>; body: unknown }[] {
  return [...cc.sidebars.entries()].map(([resourceId, sb]) => ({
    op: 'listProperties',
    path: { resourceId },
    body: { data: sb.map((p) => p.raw) },
  }));
}

export interface CreateJob {
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly operations: Obj[];
  /** Each new page, as results show it. */
  readonly pages: Obj[];
  readonly writes: number;
}

/** Places the pages and builds the ONE job: the creates, each template page's facts after it, then the verify step. */
export function planCreateJob(
  ctx: RepoCtx,
  pages: readonly NewPage[],
  o: { readonly batch: boolean; readonly tool: string },
): Result<{ readonly plan: CreatePlan<NewPage>; readonly job: CreateJob }> {
  const sim = new SiblingSim((parentId) => ctx.tree.children(ctx.projectId, parentId).data);
  let plan: CreatePlan<NewPage>;
  try {
    plan = planCreates(pages, sim, { batch: o.batch });
  } catch (e) {
    if (e instanceof CreatePlanError)
      return fail(errorResult({ code: e.code, message: e.message, ...e.details }, ctx.pd));
    throw e;
  }
  const steps: StepSpec[] = [];
  const labels: string[] = [];
  const targets: VerifyTarget[] = [];
  const operations: Obj[] = [];
  const pagesOut: Obj[] = [];
  const journalOperation = (p: NewPage) => ({ tool: o.tool, page: { id: p.id, name: p.rawName } });
  const afterCreate = (p: NewPage) => {
    if (p.templateId !== null && (p.tags !== undefined || (p.aliases?.length ?? 0) > 0)) {
      steps.push({
        op: 'updateResource',
        params: {
          path: { resourceId: p.id },
          body: {
            ...(p.tags !== undefined ? { tags: [...p.tags] } : {}),
            ...(p.aliases?.length ? { aliases: [...p.aliases] } : {}),
          },
        },
        journalOperation: { ...journalOperation(p), write: 'tags and aliases' },
      });
      labels.push(`tags and aliases of ${p.rawName}`);
    }
    if (p.facts && p.templateId !== null) {
      const nf = expandNewPageFacts({
        plan: p.facts.plan,
        page: { id: p.id, name: p.rawName },
        templateId: p.templateId,
        templateSidebar: p.facts.templateSidebar,
        copyStepNo: steps.length + 1,
        journalOperation: { tool: o.tool },
      });
      nf.steps.forEach((s, i) => {
        steps.push(s);
        labels.push(i === 0 ? 'check' : `${p.rawName}: ${p.facts!.plan.writes[i - 1]?.label ?? s.op}`);
      });
      if (nf.verify) targets.push(nf.verify);
    }
  };
  const body = (p: NewPage, parentId: string, slot: { after?: string; before?: string }) => ({
    id: p.id,
    name: p.rawName,
    parentId,
    ...(p.templateId === null && p.tags !== undefined ? { tags: [...p.tags] } : {}),
    ...(p.templateId === null && p.aliases?.length ? { aliases: [...p.aliases] } : {}),
    ...slot,
  });
  for (const s of plan.steps) {
    if (s.kind === 'template') {
      steps.push({
        op: 'createResourceFromTemplate',
        params: {
          body: {
            templateId: s.item.templateId!,
            id: s.item.id,
            name: s.item.rawName,
            parentId: s.parentId,
            ...s.slot,
          },
        },
        journalOperation: journalOperation(s.item),
        // A page that gets facts in this job is re-read by the tree once, when the job ends.
        ...(s.item.facts && !s.item.facts.plan.empty ? { deferTreeReread: true } : {}),
      });
      labels.push(`create ${s.item.rawName}`);
      afterCreate(s.item);
    } else if (s.kind === 'single') {
      steps.push({
        op: 'createResource',
        params: { body: body(s.item, s.parentId, s.slot) },
        journalOperation: journalOperation(s.item),
      });
      labels.push(`create ${s.item.rawName}`);
    } else {
      steps.push({
        op: 'createManyResources',
        params: { body: { resources: s.items.map((x) => body(x.item, x.parentId, x.slot)) } },
        journalOperation: { tool: o.tool, pages: s.items.length },
      });
      labels.push(
        `create ${s.items.length} page${s.items.length === 1 ? '' : 's'} (${s.items
          .slice(0, 5)
          .map((x) => x.item.rawName)
          .join(', ')}${s.items.length > 5 ? ', …' : ''})`,
      );
    }
  }
  for (const p of pages) {
    const where = plan.placement.get(p.id)!;
    targets.push({
      kind: 'resource',
      label: p.rawName,
      resourceId: p.id,
      fields: {
        name: p.rawName,
        parentId: where.parentId,
        ...(p.tags !== undefined ? { tags: [...p.tags] } : {}),
      },
      placement: { parentId: where.parentId, after: where.after, before: where.before },
    });
    const f = p.facts?.plan;
    const factParts = f && !f.empty ? planWords(f) : [];
    const parts = [
      `under ${p.parentName}`,
      ...(p.templateName ? [`from ${p.templateName}`] : ['no template']),
      ...factParts,
    ];
    operations.push({
      tool: o.tool,
      page: { id: p.id, name: p.rawName },
      isNew: true,
      pageParts: parts,
      summaryLabel: `New page ${p.rawName} under ${p.parentName}${factParts.length ? `: ${factParts.join(', ')}` : ''}`,
      ...(p.templateId ? { templateId: p.templateId } : {}),
      ...(f && !f.empty
        ? {
            facts: f.rowsAfter.map((r) => ({ key: r.key, value: valueOf(r.content) })),
            links: f.links.map((l) => ({ title: l.title, added: l.added.map((a) => a.name) })),
          }
        : {}),
    });
    pagesOut.push({
      id: p.id,
      name: p.rawName,
      parent: { id: where.parentId, name: p.parentName },
      ...(where.after ? { after: where.after } : {}),
      ...(where.before ? { before: where.before } : {}),
      ...(p.templateName ? { template: p.templateName } : {}),
      ...(f && !f.empty
        ? {
            facts: f.rowsAfter
              .filter((r) => valueOf(r.content) !== '')
              .map((r) => ({ key: r.key, value: valueOf(r.content) })),
            ...(f.links.some((l) => l.added.length > 0)
              ? { links: Object.fromEntries(f.links.map((l) => [l.title, l.added.map((a) => a.name)])) }
              : {}),
          }
        : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(p.tags !== undefined ? { tags: [...p.tags] } : {}),
    });
  }
  steps.push({ op: VERIFY_STEP, params: { body: { targets } } });
  labels.push('verify');
  const writes = steps.filter((s) => s.op !== VERIFY_STEP && !s.op.startsWith('bridge.')).length;
  return { ok: true, value: { plan, job: { steps, labels, operations, pages: pagesOut, writes } } };
}

const valueOf = (content: readonly Obj[]) =>
  content
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const m = r.mention && typeof r.mention === 'object' ? (r.mention as Obj) : null;
      if (!m) return '';
      return typeof m.text === 'string' ? m.text : typeof m.resourceId === 'string' ? m.resourceId : '';
    })
    .join('')
    .trim();

function planWords(plan: FactsPlan): string[] {
  const n = plan.facts.filter((f) => f.change === 'added' || f.change === 'changed').length;
  const l = plan.links.reduce((s, x) => s + x.added.length, 0);
  return [...(n ? [`${n} fact${n === 1 ? '' : 's'}`] : []), ...(l ? [`${l} link${l === 1 ? '' : 's'}`] : [])];
}

/** A page made by this request: a minted id, its names, its parent and template. */
export function newPage(o: Omit<NewPage, 'id' | 'displayName' | 'kind'> & { readonly id?: string }): NewPage {
  const c = classifyName(o.rawName);
  return {
    ...o,
    id: o.id ?? mintClientId(),
    displayName: c.displayName,
    kind: c.kind,
  };
}

// ============================================================================================ operation_id and claims

/** What a create tool's planning produced: an answer with no job (a refusal, a dry run, an existing page), or a job. */
export type CreateOutcome =
  | { readonly kind: 'answer'; readonly result: McpToolResult; readonly final?: Obj }
  | ({ readonly kind: 'job'; readonly head: Obj; readonly labels: readonly string[] } & WriteJobOutcome);

export const OPERATION_ID_DESCRIPTION =
  'Optional: your own id for this request (1 to 128 letters, digits, - _ . :). Sending the same id with the same request ' +
  'again returns the earlier result (its job, its outcome, or its proposal) and never creates anything twice; the same id ' +
  'with a different request is refused (OPERATION_ID_REUSED). Use one when you might repeat a call after a time-out.';

/**
 * Runs a create tool's planning and job under its `operation_id` (if any) and its claim (if any): a repeat returns the
 * earlier result, a reused id or an overlapping duplicate is refused before anything is planned or sent, and a call
 * that ends without a job or proposal frees both.
 */
export async function withRequest(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  args: Obj & { readonly operation_id?: string | undefined; readonly dryRun?: boolean | undefined },
  claim: { readonly key: string; readonly label: string } | null,
  run: () => Promise<CreateOutcome>,
): Promise<McpToolResult> {
  const requests = pd.services?.requests;
  const principal = mcpOrigin(mctx, tool).principal!.principalId;
  const opId = args.operation_id;
  const dry = args.dryRun === true;
  if (requests && opId !== undefined && !dry) {
    const hash = requestHash(tool, args);
    const b = requests.begin(pd.project.id, principal, opId, tool, hash);
    if (b.kind === 'reused') {
      return errorResult(
        {
          code: 'OPERATION_ID_REUSED',
          message: `operation_id “${opId}” was already used for a different request (${b.row.tool}); nothing was done. Use a new id for a new request.`,
          operation_id: opId,
        },
        pd,
      );
    }
    if (b.kind === 'in_progress') {
      return errorResult(
        {
          code: 'OPERATION_IN_PROGRESS',
          message: `The first call with operation_id “${opId}” is still being planned; nothing more was done. Call again in a moment for its result.`,
          operation_id: opId,
        },
        pd,
      );
    }
    if (b.kind === 'repeat') return repeatAnswer(pd, b.row, opId);
  }
  const release = () => {
    if (requests && opId !== undefined && !dry) requests.releaseOperation(pd.project.id, principal, opId);
  };
  let token: number | null = null;
  if (requests && claim && !dry) {
    const c = requests.claim(pd.project.id, claim.key, principal, tool, claim.label);
    if (!c.ok) {
      release();
      return errorResult(
        {
          code: 'DUPLICATE_REQUEST',
          message:
            `Another request for ${claim.label} is still under way (${c.holder.jobId ? `job ${c.holder.jobId}` : c.holder.proposalId ? `proposal ${c.holder.proposalId}` : 'being planned'}, by ${c.holder.principalId === principal ? 'this connection' : 'another connection'}); nothing was done. ` +
            'Follow that one instead; once it has finished, asking again returns the page it made.',
          ...(c.holder.jobId ? { jobId: c.holder.jobId } : {}),
          ...(c.holder.proposalId ? { proposalId: c.holder.proposalId } : {}),
          tool: c.holder.tool,
        },
        pd,
      );
    }
    token = c.token;
  }
  let out: CreateOutcome;
  try {
    out = await run();
  } catch (e) {
    release();
    if (requests && claim && token !== null) requests.releaseClaim(pd.project.id, claim.key, token);
    return errorFromThrown(e, pd);
  }
  const ids = out.kind === 'job' ? { jobId: out.jobId, proposalId: out.proposalId } : {};
  if (out.kind === 'job' && (out.jobId || out.proposalId)) {
    if (requests && opId !== undefined && !dry) {
      requests.settle(pd.project.id, principal, opId, {
        ...(out.jobId ? { jobId: out.jobId } : {}),
        ...(out.proposalId ? { proposalId: out.proposalId } : {}),
        result: { body: out.body, head: out.head, labels: out.labels },
      });
    }
    if (requests && claim && token !== null) {
      requests.bind(pd.project.id, claim.key, token, {
        ...(ids.jobId ? { jobId: ids.jobId } : {}),
        ...(ids.proposalId ? { proposalId: ids.proposalId } : {}),
      });
    }
    return out.result;
  }
  if (requests && claim && token !== null) requests.releaseClaim(pd.project.id, claim.key, token);
  if (out.kind === 'answer' && out.final && requests && opId !== undefined && !dry) {
    requests.settle(pd.project.id, principal, opId, { result: { body: out.final } });
  } else release();
  return out.result;
}

/** The answer to an `operation_id` repeat: the earlier job as it stands now, the proposal, or the earlier answer. */
function repeatAnswer(
  pd: ProjectDeps,
  row: { jobId: string | null; proposalId: string | null; result: Obj | null },
  opId: string,
): McpToolResult {
  const stored = (row.result ?? {}) as { body?: Obj; head?: Obj; labels?: string[] };
  const note = {
    repeated: true,
    operation_id: opId,
    note: 'This operation_id was used before with the same request: this is that request’s result. Nothing new was done.',
  };
  if (row.jobId) {
    const view = pd.engine.queries.getJob(pd.project.id, row.jobId);
    if (view) {
      const d = describeJob(pd, view, stored.labels ?? [], { ...(stored.head ?? {}), ...note });
      return d.result;
    }
  }
  if (row.proposalId) {
    const state = pd.services?.requests?.proposalState(pd.project.id, row.proposalId) ?? null;
    return render({ ...(stored.body ?? {}), ...note, ...(state ? { proposalState: state } : {}) }, pd);
  }
  return render({ ...(stored.body ?? {}), ...note }, pd);
}

/** The claim key of a character, by its name: case, stray prefixes and spaces do not count. */
export function characterClaim(name: string): string {
  return `character:${key(cleanPrefixes(name).name)}`;
}
