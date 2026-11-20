/**
 * v3 F4a (ADR 0063): what the pack's free read tools share (`arkona_name_check`, `arkona_brief`): the pack looked up and
 * its attachment checked, a page's sections chosen by their headings and shown as Markdown, and a long text cut with a
 * result handle (`bridge_result_page`) so an answer stays small.
 */
import { toMarkdown, type LkBlock } from '../markdown/index.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { errorResult, mcpOrigin, type ProjectDeps } from '../mcp/tools/shape.js';
import { reportRulesOf } from './governance-audit.js';
import type { Pack, PackRules } from './types.js';

type Obj = Record<string, unknown>;

/** The pack (attached to the call's project) and the rules a report reads: the approved version's. */
export function packForRead(
  pd: ProjectDeps,
  packId: string,
):
  | { readonly ok: true; readonly pack: Pack; readonly rules: PackRules }
  | { readonly ok: false; readonly result: McpToolResult } {
  const packs = pd.services?.packs;
  if (!packs)
    return {
      ok: false,
      result: errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Setting packs are not available here.' }, pd),
    };
  const pack = packs.get(packId);
  if (!pack)
    return { ok: false, result: errorResult({ code: 'PACK_NOT_FOUND', message: `No pack ${packId}.` }, pd) };
  if (!packs.attachment(pack.id, pd.project.id)) {
    const attached = packs.view(pack.id)?.attachments.map((a) => a.projectName) ?? [];
    return {
      ok: false,
      result: errorResult(
        {
          code: 'PACK_NOT_ATTACHED',
          message: `The ${pack.name} pack is not attached to the project ${pd.project.name}; its tools work only on ${attached.join(', ') || 'no project yet'}.`,
          attachedTo: attached,
        },
        pd,
      ),
    };
  }
  return { ok: true, pack, rules: reportRulesOf(pack, (id, v) => packs.store.rulesAt(id, v)) };
}

const levelOf = (b: Obj) => (typeof b.level === 'number' ? b.level : 1);
const headingText = (b: Obj) =>
  (Array.isArray(b.content) ? (b.content as Obj[]) : [])
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : isObj(r.mention) && typeof r.mention.text === 'string'
          ? r.mention.text
          : '',
    )
    .join('')
    .trim();
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A section of a page: its heading's text and level, and its blocks (the heading included). */
export interface PageSection {
  readonly title: string;
  readonly level: number;
  readonly blocks: readonly Obj[];
}

/**
 * The sections whose heading passes `test`: each its heading and every top-level block after it up to the next heading
 * of its level or higher (its subsections included). A section inside one already taken is not taken again.
 */
export function sectionsWhere(blocks: readonly unknown[], test: (title: string) => boolean): PageSection[] {
  const list = blocks.filter(isObj);
  const out: PageSection[] = [];
  let i = 0;
  while (i < list.length) {
    const b = list[i]!;
    if (b.kind !== 'heading' || !test(headingText(b))) {
      i++;
      continue;
    }
    const level = levelOf(b);
    let end = i + 1;
    while (end < list.length && !(list[end]!.kind === 'heading' && levelOf(list[end]!) <= level)) end++;
    out.push({ title: headingText(b), level, blocks: list.slice(i, end) });
    i = end;
  }
  return out;
}

/** A section as Markdown (keep regions as their markers), or its plain text when it cannot be converted. */
export function sectionMarkdown(blocks: readonly Obj[]): string {
  try {
    return toMarkdown(blocks as unknown as LkBlock[]).markdown.trim();
  } catch {
    return blocks
      .map((b) => headingText(b))
      .filter(Boolean)
      .join('\n');
  }
}

/**
 * A text no longer than `max` characters: as it is, or its start with the whole stored as a result (a handle for
 * `bridge_result_page`), so a long section never swells the answer.
 */
export function cutText(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  label: string,
  text: string,
  max: number,
): Obj {
  if (text.length <= max) return { markdown: text };
  const stored = pd.engine.recordResult({
    project: pd.project.id,
    opId: tool,
    params: {},
    value: { section: label, markdown: text },
    origin: mcpOrigin(mctx, tool),
    title: `${tool}: ${label} (stored section)`.slice(0, 200),
  });
  return {
    markdown: `${text.slice(0, max).trimEnd()}…`,
    cut: true,
    chars: text.length,
    handle: stored.artifactId,
    hint: 'Cut here. The whole section: bridge_result_page({ handle }).',
  };
}
