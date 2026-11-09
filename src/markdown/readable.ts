/**
 * The readable rendering inside a keep region: what an agent sees of a block Markdown cannot express (an infobox, a
 * collection, a table with merged cells…). It is for reading only. On a write the region's block is restored exactly
 * from the current page, and changes to this text are ignored with a `KEEP_REGION_EDITED` warning.
 *
 * It never contains keep markers or headings (so outlines and sections only see real headings), except that a heading
 * kept as a region shows as a heading.
 */
import { escapeLineStart, escapeText, mentionUrl, protectEdges } from './inline.js';
import { isObj, mentionLabel, type Obj } from './model.js';
import type { LkBlock } from './types.js';

const MAX_LINES = 400;

function numText(v: unknown, fallback = '?'): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback;
}

function text(s: unknown): string {
  return typeof s === 'string' ? s.replace(/[\r\n]+/g, ' ') : '';
}

function line(s: string): string {
  return protectEdges(escapeLineStart(s));
}

/** Runs as readable inline Markdown: text (escaped), mentions as links, unknown runs (inline icons) as "(icon)". */
export function readableRuns(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  let out = '';
  for (const r of runs) {
    if (!isObj(r)) continue;
    if (typeof r.text === 'string') out += escapeText(text(r.text));
    else if (isObj(r.mention) && typeof r.mention.resourceId === 'string') {
      const m = r.mention;
      const url = /^[A-Za-z0-9_-]+$/.test(m.resourceId as string)
        ? mentionUrl(
            m.resourceId as string,
            typeof m.documentId === 'string' && /^[A-Za-z0-9_-]+$/.test(m.documentId)
              ? m.documentId
              : undefined,
          )
        : '';
      out += url ? `[${escapeText(text(mentionLabel(m)))}](${url})` : escapeText(text(mentionLabel(m)));
    } else if (r.break === true) out += '<br>';
    else out += '(icon)';
  }
  return out;
}

function kids(b: Obj): Obj[] {
  return Array.isArray(b.children) ? (b.children as unknown[]).filter(isObj) : [];
}

function plainOf(b: Obj): string {
  if (Array.isArray(b.content)) return readableRuns(b.content);
  return kids(b).map(plainOf).filter(Boolean).join(' ');
}

function link(res: unknown, doc: unknown): string {
  if (typeof res !== 'string' || !/^[A-Za-z0-9_-]+$/.test(res)) return '(a page)';
  const d = typeof doc === 'string' && /^[A-Za-z0-9_-]+$/.test(doc) ? doc : undefined;
  return `[${d ? 'document' : 'page'}](${mentionUrl(res, d)})`;
}

function rowsOfKeyValue(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(isObj).map((r) => {
    const value = Array.isArray(r.content) ? readableRuns(r.content) : escapeText(text(r.text));
    return `- **${escapeText(text(r.key)) || '(no key)'}:** ${value}`;
  });
}

function property(p: Obj): string[] {
  const title = escapeText(text(p.title)) || '(untitled)';
  switch (p.kind) {
    case 'keyValue':
      return [`- **${title}**`, ...rowsOfKeyValue(p.rows).map((l) => `  ${l}`)];
    case 'textField':
      return [`- **${title}:** ${kids(p).map(plainOf).filter(Boolean).join(' / ')}`];
    case 'image':
      return [`- **${title}:** image ${escapeText(text(p.url))}`];
    case 'resourceLink':
    case 'resourceCollection':
      return [
        `- **${title}:** ${
          Array.isArray(p.items)
            ? (p.items as unknown[])
                .filter(isObj)
                .map((i) => link(i.resourceId, i.documentId))
                .join(', ') || '(none)'
            : '(none)'
        }${isObj(p.filter) ? ' (filtered)' : ''}`,
      ];
    case 'meter':
      return [`- **${title}:** ${meterItems(p.items)}`];
    default:
      return [`- **${title}:** (${escapeText(text(p.kind))})`];
  }
}

function meterItems(items: unknown): string {
  if (!Array.isArray(items)) return '(none)';
  return (
    items
      .filter(isObj)
      .map((i) => `${escapeText(text(i.name))} ${numText(i.current)}/${numText(i.max)}`)
      .join(', ') || '(none)'
  );
}

function titleOf(b: Obj, fallback: string): string {
  const t = text(b.title);
  return escapeText(t !== '' ? t : fallback);
}

/** Readable lines for any block. */
export function readableLines(block: LkBlock): string[] {
  const out = readable(block, 0);
  if (out.length === 0) out.push('(empty)');
  return out.length > MAX_LINES
    ? [...out.slice(0, MAX_LINES), `(… ${out.length - MAX_LINES} more lines)`]
    : out;
}

function readable(b: Obj, depth: number): string[] {
  if (depth > 20) return ['(nested too deeply to show)'];
  switch (b.kind) {
    case 'paragraph':
      return [line(readableRuns(b.content)) || '(empty line)'];
    case 'heading': {
      const level = Number.isInteger(b.level) ? Math.min(6, Math.max(1, b.level as number)) : 2;
      return [`${'#'.repeat(level)} ${protectEdges(readableRuns(b.content))}`.trimEnd()];
    }
    case 'taskItem':
      return [`- [${b.checked === true ? 'x' : ' '}] ${readableRuns(b.content)}`];
    case 'code':
      // An indented code block: no fence that could swallow the region's closing marker.
      return (typeof b.text === 'string' ? b.text : '').split(/\r?\n|\r/).map((l) => `    ${l}`);
    case 'rule':
      return ['(horizontal rule)'];
    case 'image':
      return [
        `Image: ${escapeText(text(b.url))}${typeof b.alt === 'string' && b.alt ? ` (${escapeText(text(b.alt))})` : ''}`,
      ];
    case 'embed':
      return [`**${titleOf(b, 'Embed')}** (${escapeText(text(b.provider))}): ${escapeText(text(b.url))}`];
    case 'keyValue':
      return [`**${titleOf(b, 'Stats')}**`, '', ...rowsOfKeyValue(b.rows)];
    case 'infobox':
      return [
        '**Infobox**',
        '',
        ...(Array.isArray(b.rows) ? (b.rows as unknown[]).filter(isObj).flatMap(property) : []),
      ];
    case 'meter':
      return [`**${titleOf(b, 'Meter')}**: ${meterItems(b.items)}`];
    case 'resourceCollection':
    case 'resourceLink': {
      const items = Array.isArray(b.items) ? (b.items as unknown[]).filter(isObj) : [];
      return [
        `**${titleOf(b, b.kind === 'resourceLink' ? 'Links' : 'Collection')}**${isObj(b.filter) ? ' (filtered collection)' : ''}`,
        ...(items.length > 0 ? ['', ...items.map((i) => `- ${link(i.resourceId, i.documentId)}`)] : []),
      ];
    }
    case 'map':
      return [
        `**${titleOf(b, 'Map')}**: ${b.resourceId ? link(b.resourceId, b.documentId) : '(no map linked)'}`,
      ];
    case 'unsupported':
      return ['*(Content the LegendKeeper API cannot show. It is kept as it is.)*'];
    case 'table': {
      const rows = kids(b).filter((r) => r.kind === 'tableRow');
      return rows.map(
        (r, i) =>
          `${i + 1}. ${kids(r)
            .map((c) => readableCell(c, depth))
            .join(' | ')}`,
      );
    }
    default: {
      const children = kids(b);
      const head =
        b.kind === 'textField' || b.kind === 'expand'
          ? `**${titleOf(b, String(b.kind))}**`
          : `*(${escapeText(text(b.kind))})*`;
      if (children.length === 0) return [head];
      const body: string[] = [];
      for (const c of children) {
        if (body.length > 0) body.push('');
        body.push(...readable(c, depth + 1));
      }
      return [head, '', ...body];
    }
  }
}

function readableCell(c: Obj, depth: number): string {
  const parts = kids(c).flatMap((k) => readable(k, depth + 1));
  const span = [c.colspan, c.rowspan].some((v) => typeof v === 'number' && v > 1)
    ? ` (spans ${numText(c.colspan, '1')}×${numText(c.rowspan, '1')})`
    : '';
  return `${parts.join(' / ').replace(/\|/g, '\\|')}${span}`;
}
