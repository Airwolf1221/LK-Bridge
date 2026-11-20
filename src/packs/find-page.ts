/**
 * v3 F4c (ADR 0065): a governance source given by its page's NAME (the Design References pages, whose ids the pack does
 * not hold): the one page of the project's repository tree with that display name, any dash and any spacing ("Arkona –
 * Fiction Writing Reference" and "Arkona - Fiction Writing Reference" are one name), and its main page document. Null
 * when there is none, or more than one (never a guess).
 */
import type { TreeNode, TreeQueries } from '../tree/index.js';

/** A name with every dash made one hyphen and the spacing around it made one space, without case. */
export function dashKey(name: string): string {
  return name
    .replace(/\s*[-‐‑‒–—―]\s*/gu, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');
}

/** The dash spellings of a name a page may use (hyphen, en dash, em dash). */
export function dashVariants(name: string): string[] {
  const out = new Set<string>([name.trim()]);
  for (const d of ['-', '–', '—']) out.add(name.trim().replace(/\s*[-‐‑‒–—―]\s*/gu, ` ${d} `));
  return [...out];
}

export function findPageByName(
  tree: Pick<TreeQueries, 'findByName'>,
  projectId: string,
  name: string,
): { readonly resourceId: string; readonly documentId: string } | null {
  const want = dashKey(name);
  const hits = new Map<string, TreeNode>();
  for (const v of dashVariants(name))
    for (const m of tree.findByName(projectId, v, { fields: ['display', 'raw'] }).data)
      if (dashKey(m.node.displayName) === want) hits.set(m.node.id, m.node);
  if (hits.size !== 1) return null;
  const node = [...hits.values()][0]!;
  const doc = node.documents.find((x) => x.type === 'page') ?? null;
  return doc ? { resourceId: node.id, documentId: doc.id } : null;
}
