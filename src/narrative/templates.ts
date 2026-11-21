/**
 * R4.1 (ADR 0066 amendment 1): which template a page was made from, for the canon and lifecycle guards' first-fill rule
 * (src/facts/template-defaults.ts): a value identical to the page's template default is replaced as a first fill.
 *
 * In order: inside the lock, the writing job's own `createResourceFromTemplate` step for the page (its stored steps);
 * then, for a page under Narratives only, the narrative template its kind is made from (the approved pack's
 * `narrative.templates`, found by name in the project's template list as the narrative tools find it; a page made in
 * the app from the Chapter template counts). Null when none tells, or when a name matches no template or more than one.
 *
 * Chosen: the template the repository tree recorded when the bridge copied a page (`template_id`) is NOT used. A
 * template's default may be a real value (an Arkona Core template holding Continuity "Main", the pack's fixed fact):
 * every Core made from it would then read its own "Main" as a default, and its Continuity could be changed without the
 * owner's canonical approval. Outside the request or job that makes a page, only a narrative page's template counts.
 */
import type { TemplateOfPage } from '../facts/template-defaults.js';
import { templateFromCopySteps } from '../facts/template-defaults.js';
import { cleanPrefixes, templateBaseKey } from '../registry/names.js';
import type { NarrativeRules } from '../packs/types.js';
import type { TreeQueries } from '../tree/index.js';
import { placeOf } from './layout.js';
import { narrativeScope, treeView, type PacksLike } from './scope.js';

/** The narrative template kinds (a key of the pack's `narrative.templates`) by the place a page holds. */
const KIND_TEMPLATE: Readonly<Record<string, keyof NarrativeRules['templates']>> = {
  storyMap: 'storyMap',
  actMap: 'actMap',
  chapterPlan: 'chapterPlan',
  chapter: 'chapter',
};

export interface PageTemplateDeps {
  readonly packs: PacksLike;
  readonly queries: Pick<TreeQueries, 'node' | 'children' | 'findByName' | 'sidebars'>;
  /** The project's templates as last read (the registry's list). */
  readonly templates: (projectId: string) => readonly { readonly id: string; readonly name: string | null }[];
  /** A job's stored steps (op and params), for its own template copies. */
  readonly jobSteps: (
    projectId: string,
    jobId: string,
  ) => readonly { readonly opId: string; readonly params?: unknown }[] | null;
}

export function pageTemplateReader(d: PageTemplateDeps): TemplateOfPage {
  return (projectId, resourceId, jobId) => {
    try {
      if (jobId) {
        const steps = d.jobSteps(projectId, jobId) ?? [];
        const own = templateFromCopySteps(
          steps.filter((s) => s.opId === 'createResourceFromTemplate').map((s) => s.params),
          resourceId,
        );
        if (own) return own;
      }
      const node = d.queries.node(projectId, resourceId).data;
      if (!node) return null;
      const scope = narrativeScope(d.packs, d.queries, projectId);
      if (!scope) return null;
      const place = placeOf(treeView(d.queries, projectId), scope.rules, scope.roots, resourceId);
      const which = place ? KIND_TEMPLATE[place.kind] : undefined;
      if (!which) return null;
      const want = templateBaseKey(cleanPrefixes(scope.rules.templates[which]).name);
      const hits = d
        .templates(projectId)
        .filter((t) => t.name && templateBaseKey(cleanPrefixes(t.name).name) === want);
      return hits.length === 1 ? hits[0]!.id : null;
    } catch {
      return null;
    }
  };
}
