/**
 * write_page's in-lock planner (v2 C1, ADR 0031; PLAN-v2 10.6). The engine calls it inside the document lock when its
 * own compare-and-swap finds that the page changed between the plan and the write. Only section edits are re-planned,
 * and only when the targeted section's Markdown is exactly what it was when the write was planned (its SHA-256 is in the
 * step); the edit is then applied again, by the same converter, to the page as it is now. Anything else is a conflict
 * and nothing is sent.
 */
import { JobsError, VersionConflictError } from '../jobs/errors.js';
import type { ReplanContext, ReplanResult, StepPlanner } from '../jobs/planners.js';
import {
  applyEdit,
  getSection,
  MarkdownError,
  toMarkdown,
  type EditMode,
  type FromMarkdownContext,
  type LkBlock,
} from '../markdown/index.js';
import { PageVersionConflictError, SECTION_MODES, sha256 } from './plan.js';
import type { DocumentVersions } from './versions.js';

export const WRITE_PAGE_PLANNER = 'write_page';

/** What a write_page step stores for its planner (`options.replan.input`). */
export interface WritePageReplanInput {
  readonly mode: EditMode;
  readonly section: string;
  readonly markdown: string;
  readonly dropRegions?: readonly string[];
  /** SHA-256 of the section's Markdown at the planned version. */
  readonly sectionHash: string;
}

export interface WritePagePlannerDeps {
  /** The converter context for a project (name resolution over its repository tree); undefined when unavailable. */
  readonly contextFor: (projectId: string) => FromMarkdownContext | undefined;
  readonly versions?: DocumentVersions | undefined;
}

function isInput(v: unknown): v is WritePageReplanInput {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.mode === 'string' &&
    SECTION_MODES.has(o.mode as EditMode) &&
    typeof o.section === 'string' &&
    typeof o.markdown === 'string' &&
    typeof o.sectionHash === 'string'
  );
}

export function createWritePagePlanner(deps: WritePagePlannerDeps): StepPlanner {
  return (c: ReplanContext): ReplanResult => {
    const ref = { jobId: c.jobId, stepNo: c.stepNo };
    if (!isInput(c.input)) {
      throw new VersionConflictError(c.opId, c.plannedVersion, c.current.version, ref);
    }
    const input = c.input;
    const blocks = ((c.current.body as { blocks?: unknown } | undefined)?.blocks ?? []) as LkBlock[];
    const md = toMarkdown({ blocks }).markdown;
    const documentId = c.params.path?.documentId;
    if (documentId) deps.versions?.remember(c.projectId, documentId, c.current.version, md);
    let now: string;
    let path: string;
    try {
      const s = getSection(md, input.section);
      now = s.markdown;
      path = s.heading.path;
    } catch (e) {
      throw new PageVersionConflictError(
        'section_gone',
        c.plannedVersion,
        c.current.version,
        { section: input.section, ...(e instanceof MarkdownError ? { markdownError: e.toJSON() } : {}) },
        ref,
      );
    }
    const extra = {
      section: path,
      ...(now.length > 30_000
        ? { currentSection: `${now.slice(0, 30_000)}…`, currentSectionTruncated: true }
        : { currentSection: now }),
    };
    if (sha256(now) !== input.sectionHash) {
      throw new PageVersionConflictError('section_changed', c.plannedVersion, c.current.version, extra, ref);
    }
    const ctx = deps.contextFor(c.projectId);
    if (!ctx) {
      throw new PageVersionConflictError(
        'replan_refused',
        c.plannedVersion,
        c.current.version,
        { ...extra, why: 'the repository tree is not available to resolve mentions' },
        ref,
      );
    }
    let result;
    try {
      result = applyEdit(
        { blocks },
        {
          mode: input.mode,
          section: input.section,
          markdown: input.markdown,
          ...(input.dropRegions && input.dropRegions.length > 0 ? { dropRegions: input.dropRegions } : {}),
        },
        ctx,
      );
    } catch (e) {
      if (e instanceof JobsError) throw e;
      throw new PageVersionConflictError(
        'replan_refused',
        c.plannedVersion,
        c.current.version,
        {
          ...extra,
          why: e instanceof Error ? e.message : String(e),
          ...(e instanceof MarkdownError ? { markdownError: e.toJSON() } : {}),
        },
        ref,
      );
    }
    if (result.plan.empty) return { kind: 'unchanged', note: { sectionUnchanged: true } };
    return {
      kind: 'replanned',
      params: { ...c.params, ifMatch: c.current.version, body: { blocks: result.blocks } },
      note: { sectionUnchanged: true },
    };
  };
}
