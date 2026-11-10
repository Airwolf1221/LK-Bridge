/**
 * `read_document` (v2 B2, ADR 0029): a page's document as Markdown (B1's converter), its outline, one section, or the
 * raw blocks. Maps, timelines and boards are shown with B1's read-only renderers. Works only inside the AI REPOSITORY.
 */
import * as z from 'zod';
import {
  getSection,
  MarkdownError,
  outline,
  renderBoard,
  renderMap,
  renderTimeline,
  toMarkdown,
} from '../../markdown/index.js';
import type { TreeDocument, TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { clip, finish, liveRead, repoContext, resolvePage, treeInfo, type RepoCtx } from './repo.js';
import { errorResult, projectArg, withProject, type ToolDeps } from './shape.js';

/** Timelines are read page by page (100 events per read); this many pages at most. */
const EVENT_PAGES_MAX = 10;

const KEEP_ID = /<!-- lk:keep id="([^"]*)"/g;

function pickDocument(
  ctx: RepoCtx,
  node: TreeNode,
  wanted: string | undefined,
):
  | { readonly ok: true; readonly doc: TreeDocument; readonly note?: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const docs = node.documents;
  const list = docs.map((d) => ({ id: d.id, name: d.name, type: d.type }));
  const fail = (code: string, message: string): { ok: false; result: McpToolResult } => ({
    ok: false,
    result: errorResult(
      { code, message, documents: list, page: { id: node.id, name: node.displayName } },
      ctx.pd,
    ),
  });
  if (docs.length === 0) return fail('DOCUMENT_NOT_FOUND', `“${node.displayName}” has no documents.`);
  if (wanted !== undefined) {
    const byId = docs.find((d) => d.id === wanted);
    if (byId) return { ok: true, doc: byId };
    const k = wanted.trim().toLowerCase();
    const named = docs.filter((d) => (d.name ?? '').toLowerCase() === k);
    if (named.length === 1) return { ok: true, doc: named[0]! };
    if (named.length > 1) {
      return fail(
        'AMBIGUOUS',
        `“${node.displayName}” has ${named.length} documents named “${wanted}”. Pass the id of the one you mean.`,
      );
    }
    return fail('DOCUMENT_NOT_FOUND', `“${node.displayName}” has no document named or numbered “${wanted}”.`);
  }
  const main = docs.filter((d) => (d.name ?? '').toLowerCase() === 'main');
  if (main.length === 1) return { ok: true, doc: main[0]! };
  if (main.length > 1)
    return fail('AMBIGUOUS', `“${node.displayName}” has several documents named “Main”. Pass an id.`);
  if (docs.length === 1) {
    return {
      ok: true,
      doc: docs[0]!,
      note: `The page has no document named “Main”; this is its only document.`,
    };
  }
  return fail(
    'DOCUMENT_NOT_FOUND',
    `“${node.displayName}” has no document named “Main”. Name one of its documents.`,
  );
}

interface Loaded {
  readonly markdown: string;
  readonly regions: readonly { id: string; kind: string; reason: string }[];
  readonly warnings: readonly { code: string; message: string; at?: string | undefined }[];
  readonly version?: string;
  readonly blockCount?: number;
  readonly raw: unknown;
  readonly note?: string;
}

async function load(
  ctx: RepoCtx,
  mctx: McpToolContext,
  node: TreeNode,
  doc: TreeDocument,
): Promise<
  { readonly ok: true; readonly loaded: Loaded } | { readonly ok: false; readonly result: McpToolResult }
> {
  const path = { resourceId: node.id, documentId: doc.id };
  const read = (opId: string, query?: Record<string, unknown>) =>
    liveRead(ctx.pd, mctx, 'read_document', opId, { path, ...(query ? { query } : {}) });
  switch (doc.type) {
    case 'map': {
      const r = await read('listFeatures');
      if (!r.ok) return r;
      const features = (r.value as { data?: unknown[] })?.data ?? [];
      return {
        ok: true,
        loaded: {
          markdown: renderMap({ ...(doc.name ? { name: doc.name } : {}), features }),
          regions: [],
          warnings: [],
          raw: r.value,
        },
      };
    }
    case 'time': {
      const lanes = await read('listLanes');
      if (!lanes.ok) return lanes;
      const events: unknown[] = [];
      let cursor: string | undefined;
      let more = false;
      for (let page = 0; page < EVENT_PAGES_MAX; page++) {
        const r = await read('listEvents', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!r.ok) return r;
        const v = r.value as { data?: unknown[]; hasMore?: boolean; nextCursor?: string | null };
        events.push(...(v.data ?? []));
        more = v.hasMore === true && !!v.nextCursor;
        if (!more) break;
        cursor = v.nextCursor!;
      }
      return {
        ok: true,
        loaded: {
          markdown: renderTimeline({
            ...(doc.name ? { name: doc.name } : {}),
            lanes: (lanes.value as { data?: unknown[] })?.data ?? [],
            events,
          }),
          regions: [],
          warnings: [],
          raw: { lanes: lanes.value, events },
          ...(more
            ? {
                note: `Only the first ${events.length} events were read (${EVENT_PAGES_MAX} reads); the timeline has more.`,
              }
            : {}),
        },
      };
    }
    case 'board': {
      const r = await read('getBoardContent');
      if (!r.ok) return r;
      return {
        ok: true,
        loaded: {
          markdown: renderBoard(r.value, doc.name ?? undefined),
          regions: [],
          warnings: [],
          raw: r.value,
        },
      };
    }
    default: {
      const r = await read('getDocumentBlocks');
      if (!r.ok) return r;
      const v = r.value as { version?: string; blocks?: unknown[] };
      const md = toMarkdown({ blocks: (v.blocks ?? []) as never });
      return {
        ok: true,
        loaded: {
          markdown: md.markdown,
          regions: md.regions.map((x) => ({ id: x.id, kind: x.kind, reason: x.reason })),
          warnings: md.warnings.map((w) => ({ code: w.code, message: w.message, at: w.at })),
          ...(typeof v.version === 'string' ? { version: v.version } : {}),
          blockCount: countBlocks(v.blocks),
          raw: r.value,
        },
      };
    }
  }
}

function countBlocks(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0;
  return (blocks as { children?: unknown }[]).reduce((n, b) => n + 1 + countBlocks(b.children), 0);
}

export function readDocumentTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'read_document',
    title: 'Read a page’s document',
    access: 'read',
    description:
      'Reads one document of a page of the AI REPOSITORY as Markdown, ready to edit and write back: the Markdown (with keep regions for ' +
      'anything Markdown cannot show), the document version, and the list of keep regions. `resource` is a page name or id; `document` ' +
      'is a document name or id (default "Main"). `outline: true` returns only the headings with their section paths; ' +
      '`section: "Biography > Early Life"` returns just that section (a heading that occurs twice is refused, with the options); ' +
      '`format: "json"` returns the raw blocks instead. Maps, timelines and boards come back as read-only Markdown (features, lanes and ' +
      'events, shapes and connections). Read get_markdown_guide before you write Markdown back. ' +
      'Example: { "resource": "Asagiri Miyabi", "section": "Biography" }. ' +
      'Cost: 1 read for a page, map or board; a timeline needs 2 plus 1 per 100 events. A long page is stored and returned as a ' +
      'handle for bridge_result_page.',
    inputSchema: z.object({
      resource: z.string().min(1).max(500).describe('Page name or id.'),
      document: z.string().min(1).max(500).optional().describe('Document name or id. Default "Main".'),
      outline: z.boolean().optional().describe('Only the headings, with their section paths.'),
      section: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('One section, by heading path such as "Biography > Early Life".'),
      format: z
        .enum(['markdown', 'json'])
        .optional()
        .describe('markdown (default) or json (the raw blocks).'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ resource, document, outline: wantOutline, section, format, project }, mctx) =>
      withProject(deps, project, 'read', async (pd) => {
        if (wantOutline === true && section !== undefined) {
          return errorResult(
            { code: 'INVALID_PARAMS', message: 'Ask for an outline or for one section, not both.' },
            pd,
          );
        }
        if (format === 'json' && (wantOutline === true || section !== undefined)) {
          return errorResult(
            {
              code: 'INVALID_PARAMS',
              message: 'outline and section work on Markdown: leave format out, or use "markdown".',
            },
            pd,
          );
        }
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const r = resolvePage(ctx, resource);
        if (!r.ok) return r.result;
        const picked = pickDocument(ctx, r.node, document);
        if (!picked.ok) return picked.result;
        const doc = picked.doc;
        const l = await load(ctx, mctx, r.node, doc);
        if (!l.ok) return l.result;
        const loaded = l.loaded;
        const head = {
          tree: treeInfo(ctx.meta, ctx.now),
          page: { id: r.node.id, name: r.node.displayName, path: r.node.path.names.join(' / ') },
          document: { id: doc.id, name: doc.name, type: doc.type },
          ...(loaded.version ? { version: loaded.version } : {}),
          ...(picked.note || loaded.note
            ? { note: [picked.note, loaded.note].filter(Boolean).join(' ') }
            : {}),
        };
        const previewOf = () => ({
          page: head.page,
          document: head.document,
          ...(loaded.version ? { version: loaded.version } : {}),
          outline: outline(loaded.markdown)
            .map((h) => h.path)
            .slice(0, 40),
          start: clip(loaded.markdown, 1000),
        });
        if (format === 'json') {
          return finish(
            pd,
            mctx,
            'read_document',
            { ...head, format: 'json', content: loaded.raw },
            previewOf,
          );
        }
        if (wantOutline === true) {
          const headings = outline(loaded.markdown);
          return finish(
            pd,
            mctx,
            'read_document',
            {
              ...head,
              format: 'outline',
              headings: headings.map((h) => ({ level: h.level, text: h.text, path: h.path })),
              ...(loaded.blockCount !== undefined ? { blockCount: loaded.blockCount } : {}),
              keepRegions: loaded.regions.length,
              hint: 'Pass section with one of these paths to read just that section.',
            },
            previewOf,
          );
        }
        if (section !== undefined) {
          try {
            const s = getSection(loaded.markdown, section);
            const inside = new Set([...s.markdown.matchAll(KEEP_ID)].map((m) => m[1]!));
            return finish(
              pd,
              mctx,
              'read_document',
              {
                ...head,
                format: 'markdown',
                section: s.heading.path,
                level: s.heading.level,
                markdown: s.markdown,
                regions: loaded.regions.filter((x) => inside.has(x.id)),
              },
              previewOf,
            );
          } catch (e) {
            if (e instanceof MarkdownError) {
              return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
            }
            throw e;
          }
        }
        return finish(
          pd,
          mctx,
          'read_document',
          {
            ...head,
            format: 'markdown',
            markdown: loaded.markdown,
            regions: loaded.regions,
            ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings } : {}),
            ...(loaded.blockCount !== undefined ? { blockCount: loaded.blockCount } : {}),
          },
          previewOf,
        );
      }),
  });
}
