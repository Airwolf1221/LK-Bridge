/**
 * Name helpers (v2 A3): the case-folded key every comparison uses, stray-prefix clean-up, singular forms, and template
 * name matching. Pure functions.
 */
import { nameKey } from '../tree/index.js';
import { SINGULAR_PLURALS } from './seed-data.js';

/** The key names are compared by: Unicode NFC, lower case, outer spaces removed, inner runs of spaces as one. */
export function key(name: string): string {
  return nameKey(name.trim().replace(/\s+/g, ' '));
}

const PREFIX = /^\s*\[(INDEX|BSRC)\]\s*/i;

/**
 * Removes stray leading `[INDEX]` / `[BSRC]` prefixes (any case; repeated ones collapse). Returns the clean name and
 * the kind of the LAST prefix given (the one next to the name), or null when there was none.
 */
export function cleanPrefixes(query: string): { name: string; prefix: 'index' | 'bsrc' | null } {
  let name = query.trim();
  let prefix: 'index' | 'bsrc' | null = null;
  for (let m = PREFIX.exec(name); m; m = PREFIX.exec(name)) {
    prefix = m[1]!.toUpperCase() === 'INDEX' ? 'index' : 'bsrc';
    name = name.slice(m[0].length);
  }
  return { name: name.trim(), prefix };
}

export interface SingularGuess {
  readonly singular: string;
  /** `list`: from the old bridge's list (no review needed); `rule`: a guess the owner should check. */
  readonly source: 'list' | 'rule';
  /** For a rule: which one, in words. */
  readonly rule: string | null;
}

const LIST = new Map(SINGULAR_PLURALS.map(([s, p]) => [key(p), s]));

/**
 * The singular of a plural index name. The list first (whole name); then simple rules, every one a guess:
 * the list applied to the last word (`Forest Dwarves` → `Forest Dwarf`), `-ies` → `-y`, `-ss` kept, `-s` dropped, and
 * a name that does not end in `s` kept as it is (`Beastkin`, `Saru`, `Qishen`). `-ves` → `-f` only through the list.
 */
export function singularFor(plural: string, list: ReadonlyMap<string, string> = LIST): SingularGuess {
  const name = plural.trim().replace(/\s+/g, ' ');
  const fromList = list.get(key(name));
  if (fromList !== undefined) return { singular: fromList, source: 'list', rule: null };
  const words = name.split(' ');
  if (words.length > 1) {
    const last = list.get(key(words.at(-1)!));
    if (last !== undefined) {
      return {
        singular: [...words.slice(0, -1), last].join(' '),
        source: 'rule',
        rule: `the last word from the list (${words.at(-1)} → ${last})`,
      };
    }
  }
  if (/ies$/i.test(name) && name.length > 3) {
    return { singular: `${name.slice(0, -3)}y`, source: 'rule', rule: '-ies → -y' };
  }
  if (/ss$/i.test(name)) return { singular: name, source: 'rule', rule: 'ends in -ss: kept as it is' };
  if (/s$/i.test(name) && name.length > 1) {
    return { singular: name.slice(0, -1), source: 'rule', rule: '-s removed' };
  }
  return { singular: name, source: 'rule', rule: 'does not end in s: kept as it is' };
}

/**
 * A template's name as LegendKeeper uses it for copies: `createResourceFromTemplate` drops the word "Template" from
 * the name, so `[BSRC] AI Character Core Template` and `[BSRC] AI Character Core` are the same template name.
 */
export function templateBaseKey(name: string): string {
  return key(name.replace(/\btemplate\b/gi, ' '));
}

/** A page's subject: its Subject row when present, else its display name before " - ". */
export function subjectOf(displayName: string, subjectRow: string | null): string {
  if (subjectRow !== null && subjectRow.trim() !== '') return subjectRow.trim();
  const i = displayName.indexOf(' - ');
  return (i >= 0 ? displayName.slice(0, i) : displayName).trim();
}

/** `{name}` in a page-name pattern replaced by the character's name. */
export function fillName(pattern: string, name: string): string {
  return pattern.split('{name}').join(name);
}
