/**
 * CR-2026-11-R3 (R3-37): "Propose these again" puts back the routing lines a partial approval left out.
 *
 * A routing line (a list item mentioning a page) to a page left out of a partial approval is a soft reference (ADR 0058
 * decision 2.1): it is removed from the approved write (an index's text), so the index never lists a page that was not
 * made. When "Propose these again" then makes that page, nothing put the line back: a package approved in two steps
 * ended with its index not routing to the page the whole package would have routed to.
 *
 * `routesBack` finds, in the approved writes of the original plan, each line that names a page the re-proposal makes,
 * and plans one write per line on the document the approved job wrote (its id as the job bound it). The write is computed
 * inside the page's lock on the document as it is then (`ROUTE_BACK_REBASER`, `rebase.always`): the line goes back into
 * the same list after the line it followed (or, when that list is gone, the last list of the same section, else a new
 * one); a section that already routes to the page sends nothing; a section that is gone sends nothing either (said in
 * the job's record). It belongs to the item that makes the page, so leaving that item out of the re-proposal leaves its
 * line out too.
 */
import type { RebaseContext, RebaseResult } from './rebase.js';
import type { OpParams, StepSpec } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const ROUTE_BACK_REBASER = 'items.route_back';

export interface RouteBackInput {
  readonly item: string;
  /** The heading text of the section the line stood in (null: before any heading). */
  readonly section: string | null;
  /** The line as planned (a list item mentioning the page). */
  readonly line: Obj;
  /** The list it stood in, and the line before it there (null: it was first). */
  readonly listId: string | null;
  readonly after: string | null;
  readonly pageId: string;
  readonly where: string;
}

const runsText = (v: unknown): string =>
  Array.isArray(v)
    ? (v as unknown[])
        .map((r) =>
          isObj(r)
            ? (str(r.text) ?? (isObj(r.mention) ? (str(r.mention.text) ?? str(r.mention.name) ?? '') : ''))
            : '',
        )
        .join('')
    : '';
const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether a block (or anything inside it) mentions the page. */
function mentions(v: unknown, pageId: string, depth = 0): boolean {
  if (depth > 40) return false;
  if (Array.isArray(v)) return v.some((x) => mentions(x, pageId, depth + 1));
  if (!isObj(v)) return false;
  if (isObj(v.mention) && v.mention.resourceId === pageId) return true;
  return Object.values(v).some((x) => mentions(x, pageId, depth + 1));
}

const isList = (b: Obj) => b.kind === 'bulletList' || b.kind === 'orderedList';

/**
 * The routing lines to put back (see the module comment). `full` is the original plan; `approvedFrom` the full plan's
 * step number of each step the approved job ran (in its order); `jobParams` that job's step params as it ran them (a
 * document id bound when it ran); `makes` the pages the re-proposal makes, each with the item that makes it.
 */
export function routesBack(
  full: readonly StepSpec[],
  approvedFrom: readonly number[],
  jobParams: (jobStepNo: number) => OpParams | undefined,
  makes: ReadonlyMap<string, string>,
  pageName: (resourceId: string) => string,
): StepSpec[] {
  const out: StepSpec[] = [];
  approvedFrom.forEach((f, k) => {
    const s = full[f - 1];
    if (!s || s.op !== 'replaceDocumentBlocks') return;
    const ran = jobParams(k + 1);
    const resourceId = str(ran?.path?.resourceId);
    const documentId = str(ran?.path?.documentId);
    if (!resourceId || !documentId || documentId === 'pending') return;
    const blocks = isObj(s.params?.body) && Array.isArray(s.params.body.blocks) ? s.params.body.blocks : [];
    let section: string | null = null;
    for (const b of blocks) {
      if (!isObj(b)) continue;
      if (b.kind === 'heading') {
        section = runsText(b.content);
        continue;
      }
      if (!isList(b) || !Array.isArray(b.children)) continue;
      let after: string | null = null;
      for (const li of b.children as unknown[]) {
        if (!isObj(li)) continue;
        const page = [...makes.keys()].find((p) => mentions(li, p));
        if (page) {
          const input: RouteBackInput = {
            item: makes.get(page)!,
            section,
            line: li,
            listId: str(b.id),
            after,
            pageId: page,
            where: `${pageName(resourceId)}${section ? ` › ${section}` : ''}`,
          };
          out.push({
            op: 'replaceDocumentBlocks',
            params: { path: { resourceId, documentId }, body: { blocks: [] } },
            judgedInLock: true,
            verifyAfterWrite: true,
            items: [input.item],
            rebase: { rebaser: ROUTE_BACK_REBASER, input, always: true },
            journalOperation: { write: `the routing line to ${pageName(page)}, put back` },
          });
        } else after = str(li.id) ?? after;
      }
    }
  });
  return out;
}

/** The line put back on the document as it is now (see the module comment). Pure. */
export function applyRouteBack(
  current: readonly Obj[],
  r: RouteBackInput,
): { state: 'apply'; blocks: Obj[] } | { state: 'done' } | { state: 'missing'; why: string } {
  // The section: from its heading (or the start, for lines before any heading) to the next heading.
  const at =
    r.section === null
      ? -1
      : current.findIndex((b) => b.kind === 'heading' && key(runsText(b.content)) === key(r.section!));
  if (r.section !== null && at < 0)
    return { state: 'missing', why: `the page has no “${r.section}” section now` };
  let end = current.length;
  for (let j = at + 1; j < current.length; j++)
    if (current[j]!.kind === 'heading') {
      end = j;
      break;
    }
  const span = current.slice(at + 1, end);
  if (span.some((b) => mentions(b, r.pageId))) return { state: 'done' };
  const listAt = span.findIndex((b) => isList(b) && (r.listId === null || b.id === r.listId));
  const list = listAt >= 0 ? span[listAt]! : [...span].reverse().find(isList);
  if (list) {
    const kids = Array.isArray(list.children) ? [...(list.children as unknown[])] : [];
    const prev = r.after === null ? -1 : kids.findIndex((x) => isObj(x) && x.id === r.after);
    kids.splice(r.after === null ? 0 : prev >= 0 ? prev + 1 : kids.length, 0, r.line);
    const idx = current.indexOf(list);
    return {
      state: 'apply',
      blocks: [...current.slice(0, idx), { ...list, children: kids }, ...current.slice(idx + 1)],
    };
  }
  const fresh: Obj = { id: r.listId ?? `rb${r.pageId.slice(0, 20)}`, kind: 'bulletList', children: [r.line] };
  return { state: 'apply', blocks: [...current.slice(0, end), fresh, ...current.slice(end)] };
}

export function routeBackRebaser(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as RouteBackInput;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: 'the document is gone', where: input.where }],
    };
  const body = ctx.current.body;
  const blocks = isObj(body) && Array.isArray(body.blocks) ? (body.blocks as unknown[]).filter(isObj) : [];
  const o = applyRouteBack(blocks, input);
  if (o.state === 'done') return { kind: 'unchanged', note: { done: input.item } };
  // A section gone sends nothing and skips nothing (the page itself was made): the job's record says why.
  if (o.state === 'missing')
    return { kind: 'unchanged', note: { notRoutedBack: `${input.where}: ${o.why}` } };
  return {
    kind: 'retry',
    params: { ...ctx.params, body: { blocks: o.blocks } },
    note: { routedBack: input.pageId },
  };
}
