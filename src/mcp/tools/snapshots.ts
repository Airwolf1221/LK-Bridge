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
import { missingPiecesOf } from '../../snapshots/manifest.js';
import * as z from 'zod';
import { mcpOrigin } from '../../policy/mcp.js';
import type { McpToolProvider } from '../server.js';
import { lastMajorRevisionArg } from './schemas.js';
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
import { RestoreError, type RestoreEstimate } from '../../snapshots/restore.js';
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
      'Lists the bridge’s own snapshots of a page (or its sidebar, settings or one document), newest first: when, the kind (full: nightly, which also catches edits made in the app; change: after a bridge write) and which pieces changed. A deleted page is found by its id. Next: snapshot_diff to see a change, restore_snapshot to propose bringing one back. Cost: none.',
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
        const limit = args.limit ?? 30;
        const h = historyOf(svc, pd.project.id, page.id, f, limit);
        // v3 F2 (ADR 0049 decision 4): a partial snapshot says what it is missing, in summary form: how many pieces in
        // all, and this page's own (piece, reference, reason). One manifest read per partial snapshot; no LK call.
        const snapshots = await Promise.all(
          h.snapshots.map(async (e) => {
            if (!e.partial) return e;
            const m = await svc.manifest(e.snapshot).catch(() => null);
            if (!m) return e;
            const all = missingPiecesOf(m);
            const here = all.filter((x) => x.pageId === page.id);
            return {
              ...e,
              missing: {
                total: all.length,
                ...(here.length > 0
                  ? {
                      thisPage: here.slice(0, 10).map((x) => ({
                        piece: x.piece,
                        ...(x.ref !== undefined ? { ref: x.ref } : {}),
                        reason: x.reason.slice(0, 200),
                      })),
                    }
                  : {}),
                ...(all.length > here.length ? { otherPages: all.length - here.length } : {}),
              },
            };
          }),
        );
        return render(
          {
            page: { id: page.id, name: page.name, deleted: !page.live },
            of: f.label,
            count: h.count,
            snapshots,
            ...(h.more ? { more: h.more } : {}),
            hint:
              h.count === 0
                ? 'The bridge holds no snapshot of this page yet (the nightly full snapshot takes every page; every bridge write takes a change snapshot).'
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
      'The Markdown diff of a page’s document, sidebar or settings between a snapshot and now (leave `to` out), or between two snapshots. Keep regions show as one line each; "-" is the older state, "+" the newer. Cost: against now 1 read plus the document’s own (page 1, map 2, timeline 3 or more); between two snapshots none.',
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

/**
 * v2 E5.5 (backlog 16): the restore's time once approved, in a few words, with the per-write figure it assumes (the
 * measured median of the project's recent write steps, or the spacing) and any learned operation limit that paces it.
 */
function estimateLine(e: RestoreEstimate): Record<string, unknown> {
  const ms = e.wallClockMs ?? 0;
  const pw = e.figures?.perWrite;
  return {
    about:
      ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round((ms / 60_000) * 10) / 10} min`,
    writes: e.writes,
    ...(pw
      ? {
          secondsPerWrite: Math.round(pw.ms / 100) / 10,
          perWriteFrom:
            pw.from === 'measured'
              ? `the median of the last ${pw.samples} write steps`
              : 'the configured write spacing',
        }
      : {}),
    ...(e.figures && e.figures.groups.length > 0
      ? {
          learnedLimits: e.figures.groups.map(
            (g) =>
              `${g.group}: ${g.limit} per ${g.windowMs <= 60_000 ? 'minute' : g.windowMs <= 3_600_000 ? 'hour' : 'day'}`,
          ),
        }
      : {}),
  };
}

function restoreSnapshotTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'restore_snapshot',
    title: 'Propose a restore from a snapshot',
    access: 'write',
    description:
      'Proposes bringing back a page’s documents (scope "page"), its sidebar ("sidebar"), one document ("document", with `document`), a deleted page with its content ("deleted") or a deleted image ("image") as they were at a snapshot (list_snapshots). Use it to undo a mistake, not to edit: to change a page, write it. ALWAYS a proposal, whatever your scope: nothing is written until the owner approves; never retry it, follow it with bridge_proposal_status. dryRun shows the plan, the diff and what cannot be restored exactly (unsupported blocks, inline icons, board pages): tell the person. A restored image is a NEW asset with a new URL (updateReferences: true also updates the pages that showed the old one). A restore never changes a page’s lifecycle state. Cost to plan: 1 to 2 reads plus the documents’ own.',
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
      lastMajorRevision: lastMajorRevisionArg,
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
            ...(args.lastMajorRevision ? { lastMajorRevision: args.lastMajorRevision } : {}),
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
            ...(plan.estimate?.wallClockMs != null ? { estimate: estimateLine(plan.estimate) } : {}),
          };
          if (plan.empty)
            return render(
              {
                status: 'nothing_to_do',
                ...view,
                // v2 E4 (RV4-3): "already matches" only when nothing is listed as not restored; otherwise say what is not.
                hint:
                  plan.notRestored.length > 0 || plan.lost.length > 0
                    ? 'Nothing this restore covers needs writing, and nothing was proposed; but the page is NOT simply as it was at the snapshot: what is listed under notRestored (and lost) is not restored by this tool. Tell the person; those parts are restored by hand.'
                    : 'The page already matches the snapshot here; nothing was proposed.',
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

/** Scope "image": a deleted image back as a new asset (kept on the bridge’s server, uploaded on approval), its references optional. */
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
    return render(
      {
        ...r,
        scope: 'image',
        ...canonicalBody(
          r,
          'A restore is always a proposal (whatever your scope): the image waits on the bridge’s server, and nothing is sent to LegendKeeper until the owner approves.',
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
