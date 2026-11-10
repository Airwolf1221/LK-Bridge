/**
 * Which template a page comes from, and that template's fact keys in order (v2 C2a). set_facts puts new template facts
 * in this order.
 *
 * The template: the one the repository tree recorded for the page (C2b records it when it creates a page), or else the
 * page's Reference Type mapped through A3's type registry to a type and role (a character type's `core` and `compact`
 * Reference Types), and from that to the role's template. Nothing is guessed from names.
 *
 * The keys: the template's key-value property with the same title, read with `listProperties` once and kept in
 * `template_fact_keys` for a day (a cache: losing it costs one read).
 */
import type { Db } from '../db/open.js';
import type { RegistryType } from '../registry/index.js';
import { sidebarFrom } from './sidebar.js';

export const TEMPLATE_KEYS_TTL_MS = 24 * 3_600_000;

export interface TemplateChoice {
  readonly templateId: string;
  readonly how: 'recorded' | 'reference_type';
  readonly detail: string;
}

/** The page's template (see the module comment), or null with nothing guessed. */
export function templateFor(
  node: { readonly templateId: string | null; readonly referenceType: string | null },
  types: readonly RegistryType[],
  referenceType?: string | null,
): TemplateChoice | null {
  if (node.templateId) {
    return {
      templateId: node.templateId,
      how: 'recorded',
      detail: 'recorded by the bridge when it created the page',
    };
  }
  const ref = (referenceType ?? node.referenceType)?.trim().toLocaleLowerCase('en-GB');
  if (!ref) return null;
  for (const t of types) {
    const p = t.placement;
    if (!p) continue;
    for (const role of ['core', 'compact'] as const) {
      if (p.referenceTypes[role].trim().toLocaleLowerCase('en-GB') !== ref) continue;
      const tpl = t.pageTemplates.find((x) => x.role === role)?.templateId;
      if (tpl) {
        return {
          templateId: tpl,
          how: 'reference_type',
          detail: `Reference Type “${p.referenceTypes[role]}” is the ${t.singular} type’s ${role} page`,
        };
      }
    }
  }
  return null;
}

/** The keys of a template's key-value property titled `title`, in order (null when it has none). */
export function templateKeysFrom(listProperties: unknown, title: string): string[] | null {
  const want = title.trim().toLocaleLowerCase('en-GB');
  const prop = sidebarFrom(listProperties).find(
    (p) => p.kind === 'keyValue' && p.title.trim().toLocaleLowerCase('en-GB') === want,
  );
  return prop ? (prop.rows ?? []).map((r) => r.key) : null;
}

export class TemplateKeys {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** The cached keys, if read within the last day. */
  cached(projectId: string, templateId: string, title: string): readonly string[] | null | undefined {
    const r = this.db
      .prepare(
        'SELECT property_title, keys, found, read_at FROM template_fact_keys WHERE project_id = ? AND template_id = ?',
      )
      .get(projectId, templateId) as
      { property_title: string; keys: string; found: number; read_at: number } | undefined;
    if (!r || this.now() - r.read_at > TEMPLATE_KEYS_TTL_MS) return undefined;
    if (r.property_title.trim().toLocaleLowerCase('en-GB') !== title.trim().toLocaleLowerCase('en-GB'))
      return undefined;
    if (r.found !== 1) return null;
    try {
      const keys = JSON.parse(r.keys) as unknown;
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : undefined;
    } catch {
      return undefined;
    }
  }

  /** Stores what a `listProperties` of the template returned: the keys of its key-value property titled `title`. */
  store(
    projectId: string,
    templateId: string,
    title: string,
    listProperties: unknown,
  ): readonly string[] | null {
    const keys = templateKeysFrom(listProperties, title);
    this.db
      .prepare(
        `INSERT INTO template_fact_keys (project_id, template_id, property_title, keys, found, read_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, template_id) DO UPDATE SET property_title = excluded.property_title,
           keys = excluded.keys, found = excluded.found, read_at = excluded.read_at`,
      )
      .run(projectId, templateId, title, JSON.stringify(keys ?? []), keys ? 1 : 0, this.now());
    return keys;
  }
}
