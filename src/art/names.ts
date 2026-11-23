/**
 * v3 F7 (ADR 0070; the owner-approved design LK-Bridge-F7-guided-art-design.md, G3 and G4): outfit names and asset
 * names of character art.
 *
 * **Matching** (G3). An outfit is the same outfit when its name, or one of its aliases, is equal once case and spacing
 * are normalised (`outfitKey`: Unicode NFC, lower case, every run of white space one space, trimmed).
 *
 * **Near match** (G3; `nearMatch`). A name that is not the same outfit but close to one is refused
 * (OUTFIT_NEAR_MATCH, listing the candidates) unless the call says `newOutfit: true`. Two names are near when, compared
 * as words (lower case; apostrophes dropped; every other character that is not a letter or a digit separates words):
 *
 * 1. one name's words appear, in order and together, inside the other's ("Imperial Regalia" inside "Supreme Imperial
 *    Regalia"; "Kimono" inside "Jade Moon Kimono");
 * 2. they are the same once punctuation is dropped ("Lu'lu'at al-Qamar" and "Luluat al Qamar");
 * 3. their letters differ by a few edits (Damerau-Levenshtein distance, on the words joined by one space, at most
 *    max(1, ⌊shorter length / 6⌋)): a typo ("Moonflower Yukata" and "Moonflower Yukta");
 * 4. they share at least two words and at least half of all their distinct words (Jaccard ≥ 0.5): "Sapphire Rose Gown"
 *    and "Sapphire Rose Dress".
 *
 * One shared word alone is never near ("Maid Uniform" and "Al-Ghalian Uniform").
 *
 * **Asset names** (G4): a design piece is `<Character> - <Label>`; an outfit piece `<Character> - <Outfit> - <Label>`,
 * the character's full canonical name, numbered ` (2)` when taken, never a file extension. An existing loose Wardrobe
 * piece named `<Character> - <Outfit>` (no label) is a valid single-piece outfit.
 */

/** The key two outfit names (or aliases) are the same outfit by: case and spacing normalised. */
export function outfitKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The words of a name, for the near-match test. */
export function words(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function damerau(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const containsRun = (outer: readonly string[], inner: readonly string[]): boolean => {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++)
    if (inner.every((w, k) => outer[i + k] === w)) return true;
  return false;
};

/** Why two names that are not the same outfit are near (see the module comment), or null. */
export function nearReason(a: string, b: string): string | null {
  if (outfitKey(a) === outfitKey(b)) return null;
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return null;
  if (containsRun(wa, wb) || containsRun(wb, wa)) return 'one name is contained in the other';
  const ja = wa.join(' ');
  const jb = wb.join(' ');
  if (ja === jb) return 'the same once punctuation is dropped';
  const cap = Math.max(1, Math.floor(Math.min(ja.length, jb.length) / 6));
  if (damerau(ja, jb, cap) <= cap) return 'a few letters apart';
  const sa = new Set(wa);
  const sb = new Set(wb);
  const shared = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  if (shared >= 2 && shared / union >= 0.5) return 'most of their words are the same';
  return null;
}

export interface OutfitNames {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export type OutfitMatch<T extends OutfitNames> =
  | { readonly kind: 'same'; readonly outfit: T; readonly via: string }
  | {
      readonly kind: 'near';
      readonly candidates: readonly { readonly outfit: T; readonly via: string; readonly why: string }[];
    }
  | { readonly kind: 'new' };

/** The outfit a name means among a character's outfits: the same one (by name or alias), near ones, or a new one. */
export function matchOutfit<T extends OutfitNames>(name: string, outfits: readonly T[]): OutfitMatch<T> {
  const k = outfitKey(name);
  for (const o of outfits) {
    if (outfitKey(o.name) === k) return { kind: 'same', outfit: o, via: o.name };
    const alias = o.aliases.find((a) => outfitKey(a) === k);
    if (alias !== undefined) return { kind: 'same', outfit: o, via: alias };
  }
  const near: { outfit: T; via: string; why: string }[] = [];
  for (const o of outfits) {
    for (const n of [o.name, ...o.aliases]) {
      const why = nearReason(name, n);
      if (why) {
        near.push({ outfit: o, via: n, why });
        break;
      }
    }
  }
  return near.length > 0 ? { kind: 'near', candidates: near } : { kind: 'new' };
}

// ============================================================================================ asset names (G4)

export const SEP = ' - ';
const EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|svg)$/i;
const NUMBERED = /\s\((\d+)\)$/;

export const hasExtension = (name: string): boolean => EXTENSION.test(name.replace(NUMBERED, ''));

/** A design piece's name (G4). */
export const designName = (character: string, label: string): string => `${character}${SEP}${label}`;

/** An outfit piece's name (G4). */
export const outfitPieceName = (character: string, outfit: string, label: string): string =>
  `${character}${SEP}${outfit}${SEP}${label}`;

/** A name without its ` (n)` number and its file extension. */
export function baseName(name: string): string {
  return name.replace(NUMBERED, '').replace(EXTENSION, '').trim();
}

/** The part of a name after `<Character> - ` (case and spacing normalised for the comparison), or null. */
export function afterCharacter(name: string, character: string): string | null {
  const b = baseName(name);
  const head = `${character}${SEP}`;
  if (outfitKey(b.slice(0, head.length)) === outfitKey(head)) return b.slice(head.length).trim();
  if (outfitKey(b) === outfitKey(character)) return '';
  return null;
}

/** A Visual Role ("Primary Reference", "Outfit Reference"): a label's first part, never an outfit's name. */
export const isVisualRole = (s: string): boolean => /\breference\b/i.test(s);

/**
 * A loose Wardrobe piece's outfit (`<Character> - <Outfit>[ - <Label>]`), or why it cannot be read without guessing.
 */
export function looseOutfitOf(
  name: string,
  character: string,
): { readonly outfit: string; readonly label: string } | { readonly ambiguous: string } {
  const rest = afterCharacter(name, character);
  if (rest === null) return { ambiguous: `its name does not start with “${character} - ”` };
  if (rest === '') return { ambiguous: 'its name has no outfit after the character’s' };
  const parts = rest.split(SEP);
  const outfit = parts[0]!.trim();
  if (outfit === '') return { ambiguous: 'its outfit part is empty' };
  if (isVisualRole(outfit))
    return { ambiguous: `“${outfit}” reads as a Visual Role (a label), not an outfit’s name` };
  return { outfit, label: parts.slice(1).join(SEP).trim() };
}

/** Whether a name follows G4 for where the piece is (`outfit`: its folder's or the record's outfit; null: design). */
export function nameProblem(
  name: string,
  character: string,
  where: { readonly outfit: string | null; readonly loose?: boolean },
): string | null {
  if (hasExtension(name)) return 'it ends in a file extension';
  const rest = afterCharacter(name, character);
  if (rest === null) return `it does not start with the character’s full name (“${character} - ”)`;
  if (rest === '') return 'it has nothing after the character’s name';
  if (where.outfit === null) return null;
  const parts = rest.split(SEP);
  if (outfitKey(parts[0]!) !== outfitKey(where.outfit))
    return `it does not name its outfit (“${character} - ${where.outfit} - …”)`;
  return null;
}

/**
 * The G4 name a piece should have, when the bridge can say without guessing: a file extension dropped; an outfit
 * folder's piece named `<Character> - <Label>` given its outfit. Null otherwise (listed for the owner).
 */
export function fixedName(
  name: string,
  character: string,
  where: { readonly outfit: string | null },
): string | null {
  const numbered = NUMBERED.exec(name)?.[0] ?? '';
  let b = name.replace(NUMBERED, '').trim();
  if (EXTENSION.test(b)) b = b.replace(EXTENSION, '').trim();
  const rest = afterCharacter(b, character);
  if (rest === null || rest === '') return null;
  if (where.outfit !== null) {
    const parts = rest.split(SEP);
    if (outfitKey(parts[0]!) !== outfitKey(where.outfit)) {
      // `<Character> - <Label>` in an outfit folder: the outfit goes in between, when the label is a Visual Role's.
      if (!isVisualRole(parts[0]!)) return null;
      b = outfitPieceName(character, where.outfit, rest);
    }
  }
  const out = `${b}${numbered}`;
  return out === name ? null : out;
}
