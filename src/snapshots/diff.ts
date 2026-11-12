/**
 * Pieces as Markdown, and the diff between two states of one (v2 E1a, ADR 0042): `snapshot_diff`, the dashboard's
 * per-page history and every restore proposal show the same text. A page document is the converter's Markdown (keep
 * regions as one labelled placeholder line each, as write_page's proposals show them); a map, timeline or board is the
 * read tools' Markdown; a sidebar is its properties as `key: value` lines, link collections as lists of mentions,
 * `unsupported` properties as a placeholder line; the resource is its settings, one per line.
 */
import { renderBoard, renderMap, renderTimeline, toMarkdown, type DocumentInput } from '../markdown/index.js';
import { markdownDiff, unifiedText, withPlaceholders, type MarkdownDiff } from '../pages/diff.js';
import type { DocumentPiece, ResourcePiece, SidebarPiece } from './canonical.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function runsText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((r) => {
      if (!isObj(r)) return '';
      if (typeof r.text === 'string') return r.text;
      if (r.break === true) return '<br>';
      const m = r.mention;
      if (isObj(m)) {
        const label = str(m.text) || str(m.name) || str(m.resourceId);
        const doc = str(m.documentId);
        return `[${label}](lk://resources/${str(m.resourceId)}${doc ? `/docs/${doc}` : ''})`;
      }
      return '[inline content]';
    })
    .join('');
}

export function renderResource(piece: ResourcePiece | null): string {
  if (!piece) return '(no resource settings)';
  const lines = ['# Page settings', ''];
  for (const [k, v] of Object.entries(piece).sort(([a], [b]) => (a < b ? -1 : 1)))
    lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return lines.join('\n');
}

export function renderSidebar(piece: SidebarPiece | null): string {
  if (!piece) return '(no sidebar)';
  const lines = ['# Sidebar'];
  for (const p of piece.properties) {
    const title = str(p.title) || '(untitled)';
    lines.push('');
    if (p.kind === 'keyValue') {
      lines.push(`## ${title}`);
      for (const r of (p.rows as Obj[] | undefined) ?? [])
        lines.push(`- ${str(r.key)}: ${runsText(r.content)}`);
    } else if (p.kind === 'resourceCollection' || p.kind === 'resourceLink') {
      lines.push(`## ${title} (links)`);
      for (const i of (p.items as Obj[] | undefined) ?? [])
        lines.push(
          `- lk://resources/${str(i.resourceId)}${i.documentId ? `/docs/${str(i.documentId)}` : ''}`,
        );
      if (p.filter !== undefined && p.filter !== null) lines.push('- (and the pages its filter adds)');
    } else if (p.kind === 'unsupported') {
      lines.push(`## ${title} [unsupported: kept by id, not shown: ${str(p.id)}]`);
    } else {
      lines.push(`## ${title} (${str(p.kind)})`);
      lines.push(`- ${JSON.stringify(p).slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

function settingsLine(s: Obj): string {
  const parts = Object.entries(s)
    .filter(([k]) => k !== 'mapImage' && k !== 'rank')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return `<!-- document settings: ${parts.join('; ')} -->`;
}

export function renderDocument(piece: DocumentPiece | null): string {
  if (!piece) return '(the document is not in this state)';
  const s = piece.settings;
  const name = str(s.name);
  const type = str(s.type) || 'blank';
  let body: string;
  if (type === 'page') {
    try {
      body = toMarkdown({ blocks: piece.blocks ?? [] } as DocumentInput, { selfCheck: false }).markdown;
    } catch {
      body = `\`\`\`json\n${JSON.stringify(piece.blocks ?? [], null, 1)}\n\`\`\``;
    }
  } else if (type === 'map') {
    const img = isObj(s.mapImage) ? s.mapImage : null;
    body =
      renderMap({ name, features: piece.features ?? [] }) +
      (img
        ? `\n\nImage: ${str(img.url) || '(none)'} (${typeof img.width === 'number' ? String(img.width) : '?'} × ${typeof img.height === 'number' ? String(img.height) : '?'})`
        : '');
  } else if (type === 'time') {
    body = renderTimeline({ name, lanes: piece.lanes ?? [], events: piece.events ?? [] });
  } else if (type === 'board') {
    body = renderBoard(piece.content ?? {}, name);
  } else {
    body = '(a blank document)';
  }
  return `${settingsLine(s)}\n${body}`;
}

export interface PieceDiff {
  readonly diff: MarkdownDiff;
  readonly text: string;
  readonly identical: boolean;
}

/** The line diff of two renderings (keep regions folded to one placeholder line each). */
export function diffText(before: string, after: string): PieceDiff {
  const diff = markdownDiff(before, after);
  const same = withPlaceholders(before).join('\n') === withPlaceholders(after).join('\n');
  return { diff, text: unifiedText(diff), identical: same && diff.added === 0 && diff.removed === 0 };
}
