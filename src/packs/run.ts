/**
 * Running one package (v3 F3a, ADR 0050; v3 F3b, ADR 0052): the pack looked up and its attachment checked, the
 * governance read, the plan made, then a preview (a dry run, or any refusal with everything the plan found) or ONE job,
 * which follows the caller's scope (v3 F12, ADR 0081: direct at `write`, canon included, on the owner's Review page; a
 * proposal at `propose`, a canonical one when it makes canon or moves an Authoritative page). Every pack tool plans its own way (a character
 * package, an owner, a relationship, art) and finishes here, through exactly the same engine; tests call these functions
 * directly for a type defined only in test data (the dummy type).
 */
import { londonDate } from '../jobs/internal-steps.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import type { LmrMode } from '../jobs/lmr-hook.js';
import { lmrConfigFrom, type LmrConfig } from '../lmr/index.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { createCtx, withRequest, type CreateCtx, type CreateOutcome } from '../mcp/tools/create-support.js';
import { finish, repoContext, type RepoCtx } from '../mcp/tools/repo.js';
import { errorResult, render, type ProjectDeps } from '../mcp/tools/shape.js';
import { runWriteJob } from '../mcp/tools/write-job.js';
import type { LifecycleConfig } from '../lifecycle/settings.js';
import { buildPackJob, type PackJob } from './engine/job.js';
import { itemizePackage } from './engine/items.js';
import { artJobCost, itemizeArtGroups } from './art-items.js';
import { lmrSummary } from './engine/lmr.js';
import { planOwner, type OwnerInput } from './engine/owner.js';
import { planPackage, type PackageInput, type PackPlan, type PlanEnv } from './engine/plan.js';
import { textKey } from './engine/text.js';
import { coreNeed, coreTextWords, isOwnerRole, ownersInIndex } from './engine/core.js';
import { GENERIC_HOOK, hookFor } from './hooks.js';
import type { GovernanceStatus } from './service.js';
import type { Pack, PackAttachment } from './types.js';
import { creationCheck } from './reftypes/service.js';
import { categoryFromTags, vocabularyOf } from './retag/engine.js';

type Obj = Record<string, unknown>;

export interface RunPackageOptions {
  readonly packId: string;
  /** The type's name (`Character`). */
  readonly type: string;
  /** The tool's full name (`arkona_create_character`), for the journal, proposals and claims. */
  readonly tool: string;
  readonly input: PackageInput;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  /** The raw arguments, for `operation_id`'s request hash. */
  readonly args: Obj;
  /** v3 F3b with ADR 0051: the caller's override for the existing pages the package changes (default `auto`). */
  readonly lastMajorRevision?: LmrMode | undefined;
  /** v3 F7c (ADR 0075, Z4): images left out before planning (an archive entry that cannot be used), with why. */
  readonly notUsed?: readonly { readonly label: string; readonly code: string; readonly reason: string }[];
}

/** What every pack tool needs before it plans: the pack, its attachment, the tree, the settings, the governance. */
export interface PackBasis {
  readonly pack: Pack;
  readonly attachment: PackAttachment;
  readonly ctx: RepoCtx;
  readonly cc: CreateCtx;
  readonly lifecycle: LifecycleConfig;
  readonly governance: GovernanceStatus;
  readonly lmrOnChanges: boolean;
  /** v3 F3b with ADR 0051: the project's Last Major Revision configuration (its key, switches, housekeeping keys). */
  readonly lmrConfig: LmrConfig;
}

/** The pack and the project, checked (v3 F3b: shared by every pack tool). */
export async function packBasis(
  pd: ProjectDeps,
  mctx: McpToolContext,
  packId: string,
  tool: string,
): Promise<
  { readonly ok: true; readonly value: PackBasis } | { readonly ok: false; readonly result: McpToolResult }
> {
  const packs = pd.services?.packs;
  if (!packs)
    return {
      ok: false,
      result: errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Setting packs are not available here.' }, pd),
    };
  const pack = packs.get(packId);
  if (!pack)
    return { ok: false, result: errorResult({ code: 'PACK_NOT_FOUND', message: `No pack ${packId}.` }, pd) };
  const attachment = packs.attachment(pack.id, pd.project.id);
  if (!attachment) {
    const attached = packs.view(pack.id)?.attachments.map((a) => a.projectName) ?? [];
    return {
      ok: false,
      result: errorResult(
        {
          code: 'PACK_NOT_ATTACHED',
          message: `The ${pack.name} pack is not attached to the project ${pd.project.name}; its tools work only on ${attached.join(', ') || 'no project yet'}. Name one of those as project.`,
          attachedTo: attached,
        },
        pd,
      ),
    };
  }
  const rc = repoContext(pd);
  if (!rc.ok) return { ok: false, result: rc.result };
  const ctx = rc.ctx;
  const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
  const lifecycle = lifecycleFrom(settings);
  const cc = createCtx(pd, mctx, ctx, tool);
  const governance = await packs.governance(pack.id, { signal: mctx.signal });
  const lmrConfig = lmrConfigFrom(settings, lifecycle.fields.lastMajorRevision);
  return {
    ok: true,
    value: {
      pack,
      attachment,
      ctx,
      cc,
      lifecycle,
      governance,
      lmrOnChanges: lmrConfig.categories.packTools,
      lmrConfig,
    },
  };
}

/** The planning environment of a pack tool, without its type (an owner's is made by its planner). */
export function envOf(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  b: PackBasis,
  lastMajorRevision: LmrMode = 'auto',
): Omit<PlanEnv, 'type' | 'hook'> {
  return {
    pd,
    mctx,
    ctx: b.ctx,
    cc: b.cc,
    tool,
    pack: b.pack,
    templates: b.attachment.templates,
    lifecycle: b.lifecycle,
    governance: b.governance,
    today: londonDate(Date.now()),
    lmrOnChanges: b.lmrOnChanges,
    lmr: { config: b.lmrConfig, mode: lastMajorRevision },
  };
}

/** The Character type's environment (the character tool, and v3 F3b's relationship and art tools). */
export function characterEnv(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  b: PackBasis,
  typeName: string,
  lastMajorRevision: LmrMode = 'auto',
): { readonly ok: true; readonly env: PlanEnv } | { readonly ok: false; readonly result: McpToolResult } {
  const type = b.pack.rules.types.find((t) => t.name.toLowerCase() === typeName.toLowerCase());
  if (!type)
    return {
      ok: false,
      result: errorResult(
        { code: 'PACK_TYPE_NOT_FOUND', message: `The ${b.pack.name} pack has no type ${typeName}.` },
        pd,
      ),
    };
  const hook = hookFor(type);
  if (!hook)
    return {
      ok: false,
      result: errorResult(
        {
          code: 'PACK_HOOK_MISSING',
          message: `The ${type.name} type names the hook “${type.hook ?? ''}”, which this bridge does not have.`,
        },
        pd,
      ),
    };
  return { ok: true, env: { ...envOf(pd, mctx, tool, b, lastMajorRevision), type, hook } };
}

export async function runPackage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: RunPackageOptions,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const e = characterEnv(pd, mctx, o.tool, b.value, o.type, o.lastMajorRevision);
  if (!e.ok) return e.result;
  const plan = await planPackage(e.env, o.input);
  if (o.notUsed && o.notUsed.length > 0) {
    for (const n of o.notUsed)
      plan.warnings.push({
        code: 'IMAGE_NOT_USED',
        message: `${n.label} was left out (${n.code}): ${n.reason} The other images go ahead.`,
      });
  }
  return finishPackage(pd, mctx, o, e.env, plan);
}

/** v3 F3b (ADR 0052): `arkona_create_owner`'s run: the owner type looked up, planned, then finished as every package. */
export async function runOwner(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: {
    readonly packId: string;
    readonly tool: string;
    readonly input: OwnerInput;
    readonly dryRun: boolean;
    readonly operationId?: string | undefined;
    readonly args: Obj;
    readonly lastMajorRevision?: LmrMode | undefined;
  },
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const owners = b.value.pack.rules.owners;
  const types = owners?.types.map((t) => t.name) ?? [];
  if (!owners || !owners.types.some((t) => textKey(t.name) === textKey(o.input.type)))
    return errorResult(
      {
        code: 'PACK_TYPE_NOT_FOUND',
        message: `${o.tool} makes ${types.join(', ') || 'no type now'}; not “${o.input.type}”.`,
        types,
      },
      pd,
    );
  const base = envOf(pd, mctx, o.tool, b.value, o.lastMajorRevision);
  const plan = await planOwner(base, o.input);
  await withCharacterCore(pd, mctx, o.tool, b.value, plan, o.lastMajorRevision);
  return finishPackage(pd, mctx, o, { ...base, type: plan.type, hook: GENERIC_HOOK }, plan);
}

/**
 * v3 F7.1 (ADR 0072): an owner page placed in a character's index (a home override) counts as one of that character's
 * owner pages. When the package would leave the character with an index and several owners under a Compact Character
 * Reference, the character planner's upgrade (planPackage with upgradeToCore) joins this package's changes: the same
 * rule as every character package (src/packs/engine/core.ts). An upgrade that cannot be made refuses the package
 * (CORE_REQUIRED).
 */
async function withCharacterCore(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  b: PackBasis,
  plan: PackPlan,
  lmr: LmrMode | undefined,
): Promise<void> {
  if (plan.refusals.length > 0) return;
  const ctx = b.ctx;
  const byIndex = new Map<string, number>();
  for (const p of plan.pages)
    if ('existing' in p.parent && isOwnerRole(p.rule))
      byIndex.set(p.parent.existing, (byIndex.get(p.parent.existing) ?? 0) + 1);
  for (const [indexId, added] of byIndex) {
    const idx = ctx.tree.node(ctx.projectId, indexId).data;
    if (!idx || idx.kind !== 'index') continue;
    const ch = ctx.types.characterOfPage(indexId);
    if (!ch.ok || ch.value.via !== 'index') continue;
    const need = coreNeed({
      role: ch.value.role,
      from: 'compact',
      hasIndex: true,
      existing: ownersInIndex(ctx.tree.children(ctx.projectId, indexId).data, ch.value.core.id),
      added,
    });
    if (!need.needed) continue;
    const e = characterEnv(pd, mctx, tool, b, 'Character', lmr);
    if (!e.ok) {
      plan.refusals.push({
        code: 'CORE_REQUIRED',
        message: `${ch.value.subject} would have ${need.owners} owner pages in ${idx.rawName} and no Character Core, and the Character type is not available to upgrade ${ch.value.core.rawName}. Nothing is made.`,
      });
      continue;
    }
    const up = await planPackage(e.env, {
      name: ch.value.subject,
      identity: {},
      target: ch.value.core.id,
      pages: [],
      upgradeToCore: true,
    });
    if (up.refusals.length > 0) {
      plan.refusals.push({
        code: 'CORE_REQUIRED',
        message: `${ch.value.subject} would have ${need.owners} owner pages in ${idx.rawName} and no Character Core, and ${ch.value.core.rawName} cannot become its Core now (${up.refusals.map((r) => `${r.code}: ${r.message}`).join('; ')}). Nothing is made. Ask the owner to fix that first, or give another home.`,
        cause: up.refusals.map((r) => r.code),
        identity: { id: ch.value.core.id, name: ch.value.core.rawName },
      });
      continue;
    }
    plan.existing.push(...up.existing);
    plan.warnings.push(...up.warnings);
    plan.notes.push(
      ...up.notes,
      `${ch.value.core.displayName} becomes its Character Core in this proposal: the character now has an index and several owners (${need.owners}).`,
    );
  }
}

/**
 * Finishes any package (v3 F3b: shared by the four write tools): the Last Major Revision note, the job, the preview,
 * then a refusal, a dry run, or ONE proposal; then the staged images it places, and (design section 6) a staged image's
 * own pending placement proposal it takes over, withdrawn as "superseded by package prop_…".
 */
export async function finishPackage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: {
    readonly packId: string;
    readonly tool: string;
    readonly dryRun: boolean;
    readonly operationId?: string | undefined;
    readonly args: Obj;
    readonly lastMajorRevision?: LmrMode | undefined;
  },
  env: PlanEnv,
  plan: PackPlan,
): Promise<McpToolResult> {
  const { pack, ctx, type } = env;
  // v3 F6a (ADR 0076; design T1 step 6): every new page's Reference Type against the vocabulary: refused once it is
  // published (the nearest canonical value suggested; an approved specialist type accepted), a warning while a draft.
  if (pack.rules.referenceTypes) {
    const vocab = vocabularyOf(pack.rules);
    for (const p of plan.pages) {
      if (!p.referenceType) continue;
      const c = categoryFromTags(p.tags ?? p.rule.tags.filter((t) => !t.startsWith('$')), vocab);
      const check = creationCheck(pack.rules, p.referenceType, 'primary' in c ? c.primary : null);
      if (check.verdict === 'ok') continue;
      const issue = {
        code: 'REFERENCE_TYPE_NOT_IN_VOCABULARY',
        message: `${p.rawName}: ${check.message ?? ''}`,
        referenceType: p.referenceType,
        ...(check.nearest ? { nearest: check.nearest } : {}),
      };
      if (check.verdict === 'refuse') plan.refusals.push(issue);
      else plan.warnings.push(issue);
    }
  }
  let job: PackJob | null = null;
  if (plan.refusals.length === 0) {
    const built = buildPackJob(env, plan);
    if (!built.ok) return built.result;
    job = built.value;
    if (job.lmr.existing.some((d) => !d.set && d.why.includes('lmrPackTools')))
      plan.notes.push(
        `${env.lifecycle.fields.lastMajorRevision} is not changed on the existing pages this package changes: the project's switch for setting-pack tools (lmrPackTools) is off. The pages it creates get it.`,
      );
  }
  // v3 F7d (ADR 0077, A5): a groups call's totals (planning reads, the job's reads, writes and uploads).
  if (job && plan.art?.groupOf) {
    const planReads = typeof plan.extra?.planReads === 'number' ? plan.extra.planReads : 0;
    plan = { ...plan, extra: { ...(plan.extra ?? {}), cost: artJobCost(job, planReads) } };
  }
  const preview = previewOf(plan, job, ctx.tree.node.bind(ctx.tree), ctx.projectId);
  if (plan.refusals.length > 0) {
    const first = plan.refusals[0]!;
    // The first refusal's details (its fields, candidates, the existing page, a hint) on the error itself, as other
    // tools' errors carry theirs; every refusal is in `refusals`.
    const { code: _code, message: _message, ...details } = first;
    return errorResult(
      {
        ...details,
        code: first.code,
        message:
          plan.refusals.length === 1
            ? first.message
            : `${first.message} (and ${plan.refusals.length - 1} more refusal${plan.refusals.length === 2 ? '' : 's'}: see refusals)`,
        refusals: plan.refusals,
        preview,
      },
      pd,
    );
  }
  if (o.dryRun) {
    const body = {
      status: 'dry_run',
      ...preview,
      // v3 F12 follow-up (ADR 0081 amendment 1, decision 4): what it will be at the caller's scope.
      message:
        mctx.scope === 'propose'
          ? 'Dry run: nothing was written and nothing was proposed. Call again without dryRun to make it: at your connection’s scope (propose) ONE proposal for the owner.'
          : 'Dry run: nothing was written. Call again without dryRun to make it: at your connection’s scope (write) ONE job that runs directly and appears on the owner’s Review page, with Revert (make it only when the owner has asked for it in this conversation, and say what you changed).',
    };
    return finish(pd, mctx, o.tool, body, () => ({ pages: plan.pages.length, summary: job!.summary }));
  }
  return withRequest(
    pd,
    mctx,
    o.tool,
    { ...o.args, dryRun: false },
    null,
    async (): Promise<CreateOutcome> => {
      const j = job!;
      const head: Obj = {
        pack: pack.id,
        type: type.name,
        subject: plan.subject,
        mode: plan.mode,
        lifecycleStatus: plan.status,
        pages: plan.pages.map((p) => ({ id: p.id, name: p.rawName, parent: p.parentName })),
        ...(plan.images.length
          ? {
              images: plan.images.map((i) => ({
                staged_id: i.stagedId,
                name: i.name,
                folder: i.path.join(' / '),
              })),
            }
          : {}),
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        ...(plan.replacements.length ? { replacements: plan.replacements } : {}),
        ...(plan.held.length ? { heldTags: plan.held } : {}),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
        lastMajorRevision: lmrView(j),
      };
      // v3 F3d (ADR 0058): the package as items the owner can approve one by one (everything ticked: as before).
      // v3 F7d (ADR 0077, A3): a groups call's items: "Art page", "Design pieces", one per outfit.
      const itemized = plan.art?.groupOf ? itemizeArtGroups(plan, j) : itemizePackage(plan, j);
      const out = await runWriteJob(pd, mctx, o.tool, {
        steps: itemized.steps,
        labels: j.labels,
        title: j.summary,
        // v3 F3d: a package that stops part-way can be resumed: its own check (governance, nothing duplicated) first.
        resumable: { kind: 'package', recheck: [1] },
        // v3 F7c (ADR 0075, Z4): archive entries not staged yet: the job waits for them (`waiting_staging`).
        ...(plan.images.some((i) => i.pending)
          ? {
              waitFor: {
                kind: 'archive_staging' as const,
                projectId: pd.project.id,
                stagedIds: plan.images.filter((i) => i.pending).map((i) => i.stagedId),
                reason: `${plan.images.filter((i) => i.pending).length} archive entr${plan.images.filter((i) => i.pending).length === 1 ? 'y' : 'ies'} to be staged first`,
              },
            }
          : {}),
        ...(j.marker ? { lifecycle: j.marker } : {}),
        // v3 F12 (ADR 0081): the agent's scope decides (direct at `write`, a proposal at `propose`); no switch.
        stagedPlacement: plan.images.length > 0,
        // v3 F3b with ADR 0051: the same override reaches the engine (whose own planner leaves this job alone while
        // it has Last Major Revision steps of its own).
        lastMajorRevision: j.lmr.mode,
        proposal: {
          operations: j.operations,
          summary: j.summary,
          ...(itemized.items ? { items: itemized.items } : {}),
          ...(j.lmr.existing.length > 0 ? { lmrNote: lmrSummary(j.lmr.existing) } : {}),
          operation: { tool: o.tool, pack: pack.id, preview },
          prefetched: [...env.cc.sidebars.entries()].map(([resourceId, sb]) => ({
            op: 'listProperties',
            path: { resourceId },
            body: { data: sb.map((p) => p.raw) },
          })),
        },
        head,
        preview: () => ({ pages: plan.pages.length, summary: j.summary }),
      });
      // v3 F3f (ADR 0060): the pack's own record of the pages it makes, the retag's first evidence of their category.
      if (pd.services?.retag && (out.proposalId || out.jobId))
        try {
          pd.services.retag.recordPackage(pd.project.id, {
            packId: pack.id,
            tool: o.tool,
            type: type.name,
            rules: pack.rules,
            pages: plan.pages.map((p) => ({ id: p.id, role: p.role, tags: p.tags ?? [] })),
            proposalId: out.proposalId ?? null,
            jobId: out.jobId ?? null,
          });
        } catch {
          // A record is evidence for a later audit only; the package stands without it.
        }
      // The staged images: the job (or proposal) that places them, and where each one's asset step is.
      const images = pd.services?.images;
      let result = out.result;
      let body = out.body;
      // CR-2026-11-R2 (R2-34): a direct job (scope write) has run (or is still waiting) by now. Its outcome decides: a
      // job that stopped leaves the images and their own placement proposals as they were.
      const status = out.jobId ? pd.engine.queries.getJob(pd.project.id, out.jobId)?.status : undefined;
      const stopped = status === 'failed' || status === 'cancelled';
      if (images && (out.proposalId || (out.jobId && !stopped))) {
        // v3 F3b (design section 6): a staged image's own pending placement is withdrawn, naming this package, once the
        // package is captured as a proposal or its job has succeeded (R2-34: never for a job that has not).
        const by = out.proposalId ?? out.jobId!;
        const takeovers: Obj[] = [];
        for (const tk of plan.takeovers ?? []) {
          if (!out.proposalId && status !== 'succeeded') {
            takeovers.push({
              staged_id: tk.stagedId,
              proposalId: tk.proposalId,
              withdrawn: false,
              note: `this package's job ${out.jobId!} places the image when it runs; its placement proposal ${tk.proposalId} is left pending until then (the owner rejects it once the job has placed the image)`,
            });
            continue;
          }
          const done = images.supersedePlacement(pd.project.id, tk.stagedId, tk.proposalId, by);
          takeovers.push({
            staged_id: tk.stagedId,
            proposalId: tk.proposalId,
            withdrawn: done,
            ...(done
              ? { note: `superseded by package ${by}` }
              : {
                  note: `its placement proposal ${tk.proposalId} was decided meanwhile; this package's job checks the image is still unplaced before it writes anything`,
                }),
          });
        }
        // CR-2026-11-R2 (R2-40): the record follows the package only while nothing else is placing or discarding the
        // image (a placement approved or started meanwhile keeps its link; the package's job finds it busy and stops).
        const ours = new Set(
          [out.proposalId, out.jobId, ...(plan.takeovers ?? []).map((t) => t.proposalId)].filter(
            (x): x is string => typeof x === 'string',
          ),
        );
        for (const im of plan.images) {
          const assetStep = j.assetSteps.get(im.stagedId);
          if (!assetStep) continue;
          const now = images.store.upload(pd.project.id, im.stagedId);
          // v3 F7c (ADR 0075, Z4): an archive entry not staged yet: the placement waits on its entry (pinned), and is
          // put on the image's record when the worker stages it.
          if (!now && im.pending) {
            images.archives.link(pd.project.id, im.stagedId, {
              ...(out.jobId ? { jobId: out.jobId } : { proposalId: out.proposalId! }),
              placing: { name: im.name, path: im.path, folderId: im.folderId, assetStep },
            });
            continue;
          }
          const free = (x: string | null | undefined) => !x || ours.has(x);
          if (now && !(free(now.placementProposalId) && free(now.placementJobId) && !now.discardJobId))
            continue;
          images.store.updateUpload(pd.project.id, im.stagedId, {
            ...(out.jobId ? { placementJobId: out.jobId } : { placementProposalId: out.proposalId! }),
            intended: {
              ...(im.row.intended ?? {}),
              placing: { name: im.name, path: im.path, folderId: im.folderId, assetStep },
            },
            error: null,
          });
        }
        if (takeovers.length > 0) {
          body = { ...out.body, takenOver: takeovers };
          result = render(body, pd);
        }
      }
      return { kind: 'job', head, labels: j.labels, ...out, result, body };
    },
  );
}

/** The preview (decision: section 4 of the design): the tree, each page in full, assets, replacements, refusals. */
export function previewOf(
  plan: PackPlan,
  job: PackJob | null,
  nodeOf: (projectId: string, id: string) => { data: { rawName: string } | null },
  projectId: string,
): Obj {
  const nameOf = (id: string | null) => {
    if (!id) return null;
    const own = plan.pages.find((p) => p.id === id);
    if (own) return own.rawName;
    return nodeOf(projectId, id).data?.rawName ?? id;
  };
  // Indexes first, then pages, each alphabetical (the sibling order the bridge places them in).
  const ordered = [...plan.pages].sort((a, b) =>
    a.kind === 'index' && b.kind !== 'index'
      ? -1
      : b.kind === 'index' && a.kind !== 'index'
        ? 1
        : a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base', numeric: true }),
  );
  const tree = ordered.map((p) => {
    const where = job?.placement.get(p.id);
    return {
      page: p.rawName,
      role: p.role,
      parent: where ? nameOf(where.parentId) : p.parentName,
      ...(where ? { after: nameOf(where.after), before: nameOf(where.before) } : {}),
    };
  });
  return {
    pack: plan.pack.id,
    packVersion: plan.pack.version,
    type: plan.type.name,
    subject: plan.subject,
    mode: plan.mode,
    lifecycleStatus: plan.status,
    ...(plan.extra ?? {}),
    ...(plan.target
      ? {
          target: {
            id: plan.target.identity.id,
            name: plan.target.identity.rawName,
            role: plan.target.role,
            index: plan.target.index?.rawName ?? null,
          },
        }
      : {}),
    governance: {
      state: plan.governance.state,
      message: plan.governance.message,
      sources: plan.governance.sources.map((s) => ({
        name: s.name,
        ...(s.label ? { label: s.label } : {}),
        state: s.state,
        approved: s.approved,
        current: s.current,
        ...(s.sections ? { sections: s.sections } : {}),
      })),
    },
    tree,
    pages: plan.pages.map((p) => ({
      name: p.rawName,
      role: p.role,
      template: { id: p.templateId, name: p.templateName },
      parent: p.parentName,
      ...(p.referenceType ? { referenceType: p.referenceType } : {}),
      facts: p.factValues.map((f) => ({ key: f.key, value: f.value })),
      ...(p.templateKeys?.some((k) => k.toLowerCase() === 'last major revision')
        ? { lastMajorRevision: 'set to the day the job runs (the day the owner approves)' }
        : {}),
      tags: p.tags ?? [],
      dependencies:
        p.linkTargets
          .find((l) => l.title.toLowerCase() === plan.pack.rules.sidebar.dependencies.toLowerCase())
          ?.targets.map((t) => t.name) ?? [],
      relatedSources:
        p.linkTargets
          .find((l) => l.title.toLowerCase() === plan.pack.rules.sidebar.related.toLowerCase())
          ?.targets.map((t) => t.name) ?? [],
      text: p.blocks ? { blocks: p.blocks.length, headings: p.headings } : null,
      ...(p.kind === 'index' && p.markdown ? { indexText: p.markdown } : {}),
      ...(p.images.length ? { images: p.images.map((i) => i.name) } : {}),
      ...(p.notes?.length ? { notes: p.notes } : {}),
    })),
    existing: plan.existing.map((c) =>
      c.kind === 'move'
        ? { page: c.page.rawName, change: `moved under ${c.toName} (id kept)` }
        : c.kind === 'rename'
          ? {
              page: c.from,
              change: `renamed to ${c.to}; Reference Type Character Core; the Core template recorded`,
            }
          : c.kind === 'facts'
            ? { page: c.page.rawName, change: c.why.join('; ') }
            : c.kind === 'images'
              ? {
                  page: c.page.rawName,
                  change: `${c.section}: +${c.images.length} image(s), each with its label and interpretation`,
                  images: c.images.map((i) => i.name),
                }
              : c.kind === 'core_text'
                ? {
                    page: c.page.rawName,
                    change: coreTextWords(c),
                    ...(c.replacements.length
                      ? { replacements: c.replacements.map((r) => ({ before: r.before, after: r.after })) }
                      : {}),
                  }
                : {
                    page: c.page.rawName,
                    change: c.what ? `${c.section}: ${c.what}` : `${c.section}: +${c.lines.length} line(s)`,
                    lines: c.lines,
                  },
    ),
    assets: plan.images.map((i) => ({
      staged_id: i.stagedId,
      name: i.name,
      folder: i.path.join(' / '),
      ...(i.creates.length ? { createsFolders: i.creates.map((c) => c.name) } : {}),
    })),
    ...(plan.takeovers?.length
      ? {
          takesOver: plan.takeovers.map((t) => ({
            staged_id: t.stagedId,
            proposalId: t.proposalId,
            note: 'its own pending placement proposal is withdrawn when this package is proposed (“superseded by package …”)',
          })),
        }
      : {}),
    ...(job ? { lastMajorRevision: lmrView(job) } : {}),
    replacements: plan.replacements,
    heldTags: plan.held,
    refusals: plan.refusals,
    warnings: plan.warnings,
    notes: plan.notes,
    ...(job ? { steps: job.labels.filter((l) => l !== 'check' && l !== 'verify'), writes: job.writes } : {}),
  };
}

/**
 * v3 F3b with ADR 0051 (ADR 0052 decision 14): what the package does to Last Major Revision, for the preview and the
 * answer: the mode, the new pages (always dated), and each existing page it changes, set or skipped, and why.
 */
function lmrView(j: PackJob): Obj {
  return {
    mode: j.lmr.mode,
    newPages: j.lmr.newPages,
    existing: j.lmr.existing.map((d) => ({ page: d.page, set: d.set, why: d.why })),
  };
}
