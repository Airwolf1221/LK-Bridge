/**
 * Read-only Markdown for the other document types (docs/PLAN-v2.md 4.7, "Reading maps, timelines and boards"), built
 * only from what the API returns. Nothing here converts back: maps, timelines and boards are changed with their own
 * tools.
 *
 * - Maps: features (folders as nesting), each with type, name, position and link.
 * - Timelines: lanes in order, then each lane's events in date order, with LegendKeeper's own `formattedStart` and
 *   `formattedEnd` (the calendar engine comes in D1).
 * - Boards: each page's shapes with their text, then the connections (arrows bound to shapes).
 */
import { escapeLineStart, escapeText } from './inline.js';
import { isObj, type Obj } from './model.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const txt = (v: unknown): string => escapeText(str(v).replace(/[\r\n]+/g, ' '));
const num = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10_000) / 10_000) : '?';
const byRank = (a: Obj, b: Obj): number =>
  str(a.rank) < str(b.rank) ? -1 : str(a.rank) > str(b.rank) ? 1 : 0;

/** A link for an `lk://` uri, or the uri as text. */
function uriLink(uri: unknown): string {
  const u = str(uri);
  if (u === '') return '';
  if (/^lk:\/\/(resources|documents)\/[A-Za-z0-9_/-]+$/.test(u)) return `[link](${u})`;
  return txt(u);
}

// ------------------------------------------------------------------------------------------------ maps

function centre(points: unknown): { lat: number; lng: number; count: number } | null {
  const flat: number[][] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number')
      flat.push(v as number[]);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  walk(points);
  if (flat.length === 0) return null;
  const lat = flat.reduce((s, p) => s + p[0]!, 0) / flat.length;
  const lng = flat.reduce((s, p) => s + p[1]!, 0) / flat.length;
  return { lat, lng, count: flat.length };
}

function featureLine(f: Obj): string {
  const type = str(f.type) || 'feature';
  const name = txt(f.name) || '(unnamed)';
  let where = '';
  if (Array.isArray(f.pos)) where = ` at (${num(f.pos[0])}, ${num(f.pos[1])})`;
  else {
    const c = centre(f.polygons ?? f.polygon ?? f.polyline);
    if (c) where = ` around (${num(c.lat)}, ${num(c.lng)}), ${c.count} points`;
  }
  const link = uriLink(f.uri);
  const hidden = f.isHidden === true ? ' (hidden)' : '';
  return `- **${name}** (${type})${where}${link ? ` → ${link}` : ''}${hidden}`;
}

export interface MapInput {
  readonly name?: string;
  readonly features: readonly unknown[];
}

/** A map document's features as Markdown. */
export function renderMap(input: MapInput): string {
  const features = input.features.filter(isObj);
  const children = new Map<string | null, Obj[]>();
  const ids = new Set(features.map((f) => str(f.id)));
  for (const f of features) {
    const p = typeof f.parentId === 'string' && ids.has(f.parentId) ? f.parentId : null;
    children.set(p, [...(children.get(p) ?? []), f]);
  }
  const lines: string[] = [
    `# Map${input.name ? `: ${txt(input.name)}` : ''}`,
    '',
    `${features.length} feature(s).`,
    '',
  ];
  const walk = (parent: string | null, depth: number) => {
    for (const f of [...(children.get(parent) ?? [])].sort(byRank)) {
      lines.push(`${'  '.repeat(depth)}${featureLine(f)}`);
      if (depth < 20) walk(str(f.id), depth + 1);
    }
  };
  walk(null, 0);
  return `${lines.join('\n').trimEnd()}\n`;
}

// ------------------------------------------------------------------------------------------------ timelines

export interface TimelineInput {
  readonly name?: string;
  readonly lanes: readonly unknown[];
  readonly events: readonly unknown[];
}

function eventLine(e: Obj): string {
  const name = txt(e.name) || '(unnamed)';
  const start = str(e.formattedStart) || (typeof e.start === 'number' ? `minute ${e.start}` : '?');
  const end = str(e.formattedEnd);
  const when = end && end !== start ? `${txt(start)} – ${txt(end)}` : txt(start);
  const type = typeof e.type === 'string' && e.type !== 'event' ? ` (${e.type})` : '';
  const link = uriLink(e.uri);
  const hidden = e.isHidden === true ? ' (hidden)' : '';
  return `- ${when}: **${name}**${type}${link ? ` → ${link}` : ''}${hidden}`;
}

/** A timeline's lanes and events as Markdown, events in date order. */
export function renderTimeline(input: TimelineInput): string {
  const lanes = input.lanes.filter(isObj).sort(byRank);
  const events = input.events.filter(isObj);
  const lines: string[] = [
    `# Timeline${input.name ? `: ${txt(input.name)}` : ''}`,
    '',
    `${lanes.length} lane(s), ${events.length} event(s).`,
  ];
  const order = (a: Obj, b: Obj) => {
    const sa = typeof a.start === 'number' ? a.start : 0;
    const sb = typeof b.start === 'number' ? b.start : 0;
    if (sa !== sb) return sa - sb;
    const ea = typeof a.end === 'number' ? a.end : sa;
    const eb = typeof b.end === 'number' ? b.end : sb;
    return ea !== eb ? ea - eb : byRank(a, b);
  };
  const laneIds = new Set(lanes.map((l) => str(l.id)));
  const groups: [string, Obj[]][] = lanes.map((l) => [
    `## ${txt(l.name) || '(unnamed lane)'}`,
    events.filter((e) => e.laneId === l.id),
  ]);
  const orphans = events.filter((e) => !laneIds.has(str(e.laneId)));
  if (orphans.length > 0) groups.push(['## (events of other lanes)', orphans]);
  for (const [title, list] of groups) {
    lines.push('', title, '');
    if (list.length === 0) lines.push('(no events)');
    for (const e of [...list].sort(order)) lines.push(eventLine(e));
  }
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ boards

/** Text of a tldraw shape: `props.text`, a TipTap `richText`, a frame's `name`, else ''. */
function shapeText(s: Obj): string {
  const p = isObj(s.props) ? s.props : {};
  if (typeof p.text === 'string' && p.text.trim() !== '') return p.text;
  if (isObj(p.richText)) {
    const parts: string[] = [];
    const walk = (n: unknown) => {
      if (!isObj(n)) return;
      if (typeof n.text === 'string') parts.push(n.text);
      if (Array.isArray(n.content)) {
        n.content.forEach(walk);
        if (n.type === 'paragraph') parts.push(' ');
      }
    };
    walk(p.richText);
    const t = parts.join('').trim();
    if (t !== '') return t;
  }
  if (typeof p.name === 'string') return p.name;
  return '';
}

function shapeLabel(s: Obj): string {
  const t = shapeText(s).replace(/\s+/g, ' ').trim();
  const kind =
    str(s.type) === 'geo' && isObj(s.props) && typeof s.props.geo === 'string'
      ? s.props.geo
      : str(s.type) || 'shape';
  return t !== '' ? `${kind} "${txt(t.slice(0, 200))}"` : `${kind} ${txt(str(s.id).replace(/^shape:/, ''))}`;
}

/** A board's shapes (with their text) and connections as Markdown. */
export function renderBoard(content: unknown, name?: string): string {
  const c = isObj(content) ? content : {};
  const pages = (Array.isArray(c.pages) ? c.pages : [])
    .filter(isObj)
    .sort((a, b) => (str(a.index) < str(b.index) ? -1 : 1));
  const shapes = (Array.isArray(c.shapes) ? c.shapes : []).filter(isObj);
  const bindings = (Array.isArray(c.bindings) ? c.bindings : []).filter(isObj);
  const byId = new Map(shapes.map((s) => [str(s.id), s]));
  const lines: string[] = [
    `# Board${name ? `: ${txt(name)}` : ''}`,
    '',
    `${shapes.length} shape(s) on ${pages.length} page(s).`,
  ];
  const kids = new Map<string, Obj[]>();
  for (const s of shapes) kids.set(str(s.parentId), [...(kids.get(str(s.parentId)) ?? []), s]);
  const walk = (parent: string, depth: number) => {
    const list = [...(kids.get(parent) ?? [])].sort((a, b) => (str(a.index) < str(b.index) ? -1 : 1));
    for (const s of list) {
      if (s.type === 'arrow') continue;
      lines.push(`${'  '.repeat(depth)}- ${shapeLabel(s)}`);
      if (depth < 20) walk(str(s.id), depth + 1);
    }
  };
  for (const p of pages.length > 0 ? pages : [{ id: '', name: '' }]) {
    lines.push('', `## ${escapeLineStart(txt(p.name)) || 'Page'}`, '');
    walk(str(p.id), 0);
  }
  // Connections: each arrow and the shapes its ends are bound to.
  const conns: string[] = [];
  for (const a of shapes.filter((s) => s.type === 'arrow')) {
    const ends = bindings.filter((b) => b.fromId === a.id && isObj(b.props));
    const end = (t: string) => {
      const b = ends.find((x) => (x.props as Obj).terminal === t);
      const s = b ? byId.get(str(b.toId)) : undefined;
      return s ? shapeLabel(s) : '(nothing)';
    };
    const label = shapeText(a);
    conns.push(`- ${end('start')} → ${end('end')}${label ? ` ("${txt(label)}")` : ''}`);
  }
  lines.push('', '## Connections', '', ...(conns.length > 0 ? conns : ['(none)']));
  return `${lines.join('\n')}\n`;
}
