/**
 * The Documents tools (v2 C2b, ADR 0034; PLAN-v2 section 5): `create_document` (a map, timeline or board on a page),
 * `update_document` (a document's settings only: name, hidden, full width, calendar, map image; pages and blank documents
 * are refused, their text is write_page's) and `delete_document` (`confirm: true`; a page's last document, or its only
 * page-type document, is refused: that is the page's content, deleted with write_page or delete_resource).
 *
 * Each is one job (or one proposal under `propose`), journalled and verified like every write; `dryRun` writes nothing.
 * Note (flagged in the C2b summary, not guarded): deleting a map, timeline or board of an Authoritative page removes
 * canonical content without canonical approval; the owner decides whether it should need it.
 */
import * as z from 'zod';
import { assessDelete, canonConfigFrom } from '../../facts/index.js';
import { VERIFY_STEP } from '../../jobs/internal-steps.js';
import type { StepSpec } from '../../jobs/index.js';
import type { TreeDocument, TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { withRequest, type CreateOutcome } from './create-support.js';
import { defineTool } from './define.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { CHANGE_ANNOTATIONS, CREATE_ANNOTATIONS, operationIdArg } from './resources.js';
import { pageRef } from './set-facts.js';
import { errorResult, projectArg, render, withProject, type ProjectDeps, type ToolDeps } from './shape.js';
import { runWriteJob } from './write-job.js';

type Obj = Record<string, unknown>;
const TYPES = { map: 'map', timeline: 'time', board: 'board' } as const;
const typeName = (t: string | null) => (t === 'time' ? 'timeline' : (t ?? 'unknown'));

/** A page of the repository (not the root), or the refusal. */
function pageOf(
  ctx: RepoCtx,
  query: string,
): { ok: true; node: TreeNode } | { ok: false; result: McpToolResult } {
  const r = resolvePage(ctx, query);
  if (!r.ok) return r;
  if (r.node.kind === 'root') {
    return {
      ok: false,
      result: errorResult(
        { code: 'ROOT_PAGE', message: 'The AI REPOSITORY page itself is not changed by the tools.' },
        ctx.pd,
      ),
    };
  }
  return r;
}

/** One document of a page, by id or name (without case), from the tree's list of its documents. */
function documentOf(
  pd: ProjectDeps,
  node: TreeNode,
  query: string,
): { ok: true; doc: TreeDocument } | { ok: false; result: McpToolResult } {
  const q = query.trim();
  const byId = node.documents.filter((d) => d.id === q);
  const hits =
    byId.length > 0 ? byId : node.documents.filter((d) => (d.name ?? '').toLowerCase() === q.toLowerCase());
  if (hits.length === 1) return { ok: true, doc: hits[0]! };
  return {
    ok: false,
    result: errorResult(
      {
        code: hits.length === 0 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_AMBIGUOUS',
        message:
          hits.length === 0
            ? `“${node.displayName}” has no document named or numbered “${q}”.`
            : `“${node.displayName}” has ${hits.length} documents named “${q}”; pass the id of the one you mean.`,
        documents: node.documents.map((d) => ({ id: d.id, name: d.name, type: typeName(d.type) })),
      },
      pd,
    ),
  };
}

/** A calendar by name or id (one listCalendars read). */
async function calendarOf(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  query: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; result: McpToolResult }> {
  const r = await liveRead(pd, mctx, tool, 'listCalendars', {});
  if (!r.ok) return r;
  const data = (r.value as { data?: unknown }).data;
  const list = (Array.isArray(data) ? (data as Obj[]) : []).map((c) => ({
    id: typeof c.id === 'string' ? c.id : '',
    name: typeof c.name === 'string' ? c.name : '',
  }));
  const q = query.trim().toLowerCase();
  const hits = list.filter((c) => c.id === query.trim() || c.name.toLowerCase() === q);
  if (hits.length === 1) return { ok: true, ...hits[0]! };
  return {
    ok: false,
    result: errorResult(
      {
        code: hits.length === 0 ? 'CALENDAR_NOT_FOUND' : 'CALENDAR_AMBIGUOUS',
        message: `${hits.length === 0 ? 'No' : 'More than one'} calendar named “${query}”. Calendars: ${list.map((c) => c.name).join(', ') || 'none'}.`,
        calendars: list,
      },
      pd,
    ),
  };
}

function createDocumentTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_document',
    title: 'Add a map, timeline or board to a page',
    access: 'write',
    description:
      'Adds a document to a page inside the AI REPOSITORY: a map, a timeline (optionally in a calendar, by name or id; see ' +
      'list_calendars) or a board. A document of the same name on the page is refused. Page text is written with ' +
      'write_page. Cost: 1 write (1 read more for a calendar), then 1 read to verify and the tree’s re-read.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      name: z.string().min(1).max(500).describe('The document’s name.'),
      type: z.enum(['map', 'timeline', 'board']),
      calendar: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Timelines only: the calendar its dates render in.'),
      hidden: z.boolean().optional(),
      fullWidth: z.boolean().optional(),
      dryRun: z.boolean().optional().describe('Show the plan; write nothing.'),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, 'create_document', args, null, async (): Promise<CreateOutcome> => {
          const p = pageOf(ctx, args.page);
          if (!p.ok) return { kind: 'answer', result: p.result };
          const node = p.node;
          const name = args.name.trim();
          const twin = node.documents.find((d) => (d.name ?? '').toLowerCase() === name.toLowerCase());
          if (twin) {
            return {
              kind: 'answer',
              result: errorResult(
                {
                  code: 'DOCUMENT_EXISTS',
                  message: `“${node.displayName}” already has a document named “${twin.name}” (${typeName(twin.type)}).`,
                  document: twin,
                },
                pd,
              ),
            };
          }
          if (args.calendar !== undefined && args.type !== 'timeline') {
            return {
              kind: 'answer',
              result: errorResult(
                { code: 'INVALID_PARAMS', message: 'Only a timeline takes a calendar.' },
                pd,
              ),
            };
          }
          let calendar: { id: string; name: string } | null = null;
          if (args.calendar !== undefined) {
            const c = await calendarOf(pd, mctx, 'create_document', args.calendar);
            if (!c.ok) return { kind: 'answer', result: c.result };
            calendar = { id: c.id, name: c.name };
          }
          const type = TYPES[args.type];
          const body = {
            name,
            type,
            ...(args.hidden !== undefined ? { isHidden: args.hidden } : {}),
            ...(args.fullWidth !== undefined ? { isFullWidth: args.fullWidth } : {}),
            ...(calendar ? { calendarId: calendar.id } : {}),
          };
          const fields: Obj = {
            ...(args.hidden !== undefined ? { isHidden: args.hidden } : {}),
            ...(args.fullWidth !== undefined ? { isFullWidth: args.fullWidth } : {}),
            ...(calendar ? { calendarId: calendar.id } : {}),
          };
          const page = { id: node.id, name: node.rawName };
          const head = {
            page,
            document: { name, type: args.type, ...(calendar ? { calendar: calendar.name } : {}) },
          };
          if (args.dryRun === true) {
            return {
              kind: 'answer',
              result: render({ ...head, status: 'dry_run', message: 'Dry run: nothing was written.' }, pd),
            };
          }
          const steps: StepSpec[] = [
            {
              op: 'createDocument',
              params: { path: { resourceId: node.id }, body },
              journalOperation: { tool: 'create_document', page },
            },
            {
              op: VERIFY_STEP,
              params: {
                body: {
                  targets: [
                    {
                      kind: 'document',
                      label: `${node.rawName} / ${name}`,
                      resourceId: node.id,
                      match: { name, type },
                      fields,
                    },
                  ],
                },
              },
            },
          ];
          const labels = [`add the ${args.type} “${name}” to ${node.rawName}`, 'verify'];
          const summary = `create_document: ${args.type} “${name}” on ${node.rawName}`;
          const out = await runWriteJob(pd, mctx, 'create_document', {
            steps,
            labels,
            title: summary,
            proposal: {
              operations: [{ tool: 'create_document', page, pageParts: [`${args.type} “${name}” added`] }],
              summary,
            },
            head,
            preview: () => head,
          });
          return { kind: 'job', head, labels, ...out };
        });
      }),
  });
}

function updateDocumentTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'update_document',
    title: 'Change a document’s settings',
    access: 'write',
    description:
      'Changes the settings of a map, timeline or board on a page inside the AI REPOSITORY: `name`, `hidden`, `fullWidth`, ' +
      '`calendar` (timelines) and `mapImage` (maps). Never its content. Page documents and blank documents are refused: ' +
      'change them with write_page. An unchanged setting sends nothing. Cost: 1 read (the document’s settings), 1 write (1 ' +
      'read more for a calendar), the journal’s read of the document, 1 read to verify.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: z.string().min(1).max(500).describe('The document (name or id).'),
      name: z.string().min(1).max(500).optional(),
      hidden: z.boolean().optional(),
      fullWidth: z.boolean().optional(),
      calendar: z.string().min(1).max(200).optional().describe('Timelines only.'),
      mapImage: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Maps only: LegendKeeper’s MapImageParams.'),
      dryRun: z.boolean().optional(),
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const p = pageOf(ctx, args.page);
        if (!p.ok) return p.result;
        const node = p.node;
        const d = documentOf(pd, node, args.document);
        if (!d.ok) return d.result;
        const doc = d.doc;
        if (doc.type === 'page' || doc.type === 'blank' || doc.type === null) {
          return errorResult(
            {
              code: 'DOCUMENT_IS_PAGE',
              message: `“${doc.name}” is a ${doc.type ?? 'blank'} document: its text and settings are changed with write_page, not update_document.`,
            },
            pd,
          );
        }
        if (args.calendar !== undefined && doc.type !== 'time') {
          return errorResult({ code: 'INVALID_PARAMS', message: 'Only a timeline takes a calendar.' }, pd);
        }
        if (args.mapImage !== undefined && doc.type !== 'map') {
          return errorResult({ code: 'INVALID_PARAMS', message: 'Only a map takes a map image.' }, pd);
        }
        // Its settings now (one read; also what the journal keeps): only what changes is sent.
        const read = await liveRead(pd, mctx, 'update_document', 'getDocument', {
          path: { resourceId: node.id, documentId: doc.id },
        });
        if (!read.ok) return read.result;
        const cur = (read.value ?? {}) as Obj;
        const body: Obj = {};
        if (args.name !== undefined && args.name.trim() !== doc.name) {
          const n = args.name.trim();
          const twin = node.documents.find(
            (x) => x.id !== doc.id && (x.name ?? '').toLowerCase() === n.toLowerCase(),
          );
          if (twin)
            return errorResult(
              {
                code: 'DOCUMENT_EXISTS',
                message: `“${node.displayName}” already has a document named “${twin.name}”.`,
              },
              pd,
            );
          body.name = n;
        }
        if (args.hidden !== undefined && args.hidden !== (cur.isHidden ?? false)) body.isHidden = args.hidden;
        if (args.fullWidth !== undefined && args.fullWidth !== (cur.isFullWidth ?? false))
          body.isFullWidth = args.fullWidth;
        if (args.mapImage !== undefined) body.mapImage = args.mapImage;
        if (args.calendar !== undefined) {
          const c = await calendarOf(pd, mctx, 'update_document', args.calendar);
          if (!c.ok) return c.result;
          if (c.id !== cur.calendarId) body.calendarId = c.id;
        }
        const page = { id: node.id, name: node.rawName };
        const document = { id: doc.id, name: doc.name, type: typeName(doc.type) };
        if (Object.keys(body).length === 0) {
          return render(
            { page, document, status: 'no_change', message: 'Nothing to change. Nothing was sent.' },
            pd,
          );
        }
        const { mapImage: _m, ...fields } = body;
        const head = { page, document, changes: body };
        if (args.dryRun === true)
          return render({ ...head, status: 'dry_run', message: 'Dry run: nothing was written.' }, pd);
        const steps: StepSpec[] = [
          {
            op: 'updateDocument',
            params: { path: { resourceId: node.id, documentId: doc.id }, body },
            journalOperation: { tool: 'update_document', page, document },
          },
          {
            op: VERIFY_STEP,
            params: {
              body: {
                targets: [
                  {
                    kind: 'document',
                    label: `${node.rawName} / ${doc.name}`,
                    resourceId: node.id,
                    documentId: doc.id,
                    fields,
                  },
                ],
              },
            },
          },
        ];
        const summary = `update_document: “${doc.name}” on ${node.rawName} (${Object.keys(body).join(', ')})`;
        const out = await runWriteJob(pd, mctx, 'update_document', {
          steps,
          labels: [`change ${Object.keys(body).join(', ')} of “${doc.name}”`, 'verify'],
          title: summary,
          proposal: {
            operations: [{ tool: 'update_document', page, pageParts: [`“${doc.name}” settings changed`] }],
            summary,
          },
          head,
          preview: () => head,
        });
        return out.result;
      }),
  });
}

function deleteDocumentTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'delete_document',
    title: 'Delete a document of a page',
    access: 'write',
    description:
      'Deletes one document (a map, timeline or board, or one of several page documents) of a page inside the AI ' +
      'REPOSITORY; LegendKeeper keeps it for a restore. `confirm: true` is required. The page’s last document, or its only ' +
      'page-type document, is refused: that is the page’s content (use write_page or delete_resource). Cost: 1 write, 1 read ' +
      'to verify, the tree’s re-read.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: z.string().min(1).max(500).describe('The document (name or id).'),
      confirm: z.literal(true).describe('Required: true.'),
      dryRun: z.boolean().optional(),
      project: projectArg,
    }),
    annotations: { ...CHANGE_ANNOTATIONS, destructiveHint: true },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const p = pageOf(ctx, args.page);
        if (!p.ok) return p.result;
        const node = p.node;
        const d = documentOf(pd, node, args.document);
        if (!d.ok) return d.result;
        const doc = d.doc;
        if (node.documents.length <= 1) {
          return errorResult(
            {
              code: 'DOCUMENT_LAST',
              message: `“${doc.name}” is the only document of “${node.displayName}”; deleting it would leave the page empty. Use write_page to change it, or delete_resource.`,
            },
            pd,
          );
        }
        if (doc.type === 'page' && node.documents.filter((x) => x.type === 'page').length === 1) {
          return errorResult(
            {
              code: 'DOCUMENT_ONLY_PAGE',
              message: `“${doc.name}” is the only page document of “${node.displayName}”: it is the page’s content. Use write_page to change it, or delete_resource.`,
            },
            pd,
          );
        }
        const page = { id: node.id, name: node.rawName };
        const document = { id: doc.id, name: doc.name, type: typeName(doc.type) };
        // Flagged for the owner, not guarded: a document of a page that is protected canon.
        const rules = canonConfigFrom(pd.services?.projectSettings?.(ctx.projectId)).active;
        const blocks = ctx.tree.sidebars(ctx.projectId, [node.id]).data.get(node.id) ?? [];
        const facts = blocks.flatMap((b) =>
          b.kind === 'keyValue'
            ? (b.rows ?? []).map((r) => ({ key: r.key, content: [{ text: r.text }] }))
            : [],
        );
        const canon = assessDelete(rules, facts, node.rawName).length > 0;
        const head = {
          page,
          document,
          ...(canon
            ? {
                note: 'The page is protected canon (Authoritative); deleting one of its documents is not guarded by canonical approval (an open question for the owner).',
              }
            : {}),
        };
        if (args.dryRun === true)
          return render({ ...head, status: 'dry_run', message: 'Dry run: nothing was deleted.' }, pd);
        const steps: StepSpec[] = [
          {
            op: 'deleteDocument',
            params: { path: { resourceId: node.id, documentId: doc.id } },
            journalOperation: { tool: 'delete_document', page, document },
            journalPreImage: { document },
          },
          {
            op: VERIFY_STEP,
            params: {
              body: {
                targets: [
                  {
                    kind: 'document',
                    label: `${node.rawName} / ${doc.name}`,
                    resourceId: node.id,
                    documentId: doc.id,
                    gone: true,
                  },
                ],
              },
            },
          },
        ];
        const summary = `delete_document: “${doc.name}” of ${node.rawName}`;
        const out = await runWriteJob(pd, mctx, 'delete_document', {
          steps,
          labels: [`delete “${doc.name}” of ${node.rawName}`, 'verify'],
          title: summary,
          proposal: {
            operations: [{ tool: 'delete_document', page, pageParts: [`“${doc.name}” deleted`] }],
            summary,
          },
          head,
          preview: () => head,
        });
        return out.result;
      }),
  });
}

export function documentTools(deps: ToolDeps): McpToolProvider[] {
  return [createDocumentTool(deps), updateDocumentTool(deps), deleteDocumentTool(deps)];
}
