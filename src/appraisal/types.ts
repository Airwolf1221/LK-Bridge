/**
 * The appraisal tools' shared shapes (v3 F3c, ADR 0054; the owner-approved design docs/design/F3c-appraisal.md).
 *
 * Repository Automation sets the boundary every tool keeps to: "Automations are diagnostic and read-only by default.
 * Report detected issues and the appropriate interactive follow-up; do not silently perform the repair." A finding
 * carries its follow-up (`followUp`); acting on it is a separate, explicit request that becomes an ordinary proposal.
 */

export type AppraisalTool =
  | 'arkona_appraise_owner'
  | 'arkona_change_impact'
  | 'arkona_working_digest'
  | 'arkona_visual_hygiene'
  | 'arkona_split_appraisal';

export const APPRAISAL_TOOLS: readonly AppraisalTool[] = [
  'arkona_appraise_owner',
  'arkona_change_impact',
  'arkona_working_digest',
  'arkona_visual_hygiene',
  'arkona_split_appraisal',
];

/**
 * The groups of a report. A2 uses Repository Automation's four (required defects, optional polish, architectural
 * candidates, blocked cases); A3 splits proven breakage from review candidates; A4 lists its four kinds of item; A5
 * reports candidates only.
 */
export type Group =
  | 'required'
  | 'polish'
  | 'architectural'
  | 'blocked'
  | 'proven'
  | 'candidates'
  | 'working'
  | 'proposals'
  | 'unpromoted'
  | 'contradictions';

export const GROUP_LABEL: Readonly<Record<Group, string>> = {
  required: 'Required defects',
  polish: 'Optional polish',
  architectural: 'Architectural candidates',
  blocked: 'Blocked cases',
  proven: 'Proven breakage',
  candidates: 'Review candidates',
  working: 'Working pages',
  proposals: 'Pending and conflicted proposals',
  unpromoted: 'Approved but not promoted',
  contradictions: 'Declared contradictions',
};

/** The groups each tool reports, in order. */
export const TOOL_GROUPS: Readonly<Record<AppraisalTool, readonly Group[]>> = {
  arkona_appraise_owner: ['required', 'polish', 'architectural', 'blocked'],
  arkona_change_impact: ['proven', 'candidates', 'blocked'],
  arkona_working_digest: ['working', 'proposals', 'unpromoted', 'contradictions', 'blocked'],
  arkona_visual_hygiene: ['candidates', 'blocked'],
  // v3 F3e (ADR 0059): the split appraisal (A6) reports architectural candidates only (and what it could not read).
  arkona_split_appraisal: ['architectural', 'blocked'],
};

/** Repository Automation's evidence terms. */
export type EvidenceClass =
  | 'Confirmed deterministic defect'
  | 'Potential Maintenance Issue'
  | 'Explicitly Unresolved'
  | 'Inaccessible'
  | 'Incomplete'
  | 'Review signal';

/** The governance rule a finding comes from: the page and its section (and the rule's own name, when it has one). */
export interface GovernanceRule {
  readonly page: string;
  readonly section: string | null;
  readonly rule?: string;
}

/**
 * What can be done about a finding:
 * - `fix`: a deterministic repair; `tool` and `args` are the exact call that would propose it (`arkona_appraisal_fix`
 *   with this finding's id), `change` the one-line change. Never applied by the appraisal: always a proposal.
 * - `judgement`: no single right repair; `tool` is what an agent would use and `decide` what has to be decided.
 * - `none`: report only.
 */
export type FollowUp =
  | {
      readonly kind: 'fix';
      readonly tool: 'arkona_appraisal_fix';
      readonly args: { readonly findingId: string };
      readonly change: string;
      /** The repair is an existing audit's "Propose a fix" (sibling order, tags), handed over rather than duplicated. */
      readonly via?: 'audit';
    }
  | { readonly kind: 'judgement'; readonly tool: string; readonly decide: string }
  | { readonly kind: 'none'; readonly reason: string };

/** The deterministic repairs `arkona_appraisal_fix` makes (design section F). */
export type FixKind =
  | 'em_dash_name'
  | 'em_dash_text'
  | 'blank_paragraphs'
  | 'heading_links'
  | 'asset_extension'
  | 'related_noncurrent'
  | 'audit';

export interface FindingSource {
  /** `snapshot`: the overlay of the snapshots; `live`: read now; `audit`: an audit's finding; others: the bridge's own. */
  readonly kind: 'snapshot' | 'live' | 'audit' | 'asset-tree' | 'bridge';
  readonly snapshotId?: string;
  readonly takenAt?: number;
  readonly ageMs?: number;
  /** An audit finding gathered (A2 reuses the audits rather than duplicating them). */
  readonly auditFindingId?: number;
  readonly auditCode?: string;
}

export interface FindingPage {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface AppraisalFinding {
  /** Stable across runs: the same finding has the same id (a fingerprint). */
  readonly id: string;
  readonly tool: AppraisalTool;
  readonly check: string;
  readonly group: Group;
  readonly evidence: EvidenceClass;
  readonly rule: GovernanceRule;
  readonly page: FindingPage | null;
  readonly documentId?: string | null;
  readonly blockId?: string | null;
  readonly message: string;
  /** What was found (and expected), for the report and for "Propose a fix" to compare live. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly followUp: FollowUp;
  /** For a `fix` follow-up: which repair, and what it needs as the appraisal saw it. */
  readonly fix?: { readonly kind: FixKind; readonly args: Readonly<Record<string, unknown>> };
  readonly source: FindingSource;
  /** Labels of the page (lifecycle and branch), when the tool shows them. */
  readonly labels?: { readonly lifecycle: string | null; readonly branch: string | null };
}

/** Where a report's data came from and how fresh it was; what it could not check. */
export interface ReportSource {
  readonly index: {
    readonly base: { readonly id: string; readonly takenAt: string };
    readonly newest: { readonly id: string; readonly takenAt: string };
    readonly changeSnapshots: number;
    /** The newest snapshot's age when the report was made. */
    readonly age: string;
    readonly ageMs: number;
  } | null;
  readonly audit?: {
    readonly runAt: string | null;
    readonly snapshotId: string | null;
    readonly note?: string;
  };
  readonly assetTree?: { readonly status: string; readonly confirmedAt: string | null };
  readonly live?: { readonly reads: number; readonly at: string };
  readonly pack?: { readonly version: number; readonly approvedVersion: number | null };
}

export interface AppraisalReport {
  readonly tool: AppraisalTool;
  readonly runId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly source: ReportSource;
  /** What was inspected (pages, assets, proposals…). */
  readonly inspected: Readonly<Record<string, unknown>>;
  /** What could not be checked, said plainly (never guessed). */
  readonly couldNotCheck: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly AppraisalFinding[];
  /**
   * v3 F3e (ADR 0059): the split appraisal's questions, the triggers the bridge cannot measure (Independent Retrieval,
   * Independent Maintenance, Downstream Dependency), for the owner.
   */
  readonly questions?: readonly { readonly trigger: string; readonly question: string }[];
  /** Against the last stored run of the same scope: findings new, still present, gone. */
  readonly compared?: {
    readonly new: number;
    readonly still: number;
    readonly gone: number;
    readonly previousRunAt: string;
  };
}

export class AppraisalError extends Error {
  override readonly name = 'AppraisalError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
