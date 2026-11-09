/**
 * Limits checked before anything is sent (docs/PLAN-v2.md 4.7 rule 5): the editor's structural limits (LegendKeeper
 * answers INVALID_CONTENT for a schema-valid tree "the editor cannot hold") and the spec's field limits (lengths, item
 * counts, nesting depth 64).
 *
 * EDITOR_RULES is the one list of editor limits. Each rule says where it comes from. To add a limit the round-trip
 * script or a sandbox write finds, add an entry here (and a line in docs/markdown.md); nothing else changes. Rules are
 * written from a block's own point of view (its kind, its parent, its position), so a violation is reported at the
 * block that causes it.
 */
import { CONTAINER_KINDS, isObj } from './model.js';
import { LIMIT_KEYWORDS, MAX_BLOCK_DEPTH, validateAgainstSpec, type SchemaIssue } from './schema.js';
import type { LkBlock } from './types.js';

export interface RuleContext {
  /** Ancestors, outermost first (empty at the top level). */
  readonly ancestors: readonly LkBlock[];
  /** Position among the parent's children. */
  readonly index: number;
}

export interface EditorRule {
  /** Stable id, reported in errors (`details.rule`). */
  readonly id: string;
  /** What the editor refuses, in words an agent can act on. */
  readonly message: string;
  /** Where the limit comes from. */
  readonly source: string;
  /** True when the block breaks the rule. */
  readonly breaks: (block: LkBlock, ctx: RuleContext) => boolean;
}

const parentKind = (c: RuleContext): string => c.ancestors[c.ancestors.length - 1]?.kind ?? 'root';
const LISTS = new Set(['bulletList', 'orderedList']);
const textMarks = ['bold', 'italic', 'underline', 'strike', 'sub', 'sup', 'link', 'color', 'highlight'];

function runs(b: LkBlock): Record<string, unknown>[] {
  return Array.isArray(b.content) ? (b.content as unknown[]).filter(isObj) : [];
}

export const EDITOR_RULES: readonly EditorRule[] = [
  {
    id: 'listItem.parent',
    message: 'A list item must sit directly in a bulleted or numbered list.',
    source: 'Spec ListItemBlock; PLAN-v2 4.7 rule 5 ("a listItem at the top level").',
    breaks: (b, c) => b.kind === 'listItem' && !LISTS.has(parentKind(c)),
  },
  {
    id: 'list.children',
    message: 'A bulleted or numbered list holds only list items.',
    source: 'Spec BulletListBlock / OrderedListBlock (children are list items in the editor).',
    breaks: (b, c) => LISTS.has(parentKind(c)) && b.kind !== 'listItem',
  },
  {
    id: 'listItem.firstChild',
    message: 'A list item starts with a paragraph.',
    source: 'Spec ListItemBlock: "The first child must be a paragraph".',
    breaks: (b, c) => parentKind(c) === 'listItem' && c.index === 0 && b.kind !== 'paragraph',
  },
  {
    id: 'listItem.nested',
    message: 'After its first paragraph, a list item holds only nested bulleted or numbered lists.',
    source: 'Spec ListItemBlock: "nested bulletList and orderedList blocks follow it".',
    breaks: (b, c) => parentKind(c) === 'listItem' && c.index > 0 && !LISTS.has(b.kind),
  },
  {
    id: 'taskItem.parent',
    message: 'A task must sit directly in a task list.',
    source: 'Spec TaskListBlock / TaskItemBlock.',
    breaks: (b, c) => b.kind === 'taskItem' && parentKind(c) !== 'taskList',
  },
  {
    id: 'taskList.children',
    message: 'A task list holds only tasks.',
    source: 'Spec TaskListBlock.',
    breaks: (b, c) => parentKind(c) === 'taskList' && b.kind !== 'taskItem',
  },
  {
    id: 'tableRow.parent',
    message: 'A table row must sit directly in a table.',
    source: 'Spec TableBlock / TableRowBlock.',
    breaks: (b, c) => b.kind === 'tableRow' && parentKind(c) !== 'table',
  },
  {
    id: 'table.children',
    message: 'A table holds only rows.',
    source: 'Spec TableBlock.',
    breaks: (b, c) => parentKind(c) === 'table' && b.kind !== 'tableRow',
  },
  {
    id: 'tableCell.parent',
    message: 'A table cell must sit directly in a table row.',
    source: 'Spec TableRowBlock / TableCellBlock.',
    breaks: (b, c) => b.kind === 'tableCell' && parentKind(c) !== 'tableRow',
  },
  {
    id: 'tableRow.children',
    message: 'A table row holds only cells.',
    source: 'Spec TableRowBlock.',
    breaks: (b, c) => parentKind(c) === 'tableRow' && b.kind !== 'tableCell',
  },
  {
    id: 'layoutColumn.parent',
    message: 'A layout column must sit directly in a layout.',
    source: 'Spec LayoutBlock / LayoutColumnBlock.',
    breaks: (b, c) => b.kind === 'layoutColumn' && parentKind(c) !== 'layout',
  },
  {
    id: 'layout.children',
    message: 'A layout holds only columns.',
    source: 'Spec LayoutBlock.',
    breaks: (b, c) => parentKind(c) === 'layout' && b.kind !== 'layoutColumn',
  },
  {
    id: 'tableCell.expandList',
    message: 'A list cannot sit inside an expand block inside a table cell.',
    source:
      "PLAN-v2 4.7 rule 5 (the plan's example of an editor limit; to be confirmed by the round-trip script).",
    breaks: (b, c) => {
      if (!LISTS.has(b.kind) && b.kind !== 'taskList') return false;
      const i = c.ancestors.findIndex((a) => a.kind === 'tableCell');
      return i >= 0 && c.ancestors.slice(i + 1).some((a) => a.kind === 'expand');
    },
  },
  {
    id: 'callout.color',
    message: 'A callout colour is accepted only with tone "custom".',
    source: 'Spec CalloutBlock.color: "Accepted only when tone is custom".',
    breaks: (b) => b.kind === 'callout' && b.color !== undefined && b.tone !== 'custom',
  },
  {
    id: 'map.ids',
    message: 'A map block names both its resource and its document, or neither.',
    source: 'Spec MapBlock: "Name both ids or neither".',
    breaks: (b) => b.kind === 'map' && (b.resourceId === undefined) !== (b.documentId === undefined),
  },
  {
    id: 'run.codeAlone',
    message: 'Inline code carries no other formatting (no bold, italic, link…).',
    source: 'Spec Run: "A run with code: true carries no other mark".',
    breaks: (b) =>
      runs(b).some((r) => r.code === true && textMarks.some((k) => r[k] !== undefined && r[k] !== false)),
  },
  {
    id: 'run.subSup',
    message: 'Text is subscript or superscript, not both.',
    source: 'Spec Run: "a run carries at most one of sub and sup".',
    breaks: (b) => runs(b).some((r) => r.sub === true && r.sup === true),
  },
];

export interface LimitProblem {
  readonly code: 'EDITOR_LIMIT' | 'FIELD_LIMIT' | 'SCHEMA_VIOLATION';
  readonly message: string;
  readonly blockId: string | null;
  readonly kind: string;
  readonly rule?: string;
  readonly path?: string;
}

/** Editor-limit problems of one block in its place. */
export function editorProblems(block: LkBlock, ctx: RuleContext): LimitProblem[] {
  const out: LimitProblem[] = [];
  for (const r of EDITOR_RULES) {
    if (r.breaks(block, ctx))
      out.push({
        code: 'EDITOR_LIMIT',
        message: r.message,
        blockId: typeof block.id === 'string' ? block.id : null,
        kind: block.kind,
        rule: r.id,
      });
  }
  return out;
}

/**
 * Field-limit and schema problems of one block's own fields (its children are checked as blocks of their own). A
 * colour on text is explained: the API's run schema has no colour yet.
 */
export function fieldProblems(block: LkBlock, depth: number): LimitProblem[] {
  const out: LimitProblem[] = [];
  const id = typeof block.id === 'string' ? block.id : null;
  if (depth > MAX_BLOCK_DEPTH)
    out.push({
      code: 'FIELD_LIMIT',
      message: `Blocks nest at most ${MAX_BLOCK_DEPTH} levels deep; this one is at level ${depth}.`,
      blockId: id,
      kind: block.kind,
      path: 'children',
    });
  const shallow =
    CONTAINER_KINDS.has(block.kind) && Array.isArray(block.children) ? { ...block, children: [] } : block;
  const issues: SchemaIssue[] = validateAgainstSpec(shallow, 'Block');
  if (Array.isArray(block.children) && block.children.length > 10_000)
    issues.push({
      path: 'children',
      keyword: 'maxItems',
      message: `holds ${block.children.length} items; the limit is 10000`,
    });
  for (const i of issues) {
    const colour = /content\[\d+\]\.(color|highlight)$/.test(i.path) && i.keyword === 'additionalProperties';
    out.push({
      code: LIMIT_KEYWORDS.has(i.keyword) ? 'FIELD_LIMIT' : 'SCHEMA_VIOLATION',
      message: colour
        ? `${i.path}: LegendKeeper's API cannot store text colours or highlights yet; remove the <span style>.`
        : `${i.path || '(block)'} ${i.message}`,
      blockId: id,
      kind: block.kind,
      path: i.path,
    });
  }
  return out;
}
