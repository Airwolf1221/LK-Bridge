/**
 * `arkona_appraise_owner` (v3 F3c, ADR 0054; the design's A2): one page appraised against Source Formatting, in
 * Repository Automation's four groups. Read-only: the page's pieces come from the snapshot overlay (or a live read when
 * asked), the page's open audit findings from the audits' store (reused, never re-checked), and the rules from the
 * Arkona pack's own data (the identity fields, placeholders, headings and overload heuristic its creation tools use).
 *
 * Every check of the design's table, in its stated group (decision D2), each naming the rule it comes from (rules.ts):
 * Purpose first; no repeated title or metadata header; no links in headings; no pasted Markdown; no decorative blank
 * paragraphs (polish); no em dashes in the name, headings or prose; the template's sidebar fields, none missing and none
 * improvised; the character completion gate (Core and Compact only); Source Boundaries and Unresolved Material where
 * applicable (polish); no Dependency on a Working or Archived page; no Working or Archived page in an Authoritative
 * page's Related Sources; an empty Related Sources (polish: a prompt to review); a missing reciprocal link between close
 * specialist owners (polish); an index's scope statement, "why open" text and Subpages collection; sibling order and the
 * closed tag grammar (the audits' findings, gathered); scope overload and a Core holding a specialist block
 * (architectural candidates, a pointer only).
 */
import { isLegacy, legacyProblems } from '../blockids/detect.js';
import type { Finding as AuditFinding } from '../audits/types.js';
import type { LkBlock } from '../markdown/index.js';
import {
  blockText,
  hasForbiddenDash,
  isPlaceholder,
  looksLikeMetadata,
  sectionsOf,
  textKey,
} from '../packs/engine/text.js';
import type { PackRules, TypeRules } from '../packs/types.js';
import { cleanPrefixes } from '../registry/names.js';
import { deepText, ownText } from './extract.js';
import type { LoadedPage, PageReader } from './reader.js';
import type { CheckId } from './rules.js';
import type { PageSplitAppraisal } from './split.js';
import type { EvidenceClass, FindingSource, GovernanceRule, Group } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One finding as a check makes it (the service adds its id, group, rule, follow-up and labels). */
export interface Draft {
  readonly check: CheckId;
  readonly pageId: string | null;
  /** Tells apart several findings of one check on one page (a link's target, a property). */
  readonly key?: string;
  readonly documentId?: string | null;
  readonly blockId?: string | null;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** For a check with a deterministic repair: what the repair needs, as the appraisal saw it. */
  readonly fixArgs?: Readonly<Record<string, unknown>>;
  readonly source?: FindingSource;
  /** Overrides of the catalogue (a gathered audit finding: its own severity decides the group). */
  readonly group?: Group;
  readonly evidence?: EvidenceClass;
  readonly rule?: GovernanceRule;
  readonly judgement?: { readonly tool: string; readonly decide: string };
  /** A gathered audit finding with its own "Propose a fix" (handed over, never duplicated). */
  readonly auditFix?: { readonly findingId: number; readonly summary: string };
  readonly noFix?: string;
}

export interface OwnerContext {
  readonly projectId: string;
  readonly reader: PageReader;
  readonly rules: PackRules;
  /** The template a page is compared with, by its pack role (`core`, `general`, `index`…), and its sidebar's rows. */
  readonly templateFor: (
    role: string,
    pageId: string,
  ) => Promise<
    | { readonly id: string; readonly name: string; readonly keys: readonly string[] }
    | { readonly unavailable: string }
    | null
  >;
  /** The page's open audit findings. */
  readonly auditFindings: (pageId: string) => readonly AuditFinding[];
  readonly propertiesName: string;
  readonly indexScopeRow: string;
  readonly referenceTypeRow: string;
  /** The two lifecycle indexes (never appraised as indexes: they are flat lists by design). */
  readonly lifecycleIndexIds: ReadonlySet<string>;
  /**
   * v3 F3e (ADR 0059): the split appraisal (A6) of a page, whose candidates A2 gathers into its architectural group
   * (null when the approved pack has no split rules: A2's own scope-overload pointer is used instead).
   */
  readonly split?: (p: LoadedPage, role: PageRole) => PageSplitAppraisal | null;
}

// ============================================================================================ text helpers

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const short = (s: string, n = 120) => {
  const t = tidy(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A paragraph with no visible text: no runs, or only whitespace and line breaks (no mention, no other run). */
export function isBlankParagraph(b: Obj): boolean {
  if (b.kind !== 'paragraph') return false;
  if (Array.isArray(b.children) && b.children.length > 0) return false;
  const runs = Array.isArray(b.content) ? (b.content as unknown[]) : [];
  return runs.every(
    (r) =>
      isObj(r) &&
      ((typeof r.text === 'string' && r.text.trim() === '' && Object.keys(r).every((k) => k === 'text')) ||
        r.break === true),
  );
}

/** A heading's runs that are links: a mention, or a text run with a link mark. */
export function headingLinks(b: Obj): { label: string; to: string }[] {
  if (b.kind !== 'heading' || !Array.isArray(b.content)) return [];
  const out: { label: string; to: string }[] = [];
  for (const r of b.content as unknown[]) {
    if (!isObj(r)) continue;
    if (isObj(r.mention))
      out.push({
        label: asText(r.mention.text) || asText(r.mention.name),
        to: `page ${asText(r.mention.resourceId)}`,
      });
    else if (typeof r.text === 'string' && typeof r.link === 'string')
      out.push({ label: r.text, to: r.link });
  }
  return out;
}

/** The literal Markdown a block's text holds (its non-code runs), as the kinds found. */
export function literalMarkdown(b: Obj, topLevel: boolean): string[] {
  if (!Array.isArray(b.content)) return [];
  const text = (b.content as unknown[])
    .filter((r) => isObj(r) && typeof r.text === 'string' && r.code !== true)
    .map((r) => String((r as Obj).text))
    .join('');
  const found: string[] = [];
  if (topLevel && b.kind === 'paragraph') {
    if (/^\s{0,3}#{1,6}\s+\S/.test(text)) found.push('a heading’s “#” syntax');
    if (/^\s{0,3}[-*+]\s+\S/.test(text)) found.push('a list item’s “- ” syntax');
  }
  if (/\*\*[^*\s][^*]*\*\*/.test(text)) found.push('“**” bold markers');
  if (/^\s*\|[^|\n]*\|[^|\n]*\|/m.test(text)) found.push('a pipe table row');
  return found;
}

/** Every block of a body in document order, with whether it is at the top level. */
function* walk(blocks: readonly unknown[], top = true): Generator<{ b: Obj; top: boolean }> {
  for (const b of blocks) {
    if (!isObj(b)) continue;
    yield { b, top };
    if (Array.isArray(b.children)) yield* walk(b.children, false);
  }
}

/** The blocks of a body that hold a forbidden dash in their text (headings and prose; never a code block). */
export function dashBlocks(blocks: readonly unknown[]): { id: string | null; kind: string; text: string }[] {
  const out: { id: string | null; kind: string; text: string }[] = [];
  for (const { b } of walk(blocks)) {
    if (!Array.isArray(b.content) || b.kind === 'code') continue;
    const text = (b.content as unknown[])
      .filter((r) => isObj(r) && typeof r.text === 'string' && r.code !== true)
      .map((r) => String((r as Obj).text))
      .join('');
    if (hasForbiddenDash(text))
      out.push({ id: typeof b.id === 'string' ? b.id : null, kind: asText(b.kind), text });
  }
  return out;
}

// ============================================================================================ roles

export interface PageRole {
  /** The pack role (`core`, `compact`, `art`, `relationship`, `specialist`, `index`), or `owner` for any other page. */
  readonly role: string;
  /** The template role it is compared with. */
  readonly template: string;
  /** Headings warned about when missing (Source Boundaries, Unresolved Material), where applicable. */
  readonly warnMissing: readonly string[];
  /** The character's index, when the page is in a character set. */
  readonly setIndex: string | null;
}

export function characterType(rules: PackRules): TypeRules | null {
  return rules.types.find((t) => t.hook === 'character') ?? null;
}

const factText = (p: LoadedPage, key: string): string | null => {
  const f = p.sidebar?.facts.get(key.normalize('NFC').trim().toLowerCase());
  return f && f.count === 1 ? f.text : (f?.text ?? null);
};

/** The identity role of a page from its Reference Type (`core`, `compact`), else null. */
function identityRoleOf(rules: PackRules, referenceType: string | null): string | null {
  const t = characterType(rules);
  if (!t || referenceType === null) return null;
  const hit = t.roles.find(
    (r) =>
      r.referenceType !== null &&
      textKey(r.referenceType) === textKey(referenceType) &&
      (r.role === 'core' || r.role === 'compact'),
  );
  return hit?.role ?? null;
}

/** Whether an index is a character's own index (it holds a Core or a Compact Reference directly). */
async function isCharacterIndex(ctx: OwnerContext, indexId: string): Promise<boolean> {
  for (const k of ctx.reader.children(indexId)) {
    if (k.kind === 'index') continue;
    const p = await ctx.reader.load(k.id);
    if (p && identityRoleOf(ctx.rules, factText(p, ctx.referenceTypeRow)) !== null) return true;
  }
  return false;
}

export async function roleOf(ctx: OwnerContext, p: LoadedPage): Promise<PageRole> {
  const t = characterType(ctx.rules);
  const owners = ctx.rules.owners;
  if (p.page.kind === 'index') return { role: 'index', template: 'index', warnMissing: [], setIndex: null };
  const rt = factText(p, ctx.referenceTypeRow);
  const parent = p.page.parentId ? ctx.reader.page(p.page.parentId) : null;
  const inSet =
    parent && parent.kind === 'index' && (await isCharacterIndex(ctx, parent.id)) ? parent.id : null;
  if (t) {
    const byType =
      rt === null
        ? null
        : t.roles.find((r) => r.referenceType !== null && textKey(r.referenceType) === textKey(rt));
    if (byType)
      return {
        role: byType.role,
        template: byType.template,
        warnMissing: byType.warnMissing,
        setIndex: byType.role === 'core' || byType.role === 'compact' ? inSet : inSet,
      };
    if (inSet) {
      const spec = t.roles.find((r) => r.role === 'specialist');
      if (spec)
        return {
          role: 'specialist',
          template: spec.template,
          warnMissing: spec.warnMissing,
          setIndex: inSet,
        };
    }
  }
  return {
    role: 'owner',
    template: 'general',
    warnMissing: owners?.text.warnMissing ?? ['Source Boundaries', 'Unresolved Material'],
    setIndex: null,
  };
}

// ============================================================================================ the checks

/** The body checks: Purpose first, a repeated title or metadata header, links in headings, pasted Markdown, blank
 * paragraphs and dashes. */
function bodyChecks(ctx: OwnerContext, p: LoadedPage, role: PageRole, out: Draft[]): void {
  const t = characterType(ctx.rules);
  const firstHeading = t?.text.firstHeading ?? ctx.rules.owners?.text.firstHeading ?? 'Purpose';
  const body = p.body;
  if (!body) return;
  const blocks = body.blocks;
  const doc = body.documentId;
  const nonBlank = blocks.filter((b) => !isBlankParagraph(b));
  const subject = cleanPrefixes(p.page.rawName).name.split(' - ')[0]!.trim();
  const titles = [p.page.displayName, p.page.rawName, subject, factText(p, 'Canonical Display Name') ?? '']
    .map((x) => x.trim())
    .filter((x) => x !== '');
  const isPurpose = (b: Obj | undefined) =>
    !!b && b.kind === 'heading' && textKey(blockText(b)) === textKey(firstHeading);
  const isTitle = (b: Obj) =>
    (b.kind === 'heading' || b.kind === 'paragraph') &&
    titles.some((x) => textKey(x) === textKey(blockText(b)));
  const repeated: { id: string | null; text: string; what: string }[] = [];
  let i = 0;
  while (i < nonBlank.length && i < 3 && !isPurpose(nonBlank[i])) {
    const b = nonBlank[i]!;
    if (isTitle(b))
      repeated.push({ id: (b.id as string) ?? null, text: short(deepText(b)), what: 'the page title' });
    else if (looksLikeMetadata([b as LkBlock]))
      repeated.push({ id: (b.id as string) ?? null, text: short(deepText(b)), what: 'a metadata header' });
    else break;
    i++;
  }
  if (repeated.length > 0)
    out.push({
      check: 'title_repeated',
      pageId: p.page.id,
      documentId: doc,
      blockId: repeated[0]!.id,
      message: `The top of the body repeats ${repeated.map((r) => `${r.what} (“${r.text}”)`).join(' and ')}; LegendKeeper shows the name, and facts belong in the sidebar.`,
      details: { blocks: repeated },
    });
  const first = nonBlank[i];
  if (!isPurpose(first))
    out.push({
      check: 'purpose_first',
      pageId: p.page.id,
      documentId: doc,
      blockId: first ? ((first.id as string) ?? null) : null,
      message: first
        ? `The body${repeated.length > 0 ? ', after the repeated header,' : ''} begins with “${short(deepText(first), 80)}”, not a “${firstHeading}” heading.`
        : `The body is empty: it should begin with a “${firstHeading}” heading.`,
      details: {
        expected: `a heading “${firstHeading}”`,
        found: first ? { kind: first.kind, text: short(deepText(first), 200) } : null,
      },
    });

  // Links inside headings.
  const linked = blocks.flatMap((b) => {
    const l = headingLinks(b);
    return l.length > 0 ? [{ id: (b.id as string) ?? null, heading: short(blockText(b)), links: l }] : [];
  });
  if (linked.length > 0)
    out.push({
      check: 'heading_links',
      pageId: p.page.id,
      documentId: doc,
      blockId: linked[0]!.id,
      message: `${linked.length} heading${linked.length === 1 ? ' holds' : 's hold'} a link (${linked
        .slice(0, 3)
        .map((h) => `“${h.heading}”`)
        .join(', ')}); a heading's text stays, its link goes.`,
      details: { headings: linked },
      fixArgs: { documentId: doc, blocks: linked.map((h) => h.id) },
    });

  // Pasted Markdown.
  const pasted: { id: string | null; found: string[]; text: string }[] = [];
  for (const { b, top } of walk(blocks)) {
    const f = literalMarkdown(b, top);
    if (f.length > 0) pasted.push({ id: (b.id as string) ?? null, found: f, text: short(ownText(b)) });
  }
  if (pasted.length > 0)
    out.push({
      check: 'literal_markdown',
      pageId: p.page.id,
      documentId: doc,
      blockId: pasted[0]!.id,
      message: `${pasted.length} block${pasted.length === 1 ? ' holds' : 's hold'} Markdown pasted as text (${[
        ...new Set(pasted.flatMap((x) => x.found)),
      ].join(', ')}).`,
      details: { blocks: pasted.slice(0, 20), total: pasted.length },
    });

  // Decorative blank paragraphs (top level; a page made only of them is left alone: its Purpose finding says enough).
  const blanks = blocks.filter((b) => isBlankParagraph(b)).map((b) => (b.id as string) ?? null);
  if (blanks.length > 0 && nonBlank.length > 0)
    out.push({
      check: 'blank_paragraphs',
      pageId: p.page.id,
      documentId: doc,
      blockId: blanks[0] ?? null,
      message: `${blanks.length} decorative blank paragraph${blanks.length === 1 ? '' : 's'} in the body.`,
      details: { blocks: blanks },
      fixArgs: { documentId: doc, blocks: blanks },
    });

  // Dashes in headings and prose.
  const dashed = dashBlocks(blocks);
  if (dashed.length > 0)
    out.push({
      check: 'em_dash_text',
      pageId: p.page.id,
      documentId: doc,
      blockId: dashed[0]!.id,
      message: `${dashed.length} block${dashed.length === 1 ? '' : 's'} of the body hold${dashed.length === 1 ? 's' : ''} an em dash (or an en dash used as a separator): ${dashed
        .slice(0, 3)
        .map((d) => `“${short(d.text, 60)}”`)
        .join(', ')}.`,
      details: {
        blocks: dashed.slice(0, 30).map((d) => ({ ...d, text: short(d.text, 200) })),
        total: dashed.length,
      },
      fixArgs: { documentId: doc, blocks: dashed.map((d) => d.id) },
    });
  void role;
}

/** The template's fields: none missing, none improvised. */
async function sidebarChecks(
  ctx: OwnerContext,
  p: LoadedPage,
  role: PageRole,
  audit: readonly AuditFinding[],
  out: Draft[],
): Promise<void> {
  if (!p.sidebar) return;
  const tpl = await ctx.templateFor(role.template, p.page.id);
  if (tpl === null) return;
  if ('unavailable' in tpl) {
    out.push({
      check: 'template_unavailable',
      pageId: p.page.id,
      key: role.template,
      message: `The page’s template (${role.template}) could not be compared: ${tpl.unavailable}`,
      details: { template: role.template, reason: tpl.unavailable },
    });
    return;
  }
  const rows = (p.sidebar.properties.find(
    (x) => x.kind === 'keyValue' && textKey(x.title ?? '') === textKey(ctx.propertiesName),
  )?.rows ?? []) as readonly { key: string }[];
  const have = new Set(rows.map((r) => textKey(r.key)));
  const want = new Set(tpl.keys.map(textKey));
  // The audit's own findings for missing rows are gathered (reused), so only the rest are reported here.
  const byAudit = new Set(
    audit
      .filter((f) => f.code === 'property_row_missing')
      .map((f) => textKey(asText((f.evidence as { expected?: unknown }).expected))),
  );
  const missing = tpl.keys.filter((k) => !have.has(textKey(k)) && !byAudit.has(textKey(k)));
  const extra = rows.map((r) => r.key).filter((k) => k.trim() !== '' && !want.has(textKey(k)));
  if (missing.length > 0 && !audit.some((f) => f.code === 'property_missing'))
    out.push({
      check: 'template_field_missing',
      pageId: p.page.id,
      key: missing.map(textKey).join('|'),
      message: `The sidebar lacks ${missing.length === 1 ? 'a field' : `${missing.length} fields`} its template (“${tpl.name}”) has: ${missing.join(', ')}.`,
      details: { template: { id: tpl.id, name: tpl.name }, missing },
    });
  if (extra.length > 0)
    out.push({
      check: 'field_improvised',
      pageId: p.page.id,
      key: extra.map(textKey).join('|'),
      message: `The sidebar has ${extra.length === 1 ? 'a field' : `${extra.length} fields`} its template (“${tpl.name}”) does not: ${extra.join(', ')}.`,
      details: { template: { id: tpl.id, name: tpl.name }, improvised: extra },
    });
  // The character completion gate: Core and Compact only.
  const t = characterType(ctx.rules);
  if (t && (role.role === 'core' || role.role === 'compact')) {
    const gated = t.identity.filter((f) => f.gated).map((f) => f.key);
    const failing: { field: string; found: string | null; why: string }[] = [];
    for (const key of gated) {
      const v = factText(p, key);
      if (v === null) failing.push({ field: key, found: null, why: 'no such row' });
      else if (v.trim() === '') failing.push({ field: key, found: v, why: 'blank' });
      else if (textKey(v) !== textKey(t.unestablished) && isPlaceholder(v, t.placeholders))
        failing.push({ field: key, found: v, why: 'an untouched placeholder' });
    }
    if (failing.length > 0)
      out.push({
        check: 'completion_gate',
        pageId: p.page.id,
        message: `The character completion gate is not met: ${failing.map((f) => `${f.field} (${f.why})`).join(', ')}. “${t.unestablished}” is accepted; nothing else may be guessed.`,
        details: { fields: failing, accepted: t.unestablished },
      });
  }
}

/** Source Boundaries and Unresolved Material, where the page's role asks for them (polish). */
function boundaryChecks(p: LoadedPage, role: PageRole, out: Draft[]): void {
  if (!p.body || role.warnMissing.length === 0) return;
  const headings = new Set(
    sectionsOf(p.body.blocks as unknown as LkBlock[])
      .filter((s) => s.heading)
      .map((s) => textKey(s.title)),
  );
  const missing = role.warnMissing.filter((h) => !headings.has(textKey(h)));
  if (missing.length > 0)
    out.push({
      check: 'boundaries_missing',
      pageId: p.page.id,
      documentId: p.body.documentId,
      key: missing.map(textKey).join('|'),
      message: `No ${missing.map((m) => `“${m}”`).join(' or ')} section (Source Formatting: where applicable, so a judgement, never a defect).`,
      details: { missing },
    });
}

/** Dependencies and Related Sources: their targets' lifecycle, an empty Related Sources, a missing link back. */
async function linkChecks(ctx: OwnerContext, p: LoadedPage, role: PageRole, out: Draft[]): Promise<void> {
  const deps = ctx.rules.sidebar.dependencies;
  const related = ctx.rules.sidebar.related;
  const coll = (title: string) => p.collections.find((c) => textKey(c.title) === textKey(title));
  const noncurrent = (id: string) => {
    const t = ctx.reader.page(id);
    return t && (t.kind === 'bwrk' || t.kind === 'barc') ? t : null;
  };
  const d = coll(deps);
  for (const item of d?.items ?? []) {
    const t = noncurrent(item.resourceId);
    if (t)
      out.push({
        check: 'dependency_noncurrent',
        pageId: p.page.id,
        key: t.id,
        message: `A Dependency on ${t.kind === 'bwrk' ? 'a Working' : 'an Archived'} page: “${t.rawName}”. Dependencies name current Authoritative owners only.`,
        details: { property: d!.title, target: { id: t.id, name: t.rawName, kind: t.kind } },
      });
  }
  const r = coll(related);
  if (p.page.kind === 'bsrc')
    for (const item of r?.items ?? []) {
      const t = noncurrent(item.resourceId);
      if (t)
        out.push({
          check: 'related_noncurrent',
          pageId: p.page.id,
          key: t.id,
          message: `An Authoritative page lists ${t.kind === 'bwrk' ? 'a Working' : 'an Archived'} page in its Related Sources: “${t.rawName}”.`,
          details: {
            property: r!.title,
            propertyId: r!.id,
            target: { id: t.id, name: t.rawName, kind: t.kind },
          },
          fixArgs: { propertyTitle: r!.title, propertyId: r!.id, targetId: t.id, targetName: t.rawName },
        });
    }
  if (r && r.items.length === 0 && !r.filtered && p.page.kind !== 'index')
    out.push({
      check: 'related_empty',
      pageId: p.page.id,
      message:
        'Related Sources is empty. That is acceptable after an actual review: review whether any page relates to this one.',
      details: { property: r.title },
    });
  // Close specialist owners: the pages of one character's set link to each other both ways.
  if (role.setIndex && p.page.kind !== 'index') {
    const mine = new Set((r?.items ?? []).map((x) => x.resourceId));
    for (const sib of ctx.reader.children(role.setIndex)) {
      if (sib.id === p.page.id || sib.kind === 'index') continue;
      const other = await ctx.reader.load(sib.id);
      const theirs = other?.collections.find((c) => textKey(c.title) === textKey(related));
      if (theirs?.items.some((x) => x.resourceId === p.page.id) && !mine.has(sib.id))
        out.push({
          check: 'related_not_reciprocal',
          pageId: p.page.id,
          key: sib.id,
          message: `“${sib.rawName}” lists this page in its Related Sources, but this page does not list it back.`,
          details: { from: { id: sib.id, name: sib.rawName }, property: related },
        });
    }
  }
}

/** An index's scope statement, "why open" text and Subpages collection. */
function indexChecks(ctx: OwnerContext, p: LoadedPage, out: Draft[]): void {
  if (p.page.kind !== 'index' || ctx.lifecycleIndexIds.has(p.page.id)) return;
  const t = characterType(ctx.rules);
  const firstHeading = t?.text.firstHeading ?? 'Purpose';
  const lacking: string[] = [];
  const scope = factText(p, ctx.indexScopeRow);
  if (scope === null || scope.trim() === '' || isPlaceholder(scope, t?.placeholders ?? []))
    lacking.push(`a scope statement (${ctx.indexScopeRow})`);
  const blocks = (p.body?.blocks ?? []) as unknown as LkBlock[];
  const purpose = sectionsOf(blocks).find((s) => s.heading && textKey(s.title) === textKey(firstHeading));
  const why = (purpose?.blocks ?? []).some((b) => {
    const text = deepText(b).trim();
    return text !== '' && !/^\s*(?:\[.*\]|<.*>|\{.*\}|tbd|tbc|todo|\.\.\.|…)\s*$/i.test(text);
  });
  if (!why) lacking.push(`“why open” text (the ${firstHeading} section)`);
  let collection = false;
  for (const { b } of walk(p.body?.blocks ?? [])) if (b.kind === 'resourceCollection') collection = true;
  if (!collection) lacking.push('a Subpages collection');
  if (lacking.length > 0)
    out.push({
      check: 'index_incomplete',
      pageId: p.page.id,
      key: lacking.join('|'),
      message: `The index lacks ${lacking.join(', ')}.`,
      details: { lacking },
    });
}

/**
 * The architectural candidates: a Core holding a large specialist block (A2's own pointer), and, v3 F3e (ADR 0059), the
 * split appraisal's (A6) measurable Split Triggers on any content page, each with its evidence, the draft destination
 * map and the Anti-Fragmentation note. Without the pack's split rules (an approved version from before F3e), A2's own
 * scope-overload pointer stands in.
 */
function architectureChecks(ctx: OwnerContext, p: LoadedPage, role: PageRole, out: Draft[]): void {
  const t = characterType(ctx.rules);
  const identity = role.role === 'core' || role.role === 'compact';
  if (t && p.body && identity) {
    const o = t.text.overload;
    for (const s of sectionsOf(p.body.blocks as unknown as LkBlock[]).filter((x) => x.heading)) {
      const title = textKey(s.title);
      const d = Object.entries(o.domains).find(([, words]) => words.some((w) => title.includes(textKey(w))));
      if (!d) continue;
      const chars = s.blocks.reduce((n, b) => n + deepText(b as unknown as Obj).length, 0);
      if (o.roles.includes(role.role) && chars >= o.minChars)
        out.push({
          check: 'core_holds_specialist',
          pageId: p.page.id,
          key: textKey(s.title),
          message: `The Core holds a large ${d[0].toLowerCase()} block (“${s.title}”, ${chars} characters): a candidate for a specialist page. A pointer only: the split appraisal (A6, arkona_split_appraisal) gives the evidence and a draft destination map, and the owner decides.`,
          details: { domain: d[0], section: s.title, chars },
        });
    }
  }
  if (!p.body || p.page.kind === 'index') return;
  const a6 = ctx.split?.(p, role);
  if (a6) {
    for (const c of a6.candidates)
      out.push({
        check: c.check,
        pageId: p.page.id,
        ...(c.key ? { key: c.key } : {}),
        message: c.message,
        // Compact here (A2 reports many pages at once, and answers inline up to about 40,000 characters): the trigger and
        // its evidence. The draft destination map, the Anti-Fragmentation note and the owner's questions are the split
        // appraisal's own report (arkona_split_appraisal, or "Split appraisal (A6)" on the Appraisal page).
        details: {
          trigger: c.trigger,
          evidence: c.evidence,
          splitAppraisal:
            'arkona_split_appraisal gives the draft destination map, the Anti-Fragmentation note and the owner’s questions',
        },
      });
    return;
  }
  // No split rules in the approved pack: A2's own pointer (ADR 0054), for a Core or a Compact Reference only.
  if (!t || !identity) return;
  const domains = new Map<string, string[]>();
  for (const s of sectionsOf(p.body.blocks as unknown as LkBlock[]).filter((x) => x.heading)) {
    const title = textKey(s.title);
    const d = Object.entries(t.text.overload.domains).find(([, words]) =>
      words.some((w) => title.includes(textKey(w))),
    );
    if (d) domains.set(d[0], [...(domains.get(d[0]) ?? []), s.title]);
  }
  if (domains.size >= 3)
    out.push({
      check: 'scope_overload',
      pageId: p.page.id,
      message: `The page covers ${domains.size} specialist domains (${[...domains.keys()].join(', ')}): a candidate for splitting. A pointer only: the split appraisal (A6) needs the pack version with its split rules approved.`,
      details: { domains: Object.fromEntries(domains) },
    });
}

// ============================================================================================ the audits, gathered

/** How a gathered audit finding is grouped: its category's check, its severity's group. */
function auditDraft(p: LoadedPage, f: AuditFinding): Draft {
  const source: FindingSource = {
    kind: 'audit',
    auditFindingId: f.id,
    auditCode: f.code,
    takenAt: f.source.takenAt,
    ageMs: f.source.ageMs,
    ...('snapshotId' in f.source ? { snapshotId: f.source.snapshotId } : {}),
  };
  // Design section F: sibling order and the tags hand over to the audits' own fixes (by the fix's kind, so F3d's
  // lifecycle-tag order, a `lifecycle` finding whose fix only reorders tags, is handed over too); any other audit
  // finding's fix stays the owner's, on the Audits page.
  const tagOrOrder =
    f.category === 'ordering' || f.category === 'tags' || HANDOVER_FIXES.has(f.fix?.kind ?? '');
  const auditFix = f.fix && tagOrOrder ? { findingId: f.id, summary: f.fix.summary } : undefined;
  const base = {
    pageId: p.page.id,
    key: `audit:${f.id}`,
    documentId: f.documentId,
    blockId: f.blockId,
    message: f.message,
    details: {
      audit: { id: f.id, code: f.code, category: f.category, severity: f.severity },
      evidence: f.evidence,
    },
    source,
    ...(auditFix ? { auditFix } : {}),
  };
  if (f.category === 'ordering') return { ...base, check: 'sibling_order' };
  if (f.category === 'tags' || (f.category === 'lifecycle' && auditFix))
    return { ...base, check: 'tag_grammar' };
  if (f.category === 'template')
    return {
      ...base,
      check: 'template_field_missing',
      group: f.severity === 'info' && f.code !== 'property_row_missing' ? 'polish' : 'required',
    };
  const judgement =
    f.category === 'lifecycle'
      ? {
          tool: 'archive_page / unarchive_page / move_to_working / promote_page',
          decide:
            'which signal is right is the owner’s to decide; never edit a prefix, Status or status tag to make it go away',
        }
      : f.category === 'facts'
        ? { tool: 'set_facts', decide: 'the right value (the finding names it only when it is unambiguous)' }
        : f.category === 'references'
          ? { tool: 'set_facts or write_page', decide: 'what the link should point at, or whether it goes' }
          : f.category === 'keep_regions'
            ? {
                tool: 'write_page',
                decide: f.fix
                  ? 'the Audits page offers its own “Propose a fix” for this one (the owner’s)'
                  : 'whether the block needs changing',
              }
            : f.category === 'chronology'
              ? { tool: 'sync_timeline_event', decide: 'what the chronology check’s evidence calls for' }
              : { tool: 'audit_findings', decide: 'what the finding’s evidence calls for' };
  return {
    ...base,
    check: 'audit_finding',
    group: f.severity === 'info' ? 'polish' : 'required',
    evidence:
      f.code === 'inaccessible_target'
        ? 'Inaccessible'
        : f.severity === 'info'
          ? 'Potential Maintenance Issue'
          : 'Confirmed deterministic defect',
    rule: { page: 'LK-Bridge audits', section: f.category, rule: f.code },
    judgement,
  };
}

/**
 * The audits' fixes A2 hands over (design section F): sibling order (`move_resource`), the missing required tags
 * (`add_tags`) and the lifecycle tag put first (`reorder_tags`, F3d's, ADR 0053).
 */
const HANDOVER_FIXES: ReadonlySet<string> = new Set(['move_resource', 'add_tags', 'reorder_tags']);

/** Audit categories that are about the audit's own configuration or run, not the page: not gathered. */
const NOT_PAGE_CATEGORIES = new Set(['rules', 'audit']);
/**
 * Audit notices about what the bridge's own tools can write back (a collection or an unsupported block is a keep region,
 * an inline icon cannot be written whole): about the tooling, not the page's quality, so not gathered.
 */
const NOT_PAGE_CODES = new Set(['collection_blocks', 'unsupported_blocks', 'inline_icon_page']);

// ============================================================================================ one page

/** Every check on one page (its pieces loaded from the overlay, or read live by the caller first). */
export async function appraisePage(ctx: OwnerContext, pageId: string): Promise<Draft[]> {
  const out: Draft[] = [];
  const p = await ctx.reader.load(pageId);
  if (!p)
    return [
      {
        check: 'not_in_snapshots',
        pageId,
        message:
          'The page is not in the snapshots yet (made in the LegendKeeper app since the last full snapshot?).',
        details: {},
      },
    ];
  if (p.page.kind === 'root') return out;
  // A missing image is A5's (visual hygiene) to report; what the body and sidebar checks need is reported here.
  for (const piece of p.unreadable.filter((x) => !x.startsWith('image')))
    out.push({
      check: 'page_unreadable',
      pageId,
      key: piece,
      message: `The page’s ${piece} could not be read from the snapshot store (missing or damaged), so what depends on it was not checked.`,
      details: { piece },
    });
  const audit = ctx
    .auditFindings(pageId)
    .filter((f) => !NOT_PAGE_CATEGORIES.has(f.category) && !NOT_PAGE_CODES.has(f.code));
  const role = await roleOf(ctx, p);
  if (hasForbiddenDash(p.page.displayName))
    out.push({
      check: 'em_dash_name',
      pageId,
      message: `The page name holds an em dash (or an en dash used as a separator): “${p.page.rawName}”.`,
      details: { name: p.page.rawName },
      fixArgs: { name: p.page.rawName },
    });
  if (!p.body && p.page.kind !== 'index')
    out.push({
      check: 'no_body',
      pageId,
      message: 'The page has no page document (or it could not be read), so its body was not appraised.',
      details: { documents: p.page.documents.map((d) => ({ id: d.id, type: d.type, name: d.name })) },
    });
  // v3 F3.5 (ADR 0056): a legacy body waits for the block-id sweep (optional polish, nothing to do but wait).
  if (p.body && isLegacy(p.body.blocks)) {
    const lp = legacyProblems(p.body.blocks);
    out.push({
      check: 'block_ids_pending',
      pageId,
      documentId: p.body.documentId,
      message:
        'The page is a legacy page (' +
        [
          lp.missing > 0 ? `${lp.missing} ${lp.missing === 1 ? 'block has' : 'blocks have'} no id` : null,
          lp.duplicates.length > 0
            ? `${lp.duplicates.length} block ${lp.duplicates.length === 1 ? 'id is' : 'ids are'} used twice`
            : null,
        ]
          .filter((x) => x !== null)
          .join(', ') +
        '), so block-by-block writes, Revert and the appraisal’s fixes cannot work on it yet: waiting for the block-id sweep.',
      details: { blocks: lp.blocks, missing: lp.missing, duplicates: lp.duplicates.slice(0, 20) },
    });
  }
  bodyChecks(ctx, p, role, out);
  await sidebarChecks(ctx, p, role, audit, out);
  boundaryChecks(p, role, out);
  await linkChecks(ctx, p, role, out);
  indexChecks(ctx, p, out);
  architectureChecks(ctx, p, role, out);
  // The page's open audit findings, gathered (the audits are reused, never re-checked here). An audit finding about an
  // Archived target that one of this page's own link findings already names is that finding's, not a second one.
  const linked = new Set(
    out
      .filter((d) => d.check === 'related_noncurrent' || d.check === 'dependency_noncurrent')
      .map((d) => d.key ?? ''),
  );
  for (const f of audit) {
    if (f.code === 'canon_refers_to_archived') {
      const target = asText((f.evidence as { target?: { id?: unknown } }).target?.id);
      if (linked.has(target)) continue;
    }
    out.push(auditDraft(p, f));
  }
  return out;
}
