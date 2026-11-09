/**
 * Markdown → "drafts": the blocks the Markdown shows (projections, see model.ts), plus references to keep regions and
 * raw `lk-block` blocks. Matching drafts against the current page happens in rebuild.ts.
 *
 * Parsing uses micromark (CommonMark) through mdast-util-from-markdown, with GFM tables, strikethrough and task list
 * items, and this converter's own `[[Name]]` construct (wiki-syntax.ts). GFM autolink literals and footnotes are off:
 * a bare URL stays text, so text never turns into a link on its way back.
 */
import type {
  Blockquote,
  Code,
  Definition,
  Heading,
  Html,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import { fromMarkdown as mdastFromMarkdown } from 'mdast-util-from-markdown';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { MarkdownError } from './errors.js';
import { CALLOUT_TONES, isObj, sameMarks, toLkRuns, type Marks, type NRun, type Obj } from './model.js';
import { validateAgainstSpec } from './schema.js';
import type { LkBlock, MarkdownWarning, ResolveMention } from './types.js';
import { lkWikiFromMarkdown, lkWikiSyntax, type LkWikiNode } from './wiki-syntax.js';

// ------------------------------------------------------------------------------------------------ drafts

export interface DraftBlock {
  readonly t: 'block';
  /** The block's own projected fields (no `children`). */
  readonly own: LkBlock;
  /** Children of a container, else null. */
  readonly children: Draft[] | null;
  readonly line: number;
  fp?: number;
  fpBy?: object;
}
export interface DraftKeep {
  readonly t: 'keep';
  readonly id: string;
  readonly kind: string;
  /** The region's content as written, normalised (see `normaliseRegionText`). */
  readonly inner: string;
  readonly line: number;
}
export interface DraftRaw {
  readonly t: 'raw';
  readonly block: LkBlock;
  readonly line: number;
}
export type Draft = DraftBlock | DraftKeep | DraftRaw;

export interface ParseOptions {
  readonly resolveMention?: ResolveMention | undefined;
  /** Collect `[[…]]` names instead of resolving them (collectMentionNames). */
  readonly collectNames?: string[];
}

export interface ParseResult {
  readonly drafts: Draft[];
  readonly warnings: MarkdownWarning[];
}

// ------------------------------------------------------------------------------------------------ mdast

/** Parses Markdown into mdast with the converter's extensions. */
export function parseMdast(md: string): Root {
  return mdastFromMarkdown(md, {
    extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem(), lkWikiSyntax()],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
      lkWikiFromMarkdown(),
    ],
  });
}

export const KEEP_OPEN_RE = /^<!--\s*lk:keep\s+id="([^"]*)"\s+kind="([^"]*)"\s*-->$/;
export const KEEP_CLOSE_RE = /^<!--\s*\/lk:keep\s*-->$/;
const EMPTY_PARAGRAPH_RE = /^<p>\s*<\/p>$/i;
const BR_ONLY_RE = /^(?:<br\s*\/?>\s*)+$/i;
const COMMENT_RE = /^<!--[\s\S]*-->$/;

/** Region text compared loosely: container prefixes (`>`, indentation) and blank lines do not count as edits. */
export function normaliseRegionText(s: string): string {
  return s
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/^[\s>]*/, '').trimEnd())
    .filter((l) => l !== '')
    .join('\n');
}

const lineOf = (n: { position?: { start: { line: number } } | undefined }): number =>
  n.position?.start.line ?? 0;

// ------------------------------------------------------------------------------------------------ the parser

const HTML_MARKS: Readonly<Record<string, keyof Marks>> = {
  u: 'underline',
  ins: 'underline',
  sub: 'sub',
  sup: 'sup',
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
};
const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(\s[^>]*?)?\s*(\/?)>$/;

interface HtmlOpen {
  readonly tag: string;
  readonly marks: Marks;
}

class Parser {
  readonly warnings: MarkdownWarning[] = [];
  private readonly definitions = new Map<string, Definition>();
  private readonly usedDefinitions = new Set<string>();
  private htmlStack: HtmlOpen[] = [];
  private readonly wikiProblems: { name: string; result: 'not_found' | 'ambiguous'; candidates?: unknown }[] =
    [];

  constructor(
    private readonly src: string,
    private readonly opts: ParseOptions,
  ) {}

  warn(code: MarkdownWarning['code'], message: string, at?: string): void {
    this.warnings.push({ code, message, ...(at !== undefined ? { at } : {}) });
  }

  run(root: Root): Draft[] {
    this.collectDefinitions(root);
    const drafts = this.flow(root.children);
    const unused = [...this.definitions.values()].filter((d) => !this.usedDefinitions.has(d.identifier));
    if (unused.length > 0 && !this.opts.collectNames) {
      const d = unused[0]!;
      throw new MarkdownError(
        'UNSUPPORTED_MARKDOWN',
        `Line ${lineOf(d)} reads as a link reference definition ([${d.label ?? d.identifier}]: ${d.url}), which no link uses and which would vanish from the page. To write it as text, escape the bracket: \\[${d.label ?? d.identifier}]: …`,
        {
          line: lineOf(d),
          definitions: unused.map((x) => ({ label: x.label ?? x.identifier, line: lineOf(x) })),
        },
      );
    }
    if (this.wikiProblems.length > 0) {
      const first = this.wikiProblems[0]!;
      const list = this.wikiProblems.map(
        (p) => `[[${p.name}]] (${p.result === 'ambiguous' ? 'several pages match' : 'no page matches'})`,
      );
      throw new MarkdownError(
        first.result === 'ambiguous' ? 'MENTION_AMBIGUOUS' : 'MENTION_NOT_FOUND',
        `These mentions do not name exactly one page: ${list.join(', ')}. Use a more exact name, or a link to the page id: [label](lk://resources/<id>).`,
        { problems: this.wikiProblems },
      );
    }
    return drafts;
  }

  private collectDefinitions(node: Nodes): void {
    if (node.type === 'definition') {
      if (!this.definitions.has(node.identifier)) this.definitions.set(node.identifier, node);
      return;
    }
    if ('children' in node) for (const c of node.children as Nodes[]) this.collectDefinitions(c);
  }

  // ---------------------------------------------------------------------------------------------- flow

  flow(nodes: readonly RootContent[]): Draft[] {
    const out: Draft[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.type === 'html') {
        const v = n.value.trim();
        const open = KEEP_OPEN_RE.exec(v);
        if (open) {
          let j = i + 1;
          while (j < nodes.length) {
            const m = nodes[j]!;
            if (m.type === 'html') {
              const mv = m.value.trim();
              if (KEEP_CLOSE_RE.test(mv)) break;
              if (KEEP_OPEN_RE.test(mv))
                throw new MarkdownError(
                  'KEEP_REGION_MALFORMED',
                  `The keep region "${open[1]}" (line ${lineOf(n)}) is not closed before the next one starts (line ${lineOf(m)}). Each <!-- lk:keep … --> needs its own <!-- /lk:keep --> at the same level.`,
                  { id: open[1], line: lineOf(n) },
                );
            }
            j++;
          }
          if (j >= nodes.length)
            throw new MarkdownError(
              'KEEP_REGION_MALFORMED',
              `The keep region "${open[1]}" (line ${lineOf(n)}) has no closing <!-- /lk:keep --> at the same level.`,
              { id: open[1], line: lineOf(n) },
            );
          const id = open[1]!;
          if (id === '' || open[2] === '')
            throw new MarkdownError(
              'KEEP_REGION_MALFORMED',
              `A keep region on line ${lineOf(n)} has an empty id or kind.`,
              {
                line: lineOf(n),
              },
            );
          const a = n.position?.end.offset ?? 0;
          const b = nodes[j]!.position?.start.offset ?? a;
          out.push({
            t: 'keep',
            id,
            kind: open[2]!,
            inner: normaliseRegionText(this.src.slice(a, b)),
            line: lineOf(n),
          });
          i = j;
          continue;
        }
        if (KEEP_CLOSE_RE.test(v))
          throw new MarkdownError(
            'KEEP_REGION_MALFORMED',
            `Line ${lineOf(n)} closes a keep region that was never opened at this level.`,
            { line: lineOf(n) },
          );
        if (EMPTY_PARAGRAPH_RE.test(v)) {
          out.push(this.block({ kind: 'paragraph', content: [] }, null, n));
          continue;
        }
        if (BR_ONLY_RE.test(v)) {
          const count = (v.match(/<br/gi) ?? []).length;
          out.push(
            this.block(
              { kind: 'paragraph', content: Array.from({ length: count }, () => ({ break: true })) },
              null,
              n,
            ),
          );
          continue;
        }
        if (COMMENT_RE.test(v)) {
          this.warn(
            'HTML_COMMENT_IGNORED',
            `The HTML comment on line ${lineOf(n)} is not page content and was left out.`,
          );
          continue;
        }
        throw new MarkdownError(
          'UNSUPPORTED_HTML',
          `Line ${lineOf(n)} holds HTML LegendKeeper pages cannot hold: ${JSON.stringify(v.slice(0, 80))}. Write Markdown instead (an empty paragraph is <p></p> followed by a blank line).`,
          { line: lineOf(n) },
        );
      }
      out.push(...this.flowNode(n));
    }
    return out;
  }

  private block(
    own: LkBlock,
    children: Draft[] | null,
    n: { position?: { start: { line: number } } | undefined },
  ): DraftBlock {
    return { t: 'block', own, children, line: lineOf(n) };
  }

  private container(kind: string, own: Obj, kids: readonly RootContent[], n: RootContent): DraftBlock {
    let children = this.flow(kids);
    if (children.length === 0) children = [this.block({ kind: 'paragraph', content: [] }, null, n)];
    return this.block({ kind, ...own }, children, n);
  }

  private flowNode(n: RootContent): Draft[] {
    switch (n.type) {
      case 'heading':
        return [this.heading(n)];
      case 'paragraph':
        return [this.paragraph(n)];
      case 'thematicBreak':
        return [this.block({ kind: 'rule' }, null, n)];
      case 'code':
        return [this.code(n)];
      case 'blockquote':
        return [this.quote(n)];
      case 'list':
        return this.list(n);
      case 'table':
        return [this.table(n)];
      case 'definition':
        return [];
      default:
        throw new MarkdownError(
          'UNSUPPORTED_MARKDOWN',
          `Line ${lineOf(n)}: ${n.type} has no LegendKeeper equivalent.`,
          { line: lineOf(n), type: n.type },
        );
    }
  }

  private heading(n: Heading): DraftBlock {
    return this.block({ kind: 'heading', level: n.depth, content: this.inline(n.children) }, null, n);
  }

  private paragraph(n: Paragraph): DraftBlock {
    const kids = n.children;
    if (kids.length === 1 && (kids[0]!.type === 'image' || kids[0]!.type === 'imageReference')) {
      const img = kids[0];
      let url: string;
      let title: string | null | undefined;
      if (img.type === 'image') {
        url = img.url;
        title = img.title;
      } else {
        const d = this.definitions.get(img.identifier);
        this.usedDefinitions.add(img.identifier);
        url = d?.url ?? '';
        title = d?.title;
      }
      if (title)
        this.warn(
          'TITLE_IGNORED',
          `The image title on line ${lineOf(n)} was ignored: LegendKeeper images keep their own title.`,
        );
      const alt = img.alt ?? '';
      return this.block({ kind: 'image', url, ...(alt !== '' ? { alt } : {}) }, null, n);
    }
    return this.block({ kind: 'paragraph', content: this.inline(kids) }, null, n);
  }

  private code(n: Code): Draft {
    if ((n.lang ?? '').toLowerCase() === 'lk-block') return this.raw(n);
    const language = n.lang ? (n.meta ? `${n.lang} ${n.meta}` : n.lang) : '';
    return this.block({ kind: 'code', text: n.value, ...(language !== '' ? { language } : {}) }, null, n);
  }

  private raw(n: Code): DraftRaw {
    let v: unknown;
    try {
      v = JSON.parse(n.value);
    } catch (e) {
      throw new MarkdownError(
        'INVALID_LK_BLOCK',
        `The lk-block on line ${lineOf(n)} is not valid JSON: ${(e as Error).message}`,
        {
          line: lineOf(n),
        },
      );
    }
    if (!isObj(v))
      throw new MarkdownError(
        'INVALID_LK_BLOCK',
        `The lk-block on line ${lineOf(n)} must hold one block object.`,
        { line: lineOf(n) },
      );
    let stripped = 0;
    const strip = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(strip);
      if (!isObj(x)) return x;
      const o: Obj = {};
      for (const [k, val] of Object.entries(x)) {
        if (k === 'version' && typeof val === 'string') {
          stripped++;
          continue;
        }
        o[k] = strip(val);
      }
      return o;
    };
    const block = strip(v) as LkBlock;
    if (stripped > 0)
      this.warn(
        'LK_BLOCK_VERSION_STRIPPED',
        `The lk-block on line ${lineOf(n)} carried read-only "version" fields; they were removed.`,
      );
    const issues = validateAgainstSpec(block, 'Block');
    if (issues.length > 0) {
      throw new MarkdownError(
        'INVALID_LK_BLOCK',
        `The lk-block on line ${lineOf(n)} is not a block LegendKeeper accepts: ${issues
          .slice(0, 5)
          .map((i) => `${i.path || '(block)'} ${i.message}`)
          .join('; ')}.`,
        { line: lineOf(n), issues },
      );
    }
    return { t: 'raw', block, line: lineOf(n) };
  }

  /** `> [!info]` and friends: the marker must be written unescaped at the very start of the quote. */
  private marker(p: Paragraph): string | null {
    const first = p.children[0];
    if (first?.type !== 'text') return null;
    const m = /^\[!([A-Za-z]+)\]/.exec(first.value);
    if (!m) return null;
    const off = first.position?.start.offset;
    if (off === undefined || this.src[off] !== '[' || this.src[off + 1] !== '!') return null;
    return m[1]!.toLowerCase();
  }

  private quote(n: Blockquote): DraftBlock {
    const first = n.children[0];
    const name = first?.type === 'paragraph' ? this.marker(first) : null;
    if (name === null || first?.type !== 'paragraph') return this.container('quote', {}, n.children, n);
    const known = ['info', 'note', 'success', 'tip', 'warning', 'error', 'caution', 'secret', 'expand'];
    if (!known.includes(name)) {
      this.warn(
        'CALLOUT_TYPE_UNKNOWN',
        `Line ${lineOf(n)}: [!${name}] is not a callout LegendKeeper has (info, note, success or tip, warning, error or caution, secret, expand); it was kept as a plain quote.`,
      );
      return this.container('quote', {}, n.children, n);
    }
    // Split the first paragraph: the marker line, then the rest.
    const kids = [...first.children];
    const head = kids[0] as Extract<PhrasingContent, { type: 'text' }>;
    const afterMarker = head.value.slice(name.length + 3);
    const lineNodes: PhrasingContent[] = [];
    const restNodes: PhrasingContent[] = [];
    let inRest = false;
    const pushText = (value: string, into: PhrasingContent[]) => {
      if (value !== '') into.push({ ...head, value });
    };
    const nl = afterMarker.search(/\r?\n|\r/);
    if (nl >= 0) {
      pushText(afterMarker.slice(0, nl), lineNodes);
      pushText(afterMarker.slice(nl).replace(/^(?:\r?\n|\r)/, ''), restNodes);
      inRest = true;
    } else pushText(afterMarker, lineNodes);
    for (const k of kids.slice(1)) {
      if (!inRest && k.type === 'text') {
        const i = k.value.search(/\r?\n|\r/);
        if (i >= 0) {
          if (i > 0) lineNodes.push({ ...k, value: k.value.slice(0, i) });
          const rest = k.value.slice(i).replace(/^(?:\r?\n|\r)/, '');
          if (rest !== '') restNodes.push({ ...k, value: rest });
          inRest = true;
          continue;
        }
      }
      (inRest ? restNodes : lineNodes).push(k);
    }
    const stripOneSpace = (nodes: PhrasingContent[]) => {
      const f = nodes[0];
      if (f?.type === 'text' && f.value.startsWith(' ')) nodes[0] = { ...f, value: f.value.slice(1) };
      if (nodes[0]?.type === 'text' && nodes[0].value === '') nodes.shift();
    };
    stripOneSpace(lineNodes);
    const firstPara = (nodes: PhrasingContent[]): RootContent[] =>
      nodes.length > 0 ? [{ type: 'paragraph', children: nodes, position: first.position }] : [];
    const rest = n.children.slice(1);
    if (name === 'expand') {
      if (lineNodes.some((k) => k.type !== 'text'))
        this.warn(
          'FORMATTING_IGNORED',
          `Line ${lineOf(n)}: an expand title is plain text; its formatting was ignored.`,
        );
      const title = lineNodes
        .map(plainText)
        .join('')
        .replace(/\r?\n|\r/g, ' ');
      return this.container('expand', { title }, [...firstPara(restNodes), ...rest], n);
    }
    // Callouts and secrets: the marker line's text (if any) and the rest of the paragraph are one paragraph.
    const joined: PhrasingContent[] = [...lineNodes];
    if (lineNodes.length > 0 && restNodes.length > 0) joined.push({ type: 'text', value: ' ' });
    joined.push(...restNodes);
    if (name === 'secret') return this.container('secret', {}, [...firstPara(joined), ...rest], n);
    const tone = name === 'tip' ? 'success' : name === 'caution' ? 'error' : name;
    if (!CALLOUT_TONES.includes(tone)) return this.container('quote', {}, n.children, n);
    return this.container('callout', { tone }, [...firstPara(joined), ...rest], n);
  }

  private list(n: List): Draft[] {
    const tasks = n.children.map((i) => typeof i.checked === 'boolean');
    if (n.ordered) {
      if (tasks.some(Boolean)) {
        this.warn(
          'TASK_LIST_NUMBERING',
          `Line ${lineOf(n)}: a numbered task list became a task list; LegendKeeper task lists are not numbered.`,
        );
        return [
          this.block(
            { kind: 'taskList' },
            n.children.map((i) => this.taskItem(i)),
            n,
          ),
        ];
      }
      const start = n.start ?? 1;
      return [
        this.block(
          { kind: 'orderedList', ...(start !== 1 ? { start } : {}) },
          n.children.map((i) => this.listItem(i)),
          n,
        ),
      ];
    }
    // A bullet list mixing tasks and plain items becomes consecutive lists.
    const out: Draft[] = [];
    let i = 0;
    while (i < n.children.length) {
      const isTask = tasks[i]!;
      let j = i;
      while (j < n.children.length && tasks[j] === isTask) j++;
      const items = n.children.slice(i, j);
      out.push(
        isTask
          ? this.block(
              { kind: 'taskList' },
              items.map((it) => this.taskItem(it)),
              items[0]!,
            )
          : this.block(
              { kind: 'bulletList' },
              items.map((it) => this.listItem(it)),
              items[0]!,
            ),
      );
      i = j;
    }
    return out;
  }

  private listItem(i: ListItem): DraftBlock {
    return this.container('listItem', {}, i.children, i);
  }

  private taskItem(i: ListItem): DraftBlock {
    const kids = i.children;
    if (kids.length > 1 || (kids.length === 1 && kids[0]!.type !== 'paragraph'))
      throw new MarkdownError(
        'EDITOR_LIMIT',
        `Line ${lineOf(i)}: a task holds one line of text in LegendKeeper; it cannot hold other blocks or a nested list.`,
        { rule: 'taskItem.content', line: lineOf(i) },
      );
    const content = kids.length === 1 ? this.inline((kids[0] as Paragraph).children) : [];
    return this.block({ kind: 'taskItem', checked: i.checked === true, content }, null, i);
  }

  private table(n: Table): DraftBlock {
    if (n.align?.some((a) => a !== null))
      this.warn(
        'ALIGNMENT_IGNORED',
        `Line ${lineOf(n)}: column alignment is not something LegendKeeper tables hold; it was ignored.`,
      );
    const width = n.children[0]?.children.length ?? 0;
    const rows = n.children.map((r, ri) => {
      if (r.children.length > width)
        throw new MarkdownError(
          'UNSUPPORTED_MARKDOWN',
          `Line ${lineOf(r)}: this table row has ${r.children.length} cells but the header has ${width}; the extra cells would be lost. Write a | inside a cell as \\| (also in [[Name\\|label]]).`,
          { line: lineOf(r), cells: r.children.length, header: width },
        );
      const cells = r.children.map((c) =>
        this.block(
          { kind: 'tableCell', ...(ri === 0 ? { header: true } : {}) },
          [this.block({ kind: 'paragraph', content: this.inline(c.children) }, null, c)],
          c,
        ),
      );
      // A short row has empty cells at its end, as GFM shows it.
      while (cells.length < width)
        cells.push(
          this.block({ kind: 'tableCell' }, [this.block({ kind: 'paragraph', content: [] }, null, r)], r),
        );
      return this.block({ kind: 'tableRow' }, cells, r);
    });
    return this.block({ kind: 'table' }, rows, n);
  }

  // ---------------------------------------------------------------------------------------------- inline

  /** Phrasing content → LegendKeeper runs (normalised). */
  inline(nodes: readonly PhrasingContent[]): Obj[] {
    this.htmlStack = [];
    const runs: NRun[] = [];
    this.phrasing(nodes, {}, runs);
    if (this.htmlStack.length > 0) {
      this.warn(
        'HTML_TAG_UNBALANCED',
        `<${this.htmlStack.map((h) => h.tag).join('>, <')}> was not closed; it runs to the end of its line.`,
      );
      this.htmlStack = [];
    }
    return toLkRuns(mergeRuns(runs));
  }

  private effective(marks: Marks): Marks {
    let m: Marks = { ...marks };
    for (const h of this.htmlStack) m = { ...m, ...h.marks };
    return m;
  }

  private phrasing(nodes: readonly PhrasingContent[], marks: Marks, out: NRun[]): void {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          out.push({ t: 'text', text: n.value.replace(/\r?\n|\r/g, ' '), marks: this.effective(marks) });
          break;
        case 'emphasis':
          this.phrasing(n.children, { ...marks, italic: true }, out);
          break;
        case 'strong':
          this.phrasing(n.children, { ...marks, bold: true }, out);
          break;
        case 'delete':
          this.phrasing(n.children, { ...marks, strike: true }, out);
          break;
        case 'inlineCode':
          out.push({
            t: 'text',
            text: n.value.replace(/\r?\n|\r/g, ' '),
            marks: { ...this.effective(marks), code: true },
          });
          break;
        case 'break':
          out.push({ t: 'break' });
          break;
        case 'link':
          this.link(n.url, n.title, n.children, marks, out, n);
          break;
        case 'linkReference': {
          const d = this.definitions.get(n.identifier);
          this.usedDefinitions.add(n.identifier);
          this.link(d?.url ?? '', d?.title, n.children, marks, out, n);
          break;
        }
        case 'image':
        case 'imageReference':
          throw new MarkdownError(
            'INLINE_IMAGE',
            `Line ${lineOf(n)}: an image inside a line of text. In LegendKeeper an image is a block: put ![alt](url) on a line of its own.`,
            { line: lineOf(n) },
          );
        case 'html':
          this.html(n, out);
          break;
        case 'lkWiki':
          this.wiki(n, out);
          break;
        default:
          throw new MarkdownError(
            'UNSUPPORTED_MARKDOWN',
            `Line ${lineOf(n)}: ${n.type} has no LegendKeeper equivalent.`,
            {
              line: lineOf(n),
            },
          );
      }
    }
  }

  private link(
    url: string,
    title: string | null | undefined,
    kids: readonly PhrasingContent[],
    marks: Marks,
    out: NRun[],
    n: PhrasingContent,
  ): void {
    if (title)
      this.warn(
        'TITLE_IGNORED',
        `Line ${lineOf(n)}: the link title was ignored; LegendKeeper links have none.`,
      );
    const m = /^lk:\/\/resources\/([A-Za-z0-9_-]+)(?:\/docs\/([A-Za-z0-9_-]+))?$/.exec(url);
    if (m) {
      out.push({
        t: 'mention',
        resourceId: m[1]!,
        ...(m[2] !== undefined ? { documentId: m[2] } : {}),
        label: kids
          .map(plainText)
          .join('')
          .replace(/\r?\n|\r/g, ' '),
      });
      return;
    }
    if (/^lk:/i.test(url))
      throw new MarkdownError(
        'UNSUPPORTED_MARKDOWN',
        `Line ${lineOf(n)}: ${url} is not a mention link. Use lk://resources/<id> or lk://resources/<id>/docs/<documentId>.`,
        { line: lineOf(n) },
      );
    this.phrasing(kids, { ...marks, link: url }, out);
  }

  private html(n: Html, out: NRun[]): void {
    const v = n.value.trim();
    if (COMMENT_RE.test(v)) {
      if (!/^<!--\s*empty\s*-->$/i.test(v))
        this.warn(
          'HTML_COMMENT_IGNORED',
          `Line ${lineOf(n)}: an HTML comment is not page content and was left out.`,
        );
      return;
    }
    const m = TAG_RE.exec(v);
    if (!m) this.unsupportedHtml(n, v);
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = (m[3] ?? '').trim();
    const selfClosing = m[4] === '/';
    if (tag === 'br') {
      if (closing || attrs !== '') this.unsupportedHtml(n, v);
      out.push({ t: 'break' });
      return;
    }
    if (selfClosing) this.unsupportedHtml(n, v);
    if (closing) {
      if (attrs !== '') this.unsupportedHtml(n, v);
      for (let k = this.htmlStack.length - 1; k >= 0; k--) {
        if (this.htmlStack[k]!.tag === tag || (tag === 'span' && this.htmlStack[k]!.tag === 'span')) {
          this.htmlStack.splice(k, 1);
          return;
        }
      }
      if (tag in HTML_MARKS || tag === 'span') {
        this.warn('HTML_TAG_UNBALANCED', `Line ${lineOf(n)}: </${tag}> closes nothing; it was ignored.`);
        return;
      }
      this.unsupportedHtml(n, v);
    }
    if (tag === 'span') {
      this.htmlStack.push({ tag, marks: this.spanStyle(attrs, n, v) });
      return;
    }
    const mark = HTML_MARKS[tag];
    if (!mark || attrs !== '') this.unsupportedHtml(n, v);
    this.htmlStack.push({ tag, marks: { [mark]: true } });
  }

  private spanStyle(attrs: string, n: Html, v: string): Marks {
    const m = /^style\s*=\s*(?:"([^"]*)"|'([^']*)')$/i.exec(attrs);
    if (!m) this.unsupportedHtml(n, v);
    const marks: Marks = {};
    for (const decl of (m[1] ?? m[2] ?? '').split(';')) {
      if (decl.trim() === '') continue;
      const d = /^\s*([a-z-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*$/i.exec(decl);
      if (!d) this.unsupportedHtml(n, v);
      const prop = d[1]!.toLowerCase();
      if (prop === 'color') marks.color = d[2]!;
      else if (prop === 'background-color' || prop === 'background') marks.highlight = d[2]!;
      else this.unsupportedHtml(n, v);
    }
    return marks;
  }

  private unsupportedHtml(n: { position?: { start: { line: number } } | undefined }, v: string): never {
    throw new MarkdownError(
      'UNSUPPORTED_HTML',
      `Line ${lineOf(n)}: ${JSON.stringify(v.slice(0, 80))} is not HTML the converter understands. Inline HTML may be <u>, <sub>, <sup>, <br>, <strong>, <em>, <s>, <code> and <span style="color:#RRGGBB; background-color:#RRGGBB">; write anything else as text with a backslash before the < (\\<).`,
      { line: lineOf(n) },
    );
  }

  private wiki(n: LkWikiNode, out: NRun[]): void {
    if (this.opts.collectNames) {
      this.opts.collectNames.push(n.name);
      return;
    }
    const resolve = this.opts.resolveMention;
    if (!resolve)
      throw new MarkdownError(
        'MENTION_RESOLVER_MISSING',
        `${n.value} needs a name resolver, and none is available here. Link the page by id instead: [label](lk://resources/<id>).`,
        { name: n.name },
      );
    const r = resolve(n.name);
    if (r.status === 'resolved') {
      out.push({
        t: 'mention',
        resourceId: r.resourceId,
        ...(r.documentId !== undefined ? { documentId: r.documentId } : {}),
        label: n.label ?? '',
      });
      return;
    }
    this.wikiProblems.push(
      r.status === 'ambiguous'
        ? { name: n.name, result: 'ambiguous', candidates: r.candidates }
        : { name: n.name, result: 'not_found' },
    );
  }
}

/** Plain text of phrasing content (for labels, titles and alt text). */
export function plainText(n: PhrasingContent | Nodes): string {
  if (n.type === 'text' || n.type === 'inlineCode') return n.value;
  if (n.type === 'lkWiki') return n.label ?? n.name;
  if (n.type === 'break') return ' ';
  if (n.type === 'html') return BR_ONLY_RE.test(n.value.trim()) ? ' ' : '';
  if (n.type === 'image') return n.alt ?? '';
  if ('children' in n) return (n.children as Nodes[]).map(plainText).join('');
  return '';
}

/** Merges neighbouring text runs with identical marks and drops empty ones (what LegendKeeper does on write). */
export function mergeRuns(runs: readonly NRun[]): NRun[] {
  const out: NRun[] = [];
  for (const r of runs) {
    if (r.t === 'text') {
      if (r.text === '') continue;
      const prev = out[out.length - 1];
      if (prev?.t === 'text' && sameMarks(prev.marks, r.marks)) {
        out[out.length - 1] = { t: 'text', text: prev.text + r.text, marks: r.marks };
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

/** Parses Markdown into drafts. Throws `MarkdownError` for anything it cannot convert. */
export function parseDrafts(md: string, opts: ParseOptions = {}): ParseResult {
  const p = new Parser(md, opts);
  const drafts = p.run(parseMdast(md));
  return { drafts, warnings: p.warnings };
}

/** Parses one line of inline Markdown back into runs (the renderer's check). Null when it is not one paragraph. */
export function parseInlineLine(md: string): Obj[] | null {
  let root: Root;
  try {
    root = parseMdast(md);
  } catch {
    return null;
  }
  if (root.children.length !== 1) return null;
  const only = root.children[0]!;
  const p = new Parser(md, {});
  try {
    if (only.type === 'paragraph') {
      if (only.children.some((c) => c.type === 'image' || c.type === 'imageReference')) return null;
      return p.inline(only.children);
    }
    if (only.type === 'html' && BR_ONLY_RE.test(only.value.trim())) {
      return Array.from({ length: (only.value.match(/<br/gi) ?? []).length }, () => ({ break: true }));
    }
  } catch {
    return null;
  }
  return null;
}

/** Parses one table cell's inline Markdown, in a one-cell table, back into runs. Null when it is not one cell. */
export function parseInlineCell(cell: string): Obj[] | null {
  let root: Root;
  const md = `| ${cell} |\n| --- |\n`;
  try {
    root = parseMdast(md);
  } catch {
    return null;
  }
  const t = root.children[0];
  if (root.children.length !== 1 || t?.type !== 'table') return null;
  const row = t.children[0];
  if (t.children.length !== 1 || row?.children.length !== 1) return null;
  try {
    return new Parser(md, {}).inline(row.children[0]!.children);
  } catch {
    return null;
  }
}

/** Every `[[Name]]` in the Markdown, so an asynchronous resolver can look them up before converting. */
export function collectMentionNames(md: string): string[] {
  const names: string[] = [];
  const p = new Parser(md, { collectNames: names });
  try {
    p.run(parseMdast(md));
  } catch {
    // Collection is best effort: the real conversion reports the problem.
  }
  return [...new Set(names)];
}
