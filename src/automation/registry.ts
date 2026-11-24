/**
 * v3 F5b (ADR 0068; design docs/design/F5-orchestration.md, H5): the finding codes the automation framework knows, and
 * which of them may be switched on.
 *
 * Repository Automation's Default Boundary: automations are diagnostic and read-only by default, and "a separately
 * approved narrow automation action must identify exact scope, prerequisites, transformations, verification,
 * concurrency rules and stop conditions". So a code may carry `automatable: 'mechanical'` only when its fix is fully
 * determined by the bridge: no choice of text, value or classification is made, nothing is deleted, made, split,
 * renamed, moved into or out of Narratives, and no canon, lifecycle, image or `unsupported` block is touched.
 *
 * Every candidate the design named is in the catalogue with its transformation, for the owner to confirm (ADR 0068
 * lists them). The codes the design rules out are in it too, each with the trait that rules it out, so that a test can
 * assert the flag cannot be set on any of them: `defineCode` refuses it, and the catalogue is built through it.
 */

/** What a code's fix touches. The first group never stops a code being eligible; the second always does. */
export type Trait =
  // ---- mechanical traits
  | 'order' // a page re-placed among its siblings, under the same parent
  | 'tag_order' // the page's own tags reordered (nothing added or removed)
  | 'tags' // the page's tags set to a deterministic array (the retag engine's correction, a narrative grammar)
  | 'name_punctuation' // a dash in the page's display name replaced (the prefix and the words kept)
  | 'text_punctuation' // a dash in the headings or prose replaced (every other character kept)
  | 'empty_blocks' // decorative blank paragraphs removed (blocks with no visible text)
  | 'heading_link' // a link inside a heading dropped (the heading's text kept)
  | 'asset_name' // a file extension dropped from an asset's name
  | 'sidebar_link' // one non-current page removed from a Related Sources collection
  | 'fact' // one sidebar fact set to the value the page itself states (a number, a link back)
  | 'dateline' // a chapter's first line written from its own In-world Date
  // ---- never eligible
  | 'canon'
  | 'lifecycle'
  | 'hold'
  | 'exception'
  | 'judgement'
  | 'pick'
  | 'delete'
  | 'split'
  | 'rename'
  | 'narrative_move'
  | 'image'
  | 'unsupported'
  | 'create';

/** The traits that rule a code out, whatever else it does (the design's "Never automatic", and ADR 0068's additions). */
export const NEVER_TRAITS: readonly Trait[] = [
  'canon',
  'lifecycle',
  'hold',
  'exception',
  'judgement',
  'pick',
  'delete',
  'split',
  'rename',
  'narrative_move',
  'image',
  'unsupported',
  'create',
];

/** Where a code's findings come from, and whose fix it uses. */
export type AutomationSource = 'audit' | 'appraisal' | 'retag';

/** What the automation reads back to verify a write, and compares with what it read before. */
export type AutomationTarget = 'resource' | 'document' | 'asset';

export interface CodeEntry {
  /** The code (the audit's or the appraisal's own finding code; `retag_correction` for the retag engine's). */
  readonly code: string;
  readonly source: AutomationSource;
  /** The plain name, as the dashboard and the governance paragraph say it. */
  readonly name: string;
  /** A one-line example of what it does. */
  readonly example: string;
  /** The one transformation, in the words of the governance paragraph. */
  readonly transformation: string;
  readonly traits: readonly Trait[];
  /** Why it is ruled out (never eligible) or not flagged, in words. */
  readonly note?: string;
  /** What the read-back compares (absent for a code that cannot be flagged). */
  readonly target?: AutomationTarget;
  /**
   * The fields of `getResource` (or `getAsset`) the transformation may change; every other field must read back
   * identical. Document codes change none (their document is compared block by block with the plan).
   */
  readonly changes?: readonly string[];
  /** The non-current area the code is about (none of today's): only then is that area in its scope. */
  readonly area?: 'legacy' | 'design';
  /**
   * `mechanical`: Off, Propose or Apply. v3 F7 (ADR 0070): `propose`: Off or Propose only, never Apply: every fix is a
   * proposal the owner approves (the art layout's moves, renames and deletes, G7), so the never-eligible traits do not
   * stop it; Apply is refused (PROPOSE_ONLY).
   */
  readonly automatable?: 'mechanical' | 'propose';
  /** v3 F7: the mode a code has before the owner sets one (default Off). Only a `propose` code may default to Propose. */
  readonly defaultMode?: 'propose';
  /**
   * v3 F7.1 (ADR 0072): a `propose` code whose fix may also run as a job once the owner switches it to Apply (Off,
   * Propose or Apply; default Propose): submitted as the Automation principal without being forced into a proposal, so
   * every guard judges it as it judges any write (the canon guard keeps an Authoritative page's rename a canonical
   * proposal). Only the owner's switch allows it.
   */
  readonly applyDirect?: true;
}

export class AutomationFlagError extends Error {
  readonly code = 'NOT_MECHANICAL';
  constructor(message: string) {
    super(message);
    this.name = 'AutomationFlagError';
  }
}

/**
 * A catalogue entry, checked: `automatable: 'mechanical'` is refused on a code with a never-eligible trait, on a code
 * without a read-back target, and on one with no mechanical trait at all (a code must say what it changes).
 */
export function defineCode(e: CodeEntry): CodeEntry {
  if (e.defaultMode === 'propose' && e.automatable !== 'propose')
    throw new AutomationFlagError(`${e.code} cannot default to Propose: only a proposal-only code can.`);
  if (e.applyDirect === true && e.automatable !== 'propose')
    throw new AutomationFlagError(`${e.code}: only a proposal-only audit code can allow a direct Apply.`);
  if (e.automatable === 'propose' && e.source !== 'audit')
    throw new AutomationFlagError(
      `${e.code} cannot be proposal-only: only an audit code’s fix is a proposal of its own.`,
    );
  if (e.automatable === 'mechanical') {
    const bad = e.traits.filter((t) => NEVER_TRAITS.includes(t));
    if (bad.length > 0)
      throw new AutomationFlagError(
        `${e.code} cannot be flagged automatable: it ${bad.map((t) => TRAIT_WORDS[t]).join(', ')}.`,
      );
    if (e.traits.length === 0)
      throw new AutomationFlagError(`${e.code} cannot be flagged automatable: it names no transformation.`);
    if (!e.target)
      throw new AutomationFlagError(`${e.code} cannot be flagged automatable: no read-back target.`);
  }
  return Object.freeze({ ...e });
}

const TRAIT_WORDS: Readonly<Record<Trait, string>> = {
  order: 're-places a page among its siblings',
  tag_order: 'reorders tags',
  tags: 'sets tags',
  name_punctuation: 'replaces a dash in a name',
  text_punctuation: 'replaces a dash in text',
  empty_blocks: 'removes blank paragraphs',
  heading_link: 'drops a link from a heading',
  asset_name: 'renames an asset',
  sidebar_link: 'removes a sidebar link',
  fact: 'sets a fact',
  dateline: 'writes a dateline',
  canon: 'changes canon',
  lifecycle: 'changes a lifecycle state',
  hold: 'needs the owner’s classification (a hold)',
  exception: 'is an owner exception',
  judgement: 'needs a judgement',
  pick: 'needs the right value picked',
  delete: 'deletes something',
  split: 'splits',
  rename: 'renames a subject',
  narrative_move: 'moves a page into or out of Narratives',
  image: 'changes an image',
  unsupported: 'touches unsupported blocks',
  create: 'makes a page',
};

const SCOPE_PAGE = 'pages inside the project’s AI REPOSITORY';

/** The catalogue, in the engine's fixed order (eligible codes first, in the order they run). */
export const CATALOGUE: readonly CodeEntry[] = [
  // ======================================================================== eligible (for the owner to confirm)
  defineCode({
    code: 'out_of_order',
    source: 'audit',
    name: 'Sibling order',
    example: '“Zebra Gate” listed before “Apple Court” under the same index is moved after it.',
    transformation:
      'one moveResource placing the page among its siblings by the repository’s ordering rule (alphabetical; inside Narratives the narrative order), under the same parent; nothing else',
    traits: ['order'],
    target: 'resource',
    changes: ['rank'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'lifecycle_tag_not_leading',
    source: 'audit',
    name: 'Lifecycle tag first',
    example: 'A Working page tagged “Character, WORKING” becomes “WORKING, Character”.',
    transformation:
      'one updateResource with the page’s own tags in a new order, the lifecycle tag first; no tag added, removed or renamed (a page still carrying a status tag has no fix and is left to the owner)',
    traits: ['tag_order'],
    target: 'resource',
    changes: ['tags'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'retag_correction',
    source: 'retag',
    name: 'Tag corrections, in grammar order',
    example: '“CANON, Khayali, Genie, Character” becomes “CANON, Character, Genie, Khayali”.',
    transformation:
      'one updateResource setting the page’s tags to the retag engine’s deterministic correction under the approved policy, in grammar order (H3): no hold, no exception, and no status or lifecycle tag added or removed',
    traits: ['tags'],
    target: 'resource',
    changes: ['tags'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'em_dash_name',
    source: 'appraisal',
    name: 'Em dash in a page name',
    example: '“[BSRC] Harbour—Gate Reference” becomes “[BSRC] Harbour - Gate Reference”.',
    transformation:
      'one updateResource with the dash in the display name replaced as the pack’s name rule replaces it, the prefix kept, re-placed among its siblings if its place changes; a dash in a subject’s name (a rename of the subject) is never done and is skipped',
    traits: ['name_punctuation'],
    target: 'resource',
    changes: ['name', 'rank'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'em_dash_text',
    source: 'appraisal',
    name: 'Em dash in headings or prose',
    example: '“The gate—its keepers say—never closes” becomes “The gate - its keepers say - never closes”.',
    transformation:
      'replaceBlock of each heading or paragraph holding the dash, the dash replaced and every other character, run and mark kept; a block with an inline icon is left as it is',
    traits: ['text_punctuation'],
    target: 'document',
    changes: [],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'blank_paragraphs',
    source: 'appraisal',
    name: 'Decorative blank paragraphs',
    example: 'Two empty paragraphs between “Overview” and its text are removed.',
    transformation:
      'deleteBlock of each top-level paragraph with no visible text; nothing else (a page made only of blank paragraphs is left as it is)',
    traits: ['empty_blocks'],
    target: 'document',
    changes: [],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'heading_links',
    source: 'appraisal',
    name: 'Link inside a heading',
    example: 'The heading “Relations with [Tarim]” keeps its words and loses the link.',
    transformation:
      'replaceBlock of each heading holding a mention, the mention written as its plain label text; the heading’s words, level and every other block kept',
    traits: ['heading_link'],
    target: 'document',
    changes: [],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'asset_extension',
    source: 'appraisal',
    name: 'File extension in an asset name',
    example: 'The asset “Nadira portrait.png” is renamed “Nadira portrait”.',
    transformation:
      'one updateAsset with the file extension dropped from the asset’s name; refused when the folder already holds that name; the image itself, its folder and its placements untouched',
    traits: ['asset_name'],
    target: 'asset',
    changes: ['name'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'related_noncurrent',
    source: 'appraisal',
    name: 'Working or Archived page in Related Sources',
    example: 'An Authoritative page’s Related Sources loses its link to “[BARC] Old Charter”.',
    transformation:
      'the one link to a Working or Archived page removed from an Authoritative page’s Related Sources collection (set_facts’ own plan), the linked page read live first; nothing else in the sidebar',
    traits: ['sidebar_link'],
    target: 'resource',
    changes: ['properties'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'narrative_number_mismatch',
    source: 'audit',
    name: 'Chapter number field',
    example: '“Chapter 3 - The Weir” whose Chapter Number field says 2 gets 3.',
    transformation:
      'the Chapter Number field set to the number in the page’s own name (set_facts’ own plan), only when the audit names that one value; nothing else',
    traits: ['fact'],
    target: 'resource',
    changes: ['properties'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'narrative_link_broken',
    source: 'audit',
    name: 'Chapter and plan links',
    example: 'A chapter’s Chapter Plan field is pointed at the plan that already points at it.',
    transformation:
      'the one Chapter or Chapter Plan field set to the page it belongs with (set_facts’ own plan); nothing else',
    traits: ['fact'],
    target: 'resource',
    changes: ['properties'],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'narrative_dateline_mismatch',
    source: 'audit',
    name: 'Chapter dateline',
    example:
      'A chapter whose first line says “4 Mid-Thaw” while its In-world Date gives “5 Mid-Thaw” gets the right one.',
    transformation:
      'the chapter’s first block made the dateline its own In-world Date gives (or the dateline put before the text), every other block echoed exactly; never the prose',
    traits: ['dateline'],
    target: 'document',
    changes: [],
    automatable: 'mechanical',
  }),
  defineCode({
    code: 'narrative_tags',
    source: 'audit',
    name: 'Narrative tags',
    example: 'A chapter tagged nothing gets “Narrative, Chapter”.',
    transformation:
      'one updateResource adding the narrative grammar’s missing tags (Narrative, the page’s kind, AU in an AU story); every tag the page holds is kept',
    traits: ['tags'],
    target: 'resource',
    changes: ['tags'],
    automatable: 'mechanical',
  }),
  // ======================================================================== never eligible (a test asserts it)
  defineCode({
    code: 'retag_hold',
    source: 'retag',
    name: 'Retag hold',
    example: 'An uncertain category waits for the owner’s classification.',
    transformation: 'none: the owner classifies the page',
    traits: ['hold'],
  }),
  defineCode({
    code: 'tags_held',
    source: 'audit',
    name: 'Tags held',
    example: 'The audit’s copy of a retag hold.',
    transformation: 'none: the owner classifies the page',
    traits: ['hold'],
  }),
  defineCode({
    code: 'retag_exception',
    source: 'retag',
    name: 'Retag exception',
    example: 'A tag outside the grammar that no rule lists.',
    transformation: 'none: “Keep this tag here” or “Allow this tag everywhere” is the owner’s',
    traits: ['exception'],
  }),
  defineCode({
    code: 'tags_outside_definition',
    source: 'audit',
    name: 'Tags outside the allowed list',
    example: 'A tag the grammar does not place.',
    transformation: 'none: an owner exception',
    traits: ['exception'],
  }),
  defineCode({
    code: 'au_status_tag_mismatch',
    source: 'audit',
    name: 'AU and CANON status tags',
    example: 'CANON on an AU page.',
    transformation: 'none: the lifecycle tools’ work',
    traits: ['lifecycle', 'canon'],
  }),
  defineCode({
    code: 'lifecycle_inconsistent',
    source: 'audit',
    name: 'Lifecycle prefix, Status and place',
    example: 'A [BWRK] page outside the Working area.',
    transformation: 'none: promote_page, archive_page and move_to_working are canonical proposals',
    traits: ['lifecycle', 'canon'],
  }),
  defineCode({
    code: 'dependency_noncurrent',
    source: 'appraisal',
    name: 'Dependency on a Working or Archived page',
    example: 'A Dependency on “[BWRK] Draft Treaty”.',
    transformation: 'none: replacing it rather than dropping it may be right',
    traits: ['judgement'],
  }),
  defineCode({
    code: 'purpose_first',
    source: 'appraisal',
    name: 'Purpose first',
    example: 'The body does not begin with Purpose.',
    transformation: 'none: the text is the author’s',
    traits: ['judgement'],
  }),
  defineCode({
    code: 'consistency_birth',
    source: 'audit',
    name: 'Pick the right value',
    example: 'Two Authoritative pages give different birth years.',
    transformation: 'none: the owner picks the value',
    traits: ['pick', 'canon'],
  }),
  defineCode({
    code: 'chronology_event_without_row',
    source: 'audit',
    name: 'Timeline event without a row',
    example: 'An event no chronology row explains.',
    transformation: 'none: deleting an event is never automatic',
    traits: ['delete'],
  }),
  defineCode({
    code: 'duplicate_asset_folders',
    source: 'audit',
    name: 'Duplicate asset folders',
    example: 'Two “Characters” folders.',
    transformation: 'none: merging deletes folders',
    traits: ['delete', 'image'],
  }),
  // ======================================================================== v3 F7 (ADR 0070, G7): proposals only
  defineCode({
    code: 'art_outfit_folder_single',
    source: 'audit',
    name: 'One-piece outfit folder',
    example: 'Wardrobe / Silk Robe holds one piece: it is moved into Wardrobe and the folder deleted.',
    transformation:
      'ONE proposal: one updateAsset moving the piece into Wardrobe, then a deleteAsset of the emptied folder (only if empty when the job runs); every target read live first',
    traits: ['image', 'delete'],
    target: 'asset',
    changes: ['folderId'],
    automatable: 'propose',
    defaultMode: 'propose',
  }),
  defineCode({
    code: 'art_loose_outfit_pieces',
    source: 'audit',
    name: 'Loose pieces of one outfit',
    example: 'Two loose “Jade Moon Kimono” pieces: Wardrobe / Jade Moon Kimono is made and both moved in.',
    transformation:
      'ONE proposal: Wardrobe / <Outfit> found or made (createAssetFolder, found when it exists), then one updateAsset per piece moving it in; every piece read live first',
    traits: ['image', 'create'],
    target: 'asset',
    changes: ['folderId'],
    automatable: 'propose',
    defaultMode: 'propose',
  }),
  defineCode({
    code: 'art_legacy_folder_empty',
    source: 'audit',
    name: 'Empty Forms, Outfits or Details folder',
    example: 'An empty Forms / Primary Appearance under a character is deleted.',
    transformation:
      'ONE proposal: one deleteAsset per empty folder, deepest first, each only if empty when the job runs; read live first',
    traits: ['delete'],
    target: 'asset',
    changes: [],
    automatable: 'propose',
    defaultMode: 'propose',
  }),
  defineCode({
    code: 'art_legacy_folder_holds_assets',
    source: 'audit',
    name: 'Forms, Outfits or Details folder with assets',
    example: 'Outfits / Court Dress still holds two images.',
    transformation: 'none: where each image belongs is the owner’s call',
    traits: ['judgement', 'image'],
  }),
  defineCode({
    code: 'art_asset_name',
    source: 'audit',
    name: 'Character art name',
    example: '“Soraya bint al-Noor - Portrait.png” becomes “Soraya bint al-Noor - Portrait”.',
    transformation:
      'ONE proposal: one updateAsset renaming the asset to its G4 name (a file extension dropped, or an outfit folder’s piece given its outfit); refused when its folder holds that name; read live first',
    traits: ['asset_name'],
    target: 'asset',
    changes: ['name'],
    automatable: 'propose',
    defaultMode: 'propose',
  }),
  defineCode({
    code: 'art_stale_folder_ref',
    source: 'audit',
    name: 'Stale asset folder in page text',
    example:
      'A line naming “… / Soraya bint al-Noor / Outfits / Jade Moon Kimono” names “… / Wardrobe / Jade Moon Kimono”.',
    transformation:
      'ONE proposal: one replaceBlock with the stale path replaced by the folder’s place now, at the document version read live (a later edit stops the job)',
    traits: ['text_punctuation'],
    target: 'document',
    changes: [],
    automatable: 'propose',
    defaultMode: 'propose',
  }),
  // ======================================================================== v3 F7.1 (ADR 0072): default Propose, Apply allowed
  defineCode({
    code: 'character_core_missing',
    source: 'audit',
    name: 'Character Core missing',
    example:
      '[INDEX] Kamigawa Shirahime holds her Compact Character Reference and her Character Art: the Reference becomes “Kamigawa Shirahime - Character Core”.',
    transformation:
      'ONE proposal per character: arkona_create_character’s upgrade (target, upgradeToCore) of its Compact Character Reference, read live first: renamed “<Name> - Character Core”, Reference Type Character Core, the Core template recorded, its compact wording replaced, the images its Art page holds removed from it (those the Art page lacks moved there first); its id, identity facts, links and prose kept. Apply (only when the owner switches it) submits the same job, every guard judging it: an Authoritative page’s rename stays a canonical proposal',
    traits: ['fact', 'canon'],
    target: 'resource',
    changes: ['name', 'properties'],
    automatable: 'propose',
    defaultMode: 'propose',
    applyDirect: true,
  }),
  defineCode({
    code: 'core_compact_wording',
    source: 'audit',
    name: 'Character Core still called compact',
    example:
      '“This compact reference owns her identity.” on Emine al-Noor - Character Core becomes “This Character Core owns her identity.”',
    transformation:
      'ONE proposal per character: the Character Core upgrade’s own wording rules (“Compact Main CANON reference” → “Main CANON Character Core”; “compact (character) reference” → “Character Core”; on the Art page, “her character reference” → “her Character Core”) applied to the named blocks inside the lock, the Art page first, both pages read live first; any other sentence saying “compact” listed, never edited. Apply (only when the owner switches it) submits the same job, every guard judging it',
    traits: ['text_punctuation', 'canon'],
    target: 'document',
    changes: [],
    automatable: 'propose',
    defaultMode: 'propose',
    applyDirect: true,
  }),
  // ======================================================================== v3 F6a (ADR 0076): default Off, Apply allowed
  defineCode({
    code: 'reference_type_noncanonical',
    source: 'audit',
    name: 'Reference Type outside the vocabulary (an approved mapping)',
    example:
      '“Historical Cultural Reference” on a Culture page, which the owner mapped to “Culture Reference”, becomes “Culture Reference”.',
    transformation:
      'ONE proposal per page: set_facts of one sidebar field, Reference Type, to the value the owner mapped it to on the Reference Types page (only findings with an approved mapping have a fix), the row read live first and checked in the lock, its write If-Match chained, journalled and read back. The order is the owner’s: approve mappings, then switch to Propose, then Apply. Apply (only when the owner switches it) submits the same job, every guard judging it: an Authoritative page’s change is what the canon guard decides',
    traits: ['fact', 'canon'],
    target: 'resource',
    changes: ['properties'],
    automatable: 'propose',
    applyDirect: true,
  }),
  defineCode({
    code: 'scope_overload',
    source: 'appraisal',
    name: 'Scope overload (a split candidate)',
    example: 'A Core covering three specialist domains.',
    transformation: 'none: a split is the owner’s',
    traits: ['split', 'judgement'],
  }),
  defineCode({
    code: 'line_break_paragraph',
    source: 'audit',
    name: 'Line break inside a paragraph',
    example: 'A paragraph holding hard line breaks.',
    transformation: 'none: splitting a block is not among the approved transformations',
    traits: ['split'],
  }),
  defineCode({
    code: 'em_dash_subject_name',
    source: 'appraisal',
    name: 'Em dash in a subject’s name',
    example: '“Gata—Lund - Polity Reference”: the subject “Gata—Lund” would be renamed on this page only.',
    transformation: 'none: arkona_rename renames a subject everywhere, as the owner decides',
    traits: ['rename'],
  }),
  defineCode({
    code: 'narrative_lifecycle_page',
    source: 'audit',
    name: 'Lifecycle signal in Narratives',
    example: 'A [BSRC] page under Narratives.',
    transformation: 'none: moving a page into or out of Narratives is the owner’s',
    traits: ['narrative_move', 'lifecycle'],
  }),
  defineCode({
    code: 'asset_not_webp',
    source: 'appraisal',
    name: 'Image not WebP',
    example: 'A PNG portrait.',
    transformation: 'none: converting an image is never automatic',
    traits: ['image'],
  }),
  defineCode({
    code: 'asset_misplaced',
    source: 'appraisal',
    name: 'Image outside its character’s folder',
    example: 'Nadira’s portrait in Mehrana’s folder.',
    transformation: 'none: moving an image is never automatic',
    traits: ['image'],
  }),
  defineCode({
    code: 'unsupported_blocks',
    source: 'audit',
    name: 'Unsupported blocks',
    example: 'A page holding content LegendKeeper’s block model cannot express.',
    transformation: 'none: unsupported blocks are never touched',
    traits: ['unsupported'],
  }),
  defineCode({
    code: 'narrative_main_index_missing',
    source: 'audit',
    name: 'Missing continuity index',
    example: 'Narratives has no Main CANON index.',
    transformation: 'none: making a page is not among the approved transformations',
    traits: ['create'],
  }),
];

/** The codes that may be switched on, in the engine's fixed order. */
export const ELIGIBLE: readonly CodeEntry[] = CATALOGUE.filter((e) => e.automatable === 'mechanical');

export const isEligible = (code: string): boolean => ELIGIBLE.some((e) => e.code === code);

/** v3 F7 (ADR 0070): the proposal-only codes (Off or Propose, never Apply), in the catalogue's order. */
export const PROPOSE_ONLY: readonly CodeEntry[] = CATALOGUE.filter((e) => e.automatable === 'propose');

/** v3 F7: every code the owner can switch (the eligible ones, then the proposal-only ones). */
export const SWITCHABLE: readonly CodeEntry[] = [...ELIGIBLE, ...PROPOSE_ONLY];

export const isSwitchable = (code: string): boolean => SWITCHABLE.some((e) => e.code === code);

export function entryOf(code: string): CodeEntry | null {
  return CATALOGUE.find((e) => e.code === code) ?? null;
}

/** The scope sentence of a code (the governance paragraph's "Scope"). */
export function scopeOf(e: CodeEntry): string {
  const area =
    e.area === 'legacy'
      ? 'the Legacy Canon Archive included'
      : e.area === 'design'
        ? 'the Design References included'
        : 'excluding the Legacy Canon Archive and the Design References';
  return e.target === 'asset'
    ? 'the assets of the project’s asset library (their names only: never the image, its folder or its placements)'
    : `${SCOPE_PAGE}, ${area}`;
}
