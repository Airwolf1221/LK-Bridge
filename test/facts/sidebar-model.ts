/**
 * A faithful model of LegendKeeper's sidebar properties for the v2 C2a tests (no test framework imported, so the
 * Playwright server can use it too); see test/facts/world.ts.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';

type Obj = Record<string, unknown>;

export interface MRow {
  id: string;
  rank: string;
  key: string;
  content: Obj[];
}
export interface MItem {
  id: string;
  rank: string;
  resourceId: string;
  documentId?: string;
}
export interface MProp {
  id: string;
  kind: 'keyValue' | 'resourceCollection' | 'resourceLink' | 'unsupported' | 'textField';
  title: string;
  rank: string;
  rows?: MRow[];
  items?: MItem[];
  filter?: unknown;
}
export interface MSidebar {
  version: number;
  props: MProp[];
}

let seq = 0;
const mint = (p: string) => `${p}${(++seq).toString(36).padStart(7, '0')}`.slice(0, 8);
const rankAt = (n: number) => `r${n.toString(36).padStart(8, '0')}`;
const err = (status: number, code: string): MockResponse => ({
  status,
  body: { message: `model ${code}`, code, requestId: `model-${code}` },
});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const textOf = (content: Obj[]) =>
  content
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.break === true
          ? '\n'
          : r.mention
            ? str((r.mention as Obj).text) || str((r.mention as Obj).name)
            : '',
    )
    .join('');

export class SidebarModel {
  readonly pages = new Map<string, MSidebar>();
  readonly requests: { method: string; path: string; ifMatch?: string; body?: unknown }[] = [];
  /** Runs once, right after the n-th answered request (0-based) whose `method path` matches. */
  private readonly hooks: { re: RegExp; n: number; seen: number; fn: () => void }[] = [];
  /** Changes what a write stores (LegendKeeper storing something other than what was sent). */
  mangle: ((req: MockRequest, sidebar: MSidebar) => void) | null = null;
  propertyVersions = false;

  constructor(readonly names: (id: string) => string | undefined) {}

  page(id: string, props: Omit<MProp, 'rank'>[]): MSidebar {
    const sb: MSidebar = { version: 1, props: props.map((p, i) => ({ ...p, rank: rankAt((i + 1) * 100) })) };
    this.pages.set(id, sb);
    return sb;
  }

  /** A key-value property from `[key, text]` pairs. */
  static kv(id: string, title: string, rows: [string, string | Obj[]][]): Omit<MProp, 'rank'> {
    return {
      id,
      kind: 'keyValue',
      title,
      rows: rows.map(([key, v], i) => ({
        id: `${id}r${i + 1}`,
        rank: rankAt((i + 1) * 100),
        key,
        content: typeof v === 'string' ? (v === '' ? [] : [{ text: v }]) : v,
      })),
    };
  }

  static links(
    id: string,
    title: string,
    items: { resourceId: string; documentId?: string }[],
    o: { kind?: 'resourceCollection' | 'resourceLink'; filter?: unknown } = {},
  ): Omit<MProp, 'rank'> {
    return {
      id,
      kind: o.kind ?? 'resourceCollection',
      title,
      items: items.map((x, i) => ({ id: `${id}i${i + 1}`, rank: rankAt((i + 1) * 100), ...x })),
      ...(o.filter !== undefined ? { filter: o.filter } : {}),
    };
  }

  after(pattern: RegExp, n: number, fn: () => void): void {
    this.hooks.push({ re: pattern, n, seen: 0, fn });
  }

  /** An edit made in the LegendKeeper app: the version moves on. */
  outside(page: string, fn: (sb: MSidebar) => void): void {
    const sb = this.pages.get(page)!;
    fn(sb);
    sb.version++;
  }

  rows(page: string, title = 'PROPERTIES'): { key: string; text: string; id: string }[] {
    const p = this.pages.get(page)!.props.find((x) => x.title === title)!;
    return (p.rows ?? []).map((r) => ({ key: r.key, text: textOf(r.content), id: r.id }));
  }

  items(page: string, title: string): MItem[] {
    return [...(this.pages.get(page)!.props.find((x) => x.title === title)!.items ?? [])];
  }

  rowView(r: MRow) {
    return {
      id: r.id,
      rank: r.rank,
      key: r.key,
      content: structuredClone(r.content),
      text: textOf(r.content),
    };
  }

  propView(p: MProp, sb: MSidebar): Obj {
    const env = {
      id: p.id,
      kind: p.kind,
      title: p.title,
      rank: p.rank,
      ...(this.propertyVersions ? { version: `pv${sb.version}` } : {}),
    };
    if (p.kind === 'keyValue') return { ...env, rows: (p.rows ?? []).map((r) => this.rowView(r)) };
    if (p.kind === 'resourceCollection' || p.kind === 'resourceLink')
      return {
        ...env,
        items: (p.items ?? []).map((i) => ({
          id: i.id,
          rank: i.rank,
          resourceId: i.resourceId,
          ...(i.documentId ? { documentId: i.documentId } : {}),
        })),
        ...(p.filter !== undefined ? { filter: structuredClone(p.filter) } : {}),
      };
    if (p.kind === 'textField') return { ...env, children: [] };
    return { kind: 'unsupported', id: p.id, title: p.title, rank: p.rank };
  }

  /** Answers a request to a modelled page's properties (or getResource's properties), else undefined. */
  respond(req: MockRequest, resourceView: (id: string) => Obj | undefined): MockResponse | undefined {
    const m = /\/resources\/([^/]+)(\/properties(?:\/([^/]+)(?:\/rows(?:\/([^/]+))?)?)?)?$/.exec(
      req.path.replace(/\/$/, ''),
    );
    if (!m) return undefined;
    const [, rid, propsPart, pid, rowId] = m;
    const sb = this.pages.get(rid!);
    if (!sb) return undefined;
    const rowsPart = /\/rows/.test(req.path);
    this.requests.push({
      method: req.method,
      path: req.path.replace(/^\/api\/v3\/projects\/[^/]+/, ''),
      ...(req.headers['if-match'] ? { ifMatch: req.headers['if-match'] } : {}),
      ...(req.method !== 'GET' ? { body: structuredClone(req.body) } : {}),
    });
    const answer = this.answer(req, sb, rid!, propsPart, pid, rowsPart, rowId, resourceView);
    const line = `${req.method} ${req.path.replace(/^\/api\/v3\/projects\/[^/]+/, '')}`;
    for (const h of this.hooks) if (h.re.test(line) && h.seen++ === h.n) h.fn();
    return answer;
  }

  private answer(
    req: MockRequest,
    sb: MSidebar,
    rid: string,
    propsPart: string | undefined,
    pid: string | undefined,
    rowsPart: boolean,
    rowId: string | undefined,
    resourceView: (id: string) => Obj | undefined,
  ): MockResponse | undefined {
    const M = req.method;
    const body = (req.body ?? {}) as Obj;
    if (!propsPart) {
      if (M !== 'GET') return undefined;
      const view = resourceView(rid);
      if (!view) return err(404, 'NOT_FOUND');
      return { status: 200, body: { ...view, properties: sb.props.map((p) => this.propView(p, sb)) } };
    }
    if (!pid) {
      if (M === 'GET')
        return {
          status: 200,
          body: { data: sb.props.map((p) => this.propView(p, sb)), hasMore: false, nextCursor: null },
        };
      if (M === 'POST') {
        const p: MProp = {
          id: typeof body.id === 'string' ? body.id : mint('p'),
          kind: body.kind as MProp['kind'],
          title: typeof body.title === 'string' ? body.title : '',
          rank: rankAt((sb.props.length + 1) * 100),
          ...(body.kind === 'keyValue'
            ? {
                rows: ((body.rows as Obj[] | undefined) ?? []).map((r, i) => ({
                  id: mint('w'),
                  rank: rankAt((i + 1) * 100),
                  key: str(r.key),
                  content: Array.isArray(r.content) ? (r.content as Obj[]) : r.text ? [{ text: r.text }] : [],
                })),
              }
            : {}),
        };
        sb.props.push(p);
        sb.version++;
        return { status: 201, body: this.propView(p, sb) };
      }
      return undefined;
    }
    const prop = sb.props.find((p) => p.id === pid);
    if (!prop) return err(404, 'NOT_FOUND');
    if (!rowsPart) {
      if (M === 'GET') return { status: 200, body: this.propView(prop, sb) };
      if (M === 'DELETE') {
        sb.props = sb.props.filter((p) => p !== prop);
        sb.version++;
        return { status: 204 };
      }
      if (M === 'PATCH') {
        if (typeof body.title === 'string') prop.title = body.title;
        if (Array.isArray(body.items)) {
          let last = 0;
          prop.items = (body.items as Obj[]).map((i) => {
            const rank = typeof i.rank === 'string' ? i.rank : rankAt((last += 100) + 10_000);
            if (typeof i.rank === 'string') last = Math.max(last, parseInt(i.rank.slice(1), 36));
            return {
              id: typeof i.id === 'string' ? i.id : mint('i'),
              rank,
              resourceId: String(i.resourceId),
              ...(typeof i.documentId === 'string' ? { documentId: i.documentId } : {}),
            };
          });
        }
        if (Array.isArray(body.rows) && prop.kind === 'keyValue') {
          prop.rows = (body.rows as Obj[]).map((r, i) => ({
            id: typeof r.id === 'string' ? r.id : mint('w'),
            rank: rankAt((i + 1) * 100),
            key: str(r.key),
            content: Array.isArray(r.content) ? (r.content as Obj[]) : r.text ? [{ text: r.text }] : [],
          }));
        }
        this.mangle?.(req, sb);
        sb.version++;
        return { status: 200, body: this.propView(prop, sb) };
      }
      return undefined;
    }
    if (prop.kind !== 'keyValue') return err(400, 'KIND_MISMATCH');
    const rows = prop.rows!;
    const version = `v${sb.version}`;
    if (M === 'GET' && !rowId)
      return { status: 200, body: { data: rows.map((r) => this.rowView(r)), version } };
    if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== version)
      return err(412, 'VERSION_MISMATCH');
    const contentOf = (cur: Obj[]): Obj[] =>
      'content' in body
        ? Array.isArray(body.content)
          ? (body.content as Obj[])
          : []
        : typeof body.text === 'string'
          ? body.text === ''
            ? []
            : [{ text: body.text }]
          : cur;
    if (M === 'POST' && !rowId) {
      const row: MRow = { id: mint('w'), rank: '', key: str(body.key), content: contentOf([]) };
      const after = typeof body.after === 'string' ? rows.findIndex((r) => r.id === body.after) : -1;
      const before = typeof body.before === 'string' ? rows.findIndex((r) => r.id === body.before) : -1;
      if ((typeof body.after === 'string' && after < 0) || (typeof body.before === 'string' && before < 0))
        return err(404, 'NOT_FOUND');
      if (after >= 0) rows.splice(after + 1, 0, row);
      else if (before >= 0) rows.splice(before, 0, row);
      else rows.push(row);
      rows.forEach((r, i) => (r.rank = rankAt((i + 1) * 100)));
      this.mangle?.(req, sb);
      sb.version++;
      return { status: 201, body: { ...this.rowView(row), version: `v${sb.version}` } };
    }
    const row = rows.find((r) => r.id === rowId);
    if (!row) return err(404, 'NOT_FOUND');
    if (M === 'PATCH') {
      if (typeof body.key === 'string') row.key = body.key;
      row.content = contentOf(row.content);
      this.mangle?.(req, sb);
      sb.version++;
      return { status: 200, body: { ...this.rowView(row), version: `v${sb.version}` } };
    }
    if (M === 'DELETE') {
      prop.rows = rows.filter((r) => r !== row);
      sb.version++;
      return { status: 204 };
    }
    return undefined;
  }
}
