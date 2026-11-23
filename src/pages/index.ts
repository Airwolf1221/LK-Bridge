/**
 * `src/pages`: page writes (v2 C1, ADR 0031). Planning on B1's converter with the version rules, the bridge's memory of
 * recent page versions, the in-lock re-planner the job engine calls, and the Markdown diff. The tool is
 * src/mcp/tools/write-page.ts; the engine side (in-lock compare-and-swap, re-plan, verify read) is src/jobs.
 */
import { mintClientId } from '../jobs/ids.js';
import type { FromMarkdownContext } from '../markdown/index.js';
import { ROLE_LABEL, type MentionChoice, type Registry } from '../registry/index.js';
import type { TreeQueries } from '../tree/index.js';
import type { AssetQueries } from '../assets/queries.js';

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
    /** v3 F7 (ADR 0070, G11): the asset tree, so a new image's URL is checked against the project's assets. */
    readonly assets?: { readonly queries: Pick<AssetQueries, 'status' | 'assetByUrl'> } | undefined;
  },
  projectId: string,
  o: {
    /** v2 C2b: told when a mention of several pages of one character went to its Core, Reference or index. */
    readonly onMentionChoice?: (c: MentionChoice & { name: string }) => void;
    /**
     * v3 F7 (G11): URLs already confirmed as this project's assets (`prepareImageUrls`, which refreshes live once for
     * any the model did not hold); checked before the model.
     */
    readonly knownImageUrls?: ReadonlySet<string>;
  } = {},
): FromMarkdownContext | undefined {
  const status = services.tree.queries.status(projectId).status;
  if (status !== 'ready' && status !== 'stale') return undefined;
  // Only for a caller that ran `prepareImageUrls` (so a miss was looked up live once); others keep the warning.
  const isProjectAsset =
    o.knownImageUrls !== undefined
      ? projectAssetCheck(services.assets, projectId, o.knownImageUrls)
      : undefined;
  return {
    resolveMention: services.registry
      .forProject(projectId)
      .mentionResolver(o.onMentionChoice ? { onChoice: o.onMentionChoice } : {}),
    mintBlockId: mintClientId,
    ...(isProjectAsset ? { isProjectAsset } : {}),
  };
}

/**
 * v3 F7 (ADR 0070, G11): whether an image URL is one of this project's image assets, matched on the asset's exact `url`
 * (both forms LegendKeeper has used: `https://assets.legendkeeper.com/<projectId>_<uuid>.webp` and the older
 * `https://assets.legendkeeper.com/<uuid>.webp`). Only once the asset tree is built (while it is not, there is no check
 * and an unknown URL keeps its IMAGE_URL_UNCHECKED warning).
 */
export function projectAssetCheck(
  assets: { readonly queries: Pick<AssetQueries, 'status' | 'assetByUrl'> } | undefined,
  projectId: string,
  known?: ReadonlySet<string>,
): ((url: string) => boolean) | undefined {
  if (!assets) return undefined;
  const st = assets.queries.status(projectId).status;
  if (st === 'not_built' || st === 'building') return undefined;
  return (url) => known?.has(url) === true || assets.queries.assetByUrl(projectId, url).data !== null;
}

/**
 * v3 F7 (ADR 0070, G11): a converter with the image URL check, for a Markdown writer: the URLs `markdown` names that the
 * model lacks are looked up live once (`prepareImageUrls`), then every new image's URL must be one of the project's
 * image assets (else IMAGE_URL_REFUSED). URLs in `skip` (the page's own images) are not looked up.
 */
export async function withImageCheck<C extends FromMarkdownContext>(
  assets: Parameters<typeof prepareImageUrls>[0],
  projectId: string,
  converter: C,
  markdown: string | readonly string[],
  skip?: ReadonlySet<string>,
): Promise<C> {
  const known = await prepareImageUrls(assets, projectId, markdown, skip ? { skip } : {});
  const isProjectAsset = projectAssetCheck(assets, projectId, known);
  return isProjectAsset ? { ...converter, isProjectAsset } : converter;
}

/** v3 F7 (G11): the image URLs a page already holds (its image blocks, at any depth): those are never checked again. */
export function blockImageUrls(blocks: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o.kind === 'image' && typeof o.url === 'string') out.add(o.url);
    for (const x of Object.values(o)) if (typeof x === 'object') walk(x);
  };
  walk(blocks);
  return out;
}

/** v3 F7 (G11): the image URLs a piece of Markdown names (`![alt](url)`), in order, without repeats. */
export function markdownImageUrls(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/!\[(?:[^\]\\]|\\.)*\]\(\s*<?([^\s)>]+)>?/g)) if (m[1]) out.add(m[1]);
  return [...out];
}

/**
 * v3 F7 (ADR 0070, G11): before a Markdown write is planned, the image URLs it names that the asset tree does not hold
 * are looked up LIVE once (G9: the tree may be hours old, and an image uploaded since is a real asset). Returns the URLs
 * confirmed, for `pageConverterContext`'s `knownImageUrls`. Without the live service, or before the tree is built, none.
 */
export async function prepareImageUrls(
  assets:
    | {
        readonly queries: Pick<AssetQueries, 'status' | 'assetByUrl'>;
        readonly checkUrls?: (
          projectId: string,
          urls: readonly string[],
        ) => Promise<{ known: Set<string>; refreshed: boolean; requests: number }>;
      }
    | undefined,
  projectId: string,
  markdown: string | readonly string[],
  o: { readonly skip?: ReadonlySet<string> } = {},
): Promise<Set<string>> {
  if (!assets?.checkUrls) return new Set();
  const st = assets.queries.status(projectId).status;
  if (st === 'not_built' || st === 'building') return new Set();
  const urls = (typeof markdown === 'string' ? [markdown] : markdown)
    .flatMap(markdownImageUrls)
    .filter((u) => /^https:\/\//i.test(u) && o.skip?.has(u) !== true);
  if (urls.length === 0) return new Set();
  return (await assets.checkUrls(projectId, urls)).known;
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
