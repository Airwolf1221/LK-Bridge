/**
 * Running one package (v3 F3a, ADR 0050; v3 F3b, ADR 0052): the pack looked up and its attachment checked, the
 * governance read, the plan made, then a preview (a dry run, or any refusal with everything the plan found) or ONE job,
 * which is a proposal whatever the caller's scope while the pack's `alwaysPropose` is on (its first weeks), and a
 * canonical one when it makes canon or moves an Authoritative page. Every pack tool plans its own way (a character
 * package, an owner, a relationship, art) and finishes here, through exactly the same engine; tests call these functions
 * directly for a type defined only in test data (the dummy type).
 */
import { londonDate } from '../jobs/internal-steps.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import { lmrConfigFrom } from '../lmr/index.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { createCtx, withRequest, type CreateCtx, type CreateOutcome } from '../mcp/tools/create-support.js';
import { finish, repoContext, type RepoCtx } from '../mcp/tools/repo.js';
import { errorResult, render, type ProjectDeps } from '../mcp/tools/shape.js';
import { runWriteJob } from '../mcp/tools/write-job.js';
import type { LifecycleConfig } from '../lifecycle/settings.js';
import { buildPackJob, type PackJob } from './engine/job.js';
import { planOwner, type OwnerInput } from './engine/owner.js';
import { planPackage, type PackageInput, type PackPlan, type PlanEnv } from './engine/plan.js';
import { textKey } from './engine/text.js';
import { GENERIC_HOOK, hookFor } from './hooks.js';
import type { GovernanceStatus } from './service.js';
import type { Pack, PackAttachment } from './types.js';

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
}

/** The pack and the project, checked (v3 F3b: shared by every pack tool). */
export async function packBasis(
  pd: ProjectDeps,
  mctx: McpToolContext,
  packId: string,
  tool: string,
): Promise<{ readonly ok: true; readonly value: PackBasis } | { readonly ok: false; readonly result: McpToolResult }> {
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
  return {
    ok: true,
    value: {
      pack,
      attachment,
      ctx,
      cc,
      lifecycle,
      governance,
      lmrOnChanges: lmrConfigFrom(settings, lifecycle.fields.lastMajorRevision).categories.packTools,
    },
  };
}

/** The planning environment of a pack tool, without its type (an owner's is made by its planner). */
export function envOf(pd: ProjectDeps, mctx: McpToolContext, tool: string, b: PackBasis): Omit<PlanEnv, 'type' | 'hook'> {
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
  };
}

/** The Character type's environment (the character tool, and v3 F3b's relationship and art tools). */
export function characterEnv(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  b: PackBasis,
  typeName: string,
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
  return { ok: true, env: { ...envOf(pd, mctx, tool, b), type, hook } };
}

export async function runPackage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: RunPackageOptions,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const e = characterEnv(pd, mctx, o.tool, b.value, o.type);
  if (!e.ok) return e.result;
  const plan = await planPackage(e.env, o.input);
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
  const base = envOf(pd, mctx, o.tool, b.value);
  const plan = await planOwner(base, o.input);
  return finishPackage(pd, mctx, o, { ...base, type: plan.type, hook: GENERIC_HOOK }, plan);
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
  },
  env: PlanEnv,
  plan: PackPlan,
): Promise<McpToolResult> {
  const { pack, ctx, type } = env;
  if (
    !env.lmrOnChanges &&
    plan.existing.some(
      (c) => c.kind === 'rename' || c.kind === 'images' || (c.kind === 'facts' && c.substantial),
    )
  ) {
    plan.notes.push(
      `${env.lifecycle.fields.lastMajorRevision} is not changed on the existing pages this package changes: the project's switch for setting-pack tools (lmrPackTools) is off. The pages it creates get it.`,
    );
  }
  let job: PackJob | null = null;
  if (plan.refusals.length === 0) {
    const built = buildPackJob(env, plan);
    if (!built.ok) return built.result;
    job = built.value;
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
      message:
        'Dry run: nothing was written and nothing was proposed. Call again without dryRun to propose it (one proposal for the owner).',
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
      };
      const out = await runWriteJob(pd, mctx, o.tool, {
        steps: j.steps,
        labels: j.labels,
        title: j.summary,
        ...(j.marker ? { lifecycle: j.marker } : {}),
        forceProposal: pack.rules.settings.alwaysPropose,
        stagedPlacement: plan.images.length > 0,
        proposal: {
          operations: j.operations,
          summary: j.summary,
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
      // The staged images: the job (or proposal) that places them, and where each one's asset step is.
      const images = pd.services?.images;
      let result = out.result;
      let body = out.body;
      if (images && (out.jobId || out.proposalId)) {
        // v3 F3b (design section 6): a staged image's own pending placement is withdrawn first, naming this package.
        const by = out.proposalId ?? out.jobId!;
        const takeovers: Obj[] = [];
        for (const tk of plan.takeovers ?? []) {
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
        for (const im of plan.images) {
          const assetStep = j.assetSteps.get(im.stagedId);
          if (!assetStep) continue;
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
              : { page: c.page.rawName, change: `${c.section}: +${c.lines.length} line(s)`, lines: c.lines },
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
    replacements: plan.replacements,
    heldTags: plan.held,
    refusals: plan.refusals,
    warnings: plan.warnings,
    notes: plan.notes,
    ...(job ? { steps: job.labels.filter((l) => l !== 'check' && l !== 'verify'), writes: job.writes } : {}),
  };
}
