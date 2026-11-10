/**
 * `src/pages`: page writes (v2 C1, ADR 0031). Planning on B1's converter with the version rules, the bridge's memory of
 * recent page versions, the in-lock re-planner the job engine calls, and the Markdown diff. The tool is
 * src/mcp/tools/write-page.ts; the engine side (in-lock compare-and-swap, re-plan, verify read) is src/jobs.
 */
import { mintClientId } from '../jobs/ids.js';
import type { FromMarkdownContext } from '../markdown/index.js';
import { ROLE_LABEL, type MentionChoice, type Registry } from '../registry/index.js';
import type { TreeQueries } from '../tree/index.js';

export {
  planPageWrite,
  countPlan,
  sha256,
  PageVersionConflictError,
  SECTION_MODES,
  type ConflictReason,
  type CurrentDocument,
  type PageEditInput,
  type PagePlan,
  type PlanCounts,
  type PlanOptions,
} from './plan.js';
export {
  createWritePagePlanner,
  WRITE_PAGE_PLANNER,
  type WritePageReplanInput,
  type WritePagePlannerDeps,
} from './replan.js';
export {
  DocumentVersions,
  DEFAULT_DOCUMENT_VERSION_SETTINGS,
  type DocumentVersionSettings,
} from './versions.js';
export {
  markdownDiff,
  unifiedText,
  withPlaceholders,
  lineDiff,
  toHunks,
  type MarkdownDiff,
  type DiffHunk,
  type DiffLine,
} from './diff.js';

/**
 * The converter context for writes to a project's pages: `[[Name]]` resolved by A3's resolver over the repository tree
 * (exactly one page, inside the AI REPOSITORY), and an id minted for every new block, so the verify read can compare
 * ids. Image URLs are left to LegendKeeper, which refuses a foreign one before writing anything (ADR 0031). Undefined
 * when the tree cannot answer.
 */
export function pageConverterContext(
  services: {
    readonly tree: { readonly queries: TreeQueries };
    readonly registry: Pick<Registry, 'forProject'>;
  },
  projectId: string,
  o: {
    /** v2 C2b: told when a mention of several pages of one character went to its Core, Reference or index. */
    readonly onMentionChoice?: (c: MentionChoice & { name: string }) => void;
  } = {},
): FromMarkdownContext | undefined {
  const status = services.tree.queries.status(projectId).status;
  if (status !== 'ready' && status !== 'stale') return undefined;
  return {
    resolveMention: services.registry
      .forProject(projectId)
      .mentionResolver(o.onMentionChoice ? { onChoice: o.onMentionChoice } : {}),
    mintBlockId: mintClientId,
  };
}

/** v2 C2b: the mentions resolved by the character rule, as a result lists them (once per name). */
export function mentionChoices(
  choices: readonly (MentionChoice & { name: string })[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const c of choices) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      chosen: { id: c.chosen.id, name: c.chosen.rawName, role: ROLE_LABEL[c.role] },
      why: c.why,
      candidates: c.candidates.map((x) => ({ id: x.id, name: x.rawName, role: x.role })),
    });
  }
  return out;
}
