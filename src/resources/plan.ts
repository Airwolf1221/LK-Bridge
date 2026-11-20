/**
 * Planning creates (v2 C2b, ADR 0034): where every new page goes, in which write, with which neighbour, for one page or
 * a nested batch of up to 100. Pure: it reads the repository tree's sibling lists through `children` and makes no
 * request.
 *
 * - **Order** (PLAN-v2 4.5): `[INDEX]` pages, then `[BSRC]`, then unclassified, each alphabetical (A3's
 *   `compareSiblings`). Every new page gets its place in the write that creates it: `after` / `before` an existing
 *   sibling (A3's `slotAmong`, so it lands next to its correct neighbour even among siblings out of order), or, under a
 *   parent made in the same `createManyResources` call (which allows no anchor there), by being created in sorted order.
 * - **Writes**: a page from a template is one `createResourceFromTemplate`; pages without one are one `createResource`
 *   (a single page) or one `createManyResources` call per run of them (a batch). Parents always come first: the items
 *   are taken depth-first, siblings sorted, and the run of plain pages is sent before a template page that needs one of
 *   them as its parent.
 * - **Within one batch call** anchors may only name pages that exist before the call. Several pages anchored `after`
 *   the same sibling go in reverse order (each lands right after it), several anchored `before` one in order, so they
 *   end up alphabetical.
 * - **Neighbours**: the plan simulates every insertion on the sibling lists, so the verify step can check each page's
 *   final neighbours (by rank) exactly.
 */
import { compareSiblings, slotAmong, type Orderable, type SiblingCompare } from '../registry/ordering.js';
import type { ResolveKind, Slot } from '../registry/index.js';

/** A sibling as the simulation holds it. */
export interface SimNode extends Orderable {
  readonly isNew?: boolean;
}

/** The sibling lists of the parents a plan touches, in position order, with the plan's insertions applied. */
export class SiblingSim {
  private readonly lists = new Map<string, SimNode[]>();

  constructor(
    private readonly children: (parentId: string) => readonly Orderable[],
    /** v3 F4c (ADR 0065): a parent's own sibling order (Narratives', design E1); null: the ordinary rule. */
    private readonly orderFor: (parentId: string) => SiblingCompare | null = () => null,
  ) {}

  /** The order of a parent's children. */
  compareFor(parentId: string): SiblingCompare {
    return this.orderFor(parentId) ?? compareSiblings;
  }

  list(parentId: string): SimNode[] {
    let l = this.lists.get(parentId);
    if (!l) {
      l = this.children(parentId).map((c) => ({ id: c.id, displayName: c.displayName, kind: c.kind }));
      this.lists.set(parentId, l);
    }
    return l;
  }

  /** Where `page` goes among the siblings that exist (`anchorable`), as one neighbour. */
  slot(
    parentId: string,
    page: Pick<Orderable, 'displayName' | 'kind'>,
    anchorable: (n: SimNode) => boolean = () => true,
    excludeId?: string,
  ): Slot {
    const sibs = this.list(parentId).filter((s) => s.id !== excludeId && anchorable(s));
    return slotAmong(sibs, page.displayName, page.kind as ResolveKind, this.compareFor(parentId));
  }

  /** Puts `page` where LegendKeeper will put it for `slot` (no slot: at the end). */
  insert(parentId: string, page: SimNode, slot: Slot): void {
    const l = this.list(parentId);
    const at = l.findIndex((s) => s.id === page.id);
    if (at >= 0) l.splice(at, 1);
    if (slot.after !== undefined) {
      const i = l.findIndex((s) => s.id === slot.after);
      l.splice(i < 0 ? l.length : i + 1, 0, page);
    } else if (slot.before !== undefined) {
      const i = l.findIndex((s) => s.id === slot.before);
      l.splice(i < 0 ? l.length : i, 0, page);
    } else l.push(page);
  }

  remove(parentId: string, id: string): void {
    const l = this.list(parentId);
    const i = l.findIndex((s) => s.id === id);
    if (i >= 0) l.splice(i, 1);
  }

  /** The page's neighbours in position order (null: none on that side). */
  neighbours(parentId: string, id: string): { after: string | null; before: string | null } {
    const l = this.list(parentId);
    const i = l.findIndex((s) => s.id === id);
    return { after: i > 0 ? l[i - 1]!.id : null, before: i >= 0 && i + 1 < l.length ? l[i + 1]!.id : null };
  }
}

/** One page to create. */
export interface CreateItem {
  /** The caller's key (create_many_resources), or a fixed one for a single create. */
  readonly key: string;
  /** The client id minted for it (the bridge mints every new page's id). */
  readonly id: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: ResolveKind;
  /** An existing page, or another item of the same request (by key). */
  readonly parent: { readonly existing: string } | { readonly item: string };
  readonly templateId: string | null;
}

export type PlannedStep<T extends CreateItem = CreateItem> =
  | { readonly kind: 'template'; readonly item: T; readonly parentId: string; readonly slot: Slot }
  | { readonly kind: 'single'; readonly item: T; readonly parentId: string; readonly slot: Slot }
  | {
      readonly kind: 'batch';
      readonly items: readonly { readonly item: T; readonly parentId: string; readonly slot: Slot }[];
    };

export interface CreatePlan<T extends CreateItem = CreateItem> {
  readonly steps: readonly PlannedStep<T>[];
  /** Each new page's parent and final neighbours, by its id. */
  readonly placement: ReadonlyMap<
    string,
    { readonly parentId: string; readonly after: string | null; readonly before: string | null }
  >;
}

export class CreatePlanError extends Error {
  override readonly name = 'CreatePlanError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** The items parents-first, depth-first, each parent's new children in sibling order. Refuses unknown keys and loops. */
export function orderItems<T extends CreateItem>(
  items: readonly T[],
  /** v3 F4c: the order of a parent's children (by the parent's id); default the ordinary rule. */
  compareFor: (parentId: string) => SiblingCompare = () => compareSiblings,
): T[] {
  const byKey = new Map<string, T>();
  for (const it of items) {
    if (byKey.has(it.key)) throw new CreatePlanError('INVALID_ITEMS', `The key “${it.key}” is used twice.`);
    byKey.set(it.key, it);
  }
  for (const it of items) {
    if ('item' in it.parent && !byKey.has(it.parent.item)) {
      throw new CreatePlanError(
        'PARENT_KEY_NOT_FOUND',
        `“${it.key}” names parent_key “${it.parent.item}”, which is not the key of an item of this request.`,
        { key: it.key, parent_key: it.parent.item },
      );
    }
  }
  // A loop: following parent keys from any item must reach an existing page.
  for (const it of items) {
    const seen = new Set<string>([it.key]);
    for (let cur: T | undefined = it; cur && 'item' in cur.parent;) {
      const next: T | undefined = byKey.get(cur.parent.item);
      if (!next) break;
      if (seen.has(next.key)) {
        throw new CreatePlanError(
          'PARENT_KEY_LOOP',
          `The parent keys of “${it.key}” go round in a loop (${[...seen].join(' → ')} → ${next.key}).`,
          { key: it.key },
        );
      }
      seen.add(next.key);
      cur = next;
    }
  }
  const kids = new Map<string, T[]>();
  const roots = new Map<string, T[]>();
  for (const it of items) {
    if ('item' in it.parent) kids.set(it.parent.item, [...(kids.get(it.parent.item) ?? []), it]);
    else roots.set(it.parent.existing, [...(roots.get(it.parent.existing) ?? []), it]);
  }
  const sorted = (l: readonly T[], parentId: string) => {
    const cmp = compareFor(parentId);
    return [...l].sort((a, b) => cmp(a, b));
  };
  const out: T[] = [];
  const visit = (it: T) => {
    out.push(it);
    for (const c of sorted(kids.get(it.key) ?? [], it.id)) visit(c);
  };
  for (const [parentId, group] of roots) for (const it of sorted(group, parentId)) visit(it);
  return out;
}

/**
 * The writes for `items` (see the module comment). `batch`: plain pages go in `createManyResources` calls (else each
 * is one `createResource`). `sim` holds the sibling lists and gets every insertion.
 */
export function planCreates<T extends CreateItem>(
  items: readonly T[],
  sim: SiblingSim,
  o: { readonly batch: boolean },
): CreatePlan<T> {
  const ordered = orderItems(items, (parentId) => sim.compareFor(parentId));
  const byKey = new Map(ordered.map((it) => [it.key, it]));
  const parentOf = (it: T) => ('item' in it.parent ? byKey.get(it.parent.item)!.id : it.parent.existing);
  const created = new Set<string>(); // ids created by an earlier step
  const steps: PlannedStep<T>[] = [];
  const node = (it: T): SimNode => ({ id: it.id, displayName: it.displayName, kind: it.kind, isNew: true });
  const exists = (n: SimNode) => !n.isNew || created.has(n.id);

  let pending: T[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const inCall = new Set(pending.map((p) => p.id));
    // Anchors are worked out on the siblings as they are before the call; then the call is ordered so pages sharing an
    // anchor end up alphabetical.
    const outside: { item: T; parentId: string; slot: Slot }[] = [];
    const inside: { item: T; parentId: string; slot: Slot }[] = [];
    for (const it of pending) {
      const parentId = parentOf(it);
      if (inCall.has(parentId)) inside.push({ item: it, parentId, slot: {} });
      else outside.push({ item: it, parentId, slot: sim.slot(parentId, it, exists) });
    }
    const groups = new Map<string, { item: T; parentId: string; slot: Slot }[]>();
    for (const x of outside) {
      const k = `${x.parentId}|${x.slot.after ? `a:${x.slot.after}` : x.slot.before ? `b:${x.slot.before}` : 'end'}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    const callOrder: { item: T; parentId: string; slot: Slot }[] = [];
    for (const g of groups.values())
      callOrder.push(...(g[0]!.slot.after !== undefined ? [...g].reverse() : g));
    callOrder.push(...inside);
    for (const x of callOrder) sim.insert(x.parentId, node(x.item), x.slot);
    for (const x of callOrder) created.add(x.item.id);
    if (o.batch) steps.push({ kind: 'batch', items: callOrder });
    else for (const x of callOrder) steps.push({ kind: 'single', ...x });
    pending = [];
  };

  for (const it of ordered) {
    if (it.templateId === null) {
      // Without the batch, every plain page is its own write, so it may anchor to pages made just before it.
      if (!o.batch) {
        const parentId = parentOf(it);
        const slot = sim.slot(parentId, it, exists);
        sim.insert(parentId, node(it), slot);
        created.add(it.id);
        steps.push({ kind: 'single', item: it, parentId, slot });
      } else pending.push(it);
      continue;
    }
    // A template page is its own write; whatever it needs (its parent, siblings before it) is sent first.
    flush();
    const parentId = parentOf(it);
    const slot = sim.slot(parentId, it, exists);
    sim.insert(parentId, node(it), slot);
    created.add(it.id);
    steps.push({ kind: 'template', item: it, parentId, slot });
  }
  flush();
  const placement = new Map<string, { parentId: string; after: string | null; before: string | null }>();
  for (const it of ordered) {
    const parentId = parentOf(it);
    placement.set(it.id, { parentId, ...sim.neighbours(parentId, it.id) });
  }
  return { steps, placement };
}
