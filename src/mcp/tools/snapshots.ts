/**
 * The snapshot tools (v2 E1a, ADR 0042; PLAN-v2 4.11 and section 5's Restore row):
 *
 * - `list_snapshots` (R): the snapshots of a page (by name or id, or a deleted page by id), of its sidebar or of one
 *   document, newest first, with the time, the kind and what changed from the snapshot before it. Free: the bridge's own
 *   index, no request to LegendKeeper.
 * - `snapshot_diff` (R): the Markdown diff of a document or a sidebar between a snapshot and the page now (a few reads),
 *   or between two snapshots (free).
 * - `restore_snapshot` (W): a page's documents, its sidebar, one document, or a deleted page, back to a chosen snapshot.
 *   ALWAYS a proposal, at every scope (`write` included): the owner approves it on the dashboard. `dryRun` shows the plan.
 */
import * as z from 'zod';
import { mcpOrigin } from '../../policy/mcp.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { repoContext, resolvePage } from './repo.js';
import { CHANGE_ANNOTATIONS } from './resources.js';
import {
  canonicalBody,
  errorFromThrown,
  errorResult,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { RestoreError } from '../../snapshots/restore.js';
import { diffText } from '../../snapshots/diff.js';
import { historyOf, pieceFilterOf, pieceNow, pieceThen } from '../../snapshots/history.js';
import { imageRestoreDeps, restoreImage } from '../../snapshots/image-restore.js';

const ID_ONLY = /^(lk:\/\/resources\/)?([a-z][0-9a-z]{5,31})$/;

const pieceArg = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe(
    'What of the page: "sidebar", "settings" (its name, tags, icon…), or a document by name or id. Omitted: everything.',
  );

/** The page a snapshot tool is about: a page in the tree by name or id, or (any id) a page only the snapshots know. */
function pageOf(
  pd: ProjectDeps,
  page: string,
):
  | { ok: true; id: string; name: string; live: boolean }
  | { ok: false; result: ReturnType<typeof errorResult> } {
  const svc = pd.services?.snapshots;
  const rc = repoContext(pd);
  if (rc.ok) {
    const r = resolvePage(rc.ctx, page);
    if (r.ok) return { ok: true, id: r.node.id, name: r.node.rawName, live: true };
    const m = ID_ONLY.exec(page.trim());
    if (m && svc && svc.index.pageHistory(pd.project.id, m[2]!, { limit: 1 }).length > 0) {
      const name =
        svc.index.pageHistory(pd.project.id, m[2]!, { limit: 50 }).find((x) => x.name)?.name ?? m[2]!;
      return { ok: true, id: m[2]!, name, live: false };
    }
    return { ok: false, result: r.result };
  }
  const m = ID_ONLY.exec(page.trim());
  if (m && svc) return { ok: true, id: m[2]!, name: m[2]!, live: false };
  return { ok: false, result: rc.result };
}

function listSnapshotsTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'list_snapshots',
    title: 'List the snapshots of a page',
    access: 'read',
    description:
      'Lists the snapshots the bridge holds of a page (or its sidebar, its settings, or one document), newest first: when, ' +
      'the kind (full: the weekly snapshot of everything; change: after a bridge write; daily: an edit made in the app), ' +
      'and for each piece whether it changed from the snapshot before. A deleted page is found by its id. Cost: none (the ' +
      'bridge’s own index, no request to LegendKeeper). Use snapshot_diff to see a change, restore_snapshot to propose ' +
      'bringing one back.',
    inputSchema: z.object({
      page: z.string().min(1).max(500).describe('The page: a name or id (a deleted page: its id).'),
      piece: pieceArg,
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('At most this many snapshots (default 30).'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: (args) =>
      withProject(deps, args.project, 'read', (pd) => {
        const svc = pd.services?.snapshots;
        if (!svc)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'Snapshots are not running in this bridge.' },
            pd,
          );
        const page = pageOf(pd, args.page);
        if (!page.ok) return page.result;
        const f = pieceFilterOf(svc, pd.project.id, page.id, args.piece);
        if ('error' in f)
          return errorResult({ code: 'NOT_FOUND', message: f.error, documents: f.documents }, pd);
        const limit = args.limit ?? 30;
        const h = historyOf(svc, pd.project.id, page.id, f, limit);
        return render(
          {
            page: { id: page.id, name: page.name, deleted: !page.live },
            of: f.label,
            count: h.count,
            snapshots: h.snapshots,
            ...(h.more ? { more: h.more } : {}),
            hint:
              h.count === 0
                ? 'The bridge holds no snapshot of this page yet (the weekly full snapshot takes every page; every bridge write takes a change snapshot).'
                : 'snapshot_diff shows what changed; restore_snapshot proposes bringing a snapshot back (the owner approves it).',
          },
          pd,
        );
      }),
  });
}

function snapshotDiffTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'snapshot_diff',
    title: 'Diff a snapshot',
    access: 'read',
    description:
      'The Markdown diff of a page’s document, sidebar or settings between a snapshot and the page now (`to` left out), ' +
      'or between two snapshots. Cost: against now 1 read, plus the document’s own reads (a page 1, a map 2, a timeline 3 ' +
      'or more, a board 1); between two snapshots none. Keep regions show as one placeholder line each. Lines starting ' +
      '“-” are the older state (`from`), “+” the newer.',
    inputSchema: z.object({
      page: z.string().min(1).max(500).describe('The page: a name or id (a deleted page: its id).'),
      piece: z.string().min(1).max(500).describe('"sidebar", "settings", or a document by name or id.'),
      from: z.string().min(1).max(64).describe('A snapshot id (list_snapshots).'),
      to: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Another snapshot id; left out, the page as it is now.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: (args) =>
      withProject(deps, args.project, 'read', async (pd) => {
        const svc = pd.services?.snapshots;
        if (!svc)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'Snapshots are not running in this bridge.' },
            pd,
          );
        const page = pageOf(pd, args.page);
        if (!page.ok) return page.result;
        const f = pieceFilterOf(svc, pd.project.id, page.id, args.piece);
        if ('error' in f)
          return errorResult({ code: 'NOT_FOUND', message: f.error, documents: f.documents }, pd);
        try {
          const before = await pieceThen(svc, pd.project.id, page.id, f, args.from);
          let after: string;
          let reads = 0;
          if (args.to) after = await pieceThen(svc, pd.project.id, page.id, f, args.to);
          else {
            const now = await pieceNow(svc, pd.project.id, page.id, f);
            after = now.text;
            reads = now.reads;
          }
          const d = diffText(before, after);
          return render(
            {
              page: { id: page.id, name: page.name },
              of: f.label,
              from: args.from,
              to: args.to ?? 'now',
              identical: d.identical,
              added: d.diff.added,
              removed: d.diff.removed,
              diff: d.text,
              reads,
            },
            pd,
          );
        } catch (e) {
          if (e instanceof RestoreError)
            return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
          return errorFromThrown(e, pd);
        }
      }),
  });
}

function restoreSnapshotTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'restore_snapshot',
    title: 'Propose a restore from a snapshot',
    access: 'write',
    description:
      'Proposes bringing back a page’s documents (`scope: "page"`), its sidebar (`"sidebar"`), one document (`"document"`, ' +
      'with `document`), or a deleted page with its content (`"deleted"`) as they were at a snapshot (list_snapshots). ALWAYS ' +
      'a proposal, whatever your scope: nothing is written until the owner approves it on the dashboard; follow it with ' +
      'bridge_proposal_status. The plan says what cannot be restored exactly (unsupported blocks no longer on the page, ' +
      'inline icons, board pages) and what is left alone (documents added since). A restore never changes a page’s ' +
      'lifecycle state (refused: use the lifecycle tools); one that makes something canon needs the owner’s canonical ' +
      'approval. A deleted page is undeleted while LegendKeeper keeps it (its content then follows as a second proposal), ' +
      'or recreated under its snapshot parent (`mode: "recreate"`; `ids: "new"` when its old id is refused). A deleted ' +
      'image (`scope: "image"`, `asset`: its old id) comes back as a NEW asset with a new URL: it is staged (hidden) at ' +
      'once and the proposal places it; `updateReferences: true` also updates the pages that showed the old URL. `dryRun: ' +
      'true` shows the plan and its diff and proposes nothing. Cost to plan: 1–2 reads plus the documents’ own reads.',
    inputSchema: z.object({
      page: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('The page: a name or id (a deleted page: its id). Not used for scope "image".'),
      snapshot: z
        .string()
        .min(1)
        .max(64)
        .describe('The snapshot to restore to (list_snapshots gives its id).'),
      scope: z.enum(['page', 'sidebar', 'document', 'deleted', 'image']).describe('What to restore.'),
      asset: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          'For scope "image": the deleted image’s old asset id (it comes back as a new asset, with a new URL).',
        ),
      updateReferences: z
        .boolean()
        .optional()
        .describe(
          'For scope "image": also update the pages that referred to the old URL (page documents and map images).',
        ),
      document: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('For scope "document": the document’s name or id.'),
      mode: z
        .enum(['auto', 'undelete', 'recreate'])
        .optional()
        .describe('For scope "deleted" (default auto: undelete when recently deleted).'),
      ids: z
        .enum(['original', 'new'])
        .optional()
        .describe('For a recreated page: its original id (default) or a new one.'),
      parent: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('For a recreated page whose parent is gone: where it goes (a name or id).'),
      dryRun: z.boolean().optional().describe('Show the plan and its diff; propose nothing.'),
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const restores = pd.services?.restores;
        if (!restores)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'Snapshots are not running in this bridge.' },
            pd,
          );
        if (args.scope === 'image') return imageScope(pd, args, mctx);
        if (!args.page)
          return errorResult(
            { code: 'INVALID_PARAMS', message: `Scope "${args.scope}" needs page (a name or id).` },
            pd,
          );
        const page = pageOf(pd, args.page);
        if (!page.ok) return page.result;
        let parentId: string | undefined;
        if (args.parent) {
          const rc = repoContext(pd);
          if (!rc.ok) return rc.result;
          const r = resolvePage(rc.ctx, args.parent);
          if (!r.ok) return r.result;
          parentId = r.node.id;
        }
        let documentId: string | undefined;
        if (args.scope === 'document') {
          if (!args.document)
            return errorResult(
              { code: 'INVALID_PARAMS', message: 'Scope "document" needs document (its name or id).' },
              pd,
            );
          const f = pieceFilterOf(pd.services.snapshots!, pd.project.id, page.id, args.document);
          if ('error' in f)
            return errorResult({ code: 'NOT_FOUND', message: f.error, documents: f.documents }, pd);
          documentId = f.ref;
        }
        try {
          const input = {
            projectId: pd.project.id,
            pageId: page.id,
            snapshotId: args.snapshot,
            scope: args.scope,
            ...(documentId ? { documentId } : {}),
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.ids ? { ids: args.ids } : {}),
            ...(parentId ? { parentId } : {}),
          } as const;
          const plan = await restores.plan(input);
          const view = {
            page: plan.page,
            scope: plan.scope,
            ...(plan.mode ? { mode: plan.mode } : {}),
            snapshot: {
              id: plan.snapshot.id,
              takenAt: new Date(plan.snapshot.takenAt).toISOString(),
              kind: plan.snapshot.kind,
            },
            summary: plan.summary,
            changes: plan.pieces.map((p) => ({ piece: p.label, diff: p.diff })),
            writes: plan.steps.filter((s) => !s.op.startsWith('bridge.')).length,
            ...(plan.lost.length ? { cannotRestore: plan.lost } : {}),
            ...(plan.kept.length ? { kept: plan.kept } : {}),
            ...(plan.notRestored.length ? { notRestored: plan.notRestored } : {}),
            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            ...(plan.idMap ? { idMap: plan.idMap } : {}),
            ...(plan.followUp
              ? {
                  followUp:
                    'once it has run, a second proposal brings the page’s content back to the snapshot',
                }
              : {}),
            reads: plan.reads,
          };
          if (plan.empty)
            return render(
              {
                status: 'nothing_to_do',
                ...view,
                hint: 'The page already matches the snapshot here; nothing was proposed.',
              },
              pd,
            );
          if (args.dryRun) return render({ status: 'dry_run', ...view }, pd);
          const origin = mcpOrigin(mctx, 'restore_snapshot');
          const r = await restores.propose(input, origin, origin.principal?.principalId ?? 'unknown', plan);
          if (r.status === 'nothing_to_do') return render({ status: 'nothing_to_do', ...view }, pd);
          return render(
            {
              status: 'proposal_captured',
              proposalId: r.proposalId,
              ...view,
              ...canonicalBody(
                r,
                'A restore is always a proposal (whatever your scope): nothing was written.',
              ),
            },
            pd,
          );
        } catch (e) {
          if (e instanceof RestoreError)
            return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
          return errorFromThrown(e, pd);
        }
      }),
  });
}

/** Scope "image": a deleted image back as a new asset (staged now, placed by the proposal), its references optional. */
async function imageScope(
  pd: ProjectDeps,
  args: {
    snapshot: string;
    asset?: string | undefined;
    updateReferences?: boolean | undefined;
    dryRun?: boolean | undefined;
  },
  mctx: Parameters<typeof mcpOrigin>[0],
) {
  const s = pd.services!;
  if (!args.asset)
    return errorResult(
      { code: 'INVALID_PARAMS', message: 'Scope "image" needs asset: the deleted image’s old asset id.' },
      pd,
    );
  if (!s.images || !s.snapshots)
    return errorResult(
      { code: 'TOOL_UNAVAILABLE', message: 'The image pipeline is not running in this bridge.' },
      pd,
    );
  try {
    const r = await restoreImage(
      imageRestoreDeps({
        svc: s.snapshots,
        engine: pd.engine,
        images: s.images,
        assets: s.assets,
        tree: s.tree,
        projectId: pd.project.id,
      }),
      {
        projectId: pd.project.id,
        snapshotId: args.snapshot,
        assetId: args.asset,
        updateReferences: args.updateReferences === true,
      },
      mcpOrigin(mctx, 'restore_snapshot'),
      { ...(args.dryRun ? { dryRun: true } : {}) },
    );
    if (r.status === 'dry_run') return render({ ...r, scope: 'image' }, pd);
    if (r.status === 'staging')
      return render(
        {
          ...r,
          scope: 'image',
          hint: 'The image is being staged (uploaded and hidden) first; call restore_snapshot again with the same arguments once its job ends (bridge_job_status). It is not uploaded twice.',
        },
        pd,
      );
    return render(
      {
        ...r,
        scope: 'image',
        ...canonicalBody(
          r,
          'A restore is always a proposal (whatever your scope): the image is staged (hidden) and waits for the owner.',
        ),
      },
      pd,
    );
  } catch (e) {
    if (e instanceof RestoreError) return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
    return errorFromThrown(e, pd);
  }
}

export function snapshotTools(deps: ToolDeps): McpToolProvider[] {
  return [listSnapshotsTool(deps), snapshotDiffTool(deps), restoreSnapshotTool(deps)];
}
