/**
 * v3 F4c (ADR 0065; design E4 and E8): the Narrative Integrity audit (category `narrative`), the Repository Automation
 * diagnostic that had no tool. Read-only, from the snapshots (a pure function of its context). It reports, it never
 * repairs: "Propose a fix" is offered only where the fix is mechanical (a missing continuity index, tags, a dateline, a
 * link, a number field, the order) and is always ONE proposal for the owner. Never the prose.
 */
import { readLeading, spanOf, type DateReading } from '../../consistency/dates.js';
import { datelineOf, holdsReservedWord, parseNarrativeName } from '../../narrative/names.js';
import {
  auDefinitions,
  continuityIndexes,
  nkey,
  rootsOf,
  storiesIn,
  storyLayout,
  type NNode,
  type NView,
  type StoryLayout,
} from '../../narrative/layout.js';
import { narrativeTags, type NarrativeKindTag } from '../../narrative/tags.js';
import type { NarrativeRules } from '../../packs/types.js';
import { fact, isNarrativePage, modelView, type AuditContext } from '../context.js';
import type { AuditPage } from '../model.js';
import type { FindingDraft } from '../types.js';

type Obj = Record<string, unknown>;

/** The narrative check (see the module comment). Nothing when the project has no narrative rules. */
export function narrativeCheck(ctx: AuditContext): FindingDraft[] {
  const input = ctx.narrative;
  if (!input) return [];
  const { rules } = input;
  const view = modelView(ctx.model);
  const roots = rootsOf(view, rules);
  const out: FindingDraft[] = [];
  if (!roots.narratives) {
    out.push({
      code: 'narrative_root_missing',
      message: roots.ambiguous.includes(rules.indexes.narratives)
        ? `More than one index is named “${rules.indexes.narratives}”: the narrative audit and tools need exactly one.`
        : `No index named “${rules.indexes.narratives}” is in the snapshots: the stories have nowhere to go.`,
      evidence: {
        name: rules.indexes.narratives,
        ambiguous: roots.ambiguous.includes(rules.indexes.narratives),
      },
      sourceKind: 'bridge',
    });
    return out;
  }
  const narratives = roots.narratives;
  const page = (id: string) => ctx.model.pages.get(id)!;

  // ---- E4: the continuity indexes.
  const conts = continuityIndexes(view, rules, roots);
  if (!conts.some((c) => c.main))
    out.push({
      code: 'narrative_main_index_missing',
      pageId: narratives.id,
      message: `“${narratives.displayName}” has no “${rules.indexes.main}” index: the main continuity’s stories go there.`,
      evidence: { name: rules.indexes.main },
      fix: indexFix(rules, narratives, rules.indexes.main, false),
    });
  for (const au of auDefinitions(view, roots))
    if (!conts.some((c) => nkey(c.name) === nkey(au.name)))
      out.push({
        code: 'narrative_au_index_missing',
        pageId: narratives.id,
        key: nkey(au.name),
        message: `The AU “${au.name}” (defined under ${rules.indexes.continuities}) has no index under “${narratives.displayName}”.`,
        evidence: { au: au.name, definition: { id: au.node.id, name: au.node.rawName } },
        fix: indexFix(rules, narratives, au.name, true),
      });
  for (const c of conts)
    if (!c.main && !c.au)
      out.push({
        code: 'narrative_unknown_continuity',
        pageId: c.node.id,
        message: `“${c.node.displayName}” under ${narratives.displayName} is neither ${rules.indexes.main} nor an AU defined under ${rules.indexes.continuities}.`,
        evidence: { name: c.node.displayName },
      });
  for (const id of ctx.narrativeIds ?? []) {
    const p = page(id);
    if (
      p.kind === 'index' &&
      holdsReservedWord(rules, p.displayName) &&
      nkey(p.displayName) !== nkey(rules.indexes.main)
    )
      out.push({
        code: 'narrative_reserved_word',
        pageId: p.id,
        message: `“${p.rawName}”: only the ${rules.indexes.main} index may carry “${rules.reservedWord}” in its name.`,
        evidence: { name: p.rawName },
      });
  }

  // ---- every story.
  for (const c of conts) {
    const au = !c.main;
    for (const s of storiesIn(view, c.node)) {
      const layout = storyLayout(view, rules, roots, s);
      storyChecks(ctx, input, view, layout, c.name, au, out);
    }
    // A continuity's own pages (a Chronology Map) and its stories: tags.
    for (const k of view.children(c.node.id)) {
      const parsed = parseNarrativeName(rules, k.displayName, k.kind === 'index');
      const kind: NarrativeKindTag | null =
        k.kind === 'index' ? 'story' : parsed?.kind === 'chronologyMap' ? 'chronologyMap' : null;
      if (kind) tagCheck(rules, page(k.id), kind, au, out);
    }
  }
  // Placeholder text left in a field of any narrative page.
  const patterns = rules.placeholders.flatMap((p) => {
    try {
      return [new RegExp(p, 'iu')];
    } catch {
      return [];
    }
  });
  for (const id of ctx.narrativeIds ?? []) {
    const p = page(id);
    for (const f of p.facts.values()) {
      const t = f.text.trim();
      if (t !== '' && patterns.some((re) => re.test(t)))
        out.push({
          code: 'narrative_placeholder',
          pageId: p.id,
          key: nkey(f.key),
          message: `“${p.rawName}”: ${f.key} still holds the template’s placeholder “${t.slice(0, 120)}”.`,
          evidence: { field: f.key, value: t.slice(0, 200) },
        });
    }
  }
  return out;
}

function indexFix(rules: NarrativeRules, narratives: NNode, name: string, au: boolean) {
  return {
    kind: 'narrative' as const,
    args: { action: 'index', parentId: narratives.id, name, tags: narrativeTags(rules, 'continuity', au) },
    summary: `Make the index “${name}” under ${narratives.displayName}, tagged ${narrativeTags(rules, 'continuity', au).join(', ')}.`,
  };
}

/** The narrative tags a page should carry, and a fix setting them (others kept after them). */
function tagCheck(
  rules: NarrativeRules,
  p: AuditPage,
  kind: NarrativeKindTag,
  au: boolean,
  out: FindingDraft[],
): void {
  const want = narrativeTags(rules, kind, false);
  if (au) want.push(rules.tags.au);
  const has = (t: string) => p.tags.some((x) => nkey(x) === nkey(t));
  const missing = want.filter((t) => !has(t));
  if (missing.length === 0) return;
  const tags = narrativeTags(rules, kind, au, p.tags);
  out.push({
    code: 'narrative_tags',
    pageId: p.id,
    message: `“${p.rawName}” lacks the narrative tag${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`,
    evidence: { missing, tags: [...p.tags] },
    fix: {
      kind: 'narrative',
      args: { action: 'tags', pageId: p.id, expected: [...p.tags], tags },
      summary: `Tag ${p.displayName}: ${tags.join(', ')}.`,
    },
  });
}

/** Whether a sidebar mention of `target` is on page `p` under the field `field`. */
function linksTo(p: AuditPage, field: string, target: string): boolean {
  return p.refs.some(
    (r) =>
      r.resourceId === target &&
      r.via.kind === 'mention' &&
      r.via.where === 'sidebar' &&
      nkey(r.via.row) === nkey(field),
  );
}

function storyChecks(
  ctx: AuditContext,
  input: NonNullable<AuditContext['narrative']>,
  view: NView,
  l: StoryLayout,
  continuity: string,
  au: boolean,
  out: FindingDraft[],
): void {
  const { rules } = input;
  const f = rules.fields;
  const page = (id: string) => ctx.model.pages.get(id)!;
  const story = l.story;
  // Structure.
  if (l.storyMaps.length === 0)
    out.push({
      code: 'narrative_story_map_missing',
      pageId: story.id,
      message: `The story “${story.displayName}” has no ${rules.names.storyMap} (its first child).`,
      evidence: { story: story.displayName },
    });
  const first = view.children(story.id)[0];
  for (const m of l.storyMaps)
    if (first && first.id !== m.id)
      out.push({
        code: 'narrative_story_map_not_first',
        pageId: m.id,
        message: `“${story.displayName}”’s ${rules.names.storyMap} is not its first child (“${first.displayName}” is).`,
        evidence: { story: story.displayName, first: first.displayName },
        fix: {
          kind: 'move_resource',
          args: { pageId: m.id, parentId: story.id, order: 'narrative' },
          summary: `Put the ${rules.names.storyMap} first in ${story.displayName}.`,
        },
      });
  for (const a of l.acts) {
    const chapters = l.chapters.filter((c) => c.act?.n === a.n).length;
    const plans = l.plans.filter((p) => p.act === a.n).length;
    if (chapters === 0 && plans === 0)
      out.push({
        code: 'narrative_empty_act',
        pageId: a.node.id,
        message: `“${a.node.displayName}” holds no chapter, and its Act Map no plan: an empty act layer (the Workflow: no ceremonial layers).`,
        evidence: { act: a.n },
      });
  }
  for (const o of l.others)
    out.push({
      code: 'narrative_unnamed',
      pageId: o.node.id,
      message: `“${o.node.rawName}” in “${story.displayName}” is named by none of the narrative patterns (${rules.names.storyMap}, ${rules.names.act}, ${rules.names.actMap}, ${rules.names.chapterPlan}, ${rules.names.chapter}).`,
      evidence: { name: o.node.rawName, parent: o.parent.displayName },
    });
  // Tags.
  tagCheck(rules, page(story.id), 'story', au, out);
  for (const m of l.storyMaps) tagCheck(rules, page(m.id), 'storyMap', au, out);
  for (const a of l.acts) tagCheck(rules, page(a.node.id), 'act', au, out);
  for (const a of l.actMaps) tagCheck(rules, page(a.node.id), 'actMap', au, out);
  for (const p of l.plans) tagCheck(rules, page(p.node.id), 'chapterPlan', au, out);
  for (const c of l.chapters) tagCheck(rules, page(c.node.id), 'chapter', au, out);
  // Continuity fields.
  const contOk = (v: string) =>
    au
      ? nkey(v) === nkey(continuity)
      : rules.mainContinuityValues.some((m) => nkey(m) === nkey(v)) || nkey(v) === nkey(continuity);
  for (const id of [
    story.id,
    ...l.storyMaps.map((m) => m.id),
    ...l.actMaps.map((a) => a.node.id),
    ...l.plans.map((p) => p.node.id),
    ...l.chapters.map((c) => c.node.id),
  ]) {
    const p = page(id);
    const v = fact(ctx, p, f.continuity);
    if (v !== null && !contOk(v))
      out.push({
        code: 'narrative_continuity_mismatch',
        pageId: p.id,
        message: `“${p.rawName}”’s ${f.continuity} is “${v}”, but it sits in ${continuity}.`,
        evidence: { value: v, continuity },
      });
  }
  // Numbering.
  const dup = (list: readonly { n: number; node: NNode }[], what: string) => {
    const by = new Map<number, NNode[]>();
    for (const x of list) by.set(x.n, [...(by.get(x.n) ?? []), x.node]);
    for (const [n, nodes] of by)
      if (nodes.length > 1)
        out.push({
          code: 'narrative_number_duplicate',
          pageId: nodes[0]!.id,
          key: `${what}:${n}`,
          message: `“${story.displayName}” has ${nodes.length} ${what}s numbered ${n}: ${nodes.map((x) => x.displayName).join(', ')}.`,
          evidence: { number: n, pages: nodes.map((x) => ({ id: x.id, name: x.displayName })) },
        });
  };
  dup(l.chapters, 'chapter');
  dup(l.plans, 'plan');
  const numbers = new Set([...l.chapters.map((c) => c.n), ...l.plans.map((p) => p.n)]);
  const max = Math.max(0, ...numbers);
  for (let n = 1; n < max; n++)
    if (!numbers.has(n))
      out.push({
        code: 'narrative_number_gap',
        pageId: story.id,
        key: String(n),
        message: `“${story.displayName}” has no chapter and no plan numbered ${n} (its chapters run to ${max}).`,
        evidence: { number: n, max },
      });
  for (const x of [...l.chapters, ...l.plans]) {
    const p = page(x.node.id);
    const v = fact(ctx, p, f.chapterNumber);
    if (v !== null && v.replace(/\s/g, '') !== String(x.n))
      out.push({
        code: 'narrative_number_mismatch',
        pageId: p.id,
        message: `“${p.rawName}” is number ${x.n} by its name, but its ${f.chapterNumber} says “${v}”.`,
        evidence: { name: x.n, field: v },
        fix: {
          kind: 'set_facts',
          args: {
            pageId: p.id,
            facts: { [f.chapterNumber]: String(x.n) },
            expectedCurrent: { [f.chapterNumber]: v },
          },
          summary: `Set ${p.displayName}’s ${f.chapterNumber} to ${x.n} (its name’s number).`,
        },
      });
  }
  // Acts.
  for (const c of l.chapters) {
    const p = page(c.node.id);
    if (c.act && p.facts.has(nkey(f.act)) && !linksTo(p, f.act, c.act.node.id)) {
      const v = fact(ctx, p, f.act) ?? '';
      const named = parseNarrativeName(rules, v, true)?.n;
      if (v !== '' && named !== c.act.n && nkey(v) !== nkey(c.act.node.displayName))
        out.push({
          code: 'narrative_wrong_act',
          pageId: p.id,
          message: `“${p.rawName}” sits in “${c.act.node.displayName}” but its ${f.act} says “${v}”.`,
          evidence: { act: c.act.n, field: v },
        });
    }
  }
  // Plans and chapters.
  const gateRow = (p: AuditPage) => fact(ctx, p, f.questionGate);
  for (const c of l.chapters) {
    const plan = l.plans.find((p) => p.n === c.n);
    const ch = page(c.node.id);
    if (!plan) {
      out.push({
        code: 'narrative_chapter_without_plan',
        pageId: ch.id,
        message: `“${ch.rawName}” has no Chapter ${c.n} Plan.`,
        evidence: { number: c.n },
      });
    } else {
      const pl = page(plan.node.id);
      const fwd = ch.facts.has(nkey(f.chapterPlan)) && !linksTo(ch, f.chapterPlan, pl.id);
      const back = pl.facts.has(nkey(f.chapter)) && !linksTo(pl, f.chapter, ch.id);
      if (fwd) out.push(linkFinding(ch, f.chapterPlan, pl));
      if (back) out.push(linkFinding(pl, f.chapter, ch));
      const g = gateRow(pl);
      if (g !== null && nkey(g) === nkey(rules.gate.open))
        out.push({
          code: 'narrative_gate_open',
          pageId: pl.id,
          message: `“${ch.rawName}” exists while “${pl.rawName}” has its Question Gate ${rules.gate.open} (the Workflow’s Drafting Gate).`,
          evidence: { chapter: { id: ch.id, name: ch.rawName }, gate: g },
        });
    }
  }
  for (const p of l.plans) {
    const pl = page(p.node.id);
    const status = fact(ctx, pl, f.planningStatus);
    if (status && nkey(status) === nkey(rules.planning.drafted) && !l.chapters.some((c) => c.n === p.n))
      out.push({
        code: 'narrative_plan_drafted_without_chapter',
        pageId: pl.id,
        message: `“${pl.rawName}” is marked ${rules.planning.drafted}, but “${story.displayName}” has no chapter ${p.n}.`,
        evidence: { number: p.n },
      });
  }
  // Dates.
  const cal = input.calendar;
  const read = (t: string): DateReading | null => {
    if (!cal) return null;
    const r = input.style ? readLeading(cal, t, input.style) : readLeading(cal, t);
    return r.ok &&
      r.reading.text.replace(/\s+/g, ' ').trim().length >=
        t
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.;,]$/, '').length
      ? r.reading
      : null;
  };
  const span = (r: DateReading) => spanOf(cal!, r, 0);
  const storySpan = l.storyMaps[0] ? fact(ctx, page(l.storyMaps[0].id), f.storySpan) : null;
  const storyRange = storySpan ? read(storySpan) : null;
  let prev: { n: number; from: number; name: string } | null = null;
  for (const c of l.chapters) {
    const ch = page(c.node.id);
    const d = fact(ctx, ch, f.inWorldDate);
    const reading = d ? read(d) : null;
    if (!cal) continue;
    if (!d || !reading) {
      out.push({
        code: 'narrative_date_unreadable',
        pageId: ch.id,
        message: d
          ? `“${ch.rawName}”’s ${f.inWorldDate} “${d}” is not a date the calendar can read.`
          : `“${ch.rawName}” has no ${f.inWorldDate}.`,
        evidence: { value: d },
      });
      continue;
    }
    // The dateline: the first line of its page document, written from In-world Date (a place may follow).
    const scan = ch.scans.find((s) => ch.documents.find((x) => x.id === s.documentId)?.type === 'page');
    const firstText = (scan?.firstText ?? '').replace(/\s+/g, ' ').trim();
    const want = datelineOf(rules, d);
    const sep = rules.dateline.separator.trim();
    const ok = firstText === want || firstText.startsWith(`${want} ${sep} `);
    if (scan && !ok) {
      const place = firstText.includes(sep)
        ? firstText.slice(firstText.indexOf(sep) + sep.length).trim()
        : null;
      const dateline = datelineOf(
        rules,
        d,
        place && read(firstText.slice(0, firstText.indexOf(sep)).trim()) ? place : null,
      );
      out.push({
        code: 'narrative_dateline_mismatch',
        pageId: ch.id,
        documentId: scan.documentId,
        message: `“${ch.rawName}” opens with “${firstText.slice(0, 120)}”, not its dateline “${dateline}” (from ${f.inWorldDate}).`,
        evidence: { first: firstText.slice(0, 200), dateline },
        fix: {
          kind: 'narrative',
          args: {
            action: 'dateline',
            pageId: ch.id,
            documentId: scan.documentId,
            dateline,
            expectedFirst: firstText,
          },
          summary: `Make ${ch.displayName}’s first line its dateline “${dateline}” (the prose is untouched).`,
        },
      });
    }
    const s = span(reading);
    if (prev && s.from < prev.from && !ch.tags.some((t) => nkey(t) === nkey(rules.tags.flashback)))
      out.push({
        code: 'narrative_date_backwards',
        pageId: ch.id,
        message: `“${ch.rawName}” (${d}) is dated earlier than “${prev.name}” before it, and is not tagged ${rules.tags.flashback}.`,
        evidence: { date: d, previous: prev.name },
      });
    prev = { n: c.n, from: s.from, name: ch.rawName };
    const actMap = c.act ? l.actMaps.find((m) => m.n === c.act!.n) : null;
    const actSpan = actMap ? fact(ctx, page(actMap.node.id), f.actSpan) : null;
    const actRange = actSpan ? read(actSpan) : null;
    for (const [range, what] of [
      [actRange, f.actSpan],
      [storyRange, f.storySpan],
    ] as const) {
      if (!range) continue;
      const r = span(range);
      if (s.to < r.from || s.from > r.to)
        out.push({
          code: 'narrative_date_outside_span',
          pageId: ch.id,
          key: nkey(what),
          message: `“${ch.rawName}” (${d}) is outside its ${what} (${range.text}).`,
          evidence: { date: d, span: range.text, field: what },
        });
    }
  }
  void isNarrativePage;
}

function linkFinding(from: AuditPage, field: string, to: AuditPage): FindingDraft {
  return {
    code: 'narrative_link_broken',
    pageId: from.id,
    key: nkey(field),
    message: `“${from.rawName}”’s ${field} does not point at “${to.rawName}”.`,
    evidence: { field, target: { id: to.id, name: to.rawName } },
    fix: {
      kind: 'narrative',
      args: { action: 'link', pageId: from.id, field, targetId: to.id, targetName: to.displayName },
      summary: `Point ${from.displayName}’s ${field} at ${to.displayName}.`,
    },
  } satisfies FindingDraft & { evidence: Obj };
}
