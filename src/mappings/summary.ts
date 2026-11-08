/** A readable account of a mapping set, in British English, for the Repository Mappings page. */
import type { FieldMap, Location, MappingSet, Selector, SetSummaryText, TypeRule } from './types.js';

export const describeSelector = (s: Selector): string =>
  s.kind === 'subtree'
    ? s.descendants
      ? `Resource ${s.resourceId} and everything below it`
      : `Resource ${s.resourceId} only`
    : s.kind === 'template'
      ? `Resources made from template ${s.templateId}`
      : `Resources tagged “${s.tag}”`;

export const describeLocation = (l: Location): string =>
  l.kind === 'sidebar_property'
    ? `Sidebar property “${l.title}”`
    : l.kind === 'infobox_row'
      ? `Infobox “${l.infoboxTitle}”, row “${l.rowKey}”`
      : l.heading !== undefined
        ? `Block under the heading “${l.heading}”`
        : `Block ${l.blockId ?? ''}`;

const KIND_LABEL: Record<string, string> = {
  text: 'text',
  number: 'a number',
  resource_link: 'a resource link',
  list: 'a list',
  date: 'a date',
  boolean: 'yes or no',
  image: 'an image',
  other: 'something else',
};
export const describeExpected = (k: string): string => KIND_LABEL[k] ?? k;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summarise(
  set: MappingSet,
  rules: readonly TypeRule[],
  fields: readonly FieldMap[],
): SetSummaryText {
  const types = new Map<string, { rules: string[]; fields: string[] }>();
  const slot = (t: string) => {
    const key = [...types.keys()].find((k) => k.toLowerCase() === t.toLowerCase()) ?? t;
    if (!types.has(key)) types.set(key, { rules: [], fields: [] });
    return types.get(key)!;
  };
  for (const r of rules) {
    slot(r.semanticType).rules.push(`${describeSelector(r.selector)} (priority ${r.priority})`);
  }
  for (const f of fields) {
    slot(f.semanticType).fields.push(
      `${f.fieldName}: ${describeLocation(f.location)}, expected ${describeExpected(f.expectedKind)}`,
    );
  }
  const warnings: string[] = [];
  for (const [type, v] of types) {
    if (v.rules.length === 0) warnings.push(`${type} has field maps but no type rule selects it.`);
    if (v.fields.length === 0) warnings.push(`${type} has type rules but no field maps yet.`);
  }
  const key = (r: TypeRule) =>
    r.selector.kind === 'subtree'
      ? `s:${r.selector.resourceId}:${r.selector.descendants}`
      : r.selector.kind === 'template'
        ? `t:${r.selector.templateId}`
        : `g:${r.selector.tag}`;
  const seen = new Map<string, TypeRule>();
  for (const r of rules) {
    const k = `${key(r)}|${r.priority}`;
    const other = seen.get(k);
    if (other && other.semanticType.toLowerCase() !== r.semanticType.toLowerCase()) {
      warnings.push(
        `${describeSelector(r.selector)} is claimed by both ${other.semanticType} and ${r.semanticType} at priority ${r.priority}.`,
      );
    }
    seen.set(k, r);
  }
  return {
    headline: `${set.active ? 'Active set' : 'Inactive set'} “${set.name}”: ${plural(rules.length, 'type rule', 'type rules')}, ${plural(fields.length, 'field map', 'field maps')}, ${plural(types.size, 'semantic type', 'semantic types')}.`,
    types: [...types.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en-GB'))
      .map(([semanticType, v]) => ({ semanticType, ...v })),
    warnings,
  };
}
