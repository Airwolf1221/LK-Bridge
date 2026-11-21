/**
 * R4.1 (ADR 0066 amendment 1, the owner's rule after the sandbox run of 21 November 2026, narrative-f4c N3): a template's
 * default values are not "existing" values. LegendKeeper copies a template's sidebar into every page made from it, so a
 * new chapter's Continuity holds the Chapter template's placeholder ("Main CANON, or the AU's name") until a tool fills
 * it. Replacing a field value that is IDENTICAL to the page's template default for that field is a first fill, not a
 * change of an existing value, for the canon guard (its `change` rules) and the lifecycle guard alike. A real existing
 * value (anything else) is still protected; a `value` rule (Status Authoritative) is judged as before.
 *
 * The lifecycle guard needs nothing of this module: it counts only lifecycle Status values (Working, Archived, and
 * Authoritative), and a placeholder is none, so replacing one is already a first fill there. A template default that
 * IS a lifecycle value (the generic Working sidebar's Status "Working") is no placeholder: the template copy was judged
 * as giving the page that state (CR-2026-11-R4 F2), so it stays protected (ADR 0066 amendment 1, part B asks the owner).
 *
 * Which template a page was made from (LegendKeeper does not say; a resource carries no template id):
 * 1. the request's own template copy (`createResourceFromTemplate` with the page's client-minted id), at entry;
 * 2. inside the lock, the writing job's own earlier copy step for the page (its stored steps, so a restarted job knows
 *    it too);
 * 3. a page under Narratives: the narrative template for its kind (Story Map, Act Map, Chapter Plan, Chapter), from the
 *    approved pack's narrative rules, found by name in the project's template list (a chapter made in the app).
 * Not the template the tree recorded for an older copy by the bridge: a default may be a real value (a Core template's
 * Continuity "Main"), which would leave every such page's Continuity unprotected (src/narrative/templates.ts).
 * Unknown: no defaults (every non-empty value is existing, as before). The defaults are the template's sidebar as
 * LegendKeeper holds it when the guard judges the write (read live; a template whose placeholders the owner has since
 * cleared has none, so a page still holding the old text keeps it protected: the safe side).
 */
import { factKey } from './rules.js';
import { factRows, valueSignature, type Sidebar } from './sidebar.js';

/**
 * A page's template id, when the bridge can tell (null: unknown). `jobId`: the job writing it (inside the lock), whose
 * own template copy of the page counts first. An error reads as unknown.
 */
export type TemplateOfPage = (projectId: string, resourceId: string, jobId?: string) => string | null;

/** A template's default values by fact key (folded): each a set of value signatures (text and mentions). */
export type TemplateDefaults = ReadonlyMap<string, ReadonlySet<string>>;

/** The default values a template's sidebar gives each fact (empty values are no default: empty is empty already). */
export function templateDefaultsOf(sidebar: Sidebar | null | undefined): TemplateDefaults {
  const out = new Map<string, Set<string>>();
  for (const r of factRows(sidebar ?? [])) {
    const sig = valueSignature(r.content);
    if (sig === valueSignature([])) continue;
    const k = factKey(r.key);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k)!.add(sig);
  }
  return out;
}

/** Whether a fact's value is the template's default for that fact (identical: its text and mentions). */
export function isTemplateDefault(
  defaults: TemplateDefaults | null | undefined,
  key: string,
  content: readonly Record<string, unknown>[],
): boolean {
  if (!defaults || defaults.size === 0) return false;
  return defaults.get(factKey(key))?.has(valueSignature(content)) === true;
}

/**
 * The template a client-minted page id was copied from by a job's own `createResourceFromTemplate` steps (`steps`: their
 * stored params), or null.
 */
export function templateFromCopySteps(steps: readonly unknown[], resourceId: string): string | null {
  for (const p of steps) {
    const body = (p as { body?: { id?: unknown; templateId?: unknown } } | null | undefined)?.body;
    if (body?.id === resourceId && typeof body.templateId === 'string') return body.templateId;
  }
  return null;
}
