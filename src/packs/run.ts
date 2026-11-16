/**
 * Running one package (v3 F3a, ADR 0050): the pack and type looked up, the governance read, the plan made, then a
 * preview (a dry run, or any refusal with everything the plan found) or ONE job, which is a proposal whatever the
 * caller's scope while the pack's `alwaysPropose` is on (its first weeks), and a canonical one when it makes canon.
 * Every pack tool is this function with its own input schema; tests call it directly for a type defined only in test
 * data (the dummy Polity), through exactly the same engine.
 */
import { londonDate } from '../jobs/internal-steps.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { createCtx, withRequest, type CreateOutcome } from '../mcp/tools/create-support.js';
import { finish, repoContext } from '../mcp/tools/repo.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { runWriteJob } from '../mcp/tools/write-job.js';
import { buildPackJob, type PackJob } from './engine/job.js';
import { planPackage, type PackageInput, type PackPlan, type PlanEnv } from './engine/plan.js';
import { hookFor } from './hooks.js';

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

export async function runPackage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: RunPackageOptions,
): Promise<McpToolResult> {
  const packs = pd.services?.packs;
  if (!packs)
    return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Setting packs are not available here.' }, pd);
  const pack = packs.get(o.packId);
  if (!pack) return errorResult({ code: 'PACK_NOT_FOUND', message: `No pack ${o.packId}.` }, pd);
  const attachment = packs.attachment(pack.id, pd.project.id);
  if (!attachment) {
    const attached = packs.view(pack.id)?.attachments.map((a) => a.projectName) ?? [];
    return errorResult(
      {
        code: 'PACK_NOT_ATTACHED',
        message: `The ${pack.name} pack is not attached to the project ${pd.project.name}; its tools work only on ${attached.join(', ') || 'no project yet'}. Name one of those as project.`,
        attachedTo: attached,
      },
      pd,
    );
  }
  const type = pack.rules.types.find((t) => t.name.toLowerCase() === o.type.toLowerCase());
  if (!type)
    return errorResult(
      { code: 'PACK_TYPE_NOT_FOUND', message: `The ${pack.name} pack has no type ${o.type}.` },
      pd,
    );
  const hook = hookFor(type);
  if (!hook)
    return errorResult(
      {
        code: 'PACK_HOOK_MISSING',
        message: `The ${type.name} type names the hook “${type.hook ?? ''}”, which this bridge does not have.`,
      },
      pd,
    );
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
  const lifecycle = lifecycleFrom(settings);
  const cc = createCtx(pd, mctx, ctx, o.tool);
  const governance = await packs.governance(pack.id, { signal: mctx.signal });
  const env: PlanEnv = {
    pd,
    mctx,
    ctx,
    cc,
    tool: o.tool,
    pack,
    type,
    hook,
    templates: attachment.templates,
    lifecycle,
    governance,
    today: londonDate(Date.now()),
  };
  const plan = await planPackage(env, o.input);
  let job: PackJob | null = null;
  if (plan.refusals.length === 0) {
    const built = buildPackJob(env, plan);
    if (!built.ok) return built.result;
    job = built.value;
  }
  const preview = previewOf(plan, job, ctx.tree.node.bind(ctx.tree), ctx.projectId);
  if (plan.refusals.length > 0) {
    const first = plan.refusals[0]!;
    return errorResult(
      {
        code: first.code,
        message:
          plan.refusals.length === 1
            ? first.message
            : `${first.message} (and ${plan.refusals.length - 1} more refusal${plan.refusals.length === 2 ? '' : 's'}: see refusals)`,
        refusals: plan.refusals,
        ...(first.hint ? { hint: first.hint } : {}),
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
          prefetched: [...cc.sidebars.entries()].map(([resourceId, sb]) => ({
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
      if (images && (out.jobId || out.proposalId)) {
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
      }
      return { kind: 'job', head, labels: j.labels, ...out };
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
            : { page: c.page.rawName, change: `${c.section}: +${c.lines.length} line(s)`, lines: c.lines },
    ),
    assets: plan.images.map((i) => ({
      staged_id: i.stagedId,
      name: i.name,
      folder: i.path.join(' / '),
      ...(i.creates.length ? { createsFolders: i.creates.map((c) => c.name) } : {}),
    })),
    replacements: plan.replacements,
    heldTags: plan.held,
    refusals: plan.refusals,
    warnings: plan.warnings,
    notes: plan.notes,
    ...(job ? { steps: job.labels.filter((l) => l !== 'check' && l !== 'verify'), writes: job.writes } : {}),
  };
}
