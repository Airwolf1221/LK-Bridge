/**
 * The Resources tools (v2 C2b, ADR 0034; PLAN-v2 section 5): `create_index`, `create_resource`, `create_bare_resource`,
 * `create_many_resources`, `update_resource`, `move_resource`, `delete_resource` and `restore_resource`.
 * (`create_character` is src/mcp/tools/create-character.ts.)
 *
 * Every one: targets and parents inside the AI REPOSITORY only; a page created or moved gets its alphabetical place in
 * the same write (and a rename re-places it in the same job); nothing else is moved or reclassified; ONE job, or ONE
 * proposal under `propose` (ids minted at capture, a page-level summary first); every guard runs again when the job runs;
 * every write is verified by the shared verify step; `dryRun: true` shows the plan and writes nothing. A page made from
 * a template gets Status `Working` (the project's default) when it has a Status row, and its template is recorded in the
 * tree at once.
 */
import * as z from 'zod';
import {
  assessDelete,
  assessFactChange,
  canonConfigFrom,
  factRows,
  type CanonicalRule,
} from '../../facts/index.js';
import { VERIFY_STEP, type VerifyTarget } from '../../jobs/internal-steps.js';
import type { StepSpec } from '../../jobs/index.js';
import { cleanPrefixes, fillName, key } from '../../registry/names.js';
import { SiblingSim, orderItems } from '../../resources/plan.js';
import {
  BSRC_PREFIX,
  BWRK_PREFIX,
  INDEX_PREFIX,
  KIND_PREFIX,
  classifyName,
  isPageKind,
} from '../../tree/classify.js';
import type { TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import {
  OPERATION_ID_DESCRIPTION,
  STATUS_DESCRIPTION,
  createCtx,
  createMarker,
  lifecycleAreaOf,
  statusValue,
  withStatusTag,
  workingIndex,
  type CreateStatus,
  namePatternOf,
  newPage,
  planCreateJob,
  planNewPageFacts,
  prefetchedTemplates,
  resolveParent,
  resolveTemplate,
  withRequest,
  type CreateCtx,
  type CreateOutcome,
  type NewPage,
} from './create-support.js';
import { defineTool } from './define.js';
import { finish, liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { factValue, linkRef, pageRef } from './set-facts.js';
import { errorResult, projectArg, render, withProject, type ProjectDeps, type ToolDeps } from './shape.js';
import { runWriteJob } from './write-job.js';

export const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export const CHANGE_ANNOTATIONS = { ...CREATE_ANNOTATIONS, destructiveHint: true } as const;

type Obj = Record<string, unknown>;

export const operationIdArg = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/, '1 to 128 letters, digits, - _ . or :')
  .optional()
  .describe(OPERATION_ID_DESCRIPTION);
export const factsArg = z
  .record(z.string().min(1).max(256), factValue)
  .optional()
  .describe('Facts for the new page: key → plain text, { "markdown": "…" } or null (as in set_facts).');
export const linksArg = z
  .record(z.string().min(1).max(256), z.object({ add: z.array(linkRef).max(256) }).strict())
  .optional()
  .describe('Collection title → { add: [page names or ids, or { page, document }] } (as in set_facts).');
const dryRunArg = z
  .boolean()
  .optional()
  .describe('Show the plan (pages, names, parents, places, facts, canon); write nothing.');
const tagsArg = z.array(z.string().trim().min(1).max(100)).max(50).optional();
const aliasesArg = z.array(z.string().trim().min(1).max(256)).max(128).optional();

const COSTS_CREATE =
  'Cost: 1 read of the template’s sidebar (once per template), 1 write to create, 1 read to check the copy and 1 write per ' +
  'fact (Status included) when it has facts, then the verify step: 1 read per page, 1 listing of the parent’s children (per ' +
  '100) and the tree’s re-read. A dry run: the template read only.';

// ============================================================================================ shared

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A sibling under `parentId` with the same kind and name, among the tree's pages (null when there is none). v2 C2c: the
 * page kinds (`[BSRC]`, `[BWRK]`, `[BARC]`) share one name space, as name handling treats them alike.
 */
function sibling(
  ctx: RepoCtx,
  parentId: string,
  kind: string,
  displayName: string,
  except?: string,
): TreeNode | null {
  const k = key(displayName);
  const same = (c: TreeNode) => c.kind === kind || (isPageKind(kind) && isPageKind(c.kind));
  return (
    ctx.tree
      .children(ctx.projectId, parentId)
      .data.find((c) => c.id !== except && same(c) && key(c.displayName) === k) ?? null
  );
}

/**
 * v2 C2c: where a new page of this status goes: a Working page directly under `[INDEX] Working` (a given parent must be
 * it, or for `allowCharacterIndex` a character index directly under it); an Authoritative page under the given parent,
 * which must not be in a lifecycle area.
 */
function parentForStatus(
  cc: CreateCtx,
  status: CreateStatus,
  given: string | undefined,
  o: { readonly allowCharacterIndex?: boolean; readonly what?: string } = {},
): { ok: true; value: TreeNode } | { ok: false; result: McpToolResult } {
  const { pd, ctx } = cc;
  if (status === 'working') {
    const wi = workingIndex(cc);
    if (!wi.ok) return wi;
    if (given === undefined) return { ok: true, value: wi.value };
    const r = resolveParent(ctx, given, o.what ? { what: o.what } : {});
    if (!r.ok) return r;
    const underWorking =
      r.value.id === wi.value.id ||
      (o.allowCharacterIndex === true && r.value.kind === 'index' && r.value.parentId === wi.value.id);
    if (!underWorking) {
      return {
        ok: false,
        result: errorResult(
          {
            code: 'WORKING_PARENT',
            message: `A Working page goes directly under ${wi.value.rawName}${o.allowCharacterIndex ? ' (or a character index directly under it)' : ''}, flat and alphabetical; “${r.value.displayName}” is not. Leave parent out, or pass status "authoritative" to place it there (a canonical proposal). It goes to its normal place when it is promoted.`,
            workingIndex: { id: wi.value.id, name: wi.value.rawName },
          },
          pd,
        ),
      };
    }
    return { ok: true, value: r.value };
  }
  if (given === undefined) {
    return {
      ok: false,
      result: errorResult(
        { code: 'INVALID_PARAMS', message: 'An Authoritative page needs `parent`: the index it goes under.' },
        pd,
      ),
    };
  }
  const r = resolveParent(ctx, given, o.what ? { what: o.what } : {});
  if (!r.ok) return r;
  const area = lifecycleAreaOf(cc, r.value);
  if (area !== null) {
    return {
      ok: false,
      result: errorResult(
        {
          code: 'LIFECYCLE_AREA',
          message: `“${r.value.displayName}” is ${area === 'working' ? `[INDEX] ${cc.lifecycle.indexNames.working}` : `[INDEX] ${cc.lifecycle.indexNames.archived}`} or under it; an Authoritative page goes in its normal place. ${area === 'working' ? 'Create it as Working (leave status out) instead.' : 'Pages are archived only with archive_page.'}`,
        },
        pd,
      ),
    };
  }
  return { ok: true, value: r.value };
}

const statusArg = z.enum(['working', 'authoritative']).optional().describe(STATUS_DESCRIPTION);

const nodeView = (n: TreeNode) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') });

/** The canonical rules of the call's project. */
function canonRules(pd: ProjectDeps, projectId: string): readonly CanonicalRule[] {
  return canonConfigFrom(pd.services?.projectSettings?.(projectId)).active;
}

/**
 * The end of every create: the job planned, a dry run answered (with the canon assessment), or the job submitted.
 * `extraHead` goes first in every answer.
 */
export async function finishCreate(
  cc: CreateCtx,
  pages: readonly NewPage[],
  o: {
    readonly batch: boolean;
    readonly dryRun: boolean;
    readonly extraHead?: Obj;
    readonly summary: string;
    /** v2 C2c: pages besides those with a status that the job places in a lifecycle area (a Working character's index). */
    readonly markerPages?: readonly { readonly id: string; readonly to: null }[];
  },
): Promise<CreateOutcome> {
  const { pd, mctx, ctx, tool } = cc;
  const planned = planCreateJob(ctx, pages, { batch: o.batch, tool });
  if (!planned.ok) return { kind: 'answer', result: planned.result };
  const { job } = planned.value;
  const rules = canonRules(pd, ctx.projectId);
  // v2 C2c: the job declares the lifecycle state it gives each page; an Authoritative page is canon.
  const marker = createMarker(tool, [
    ...pages.filter((p) => p.status).map((p) => ({ id: p.id, to: p.status! })),
    ...(o.markerPages ?? []),
  ]);
  const canon = [
    ...pages.flatMap((p) =>
      p.facts
        ? assessFactChange(rules, [], factRows(p.facts.plan.sidebarAfter)).map(
            (c) => `${p.rawName}: ${c.text}`,
          )
        : [],
    ),
    ...pages
      .filter((p) => p.status === 'authoritative' && !p.facts?.status)
      .map((p) => `${p.rawName}: a new Authoritative page (canon)`),
  ];
  const head: Obj = {
    ...(o.extraHead ?? {}),
    pages: job.pages,
    writes: job.writes,
  };
  const preview = () => ({ pages: job.pages.length, summary: o.summary });
  if (o.dryRun) {
    const body = {
      ...head,
      status: 'dry_run',
      steps: job.labels.filter((l) => l !== 'check' && l !== 'verify'),
      ...(canon.length > 0 ? { requiresCanonicalApproval: true, protectedChanges: canon } : {}),
      message:
        canon.length > 0
          ? 'Dry run: nothing was written. This touches protected canon, so it would become a proposal only the owner can accept as canon.'
          : 'Dry run: nothing was written and nothing was proposed.',
    };
    return { kind: 'answer', result: finish(pd, mctx, tool, body, preview) };
  }
  const out = await runWriteJob(pd, mctx, tool, {
    steps: job.steps,
    labels: job.labels,
    title: o.summary,
    ...(marker ? { lifecycle: marker } : {}),
    proposal: { operations: job.operations, summary: o.summary, prefetched: prefetchedTemplates(cc) },
    head,
    preview,
  });
  return { kind: 'job', head, labels: job.labels, ...out };
}

const refusal = (pd: ProjectDeps, code: string, message: string, more: Obj = {}): CreateOutcome => ({
  kind: 'answer',
  result: errorResult({ code, message, ...more }, pd),
});

/** A display name from an agent: stray prefixes removed, 1 to 200 characters. */
function cleanName(name: string): string | null {
  const n = cleanPrefixes(name).name.replace(/\s+/g, ' ').trim();
  return n === '' || n.length > 200 ? null : n;
}

// ============================================================================================ create_index

function createIndexTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_index',
    title: 'Create an index',
    access: 'write',
    description:
      'Creates an [INDEX] page from its type’s Index template, under a parent index inside the AI REPOSITORY, in its ' +
      'alphabetical place. The type (for example Character) and category (for example a race such as Foxians) come from the ' +
      'type registry and taxonomy: give `parent`, or `type` and `category` (the category’s index is then the parent), or ' +
      'both. An unknown type or category is refused with the known ones; an index of the same name under the same parent is ' +
      'refused. An index takes no status and gets no Status fact (v2 C2c: indexes have no lifecycle). Indexes are never ' +
      'made under [INDEX] Working or [INDEX] Archived (flat). Characters’ own indexes are made by create_character. ' +
      '`dryRun: true` shows the plan. ' +
      COSTS_CREATE,
    inputSchema: z.object({
      name: z.string().min(1).max(500).describe('The index’s name, without [INDEX] (added).'),
      parent: pageRef.optional().describe('The parent index (name or id).'),
      type: z.string().min(1).max(100).optional().describe('The type (singular or plural), e.g. Character.'),
      category: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('A taxonomy category of the type, e.g. Foxians.'),
      dryRun: dryRunArg,
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, 'create_index', args, null, async () => {
          const name = cleanName(args.name);
          if (!name) return refusal(pd, 'INVALID_PARAMS', 'An index name (1 to 200 characters) is required.');
          const store = ctx.types.store;
          const types = store.listTypes();
          const known = types.map((t) => t.singular);
          let type = args.type !== undefined ? store.typeByName(args.type) : undefined;
          if (args.type !== undefined && !type) {
            return refusal(
              pd,
              'UNKNOWN_TYPE',
              `No type named “${args.type}”. Types: ${known.join(', ') || 'none yet'}.`,
              {
                types: known,
              },
            );
          }
          // The category: a taxonomy entry of the type (or of the one type that has it).
          let categoryNode: TreeNode | null = null;
          if (args.category !== undefined) {
            const k = key(cleanPrefixes(args.category).name);
            const pool = type ? [type] : types;
            const hits = pool.flatMap((t) =>
              store
                .entries(t.id)
                .filter(
                  (e) => key(e.plural) === k || key(e.singular) === k || e.aliases.some((a) => key(a) === k),
                )
                .map((e) => ({ t, e })),
            );
            if (hits.length !== 1) {
              const labels = pool.flatMap((t) => store.entries(t.id).map((e) => e.plural));
              return refusal(
                pd,
                hits.length === 0 ? 'UNKNOWN_CATEGORY' : 'CATEGORY_AMBIGUOUS',
                hits.length === 0
                  ? `No category “${args.category}”${type ? ` of ${type.plural}` : ''}. Categories: ${labels.join(', ') || 'none (seed the taxonomy first)'}.`
                  : `“${args.category}” is a category of ${hits.length} types; name the type.`,
                { categories: labels.slice(0, 200) },
              );
            }
            type = hits[0]!.t;
            categoryNode = ctx.tree.node(ctx.projectId, hits[0]!.e.sourceNodeId).data;
            if (!categoryNode) {
              return refusal(
                pd,
                'CATEGORY_SOURCE_MISSING',
                `The index of the category “${hits[0]!.e.plural}” is no longer in the tree.`,
              );
            }
          }
          let parent: TreeNode;
          if (args.parent !== undefined) {
            const r = resolveParent(ctx, args.parent);
            if (!r.ok) return { kind: 'answer', result: r.result };
            parent = r.value;
            if (categoryNode && parent.id !== categoryNode.id && !parent.path.ids.includes(categoryNode.id)) {
              return refusal(
                pd,
                'CATEGORY_MISMATCH',
                `“${parent.displayName}” is not the index of the category “${categoryNode.displayName}” or under it.`,
              );
            }
          } else if (categoryNode) parent = categoryNode;
          else if (type?.rootIndexId) {
            const root = ctx.tree.node(ctx.projectId, type.rootIndexId).data;
            if (!root)
              return refusal(
                pd,
                'TYPE_ROOT_MISSING',
                `The type ${type.singular} has no root index in the tree.`,
              );
            parent = root;
          } else {
            return refusal(
              pd,
              'INVALID_PARAMS',
              'Give parent, or type and category (or type alone for its root index).',
            );
          }
          // The type: given, or the one whose root index holds the parent (the nearest).
          if (!type) {
            const owners = types
              .filter(
                (t) =>
                  t.rootIndexId && (parent.id === t.rootIndexId || parent.path.ids.includes(t.rootIndexId)),
              )
              .sort(
                (a, b) => parent.path.ids.indexOf(b.rootIndexId!) - parent.path.ids.indexOf(a.rootIndexId!),
              );
            type = owners[0];
            if (!type) {
              return refusal(
                pd,
                'UNKNOWN_TYPE',
                `“${parent.displayName}” is under no type’s root index, so the bridge does not know which Index template to use. Name a type: ${known.join(', ') || 'none yet'}.`,
                { types: known },
              );
            }
          } else if (
            type.rootIndexId &&
            parent.id !== type.rootIndexId &&
            !parent.path.ids.includes(type.rootIndexId)
          ) {
            return refusal(
              pd,
              'TYPE_MISMATCH',
              `“${parent.displayName}” is not under the ${type.plural} index.`,
            );
          }
          if (!type.indexTemplateId) {
            return refusal(
              pd,
              'TEMPLATE_NOT_CONFIGURED',
              `The type ${type.singular} has no Index template; the owner sets it on the Repository Mappings page.`,
            );
          }
          const twin = sibling(ctx, parent.id, 'index', name);
          if (twin) {
            return refusal(
              pd,
              'INDEX_EXISTS',
              `“${parent.displayName}” already has an index named “${twin.displayName}”.`,
              {
                existing: nodeView(twin),
              },
            );
          }
          const cc = createCtx(pd, mctx, ctx, 'create_index');
          // v2 C2c: [INDEX] Working and [INDEX] Archived are flat: no index is made under either (a Working
          // character's own index is create_character's).
          const area = lifecycleAreaOf(cc, parent);
          if (area !== null) {
            return refusal(
              pd,
              'LIFECYCLE_AREA',
              `“${parent.displayName}” is [INDEX] ${area === 'working' ? cc.lifecycle.indexNames.working : cc.lifecycle.indexNames.archived} or under it: those indexes are flat, so no index is made there (a Working character’s own index is made by create_character).`,
            );
          }
          const id = newPage({
            key: 'index',
            rawName: `${INDEX_PREFIX}${name}`,
            parent: { existing: parent.id },
            templateId: type.indexTemplateId,
            facts: null,
            parentName: parent.rawName,
            templateName: `the ${type.singular} Index template`,
          });
          const facts = await planNewPageFacts(cc, {
            pageId: id.id,
            pageName: id.rawName,
            templateId: type.indexTemplateId,
            status: null,
            what: id.rawName,
          });
          if (!facts.ok) return { kind: 'answer', result: facts.result };
          return finishCreate(cc, [{ ...id, facts: facts.value }], {
            batch: false,
            dryRun: args.dryRun === true,
            extraHead: {
              type: type.singular,
              ...(categoryNode ? { category: categoryNode.displayName } : {}),
            },
            summary: `create_index: ${id.rawName} under ${parent.rawName}`,
          });
        });
      }),
  });
}

// ============================================================================================ create_resource

/** A template for a [BSRC] page made by create_resource (or a create_many item): not a character page's. */
function pageTemplateCheck(
  pd: ProjectDeps,
  t: Awaited<ReturnType<typeof resolveTemplate>>,
): CreateOutcome | null {
  if (!t.ok) return { kind: 'answer', result: t.result };
  const ch = t.value.roles.find(
    (r) => r.type.placementKind === 'character' && (r.role === 'core' || r.role === 'compact'),
  );
  if (ch) {
    return refusal(
      pd,
      'CHARACTER_TEMPLATE',
      `The template ${t.value.name ?? t.value.id} makes ${ch.type.plural} pages, which follow the character rules (index, race, an existing page returned): use create_character.`,
    );
  }
  return null;
}

function createResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_resource',
    title: 'Create a page from a template',
    access: 'write',
    description:
      'Creates a page from a template (required: name or id; see list_templates) inside the AI REPOSITORY, in its ' +
      'alphabetical place. `status` (default "working"): a [BWRK] page directly under [INDEX] Working with Status Working ' +
      'and the Working tag (leave `parent` out); or "authoritative": a [BSRC] page under `parent` with Status ' +
      'Authoritative and the CANON tag, which is canon and always becomes a proposal only the owner can accept as canon. ' +
      'The page’s name follows the template role’s pattern. Optional `facts` and `links` as in set_facts are written in ' +
      'the same job, in template order (Status comes from `status`). A page of the same name under the same parent is ' +
      'refused. Character pages: use create_character. Example: { "name": "The Hollow Court", "template": "[BSRC] AI ' +
      'General Source", "facts": { "Scope": "A court of the Foxians" }, "project": "test" }. ' +
      COSTS_CREATE,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(500)
        .describe('The page’s name, without [BSRC] (the template’s pattern is applied).'),
      template: z.string().min(1).max(500).describe('The template, by name or id.'),
      parent: pageRef
        .optional()
        .describe(
          'The index it goes under (name or id). Required for an Authoritative page; a Working page goes under [INDEX] Working.',
        ),
      status: statusArg,
      facts: factsArg,
      links: linksArg,
      tags: tagsArg,
      aliases: aliasesArg,
      dryRun: dryRunArg,
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, 'create_resource', args, null, async () => {
          const name = cleanName(args.name);
          if (!name) return refusal(pd, 'INVALID_PARAMS', 'A page name (1 to 200 characters) is required.');
          const cc = createCtx(pd, mctx, ctx, 'create_resource');
          const status: CreateStatus = args.status ?? 'working';
          const parent = parentForStatus(cc, status, args.parent);
          if (!parent.ok) return { kind: 'answer', result: parent.result };
          const t = await resolveTemplate(pd, mctx, ctx, 'create_resource', args.template);
          const bad = pageTemplateCheck(pd, t);
          if (bad) return bad;
          const tpl = (t as Extract<typeof t, { ok: true }>).value;
          if (tpl.kind === 'index') {
            return refusal(
              pd,
              'INDEX_TEMPLATE',
              `${tpl.name ?? tpl.id} makes an [INDEX] page: use create_index.`,
            );
          }
          const display = fillName(namePatternOf(tpl), name);
          const twin = sibling(ctx, parent.value.id, 'bsrc', display);
          if (twin) {
            return refusal(
              pd,
              'PAGE_EXISTS',
              `“${parent.value.displayName}” already has a page named “${twin.displayName}”.`,
              {
                existing: nodeView(twin),
              },
            );
          }
          const page = newPage({
            key: 'page',
            rawName: `${status === 'working' ? BWRK_PREFIX : BSRC_PREFIX}${display}`,
            parent: { existing: parent.value.id },
            templateId: tpl.id,
            facts: null,
            parentName: parent.value.rawName,
            templateName: tpl.name ?? tpl.id,
            status,
            ...(args.aliases ? { aliases: args.aliases } : {}),
          });
          const facts = await planNewPageFacts(cc, {
            pageId: page.id,
            pageName: page.rawName,
            templateId: tpl.id,
            ...(args.facts ? { facts: args.facts } : {}),
            ...(args.links ? { links: args.links } : {}),
            status: statusValue(cc.lifecycle, status),
            what: page.rawName,
          });
          if (!facts.ok) return { kind: 'answer', result: facts.result };
          // v2 C2c: the template's tags with its status tag replaced, and the caller's.
          const tags = withStatusTag(
            cc.lifecycle,
            [...(cc.templateTags.get(tpl.id) ?? []), ...(args.tags ?? [])],
            status,
          );
          return finishCreate(cc, [{ ...page, facts: facts.value, tags }], {
            batch: false,
            dryRun: args.dryRun === true,
            extraHead: { status },
            summary: `create_resource: ${page.rawName} under ${parent.value.rawName}`,
          });
        });
      }),
  });
}

// ============================================================================================ create_bare_resource

/**
 * A name with its prefix, by the registry's rule: exactly `[INDEX] `, or (a page) `[BSRC] ` or `[BWRK] `, then a name.
 * v2 C2c: a page's prefix then follows its status (`[BWRK]` Working, `[BSRC]` Authoritative); `[BWRK]` with status
 * authoritative is a contradiction, and `[BARC]` is refused (only archive_page archives).
 */
function bareName(
  raw: string,
  status: CreateStatus | undefined,
):
  | { rawName: string; displayName: string; kind: 'index' | 'bsrc' | 'bwrk'; status: CreateStatus | null }
  | string {
  const trimmed = raw.trim();
  const c = classifyName(trimmed);
  if (c.kind === 'unclassified') {
    return `“${trimmed}” has no valid prefix: a name starts with exactly “[INDEX] ”, or for a page “[BSRC] ” or “[BWRK] ” (capitals, one space).`;
  }
  if (c.kind === 'barc')
    return `“${trimmed}”: a page is archived only with archive_page, never created as [BARC].`;
  const display = c.displayName.replace(/\s+/g, ' ').trim();
  if (display === '' || display.length > 200)
    return 'A name (1 to 200 characters) is required after the prefix.';
  if (cleanPrefixes(display).prefix !== null) return `“${trimmed}” has its prefix twice.`;
  if (c.kind === 'index') {
    if (status !== undefined) return `“${trimmed}” is an index: an index takes no status.`;
    return { rawName: `${INDEX_PREFIX}${display}`, displayName: display, kind: 'index', status: null };
  }
  if (c.kind === 'bwrk' && status === 'authoritative') {
    return `“${trimmed}” is named as a Working page but status is "authoritative": give it as “[BSRC] ${display}”.`;
  }
  const st: CreateStatus = status ?? 'working';
  return {
    rawName: `${st === 'working' ? BWRK_PREFIX : BSRC_PREFIX}${display}`,
    displayName: display,
    kind: st === 'working' ? 'bwrk' : 'bsrc',
    status: st,
  };
}

function createBareResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_bare_resource',
    title: 'Create a page without a template',
    access: 'write',
    description:
      'Creates a page with no template (no sidebar facts) inside the AI REPOSITORY, in its alphabetical place. The name ' +
      'starts with exactly “[INDEX] ” (an index, under `parent`; no status), or for a page “[BSRC] ” or “[BWRK] ”: a ' +
      'page’s prefix follows `status` (default "working": [BWRK] directly under [INDEX] Working with the Working tag; ' +
      '"authoritative": [BSRC] under `parent` with the CANON tag, a canonical proposal). Anything else is refused, and ' +
      '[BARC] too (only archive_page archives). A page of the same kind and name under the same parent is refused. ' +
      'Prefer create_resource (a template gives the page its sidebar). Cost: 1 write, then the verify step (1 read, 1 ' +
      'listing of the parent’s children per 100) and the tree’s re-read.',
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(500)
        .describe('The full name, with its prefix: “[INDEX] …”, or “[BSRC] …” / “[BWRK] …” for a page.'),
      parent: pageRef
        .optional()
        .describe('The index it goes under (name or id). A Working page goes under [INDEX] Working.'),
      status: statusArg,
      tags: tagsArg,
      aliases: aliasesArg,
      dryRun: dryRunArg,
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, 'create_bare_resource', args, null, async () => {
          const n = bareName(args.name, args.status);
          if (typeof n === 'string') return refusal(pd, 'INVALID_NAME', n);
          const cc = createCtx(pd, mctx, ctx, 'create_bare_resource');
          let parent: { ok: true; value: TreeNode } | { ok: false; result: McpToolResult };
          if (n.status !== null) parent = parentForStatus(cc, n.status, args.parent);
          else if (args.parent === undefined)
            return refusal(pd, 'INVALID_PARAMS', 'An index needs `parent`: the index it goes under.');
          else {
            parent = resolveParent(ctx, args.parent);
            if (parent.ok && lifecycleAreaOf(cc, parent.value) !== null) {
              return refusal(
                pd,
                'LIFECYCLE_AREA',
                `“${parent.value.displayName}” is a lifecycle index or under one: those are flat, so no index is made there.`,
              );
            }
          }
          if (!parent.ok) return { kind: 'answer', result: parent.result };
          const twin = sibling(ctx, parent.value.id, n.kind, n.displayName);
          if (twin) {
            return refusal(
              pd,
              'PAGE_EXISTS',
              `“${parent.value.displayName}” already has “${twin.rawName}”.`,
              {
                existing: nodeView(twin),
              },
            );
          }
          const tags = n.status !== null ? withStatusTag(cc.lifecycle, args.tags ?? [], n.status) : args.tags;
          const page = newPage({
            key: 'page',
            rawName: n.rawName,
            parent: { existing: parent.value.id },
            templateId: null,
            facts: null,
            parentName: parent.value.rawName,
            templateName: null,
            status: n.status,
            ...(tags ? { tags } : {}),
            ...(args.aliases ? { aliases: args.aliases } : {}),
          });
          return finishCreate(cc, [page], {
            batch: false,
            dryRun: args.dryRun === true,
            ...(n.status ? { extraHead: { status: n.status } } : {}),
            summary: `create_bare_resource: ${page.rawName} under ${parent.value.rawName}`,
          });
        });
      }),
  });
}

// ============================================================================================ create_many_resources

const manyItem = z
  .object({
    key: z
      .string()
      .min(1)
      .max(100)
      .describe('Your key for this item (unique in the request), for parent_key.'),
    name: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'With a template: the name without prefix. Without one: the full name with “[INDEX] ”, or “[BSRC] ” / “[BWRK] ” for a page.',
      ),
    parent: pageRef
      .optional()
      .describe(
        'An existing index (name or id). Give parent or parent_key; a Working page may leave both out ([INDEX] Working).',
      ),
    parent_key: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('The key of an earlier or later item of this request.'),
    template: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('A template (name or id); none makes a bare page.'),
    status: z
      .enum(['working', 'authoritative'])
      .optional()
      .describe(
        'A page’s status (default "working": [BWRK] under [INDEX] Working or a character index directly under it; "authoritative": [BSRC] in its normal place, canon). Indexes take none.',
      ),
    facts: factsArg,
    links: linksArg,
    tags: tagsArg,
    aliases: aliasesArg,
  })
  .strict();

function createManyResourcesTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_many_resources',
    title: 'Create up to 100 pages',
    access: 'write',
    description:
      'Creates up to 100 pages in ONE request, nested with `key` and `parent_key` (a parent made in the same request works), ' +
      'each in its alphabetical place. Each item follows the single-create rules: with a `template`, as create_resource (name ' +
      'pattern, facts, links); without, as create_bare_resource (name with its prefix). Each page item has a `status` ' +
      '(default "working": a [BWRK] page under [INDEX] Working, or a character index directly under it; never under another ' +
      'item, as Working pages are flat; "authoritative": a [BSRC] page in its normal place, canon); mixed batches are fine, ' +
      'and a batch with any Authoritative page is one canonical proposal. Indexes take no status and are never made under ' +
      '[INDEX] Working or [INDEX] Archived. Pages without a ' +
      'template go in createManyResources calls (one write for many); each page from a template is its own write. Under ' +
      '`propose`, the whole batch is ONE proposal. A bad parent_key, a loop, or more than 100 items is refused before ' +
      'anything is sent. Character pages: use create_character. Cost: 1 read per distinct template; 1 write per template ' +
      'page (plus 1 read and 1 write per fact), 1 write per run of pages without one; the verify step reads each page once ' +
      'and lists each parent’s children.',
    inputSchema: z.object({
      items: z.array(manyItem).min(1).max(100, 'At most 100 items in one request.'),
      dryRun: dryRunArg,
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, 'create_many_resources', args, null, async () => {
          // 1. Keys and parents, before any read: a bad parent_key or a loop is refused for nothing.
          for (const it of args.items) {
            if (it.parent !== undefined && it.parent_key !== undefined) {
              return refusal(pd, 'INVALID_ITEMS', `Item “${it.key}”: give parent or parent_key, not both.`, {
                key: it.key,
              });
            }
          }
          try {
            orderItems(
              args.items.map((it) => ({
                key: it.key,
                id: it.key,
                rawName: it.name,
                displayName: it.name,
                kind: 'bsrc' as const,
                parent: it.parent_key !== undefined ? { item: it.parent_key } : { existing: '?' },
                templateId: null,
              })),
            );
          } catch (e) {
            const err = e as { code?: string; message?: string; details?: Obj };
            return refusal(pd, err.code ?? 'INVALID_ITEMS', err.message ?? String(e), err.details ?? {});
          }
          const cc = createCtx(pd, mctx, ctx, 'create_many_resources');
          const pages: NewPage[] = [];
          const parents = new Map<string, TreeNode>();
          const itemStatus = new Map<string, CreateStatus | null>();
          for (const it of args.items) {
            let parentName = '';
            let rawName: string;
            let templateId: string | null = null;
            let templateName: string | null = null;
            let status: CreateStatus | null;
            if (it.template !== undefined) {
              const t = await resolveTemplate(pd, mctx, ctx, 'create_many_resources', it.template);
              const bad = pageTemplateCheck(pd, t);
              if (bad) return bad;
              const tpl = (t as Extract<typeof t, { ok: true }>).value;
              const name = cleanName(it.name);
              if (!name) return refusal(pd, 'INVALID_ITEMS', `Item “${it.key}”: a name is required.`);
              if (tpl.kind === 'index' && it.status !== undefined) {
                return refusal(pd, 'INVALID_ITEMS', `Item “${it.key}”: an index takes no status.`, {
                  key: it.key,
                });
              }
              status = tpl.kind === 'index' ? null : (it.status ?? 'working');
              const display = fillName(namePatternOf(tpl), name);
              rawName = `${tpl.kind === 'index' ? INDEX_PREFIX : status === 'working' ? BWRK_PREFIX : BSRC_PREFIX}${display}`;
              templateId = tpl.id;
              templateName = tpl.name ?? tpl.id;
            } else {
              if (it.facts || it.links) {
                return refusal(
                  pd,
                  'INVALID_ITEMS',
                  `Item “${it.key}”: a page without a template has no facts or links to set.`,
                );
              }
              const n = bareName(it.name, it.status);
              if (typeof n === 'string')
                return refusal(pd, 'INVALID_NAME', `Item “${it.key}”: ${n}`, { key: it.key });
              rawName = n.rawName;
              status = n.status;
            }
            itemStatus.set(it.key, status);
            // v2 C2c: the parent by the item's status. A Working page goes directly under [INDEX] Working (or a
            // character index directly under it), never under another item (flat); an index or an Authoritative page
            // never under a lifecycle index.
            const what = `item “${it.key}”’s parent “${it.parent ?? ''}”`;
            if (status === 'working' && it.parent_key !== undefined) {
              return refusal(
                pd,
                'WORKING_PARENT',
                `Item “${it.key}”: a Working page goes directly under [INDEX] ${cc.lifecycle.indexNames.working} (or a character index directly under it), never under another item of the request: Working pages are flat.`,
                { key: it.key },
              );
            }
            if (it.parent_key === undefined) {
              let p: { ok: true; value: TreeNode } | { ok: false; result: McpToolResult };
              if (status !== null) {
                p = parentForStatus(cc, status, it.parent, { allowCharacterIndex: true, what });
              } else if (it.parent === undefined) {
                return refusal(
                  pd,
                  'INVALID_ITEMS',
                  `Item “${it.key}”: an index needs parent or parent_key.`,
                  {
                    key: it.key,
                  },
                );
              } else {
                p = resolveParent(ctx, it.parent, { what });
                if (p.ok && lifecycleAreaOf(cc, p.value) !== null) {
                  return refusal(
                    pd,
                    'LIFECYCLE_AREA',
                    `Item “${it.key}”: “${p.value.displayName}” is a lifecycle index or under one; those are flat, so no index is made there.`,
                    { key: it.key },
                  );
                }
              }
              if (!p.ok) return { kind: 'answer', result: p.result };
              parents.set(it.key, p.value);
              parentName = p.value.rawName;
            }
            const tags =
              status === null
                ? it.tags
                : templateId === null
                  ? withStatusTag(cc.lifecycle, it.tags ?? [], status)
                  : undefined; // a template page's tags need its template's: set below, with its facts
            pages.push(
              newPage({
                key: it.key,
                rawName,
                parent:
                  it.parent_key !== undefined
                    ? { item: it.parent_key }
                    : { existing: parents.get(it.key)!.id },
                templateId,
                facts: null,
                parentName,
                templateName,
                status,
                ...(tags ? { tags } : {}),
                ...(it.aliases ? { aliases: it.aliases } : {}),
              }),
            );
          }
          // v2 C2c: nothing goes under a Working item (flat).
          for (const p of pages) {
            if ('item' in p.parent && itemStatus.get(p.parent.item) === 'working') {
              return refusal(
                pd,
                'WORKING_PARENT',
                `Item “${p.key}” is under item “${p.parent.item}”, a Working page: Working pages are flat, so nothing goes under one.`,
                { key: p.key },
              );
            }
          }
          const byKey = new Map(pages.map((p) => [p.key, p]));
          // Parent names for items under another item, and names taken twice under one parent.
          const seen = new Map<string, string>();
          for (const p of pages) {
            const parentKey = 'item' in p.parent ? `item:${p.parent.item}` : `node:${p.parent.existing}`;
            const named = `${parentKey}|${isPageKind(p.kind) ? 'page' : p.kind}|${key(p.displayName)}`;
            if (seen.has(named)) {
              return refusal(
                pd,
                'INVALID_ITEMS',
                `Items “${seen.get(named)}” and “${p.key}” would be two “${p.rawName}” under one parent.`,
              );
            }
            seen.set(named, p.key);
            if ('existing' in p.parent) {
              const twin = sibling(ctx, p.parent.existing, p.kind, p.displayName);
              if (twin) {
                return refusal(
                  pd,
                  'PAGE_EXISTS',
                  `Item “${p.key}”: “${twin.rawName}” already exists there.`,
                  {
                    key: p.key,
                    existing: nodeView(twin),
                  },
                );
              }
            }
          }
          const named = pages.map((p) =>
            'item' in p.parent ? { ...p, parentName: byKey.get(p.parent.item)!.rawName } : p,
          );
          // 2. Facts of the template pages (one read per template), Status Working where the template has a Status row.
          const withFacts: NewPage[] = [];
          for (const p of named) {
            const it = args.items.find((x) => x.key === p.key)!;
            if (p.templateId === null) {
              withFacts.push(p);
              continue;
            }
            const f = await planNewPageFacts(cc, {
              pageId: p.id,
              pageName: p.rawName,
              templateId: p.templateId,
              ...(it.facts ? { facts: it.facts } : {}),
              ...(it.links ? { links: it.links } : {}),
              status: p.status ? statusValue(cc.lifecycle, p.status) : null,
              what: `Item “${p.key}” (${p.rawName})`,
            });
            if (!f.ok) return { kind: 'answer', result: f.result };
            const tags = p.status
              ? withStatusTag(
                  cc.lifecycle,
                  [...(cc.templateTags.get(p.templateId) ?? []), ...(it.tags ?? [])],
                  p.status,
                )
              : p.tags;
            withFacts.push({ ...p, facts: f.value, ...(tags ? { tags } : {}) });
          }
          return finishCreate(cc, withFacts, {
            batch: true,
            dryRun: args.dryRun === true,
            summary: `create_many_resources: ${plural(withFacts.length, 'page')} (${withFacts
              .slice(0, 3)
              .map((p) => p.rawName)
              .join(', ')}${withFacts.length > 3 ? ', …' : ''})`,
          });
        });
      }),
  });
}

// ============================================================================================ update_resource

const editList = z
  .object({
    add: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
    remove: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  })
  .strict();

function updateResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'update_resource',
    title: 'Change a page’s name, tags and settings',
    access: 'write',
    description:
      'Changes a page inside the AI REPOSITORY: `name` (the [INDEX] or [BSRC] prefix is kept; the page is re-placed in its ' +
      'alphabetical place among its siblings in the same job; a name a sibling already has is refused), `tags` and ' +
      '`aliases` ({ add, remove }), `icon` ({ glyph, color, shape, size }), `banner` ({ url, yPosition, enabled }), `hidden` ' +
      'and `locked`. Facts and links: set_facts; page text: write_page. Cost: 1 read, 1 write (plus 1 to re-place after a ' +
      'rename), then the verify step (1 read and 1 listing for a re-placed page) and the tree’s re-read.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('The new name, without its prefix (kept as it is).'),
      tags: editList.optional(),
      aliases: editList.optional(),
      icon: z
        .object({
          glyph: z.string().min(1).max(128).optional(),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional(),
          shape: z
            .enum(['pin', 'diamond', 'flag', 'marker', 'shield', 'circle', 'banner', 'arch', 'none'])
            .optional(),
          size: z.enum(['medium', 'small']).optional(),
        })
        .strict()
        .optional(),
      banner: z
        .object({
          url: z.string().min(1).max(2048).optional(),
          yPosition: z.number().optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .optional(),
      hidden: z.boolean().optional(),
      locked: z.boolean().optional(),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const r = resolvePage(ctx, args.page);
        if (!r.ok) return r.result;
        const node = r.node;
        if (node.kind === 'root')
          return errorResult(
            { code: 'ROOT_PAGE', message: 'The AI REPOSITORY page itself is not changed by the tools.' },
            pd,
          );
        const read = await liveRead(pd, mctx, 'update_resource', 'getResource', {
          path: { resourceId: node.id },
        });
        if (!read.ok) return read.result;
        const cur = (read.value ?? {}) as Obj;
        const body: Obj = {};
        const changes: Obj = {};
        let rename: { rawName: string; displayName: string } | null = null;
        if (args.name !== undefined) {
          const given = cleanPrefixes(args.name);
          if (given.prefix !== null && given.prefix !== node.kind) {
            const label =
              node.kind === 'index' || isPageKind(node.kind)
                ? `${node.kind === 'index' ? 'an' : 'a'} ${KIND_PREFIX[node.kind].trim()}`
                : 'an unclassified';
            return errorResult(
              {
                code: 'PREFIX_CHANGE',
                message:
                  `“${node.rawName}” is ${label} page; a rename keeps its prefix and never reclassifies it. Give the name without a prefix.` +
                  (given.prefix === 'bwrk' ||
                  given.prefix === 'barc' ||
                  node.kind === 'bwrk' ||
                  node.kind === 'barc'
                    ? ' A page’s lifecycle state ([BSRC], [BWRK], [BARC]) changes only with archive_page, unarchive_page, move_to_working or promote_page.'
                    : ''),
              },
              pd,
            );
          }
          if (node.kind === 'unclassified') {
            return errorResult(
              {
                code: 'UNCLASSIFIED_PAGE',
                message: `“${node.rawName}” has no [INDEX] or [BSRC] prefix; rename it in LegendKeeper (or tell the owner).`,
              },
              pd,
            );
          }
          const name = cleanName(given.name);
          if (!name)
            return errorResult(
              { code: 'INVALID_PARAMS', message: 'A name (1 to 200 characters) is required.' },
              pd,
            );
          // The page's own prefix, kept (v2 C2c: [BWRK] and [BARC] too).
          const rawName = `${KIND_PREFIX[node.kind as 'index' | 'bsrc' | 'bwrk' | 'barc']}${name}`;
          if (rawName !== node.rawName) {
            const twin = node.parentId ? sibling(ctx, node.parentId, node.kind, name, node.id) : null;
            if (twin) {
              return errorResult(
                {
                  code: 'NAME_TAKEN',
                  message: `A sibling is already named “${twin.rawName}”.`,
                  existing: nodeView(twin),
                },
                pd,
              );
            }
            rename = { rawName, displayName: name };
            body.name = rawName;
            changes.name = { before: node.rawName, after: rawName };
          }
        }
        const editStrings = (
          field: 'tags' | 'aliases',
          edit: { add?: string[] | undefined; remove?: string[] | undefined } | undefined,
          max: number,
        ) => {
          if (!edit) return null;
          const now = Array.isArray(cur[field]) ? (cur[field] as string[]) : [];
          const remove = new Set((edit.remove ?? []).map((x) => x.toLocaleLowerCase('en-GB')));
          const next = now.filter((x) => !remove.has(x.toLocaleLowerCase('en-GB')));
          for (const a of edit.add ?? [])
            if (!next.some((x) => x.toLocaleLowerCase('en-GB') === a.toLocaleLowerCase('en-GB')))
              next.push(a);
          if (next.length > max) return `${field} would hold ${next.length}; LegendKeeper allows ${max}.`;
          if (JSON.stringify(next) === JSON.stringify(now)) return null;
          body[field] = next;
          changes[field] = { before: now, after: next };
          return null;
        };
        const e1 = editStrings('tags', args.tags, 50);
        const e2 = editStrings('aliases', args.aliases, 128);
        if (e1 || e2) return errorResult({ code: 'INVALID_PARAMS', message: (e1 ?? e2)! }, pd);
        if (args.icon) {
          const map: [keyof NonNullable<typeof args.icon>, string][] = [
            ['glyph', 'iconGlyph'],
            ['color', 'iconColor'],
            ['shape', 'iconShape'],
            ['size', 'iconSize'],
          ];
          for (const [a, b] of map) {
            const v = args.icon[a];
            if (v !== undefined && v !== cur[b]) {
              body[b] = v;
              changes[b] = { before: cur[b] ?? null, after: v };
            }
          }
        }
        if (args.banner) {
          const b0 = cur.banner;
          const was =
            b0 && typeof b0 === 'object'
              ? (b0 as { enabled?: boolean; url?: string; yPosition?: number })
              : null;
          const url = args.banner.url ?? was?.url;
          if (!url)
            return errorResult(
              {
                code: 'INVALID_PARAMS',
                message: 'The page has no banner yet: give banner.url (an image asset of this project).',
              },
              pd,
            );
          const next = {
            enabled: args.banner.enabled ?? was?.enabled ?? true,
            url,
            yPosition: args.banner.yPosition ?? was?.yPosition ?? 50,
          };
          if (JSON.stringify(next) !== JSON.stringify(was)) {
            body.banner = next;
            changes.banner = { before: was, after: next };
          }
        }
        for (const [a, b] of [
          ['hidden', 'isHidden'],
          ['locked', 'isLocked'],
        ] as const) {
          const v = args[a];
          if (v !== undefined && v !== cur[b]) {
            body[b] = v;
            changes[a] = { before: cur[b] ?? null, after: v };
          }
        }
        const page = { id: node.id, name: node.rawName, path: node.path.names.join(' / ') };
        if (Object.keys(body).length === 0) {
          return render(
            {
              page,
              status: 'no_change',
              message: 'Nothing to change: the page already holds this. Nothing was sent.',
            },
            pd,
          );
        }
        // A rename re-places the page among its siblings, in the same job, when its place changes.
        const steps: StepSpec[] = [
          {
            op: 'updateResource',
            params: { path: { resourceId: node.id }, body },
            journalOperation: { tool: 'update_resource', page },
          },
        ];
        const labels = [`change ${Object.keys(changes).join(', ')}`];
        const fields: Obj = { ...(rename ? { name: rename.rawName } : {}) };
        for (const k of [
          'tags',
          'aliases',
          'iconGlyph',
          'iconColor',
          'iconShape',
          'iconSize',
          'banner',
          'isHidden',
          'isLocked',
        ])
          if (k in body) fields[k] = body[k];
        let placement: { parentId: string; after: string | null; before: string | null } | undefined;
        if (rename && node.parentId) {
          const sim = new SiblingSim((pid) => ctx.tree.children(ctx.projectId, pid).data);
          const now = sim.neighbours(node.parentId, node.id);
          sim.remove(node.parentId, node.id);
          const slot = sim.slot(node.parentId, { displayName: rename.displayName, kind: node.kind });
          sim.insert(node.parentId, { id: node.id, displayName: rename.displayName, kind: node.kind }, slot);
          const then = sim.neighbours(node.parentId, node.id);
          placement = { parentId: node.parentId, ...then };
          if (now.after !== then.after || now.before !== then.before) {
            steps.push({
              op: 'moveResource',
              params: { path: { resourceId: node.id }, body: { parentId: node.parentId, ...slot } },
              journalOperation: { tool: 'update_resource', page, write: 're-placed after the rename' },
            });
            labels.push(`re-place ${rename.rawName}`);
            changes.place = { after: then.after, before: then.before };
          }
        }
        const target: VerifyTarget = {
          kind: 'resource',
          label: rename?.rawName ?? node.rawName,
          resourceId: node.id,
          fields,
          ...(placement ? { placement } : {}),
        };
        steps.push({ op: VERIFY_STEP, params: { body: { targets: [target] } } });
        labels.push('verify');
        const head = { page, changes };
        const summary = `update_resource on “${node.rawName}”: ${Object.keys(changes).join(', ')}`;
        if (args.dryRun === true) {
          return render(
            {
              ...head,
              status: 'dry_run',
              steps: labels.slice(0, -1),
              message: 'Dry run: nothing was written.',
            },
            pd,
          );
        }
        const out = await runWriteJob(pd, mctx, 'update_resource', {
          steps,
          labels,
          title: summary,
          holdLock: { resourceId: node.id },
          proposal: {
            operations: [
              {
                tool: 'update_resource',
                page: { id: node.id, name: node.rawName },
                pageParts: Object.keys(changes),
                changes,
              },
            ],
            summary,
          },
          head,
          preview: () => ({ page }),
        });
        return out.result;
      }),
  });
}

// ============================================================================================ move_resource

function moveResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'move_resource',
    title: 'Move a page',
    access: 'write',
    description:
      'Moves a page (and everything under it) to a new parent index inside the AI REPOSITORY, in its alphabetical place ' +
      'there (one write). A move under the page itself or one of its descendants, or out of the repository, is refused. ' +
      'Cost: 1 write, then the verify step (1 read, 1 listing of the new parent’s children per 100) and the tree’s re-read.',
    inputSchema: z.object({
      page: pageRef.describe('The page to move (name or id).'),
      to: pageRef.describe('The new parent index (name or id).'),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const r = resolvePage(ctx, args.page);
        if (!r.ok) return r.result;
        const node = r.node;
        if (node.kind === 'root')
          return errorResult(
            { code: 'ROOT_PAGE', message: 'The AI REPOSITORY page itself cannot be moved by the tools.' },
            pd,
          );
        const d = resolveParent(ctx, args.to, { what: `the destination “${args.to}”` });
        if (!d.ok) return d.result;
        const dest = d.value;
        if (dest.id === node.id || dest.path.ids.includes(node.id)) {
          return errorResult(
            {
              code: 'MOVE_CYCLE',
              message: `“${dest.displayName}” is “${node.displayName}” itself or under it; a page cannot be moved under itself.`,
            },
            pd,
          );
        }
        const twin = sibling(ctx, dest.id, node.kind, node.displayName, node.id);
        if (twin)
          return errorResult(
            {
              code: 'NAME_TAKEN',
              message: `“${dest.displayName}” already has “${twin.rawName}”.`,
              existing: nodeView(twin),
            },
            pd,
          );
        const sim = new SiblingSim((pid) => ctx.tree.children(ctx.projectId, pid).data);
        const before = node.parentId ? sim.neighbours(node.parentId, node.id) : null;
        if (node.parentId) sim.remove(node.parentId, node.id);
        const slot = sim.slot(dest.id, node, () => true, node.id);
        sim.insert(dest.id, { id: node.id, displayName: node.displayName, kind: node.kind }, slot);
        const after = sim.neighbours(dest.id, node.id);
        const page = {
          id: node.id,
          name: node.rawName,
          from: node.path.names.slice(0, -1).join(' / '),
          to: dest.path.names.join(' / '),
        };
        if (
          dest.id === node.parentId &&
          before &&
          before.after === after.after &&
          before.before === after.before
        ) {
          return render(
            {
              page,
              status: 'no_change',
              message: 'The page is already there, in its place. Nothing was sent.',
            },
            pd,
          );
        }
        const steps: StepSpec[] = [
          {
            op: 'moveResource',
            params: { path: { resourceId: node.id }, body: { parentId: dest.id, ...slot } },
            journalOperation: { tool: 'move_resource', page: { id: node.id, name: node.rawName } },
          },
          {
            op: VERIFY_STEP,
            params: {
              body: {
                targets: [
                  {
                    kind: 'resource',
                    label: node.rawName,
                    resourceId: node.id,
                    fields: { parentId: dest.id },
                    placement: { parentId: dest.id, ...after },
                  },
                ],
              },
            },
          },
        ];
        const labels = [`move ${node.rawName} under ${dest.rawName}`, 'verify'];
        const head = {
          page,
          place: { after: after.after, before: after.before },
          moved: ctx.tree.subtree(ctx.projectId, node.id, { limit: 100_000 }).data.entries.length,
        };
        const summary = `move_resource: ${node.rawName} to ${dest.rawName}`;
        if (args.dryRun === true)
          return render({ ...head, status: 'dry_run', message: 'Dry run: nothing was written.' }, pd);
        const out = await runWriteJob(pd, mctx, 'move_resource', {
          steps,
          labels,
          title: summary,
          proposal: {
            operations: [
              {
                tool: 'move_resource',
                page: { id: node.id, name: node.rawName },
                pageParts: [`moved to ${dest.rawName}`],
              },
            ],
            summary,
          },
          head,
          preview: () => ({ page }),
        });
        return out.result;
      }),
  });
}

// ============================================================================================ delete_resource

/** The Status (and other rows) of pages as the tree last read them: the dry run's canon estimate (no reads). */
function treeFacts(ctx: RepoCtx, ids: readonly string[]): Map<string, { key: string; content: Obj[] }[]> {
  const out = new Map<string, { key: string; content: Obj[] }[]>();
  const sidebars = ctx.tree.sidebars(ctx.projectId, ids).data;
  for (const id of ids) {
    const blocks = sidebars.get(id) ?? [];
    out.set(
      id,
      blocks.flatMap((b) =>
        b.kind === 'keyValue'
          ? (b.rows ?? []).map((r) => ({ key: r.key, content: r.text ? [{ text: r.text }] : [] }))
          : [],
      ),
    );
  }
  return out;
}

function deleteResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'delete_resource',
    title: 'Delete a page',
    access: 'write',
    description:
      'Deletes a page inside the AI REPOSITORY (LegendKeeper keeps it; restore_resource brings it back). `confirm: true` is ' +
      'required; a page with pages under it also needs `cascade: true`, and the result lists every page removed. PROTECTED ' +
      'CANON: deleting a page whose Status is Authoritative (with cascade, any page in the subtree) needs the owner’s ' +
      'canonical approval: it becomes a proposal (proposal_captured with requiresCanonicalApproval) whatever your scope, ' +
      'listing which pages; never retry it. Cost: 1 read (the page, kept in the journal), 1 read per page of the subtree for ' +
      'the canon check, 1 write, 1 read to verify, and the tree’s re-read.',
    inputSchema: z.object({
      page: pageRef.describe('The page to delete (name or id).'),
      confirm: z.literal(true).describe('Required: true.'),
      cascade: z
        .literal(true)
        .optional()
        .describe('Also delete every page under it (required when it has any).'),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: { ...CHANGE_ANNOTATIONS, destructiveHint: true },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const r = resolvePage(ctx, args.page);
        if (!r.ok) return r.result;
        const node = r.node;
        if (node.kind === 'root')
          return errorResult(
            { code: 'ROOT_PAGE', message: 'The AI REPOSITORY page itself is never deleted by the tools.' },
            pd,
          );
        const subtree = ctx.tree
          .subtree(ctx.projectId, node.id, { limit: 100_000 })
          .data.entries.map((e) => e.node);
        const below = subtree.filter((n) => n.id !== node.id);
        const page = { id: node.id, name: node.rawName, path: node.path.names.join(' / ') };
        if (below.length > 0 && args.cascade !== true) {
          return errorResult(
            {
              code: 'HAS_CHILDREN',
              message: `“${node.displayName}” has ${plural(below.length, 'page')} under it; nothing was deleted. To delete them all with it, pass cascade: true as well.`,
              page,
              under: below.slice(0, 50).map(nodeView),
            },
            pd,
          );
        }
        const removed = subtree.map(nodeView);
        const rules = canonRules(pd, ctx.projectId);
        const facts = treeFacts(
          ctx,
          subtree.map((n) => n.id),
        );
        const canon = subtree
          .flatMap((n) => assessDelete(rules, facts.get(n.id) ?? [], n.rawName))
          .map((c) => c.text);
        const head = { page, removed, ...(below.length > 0 ? { cascade: true } : {}) };
        if (args.dryRun === true) {
          return render(
            {
              ...head,
              status: 'dry_run',
              ...(canon.length > 0 ? { requiresCanonicalApproval: true, protectedChanges: canon } : {}),
              message:
                (canon.length > 0
                  ? 'Dry run: nothing was deleted. As the tree last read them, these pages are protected canon, so the delete would become a proposal only the owner can accept as canon. '
                  : 'Dry run: nothing was deleted. ') + 'The real check reads every page again.',
            },
            pd,
          );
        }
        const read = await liveRead(pd, mctx, 'delete_resource', 'getResource', {
          path: { resourceId: node.id },
        });
        if (!read.ok) return read.result;
        const steps: StepSpec[] = [
          {
            op: 'deleteResource',
            params: {
              path: { resourceId: node.id },
              ...(below.length > 0 ? { query: { cascade: true } } : {}),
            },
            ...(below.length > 0 ? { confirm: 'cascade' as const } : {}),
            journalOperation: {
              tool: 'delete_resource',
              page: { id: node.id, name: node.rawName },
              removed: removed.length,
            },
            journalPreImage: {
              resource: read.value,
              subtree: subtree.map((n) => ({ id: n.id, name: n.rawName, parentId: n.parentId })),
            },
          },
          {
            op: VERIFY_STEP,
            params: { body: { targets: [{ kind: 'gone', label: node.rawName, resourceId: node.id }] } },
          },
        ];
        const summary = `delete_resource: ${node.rawName}${below.length > 0 ? ` and ${plural(below.length, 'page')} under it` : ''}`;
        const out = await runWriteJob(pd, mctx, 'delete_resource', {
          steps,
          labels: [
            `delete ${node.rawName}${below.length > 0 ? ` (cascade: ${removed.length} pages)` : ''}`,
            'verify',
          ],
          title: summary,
          proposal: {
            operations: [
              {
                tool: 'delete_resource',
                page: { id: node.id, name: node.rawName },
                pageParts: [
                  below.length > 0 ? `deleted with ${plural(below.length, 'page')} under it` : 'deleted',
                ],
                removed,
              },
            ],
            summary,
            prefetched: [{ op: 'getResource', path: { resourceId: node.id }, body: read.value }],
          },
          head,
          preview: () => ({ page, removed: removed.length }),
        });
        return out.result;
      }),
  });
}

// ============================================================================================ restore_resource

const ID_ONLY = /^(lk:\/\/resources\/)?([a-z][0-9a-z]{5,31})$/;

function restoreResourceTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'restore_resource',
    title: 'Restore a deleted page',
    access: 'write',
    description:
      'Restores a page deleted from the AI REPOSITORY (with everything deleted with it in the same cascade) and adds it ' +
      'back to the bridge’s tree. Give its id (delete_resource’s result and bridge_journal_lookup show it). No canonical ' +
      'approval is needed: restoring brings back what was approved. A page whose parent is itself deleted is refused ' +
      '(restore the parent). Cost: 1 write, 1 read to verify, and the tree’s re-read of what came back.',
    inputSchema: z.object({
      page: z.string().min(1).max(500).describe('The deleted page’s id (or lk://resources/<id>).'),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const m = ID_ONLY.exec(args.page.trim());
        if (!m)
          return errorResult(
            {
              code: 'INVALID_PARAMS',
              message: 'Give the deleted page’s id: a deleted page has no name the tree can find.',
            },
            pd,
          );
        const id = m[2]!;
        if (ctx.tree.node(ctx.projectId, id).data) {
          return errorResult(
            { code: 'NOT_DELETED', message: `${id} is in the repository tree, so it is not deleted.` },
            pd,
          );
        }
        // Where it was: the journal of the delete (delete_resource keeps the page and its subtree), else the tree's tombstone.
        const entries = pd.engine.queries.journalLookup(ctx.projectId, {
          opId: 'deleteResource',
          limit: 200,
          includePreImage: true,
        });
        let parentId: string | null | undefined;
        let name: string | null = null;
        for (const e of entries) {
          const pre = (e as { preImage?: unknown }).preImage as
            { resource?: Obj; subtree?: { id: string; name: string; parentId: string | null }[] } | undefined;
          const hit =
            pre?.subtree?.find((x) => x.id === id) ??
            (e.targetId === id && pre?.resource
              ? {
                  parentId: (pre.resource.parentId as string) ?? null,
                  name: typeof pre.resource.name === 'string' ? pre.resource.name : id,
                }
              : undefined);
          if (hit) {
            parentId = hit.parentId;
            name = hit.name;
            break;
          }
          if (e.targetId === id) {
            parentId = undefined;
            break;
          }
        }
        const tomb = ctx.tree.tombstone(ctx.projectId, id);
        if (parentId === undefined && !tomb) {
          return errorResult(
            {
              code: 'NOT_IN_REPOSITORY',
              message: `The bridge has no record of ${id} being deleted from this project’s AI REPOSITORY, so it will not restore it. The low-level lk_api_write can restore pages outside it.`,
            },
            pd,
          );
        }
        if (parentId !== undefined && parentId !== null && !ctx.tree.node(ctx.projectId, parentId).data) {
          return errorResult(
            {
              code: 'PARENT_DELETED',
              message: `${name ?? id} was under ${parentId}, which is not in the repository now (deleted too?). Restore that page first; a cascade comes back together.`,
              parentId,
            },
            pd,
          );
        }
        const page = { id, ...(name ? { name } : {}), ...(parentId ? { parentId } : {}) };
        if (args.dryRun === true)
          return render({ page, status: 'dry_run', message: 'Dry run: nothing was restored.' }, pd);
        const steps: StepSpec[] = [
          {
            op: 'restoreResource',
            params: { path: { resourceId: id } },
            journalOperation: { tool: 'restore_resource', page },
          },
          {
            op: VERIFY_STEP,
            params: {
              body: {
                targets: [
                  {
                    kind: 'resource',
                    label: name ?? id,
                    resourceId: id,
                    fields: parentId ? { parentId } : {},
                  },
                ],
              },
            },
          },
        ];
        const summary = `restore_resource: ${name ?? id}`;
        const out = await runWriteJob(pd, mctx, 'restore_resource', {
          steps,
          labels: [`restore ${name ?? id}`, 'verify'],
          title: summary,
          proposal: {
            operations: [
              { tool: 'restore_resource', page: { id, name: name ?? id }, pageParts: ['restored'] },
            ],
            summary,
          },
          head: { page },
          preview: () => ({ page }),
        });
        return out.result;
      }),
  });
}

export function resourceTools(deps: ToolDeps): McpToolProvider[] {
  return [
    createIndexTool(deps),
    createResourceTool(deps),
    createBareResourceTool(deps),
    createManyResourcesTool(deps),
    updateResourceTool(deps),
    moveResourceTool(deps),
    deleteResourceTool(deps),
    restoreResourceTool(deps),
  ];
}

export type { McpToolContext, McpToolResult };
