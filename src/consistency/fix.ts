/**
 * v3 F4b (ADR 0064, design D6): "Pick the right value". The owner picks a value on the dashboard (or types one); the
 * bridge **proposes** edits to every page that disagrees with it: ONE ordinary proposal, made of items (F3d's selective
 * approval), one per page, each editing only the restated value:
 *
 * - **a sidebar field** (a Temporal Scope's date, a Life State's, an identity field): `set_facts`' plan, the date's text
 *   replaced inside the field (the rest of the field kept), or the identity field's principal part;
 * - **a sentence**: `write_page`'s block-by-block path, the date's text replaced in its one text run (a date split by a
 *   mention or by formatting is not planned, and said);
 * - **a chronology row**: `update_timeline_event`'s own plan (`planEventChange`), so the row's Date and KCY cells and its
 *   timeline event change together.
 *
 * CR-2026-11-R4 (the review of the pick): **every edit is PLACED where the check read the value, never searched for**.
 *
 * - **A sentence** is found again by the sentence the check read it from (`StoredFact.place`: its SHA-1, and the date's
 *   offset in it) among the live paragraph's sentences, split exactly as the extractor splits them. It must be there
 *   exactly once, with the date at its offset, standing whole ("4A 10" is never the start of "4A 100") and inside ONE
 *   text run; only that run's text is edited, and only there. A sentence written more than once in its paragraph (which
 *   is meant cannot be told), a sentence changed since the check, a date inside a quotation (ADR 0058 D1 (a): quotations
 *   are never edited) or a date split by a mention or formatting is not planned, and is listed with why.
 * - **A field**: the `;` clause the check read (its SHA-1) among the live field's clauses, exactly once, the date at its
 *   offset; the run holding the date is edited in place and every other run (a line break, bold, a link) is sent back as
 *   it is. An identity value must still read as the check read it; only its principal part (before the first `;`, `(`
 *   or spaced dash, ADR 0064 amendment 1 E) is replaced and its qualifier kept. A field holding a mention is not planned.
 * - **A chronology row**: its live Date cell (and its Historical Event) must read what the check read, else it is not
 *   planned (the newer date is kept, and shown); inside the lock the row is compared whole (`rowBlocks`).
 * - **Each page's name, parent and tags are read live**: a page Archived, or filed under the Archived area, the Legacy
 *   Canon Archive or the Design References since the check is left as it is (history keeps its record); the job checks
 *   the name, parent and tags again inside its locks before it writes the page, and stops if they changed.
 *
 * Each page is read live first (the plan's reads); a value no longer there is not planned and is listed. It never edits
 * the side the owner picked, and never runs without the owner's pick: agents can only suggest. Approval, selective
 * approval, the rails ("bulk over 10 pages" asks for the step-up at approval) and Revert work as for any proposal; Last
 * Major Revision follows the owner's rule (the engine measures each page's change).
 */
import { textChange } from '../jobs/text-change.js';
import { createHash } from 'node:crypto';
import { unwritableIds } from '../appraisal/fixes.js';
import { labelContext, labelsOf, NON_CURRENT_AREAS } from '../appraisal/scope.js';
import { buildJob } from '../chronology/plan.js';
import { expandFacts } from '../facts/expand.js';
import { FactsPlanError, planFacts } from '../facts/plan.js';
import { sidebarFrom } from '../facts/sidebar.js';
import { SYSTEM_PRINCIPAL, type JobOrigin, type StepSpec } from '../jobs/index.js';
import { EXPECT_STEP } from '../jobs/internal-steps.js';
import type { PlanItem } from '../jobs/items.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import { shiftStep } from '../packs/engine/job.js';
import { textKey } from '../packs/engine/text.js';
import { insideQuotes } from '../packs/rename/text.js';
import { planBlockwise } from '../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../pages/blockwise-job.js';
import type { McpToolContext } from '../mcp/server.js';
import { liveRead } from '../mcp/tools/repo.js';
import type { ProjectDeps, ToolDeps } from '../mcp/tools/shape.js';
import { chrono, freshCalendar, planEventChange } from '../mcp/tools/timelines.js';
import { classifyName, treeSettingsFrom } from '../tree/classify.js';
import { placeSha, principalValue, sentenceSpans, standsWhole, type FactPlace } from './extract.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The job origin of every pick's proposal (Revert recognises its jobs by it). */
export const PICK_TOOL = 'consistency.pick';

/** One value to change, as the pick found it on its page. */
export type Edit =
  | {
      readonly kind: 'fact';
      readonly pageId: string;
      readonly pageName: string;
      /** The sidebar field (`Temporal Scope`). */
      readonly field: string;
      /** The value's text inside the field (a date), or the whole field's value (an identity fact). */
      readonly from: string;
      /** The new text of the value (a date; an identity fact's new principal part). */
      readonly to: string;
      /** The whole field is the value (an identity fact): its principal part is replaced, its qualifier kept. */
      readonly whole: boolean;
      /** CR-2026-11-R4: a date's `;` clause as the check read it (its SHA-1) and the date's offset in it. */
      readonly clause?: { readonly sha: string; readonly at: number };
    }
  | {
      readonly kind: 'prose';
      readonly pageId: string;
      readonly pageName: string;
      readonly documentId: string;
      readonly blockId: string;
      readonly from: string;
      readonly to: string;
      readonly context: string;
      /** CR-2026-11-R4: the sentence as the check read it (its SHA-1) and the date's offset in it. */
      readonly sentence?: { readonly sha: string; readonly at: number };
    }
  | {
      readonly kind: 'row';
      readonly pageId: string;
      readonly pageName: string;
      readonly documentId: string;
      readonly rowId: string;
      /** The Date cell as the check read it: the row is planned only while its live Date cell reads the same. */
      readonly from: string;
      readonly to: string;
      /** CR-2026-11-R4: the SHA-1 of the row's Historical Event text as the check read it (absent: not compared). */
      readonly event?: string;
    };

/** An edit not planned, with why (and the value the page holds now, when it was read). */
export interface NotPlanned {
  readonly page: string;
  readonly from: string;
  readonly why: string;
  readonly now?: string;
}

export interface PickProposal {
  /**
   * The proposal made. CR-2026-11-R4: empty when no page could be planned: then nothing was proposed, `items` is empty
   * and every edit is in `notPlanned` (the pick answers `NOTHING_TO_PROPOSE` with them).
   */
  readonly proposalId: string;
  /** v3 F12 (ADR 0081): the job the edits run as (the owner's confirmed pick runs at once); absent for a proposal. */
  readonly jobId?: string;
  readonly summary: string | null;
  readonly items: readonly PlanItem[];
  /** Edits not planned, each with why (changed since the snapshot, a split date, a refusal of the row tools). */
  readonly notPlanned: readonly NotPlanned[];
  readonly reads: number;
  readonly proposedBecause?: string;
}

export class PickError extends Error {
  override readonly name = 'PickError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Makes ONE proposal of these edits (the owner's pick); none when no page can be planned. */
export type Picker = (o: {
  readonly projectId: string;
  readonly edits: readonly Edit[];
  readonly title: string;
  readonly operation: Obj;
}) => Promise<PickProposal>;

const SILENT_LOG = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => SILENT_LOG,
} as unknown as McpToolContext['log'];

/** v3 F12 (ADR 0081): the owner's pick, confirmed in its dialog, runs its edits at once as one job. */
const ORIGIN: JobOrigin = {
  kind: 'ui',
  client: 'owner',
  tool: PICK_TOOL,
  principal: SYSTEM_PRINCIPAL,
  ownerConfirmed: true,
};

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ============================================================================================ text, placed

/** Where a character of a block's (or a field's) text came from: a run, and the offset in its own text (-1: not text). */
interface Origin {
  readonly run: number;
  readonly off: number;
}

/**
 * Runs' text as the full-text index reads it (a text run's own, a line break as a new line, a mention by its label),
 * whitespace collapsed and trimmed, as the check read it, with the origin of every character kept (the pick edits the
 * run a date stands in, there, and nothing else).
 */
export function placedText(runs: readonly unknown[]): { text: string; origin: Origin[] } {
  const raw: string[] = [];
  const from: Origin[] = [];
  runs.forEach((r, run) => {
    if (!isObj(r)) return;
    if (typeof r.text === 'string') {
      for (let k = 0; k < r.text.length; k++) {
        raw.push(r.text[k]!);
        from.push({ run, off: k });
      }
    } else if (r.break === true) {
      raw.push('\n');
      from.push({ run, off: -1 });
    } else if (isObj(r.mention)) {
      const m = r.mention;
      const label = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
      for (let k = 0; k < label.length; k++) {
        raw.push(label[k]!);
        from.push({ run, off: -1 });
      }
    }
  });
  let text = '';
  const origin: Origin[] = [];
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/u.test(raw[i]!)) {
      if (!space) {
        text += ' ';
        origin.push(from[i]!);
      }
      space = true;
      continue;
    }
    space = false;
    text += raw[i]!;
    origin.push(from[i]!);
  }
  let s = 0;
  let e = text.length;
  while (s < e && text[s] === ' ') s++;
  while (e > s && text[e - 1] === ' ') e--;
  return { text: text.slice(s, e), origin: origin.slice(s, e) };
}

/** The one text run `len` characters at `p` stand in, and their place in its own text; null when they cross runs. */
function oneRun(
  origin: readonly Origin[],
  p: number,
  len: number,
): { run: number; a: number; b: number } | null {
  if (len <= 0 || p < 0 || p + len > origin.length) return null;
  const first = origin[p]!;
  for (let i = p; i < p + len; i++) {
    const o = origin[i]!;
    if (o.off < 0 || o.run !== first.run) return null;
  }
  return { run: first.run, a: first.off, b: origin[p + len - 1]!.off + 1 };
}

interface RunEdit {
  readonly run: number;
  readonly a: number;
  readonly b: number;
  readonly to: string;
}

/**
 * The runs with these edits made (each in its run's own text, at its place); every other run, and every mark, exactly
 * as it was (the array is copied, never filtered).
 */
function applyRunEdits(runs: readonly unknown[], edits: readonly RunEdit[]): unknown[] {
  const out = [...runs];
  for (const e of [...edits].sort((x, y) => x.run - y.run || y.a - x.a)) {
    const r = out[e.run];
    if (!isObj(r) || typeof r.text !== 'string') continue; // never: an edit is placed in a text run
    out[e.run] = { ...r, text: `${r.text.slice(0, e.a)}${e.to}${r.text.slice(e.b)}` };
  }
  return out;
}

/** Whether a new edit overlaps one already planned in the same runs. */
const overlaps = (list: readonly RunEdit[], e: RunEdit) =>
  list.some((x) => x.run === e.run && x.a < e.b && e.a < x.b);

/** A field's `;` clauses with where each stands in its text, as the extractor reads them (each trimmed). */
function clauseSpans(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let from = 0;
  for (const part of text.split(';')) {
    const lead = part.length - part.trimStart().length;
    const t = part.trim();
    if (t !== '') out.push({ start: from + lead, text: t });
    from += part.length + 1;
  }
  return out;
}

/** A block anywhere in a tree, with the kinds of the blocks it stands in. */
function blockAt(
  list: readonly unknown[],
  id: string,
  kinds: readonly string[] = [],
): { block: Obj; within: string[] } | null {
  for (const b of list) {
    if (!isObj(b)) continue;
    if (b.id === id) return { block: b, within: [...kinds] };
    if (Array.isArray(b.children)) {
      const hit = blockAt(b.children as unknown[], id, [...kinds, typeof b.kind === 'string' ? b.kind : '']);
      if (hit) return hit;
    }
  }
  return null;
}

/** A tree with one block's runs replaced (everything else as it was). */
function withContent(list: readonly unknown[], id: string, content: unknown[]): Obj[] {
  return list.map((b) => {
    if (!isObj(b)) return b as Obj;
    if (b.id === id) return { ...b, content };
    if (Array.isArray(b.children))
      return { ...b, children: withContent(b.children as unknown[], id, content) };
    return b;
  });
}

// ============================================================================================ the page, now

interface PageNow {
  readonly name: string;
  readonly parentId: string | null;
  readonly tags: readonly string[];
}

/**
 * CR-2026-11-R4 (PK-28): why a page read live is history now, or null: Archived (its `[BARC]` prefix or the Archived
 * status tag), or under the Archived index, the Legacy Canon Archive or the Design References (its parent's place in the
 * repository tree). ADR 0064 D3/D4 decision 7 leaves history out of the comparison; the pick never edits it.
 */
function historyNow(pd: ProjectDeps, projectId: string, pageId: string, now: PageNow): string | null {
  const lifecycle = lifecycleFrom(pd.services?.projectSettings?.(projectId) ?? {});
  const { kind, displayName } = classifyName(now.name);
  if (kind === 'barc') return `it is Archived now (“${now.name}”): history is left as it is`;
  if (now.tags.some((t) => textKey(t) === textKey(lifecycle.tags.archived)))
    return `it is tagged ${lifecycle.tags.archived} now: history is left as it is`;
  const tree = pd.services?.tree.queries;
  const parent = now.parentId && tree ? tree.node(projectId, now.parentId).data : null;
  if (!parent || !tree) return null;
  const kinds = parent.path.ids.map((id) => tree.node(projectId, id).data?.kind ?? 'unclassified');
  const labels = labelsOf(
    {
      ids: [...parent.path.ids, pageId],
      names: [...parent.path.names, displayName],
      kinds: [...kinds, kind],
    },
    labelContext(null, lifecycle),
  );
  if (labels.lifecycle === 'Archived') return 'it is in the Archived area now: history is left as it is';
  if (labels.area) {
    const area = NON_CURRENT_AREAS.find((a) => a.key === labels.area)?.label ?? labels.area;
    return `it is filed under the ${area} now: history is left as it is`;
  }
  return null;
}

/** The in-lock check of a page's name, parent and tags as the pick read them (a lifecycle change stops the job). */
function pageCheck(pageId: string, now: PageNow): StepSpec {
  return {
    op: EXPECT_STEP,
    params: {
      body: {
        checks: [
          {
            label: 'page',
            kind: 'resource',
            resourceId: pageId,
            ...(now.name.length <= 500 ? { name: now.name } : {}),
            parentId: now.parentId,
            ...(now.tags.length <= 50 && now.tags.every((t) => t.length <= 100)
              ? { tags: [...now.tags] }
              : {}),
          },
        ],
      },
    },
  };
}

// ============================================================================================ the picker

/** Builds the picker over the tool layer (the chronology's row tools need its context), as the bridge's own work. */
export function bridgePicker(deps: ToolDeps): Picker {
  return async (o) => {
    const sel = deps.selector.select(o.projectId, 'write');
    if (!sel.ok) throw new PickError(sel.error.code, sel.error.message);
    // Every read of the plan is the owner's (the dashboard's), as the bridge's other owner-made proposals are.
    const engine = new Proxy(deps.engine, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === 'run')
          return (...a: Parameters<typeof t.run>) => t.run(a[0], a[1], { ...a[2], origin: ORIGIN });
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const pd: ProjectDeps = { ...deps, engine, project: sel.project };
    const mctx: McpToolContext = {
      caller: undefined,
      signal: new AbortController().signal,
      log: SILENT_LOG,
      principal: SYSTEM_PRINCIPAL,
      scope: 'write',
    };
    return proposeEdits(pd, mctx, o);
  };
}

interface Change {
  readonly what: string;
  readonly before: string | null;
  readonly after: string | null;
}

async function proposeEdits(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: Parameters<Picker>[0],
): Promise<PickProposal> {
  const tool = 'arkona_consistency';
  const notPlanned: NotPlanned[] = [];
  const items: PlanItem[] = [];
  const plans: { item: string; steps: StepSpec[]; docs: string[]; parts: string[] }[] = [];
  let reads = 0;
  const propertiesName = treeSettingsFrom(pd.services?.projectSettings?.(o.projectId) ?? {}).propertiesName;
  const byPage = new Map<string, Edit[]>();
  for (const e of o.edits) byPage.set(e.pageId, [...(byPage.get(e.pageId) ?? []), e]);
  for (const [pageId, edits] of byPage) {
    const pageName = edits[0]!.pageName;
    const item = `page:${pageId}`;
    const left = (e: Edit, why: string, now?: string) =>
      notPlanned.push({ page: pageName, from: e.from, why, ...(now !== undefined ? { now } : {}) });
    // CR-2026-11-R4 (PK-28): the page as it is now (one read): history since the check is left as it is.
    const res = await liveRead(pd, mctx, tool, 'getResource', { path: { resourceId: pageId } });
    reads++;
    if (!res.ok || !isObj(res.value)) {
      for (const e of edits) left(e, 'the page could not be read now (gone, or not readable)');
      continue;
    }
    const now: PageNow = {
      name: typeof res.value.name === 'string' ? res.value.name : '',
      parentId: typeof res.value.parentId === 'string' ? res.value.parentId : null,
      tags: Array.isArray(res.value.tags)
        ? (res.value.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    };
    const history = historyNow(pd, o.projectId, pageId, now);
    if (history) {
      for (const e of edits) left(e, history);
      continue;
    }
    // Each part of the page's plan has its own step numbers; they follow one another, after the page's own check.
    const steps: StepSpec[] = [pageCheck(pageId, now)];
    const add = (part: readonly StepSpec[]) => {
      const base = steps.length;
      for (const s of part) steps.push(shiftStep(s, base));
    };
    const docs: string[] = [];
    const parts: string[] = [];
    const changes: Change[] = [];
    const labels: string[] = [];

    // ---------------------------------------------------------------------------------------- sidebar fields
    const facts = edits.filter((e): e is Extract<Edit, { kind: 'fact' }> => e.kind === 'fact');
    if (facts.length > 0) {
      const read = await liveRead(pd, mctx, tool, 'listProperties', { path: { resourceId: pageId } });
      reads++;
      if (!read.ok) {
        for (const e of facts) left(e, 'its sidebar could not be read now');
      } else {
        const sidebar = sidebarFrom(read.value);
        const kv = sidebar.find((x) => x.kind === 'keyValue' && textKey(x.title) === textKey(propertiesName));
        const byField = new Map<
          string,
          { row: { key: string; content: readonly Obj[] }; list: typeof facts }
        >();
        for (const e of facts) {
          const rows = (kv?.rows ?? []).filter((r) => textKey(r.key) === textKey(e.field));
          const row = rows.length === 1 ? rows[0]! : null;
          if (!row) {
            left(
              e,
              rows.length > 1
                ? `${e.field} is on the page more than once: which one is meant cannot be told; change it by hand`
                : `${e.field} is no longer on the page`,
            );
            continue;
          }
          const k = textKey(row.key);
          byField.set(k, { row, list: [...(byField.get(k)?.list ?? []), e] });
        }
        const requests: { key: string; value: Obj[] }[] = [];
        const shown: Record<string, string> = {};
        for (const { row, list } of byField.values()) {
          const runs = row.content.filter(isObj);
          if (runs.some((r) => isObj(r.mention))) {
            for (const e of list) left(e, `${e.field} holds a mention: change it by hand`);
            continue;
          }
          if (runs.some((r) => typeof r.text !== 'string' && r.break !== true)) {
            for (const e of list)
              left(
                e,
                `${e.field} holds something the bridge does not write back (not text): change it by hand`,
              );
            continue;
          }
          const { text, origin } = placedText(runs);
          const runEdits: RunEdit[] = [];
          const fieldChanges: Change[] = [];
          for (const e of list) {
            let p: number;
            let len: number;
            let clause: { start: number; text: string };
            if (e.whole) {
              // An identity value: still as the check read it; its principal part replaced, its qualifier kept.
              if (text !== tidy(e.from)) {
                left(e, `${e.field} no longer reads “${e.from}”: changed since the check`, text);
                continue;
              }
              const principal = principalValue(text);
              p = text.indexOf(principal);
              len = principal.length;
              clause = { start: 0, text };
            } else {
              if (!e.clause) {
                left(e, `where the value stands in ${e.field} was not recorded: run the check again`, text);
                continue;
              }
              const hits = clauseSpans(text).filter((c) => placeSha(c.text) === e.clause!.sha);
              if (hits.length !== 1) {
                left(
                  e,
                  hits.length === 0
                    ? `${e.field} no longer reads as the check read it (changed since): nothing is planned for it`
                    : `${e.field} holds the same clause more than once: which one is meant cannot be told; change it by hand`,
                  text,
                );
                continue;
              }
              clause = hits[0]!;
              p = clause.start + e.clause.at;
              len = e.from.length;
              if (text.slice(p, p + len) !== e.from || !standsWhole(text, p, len)) {
                left(e, `${e.field} no longer reads “${e.from}” there (changed since the check)`, text);
                continue;
              }
            }
            const where = oneRun(origin, p, len);
            if (!where) {
              left(
                e,
                `the value “${e.from}” in ${e.field} is not in one piece of text (split by a line break or formatting): change it by hand`,
                text,
              );
              continue;
            }
            const re: RunEdit = { ...where, to: e.to };
            if (overlaps(runEdits, re)) {
              left(e, `another edit of this pick changes the same text of ${e.field}`, text);
              continue;
            }
            runEdits.push(re);
            const at = p - clause.start;
            fieldChanges.push({
              what: e.field,
              before: clause.text,
              after: `${clause.text.slice(0, at)}${e.to}${clause.text.slice(at + len)}`,
            });
            labels.push(`${e.from} → ${e.to}`);
          }
          if (runEdits.length === 0) continue;
          const value = applyRunEdits(runs, runEdits).filter(isObj);
          requests.push({ key: row.key, value });
          shown[row.key] = placedText(value).text;
          changes.push(...fieldChanges);
        }
        if (requests.length > 0)
          try {
            const plan = planFacts({
              resourceId: pageId,
              sidebar,
              propertyTitle: propertiesName,
              facts: requests,
              links: [],
              templateKeys: null,
            });
            if (!plan.empty) {
              const job = expandFacts(plan, { id: pageId, name: pageName }, sidebar, {
                facts: shown,
                links: {},
              });
              add(job.steps);
              parts.push(...job.pageParts);
            }
          } catch (e) {
            if (!(e instanceof FactsPlanError)) throw e;
            for (const f of facts) left(f, e.message);
          }
      }
    }

    // ---------------------------------------------------------------------------------------- sentences
    const prose = edits.filter((e): e is Extract<Edit, { kind: 'prose' }> => e.kind === 'prose');
    for (const documentId of [...new Set(prose.map((e) => e.documentId))]) {
      const read = await liveRead(pd, mctx, tool, 'getDocumentBlocks', {
        path: { resourceId: pageId, documentId },
      });
      reads++;
      const list = prose.filter((e) => e.documentId === documentId);
      const body =
        read.ok && isObj(read.value) && Array.isArray(read.value.blocks)
          ? (read.value.blocks as Obj[])
          : null;
      if (!body) {
        for (const e of list) left(e, 'its document could not be read now');
        continue;
      }
      let after: Obj[] = body;
      const docChanges: Change[] = [];
      for (const blockId of [...new Set(list.map((e) => e.blockId))]) {
        const inBlock = list.filter((e) => e.blockId === blockId);
        const found = blockAt(body, blockId);
        if (!found || !Array.isArray(found.block.content)) {
          for (const e of inBlock)
            left(e, 'its paragraph is no longer on the page (changed since the check)');
          continue;
        }
        const runs = found.block.content as unknown[];
        const { text, origin } = placedText(runs);
        const spans = sentenceSpans(text);
        const quoteBlock = found.within.some((k) => /^(?:quote|blockquote)$/iu.test(k));
        const runEdits: RunEdit[] = [];
        for (const e of inBlock) {
          if (!e.sentence) {
            left(
              e,
              'where the value stands in its sentence was not recorded: run the check again',
              clip(text),
            );
            continue;
          }
          const hits = spans.filter((s) => placeSha(s.text) === e.sentence!.sha);
          if (hits.length !== 1) {
            left(
              e,
              hits.length === 0
                ? `the sentence no longer reads as the check read it (“${clip(e.context)}”): changed since; nothing is planned for it`
                : 'the sentence is written more than once in its paragraph: which one is meant cannot be told; change it by hand',
              clip(text),
            );
            continue;
          }
          const s = hits[0]!;
          const p = s.start + e.sentence.at;
          const len = e.from.length;
          if (text.slice(p, p + len) !== e.from || !standsWhole(text, p, len)) {
            left(
              e,
              `the sentence no longer holds “${e.from}” where the check read it (changed since)`,
              s.text,
            );
            continue;
          }
          // ADR 0058 D1 (a), as for renames: a quotation is never edited.
          if (quoteBlock || insideQuotes(text, p)) {
            left(
              e,
              'inside a quotation: a quotation is never edited (ADR 0058 D1 (a)); change it by hand if wanted',
              s.text,
            );
            continue;
          }
          const where = oneRun(origin, p, len);
          if (!where) {
            left(
              e,
              `the date “${e.from}” is not in one piece of text (split by a mention or formatting): change it by hand`,
              s.text,
            );
            continue;
          }
          const re: RunEdit = { ...where, to: e.to };
          if (overlaps(runEdits, re)) {
            left(e, 'another edit of this pick changes the same text', s.text);
            continue;
          }
          runEdits.push(re);
          const at = p - s.start;
          docChanges.push({
            what: 'the sentence',
            before: s.text,
            after: `${s.text.slice(0, at)}${e.to}${s.text.slice(at + len)}`,
          });
          labels.push(`${e.from} → ${e.to}`);
        }
        if (runEdits.length > 0) after = withContent(after, blockId, applyRunEdits(runs, runEdits));
      }
      if (after === body) continue;
      const plan = planBlockwise(body, after, {
        unwritable: unwritableIds(body),
        validate: (op) => validateBlockOp(pageId, documentId, op),
      });
      if (!plan.ok) {
        for (const e of list) left(e, `it cannot be written block by block: ${plan.refusal.message}`);
        continue;
      }
      if (plan.empty) continue;
      const job = blockwiseJob({
        resourceId: pageId,
        documentId,
        before: body,
        after,
        ops: plan.ops,
        journalOperation: { tool: 'write_page', page: { id: pageId, name: pageName }, from: PICK_TOOL },
      });
      add(job.steps);
      docs.push(documentId);
      parts.push('page content');
      changes.push(...docChanges);
    }

    // ---------------------------------------------------------------------------------------- a chronology row
    // The row tools' own plan (its Date and KCY cells and its timeline event, in step).
    for (const e of edits.filter((x): x is Extract<Edit, { kind: 'row' }> => x.kind === 'row')) {
      const c = chrono(pd);
      if (!c.ok) {
        left(e, 'the chronology is not confirmed, so its row tools refuse');
        continue;
      }
      const ch = c.value;
      const age = ch.config.ages.find((a) => a.tableDocumentId === e.documentId);
      const fc = await freshCalendar(pd, mctx, 'update_timeline_event', ch.config.calendarId!);
      reads++;
      if (!fc.ok || !age) {
        left(
          e,
          age
            ? 'the chronology’s calendar could not be read now'
            : 'the row’s table is not one of the chronology’s ages',
        );
        continue;
      }
      const requestKey = createHash('sha1')
        .update(JSON.stringify({ pick: o.title, row: e.rowId, to: e.to }))
        .digest('hex');
      const planned = await planEventChange(
        pd,
        mctx,
        'update_timeline_event',
        ch,
        fc.cal,
        { event: { row_id: e.rowId, age: age.name }, date: e.to },
        requestKey,
      );
      if (!planned.ok) {
        const r = planned.outcome.kind === 'answer' ? planned.outcome.result : null;
        const text = r?.content?.[0] && 'text' in r.content[0] ? String(r.content[0].text) : 'refused';
        left(e, `the row tools refuse: ${text.slice(0, 300)}`);
        continue;
      }
      const s = planned.submit;
      // CR-2026-11-R4 (PK-36): the row as it is now must read what the check read; a newer date is never overwritten.
      const w = s.writes.find(
        (x) => (x.kind === 'row.replace' || x.kind === 'row.delete') && x.rowId === e.rowId,
      );
      const rowNow = w
        ? w.kind === 'row.replace'
          ? w.before
          : w.kind === 'row.delete'
            ? w.texts
            : null
        : null;
      if (!rowNow) {
        left(e, 'the row tools planned no change to this row');
        continue;
      }
      if (tidy(rowNow.date) !== tidy(e.from)) {
        left(
          e,
          `the row’s Date now reads “${rowNow.date}” (the check read “${e.from}”): changed since the check, so the newer date is kept`,
          rowNow.date,
        );
        continue;
      }
      if (e.event !== undefined && placeSha(rowNow.description) !== e.event) {
        left(
          e,
          `the row’s Historical Event changed since the check (it reads “${clip(rowNow.description)}” now): nothing is planned for it`,
          rowNow.date,
        );
        continue;
      }
      const built = buildJob({
        tool: s.tool,
        config: s.ch.config,
        target: s.target,
        writes: s.writes,
        ctx: s.ctx,
        record: { requestKey: s.requestKey, ages: s.ages, summary: s.summary },
      });
      add(built.steps);
      docs.push(...built.holdDocuments);
      parts.push(`chronology row: ${rowNow.date} → ${e.to}`);
      changes.push({
        what: 'chronology row (Date, KCY and its timeline event)',
        before: rowNow.date,
        after: e.to,
      });
      labels.push(`${rowNow.date} → ${e.to}`);
    }
    // Only the page's own check: nothing of it could be planned.
    if (steps.length === 1) continue;
    plans.push({ item, steps, docs, parts });
    items.push({
      id: item,
      kind: 'restatement',
      group: 'Pages that disagree with the picked value',
      label: `${pageName}: ${labels.join('; ')}`,
      page: { id: pageId, name: pageName },
      // Amendment 1 to ADR 0072: each change of words carries where its replaced words are (the Proposals page
      // highlights them).
      diff: {
        changes: changes.map((c) => {
          const t =
            c.before !== null && c.after !== null
              ? textChange({ page: pageName, before: c.before, after: c.after })
              : null;
          return t && t.before === c.before && t.after === c.after
            ? { ...c, removed: t.removed, added: t.added }
            : c;
        }),
      },
      dependsOn: [],
      selected: true,
    });
  }
  if (plans.length === 0) return { proposalId: '', summary: null, items: [], notPlanned, reads };
  // One job: each page's steps in turn, renumbered, each step naming its page's item; every write covered by the
  // job-level locks (the engine refuses a write a held lock does not cover). CR-2026-11-R4: every page edited is held
  // (its resource as well as its documents), so the bridge's own writes to it wait while the job checks and writes it.
  const steps: StepSpec[] = [];
  for (const { item, steps: own } of plans) {
    const base = steps.length;
    for (const s of own) steps.push({ ...shiftStep(s, base), items: [item] });
  }
  const pages = plans.map((x) => x.item.slice('page:'.length));
  const docs = [...new Set(plans.flatMap((x) => x.docs))];
  const r = await pd.engine.submit({
    kind: 'batch_ops',
    project: o.projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin: ORIGIN,
    title: o.title.slice(0, 300),
    internal: true,
    holdLock: { resourceId: pages[0]! },
    ...(pages.length > 1 ? { holdMore: { resources: pages.slice(1) } } : {}),
    ...(docs.length > 0 ? { holdDocuments: docs } : {}),
    proposal: {
      summary: o.title,
      items,
      operation: { ...o.operation, ...(notPlanned.length ? { notPlanned } : {}) },
      operations: plans.map(({ item, parts }) => {
        const it = items.find((i) => i.id === item)!;
        // Amendment 1 to ADR 0072: the words each page's edits change (the summary and the Review card show them).
        const textChanges = (it.diff?.changes ?? [])
          .map((c) =>
            c.before !== null && c.after !== null
              ? textChange({
                  page: it.page?.name ?? '',
                  ...(it.page?.id ? { pageId: it.page.id } : {}),
                  what: c.what,
                  before: c.before,
                  after: c.after,
                })
              : null,
          )
          .filter((c) => c !== null);
        return {
          tool: 'arkona_consistency',
          page: it.page,
          pageParts: parts,
          summaryLabel: it.label,
          ...(textChanges.length > 0 ? { textChanges } : {}),
        };
      }),
    },
  });
  const jobId = 'jobId' in r && typeof r.jobId === 'string' ? r.jobId : undefined;
  if ((!('proposalId' in r) || typeof r.proposalId !== 'string') && !jobId)
    throw new PickError('NOT_PROPOSED', 'The pick was neither run nor proposed; nothing was done.');
  return {
    proposalId: 'proposalId' in r && typeof r.proposalId === 'string' ? r.proposalId : '',
    ...(jobId ? { jobId } : {}),
    summary: 'summary' in r && typeof r.summary === 'string' ? r.summary : jobId ? o.title : null,
    items,
    notPlanned,
    reads,
    ...('proposedBecause' in r && typeof r.proposedBecause === 'string'
      ? { proposedBecause: r.proposedBecause }
      : {}),
  };
}

export type { FactPlace };
