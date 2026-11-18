/**
 * v3 F3d (renames), ADR 0058 (the owner-approved design docs/design/F3d-renames.md, section 2): the ITEMS of a
 * proposal. A package or a rename is planned as one ordered list of steps; its tool also says which steps belong to
 * which item (an edit the owner can approve or leave out), what each item changes, and which items it needs. The owner
 * approves a selection on the Proposals page; this module turns the stored steps into exactly the steps of the approved
 * items, with every step number re-mapped, so the job runs only what was approved.
 *
 * - **An item** (`PlanItem`): an id stable within the proposal, its kind and group, a one-line label, the page it
 *   touches, its diff, the items it depends on, and whether it starts ticked (and why not).
 * - **A step's items** (`StepOptions.items`): the step belongs to these items and is kept when ANY of them is kept;
 *   a step with none is shared (the bridge's own checks and read-back), kept whatever is selected.
 * - **Parts of a shared step** (`StepOptions.itemParts`): an array inside a bridge step's params whose elements belong
 *   to items (a check, a read-back target, a chronology record's writes): only the elements of kept items stay.
 * - **Dependants drop with what they need.** A selection is closed (every kept item's dependencies kept) before it is
 *   approved; `closeSelection` says what an unticked item takes with it.
 *
 * What the filter does to the kept steps, so they run exactly as the full plan would have for those items:
 * - every step reference (bindings, checks, read-back, Last Major Revision) is re-numbered;
 * - an If-Match chain through a dropped write is re-chained to the write (or check) before it, as if the dropped write
 *   had never been planned (a write chained from a dropped `bridge.lmr` is dropped with it);
 * - a Last Major Revision step keeps only the writes it follows that remain, and only the evidence of kept items; with
 *   none left it is dropped with its write;
 * - a new page placed beside a page that is no longer made takes that page's place (`after`/`before` re-anchored), and
 *   a read-back's expected neighbours are worked out the same way;
 * - any other reference to a dropped step is a planning error (`ITEM_FILTER`): nothing is approved.
 */
import { LMR_STEP, VERIFY_STEP, EXPECT_STEP } from './internal-steps.js';
import type { StepSpec } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an item changes, for the owner. */
export interface ItemDiff {
  /** The text or value before and after (one change). */
  readonly before?: string | null;
  readonly after?: string | null;
  /** The sentence or line around the change, for context. */
  readonly context?: string;
  /** Several changes (a page's facts). */
  readonly changes?: readonly {
    readonly what: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
}

/** One edit the owner can approve or leave out. */
export interface PlanItem {
  /** Stable within the proposal (`name:abcd1234`, `text:doc:block:2`). */
  readonly id: string;
  /** The item kind (`page_name`, `identity_facts`, `restatement`, `new_page`, …). */
  readonly kind: string;
  /** The heading it is listed under ("Page names", "Textual restatements"). */
  readonly group: string;
  /** One line: what it does. */
  readonly label: string;
  /** The page it touches, when one. */
  readonly page?: { readonly id: string; readonly name: string } | null;
  readonly diff?: ItemDiff;
  /** The items it needs: unticking one of them drops this one too. */
  readonly dependsOn: readonly string[];
  /** Ticked at first (the owner may change it). */
  readonly selected: boolean;
  /** Why it starts unticked (D1's rules), when it does. */
  readonly why?: string;
  /** Labels shown beside it (`AU`). */
  readonly tags?: readonly string[];
}

/** An array inside a shared step's params whose elements belong to items. */
export interface ItemPart {
  /** A dotted path to the array, from the step's params (`body.checks`, `body.targets.3.input.rows`). */
  readonly path: string;
  /** Each element's items, in order (empty: shared, always kept). */
  readonly items: readonly (readonly string[])[];
}

export class ItemFilterError extends Error {
  override readonly name = 'ItemFilterError';
  readonly code = 'ITEM_FILTER';
  constructor(message: string) {
    super(message);
  }
}

// ============================================================================================ the items

/** Checks a proposal's items: unique ids, known dependencies, no cycle. Throws `ItemFilterError`. */
export function validateItems(items: readonly PlanItem[]): void {
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) throw new ItemFilterError(`The item ${it.id} is listed twice.`);
    ids.add(it.id);
  }
  for (const it of items)
    for (const d of it.dependsOn)
      if (!ids.has(d)) throw new ItemFilterError(`The item ${it.id} needs ${d}, which is not an item.`);
  const state = new Map<string, 1 | 2>();
  const by = new Map(items.map((i) => [i.id, i]));
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1)
      throw new ItemFilterError(`The items depend on each other in a circle: ${[...path, id].join(' → ')}.`);
    state.set(id, 1);
    for (const d of by.get(id)?.dependsOn ?? []) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const it of items) visit(it.id, []);
}

/** The items that depend on `id`, directly or through others (what unticking it takes with it). */
export function dependantsOf(items: readonly PlanItem[], id: string): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const it of items) {
      if (it.dependsOn.includes(cur) && !out.has(it.id) && it.id !== id) {
        out.add(it.id);
        queue.push(it.id);
      }
    }
  }
  return items.filter((i) => out.has(i.id)).map((i) => i.id);
}

/**
 * The items a selection keeps once every item whose dependency is not kept has gone too, and what went with what:
 * `dropped` lists each ticked item that cannot stay, with the unticked or dropped items it needed.
 */
export function closeSelection(
  items: readonly PlanItem[],
  ticked: Iterable<string>,
): { readonly kept: string[]; readonly dropped: { readonly id: string; readonly because: string[] }[] } {
  const known = new Set(items.map((i) => i.id));
  const want = new Set([...ticked].filter((t) => known.has(t)));
  const kept = new Set(want);
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of items) {
      if (!kept.has(it.id)) continue;
      if (it.dependsOn.some((d) => !kept.has(d))) {
        kept.delete(it.id);
        changed = true;
      }
    }
  }
  const dropped = items
    .filter((i) => want.has(i.id) && !kept.has(i.id))
    .map((i) => ({ id: i.id, because: i.dependsOn.filter((d) => !kept.has(d)) }));
  return { kept: items.filter((i) => kept.has(i.id)).map((i) => i.id), dropped };
}

/** The items ticked at first, closed (an unticked item's dependants start unticked too). */
export function defaultSelection(items: readonly PlanItem[]): string[] {
  return closeSelection(
    items,
    items.filter((i) => i.selected).map((i) => i.id),
  ).kept;
}

// ============================================================================================ step references

/** A step number a step refers to, and how it may be re-mapped when that step is dropped. */
type RefKind = 'chain' | 'lmrAfter' | 'lmrChain' | 'decision' | 'hard';

/** Every step number a step refers to, with its kind. */
export function stepRefs(s: StepSpec): { readonly step: number; readonly kind: RefKind }[] {
  const out: { step: number; kind: RefKind }[] = [];
  if (s.ifMatchFrom) out.push({ step: s.ifMatchFrom.step, kind: 'chain' });
  if (s.bindIds) out.push({ step: s.bindIds.step, kind: 'hard' });
  if (s.bindBody) out.push({ step: s.bindBody.step, kind: 'hard' });
  if (s.bindFrom) out.push({ step: s.bindFrom.step, kind: 'hard' });
  if (s.decisionFrom) out.push({ step: s.decisionFrom.step, kind: 'decision' });
  for (const b of s.bindAssetUrls ?? []) out.push({ step: b.step, kind: 'hard' });
  const body = (s.params?.body ?? null) as Obj | null;
  if (body && s.op === VERIFY_STEP && Array.isArray(body.targets)) {
    for (const t of body.targets as Obj[]) for (const n of targetRefs(t)) out.push({ step: n, kind: 'hard' });
  } else if (body && s.op === LMR_STEP) {
    for (const n of (body.after as number[] | undefined) ?? []) out.push({ step: n, kind: 'lmrAfter' });
    if (typeof body.chainFrom === 'number') out.push({ step: body.chainFrom, kind: 'lmrChain' });
  } else if (body && s.op === 'upload_image.verify' && typeof body.assetStep === 'number') {
    out.push({ step: body.assetStep, kind: 'hard' });
  }
  return out;
}

const isStepRef = (v: unknown): v is { step: number } =>
  isObj(v) && typeof v.step === 'number' && Number.isInteger(v.step);

function targetRefs(t: Obj): number[] {
  const out: number[] = [];
  if (isStepRef(t.assetFrom)) out.push(t.assetFrom.step);
  if (isStepRef(t.folderFrom)) out.push(t.folderFrom.step);
  if (Array.isArray(t.inputFrom)) {
    for (const x of t.inputFrom as unknown[]) if (isStepRef(x)) out.push(x.step);
  } else if (isStepRef(t.inputFrom)) out.push(t.inputFrom.step);
  return out;
}

/** A step with every step number it names passed through `f` (which never returns null for a kept reference). */
export function mapStepRefs(s: StepSpec, f: (n: number) => number): StepSpec {
  const out: Record<string, unknown> = { ...s };
  const at = <T extends { step: number }>(o: T | undefined) => (o ? { ...o, step: f(o.step) } : undefined);
  if (s.ifMatchFrom) out.ifMatchFrom = at(s.ifMatchFrom);
  if (s.bindIds) out.bindIds = at(s.bindIds);
  if (s.bindBody) out.bindBody = at(s.bindBody);
  if (s.bindFrom) out.bindFrom = at(s.bindFrom);
  if (s.decisionFrom) out.decisionFrom = at(s.decisionFrom);
  if (s.bindAssetUrls) out.bindAssetUrls = s.bindAssetUrls.map((b) => ({ ...b, step: f(b.step) }));
  const body = (s.params?.body ?? null) as Obj | null;
  if (body && s.op === VERIFY_STEP && Array.isArray(body.targets)) {
    out.params = {
      ...s.params,
      body: {
        ...body,
        targets: (body.targets as Obj[]).map((t) => ({
          ...t,
          ...(isStepRef(t.assetFrom) ? { assetFrom: at(t.assetFrom) } : {}),
          ...(isStepRef(t.folderFrom) ? { folderFrom: at(t.folderFrom) } : {}),
          ...(Array.isArray(t.inputFrom)
            ? {
                inputFrom: (t.inputFrom as { step: number; as: string }[]).map((x) => ({
                  ...x,
                  step: f(x.step),
                })),
              }
            : isStepRef(t.inputFrom)
              ? { inputFrom: at(t.inputFrom) }
              : {}),
        })),
      },
    };
  } else if (body && s.op === LMR_STEP) {
    out.params = {
      ...s.params,
      body: {
        ...body,
        after: ((body.after as number[] | undefined) ?? []).map(f),
        ...(typeof body.chainFrom === 'number' ? { chainFrom: f(body.chainFrom) } : {}),
      },
    };
  } else if (body && s.op === 'upload_image.verify' && typeof body.assetStep === 'number') {
    out.params = { ...s.params, body: { ...body, assetStep: f(body.assetStep) } };
  }
  return out as unknown as StepSpec;
}

// ============================================================================================ dependencies

const CREATE_OPS = new Set(['createResourceFromTemplate', 'createResource']);

/** The page ids a step creates (a template copy, a resource, a batch). */
export function createdIds(s: StepSpec): string[] {
  const body = (s.params?.body ?? null) as Obj | null;
  if (!body) return [];
  if (CREATE_OPS.has(s.op)) return typeof body.id === 'string' ? [body.id] : [];
  if (s.op === 'createManyResources' && Array.isArray(body.resources))
    return (body.resources as Obj[]).map((r) => r?.id).filter((x): x is string => typeof x === 'string');
  return [];
}

/** Every string in a value (a link's page, a mention's page, a routing line's), deeply. */
function stringsOf(v: unknown, out: string[], depth = 0): void {
  if (depth > 60) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1);
  else if (isObj(v)) for (const x of Object.values(v)) stringsOf(x, out, depth + 1);
}

/**
 * The dependencies the steps themselves imply, added to the items' own. Always the HARD ones: an item whose step binds
 * (or reads back) a step of another item, makes or moves a page under a page another item makes (`parentId`), or writes
 * to a page another item makes (`path.resourceId`), needs that item. With `all` for an item, also every other mention of
 * a page another item makes in its steps (a link it adds, a routing line naming it): for a change that exists only for
 * those pages. Otherwise such a reference is SOFT: the filter removes it when that page is left out (a link or a line
 * to it; a mention keeps its text). An If-Match chain, a Last Major Revision step's writes and a new page's place among
 * its siblings are never dependencies: the filter re-chains and re-anchors them.
 */
export function withStepDependencies(
  items: readonly PlanItem[],
  steps: readonly StepSpec[],
  o: { readonly all?: (item: string) => boolean } = {},
): PlanItem[] {
  const deps = new Map(items.map((i) => [i.id, new Set(i.dependsOn)]));
  const add = (from: readonly string[], to: readonly string[]) => {
    if (to.length === 0) return;
    for (const f of from) {
      if (to.includes(f)) continue;
      const set = deps.get(f);
      if (!set) continue;
      for (const t of to) if (t !== f && deps.has(t)) set.add(t);
    }
  };
  const creator = new Map<string, readonly string[]>();
  for (const s of steps) for (const id of createdIds(s)) creator.set(id, s.items ?? []);
  const hardIds = (s: StepSpec): string[] => {
    const body = (s.params?.body ?? null) as Obj | null;
    const out: string[] = [];
    const rid = s.params?.path?.resourceId;
    if (typeof rid === 'string' && !createdIds(s).includes(rid)) out.push(rid);
    if ((CREATE_OPS.has(s.op) || s.op === 'moveResource') && typeof body?.parentId === 'string')
      out.push(body.parentId);
    if (s.op === 'createManyResources' && Array.isArray(body?.resources))
      for (const r of body.resources as Obj[]) if (typeof r?.parentId === 'string') out.push(r.parentId);
    return out;
  };
  steps.forEach((s) => {
    const mine = s.items ?? [];
    for (const r of stepRefs(s)) {
      if (r.kind !== 'hard') continue;
      add(mine, steps[r.step - 1]?.items ?? []);
    }
    for (const id of hardIds(s)) add(mine, creator.get(id) ?? []);
    const wide = mine.filter((i) => o.all?.(i) === true);
    if (wide.length > 0) {
      const own = new Set(createdIds(s));
      const found: string[] = [];
      stringsOf(s.params, found);
      for (const str of new Set(found)) if (!own.has(str)) add(wide, creator.get(str) ?? []);
    }
    // A shared step's parts: each element's items need what the element binds.
    for (const part of s.itemParts ?? []) {
      const arr = getPath(s.params, part.path);
      if (!Array.isArray(arr)) continue;
      arr.forEach((el, i) => {
        const its = part.items[i] ?? [];
        if (its.length === 0 || !isObj(el)) return;
        for (const n of targetRefs(el)) add(its, steps[n - 1]?.items ?? []);
      });
    }
  });
  return items.map((i) => ({ ...i, dependsOn: [...(deps.get(i.id) ?? [])] }));
}

/** Whether a block (a routing line) mentions one of these pages anywhere in it. */
function mentions(v: unknown, ids: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 60) return false;
  if (Array.isArray(v)) return v.some((x) => mentions(x, ids, depth + 1));
  if (!isObj(v)) return false;
  if (isObj(v.mention) && typeof v.mention.resourceId === 'string' && ids.has(v.mention.resourceId))
    return true;
  return Object.values(v).some((x) => mentions(x, ids, depth + 1));
}

/**
 * A kept step's params without its SOFT references to pages no longer made: a link (a collection item, a list of
 * ids) to one goes, a list item (a routing line) mentioning one goes, any other mention of one becomes its text.
 */
function withoutRefsTo(v: unknown, gone: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 60) return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      if (typeof x === 'string' && gone.has(x)) continue;
      if (isObj(x)) {
        if (typeof x.resourceId === 'string' && gone.has(x.resourceId)) continue;
        if (x.kind === 'listItem' && mentions(x, gone)) continue;
        const m = x.mention;
        if (isObj(m) && typeof m.resourceId === 'string' && gone.has(m.resourceId)) {
          const label = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
          if (label !== '') out.push({ text: label });
          continue;
        }
      }
      out.push(withoutRefsTo(x, gone, depth + 1));
    }
    return out;
  }
  if (isObj(v)) {
    const o: Obj = {};
    for (const [k, x] of Object.entries(v)) o[k] = NOT_REFERENCES.has(k) ? x : withoutRefsTo(x, gone, depth + 1);
    return o;
  }
  return v;
}

/**
 * Lists of ids that are not references to other pages: a package's check knows the pages it makes (`ownIds`), whether
 * they are made now or were made by the job of the items approved first ("propose these again"), so they are kept.
 */
const NOT_REFERENCES: ReadonlySet<string> = new Set(['ownIds']);

// ============================================================================================ the filter

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const k of path.split('.')) {
    if (Array.isArray(cur)) cur = cur[Number(k)];
    else if (isObj(cur)) cur = cur[k];
    else return undefined;
  }
  return cur;
}

/** A copy of `root` with the value at `path` replaced (arrays and objects along the path copied). */
function setPath(root: unknown, path: string, value: unknown): unknown {
  const keys = path.split('.');
  const go = (cur: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const k = keys[i]!;
    if (Array.isArray(cur)) {
      const copy = [...cur];
      copy[Number(k)] = go(cur[Number(k)], i + 1);
      return copy;
    }
    const o = isObj(cur) ? cur : {};
    return { ...o, [k]: go(o[k], i + 1) };
  };
  return go(root, 0);
}

const keptBy = (its: readonly string[] | undefined, kept: ReadonlySet<string>) =>
  !its || its.length === 0 || its.some((i) => kept.has(i));

/** A place among siblings: after a page, before a page, or at the end. */
interface Slot {
  readonly after?: string;
  readonly before?: string;
}

export interface FilteredSteps {
  readonly steps: StepSpec[];
  /** For each kept step, its number in the full plan (1-based), in order. */
  readonly from: number[];
  /** The page ids the full plan creates that the kept steps do not. */
  readonly notCreated: string[];
}

/**
 * The steps of the kept items (see the module comment). `kept` must be a closed selection; a step of an item not
 * kept, and the parts of a shared step that belong only to such items, are left out.
 */
export function filterSteps(steps: readonly StepSpec[], keptItems: Iterable<string>): FilteredSteps {
  const kept = new Set(keptItems);
  // 1. The parts of each step (deepest arrays first, while every index still names the full plan's element).
  const partsDone: (StepSpec | null)[] = steps.map((s) => {
    if (!keptBy(s.items, kept)) return null;
    if (!s.itemParts || s.itemParts.length === 0) return s;
    let params: unknown = s.params ?? {};
    const parts = [...s.itemParts].sort((a, b) => b.path.split('.').length - a.path.split('.').length);
    for (const part of parts) {
      const arr = getPath(params, part.path);
      if (!Array.isArray(arr)) continue;
      const next = arr.filter((_, i) => keptBy(part.items[i], kept));
      params = setPath(params, part.path, next);
    }
    const body = ((params as { body?: unknown }).body ?? null) as Obj | null;
    if (s.op === EXPECT_STEP && Array.isArray(body?.checks) && body.checks.length === 0) return null;
    if (s.op === VERIFY_STEP && Array.isArray(body?.targets) && body.targets.length === 0) return null;
    const { itemParts: _p, ...rest } = s;
    return { ...rest, params: params as StepSpec['params'] } as StepSpec;
  });
  // 2. A Last Major Revision step keeps the writes it follows that stay, and the evidence of kept items; with none left
  // it goes, and so does the write it decides. Repeated until nothing more goes.
  const keepStep = partsDone.map((s) => s !== null);
  const lmrBody = new Map<number, Obj>();
  let changed = true;
  while (changed) {
    changed = false;
    partsDone.forEach((s, i) => {
      if (!s || !keepStep[i]) return;
      if (s.op === LMR_STEP) {
        const body = (s.params?.body ?? {}) as Obj;
        const after = ((body.after as number[] | undefined) ?? []).filter((n) => keepStep[n - 1] === true);
        if (after.length === 0) {
          keepStep[i] = false;
          changed = true;
          return;
        }
        const measure = isObj(body.measure) ? body.measure : null;
        const known = Array.isArray(measure?.known)
          ? (measure.known as Obj[]).filter((e) => typeof e.item !== 'string' || kept.has(e.item))
          : undefined;
        lmrBody.set(i, {
          ...body,
          after,
          ...(measure ? { measure: { ...measure, ...(known ? { known } : {}) } } : {}),
        });
      }
      if (s.decisionFrom && keepStep[s.decisionFrom.step - 1] !== true) {
        keepStep[i] = false;
        changed = true;
      }
    });
  }
  // 3. Re-anchoring: where each page the plan no longer makes would have stood.
  const droppedSlots = new Map<string, Slot>();
  const placements = new Map<string, { after: string | null; before: string | null }>();
  steps.forEach((s, i) => {
    const body = (s.params?.body ?? null) as Obj | null;
    if (body && s.op === VERIFY_STEP && Array.isArray(body.targets))
      for (const t of body.targets as Obj[]) {
        const p = isObj(t.placement) ? t.placement : null;
        if (p && typeof t.resourceId === 'string')
          placements.set(t.resourceId, {
            after: typeof p.after === 'string' ? p.after : null,
            before: typeof p.before === 'string' ? p.before : null,
          });
      }
    if (keepStep[i]) return;
    if (body && CREATE_OPS.has(s.op) && typeof body.id === 'string')
      droppedSlots.set(body.id, {
        ...(typeof body.after === 'string' ? { after: body.after } : {}),
        ...(typeof body.before === 'string' ? { before: body.before } : {}),
      });
  });
  const reanchor = (slot: Slot): Slot => {
    let key: 'after' | 'before' | null = slot.after ? 'after' : slot.before ? 'before' : null;
    let id = slot.after ?? slot.before ?? null;
    for (let n = 0; key && id && droppedSlots.has(id) && n < 1000; n++) {
      const s = droppedSlots.get(id)!;
      key = s.after ? 'after' : s.before ? 'before' : null;
      id = s.after ?? s.before ?? null;
    }
    return key && id ? { [key]: id } : {};
  };
  const neighbour = (id: string | null, side: 'after' | 'before'): string | null => {
    let cur = id;
    for (let n = 0; cur && droppedSlots.has(cur) && n < 1000; n++) cur = placements.get(cur)?.[side] ?? null;
    return cur;
  };
  // 4. Re-numbering, re-chaining, and every other reference checked.
  const newNo = new Map<number, number>();
  let n = 0;
  keepStep.forEach((k, i) => {
    if (k) newNo.set(i + 1, ++n);
  });
  /**
   * An If-Match link to a dropped write follows that write's own link, and so on, to the first kept step: the link
   * that points into it (its step, and the key of a check's versions when it has one). Null: the chain's root went too.
   */
  const rechain = (link: NonNullable<StepSpec['ifMatchFrom']>): StepSpec['ifMatchFrom'] | null => {
    let cur: StepSpec['ifMatchFrom'] | undefined = link;
    for (let guard = 0; cur && guard < 10_000; guard++) {
      if (newNo.has(cur.step)) return cur;
      cur = steps[cur.step - 1]?.ifMatchFrom;
    }
    return null;
  };
  const out: StepSpec[] = [];
  const from: number[] = [];
  partsDone.forEach((s0, i) => {
    if (!s0 || !keepStep[i]) return;
    let s: StepSpec = s0;
    if (lmrBody.has(i)) s = { ...s, params: { ...s.params, body: lmrBody.get(i) } };
    // The If-Match chain re-chained past dropped writes, as if they had never been planned.
    if (s.ifMatchFrom && !newNo.has(s.ifMatchFrom.step)) {
      const link = rechain(s.ifMatchFrom);
      const { ifMatchFrom: _drop, ...rest } = s;
      s = link ? ({ ...rest, ifMatchFrom: link } as StepSpec) : (rest as StepSpec);
    }
    // A Last Major Revision step's row chain through a dropped write: it reads the rows itself instead.
    if (s.op === LMR_STEP) {
      const body = (s.params?.body ?? {}) as Obj;
      if (typeof body.chainFrom === 'number' && !newNo.has(body.chainFrom)) {
        const { chainFrom: _c, rowId: _r, ...rest } = body;
        s = { ...s, params: { ...s.params, body: rest } };
      }
    }
    for (const r of stepRefs(s))
      if (!newNo.has(r.step))
        throw new ItemFilterError(
          `Step ${i + 1} (${s.op}) needs step ${r.step} (${steps[r.step - 1]?.op ?? '?'}), which belongs only to items left out: the plan's items do not say so. Nothing was approved.`,
        );
    s = mapStepRefs(s, (x) => newNo.get(x)!);
    // A new page (or a move) placed beside a page no longer made takes its place.
    const body = (s.params?.body ?? null) as Obj | null;
    if (body && (CREATE_OPS.has(s.op) || s.op === 'moveResource')) {
      const slot: Slot = {
        ...(typeof body.after === 'string' ? { after: body.after } : {}),
        ...(typeof body.before === 'string' ? { before: body.before } : {}),
      };
      if ((slot.after && droppedSlots.has(slot.after)) || (slot.before && droppedSlots.has(slot.before))) {
        const { after: _a, before: _b, ...rest } = body;
        s = { ...s, params: { ...s.params, body: { ...rest, ...reanchor(slot) } } };
      }
    }
    // Links, routing lines and mentions of a page no longer made (soft references) go with it.
    if (droppedSlots.size > 0 && s.params) {
      const gone = new Set(droppedSlots.keys());
      s = { ...s, params: withoutRefsTo(s.params, gone) as NonNullable<StepSpec['params']> };
    }
    // A read-back's expected neighbours: the next pages that are still made.
    const vbody = (s.params?.body ?? null) as Obj | null;
    if (s.op === VERIFY_STEP && vbody && Array.isArray(vbody.targets) && droppedSlots.size > 0) {
      s = {
        ...s,
        params: {
          ...s.params,
          body: {
            ...vbody,
            targets: (vbody.targets as Obj[]).map((t) => {
              const p = isObj(t.placement) ? t.placement : null;
              if (!p) return t;
              const after = neighbour(typeof p.after === 'string' ? p.after : null, 'after');
              const before = neighbour(typeof p.before === 'string' ? p.before : null, 'before');
              return { ...t, placement: { ...p, after, before } };
            }),
          },
        },
      };
    }
    out.push(s);
    from.push(i + 1);
  });
  return { steps: out, from, notCreated: [...droppedSlots.keys()] };
}
