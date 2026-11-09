/**
 * Public surface of `src/markdown`: the Markdown converter library (docs/PLAN-v2.md 4.7, session B1). No MCP tools, no
 * database, no LegendKeeper calls: pure functions over block trees and Markdown. See src/markdown/README.md for the
 * developer notes and docs/markdown.md for the agent-facing guide.
 */
import { MarkdownError } from './errors.js';
import { parseDrafts } from './parse.js';
import { indexBase, rebuild } from './rebuild.js';
import { documentBlocks, renderPage } from './render.js';
import { blockHeadings, findSection, sectionRange } from './sections.js';
import type {
  DocumentInput,
  EditMode,
  FromMarkdownContext,
  FromMarkdownOptions,
  FromMarkdownResult,
  MentionResolution,
  PageEdit,
  ResolveMention,
} from './types.js';

export { toMarkdown, projectDocument } from './render.js';
export { outline, getSection } from './sections.js';
export { renderMap, renderTimeline, renderBoard, type MapInput, type TimelineInput } from './documents.js';
export { collectMentionNames } from './parse.js';
export {
  checkRoundTrip,
  firstDifference,
  minimalRepro,
  type RoundTripResult,
  type RoundTripFailure,
} from './check.js';
export { MarkdownError, type MarkdownErrorCode } from './errors.js';
export { EDITOR_RULES, type EditorRule } from './limits.js';
export { validateAgainstSpec, MAX_BLOCK_DEPTH, MAX_DOCUMENT_BLOCKS, type SchemaIssue } from './schema.js';
export type * from './types.js';

/**
 * Markdown back to a block tree, given the CURRENT document. Unchanged blocks keep their ids and every attribute; keep
 * regions restore their block exactly; `[[Name]]` goes through `ctx.resolveMention`. This is a whole-page replace: a
 * keep region missing from the Markdown is refused unless `options.dropRegions` names it.
 */
export function fromMarkdown(
  markdown: string,
  base: DocumentInput,
  ctx: FromMarkdownContext = {},
  options: FromMarkdownOptions = {},
): FromMarkdownResult {
  const blocks = documentBlocks(base);
  const page = indexBase(blocks, renderPage(blocks, true));
  const { drafts, warnings } = parseDrafts(markdown, { resolveMention: ctx.resolveMention });
  return rebuild({ base: page, start: 0, end: blocks.length, drafts, ctx, opts: options, warnings });
}

const MODES: readonly EditMode[] = ['append', 'prepend', 'replace', 'replace_section', 'append_to_section'];

/**
 * Applies a page edit to the CURRENT document: `append` and `prepend` add the Markdown's blocks at the end or start;
 * `replace` is `fromMarkdown`; `replace_section` replaces a section (its heading too when the Markdown starts with a
 * heading of the section's level or higher, else only its body); `append_to_section` adds blocks at the end of a section.
 * Blocks outside the edited range are never touched.
 */
export function applyEdit(
  base: DocumentInput,
  edit: PageEdit,
  ctx: FromMarkdownContext = {},
): FromMarkdownResult {
  if (!isObject(edit) || !MODES.includes(edit.mode))
    throw new MarkdownError(
      'INVALID_EDIT',
      `Unknown edit mode ${JSON.stringify((edit as { mode?: unknown })?.mode)}; use one of ${MODES.join(', ')}.`,
    );
  if (typeof edit.markdown !== 'string')
    throw new MarkdownError('INVALID_EDIT', 'The edit needs its Markdown as a string.');
  const sectioned = edit.mode === 'replace_section' || edit.mode === 'append_to_section';
  if (sectioned && (typeof edit.section !== 'string' || edit.section.trim() === ''))
    throw new MarkdownError(
      'INVALID_EDIT',
      `Mode ${edit.mode} needs a section: a heading path such as "Biography > Early Life".`,
    );
  if (!sectioned && edit.section !== undefined)
    throw new MarkdownError(
      'INVALID_EDIT',
      `Mode ${edit.mode} works on the whole page; leave "section" out, or use replace_section or append_to_section.`,
    );
  const blocks = documentBlocks(base);
  const page = indexBase(blocks, renderPage(blocks, true));
  const { drafts, warnings } = parseDrafts(edit.markdown, { resolveMention: ctx.resolveMention });
  const opts: FromMarkdownOptions = {
    ...(edit.dropRegions ? { dropRegions: edit.dropRegions } : {}),
    ...(edit.allowUnsupportedLoss !== undefined ? { allowUnsupportedLoss: edit.allowUnsupportedLoss } : {}),
  };
  const run = (start: number, end: number) =>
    rebuild({ base: page, start, end, drafts, ctx, opts, warnings });
  const n = blocks.length;
  switch (edit.mode) {
    case 'replace':
      return run(0, n);
    case 'append':
      return run(n, n);
    case 'prepend':
      return run(0, 0);
    default: {
      const headings = blockHeadings(blocks);
      const h = findSection(headings, edit.section!);
      const [a, b] = sectionRange(headings, h, n);
      if (edit.mode === 'append_to_section') return run(b, b);
      const first = drafts[0];
      const withHeading =
        first?.t === 'block' &&
        first.own.kind === 'heading' &&
        typeof first.own.level === 'number' &&
        first.own.level <= h.level;
      return run(withHeading ? a : a + 1, b);
    }
  }
}

/** A resolver answering from a map built in advance (for callers whose own lookup is asynchronous). */
export function mapResolver(answers: ReadonlyMap<string, MentionResolution>): ResolveMention {
  return (name) => answers.get(name) ?? { status: 'not_found' };
}

/** A resolver for tests: names map to ids; a list of ids is ambiguous. */
export function stubResolver(table: Readonly<Record<string, string | readonly string[]>>): ResolveMention {
  return (name) => {
    const v = table[name];
    if (v === undefined) return { status: 'not_found' };
    if (typeof v === 'string') return { status: 'resolved', resourceId: v };
    if (v.length === 1) return { status: 'resolved', resourceId: v[0]! };
    return { status: 'ambiguous', candidates: v.map((id) => ({ resourceId: id, name })) };
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
