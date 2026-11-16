/**
 * v3 F3b (ADR 0052): the pinned sections of a governance document. A pack's rules depend on named sections of its
 * governance pages (Source Formatting's "Approved Hierarchy", the Tagging Standard's "Exact Tag Grammar"); the owner's
 * approval records each one's digest, and a drift report says which pinned section changed. A section is its heading
 * and every top-level block after it up to the next heading of its level or higher.
 *
 * Headings are matched loosely (case, spacing, punctuation, a leading number such as "3." or "B)", "&" for "and"), so
 * a renumbered or recapitalised heading is still found; a pinned section that cannot be found is reported by name.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../jobs/sidebar-state.js';

type Obj = Record<string, unknown>;

/** The plain text of a block's runs. */
function runsText(b: Obj): string {
  const content = b.content;
  if (!Array.isArray(content)) return '';
  return (content as Obj[])
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.mention && typeof (r.mention as Obj).text === 'string'
          ? ((r.mention as Obj).text as string)
          : '',
    )
    .join('');
}

/** A heading's comparable form (see the module comment). */
export function headingKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('en-GB')
    .replace(/&/g, ' and ')
    .replace(/^\s*(?:\d+(?:\.\d+)*|[a-z]|[ivxlc]+)\s*[.)]\s+/u, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FoundSection {
  /** The heading as pinned. */
  readonly heading: string;
  /** The heading as the document has it, or null when it is not there. */
  readonly found: string | null;
  /** SHA-256 of the section's blocks (stable JSON), or null when it is not there. */
  readonly digest: string | null;
}

/** A heading block's level (1 when it has none). */
const levelOf = (b: Obj): number => (typeof b.level === 'number' ? b.level : 1);

/** Each pinned heading's section in a document's top-level blocks (the first match when a heading repeats). */
export function pinnedSections(blocks: unknown, headings: readonly string[]): FoundSection[] {
  const list = (Array.isArray(blocks) ? blocks : []).filter(
    (b): b is Obj => typeof b === 'object' && b !== null,
  );
  return headings.map((heading) => {
    const want = headingKey(heading);
    const at = list.findIndex((b) => b.kind === 'heading' && headingKey(runsText(b)) === want);
    if (at < 0) return { heading, found: null, digest: null };
    const level = levelOf(list[at]!);
    let end = at + 1;
    while (end < list.length) {
      const b = list[end]!;
      if (b.kind === 'heading' && levelOf(b) <= level) break;
      end++;
    }
    const digest = createHash('sha256')
      .update(stableJson(list.slice(at, end)))
      .digest('hex');
    return { heading, found: runsText(list[at]!).trim(), digest };
  });
}

/** The document's headings (for a refusal that names what it holds), at most `max`. */
export function headingsOf(blocks: unknown, max = 40): string[] {
  const out: string[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (typeof b !== 'object' || b === null || (b as Obj).kind !== 'heading') continue;
    const t = runsText(b as Obj).trim();
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
