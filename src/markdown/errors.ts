/**
 * Typed errors of the Markdown converter. Every refusal is one of these, never a silent loss: callers branch on
 * `code` and show `message` (written for an agent to act on) and `details`.
 */
export type MarkdownErrorCode =
  /** A keep region of the current page is missing from a replace, and the call did not name it in `dropRegions`. */
  | 'KEEP_REGIONS_MISSING'
  /** A keep region names a block id the current page does not hold. */
  | 'KEEP_REGION_UNKNOWN'
  /** The same keep region (or block id) appears twice, or a region is repeated in an append. */
  | 'KEEP_REGION_DUPLICATE'
  /** A keep region's markers are broken: no closing marker, a stray closing marker, nested markers, bad attributes. */
  | 'KEEP_REGION_MALFORMED'
  /** The write would delete `unsupported` blocks (the job engine's guard), and `allowUnsupportedLoss` was not given. */
  | 'UNSUPPORTED_BLOCK_LOSS'
  /** `[[Name]]` matched nothing. */
  | 'MENTION_NOT_FOUND'
  /** `[[Name]]` matched several pages. */
  | 'MENTION_AMBIGUOUS'
  /** `[[Name]]` was used but no resolver was supplied. */
  | 'MENTION_RESOLVER_MISSING'
  /** A fenced `lk-block` is not JSON, or not a block the spec's schema accepts. */
  | 'INVALID_LK_BLOCK'
  /** Creating an `unsupported` block, or echoing an unsupported id the page does not hold. */
  | 'UNSUPPORTED_KIND'
  /** Two blocks of the result carry the same id. */
  | 'DUPLICATE_BLOCK_ID'
  /** The tree is valid JSON for the API but the editor cannot hold it (LegendKeeper's INVALID_CONTENT). */
  | 'EDITOR_LIMIT'
  /** A field is past a length, item or nesting limit of the spec. */
  | 'FIELD_LIMIT'
  /** A block does not match the spec's schema (an unknown field, a wrong type). */
  | 'SCHEMA_VIOLATION'
  /** An image URL that is not an image asset of this project (or a `data:`/`blob:` URI). */
  | 'IMAGE_URL_REFUSED'
  /** An image inside a line of text: images are blocks and must stand on their own line. */
  | 'INLINE_IMAGE'
  /** HTML the converter does not understand. */
  | 'UNSUPPORTED_HTML'
  /** Markdown with no LegendKeeper equivalent. */
  | 'UNSUPPORTED_MARKDOWN'
  /** No heading matches the section path. */
  | 'SECTION_NOT_FOUND'
  /** Several headings match the section path. */
  | 'SECTION_AMBIGUOUS'
  /** The edit itself is malformed (unknown mode, section missing or not allowed). */
  | 'INVALID_EDIT'
  /** The converter could not render a page so that it converts back exactly (a bug; the round-trip script reports it). */
  | 'RENDER_SELF_CHECK_FAILED';

export class MarkdownError extends Error {
  override readonly name = 'MarkdownError';
  constructor(
    readonly code: MarkdownErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }

  toJSON(): { code: MarkdownErrorCode; message: string; details: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
