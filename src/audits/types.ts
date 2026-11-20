/**
 * Shared types of the audits (v2 E2, PLAN-v2 4.12, ADR 0044): findings only, read from the snapshots.
 *
 * An audit reads the newest complete full snapshot plus any later change snapshots (the snapshot store, E1a), and the
 * bridge's own stored knowledge (the type registry, the lifecycle settings and records, the chronology check's last run).
 * It never reads LegendKeeper and never changes anything. A finding may offer "Propose a fix", which is a separate,
 * owner-initiated action (src/audits/fixes.ts) that re-reads its target live and creates an ordinary proposal.
 */

export type Severity = 'error' | 'warning' | 'info';
export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

/** The finding categories (the summary's rows). */
export type Category =
  | 'rules' // which rule owns a page: no rule, several rules, a rule's own ambiguity
  | 'template' // a page's sidebar and tabs against its template's
  | 'tags' // the tag rules
  | 'references' // mentions and collection items that point nowhere, and canon pointing at archived pages
  | 'unclassified' // pages with no recognised prefix
  | 'ordering' // siblings out of alphabetical order
  | 'taxonomy' // the taxonomy against the tree
  | 'facts' // Subject, Canonical Display Name, Reference Type
  | 'lifecycle' // prefix, Status, tag and place; lifecycle and set records
  | 'keep_regions' // line breaks, inline icons, unsupported blocks, collections
  | 'chronology' // D1's chronology check, folded in
  | 'assets' // v3 F2: the asset library (duplicate folders)
  | 'governance' // v3 F4a: the governance documents against the bridge (old tool names, external skills, missing names)
  | 'audit'; // about the run itself (a stale snapshot, a missing template read)

export const CATEGORIES: readonly Category[] = [
  'rules',
  'template',
  'tags',
  'references',
  'unclassified',
  'ordering',
  'taxonomy',
  'facts',
  'lifecycle',
  'keep_regions',
  'chronology',
  'assets',
  'governance',
  'audit',
];

/** What "Propose a fix" does for a finding (the tool the proposal goes through). */
export type FixKind =
  /** `move_resource`: re-places the page under the same parent, alphabetically. */
  | 'move_resource'
  /** `set_facts`: one fact, only when the right value is unambiguous. */
  | 'set_facts'
  /** `update_resource`: the missing required tags added (additive). */
  | 'add_tags'
  /** `replaceBlock` for the first part and `insertBlock` for the rest, block by block. */
  | 'split_paragraph'
  /** D1.1's `sync_timeline_event`, through the chronology module's own "Propose a fix". */
  | 'chronology_sync'
  /** v2 E5 hotfix: the age's Main count set to its table's row count, through the chronology module likewise. */
  | 'chronology_count'
  /** v2 E6 (ADR 0048): an event without a table row deleted (only the event), through the chronology module likewise. */
  | 'chronology_orphan'
  /**
   * v3 F2.1: an event in a tie paired with the row the owner picks ("Pair with this row", one per candidate):
   * `sync_timeline_event` with that row and the event, through the chronology module likewise. Never a delete.
   */
  | 'chronology_pair'
  /** v3 F2 (ADR 0049 decision 9): duplicate asset folders merged into the earliest, the emptied ones deleted. */
  | 'merge_asset_folders'
  /**
   * v3 F3d (ADR 0053): `update_resource` with the page's own tags in a new order, the lifecycle tag first; nothing added,
   * removed or renamed (a status tag a Working or Archived page still carries is left for the owner).
   */
  | 'reorder_tags';

export interface FixSpec {
  readonly kind: FixKind;
  /** What the fix needs, as the audit saw it (re-read and compared live before anything is proposed). */
  readonly args: Readonly<Record<string, unknown>>;
  /** One line for the button's tooltip and the proposal's title. */
  readonly summary: string;
  /**
   * v2 E6 (ADR 0048): the fix is not one click: the owner confirms what it changes first (a date mismatch whose repair
   * turns a range into a single date, or the reverse: `shapeChange` says so in plain words).
   */
  readonly confirm?: { readonly shapeChange: string };
}

export interface CodeInfo {
  readonly category: Category;
  readonly severity: Severity;
  readonly title: string;
  /** What "Propose a fix" does for this code (some findings carry one only when it is exact). */
  readonly fix?: FixKind;
}

/**
 * Every finding code. The old bridge's codes keep their meanings; the others are new in v2. A finding's severity is the
 * code's here unless the check says otherwise (it never does today).
 */
export const CODES = {
  // ---- rules (old bridge)
  no_matching_rule: { category: 'rules', severity: 'info', title: 'No rule matches this page' },
  ambiguous_owner_rule: { category: 'rules', severity: 'error', title: 'Several rules match this page' },
  incomplete_owner_ancestry: {
    category: 'rules',
    severity: 'warning',
    title: 'A rule names an ancestor, but the page’s parent chain is incomplete',
  },
  // ---- rules (new)
  ambiguous_ancestor: {
    category: 'rules',
    severity: 'warning',
    title: 'A rule’s ancestor name matches several ancestors of this page',
  },
  ambiguous_template: {
    category: 'rules',
    severity: 'error',
    title: 'A rule’s template matches several templates',
  },
  template_not_found: {
    category: 'rules',
    severity: 'error',
    title: 'A rule’s template was not found',
  },
  rule_selector_unknown: {
    category: 'rules',
    severity: 'warning',
    title: 'A rule names a registry type or role the registry does not know',
  },
  // ---- template (old bridge)
  property_kind_mismatch: {
    category: 'template',
    severity: 'warning',
    title: 'A sidebar property has another kind than the template’s',
  },
  property_order_mismatch: {
    category: 'template',
    severity: 'warning',
    title: 'Sidebar properties are in another order than the template’s',
  },
  property_presentation_mismatch: {
    category: 'template',
    severity: 'info',
    title: 'A sidebar property’s visibility, title flag or display differs from the template’s',
  },
  property_row_order_mismatch: {
    category: 'template',
    severity: 'warning',
    title: 'Key-value rows are in another order than the template’s',
  },
  document_type_mismatch: {
    category: 'template',
    severity: 'warning',
    title: 'A document tab has another type than the template’s',
  },
  document_order_mismatch: {
    category: 'template',
    severity: 'info',
    title: 'Document tabs are in another order than the template’s',
  },
  // ---- template (new: the old bridge had no code for a missing one)
  property_missing: {
    category: 'template',
    severity: 'warning',
    title: 'The page lacks a sidebar property the template has',
  },
  property_row_missing: {
    category: 'template',
    severity: 'info',
    title: 'The page lacks a key-value row the template has',
  },
  document_missing: {
    category: 'template',
    severity: 'warning',
    title: 'The page lacks a document tab the template has',
  },
  templates_unavailable: {
    category: 'audit',
    severity: 'warning',
    title: 'The snapshot holds no templates, so the template checks were skipped',
  },
  // ---- tags (old bridge)
  missing_required_tags: {
    category: 'tags',
    severity: 'warning',
    title: 'Required tags are missing',
    fix: 'add_tags',
  },
  tags_outside_definition: { category: 'tags', severity: 'warning', title: 'Tags outside the allowed list' },
  duplicate_tags: { category: 'tags', severity: 'info', title: 'The same tag twice' },
  // v3 F3f (ADR 0060): on a project whose approved pack has retag rules, from the retag engine.
  tags_out_of_order: {
    category: 'tags',
    severity: 'warning',
    title: 'Tags out of the grammar’s order (the status tag first)',
  },
  tags_held: {
    category: 'tags',
    severity: 'info',
    title: 'Tags held for the owner (an uncertain category, specialist, identity or status slot)',
  },
  // ---- tags (new)
  tag_definition_invalid: {
    category: 'tags',
    severity: 'error',
    title: 'The tag-definition document cannot be used, so the tag rules were skipped',
  },
  tag_rule_unknown: {
    category: 'tags',
    severity: 'warning',
    title: 'A tag rule names a rule id that no audit rule has',
  },
  // ---- references (old bridge)
  missing_target: {
    category: 'references',
    severity: 'error',
    title: 'A link points at nothing the bridge knows',
  },
  inaccessible_target: {
    category: 'references',
    severity: 'warning',
    title: 'A link points at a page outside what the audits can see',
  },
  deleted_target: { category: 'references', severity: 'error', title: 'A link points at a deleted page' },
  // ---- references (new)
  canon_refers_to_archived: {
    category: 'references',
    severity: 'warning',
    title: 'An Authoritative page links to an Archived page',
  },
  // ---- unclassified, ordering
  unclassified_page: {
    category: 'unclassified',
    severity: 'warning',
    title: 'A page with no recognised prefix',
  },
  out_of_order: {
    category: 'ordering',
    severity: 'warning',
    title: 'A page is out of alphabetical order among its siblings',
    fix: 'move_resource',
  },
  // ---- taxonomy
  race_not_in_taxonomy: {
    category: 'taxonomy',
    severity: 'warning',
    title: 'A character page’s race is not in the taxonomy',
  },
  race_index_mismatch: {
    category: 'taxonomy',
    severity: 'info',
    title: 'A character page sits under another race’s index than its race row names',
  },
  taxonomy_entry_without_pages: {
    category: 'taxonomy',
    severity: 'info',
    title: 'A taxonomy entry whose index holds no pages',
  },
  taxonomy_index_renamed: {
    category: 'taxonomy',
    severity: 'warning',
    title: 'An index’s name disagrees with its taxonomy entry',
  },
  taxonomy_source_missing: {
    category: 'taxonomy',
    severity: 'error',
    title: 'A taxonomy entry’s index is no longer in the repository',
  },
  taxonomy_source_moved: {
    category: 'taxonomy',
    severity: 'warning',
    title: 'A taxonomy entry’s index has moved',
  },
  taxonomy_parent_mismatch: {
    category: 'taxonomy',
    severity: 'warning',
    title: 'A taxonomy entry’s parent disagrees with the tree',
  },
  taxonomy_index_without_entry: {
    category: 'taxonomy',
    severity: 'warning',
    title: 'An index under a type root has no taxonomy entry',
  },
  taxonomy_type_root_missing: {
    category: 'taxonomy',
    severity: 'error',
    title: 'A type’s root index is no longer in the repository',
  },
  taxonomy_entry_unreviewed: {
    category: 'taxonomy',
    severity: 'info',
    title: 'A taxonomy entry still waiting for the owner’s review',
  },
  // ---- facts
  subject_mismatch: {
    category: 'facts',
    severity: 'warning',
    title: 'The Subject does not match the page',
    fix: 'set_facts',
  },
  canonical_name_mismatch: {
    category: 'facts',
    severity: 'warning',
    title: 'The Canonical Display Name does not match the page',
    fix: 'set_facts',
  },
  unknown_reference_type: {
    category: 'facts',
    severity: 'warning',
    title: 'The Reference Type is not one the registry knows',
    fix: 'set_facts',
  },
  // ---- lifecycle
  lifecycle_inconsistent: {
    category: 'lifecycle',
    severity: 'error',
    title: 'The prefix, Status, status tag and place of a page do not agree',
  },
  lifecycle_set_inconsistent: {
    category: 'lifecycle',
    severity: 'error',
    title: 'A page under a lifecycle set does not match the set’s state',
  },
  lifecycle_record_incomplete: {
    category: 'lifecycle',
    severity: 'error',
    title: 'A lifecycle change stopped part-way',
  },
  lifecycle_set_incomplete: {
    category: 'lifecycle',
    severity: 'error',
    title: 'A set’s lifecycle change stopped part-way',
  },
  // v3 F3d (ADR 0053): a project whose pack says the lifecycle tag leads (Arkona).
  lifecycle_tag_not_leading: {
    category: 'lifecycle',
    severity: 'warning',
    title: 'The lifecycle tag of a Working or Archived page is not first, or a status tag is still there',
    fix: 'reorder_tags',
  },
  // v3 F3d (ADR 0053): the owner's AU ruling (a project whose pack carries it).
  au_status_tag_mismatch: {
    category: 'lifecycle',
    severity: 'error',
    title: 'The status tag does not match the Continuity Type (AU on a non-AU page, or CANON on an AU page)',
  },
  lifecycle_not_configured: {
    category: 'audit',
    severity: 'info',
    title: 'The lifecycle indexes are not confirmed, so places could not be checked',
  },
  // ---- keep regions
  line_break_paragraph: {
    category: 'keep_regions',
    severity: 'warning',
    title: 'A paragraph holds a line break inside a text run',
    fix: 'split_paragraph',
  },
  inline_icon_page: {
    category: 'keep_regions',
    severity: 'info',
    title: 'A page holds inline icons (write_page cannot write it back)',
  },
  unsupported_blocks: {
    category: 'keep_regions',
    severity: 'info',
    title: 'A page holds blocks the API cannot express (kept as they are)',
  },
  collection_blocks: {
    category: 'keep_regions',
    severity: 'info',
    title: 'A page document holds collection blocks (keep regions)',
  },
  // ---- chronology (D1's kinds, as findings)
  chronology_row_without_event: {
    category: 'chronology',
    severity: 'warning',
    title: 'A table row has no timeline event',
    fix: 'chronology_sync',
  },
  chronology_event_without_row: {
    category: 'chronology',
    severity: 'warning',
    title: 'A timeline event has no table row',
    fix: 'chronology_orphan',
  },
  chronology_event_in_tie: {
    category: 'chronology',
    severity: 'warning',
    title: 'Event in a tie: rows of the table could be its own',
    fix: 'chronology_pair',
  },
  chronology_date_mismatch: {
    category: 'chronology',
    severity: 'warning',
    title: 'A row and its event disagree about the date',
    fix: 'chronology_sync',
  },
  duplicate_asset_folders: {
    category: 'assets',
    severity: 'warning',
    title: 'Sibling asset folders with exactly the same name',
    fix: 'merge_asset_folders',
  },
  chronology_name_drift: {
    category: 'chronology',
    severity: 'info',
    title: 'An event’s date tail no longer matches its row’s Date cell',
    fix: 'chronology_sync',
  },
  chronology_row_out_of_order: {
    category: 'chronology',
    severity: 'warning',
    title: 'A table row is out of calendar order',
  },
  chronology_wrong_kcy: { category: 'chronology', severity: 'warning', title: 'A KCY value is wrong' },
  chronology_count_mismatch: {
    category: 'chronology',
    severity: 'warning',
    title: 'The Main table’s count differs from the table',
    fix: 'chronology_count',
  },
  chronology_wrong_uri: {
    category: 'chronology',
    severity: 'warning',
    title: 'An event does not link to its age’s table',
  },
  chronology_unreadable_date: {
    category: 'chronology',
    severity: 'error',
    title: 'A table date the calendar engine cannot read',
  },
  chronology_date_text_differs: {
    category: 'chronology',
    severity: 'info',
    title: 'A date or KCY is written differently from the confirmed style',
  },
  chronology_not_found: {
    category: 'chronology',
    severity: 'error',
    title: 'A chronology document was not found',
  },
  chronology_not_checked: {
    category: 'audit',
    severity: 'info',
    title: 'The chronology has not been checked yet',
  },
  // ---- governance (v3 F4a, ADR 0063): report only, never a fix (governance edits are the owner's)
  governance_unknown_tool: {
    category: 'governance',
    severity: 'warning',
    title: 'A governance page names a tool the bridge does not have (or an old bridge call)',
  },
  governance_external_name: {
    category: 'governance',
    severity: 'info',
    title: 'A governance page names an external skill (allow it if it is real)',
  },
  governance_missing_reference: {
    category: 'governance',
    severity: 'info',
    title: 'A governance page names a page, tab or standard the AI REPOSITORY does not have',
  },
  // ---- the run itself
  stale_snapshot: {
    category: 'audit',
    severity: 'warning',
    title: 'The newest full snapshot is older than the audit allows',
  },
} as const satisfies Record<string, CodeInfo>;

export type FindingCode = keyof typeof CODES;

export const FINDING_CODES = Object.keys(CODES) as FindingCode[];

export const isFindingCode = (s: string): s is FindingCode => Object.hasOwn(CODES, s);

/** Where a finding's data came from. */
export type FindingSource =
  | {
      readonly kind: 'snapshot';
      /** The snapshot that supplied the page's newest piece (the full one, or a later change snapshot). */
      readonly snapshotId: string;
      readonly takenAt: number;
      /** The run's start minus `takenAt`. */
      readonly ageMs: number;
      /** The full snapshot the audit started from. */
      readonly baseSnapshotId: string;
    }
  | {
      readonly kind: 'chronology-check';
      readonly checkId: number;
      readonly takenAt: number;
      readonly ageMs: number;
    }
  | { readonly kind: 'bridge'; readonly takenAt: number; readonly ageMs: number }
  /** "Re-check now": the page was read live, at this moment, for this one finding. */
  | {
      readonly kind: 'live';
      readonly takenAt: number;
      readonly ageMs: number;
      readonly baseSnapshotId: string;
    };

/** What a check hands back; the runner adds the source and the fingerprint. */
export interface FindingDraft {
  readonly code: FindingCode;
  /** Identifies the finding within its code, page, document and block (a rule id, a target id, a fact key…). */
  readonly key?: string;
  readonly pageId?: string | null;
  readonly documentId?: string | null;
  readonly blockId?: string | null;
  readonly message: string;
  /** What was expected and what was found; an acknowledgement is tied to its content. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly fix?: FixSpec | null;
  /** The snapshot-sourced finding's source page (defaults to `pageId`), for the source snapshot. */
  readonly sourceKind?: FindingSource['kind'];
  readonly source?: Partial<FindingSource>;
}

/** A finding as stored and shown. */
export interface Finding {
  readonly id: number;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly code: FindingCode;
  readonly category: Category;
  readonly severity: Severity;
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly pagePath: string | null;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly evidenceHash: string;
  readonly source: FindingSource;
  readonly fix: FixSpec | null;
  readonly state: 'open' | 'gone';
  readonly firstSeenRun: string;
  readonly firstSeenAt: number;
  readonly lastSeenRun: string;
  readonly lastSeenAt: number;
  readonly resolvedRun: string | null;
  readonly resolvedAt: number | null;
  /** The owner's acknowledgement while the evidence is as it was; null when there is none or it lapsed. */
  readonly acknowledgement: { readonly reason: string; readonly by: string; readonly at: number } | null;
  /** The finding was acknowledged before and its evidence has changed since (so it is shown again). */
  readonly acknowledgementLapsed: boolean;
}

export interface Acknowledgement {
  readonly fingerprint: string;
  readonly evidenceHash: string;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

export interface RunCounts {
  /** Open findings by category and severity, after this run (acknowledged ones included). */
  readonly byCategory: Readonly<Record<string, Readonly<Record<Severity, number>>>>;
  readonly open: number;
  readonly acknowledged: number;
  /** First seen in this run / seen before and still present / present last run and gone now. */
  readonly new: number;
  readonly still: number;
  readonly gone: number;
}

export interface AuditRun {
  readonly id: string;
  readonly projectId: string;
  readonly trigger: string;
  readonly state: 'running' | 'succeeded' | 'failed' | 'skipped';
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly snapshotId: string | null;
  readonly snapshotTakenAt: number | null;
  readonly snapshotAgeMs: number | null;
  readonly changeSnapshots: number;
  readonly newestSnapshotId: string | null;
  readonly stale: boolean;
  readonly pages: number;
  readonly counts: RunCounts | null;
  readonly summary: string | null;
  readonly error: string | null;
}
