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
import { planBlockwise, type BlockOp } from '../../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../../pages/blockwise-job.js';
import { defineTool } from './define.js';
import { runWriteJob } from './write-job.js';
import { lastMajorRevisionArg } from './schemas.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import { pickDocument } from './read-document.js';
import { manualSplitRefusal } from '../../packs/split/guard.js';
import { finish, liveRead, repoContext, resolvePage } from './repo.js';
import {
  railBody,
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
      lastMajorRevision: lastMajorRevisionArg,
      plainEdit: z
        .object({ reason: z.string().trim().min(3).max(500) })
        .strict()
        .optional()
        .describe(
          'Only when an edit on a pack project takes substantial material off an owner page on purpose (not a split): why. Without it such an edit is refused with USE_ARKONA_SPLIT (arkona_split_owner moves material between owners, verified). The reason is shown to the owner.',
        ),
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
        // v2 E4 (ADR 0046): a page LegendKeeper's API cannot take back whole (an inline icon) is written block by block,
        // touching only the blocks the edit changes; an edit to such a block itself stays refused.
        let blockwise: { ops: readonly BlockOp[] } | undefined;
        if (unwritable.length > 0) {
          const held = new Set(
            unwritableBlocks(path, plan.version, current.blocks)
              .map((b) => b.id)
              .filter((id): id is string => id !== null),
          );
          const bw = planBlockwise(current.blocks, plan.blocks, {
            unwritable: held,
            validate: (op) => validateBlockOp(node.id, doc.id, op),
          });
          if (!bw.ok) {
            return errorResult(
              {
                code: 'PAGE_NOT_WRITABLE',
                reason: bw.refusal.reason,
                message:
                  `LegendKeeper's API would refuse this page as written back whole: ${unwritable.length} block(s) the page already holds ` +
                  `(${unwritable
                    .slice(0, 10)
                    .map((b) => `${b.id ?? b.at} (${b.kind})`)
                    .join(
                      ', ',
                    )}) have content its write format has no form for, for example text with an inline icon. ` +
                  `write_page then writes only the blocks the edit changes, one by one, but not this edit: ${bw.refusal.message} ` +
                  'Nothing was written. Edit another section, or tell the person the text has to be changed in the LegendKeeper app. ' +
                  'Do not try replaceDocumentBlocks or another low-level route: it would drop what the page holds. read_document, get_resource and set_facts still work on this page.',
                blocks: [
                  ...unwritable.slice(0, 50),
                  ...bw.refusal.blocks.filter((b) => !unwritable.some((u) => u.id === b.id)),
                ].slice(0, 50),
              },
              pd,
            );
          }
          blockwise = { ops: bw.ops };
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
        // v3 F3e (ADR 0059): taking substantial material off a pack owner is a split (arkona_split_owner), unless
        // plainEdit says why it is not.
        if (!args.plainEdit) {
          const sb = ctx.tree.sidebars(ctx.projectId, [node.id]).data.get(node.id) ?? null;
          const refusal = manualSplitRefusal({
            packs: pd.services?.packs,
            projectId: ctx.projectId,
            node,
            before: current.blocks,
            after: plan.blocks,
            characterOf: (id) => {
              try {
                return ctx.types.characterOfPage(id).ok;
              } catch {
                return false;
              }
            },
            factKeys: sb
              ? (sb as readonly { kind?: string; rows?: readonly { key: string }[] }[])
                  .filter((x) => x.kind === 'keyValue')
                  .flatMap((x) => (x.rows ?? []).map((r) => r.key))
              : null,
          });
          if (refusal) return errorResult(refusal, pd);
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
              ...(blockwise ? { blockwise: blockwiseSummary(blockwise.ops) } : {}),
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
          ...(args.plainEdit ? { plainEdit: args.plainEdit.reason } : {}),
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
          ...(args.plainEdit ? { plainEdit: args.plainEdit.reason } : {}),
        };
        const title = `write_page ${mode}${head.section ? ` “${head.section}”` : ''} on “${node.displayName}” (${doc.name ?? doc.id})${args.plainEdit ? ` (plain edit: ${args.plainEdit.reason})` : ''}`;
        if (blockwise) {
          return writeBlockwise(pd, mctx, {
            resourceId: node.id,
            documentId: doc.id,
            before: current.blocks,
            plan,
            ops: blockwise.ops,
            title,
            head: { ...head, ...warnings },
            operation: { ...operation, blockwise: blockwiseSummary(blockwise.ops) },
            journalOperation,
            prefetched: [{ op: 'getDocumentBlocks', path, body: read.value }],
            preview,
            counts,
            diffBody: diffBody(full0(args.detail)),
            ...(args.lastMajorRevision ? { lastMajorRevision: args.lastMajorRevision } : {}),
          });
        }
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
              ...(args.lastMajorRevision ? { lastMajorRevision: args.lastMajorRevision } : {}),
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
                ...(run.lastMajorRevision ? { lastMajorRevision: run.lastMajorRevision } : {}),
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
                ...(run.lastMajorRevision ? { lastMajorRevision: run.lastMajorRevision } : {}),
                hint:
                  'The write is accepted and has NOT failed: it runs by itself, re-checking the page’s version inside its lock (a section edit whose section ' +
                  'is unchanged is re-planned; anything else ends as a conflict). Never submit it again: follow it with bridge_job_status (wait_seconds waits for it).',
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
                ...railBody(run),
                ...warnings,
                ...diffBody(full),
              },
              preview,
            );
        }
      }),
  });
}

const full0 = (detail: string | undefined): boolean => detail === 'full';

/** What a block-by-block write will send (v2 E4). */
function blockwiseSummary(ops: readonly BlockOp[]): Record<string, unknown> {
  return {
    writes: ops.length,
    inserts: ops.filter((o) => o.op === 'insertBlock').length,
    replaces: ops.filter((o) => o.op === 'replaceBlock').length,
    deletes: ops.filter((o) => o.op === 'deleteBlock').length,
    note:
      'The page holds content LegendKeeper’s API cannot take back whole (an inline icon), so only the blocks this edit changes are written, ' +
      'one by one: new blocks first, then changed ones, then removals. If it stops part-way the bridge undoes what it wrote, provided the ' +
      'page is still exactly as it left it.',
  };
}

/**
 * v2 E4 (ADR 0046): the write of a page LegendKeeper cannot take back whole, block by block, as ONE job (or one
 * proposal): the in-lock check, the chained writes, the verify of the whole page. A stop part-way is undone
 * (src/pages/undo.ts) when the page is exactly as the job left it; the answer says what happened.
 */
async function writeBlockwise(
  pd: ProjectDeps,
  mctx: Parameters<typeof finish>[1],
  w: {
    readonly resourceId: string;
    readonly documentId: string;
    readonly before: readonly unknown[];
    readonly plan: PagePlan;
    readonly ops: readonly BlockOp[];
    readonly title: string;
    readonly head: Record<string, unknown>;
    readonly operation: Record<string, unknown>;
    readonly journalOperation: Record<string, unknown>;
    readonly prefetched: readonly Record<string, unknown>[];
    readonly preview: () => unknown;
    readonly counts: Record<string, unknown>;
    readonly diffBody: Record<string, unknown>;
    readonly lastMajorRevision?: LmrMode;
  },
): Promise<McpToolResult> {
  const job = blockwiseJob({
    resourceId: w.resourceId,
    documentId: w.documentId,
    before: w.before,
    after: w.plan.blocks,
    ops: w.ops,
    journalOperation: w.journalOperation,
  });
  const head = {
    ...w.head,
    blockwise: blockwiseSummary(w.ops),
    plannedOn: w.plan.version,
    counts: w.counts,
    summary: summaryLine(w.plan),
  };
  const out = await runWriteJob(pd, mctx, 'write_page', {
    steps: job.steps,
    labels: job.labels,
    title: `${w.title} (block by block)`,
    holdDocuments: [w.documentId],
    proposal: {
      operation: w.operation,
      summary: `${w.title}: ${summaryLine(w.plan)}, block by block`.slice(0, 500),
      prefetched: w.prefetched as never,
    },
    ...(w.lastMajorRevision ? { lastMajorRevision: w.lastMajorRevision } : {}),
    head,
    preview: w.preview,
  });
  const body = out.body;
  if (body.status === 'written' && out.jobId) {
    // The page's new version: the last write's answer (a block write's body, a delete's ETag).
    const steps = pd.engine.stepResults(pd.project.id, out.jobId) ?? [];
    const last = [...steps]
      .reverse()
      .find((x) => x.status === 'succeeded' && x.stepNo > 1 && x.stepNo < job.steps.length);
    const v = last?.value as { version?: unknown; etag?: unknown } | null | undefined;
    const version = typeof v?.version === 'string' ? v.version : typeof v?.etag === 'string' ? v.etag : null;
    if (version && body.verified === true)
      pd.services?.versions?.remember(pd.project.id, w.documentId, version, w.plan.after);
    const answer = { ...body, version, previousVersion: w.plan.version, ...w.diffBody };
    return finish(pd, mctx, 'write_page', answer, w.preview);
  }
  if (
    (body.code === 'WRITTEN_IN_PART' || body.code === 'OUTCOME_UNKNOWN') &&
    out.jobId &&
    pd.services?.blockwiseUndo
  ) {
    const view = pd.engine.queries.getJob(pd.project.id, out.jobId);
    const u = view ? await pd.services.blockwiseUndo.consider(view) : undefined;
    let undo: Record<string, unknown> | undefined;
    if (u?.status === 'submitted') {
      const done = await pd.engine.wait(pd.project.id, u.undoJobId, 25_000);
      undo = {
        jobId: u.undoJobId,
        status: done.status,
        message:
          done.status === 'succeeded'
            ? 'The bridge undid what this write had made: the page is as it was before it.'
            : done.status === 'failed' || done.status === 'cancelled'
              ? 'The bridge tried to undo what this write had made, and the undo stopped too: read the page; the journal holds every block as it was.'
              : 'The bridge is undoing what this write had made (it runs by itself; follow it with bridge_job_status).',
      };
    } else if (u && 'message' in u) undo = { status: u.status, message: u.message };
    return errorResult({ ...body, ...(undo ? { undo } : {}) } as never, pd);
  }
  return out.result;
}
