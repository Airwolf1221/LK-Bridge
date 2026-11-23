/**
 * Types shared by the Markdown converter (docs/PLAN-v2.md 4.7). LegendKeeper's block JSON is loosely typed here on
 * purpose: the converter must carry fields it does not know (styling added by LegendKeeper later) through unchanged,
 * so a block is "a `kind`, maybe an `id`, and anything else".
 */

/** A LegendKeeper block as `getDocumentBlocks` returns it (spec `Block`). Unknown fields are kept verbatim. */
export interface LkBlock {
  kind: string;
  id?: string;
  [field: string]: unknown;
}

/** A run inside `content` (spec `Run`): a text run with marks, a mention, or a line break. */
export type LkRun = Record<string, unknown>;

/** What `toMarkdown` and `fromMarkdown` accept as a document: the API's `DocumentBlocks`, or just its blocks. */
export type DocumentInput = { readonly blocks: readonly LkBlock[] } | readonly LkBlock[];

/** One keep region in the Markdown: a block Markdown cannot express, preserved exactly. */
export interface KeepRegion {
  /** The block id (or `anon-<n>` for a block LegendKeeper returned without one). */
  readonly id: string;
  /** The block's kind. */
  readonly kind: string;
  /** Why Markdown cannot show it, in a few words (for audits and the dashboard). */
  readonly reason: string;
}

export interface ToMarkdownContext {
  /**
   * Parse the produced Markdown again and prove it converts back to the same blocks (default true). A block that does
   * not survive becomes a keep region, with a warning, so the Markdown never misrepresents the page.
   */
  readonly selfCheck?: boolean;
}

export interface ToMarkdownResult {
  readonly markdown: string;
  readonly regions: readonly KeepRegion[];
  readonly warnings: readonly MarkdownWarning[];
}

/** What a name resolver answers for `[[Name]]`. Anything but `resolved` is a typed error on write. */
export type MentionResolution =
  | {
      readonly status: 'resolved';
      readonly resourceId: string;
      /** Set when the name means one document of the resource. */
      readonly documentId?: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly {
        readonly resourceId: string;
        readonly name: string;
        readonly path?: string;
      }[];
    }
  | { readonly status: 'not_found' };

/**
 * Resolves the name in `[[Name]]` and `[[Name|label]]` (PLAN-v2 4.4: ids, display names, raw names, aliases; exactly
 * one match). Session A3 implements it over the repository tree. It is synchronous because the tree is held in SQLite
 * through better-sqlite3; an asynchronous resolver can resolve `collectMentionNames(markdown)` first and answer from a
 * map (see `mapResolver`).
 */
export type ResolveMention = (name: string) => MentionResolution;

export interface FromMarkdownContext {
  /** Resolves `[[Name]]`. Without it, `[[…]]` is refused (`MENTION_RESOLVER_MISSING`). */
  readonly resolveMention?: ResolveMention;
  /**
   * Whether an image URL is an image asset of this project (A4's asset tree). Without it, URLs the page already holds
   * are accepted and any other https URL is accepted with an `IMAGE_URL_UNCHECKED` warning (LegendKeeper still refuses
   * a foreign URL with a 400, before writing anything).
   */
  readonly isProjectAsset?: (url: string) => boolean;
  /**
   * v3 F7 (ADR 0070, G11): added to an IMAGE_URL_REFUSED message: when the project's asset listing was last read live,
   * and when a retry may read it again.
   */
  readonly imageUrlNote?: string;
  /** Mints ids for new blocks (a cuid2, as `src/jobs/ids.ts` mints). Without it, new blocks have no id and LegendKeeper mints one. */
  readonly mintBlockId?: () => string;
}

export interface FromMarkdownOptions {
  /** Keep regions the caller agrees to delete (their block ids). Any other missing region is refused. */
  readonly dropRegions?: readonly string[];
  /** Also allow losing `unsupported` blocks (the existing guard's `allowUnsupportedLoss`). */
  readonly allowUnsupportedLoss?: boolean;
}

/** A warning: the conversion went ahead, but the caller should know. */
export interface MarkdownWarning {
  readonly code: MarkdownWarningCode;
  readonly message: string;
  /** A block id or a heading path, when there is one. */
  readonly at?: string;
}

export type MarkdownWarningCode =
  | 'KEEP_REGION_EDITED'
  | 'KEEP_REGION_KIND'
  | 'RENDERED_AS_KEEP_REGION'
  | 'HTML_COMMENT_IGNORED'
  | 'HTML_TAG_UNBALANCED'
  | 'TITLE_IGNORED'
  | 'ALIGNMENT_IGNORED'
  | 'CALLOUT_TYPE_UNKNOWN'
  | 'FORMATTING_IGNORED'
  | 'TASK_LIST_NUMBERING'
  | 'IMAGE_URL_UNCHECKED'
  | 'LK_BLOCK_VERSION_STRIPPED'
  | 'DROP_REGION_NOT_MISSING';

/** One block in a plan, with where it sits. */
export interface PlanBlockRef {
  readonly id: string | null;
  readonly kind: string;
  /** Parent block id (null at the top level). */
  readonly parentId: string | null;
  /** Position among the parent's children (top-level blocks for null). */
  readonly index: number;
}

/**
 * What a write would change, block by block, derived by comparing the new tree with the current one. `empty` is true
 * exactly when nothing changes: then no write is needed (PLAN-v2 4.7 rule 2).
 */
export interface WritePlan {
  readonly empty: boolean;
  /** Blocks kept exactly as they are (count; ids are not listed, a page can hold 10,000). */
  readonly kept: number;
  /** Blocks whose own fields changed (children changes are reported as added, removed or moved children). */
  readonly changed: readonly (PlanBlockRef & { readonly before: LkBlock; readonly after: LkBlock })[];
  /** Top-most new blocks, each with its whole subtree. */
  readonly added: readonly (PlanBlockRef & { readonly block: LkBlock; readonly afterId: string | null })[];
  /** Top-most removed blocks (their subtrees go with them). */
  readonly removed: readonly PlanBlockRef[];
  /** Blocks kept but placed under another parent or in another order. */
  readonly moved: readonly (PlanBlockRef & {
    readonly fromParentId: string | null;
    readonly fromIndex: number;
  })[];
  /** Keep regions whose blocks the write deletes (only with `dropRegions`). */
  readonly droppedRegions: readonly KeepRegion[];
}

export interface FromMarkdownResult {
  /** The whole new block tree, ready for `replaceDocumentBlocks`. */
  readonly blocks: LkBlock[];
  readonly plan: WritePlan;
  readonly warnings: readonly MarkdownWarning[];
}

export type EditMode = 'append' | 'prepend' | 'replace' | 'replace_section' | 'append_to_section';

export interface PageEdit extends FromMarkdownOptions {
  readonly mode: EditMode;
  /** Heading path such as `Biography > Early Life` (required for the two section modes, refused otherwise). */
  readonly section?: string;
  readonly markdown: string;
}

export interface OutlineEntry {
  readonly level: number;
  readonly text: string;
  /** The full heading path, `A > B > C`. */
  readonly path: string;
  /** 1-based line of the heading in the Markdown. */
  readonly line: number;
}

export interface Section {
  readonly heading: OutlineEntry;
  /** The section's Markdown, from its heading (or the keep region holding it) to the next heading of its level or higher. */
  readonly markdown: string;
  /** The section without its heading line. */
  readonly body: string;
  /** 1-based first and last line of the section in the Markdown. */
  readonly startLine: number;
  readonly endLine: number;
}
