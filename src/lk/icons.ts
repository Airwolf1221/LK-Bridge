/**
 * Icon names, read form and write form (v2 E1a, ADR 0042 decision 9).
 *
 * LegendKeeper READS an icon as a FontAwesome class string (`"fas fa-book"`, `"far fa-circle-user"`) but its write schema
 * (`createResource`, `updateResource`, and a pin's or event's `iconGlyph`) takes the bare name (`"book"`) and answers
 * 400 VALIDATION_ERROR ("Invalid icon name. Must be a valid FontAwesome icon.") to anything else. Anywhere the bridge
 * writes back what it read, the value goes through `toWriteIcon` first.
 */

/** Style tokens a class string may carry: the short (`fas`) and long (`fa-solid`) forms, and the bare `fa`. */
const STYLES = new Set([
  'fa',
  'fas',
  'far',
  'fab',
  'fal',
  'fat',
  'fad',
  'fass',
  'fasr',
  'fasl',
  'fast',
  'fa-solid',
  'fa-regular',
  'fa-brands',
  'fa-light',
  'fa-thin',
  'fa-duotone',
  'fa-sharp',
  'fa-sharp-solid',
]);

/**
 * The write form of an icon name: the style prefix and the `fa-` prefix removed (`"fas fa-book"` → `"book"`,
 * `"fa-solid fa-book"`, `"far fa-book"` and `"fab fa-github"` likewise). A value that is already a bare name is returned
 * unchanged, and so is anything that is not a string or that leaves nothing once the prefixes are gone (LegendKeeper then
 * judges it as it stands).
 */
export function toWriteIcon<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const rest = tokens.filter((t) => !STYLES.has(t.toLowerCase()));
  if (rest.length === 0) return value;
  // The name is the first token carrying the `fa-` prefix (later ones are sizes and effects: `fa-fw`, `fa-2x`), or, with
  // none, the first token.
  const named = rest.find((t) => /^fa-./i.test(t)) ?? rest[0]!;
  const bare = named.replace(/^fa-/i, '');
  return bare === '' ? value : bare;
}

/** Whether a value is already in the write form. */
export function isWriteIcon(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && toWriteIcon(value) === value;
}

/** A shallow copy of a write body with its `iconGlyph` in the write form (the body is returned as it is without one). */
export function withWriteIcon<T extends Record<string, unknown>>(body: T): T {
  if (typeof body.iconGlyph !== 'string') return body;
  const g = toWriteIcon(body.iconGlyph);
  return g === body.iconGlyph ? body : { ...body, iconGlyph: g };
}

/** The body fields a refused icon is dropped from (LegendKeeper's default icon then applies). */
export const ICON_FIELDS = ['iconGlyph'] as const;
