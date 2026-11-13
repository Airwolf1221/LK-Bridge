/**
 * `write_page` (v2 C1, ADR 0031; PLAN-v2 4.7, section 5, 10.2 and 10.6): the main way agents change the owner's pages.
 *
 * 1. Plan, before anything is queued: one read of the document, B1's `applyEdit`, the version rules (src/pages/plan.ts).
 *    Every refusal is typed; an empty plan writes nothing; `dryRun` stops here with the plan and the Markdown diff.
 * 2. Write: ONE `replaceDocumentBlocks` job under the document lock, with If-Match. Inside the lock the engine reads the
 *    document again and compares its version with the plan's (the bridge's own compare-and-swap); a section edit whose
 *    section is unchanged is re-planned there (src/pages/replan.ts), anything else is a conflict. The journal keeps the
 *    pre-image and the high-level operation. Every unsupported block is echoed by id (the converter keeps them; the
 *    engine's guard refuses otherwise).
 * 3. Verify: still inside the lock, the document is read back and compared with the blocks sent. A difference is
 *    reported ("written but not as planned"), with the journal entry for recovery, and never retried.
 * At scope `propose` (or whenever policy turns the write into a proposal) the same plan is captured as a proposal holding
 * the high-level operation and its expansion; the owner approves exactly what it shows.
 */
import * as z from 'zod';
import { VersionConflictError, type VerifiedWriteValue } from '../../jobs/index.js';
import { operationInputSchema } from '../../lk/registry.js';
import { MarkdownError, toMarkdown, type EditMode } from '../../markdown/index.js';
import {
  markdownDiff,
  pageConverterContext,
  mentionChoices,
  PageVersionConflictError,
  planPageWrite,
  SECTION_MODES,
  sha256,
  unifiedText,
  WRITE_PAGE_PLANNER,
  type PagePlan,
  type WritePageReplanInput,
} from '../../pages/index.js';
import type { McpToolProvider, McpToolResult } from '../server.js';
import { defineTool } from './define.js';
import { pickDocument } from './read-document.js';
import { finish, liveRead, repoContext, resolvePage } from './repo.js';
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

export const WRITE_PAGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** The largest Markdown write_page takes (characters): about five times the largest page of the test world. */
export const WRITE_PAGE_MARKDOWN_MAX = 1_000_000;

const MODES = ['append', 'prepend', 'replace', 'replace_section', 'append_to_section'] as const;

/** Where to go for documents write_page does not write. */
const OTHER_TOOLS: Record<string, string> = {
  map: 'a map: change its features with create_map_feature, update_map_feature and delete_map_feature, and its image with update_document',
  time: 'a timeline: change its events with the timeline tools when they are in your tool list, or lk_api_write (createEvent, updateEvent, deleteEvent)',
  board:
    'a board: change its shapes with lk_api_write (createBoardShapes, updateBoardShapes, deleteBoardShapes)',
};

const CONFLICT_HINT =
  'Nothing was written. Do not retry the same call: read the page (or the section) again with read_document, redo your edit on what it holds now, and pass the version it returns as baseVersion.';

function conflictResult(e: VersionConflictError, pd: ProjectDeps): McpToolResult {
  if (e instanceof PageVersionConflictError) {
    const j = e.toJSON() as Record<string, unknown>;
    return errorResult(
      {
        code: 'VERSION_CONFLICT',
        reason: e.reason,
        message: e.message,
        baseVersion: e.sentVersion,
        currentVersion: e.currentVersion,
        ...Object.fromEntries(
          Object.entries(j).filter(
            ([k]) =>
              ![
                'name',
                'code',
                'message',
                'opId',
                'sentVersion',
                'currentVersion',
                'reason',
                'stepNo',
              ].includes(k),
          ),
        ),
        hint: CONFLICT_HINT,
      },
      pd,
    );
  }
  return errorResult(
    {
      code: 'VERSION_CONFLICT',
      reason: 'changed_while_waiting',
      message: `The page changed between the plan (version ${e.sentVersion ?? '?'}) and the write${e.currentVersion ? ` (it is now ${e.currentVersion})` : ''}: the bridge checks the version again inside the page's lock, and only a section edit whose section is unchanged is re-planned there.`,
      baseVersion: e.sentVersion,
      currentVersion: e.currentVersion,
      ...(e.jobId ? { jobId: e.jobId } : {}),
      hint: CONFLICT_HINT,
    },
    pd,
  );
}

/**
 * The page as it would be sent, against LegendKeeper's write schema (the registry's, as the engine checks it). The
 * converter checks what is new or changed; this finds blocks the page ALREADY holds that the API returns but would not
 * take back (for example text with an inline icon, which its run format cannot express). write_page sends the whole
 * document, so such a page cannot be written without changing them: refused, naming them, before anything is queued.
 */
function unwritableBlocks(
  path: Record<string, string>,
  version: string,
  blocks: readonly unknown[],
): { id: string | null; kind: string; at: string; problem: string }[] {
  const parsed = operationInputSchema('replaceDocumentBlocks').safeParse({
    path,
    ifMatch: version,
    body: { blocks },
  });
  if (parsed.success) return [];
  const out = new Map<string, { id: string | null; kind: string; at: string; problem: string }>();
  for (const issue of parsed.error.issues) {
    const segs = issue.path.map(String);
    if (segs[0] !== 'body' || segs[1] !== 'blocks') continue;
    // The innermost block on the issue's path (blocks.N.children.M…).
    let list: unknown = blocks;
    let block: Record<string, unknown> | undefined;
    let at = '';
    for (let i = 2; i < segs.length; i++) {
      const k = segs[i]!;
      if (Array.isArray(list) && /^\d+$/.test(k)) {
        const b = list[Number(k)] as Record<string, unknown> | undefined;
        if (!b || typeof b !== 'object') break;
        block = b;
        at += `[${k}]`;
        if (segs[i + 1] === 'children') {
          list = b.children;
          at += '.children';
          i++;
        } else break;
      } else break;
    }
    const id = typeof block?.id === 'string' ? block.id : null;
    const key = `${id ?? at}`;
    if (!out.has(key))
      out.set(key, {
        id,
        kind: typeof block?.kind === 'string' ? block.kind : '?',
        at: `blocks${at}`,
        problem: issue.message,
      });
  }
  return [...out.values()];
}

function summaryLine(p: PagePlan): string {
  const c = p.counts;
  return `${c.kept} kept, ${c.changed} changed, ${c.added} added, ${c.removed} removed${c.moved ? `, ${c.moved} moved` : ''}; ${c.regionsKept} keep region(s) kept${c.regionsDropped ? `, ${c.regionsDropped} dropped` : ''}`;
}

export function writePageTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'write_page',
    title: 'Write a page (Markdown)',
    access: 'write',
    description:
      'Changes the text of one page document with Markdown (rules: get_markdown_guide). Facts and links are set_facts; maps, timelines and boards have their own tools (refused here). Read the page first with read_document and pass its version as baseVersion: a stale version is refused, though a section edit still goes ahead if its section is unchanged. Modes: append, prepend, replace (the whole page: every keep region must be in it or named in dropRegions), replace_section (start with the heading to replace it too) and append_to_section; `section` is a heading path such as "Biography > Early Life". Prefer the section modes: they touch nothing else. Unchanged text keeps its ids and styling; an unchanged page writes nothing. dryRun returns the plan and the diff and writes nothing. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Avoid: writing a page you have not read; replace when a section edit will do; retrying VERSION_CONFLICT unchanged (read again, redo the edit on what it holds now). Cost: 2 reads, 1 write and 1 verify read (a dry run or a proposal: 1 read).',
    inputSchema: z.object({
      page: z.string().min(1).max(500).describe('Page name or id (inside the AI REPOSITORY).'),
      document: z.string().min(1).max(500).optional().describe('Document name or id. Default "Main".'),
      mode: z.enum(MODES).describe('append, prepend, replace, replace_section or append_to_section.'),
      section: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Heading path for the section modes, e.g. "Biography > Early Life" (add [n] to pick a repeated heading).',
        ),
      markdown: z
        .string()
        .max(WRITE_PAGE_MARKDOWN_MAX)
        .describe('The Markdown to write (the owner’s schema).'),
      baseVersion: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('The version read_document returned. Strongly recommended.'),
      dropRegions: z
        .array(z.string().min(1).max(256))
        .max(1000)
        .optional()
        .describe('Keep-region block ids you deliberately remove (replace modes).'),
      dryRun: z.boolean().optional().describe('Return the plan and the Markdown diff; write nothing.'),
      detail: z.enum(['summary', 'full']).optional().describe('"full" adds the Markdown diff to the result.'),
      project: projectArg,
    }),
    annotations: WRITE_PAGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const mode: EditMode = args.mode;
        const sectional = SECTION_MODES.has(mode);
        if (sectional && args.section === undefined) {
          return errorResult(
            {
              code: 'INVALID_PARAMS',
              message: `Mode ${mode} needs section: a heading path such as "Biography > Early Life" (read_document with outline: true lists them).`,
            },
            pd,
          );
        }
        if (!sectional && args.section !== undefined) {
          return errorResult(
            {
              code: 'INVALID_PARAMS',
              message: `Mode ${mode} works on the whole page; leave section out, or use replace_section or append_to_section.`,
            },
            pd,
          );
        }
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const resolved = resolvePage(ctx, args.page);
        if (!resolved.ok) return resolved.result;
        const node = resolved.node;
        const picked = pickDocument(ctx, node, args.document);
        if (!picked.ok) return picked.result;
        const doc = picked.doc;
        const other = doc.type ? OTHER_TOOLS[doc.type] : undefined;
        if (other) {
          return errorResult(
            {
              code: 'WRONG_TOOL_FOR_DOCUMENT',
              message: `“${doc.name ?? doc.id}” on “${node.displayName}” is ${other}. write_page writes page documents only.`,
              document: { id: doc.id, name: doc.name, type: doc.type },
            },
            pd,
          );
        }
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

        // 1. Plan: one read, B1's applyEdit, the version rules.
        const path = { resourceId: node.id, documentId: doc.id };
        const read = await liveRead(pd, mctx, 'write_page', 'getDocumentBlocks', { path });
        if (!read.ok) return read.result;
        const body = (read.value ?? {}) as { version?: unknown; blocks?: unknown };
        if (typeof body.version !== 'string' || !Array.isArray(body.blocks)) {
          return errorResult(
            {
              code: 'BRIDGE_ERROR',
              message: 'LegendKeeper returned the document without a version or blocks.',
            },
            pd,
          );
        }
        const current = { version: body.version, blocks: body.blocks as never[] };
        const rendered = toMarkdown({ blocks: current.blocks });
        const versions = pd.services?.versions;
        versions?.remember(ctx.projectId, doc.id, current.version, rendered.markdown);
        let plan: PagePlan;
        try {
          plan = planPageWrite(
            current,
            {
              mode,
              ...(args.section !== undefined ? { section: args.section } : {}),
              markdown: args.markdown,
              ...(args.dropRegions ? { dropRegions: args.dropRegions } : {}),
            },
            converter,
            {
              rendered,
              ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
              markdownAt: (v) => versions?.markdownAt(ctx.projectId, doc.id, v),
            },
          );
        } catch (e) {
          if (e instanceof VersionConflictError) return conflictResult(e, pd);
          if (e instanceof MarkdownError) {
            return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
          }
          return errorFromThrown(e, pd);
        }
        const unwritable = plan.plan.empty ? [] : unwritableBlocks(path, plan.version, plan.blocks);
        if (unwritable.length > 0) {
          return errorResult(
            {
              code: 'PAGE_NOT_WRITABLE',
              message:
                `LegendKeeper's API would refuse this page as written back: ${unwritable.length} block(s) the page already holds ` +
                `(${unwritable
                  .slice(0, 10)
                  .map((b) => `${b.id ?? b.at} (${b.kind})`)
                  .join(
                    ', ',
                  )}) have content its write format has no form for, for example text with an inline icon. ` +
                'write_page sends the whole document, so it cannot write this page without changing those blocks. Nothing was written. ' +
                'Tell the person: the text has to be changed in the LegendKeeper app, or the owner can split the blocks on the dashboard (Audits). ' +
                'Do not try replaceDocumentBlocks or another low-level route: it would drop what the page holds. read_document, get_resource and set_facts still work on this page.',
              blocks: unwritable.slice(0, 50),
            },
            pd,
          );
        }
        const head = {
          page: { id: node.id, name: node.displayName, path: node.path.names.join(' / ') },
          document: { id: doc.id, name: doc.name },
          mode,
          ...(plan.section ? { section: plan.section.path } : args.section ? { section: args.section } : {}),
          ...(choices.length > 0 ? { mentions: mentionChoices(choices) } : {}),
        };
        const warnings =
          plan.warnings.length > 0
            ? {
                warnings: plan.warnings.map((w) => ({
                  code: w.code,
                  message: w.message,
                  ...(w.at ? { at: w.at } : {}),
                })),
              }
            : {};
        const rebased = plan.rebasedFrom
          ? {
              note: `baseVersion ${plan.rebasedFrom} is older than the page (${plan.version}), but the section is unchanged since then, so the edit was planned on the current page.`,
            }
          : {};
        if (plan.plan.empty) {
          return render(
            {
              ...head,
              status: 'no_change',
              version: plan.version,
              message: 'Nothing to write: the page already holds this. Nothing was sent.',
              ...warnings,
            },
            pd,
          );
        }
        const diff = markdownDiff(plan.before, plan.after);
        const diffBody = (full: boolean) =>
          full
            ? { diff: unifiedText(diff), diffLines: { added: diff.added, removed: diff.removed } }
            : { diffLines: { added: diff.added, removed: diff.removed } };
        const counts = { ...plan.counts };
        const preview = () => ({ ...head, counts, diffLines: { added: diff.added, removed: diff.removed } });

        if (args.dryRun === true) {
          return finish(
            pd,
            mctx,
            'write_page',
            {
              ...head,
              status: 'dry_run',
              plannedOn: plan.version,
              counts,
              summary: summaryLine(plan),
              ...rebased,
              ...warnings,
              ...diffBody(true),
              message: 'Dry run: nothing was written and nothing was proposed.',
            },
            preview,
          );
        }

        // 2. Write: one job under the document lock (compare-and-swap, re-plan for an unchanged section, verify).
        const markdownSha256 = sha256(args.markdown);
        const journalOperation = {
          tool: 'write_page',
          mode,
          ...(head.section ? { section: head.section } : {}),
          markdownSha256,
          markdownChars: args.markdown.length,
          plannedOn: plan.version,
          ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
          ...(args.dropRegions && args.dropRegions.length > 0 ? { dropRegions: args.dropRegions } : {}),
        };
        const replanInput: WritePageReplanInput | undefined =
          sectional && plan.section && args.section !== undefined
            ? {
                mode,
                section: args.section,
                markdown: args.markdown,
                ...(args.dropRegions && args.dropRegions.length > 0 ? { dropRegions: args.dropRegions } : {}),
                sectionHash: plan.section.hash,
              }
            : undefined;
        const operation = {
          tool: 'write_page',
          page: head.page,
          document: head.document,
          mode,
          ...(head.section ? { section: head.section } : {}),
          markdown: args.markdown,
          markdownSha256,
          ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
          ...(args.dropRegions && args.dropRegions.length > 0 ? { dropRegions: args.dropRegions } : {}),
          plannedOn: plan.version,
          counts,
          before: plan.before,
          after: plan.after,
          ...warnings,
        };
        const title = `write_page ${mode}${head.section ? ` “${head.section}”` : ''} on “${node.displayName}” (${doc.name ?? doc.id})`;
        let run;
        try {
          run = await pd.engine.run(
            'replaceDocumentBlocks',
            { path, ifMatch: plan.version, body: { blocks: plan.blocks } },
            {
              project: pd.project.id,
              origin: mcpOrigin(mctx, 'write_page'),
              priority: 'P1',
              title: title.slice(0, 300),
              signal: mctx.signal,
              verifyAfterWrite: true,
              journalOperation,
              ...(replanInput ? { replan: { planner: WRITE_PAGE_PLANNER, input: replanInput } } : {}),
              proposal: {
                operation,
                summary: `${title}: ${summaryLine(plan)}`.slice(0, 500),
                prefetched: [{ op: 'getDocumentBlocks', path, body: read.value }],
              },
            },
          );
        } catch (e) {
          if (e instanceof VersionConflictError) return conflictResult(e, pd);
          return errorFromThrown(e, pd);
        }
        const full = args.detail === 'full';
        switch (run.status) {
          case 'succeeded': {
            const v = run.result as VerifiedWriteValue;
            if (v.unchanged) {
              return render(
                {
                  ...head,
                  status: 'no_change',
                  version: v.document.version,
                  message:
                    'The page changed while this write waited, and now already holds this edit. Nothing was sent.',
                  ...(run.jobId ? { jobId: run.jobId } : {}),
                },
                pd,
              );
            }
            const ver = v.verification;
            const newVersion =
              ver.version ?? (typeof v.document.version === 'string' ? v.document.version : null);
            if (ver.status === 'verified' && !v.replanned && newVersion) {
              versions?.remember(ctx.projectId, doc.id, newVersion, plan.after);
            }
            const verified = ver.status === 'verified' ? true : ver.status === 'mismatch' ? false : null;
            const first = ver.differences?.[0];
            return finish(
              pd,
              mctx,
              'write_page',
              {
                ...head,
                status: 'written',
                version: newVersion,
                previousVersion: plan.version,
                counts,
                summary: summaryLine(plan),
                verified,
                ...(ver.status === 'mismatch'
                  ? {
                      warning:
                        `written but not as planned: the page read back after the write differs from what was sent ` +
                        `(${ver.differenceCount ?? ver.differences?.length ?? 0} difference(s)${first ? `, first at blocks${first.path}` : ''}); ` +
                        `something else probably edited the page at the same moment. The write was not retried. The page as it was ` +
                        `before is in journal entry ${ver.journalId ?? '?'} (bridge_journal_lookup with jobId ${run.jobId ?? '?'}). ` +
                        'Read the page and check it.',
                      verification: ver,
                    }
                  : ver.status === 'not_checked'
                    ? { verification: { status: ver.status, reason: ver.reason, journalId: ver.journalId } }
                    : {}),
                ...(v.replanned
                  ? {
                      note: `The page changed between the plan (${String(v.replanned.from)}) and the write; the section was unchanged, so the edit was applied to version ${String(v.replanned.to)} inside the lock.`,
                    }
                  : rebased),
                ...(run.jobId ? { jobId: run.jobId } : {}),
                ...warnings,
                ...diffBody(full),
              },
              preview,
            );
          }
          case 'queued':
          case 'waiting_budget':
            return finish(
              pd,
              mctx,
              'write_page',
              {
                ...head,
                status: run.status,
                jobId: run.jobId,
                ...(run.status === 'queued' ? { reason: run.reason } : {}),
                eta: run.eta === null ? null : new Date(run.eta).toISOString(),
                plannedOn: plan.version,
                counts,
                hint:
                  'The write is accepted and has NOT failed: it runs by itself, re-checking the page’s version inside its lock (a section edit whose section ' +
                  'is unchanged is re-planned; anything else ends as a conflict). Never submit it again: follow it with bridge_job_status or bridge_job_wait.',
                ...warnings,
                ...diffBody(full),
              },
              preview,
            );
          case 'proposal_captured':
            return finish(
              pd,
              mctx,
              'write_page',
              {
                ...head,
                status: 'proposal_captured',
                proposalId: run.proposalId,
                ...(run.summary !== undefined ? { summary: run.summary } : {}),
                plannedOn: plan.version,
                counts,
                hint:
                  'The change needs the owner’s approval and was NOT made. The owner sees this exact plan and its Markdown diff; if the page changes before ' +
                  'approval, the proposal becomes conflicted rather than being applied. Never retry it; tell the user it is waiting, and follow it with ' +
                  'bridge_proposal_status.',
                ...warnings,
                ...diffBody(full),
              },
              preview,
            );
        }
      }),
  });
}
