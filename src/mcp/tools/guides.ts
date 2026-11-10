/**
 * The agent guides (v2 B2, ADR 0029): `get_markdown_guide` (docs/markdown.md) and `get_bridge_guide`
 * (docs/bridge-guide.md), each also published as an MCP resource. The text is the file as it is in the repository's
 * docs folder, read on every request, so a guide is edited in one place only.
 */
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { getSection, MarkdownError, outline } from '../../markdown/index.js';
import type { McpResourceProvider, McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { errorResult, projectArg, render, withProject, type ToolDeps } from './shape.js';

export interface Guide {
  readonly id: 'markdown' | 'bridge';
  readonly tool: 'get_markdown_guide' | 'get_bridge_guide';
  readonly file: string;
  readonly uri: string;
  readonly title: string;
  readonly summary: string;
}

export const GUIDES: readonly Guide[] = [
  {
    id: 'bridge',
    tool: 'get_bridge_guide',
    file: 'bridge-guide.md',
    uri: 'lk-bridge://guides/bridge',
    title: 'LK-Bridge guide',
    summary:
      'What the bridge is, projects, the repository tree, how to find things, how reading and writing work, budget rules and proposals',
  },
  {
    id: 'markdown',
    tool: 'get_markdown_guide',
    file: 'markdown.md',
    uri: 'lk-bridge://guides/markdown',
    title: 'Writing LegendKeeper pages in Markdown',
    summary:
      'The Markdown the bridge reads and writes: syntax, keep regions, sections, limits and error codes',
  },
];

/** The docs folder: `src/mcp/tools` and `dist/mcp/tools` are both three levels below the repository root. */
const DOCS = new URL('../../../docs/', import.meta.url);

export function readGuide(g: Guide): string {
  try {
    return readFileSync(new URL(g.file, DOCS), 'utf8');
  } catch {
    return `# ${g.title}\n\nThis guide could not be read on the server (docs/${g.file} is missing). Ask the bridge owner.\n`;
  }
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
      description:
        `Returns the ${g.title.toLowerCase()} guide: ${g.summary}. ` +
        (g.id === 'bridge'
          ? 'Read it first if you have not used this bridge before. '
          : 'Read it before writing Markdown to a page. ') +
        'With `section` (a heading such as "Keep regions", or a path "A > B") it returns just that part; without it, the whole guide. ' +
        `Also published as the MCP resource ${g.uri}. Cost: none (no LegendKeeper request).`,
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
