/**
 * `arkona_change_impact` (v3 F3c, ADR 0054; the design's A3): what depends on a page, for a page as it is, a planned
 * rename (`renameTo`), or a pending proposal's targets. Read-only, from the overlay's reference table (every mention and
 * collection item the snapshots hold), the chronology's tables and the full-text index; never LegendKeeper (unless
 * `live: true` re-reads the subject).
 *
 * Two groups:
 * - **proven breakage**: Dependencies, or an Authoritative page's Related Sources, pointing at a page that is (or will
 *   be) deleted, archived or Working; mentions whose target is (or will be) gone; for a rename, mentions and chronology
 *   rows whose displayed text will no longer match;
 * - **review candidates**: every other incoming Dependency, Related Sources link and mention; chronology rows naming the
 *   subject; and **textual restatements**: other pages' text naming the subject (its name and aliases, through the
 *   full-text index) without linking to it. Repository Automation: "a resource change is not proof every document
 *   changed substantively", so a restatement is only ever a candidate.
 */
import type { Db } from '../db/open.js';
import { textKey } from '../packs/engine/text.js';
import { aliasName } from '../packs/naming/namesakes.js';
import { cleanPrefixes } from '../registry/names.js';
import { classifyName } from '../tree/classify.js';
import type { FullText, Term } from './fts.js';
import type { Draft } from './owner.js';
import type { PageReader } from './reader.js';

type Obj = Record<string, unknown>;

/** What happens to a page: as it is, renamed, deleted, or moved into the Working or Archived state. */
export interface PlannedEffect {
  readonly pageId: string;
  readonly renameTo?: string;
  readonly deleted?: boolean;
  readonly becomes?: 'Working' | 'Archived' | 'Authoritative';
  /** Why (a proposal's operation), for the report. */
  readonly because?: string;
}

export interface ImpactContext {
  readonly db: Db;
  readonly projectId: string;
  readonly reader: PageReader;
  readonly fullText: FullText;
  readonly dependenciesTitle: string;
  readonly relatedTitle: string;
  /** The chronology's table documents (rows naming the subject are chronology rows). */
  readonly chronologyDocuments: ReadonlySet<string>;
  /** The page's name as it is now (a live read may say), else the overlay's. */
  readonly currentName?: string;
  readonly currentAliases?: readonly string[];
  /** The most restatement candidates (each a page's best units). */
  readonly maxRestatements?: number;
}

interface RefRow {
  readonly from_page: string;
  readonly from_document: string | null;
  readonly from_block: string | null;
  readonly section: string | null;
  readonly via: 'mention' | 'collection';
  readonly property: string | null;
  readonly row_key: string | null;
  readonly to_document: string | null;
  readonly label: string | null;
  readonly context: string | null;
}

const short = (s: string | null, n = 240) => {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The names a page goes by: its display name, the subject part, its aliases and its Canonical Display Name. */
export async function namesOf(
  reader: PageReader,
  pageId: string,
  o: { readonly name?: string; readonly aliases?: readonly string[] } = {},
): Promise<{ display: string; subject: string; aliases: string[] }> {
  const page = reader.page(pageId);
  const raw = o.name ?? page?.rawName ?? '';
  const display = classifyName(raw).displayName;
  const subject = cleanPrefixes(raw).name.split(' - ')[0]!.trim() || display;
  const loaded = await reader.load(pageId);
  const aliases = new Set<string>();
  const res = loaded?.resource as Obj | null | undefined;
  for (const a of o.aliases ?? (Array.isArray(res?.aliases) ? (res.aliases as unknown[]) : []))
    if (typeof a === 'string' && aliasName(a) !== '') aliases.add(aliasName(a));
  const cdn = loaded?.sidebar?.facts.get('canonical display name')?.text;
  if (cdn && cdn.trim() !== '' && textKey(cdn) !== textKey(subject)) aliases.add(cdn.trim());
  return { display, subject, aliases: [...aliases].filter((a) => textKey(a) !== textKey(subject)) };
}

/** One subject's impact (for a page, a rename, or one page a proposal changes). */
export async function impactOf(ctx: ImpactContext, effect: PlannedEffect): Promise<Draft[]> {
  const out: Draft[] = [];
  const subject = ctx.reader.page(effect.pageId);
  const names = await namesOf(ctx.reader, effect.pageId, {
    ...(ctx.currentName ? { name: ctx.currentName } : {}),
    ...(ctx.currentAliases ? { aliases: ctx.currentAliases } : {}),
  });
  const kindNow = subject?.kind ?? null;
  const goneOrNoncurrent: string | null = effect.deleted
    ? 'deleted'
    : effect.becomes === 'Archived'
      ? 'archived'
      : effect.becomes === 'Working'
        ? 'Working'
        : effect.becomes === 'Authoritative'
          ? null
          : !subject
            ? 'deleted'
            : kindNow === 'barc'
              ? 'archived'
              : kindNow === 'bwrk'
                ? 'Working'
                : null;
  const willBe = effect.deleted || effect.becomes ? 'will be' : 'is';
  const gone = effect.deleted === true || !subject;
  const rename =
    effect.renameTo !== undefined && textKey(effect.renameTo) !== textKey(names.display)
      ? cleanPrefixes(effect.renameTo).name.trim()
      : null;
  const oldNames = new Set([textKey(names.display), textKey(names.subject), textKey(subject?.rawName ?? '')]);
  const because = effect.because ? ` (${effect.because})` : '';
  const pageName = (id: string) => ctx.reader.page(id)?.rawName ?? id;

  const rows = ctx.db
    .prepare(
      `SELECT from_page, from_document, from_block, section, via, property, row_key, to_document, label, context
       FROM appraisal_refs WHERE project_id = ? AND to_page = ? AND from_page <> ? ORDER BY from_page, section`,
    )
    .all(ctx.projectId, effect.pageId, effect.pageId) as RefRow[];
  const mentionedIn = new Set<string>();
  for (const r of rows) {
    const from = ctx.reader.page(r.from_page);
    const where = {
      document: r.from_document,
      block: r.from_block,
      section: r.section,
      snippet: short(r.context),
    };
    const isDeps =
      r.via === 'collection' &&
      r.from_document === null &&
      textKey(r.property ?? '') === textKey(ctx.dependenciesTitle);
    const isRelated =
      r.via === 'collection' &&
      r.from_document === null &&
      textKey(r.property ?? '') === textKey(ctx.relatedTitle);
    if (r.via === 'collection') {
      const proven = goneOrNoncurrent !== null && (isDeps || (isRelated && from?.kind === 'bsrc'));
      out.push({
        check: proven ? 'link_to_noncurrent' : 'incoming_link',
        pageId: r.from_page,
        key: `${effect.pageId}:${r.property ?? r.from_block ?? ''}`,
        documentId: r.from_document,
        blockId: r.from_block,
        message: proven
          ? `“${pageName(r.from_page)}” lists “${names.display}” in its ${r.property}, and “${names.display}” ${willBe} ${goneOrNoncurrent}${because}.`
          : `“${pageName(r.from_page)}” lists “${names.display}” in ${r.property ? `its ${r.property}` : 'a collection'}.`,
        details: { subject: { id: effect.pageId, name: names.display }, property: r.property, ...where },
      });
      continue;
    }
    // X5: one block id can be in two documents of a page: a block is its document's.
    mentionedIn.add(`${r.from_page}:${r.from_document ?? ''}:${r.from_block ?? ''}`);
    const label = (r.label ?? '').trim();
    const chronology = r.from_document !== null && ctx.chronologyDocuments.has(r.from_document);
    const labelMatches = label !== '' && oldNames.has(textKey(label));
    if (gone) {
      out.push({
        check: 'mention_target_gone',
        pageId: r.from_page,
        key: `${effect.pageId}:${r.from_document ?? ''}:${r.from_block ?? ''}`,
        documentId: r.from_document,
        blockId: r.from_block,
        message: `“${pageName(r.from_page)}” mentions “${label || names.display}”, which ${effect.deleted ? 'will be deleted' : 'is gone'}${because}.`,
        details: { subject: { id: effect.pageId, name: names.display }, label, ...where },
      });
    } else if (rename && labelMatches) {
      out.push({
        check: chronology ? 'chronology_row_mismatch' : 'mention_label_mismatch',
        pageId: r.from_page,
        key: `${effect.pageId}:${r.from_document ?? ''}:${r.from_block ?? ''}`,
        documentId: r.from_document,
        blockId: r.from_block,
        message: `“${pageName(r.from_page)}” shows “${label}”; after the rename to “${rename}” that text no longer matches the page${because}.`,
        details: { subject: { id: effect.pageId, name: names.display }, label, renameTo: rename, ...where },
      });
    } else {
      out.push({
        check: chronology ? 'chronology_row' : 'incoming_mention',
        pageId: r.from_page,
        key: `${effect.pageId}:${r.from_document ?? ''}:${r.from_block ?? ''}`,
        documentId: r.from_document,
        blockId: r.from_block,
        message: `“${pageName(r.from_page)}” mentions “${label || names.display}”${r.section ? ` (${r.section})` : ''}.`,
        details: { subject: { id: effect.pageId, name: names.display }, label, ...where },
      });
    }
  }

  // The chronology's rows naming the subject in plain text (no mention), and every other page's text naming it.
  const terms: Term[] = [names.subject, names.display, ...names.aliases]
    .filter((v, i, a) => v.trim() !== '' && a.findIndex((x) => textKey(x) === textKey(v)) === i)
    .map((value) => ({ value, phrase: true }));
  const hits = ctx.fullText.search(ctx.projectId, terms, {
    limit: Math.max(50, (ctx.maxRestatements ?? 100) * 3),
    excludePage: effect.pageId,
  });
  const perPage = new Map<string, number>();
  for (const h of hits) {
    if (h.unit === 'name' || h.unit === 'alias') continue; // another page of the same name is not a restatement
    if (mentionedIn.has(`${h.pageId}:${h.documentId ?? ''}:${h.blockId ?? ''}`)) continue; // already listed as a mention
    const chronology = h.documentId !== null && ctx.chronologyDocuments.has(h.documentId);
    if (!chronology) {
      const n = perPage.get(h.pageId) ?? 0;
      if (n >= 3 || perPage.size >= (ctx.maxRestatements ?? 100)) continue;
      perPage.set(h.pageId, n + 1);
    }
    const where = { document: h.documentId, block: h.blockId, section: h.section, snippet: h.snippet };
    const proven = chronology && rename !== null;
    out.push({
      check: chronology ? (proven ? 'chronology_row_mismatch' : 'chronology_row') : 'restatement',
      pageId: h.pageId,
      key: `${effect.pageId}:text:${h.documentId ?? ''}:${h.blockId ?? h.field ?? ''}`,
      documentId: h.documentId,
      blockId: h.blockId,
      message: chronology
        ? proven
          ? `A chronology row names “${names.subject}” in its text; after the rename to “${rename}” it no longer matches${because}.`
          : `A chronology row names “${names.subject}”.`
        : `“${pageName(h.pageId)}” restates “${names.subject}”${h.unit === 'fact' && h.field ? ` in its sidebar fact “${h.field}”` : ` in its text${h.section ? ` (${h.section})` : ''}`}: a review candidate, never proof it changed.`,
      details: {
        subject: { id: effect.pageId, name: names.display },
        unit: h.unit,
        field: h.field,
        ...where,
      },
    });
  }
  return out;
}

/**
 * What a pending proposal does to each page it names: its operations read for deletes, renames (an `updateResource`
 * with a new name, its prefix saying the lifecycle state it moves into) and other changes.
 */
export function effectsOfProposal(
  ops: readonly { readonly op: string; readonly params: unknown }[],
): PlannedEffect[] {
  const by = new Map<
    string,
    { renameTo?: string; deleted?: boolean; becomes?: PlannedEffect['becomes']; ops: string[] }
  >();
  const at = (id: string) => {
    let e = by.get(id);
    if (!e) {
      e = { ops: [] };
      by.set(id, e);
    }
    return e;
  };
  for (const o of ops) {
    const p = (o.params ?? {}) as { path?: Record<string, unknown>; body?: Record<string, unknown> };
    const id = typeof p.path?.resourceId === 'string' ? p.path.resourceId : null;
    if (!id) continue;
    const e = at(id);
    e.ops.push(o.op);
    if (o.op === 'deleteResource') e.deleted = true;
    if (o.op === 'updateResource' && typeof p.body?.name === 'string') {
      const c = classifyName(p.body.name);
      if (c.kind === 'barc') e.becomes = 'Archived';
      else if (c.kind === 'bwrk') e.becomes = 'Working';
      else if (c.kind === 'bsrc') e.becomes = 'Authoritative';
      e.renameTo = c.displayName;
    }
  }
  return [...by.entries()].map(([pageId, e]) => ({
    pageId,
    ...(e.renameTo !== undefined ? { renameTo: e.renameTo } : {}),
    ...(e.deleted ? { deleted: true } : {}),
    ...(e.becomes ? { becomes: e.becomes } : {}),
    because: [...new Set(e.ops)].slice(0, 4).join(', '),
  }));
}
