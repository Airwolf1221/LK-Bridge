/**
 * Last Major Revision for the EXISTING pages a pack package changes (v3 F3b, ADR 0052 decision 14), by the owner's rule
 * of ADR 0051 (decision 1, src/lmr): a page the package changes is dated only for a major revision (8 or more words of
 * page text, a heading's wording, a real fact change, a Dependency added or removed), and the caller's
 * `lastMajorRevision` (`auto`, the default; `set`; `skip`) overrides it, exactly as for the general write tools. Pages a
 * package MAKES are always dated (the owner's character-pack design, answer 10), whatever the override.
 *
 * The pack job plans its own Last Major Revision steps (the engine's general planner leaves a request that already has
 * them alone), so the rule is applied here, from what the planner already read: the existing pages' sidebars (facts and
 * link collections, with their values before), the documents whose text it changes (an index's routing lines, an Art
 * page's new image sections). No extra read. What the rule never counts (a move, a new name, a housekeeping key such as
 * Reference Type, a link collection other than Dependencies) is a reason to leave the date, unless the owner switched
 * that kind on for the project (F2's switches, which ADR 0051 keeps); the switch for setting-pack tools (`lmrPackTools`)
 * still decides whether the rule is consulted at all under `auto`.
 */
import type { LmrMode } from '../../jobs/lmr-hook.js';
import {
  LMR_CATEGORIES,
  lmrNote,
  lmrSkipNote,
  verdictFor,
  type LmrConfig,
  type LmrEvidence,
} from '../../lmr/index.js';

/** One existing page a package changes, with what the rule needs to judge it. */
export interface ExistingEdit {
  readonly id: string;
  name: string;
  /** The steps (1-based) that change it: if none of them writes anything when the job runs, nothing is set. */
  readonly after: number[];
  /** What the changes did, as the rule measures it. */
  readonly evidence: LmrEvidence[];
  /** Changes the rule never counts, in words (`a move`, `a new name`, `Reference Type (a housekeeping key)`). */
  readonly minors: string[];
  /** Kinds the rule does not measure that the owner switched on for the project: they count, as in F2. */
  readonly forced: string[];
  /** Whether the page has the row: known from a sidebar read (true or false), or not known (null: the job finds out). */
  hasRow: boolean | null;
}

/** What was decided for one existing page, for the job, the preview, the proposal and the answer. */
export interface LmrDecision {
  readonly pageId: string;
  readonly page: string;
  readonly set: boolean;
  /** Which mode applied and why (`auto: a heading added (“…”)`, `set: lastMajorRevision "set" was asked`). */
  readonly why: string;
  /** In the general tools' words: `+ Last Major Revision → date of approval (auto: …)`, `Last Major Revision skipped: …`. */
  readonly note: string;
}

export const keyOf = (s: string): string => s.trim().toLocaleLowerCase('en-GB');

/** A changed existing page, made when its first change is planned. */
export function editOf(edits: Map<string, ExistingEdit>, id: string, name: string): ExistingEdit {
  let e = edits.get(id);
  if (!e) {
    e = { id, name, after: [], evidence: [], minors: [], forced: [], hasRow: null };
    edits.set(id, e);
  }
  return e;
}

/** A move or a new name: never a major revision, unless the owner switched names and moves on for the project. */
export function noteNameOrMove(e: ExistingEdit, cfg: LmrConfig, what: 'a move' | 'a new name'): void {
  e.minors.push(what);
  if (cfg.categories.namesTagsMoves)
    e.forced.push(`${LMR_CATEGORIES.namesTagsMoves.label}, switched on for this project`);
}

/** A fact's change: a housekeeping key never counts; any other is measured (trims, typos and punctuation do not count). */
export function noteFact(
  e: ExistingEdit,
  cfg: LmrConfig,
  key: string,
  before: string | null,
  after: string | null,
): void {
  if (keyOf(key) === keyOf(cfg.key)) return;
  if (cfg.housekeeping.some((h) => keyOf(h) === keyOf(key))) {
    e.minors.push(`${key} (a housekeeping key)`);
    return;
  }
  e.evidence.push({ kind: 'fact', key, before, after });
}

/** A link collection's change: Dependencies count; any other collection only when the owner switched it on. */
export function noteLinks(
  e: ExistingEdit,
  cfg: LmrConfig,
  title: string,
  added: number,
  removed: number,
): void {
  if (added + removed === 0) return;
  e.evidence.push({ kind: 'links', title, added, removed });
  if (keyOf(title) !== 'dependencies' && cfg.categories.linkCollections)
    e.forced.push(`${LMR_CATEGORIES.linkCollections.label}, switched on for this project`);
}

/**
 * The decision for one existing page. `skip` and `set` are the caller's; under `auto` the project's switch for
 * setting-pack tools must be on, then a kind the owner switched on counts, then the rule decides.
 */
export function decideExisting(
  e: ExistingEdit,
  cfg: LmrConfig,
  mode: LmrMode,
): { set: boolean; why: string } {
  if (mode === 'skip') return { set: false, why: 'lastMajorRevision "skip" was asked' };
  if (mode === 'set') return { set: true, why: 'set: lastMajorRevision "set" was asked' };
  if (!cfg.categories.packTools)
    return { set: false, why: 'the project’s switch for setting-pack tools (lmrPackTools) is off' };
  if (e.forced.length > 0) return { set: true, why: `auto: ${e.forced[0]}` };
  const v = verdictFor(e.evidence);
  if (v.major) return { set: true, why: `auto: ${v.reason}` };
  const reasons = [...(e.evidence.length > 0 ? [v.reason] : []), ...new Set(e.minors)];
  return { set: false, why: `${reasons.join('; ') || 'nothing changed'}, not a major revision` };
}

/** The decision in the general tools' words (src/lmr's notes), with the page named when the package changes several. */
export function decisionOf(e: ExistingEdit, cfg: LmrConfig, mode: LmrMode): LmrDecision {
  const d = decideExisting(e, cfg, mode);
  return {
    pageId: e.id,
    page: e.name,
    set: d.set,
    why: d.why,
    note: d.set ? lmrNote(cfg.key, e.hasRow === null, d.why) : lmrSkipNote(cfg.key, d.why),
  };
}

/** The proposal's and the answer's one line: each existing page's decision, by name. */
export function lmrSummary(decisions: readonly LmrDecision[]): string {
  return decisions.map((d) => `${d.page}: ${d.note}`).join('; ');
}
