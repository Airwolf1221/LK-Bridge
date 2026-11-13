/**
 * The agent guides (v2 B2, ADR 0029): `get_markdown_guide` (docs/markdown.md) and `get_bridge_guide`
 * (docs/bridge-guide.md), each also published as an MCP resource. The text is the file as it is in the repository's
 * docs folder, read on every request, so a guide is edited in one place only. The bridge guide gets an Operations
 * section appended, generated from the operation registry (ADR 0033).
 */
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { getSection, MarkdownError, outline } from '../../markdown/index.js';
import type { McpResourceProvider, McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { operationsGuideSection } from './discovery.js';
import { errorResult, projectArg, render, withProject, type ToolDeps } from './shape.js';

export interface Guide {
  readonly id: 'markdown' | 'bridge';
  readonly tool: 'get_markdown_guide' | 'get_bridge_guide';
  readonly file: string;
  readonly uri: string;
  readonly title: string;
  readonly summary: string;
  /** What the tool's description says (E3, ADR 0045): when to read it, how to read part of it, and its cost. */
  readonly blurb: string;
}

export const GUIDES: readonly Guide[] = [
  {
    id: 'bridge',
    tool: 'get_bridge_guide',
    file: 'bridge-guide.md',
    uri: 'lk-bridge://guides/bridge',
    title: 'LK-Bridge guide',
    summary:
      'How to decide which tool to use, then the task-by-task reference: finding and reading pages, editing text and facts, creating pages and characters, the page lifecycle, chronology, maps, images, snapshots, audits, budgets and proposals',
    blurb:
      'Returns the LK-Bridge guide for agents. It starts with HOW TO DECIDE (which tool for which job, and the rules that matter most); the rest is reference, one section per task. Read the section "How to decide" first, then the section for the task in hand before you do it: pass `section` (a heading, or a path "A > B") to get just that part; without it you get the whole guide (long). The last section lists every LegendKeeper operation id, for the low-level tools. Also the MCP resource lk-bridge://guides/bridge. Cost: none.',
  },
  {
    id: 'markdown',
    tool: 'get_markdown_guide',
    file: 'markdown.md',
    uri: 'lk-bridge://guides/markdown',
    title: 'Writing LegendKeeper pages in Markdown',
    summary:
      'The Markdown the bridge reads and writes: syntax, mentions, keep regions, sections, limits and error codes',
    blurb:
      'Returns the guide to writing LegendKeeper pages in Markdown: the syntax, mentions, keep regions, sections, limits and error codes. Read it before you send Markdown to write_page or a fact. Pass `section` (a heading such as "Keep regions", or a path "A > B") for one part; without it you get the whole guide. Also the MCP resource lk-bridge://guides/markdown. Cost: none.',
  },
];

/** The docs folder: `src/mcp/tools` and `dist/mcp/tools` are both three levels below the repository root. */
const DOCS = new URL('../../../docs/', import.meta.url);

export function readGuide(g: Guide): string {
  let text: string;
  try {
    text = readFileSync(new URL(g.file, DOCS), 'utf8');
  } catch {
    return `# ${g.title}\n\nThis guide could not be read on the server (docs/${g.file} is missing). Ask the bridge owner.\n`;
  }
  // ADR 0033: the bridge guide ends with an Operations section generated from the registry at serve time.
  return g.id === 'bridge' ? `${text.replace(/\s+$/, '')}\n\n${operationsGuideSection()}` : text;
}

export function guideResources(): McpResourceProvider[] {
  return GUIDES.map((g) => ({
    name: g.tool.replace(/^get_/, '').replace(/_guide$/, '-guide'),
    uri: g.uri,
    title: g.title,
    description: g.summary,
    mimeType: 'text/markdown',
    read: () => readGuide(g),
  }));
}

export function guideTools(deps: ToolDeps): McpToolProvider[] {
  return GUIDES.map((g) =>
    defineTool({
      name: g.tool,
      title: g.title,
      access: 'read',
      description: g.blurb,
      inputSchema: z.object({
        section: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('A heading of the guide (or "A > B"). Default: all of it.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ section, project }) =>
        withProject(deps, project, 'read', (pd) => {
          const text = readGuide(g);
          if (section === undefined) return render({ guide: g.id, title: g.title, markdown: text }, pd);
          try {
            const s = getSection(text, section);
            return render({ guide: g.id, section: s.heading.path, markdown: s.markdown }, pd);
          } catch (e) {
            if (e instanceof MarkdownError) {
              return errorResult(
                {
                  code: e.code,
                  message: e.message,
                  headings: outline(text).map((h) => h.path),
                },
                pd,
              );
            }
            throw e;
          }
        }),
    }),
  );
}
