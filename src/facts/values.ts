/**
 * A fact's value, from what an agent sends to runs LegendKeeper stores (v2 C2a). A plain string is plain text (a line
 * break becomes a line-break run, as LegendKeeper reads one back); `{ "markdown": "…" }` is inline Markdown in B1's
 * schema (docs/markdown.md): marks, links, `<br>`, and mentions, `[[Name]]` resolved through A3 inside the AI
 * REPOSITORY. Anything that is not one line of inline text (a heading, a list, two paragraphs, an image) is refused.
 * The converter is used as it is (B1 is not changed): the Markdown is converted as a one-block page and its paragraph's
 * runs are taken.
 */
import { MarkdownError, fromMarkdown, type FromMarkdownContext } from '../markdown/index.js';

export type FactInput = string | { readonly markdown: string };

type Obj = Record<string, unknown>;

/** A typed refusal of one value (the tool returns it with the fact's key). */
export class FactValueError extends Error {
  override readonly name = 'FactValueError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Plain text as runs: one text run per line, a `break` run between lines; empty text is no runs. */
export function textRuns(text: string): Obj[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Obj[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ break: true });
    if (line !== '') out.push({ text: line });
  });
  return out;
}

const ROW_RUN_KEYS = new Set(['text', 'bold', 'italic', 'underline', 'strike', 'code', 'link', 'sub', 'sup']);

/** A value's runs. Throws `FactValueError` (or passes on the converter's `MarkdownError` codes as one). */
export function factValueRuns(value: FactInput, ctx: FromMarkdownContext): Obj[] {
  if (typeof value === 'string') return textRuns(value);
  const md = value.markdown;
  if (md.trim() === '') return [];
  let blocks: readonly Obj[];
  try {
    blocks = fromMarkdown(md, { blocks: [] }, ctx).blocks;
  } catch (e) {
    if (e instanceof MarkdownError) throw new FactValueError(e.code, e.message, e.details);
    throw e;
  }
  const kinds = blocks.map((b) => String(b.kind));
  if (blocks.length !== 1 || kinds[0] !== 'paragraph') {
    throw new FactValueError(
      'FACT_VALUE_NOT_INLINE',
      `A fact's Markdown must be one line of inline text (marks, links, <br> and mentions); this is ${
        blocks.length === 0 ? 'empty' : kinds.join(', ')
      }. Write it on one line without headings, lists or blank lines.`,
      { blocks: kinds },
    );
  }
  const runs = Array.isArray(blocks[0]!.content) ? (blocks[0]!.content as Obj[]) : [];
  for (const r of runs) {
    if (r.mention !== undefined || r.break === true) continue;
    const extra = Object.keys(r).filter((k) => !ROW_RUN_KEYS.has(k));
    if (extra.length > 0) {
      throw new FactValueError(
        'FACT_VALUE_NOT_INLINE',
        `A fact's value cannot hold ${extra.join(', ')} (only bold, italic, underline, strike, code, links, sub, sup, line breaks and mentions).`,
        { fields: extra },
      );
    }
  }
  return runs.map((r) => ({ ...r }));
}
