/**
 * Planning a page write (v2 C1, ADR 0031; PLAN-v2 4.7 and 10.6): the current document, the agent's edit and, when the
 * agent passed one, the version it read, give the new block tree, its write plan, the page's Markdown before and after,
 * and the counts the result reports. Pure apart from the version memory it is handed: no LegendKeeper calls.
 *
 * The version rules (requirement 1 of C1):
 * - no `baseVersion`, or the current version: plan on the current document;
 * - `baseVersion` older, in `replace`, `append` or `prepend`: a conflict (the whole page is the edit's context);
 * - `baseVersion` older, in a section mode: the section as the agent read it (rebuilt from the bridge's memory of that
 *   version) must equal the section now; then plan on the current document, else a conflict with the current version
 *   and the current section's text. A version the bridge does not remember is a conflict too. Never a silent merge.
 *
 * Every converter refusal (`MarkdownError`) is passed on unchanged: the tool turns it into a typed error.
 */
import { createHash } from 'node:crypto';
import { VersionConflictError, type JobRef } from '../jobs/errors.js';
import {
  applyEdit,
  getSection,
  MarkdownError,
  toMarkdown,
  type EditMode,
  type FromMarkdownContext,
  type KeepRegion,
  type LkBlock,
  type MarkdownWarning,
  type ToMarkdownResult,
  type WritePlan,
} from '../markdown/index.js';

export const SECTION_MODES: ReadonlySet<EditMode> = new Set(['replace_section', 'append_to_section']);

export interface PageEditInput {
  readonly mode: EditMode;
  readonly section?: string | undefined;
  readonly markdown: string;
  readonly dropRegions?: readonly string[] | undefined;
}

export interface CurrentDocument {
  readonly version: string;
  readonly blocks: readonly LkBlock[];
}

/** Why a write was refused as a conflict: the document is not as the agent's edit assumed. */
export type ConflictReason =
  /** `baseVersion` is older than the current version, in a whole-page mode. */
  | 'version_changed'
  /** The section changed since `baseVersion` (or since the plan, inside the lock). */
  | 'section_changed'
  /** The bridge no longer remembers the section at `baseVersion`, so it cannot tell whether it changed. */
  | 'base_unknown'
  /** The section did not exist (or was ambiguous) at `baseVersion`. */
  | 'section_missing_at_base'
  /** Inside the lock: the section is gone or ambiguous now. */
  | 'section_gone'
  /** Inside the lock: the edit cannot be applied to the current page (a mention no longer resolves, a limit…). */
  | 'replan_refused';

const SECTION_TEXT_MAX = 30_000;

/**
 * A page-write conflict: a `VersionConflictError` (so the engine and the tools treat it as one, never retried) with the
 * reason, and in a section mode the section as it is now, so the agent can redo its edit without another read.
 */
export class PageVersionConflictError extends VersionConflictError {
  override readonly name = 'VersionConflictError';
  constructor(
    readonly reason: ConflictReason,
    sentVersion: string | null,
    currentVersion: string | null,
    readonly extra: Readonly<Record<string, unknown>> = {},
    ref: JobRef = {},
  ) {
    super('replaceDocumentBlocks', sentVersion, currentVersion, ref);
    this.message = conflictMessage(reason, sentVersion, currentVersion, extra);
  }

  override toJSON() {
    return { ...super.toJSON(), reason: this.reason, ...this.extra };
  }
}

function conflictMessage(
  reason: ConflictReason,
  sent: string | null,
  current: string | null,
  extra: Readonly<Record<string, unknown>>,
): string {
  const now = current ? ` The current version is ${current}.` : '';
  const section = typeof extra.section === 'string' ? `“${extra.section}”` : 'the section';
  switch (reason) {
    case 'version_changed':
      return `The page changed since version ${sent ?? '(unknown)'}, which this edit was made from.${now} A whole-page edit (replace, append, prepend) needs the current page: read it again, redo the edit on it and pass the new version. Nothing was written.`;
    case 'section_changed':
      return `${section} changed since version ${sent ?? '(unknown)'}, which this edit was made from.${now} Its current text is in currentSection: redo the edit on it and pass the current version. Nothing was written.`;
    case 'base_unknown':
      return `The bridge no longer remembers the page at version ${sent ?? '(unknown)'}, so it cannot check that ${section} is unchanged.${now} Its current text is in currentSection: check your edit against it and pass the current version. Nothing was written.`;
    case 'section_missing_at_base':
      return `${section} was not a single section at version ${sent ?? '(unknown)'}.${now} Its current text is in currentSection: redo the edit on it and pass the current version. Nothing was written.`;
    case 'section_gone':
      return `${section} no longer exists as one section: the page changed while this write waited.${now} Read the page again. Nothing was written.`;
    case 'replan_refused':
      return `The page changed while this write waited, and the edit can no longer be applied to it (${typeof extra.why === 'string' ? extra.why : 'see markdownError'}).${now} Read the page again. Nothing was written.`;
  }
}

export interface PlanCounts {
  /** Blocks kept exactly as they were (all levels). */
  readonly kept: number;
  /** Blocks whose own content changed (they keep their id). */
  readonly changed: number;
  /** Blocks added, counting everything inside them. */
  readonly added: number;
  /** Blocks removed, counting everything inside them. */
  readonly removed: number;
  /** Blocks kept but moved. */
  readonly moved: number;
  /** Keep regions of the page that stay, and those the write deletes (dropRegions). */
  readonly regionsKept: number;
  readonly regionsDropped: number;
}

export interface PagePlan {
  /** The version the plan was built on (the current one). */
  readonly version: string;
  readonly blocks: LkBlock[];
  readonly plan: WritePlan;
  readonly warnings: readonly MarkdownWarning[];
  /** The page's Markdown before and after the write. */
  readonly before: string;
  readonly after: string;
  /** The keep regions of the current page. */
  readonly regions: readonly KeepRegion[];
  readonly counts: PlanCounts;
  /** Section modes: the section's heading path as found, and a SHA-256 of its Markdown at `version`. */
  readonly section?: { readonly path: string; readonly hash: string };
  /** Set when an older `baseVersion` was accepted because the section is unchanged. */
  readonly rebasedFrom?: string;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const clipSection = (md: string): Record<string, unknown> =>
  md.length > SECTION_TEXT_MAX
    ? { currentSection: `${md.slice(0, SECTION_TEXT_MAX)}…`, currentSectionTruncated: true }
    : { currentSection: md };

export interface PlanOptions {
  /** The version the agent read (optional; strongly recommended). */
  readonly baseVersion?: string | undefined;
  /** The bridge's memory of a version's Markdown (src/pages/versions.ts). */
  readonly markdownAt?: (version: string) => string | undefined;
  /** `toMarkdown` of the current blocks, when the caller already made it. */
  readonly rendered?: ToMarkdownResult | undefined;
}

/** Plans a page write on the current document (see the module comment). Throws `MarkdownError` or a conflict. */
export function planPageWrite(
  current: CurrentDocument,
  edit: PageEditInput,
  ctx: FromMarkdownContext,
  o: PlanOptions = {},
): PagePlan {
  const rendered = o.rendered ?? toMarkdown({ blocks: current.blocks });
  const before = rendered.markdown;
  const sectional = SECTION_MODES.has(edit.mode);
  let rebasedFrom: string | undefined;
  if (o.baseVersion !== undefined && o.baseVersion !== current.version) {
    if (!sectional) throw new PageVersionConflictError('version_changed', o.baseVersion, current.version);
    // The section now (a missing or ambiguous section is the converter's own refusal, with the options).
    const now = getSection(before, edit.section ?? '');
    const extra = { section: now.heading.path, ...clipSection(now.markdown) };
    const baseMd = o.markdownAt?.(o.baseVersion);
    if (baseMd === undefined)
      throw new PageVersionConflictError('base_unknown', o.baseVersion, current.version, extra);
    let then: string;
    try {
      then = getSection(baseMd, edit.section ?? '').markdown;
    } catch (e) {
      if (e instanceof MarkdownError)
        throw new PageVersionConflictError('section_missing_at_base', o.baseVersion, current.version, extra);
      throw e;
    }
    if (then !== now.markdown)
      throw new PageVersionConflictError('section_changed', o.baseVersion, current.version, extra);
    rebasedFrom = o.baseVersion;
  }
  const result = applyEdit(
    { blocks: current.blocks },
    {
      mode: edit.mode,
      ...(edit.section !== undefined ? { section: edit.section } : {}),
      markdown: edit.markdown,
      ...(edit.dropRegions && edit.dropRegions.length > 0 ? { dropRegions: edit.dropRegions } : {}),
    },
    ctx,
  );
  let section: PagePlan['section'];
  if (sectional) {
    try {
      const s = getSection(before, edit.section ?? '');
      section = { path: s.heading.path, hash: sha256(s.markdown) };
    } catch {
      // applyEdit found the section on the blocks; without its Markdown the lock cannot re-plan, only refuse.
      section = undefined;
    }
  }
  const after = result.plan.empty ? before : toMarkdown({ blocks: result.blocks }).markdown;
  return {
    version: current.version,
    blocks: result.blocks,
    plan: result.plan,
    warnings: result.warnings,
    before,
    after,
    regions: rendered.regions,
    counts: countPlan(current.blocks, result.plan, rendered.regions.length),
    ...(section ? { section } : {}),
    ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
  };
}

type Obj = Record<string, unknown>;

function subtreeSize(b: unknown): number {
  if (typeof b !== 'object' || b === null) return 0;
  const children = (b as Obj).children;
  return 1 + (Array.isArray(children) ? children.reduce((n: number, c) => n + subtreeSize(c), 0) : 0);
}

/** The block a plan reference names in the current tree: by id, else by its parent and position. */
function findRef(
  blocks: readonly LkBlock[],
  ref: { id: string | null; parentId: string | null; index: number },
): unknown {
  let byParent: unknown;
  const walk = (list: readonly unknown[], parentId: string | null): unknown => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i] as Obj;
      if (ref.id !== null && b.id === ref.id) return b;
      if (ref.id === null && parentId === ref.parentId && i === ref.index && byParent === undefined)
        byParent = b;
      if (Array.isArray(b.children)) {
        const hit = walk(b.children, typeof b.id === 'string' ? b.id : null);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(blocks, null) ?? byParent;
}

export function countPlan(blocks: readonly LkBlock[], plan: WritePlan, regions: number): PlanCounts {
  return {
    kept: plan.kept,
    changed: plan.changed.length,
    added: plan.added.reduce((n, a) => n + subtreeSize(a.block), 0),
    removed: plan.removed.reduce((n, r) => n + Math.max(1, subtreeSize(findRef(blocks, r))), 0),
    moved: plan.moved.length,
    regionsKept: regions - plan.droppedRegions.length,
    regionsDropped: plan.droppedRegions.length,
  };
}
