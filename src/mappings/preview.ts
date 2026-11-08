/**
 * Read-only preview (chunk 6): given a resource id, which type rules of a set would match it, and what semantic type
 * results. It makes READS only (`getResource`, up the parent chain), through the job engine at priority P0 (the
 * dashboard's own class) as the system principal, so every call goes through the governor. It never writes, and it is
 * not exposed over MCP.
 *
 * What it can and cannot tell:
 * - **Subtree** rules: matched against the resource and its ancestors.
 * - **Tag** rules: matched against the resource's tags.
 * - **Template** rules: LegendKeeper does not record which template a resource was made from, so these are reported
 *   as `not_evaluable`, never as a match or a miss.
 *
 * Overlaps: the highest priority wins. Equal priorities are broken by how specific the selector is (the resource
 * itself, then the nearest ancestor, then a tag); if that still ties between different types, the result is flagged
 * `tie` and the first rule in the list is shown.
 */
import { JobsError, type JobEngine } from '../jobs/index.js';
import type { FieldMap, TypeRule } from './types.js';
import { describeSelector } from './summary.js';

export const MAX_ANCESTOR_READS = 32;

export interface PreviewMatch {
  readonly ruleId: string;
  readonly semanticType: string;
  readonly priority: number;
  readonly description: string;
  /** 0 = the resource itself, 1 = its parent, …; tag rules are 1000. */
  readonly specificity: number;
  readonly via: string;
}

export interface PreviewResult {
  readonly resource: { readonly id: string; readonly name: string | null; readonly tags: string[] };
  readonly ancestors: { readonly id: string; readonly name: string | null }[];
  /** True if the parent chain was cut short (LegendKeeper refused, or MAX_ANCESTOR_READS was reached). */
  readonly ancestorsIncomplete: boolean;
  readonly matches: PreviewMatch[];
  readonly notEvaluable: { readonly ruleId: string; readonly description: string; readonly reason: string }[];
  /** The resulting semantic type, or null when no evaluable rule matches. */
  readonly semanticType: string | null;
  readonly winner: PreviewMatch | null;
  /** More than one different type tied for the win. */
  readonly tie: boolean;
  /** The field maps defined for the resulting type (not applied to the page: this is only a preview). */
  readonly fields: FieldMap[];
  readonly readsMade: number;
}

type Resource = { id?: unknown; name?: unknown; parentId?: unknown; tags?: unknown };

export async function previewResource(args: {
  engine: JobEngine;
  rules: readonly TypeRule[];
  fields: readonly FieldMap[];
  resourceId: string;
}): Promise<PreviewResult> {
  const { engine, rules, fields, resourceId } = args;
  const origin = { kind: 'ui', tool: 'mappings-preview' } as const;
  let reads = 0;
  const read = async (id: string): Promise<Resource> => {
    reads++;
    const r = await engine.run('getResource', { path: { resourceId: id } }, { origin, priority: 'P0' });
    if (r.status !== 'succeeded')
      throw new JobsError('BRIDGE_ERROR', `Could not read resource ${id} now (${r.status})`);
    return r.result ?? {};
  };

  const self = await read(resourceId);
  const tags = Array.isArray(self.tags) ? self.tags.filter((t): t is string => typeof t === 'string') : [];
  const needsAncestors = rules.some((r) => r.selector.kind === 'subtree' && r.selector.descendants);
  const ancestors: { id: string; name: string | null }[] = [];
  let incomplete = false;
  if (needsAncestors) {
    let parent = typeof self.parentId === 'string' ? self.parentId : null;
    const seen = new Set<string>([resourceId]);
    while (parent && parent !== 'templates' && !seen.has(parent)) {
      if (ancestors.length >= MAX_ANCESTOR_READS) {
        incomplete = true;
        break;
      }
      seen.add(parent);
      let p: Resource;
      try {
        p = await read(parent);
      } catch {
        incomplete = true; // a parent that cannot be read ends the walk; matches so far still stand
        ancestors.push({ id: parent, name: null });
        break;
      }
      ancestors.push({ id: parent, name: typeof p.name === 'string' ? p.name : null });
      parent = typeof p.parentId === 'string' ? p.parentId : null;
    }
  }

  const matches: PreviewMatch[] = [];
  const notEvaluable: PreviewResult['notEvaluable'] = [];
  for (const r of rules) {
    const s = r.selector;
    const base = {
      ruleId: r.id,
      semanticType: r.semanticType,
      priority: r.priority,
      description: describeSelector(s),
    };
    if (s.kind === 'subtree') {
      if (s.resourceId === resourceId) matches.push({ ...base, specificity: 0, via: 'the resource itself' });
      else if (s.descendants) {
        const i = ancestors.findIndex((a) => a.id === s.resourceId);
        if (i >= 0)
          matches.push({
            ...base,
            specificity: i + 1,
            via: `an ancestor (${i + 1} ${i === 0 ? 'level' : 'levels'} up)`,
          });
      }
    } else if (s.kind === 'tag') {
      if (tags.includes(s.tag)) matches.push({ ...base, specificity: 1000, via: 'its tags' });
    } else {
      notEvaluable.push({
        ruleId: r.id,
        description: base.description,
        reason:
          'LegendKeeper does not record which template a resource was made from, so a template rule cannot be checked.',
      });
    }
  }
  matches.sort((a, b) => b.priority - a.priority || a.specificity - b.specificity);
  const winner = matches[0] ?? null;
  const tie =
    winner !== null &&
    matches.some(
      (m) =>
        m !== winner &&
        m.priority === winner.priority &&
        m.specificity === winner.specificity &&
        m.semanticType.toLowerCase() !== winner.semanticType.toLowerCase(),
    );
  const type = winner?.semanticType ?? null;
  return {
    resource: { id: resourceId, name: typeof self.name === 'string' ? self.name : null, tags },
    ancestors,
    ancestorsIncomplete: incomplete,
    matches,
    notEvaluable,
    semanticType: type,
    winner,
    tie,
    fields: type ? fields.filter((f) => f.semanticType.toLowerCase() === type.toLowerCase()) : [],
    readsMade: reads,
  };
}
