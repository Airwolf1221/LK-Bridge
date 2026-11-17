/**
 * The appraisal's check catalogue (v3 F3c, ADR 0054): every check with its group, its evidence class, the governance
 * rule it comes from (page and section, as the owner-approved design names them) and its follow-up when it has no
 * deterministic repair. Data, in one place, so the reports, the dashboard and the docs agree.
 *
 * The rules are the design's: built from Arkona's governance pages read live by the planner (Repository Automation,
 * Source Formatting's Sidebar Metadata, Body Structure, Completeness and Terminology, Links, Dependencies and Tags and
 * Indexes sections, the Tagging Standard, Character Architecture and Visual References). This session read none of them.
 */
import type { EvidenceClass, FixKind, GovernanceRule, Group } from './types.js';

export interface CheckInfo {
  readonly title: string;
  readonly group: Group;
  readonly evidence: EvidenceClass;
  readonly rule: GovernanceRule;
  /** The deterministic repair, when the check has one (design section F). */
  readonly fix?: FixKind;
  /** Otherwise: what an agent would use, and what has to be decided. */
  readonly judgement?: { readonly tool: string; readonly decide: string };
  /** Or nothing to do but read it. */
  readonly none?: string;
}

const SF = 'Source Formatting';
const BODY: GovernanceRule = { page: SF, section: 'Body Structure' };
const NAMES: GovernanceRule = { page: SF, section: 'Page Names and Templates' };
const SIDEBAR: GovernanceRule = { page: SF, section: 'Sidebar Metadata' };
const LINKS: GovernanceRule = { page: SF, section: 'Links, Dependencies and Tags' };
const RELATED: GovernanceRule = {
  page: SF,
  section: 'Links, Dependencies and Tags',
  rule: 'Related Sources',
};
const INDEXES: GovernanceRule = { page: SF, section: 'Indexes' };
const ORDER: GovernanceRule = { page: SF, section: 'Indexes', rule: 'Sibling Ordering' };
const TAGS: GovernanceRule = { page: 'Controlled Native Tagging Standard', section: 'Exact Tag Grammar' };
const ARCH: GovernanceRule = { page: 'Character Architecture', section: null, rule: 'scope and splitting' };
const AUTOMATION: GovernanceRule = { page: 'Repository Automation', section: null };
const VISUAL: GovernanceRule = { page: 'Visual References', section: null };

export const CHECKS = {
  // ------------------------------------------------------------------------------------------ A2: the owner appraisal
  purpose_first: {
    title: 'The body does not begin with Purpose',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: BODY,
    judgement: {
      tool: 'write_page',
      decide:
        'write a Purpose section first: needs the subject’s purpose from the owner or its sources (never invented)',
    },
  },
  title_repeated: {
    title: 'The page title or a metadata header is repeated at the top of the body',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: BODY,
    judgement: {
      tool: 'write_page',
      decide:
        'remove the repeated title or header: whether any of its facts belong in the sidebar first (set_facts) is the owner’s call',
    },
  },
  heading_links: {
    title: 'A link inside a heading',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: BODY,
    fix: 'heading_links',
  },
  literal_markdown: {
    title: 'Literal Markdown pasted as text',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: BODY,
    judgement: {
      tool: 'write_page',
      decide:
        'turn the pasted syntax into real formatting (a heading, bold, a list, a table): which the text meant is a reading of it',
    },
  },
  blank_paragraphs: {
    title: 'Decorative blank paragraphs',
    group: 'polish',
    evidence: 'Confirmed deterministic defect',
    rule: BODY,
    fix: 'blank_paragraphs',
  },
  em_dash_name: {
    title: 'An em dash in the page name',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: NAMES,
    fix: 'em_dash_name',
  },
  em_dash_text: {
    title: 'An em dash in a heading or the prose',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: NAMES,
    fix: 'em_dash_text',
  },
  template_field_missing: {
    title: 'A template field is missing from the sidebar',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: SIDEBAR,
    judgement: {
      tool: 'set_facts',
      decide:
        'add the row with its value: the value comes from the owner or the sources, never a placeholder',
    },
  },
  field_improvised: {
    title: 'A sidebar field the template does not have (improvised)',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: SIDEBAR,
    judgement: {
      tool: 'set_facts',
      decide:
        'move its value to the template field it belongs in, or to the body, before removing it: nothing is dropped unread',
    },
  },
  completion_gate: {
    title: 'The character completion gate is not met',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: SIDEBAR,
    judgement: {
      tool: 'set_facts',
      decide:
        'fill each field from the owner or the sources; "Unestablished" only with the owner’s reason in Unresolved Material',
    },
  },
  boundaries_missing: {
    title: 'No Source Boundaries or Unresolved Material section',
    group: 'polish',
    evidence: 'Potential Maintenance Issue',
    rule: { ...BODY, rule: 'where applicable' },
    judgement: {
      tool: 'write_page',
      decide: 'whether the section applies to this page, and what it says (a judgement: "where applicable")',
    },
  },
  dependency_noncurrent: {
    title: 'A Dependency on a Working or Archived page',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: LINKS,
    judgement: {
      tool: 'set_facts',
      decide:
        'the governing owner may need replacing rather than dropping: which current Authoritative page this depends on',
    },
  },
  related_noncurrent: {
    title: 'A Working or Archived page in an Authoritative page’s Related Sources',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: RELATED,
    fix: 'related_noncurrent',
  },
  related_empty: {
    title: 'Related Sources is empty: review it',
    group: 'polish',
    evidence: 'Potential Maintenance Issue',
    rule: { ...RELATED, rule: 'Related Sources (acceptable after an actual review)' },
    judgement: {
      tool: 'set_facts',
      decide: 'review whether any page relates; an empty collection is acceptable after an actual review',
    },
  },
  related_not_reciprocal: {
    title: 'A close specialist owner links here, but this page does not link back',
    group: 'polish',
    evidence: 'Potential Maintenance Issue',
    rule: RELATED,
    judgement: {
      tool: 'set_facts',
      decide: 'add the link back in Related Sources if the relation holds both ways',
    },
  },
  index_incomplete: {
    title: 'An index without its scope statement, “why open” text or Subpages collection',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: INDEXES,
    judgement: {
      tool: 'write_page',
      decide:
        'what the index routes to and why a reader opens it (set_facts for Index Scope; the Subpages collection is the template’s)',
    },
  },
  sibling_order: {
    title: 'Out of order among its siblings (INDEX pages first, then the rest, each alphabetical)',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: ORDER,
    fix: 'audit',
  },
  tag_grammar: {
    title: 'Tags outside the closed grammar',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: TAGS,
    judgement: {
      tool: 'update_resource',
      decide:
        'which tags the closed grammar allows here (a lifecycle tag only through the lifecycle tools, never by hand)',
    },
  },
  scope_overload: {
    title: 'Scope overload: the page covers several specialist domains',
    group: 'architectural',
    evidence: 'Potential Maintenance Issue',
    rule: ARCH,
    judgement: {
      tool: 'arkona_create_character',
      decide:
        'whether to split, and into which specialist owners: a pointer only (the split appraisal, A6, comes with F3e)',
    },
  },
  core_holds_specialist: {
    title: 'A Core holds a large biography, powers or other specialist block',
    group: 'architectural',
    evidence: 'Potential Maintenance Issue',
    rule: ARCH,
    judgement: {
      tool: 'arkona_create_character',
      decide:
        'whether the block becomes a specialist page (role "specialist"): a pointer only (A6, the split appraisal, comes with F3e)',
    },
  },
  audit_finding: {
    title: 'An open audit finding on this page',
    group: 'required',
    evidence: 'Confirmed deterministic defect',
    rule: { page: 'LK-Bridge audits', section: null, rule: 'ADR 0044' },
    judgement: { tool: 'audit_findings', decide: 'what the finding’s evidence calls for (see its message)' },
  },
  page_unreadable: {
    title: 'A piece of the page could not be read from the snapshot store',
    group: 'blocked',
    evidence: 'Inaccessible',
    rule: AUTOMATION,
    none: 'the next full snapshot takes the page again; nothing is guessed meanwhile',
  },
  not_in_snapshots: {
    title: 'The page is not in the snapshots yet',
    group: 'blocked',
    evidence: 'Incomplete',
    rule: AUTOMATION,
    none: 'live: true reads it now; otherwise the next full snapshot takes it',
  },
  template_unavailable: {
    title: 'The page’s template is not in the snapshot, so its fields could not be compared',
    group: 'blocked',
    evidence: 'Incomplete',
    rule: AUTOMATION,
    none: 'the next full snapshot takes the templates; nothing is guessed meanwhile',
  },
  // v3 F3.5 (ADR 0056): a legacy page (a block without an id, or an id used twice). Block-by-block writes, Revert and
  // the appraisal's own fixes cannot work on it until the block-id sweep (a maintenance job) has given it ids.
  block_ids_pending: {
    title: 'The page is waiting for block ids (a legacy page)',
    group: 'polish',
    evidence: 'Potential Maintenance Issue',
    rule: { ...AUTOMATION, rule: 'approved narrow automation: assign-block-ids-sweep' },
    none: 'waiting for the block-id sweep',
  },
  no_body: {
    title: 'The page has no page document to appraise',
    group: 'blocked',
    evidence: 'Incomplete',
    rule: AUTOMATION,
    none: 'nothing to check in the body',
  },
  // ------------------------------------------------------------------------------------------ A3: change impact
  link_to_noncurrent: {
    title:
      'A Dependency or Related Sources link points at a page that is (or will be) deleted, archived or Working',
    group: 'proven',
    evidence: 'Confirmed deterministic defect',
    rule: LINKS,
    judgement: { tool: 'set_facts', decide: 'whether the link is replaced by a current owner or removed' },
  },
  mention_target_gone: {
    title: 'A mention whose target is (or will be) gone',
    group: 'proven',
    evidence: 'Confirmed deterministic defect',
    rule: LINKS,
    judgement: { tool: 'write_page', decide: 'what the sentence should point at instead' },
  },
  mention_label_mismatch: {
    title: 'A mention whose displayed text will no longer match the renamed page',
    group: 'proven',
    evidence: 'Confirmed deterministic defect',
    rule: { ...AUTOMATION, rule: 'change impact' },
    judgement: {
      tool: 'write_page',
      decide: 'whether the sentence takes the new name or keeps the old one deliberately',
    },
  },
  chronology_row_mismatch: {
    title: 'A chronology row whose text will no longer match the renamed page',
    group: 'proven',
    evidence: 'Confirmed deterministic defect',
    rule: { ...AUTOMATION, rule: 'change impact' },
    judgement: { tool: 'sync_timeline_event', decide: 'whether the row (and its event) takes the new name' },
  },
  incoming_link: {
    title: 'A page depends on or relates to this one',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: LINKS,
    judgement: {
      tool: 'read_document',
      decide: 'whether the linking page still reads true after the change',
    },
  },
  incoming_mention: {
    title: 'A page mentions this one',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: LINKS,
    judgement: { tool: 'read_document', decide: 'whether the sentence still reads true after the change' },
  },
  chronology_row: {
    title: 'A chronology row names the subject',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...AUTOMATION, rule: 'change impact' },
    judgement: { tool: 'read_document', decide: 'whether the row still reads true after the change' },
  },
  restatement: {
    title: 'Another page restates the subject (found by its name or an alias)',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...AUTOMATION, rule: 'a resource change is not proof every document changed substantively' },
    judgement: { tool: 'read_document', decide: 'whether the restated facts still hold after the change' },
  },
  // ------------------------------------------------------------------------------------------ A4: the Working digest
  working_page: {
    title: 'A Working page',
    group: 'working',
    evidence: 'Review signal',
    rule: { ...AUTOMATION, rule: 'Age alone is a review signal' },
    judgement: {
      tool: 'promote_page',
      decide: 'whether it is ready to promote, still being worked on, or to archive',
    },
  },
  proposal_open: {
    title: 'A pending or conflicted proposal',
    group: 'proposals',
    evidence: 'Review signal',
    rule: AUTOMATION,
    judgement: {
      tool: 'bridge_proposal_status',
      decide: 'the owner approves or rejects it on the Proposals page',
    },
  },
  approved_not_promoted: {
    title: 'A Working set whose package was approved, but whose pages are still [BWRK]',
    group: 'unpromoted',
    evidence: 'Potential Maintenance Issue',
    rule: AUTOMATION,
    judgement: {
      tool: 'promote_page',
      decide: 'whether the set is ready to promote (always the owner’s approval)',
    },
  },
  declared_contradiction: {
    title: 'A Working page declares a contradiction in its Unresolved Material',
    group: 'contradictions',
    evidence: 'Explicitly Unresolved',
    rule: AUTOMATION,
    judgement: { tool: 'write_page', decide: 'which source stands: the owner resolves the contradiction' },
  },
  // ------------------------------------------------------------------------------------------ A5: visual hygiene
  asset_extension: {
    title: 'An asset name includes a file extension',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...VISUAL, rule: 'semantic, extension-free names' },
    fix: 'asset_extension',
  },
  asset_not_webp: {
    title: 'A non-WebP image asset',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...VISUAL, rule: 'WebP' },
    judgement: {
      tool: 'upload_image',
      decide:
        'whether to replace it with a WebP copy (upload_image converts) and relink the pages that show it',
    },
  },
  asset_misplaced: {
    title: 'An asset outside its subject’s character folder',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...VISUAL, rule: 'Characters / <race path> / <Name> / Forms | Outfits | Details' },
    judgement: {
      tool: 'lk_api_write',
      decide: 'which folder it belongs in (an asset may serve several subjects)',
    },
  },
  asset_orphan: {
    title: 'An orphan candidate: no page shows this asset',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: VISUAL,
    none: 'report only: an unused asset may be kept deliberately (the owner decides)',
  },
  image_broken: {
    title: 'An image block whose asset is gone',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: VISUAL,
    judgement: {
      tool: 'restore_snapshot',
      decide: 'restore the image (scope image) or remove the block: which, is the owner’s call',
    },
  },
  art_uninterpreted: {
    title: 'An Art page image without interpretation text',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...VISUAL, rule: 'Visual conclusions require inspectable imagery and the written owner' },
    judgement: { tool: 'write_page', decide: 'what the image establishes (from the owner or the sources)' },
  },
  primary_conflict: {
    title: 'Two images labelled as the Primary Reference for one subject',
    group: 'candidates',
    evidence: 'Potential Maintenance Issue',
    rule: { ...VISUAL, rule: 'one Primary Reference' },
    judgement: {
      tool: 'write_page',
      decide: 'which image is the Primary Reference; the other is relabelled',
    },
  },
  format_unknown: {
    title: 'An image whose format could not be read from the snapshots',
    group: 'blocked',
    evidence: 'Incomplete',
    rule: VISUAL,
    none: 'the next full snapshot stores its bytes; nothing is guessed meanwhile',
  },
} as const satisfies Record<string, CheckInfo>;

export type CheckId = keyof typeof CHECKS;

export const isCheckId = (s: string): s is CheckId => Object.hasOwn(CHECKS, s);

/** The one line a fix's follow-up says it changes. */
export const FIX_CHANGE: Readonly<Record<FixKind, string>> = {
  em_dash_name: 'replace the dash in the page name with an ASCII hyphen (update_resource)',
  em_dash_text:
    'replace each dash in the headings and prose with an ASCII hyphen, every other character kept',
  blank_paragraphs: 'remove the blank paragraphs',
  heading_links: 'keep each heading’s text and drop its link',
  asset_extension: 'rename the asset without its extension (checked for a name already taken in its folder)',
  related_noncurrent: 'remove that page from Related Sources',
  audit: 'the audit’s own “Propose a fix”',
};
