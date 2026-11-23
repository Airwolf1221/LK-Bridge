/**
 * v3 F5b (ADR 0068, H5): the governance record of the automation framework. Repository Automation's "Approved Narrow
 * Automations" holds the block-id sweep's paragraph (the owner's approval of 17 November 2026: "enabling it is the
 * activation, and this approval establishes no wider repair whitelist"). Each code the owner switches on gets ONE
 * paragraph after it, in the sweep's form: the code and its plain name, the owner's approval and its date, the setting,
 * the scope, the one transformation, the verification, the concurrency rules and the stop conditions. Switching it off
 * amends the same paragraph (it is never deleted, so the history stays): the governance always says what is running.
 *
 * **Bridge-managed paragraphs.** Each starts with a stable code reference, `Bridge automation <code>:`, and the bridge
 * keeps its exact text (automation_paragraphs). A paragraph that no longer reads exactly so was edited outside the
 * bridge, and is reported (`inspect`): no automation runs until the owner sets it right (a setting change rewrites it).
 *
 * Pure: planning only. The service submits the write, carries the pack's approval over it and records the paragraph.
 */
import { headingKey, sectionBlocksOf } from '../packs/sections.js';
import type { CodeEntry } from './registry.js';
import { scopeOf } from './registry.js';
import type { ChangeRow, Mode, ParagraphRow } from './store.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The stable leading code reference of a bridge-managed paragraph. */
export const MARKER = /^Bridge automation ([a-z][a-z0-9_]*):/;

/** The plain text of a block's runs (a mention reads as its label). */
export function blockText(b: unknown): string {
  if (!isObj(b) || !Array.isArray(b.content)) return '';
  return (b.content as unknown[])
    .map((r) =>
      isObj(r)
        ? typeof r.text === 'string'
          ? r.text
          : isObj(r.mention) && typeof r.mention.text === 'string'
            ? r.mention.text
            : ''
        : '',
    )
    .join('');
}

/** The code a paragraph is the bridge's paragraph of, or null. */
export function managedCode(b: unknown): string | null {
  if (!isObj(b) || b.kind !== 'paragraph') return null;
  return MARKER.exec(blockText(b))?.[1] ?? null;
}

/** "23 November 2026" (London). */
export function longDate(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(new Date(ms));
}

export const MODE_WORDS: Readonly<Record<Mode, string>> = {
  off: 'Off',
  propose: 'Propose automatically',
  apply: 'Apply automatically',
};

const SETTING_WORDS: Readonly<Record<Exclude<Mode, 'off'>, string>> = {
  propose:
    'after each nightly audit (or when the owner runs it from the dashboard) the bridge makes one proposal for this code, one item per page, which the owner approves in whole or in part',
  apply:
    'after each nightly audit (or when the owner runs it from the dashboard) the bridge writes the change itself as the Automation principal: journalled, listed on the Review page and Revertible',
};

export const VERIFICATION =
  'every page is read back after the write and compared with the read made before it: it must be identical apart from the one transformation (a document block by block, the page’s name, tags, place, sidebar and documents, an asset’s name, folder and visibility), or the code is switched off';

export const CONCURRENCY =
  'one writer per page, holding the page’s lock (and its document’s); every finding re-checked with a fresh live read before anything is written (a finding no longer present is skipped and recorded); If-Match on every versioned write; at the lowest priority (P3), giving way to the owner’s and the agents’ work';

export const STOP_CONDITIONS =
  'the first failed verification, an unexpected error or a write whose outcome is unknown stops the code’s run and switches it off, with the reason recorded and shown; three findings skipped in a row for the same reason pause it for the owner’s review; when the budget runs out the run ends cleanly and the rest waits for the next run; the canon guard, the lifecycle guard and the safety rails are never bypassed, and a change one of them catches becomes an ordinary proposal and pauses the code; nothing runs while writes are paused or draining, while the project is read-only, while Pause all automation is on, or while Repository Automation has drifted from the approved pack';

/** The paragraph's text for a code, from its journal of changes (newest first, as the store gives them). */
export function paragraphText(
  e: CodeEntry,
  changes: readonly ChangeRow[],
  caps: { readonly perCode: number; readonly perRun: number },
): string {
  const asc = [...changes].sort((a, b) => a.id - b.id);
  const firstOn = asc.find((c) => c.to !== 'off');
  const current = asc.at(-1);
  const mode: Mode = current?.to ?? 'off';
  const approvedOn = firstOn ? longDate(firstOn.at) : longDate(current?.at ?? 0);
  const setting =
    mode === 'off'
      ? `Off since ${longDate(current?.at ?? 0)}${offWhy(current)}: not running`
      : `${MODE_WORDS[mode]}: ${SETTING_WORDS[mode]}`;
  const history = asc
    .map((c) => `${MODE_WORDS[c.to]} from ${longDate(c.at)}${c.to === 'off' ? offWhy(c) : ''}`)
    .join('; ');
  return (
    `Bridge automation ${e.code}: ${e.name} (owner approval through the bridge dashboard, ${approvedOn}). ` +
    `Setting: ${setting}. ` +
    `Scope: ${scopeOf(e)}; at most ${caps.perCode} pages a run for this code and ${caps.perRun} for every code together. ` +
    `Prerequisites: the pack approved and Repository Automation as approved; the night’s audit or appraisal finding. ` +
    `Transformation: ${e.transformation}. ` +
    `Verification: ${VERIFICATION}. ` +
    `Concurrency: ${CONCURRENCY}. ` +
    `Stop conditions: ${STOP_CONDITIONS}. ` +
    `History: ${history}. ` +
    `Enabling it is the activation, and this approval establishes no wider repair whitelist.`
  );
}

function offWhy(c: ChangeRow | undefined): string {
  if (!c) return '';
  if (c.principal === 'owner') return ' (switched off by the owner)';
  return ` (switched off by the bridge: ${c.reason ?? 'a stop condition'})`;
}

export interface SectionView {
  /** The section's top-level blocks, its heading first. */
  readonly blocks: Obj[];
  /** The sweep's paragraph (the first paragraph naming it), or null. */
  readonly sweep: Obj | null;
  /** The bridge-managed paragraphs in the section, in order. */
  readonly managed: { readonly code: string; readonly block: Obj }[];
}

/** The section in a document's top-level blocks, or null when its heading is not there exactly once. */
export function readSection(blocks: unknown, heading: string, sweepMarker: string): SectionView | null {
  const sec = sectionBlocksOf(blocks, heading);
  if (!sec) return null;
  const want = headingKey(sweepMarker);
  const sweep =
    sec.find((b) => b.kind === 'paragraph' && headingKey(blockText(b)).includes(want) && !managedCode(b)) ??
    null;
  const managed: { code: string; block: Obj }[] = [];
  for (const b of sec) {
    const code = managedCode(b);
    if (code) managed.push({ code, block: b });
  }
  return { blocks: sec, sweep, managed };
}

export type WritePlan =
  | {
      readonly ok: true;
      readonly op: 'insertBlock' | 'replaceBlock';
      readonly blockId: string;
      /** The paragraph as written. */
      readonly block: Obj;
      /** For an insert: the block it goes after. */
      readonly after: string | null;
      /** The whole document as it will read (the planned blocks). */
      readonly planned: Obj[];
      /** The paragraph's text before (an amendment), or null (a new paragraph). */
      readonly previousText: string | null;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * Where the code's paragraph goes, and the document as it will read. An existing paragraph of the code (by its
 * recorded block id, else by its marker) is replaced; otherwise a new one goes after the last bridge-managed paragraph
 * of the section, or after the sweep's paragraph. `newId` mints the new paragraph's id.
 */
export function planParagraph(
  docBlocks: readonly unknown[],
  o: {
    readonly code: string;
    readonly text: string;
    readonly heading: string;
    readonly sweepMarker: string;
    readonly recorded: ParagraphRow | null;
    readonly newId: () => string;
  },
): WritePlan {
  const top = docBlocks.filter(isObj);
  const sec = readSection(top, o.heading, o.sweepMarker);
  if (!sec)
    return {
      ok: false,
      code: 'GOVERNANCE_SECTION_MISSING',
      reason: `Repository Automation has no single section “${o.heading}”, so the approval cannot be recorded`,
    };
  if (!sec.sweep)
    return {
      ok: false,
      code: 'GOVERNANCE_SWEEP_MISSING',
      reason: `“${o.heading}” holds no paragraph naming the ${o.sweepMarker}, after which the bridge records its approvals`,
    };
  const existing =
    (o.recorded ? sec.managed.find((m) => m.block.id === o.recorded!.blockId) : undefined) ??
    sec.managed.find((m) => m.code === o.code);
  if (existing) {
    const id = existing.block.id;
    if (typeof id !== 'string')
      return { ok: false, code: 'GOVERNANCE_NOT_EDITABLE', reason: 'the code’s paragraph has no block id' };
    const block: Obj = { id, kind: 'paragraph', content: [{ text: o.text }] };
    return {
      ok: true,
      op: 'replaceBlock',
      blockId: id,
      block,
      after: null,
      planned: top.map((b) => (b.id === id ? block : b)),
      previousText: blockText(existing.block),
    };
  }
  const anchor = sec.managed.at(-1)?.block ?? sec.sweep;
  const after = anchor.id;
  if (typeof after !== 'string')
    return { ok: false, code: 'GOVERNANCE_NOT_EDITABLE', reason: 'the sweep’s paragraph has no block id' };
  const id = o.newId();
  const block: Obj = { id, kind: 'paragraph', content: [{ text: o.text }] };
  const at = top.findIndex((b) => b.id === after);
  return {
    ok: true,
    op: 'insertBlock',
    blockId: id,
    block,
    after,
    planned: [...top.slice(0, at + 1), block, ...top.slice(at + 1)],
    previousText: null,
  };
}

/** A bridge-managed paragraph that does not read as the bridge left it. */
export interface ParagraphProblem {
  readonly code: string;
  readonly state: 'edited' | 'missing' | 'unrecorded';
  readonly expected: string | null;
  readonly found: string | null;
}

/**
 * The bridge-managed paragraphs of the section against the bridge's record: each recorded paragraph must be there (by
 * its block id) with exactly its text, and every paragraph carrying the marker must be recorded.
 */
export function inspect(
  docBlocks: readonly unknown[],
  recorded: readonly ParagraphRow[],
  o: { readonly heading: string; readonly sweepMarker: string },
): { readonly found: boolean; readonly problems: ParagraphProblem[] } {
  const sec = readSection(docBlocks, o.heading, o.sweepMarker);
  if (!sec) return { found: false, problems: [] };
  const problems: ParagraphProblem[] = [];
  const all = docBlocks.filter(isObj);
  for (const r of recorded) {
    const b = all.find((x) => x.id === r.blockId);
    if (!b) problems.push({ code: r.code, state: 'missing', expected: r.text, found: null });
    else if (blockText(b) !== r.text)
      problems.push({ code: r.code, state: 'edited', expected: r.text, found: blockText(b) });
  }
  for (const m of sec.managed)
    if (!recorded.some((r) => r.blockId === m.block.id))
      problems.push({ code: m.code, state: 'unrecorded', expected: null, found: blockText(m.block) });
  return { found: true, problems };
}
