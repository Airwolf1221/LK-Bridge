/**
 * v3 F3d (renames), ADR 0058 (the owner-approved design docs/design/F3d-renames.md, section 2, decision D5): a package's
 * plan as ITEMS the owner can approve one by one, for F3a's and F3b's packages (a character, an owner, a relationship,
 * art):
 *
 * - **each new page**: made from its template, its tags, facts, text, Last Major Revision and read-back, the images it
 *   shows, and the taxonomy entry it records (a new race's navigation index);
 * - **each existing page the package changes**: its facts and links, an upgrade to a Core, its routing lines, the images
 *   added to it, a move under a new index (one item per page: a page's changes are planned together, and its sidebar
 *   rows are written in one checked chain).
 *
 * Every step names its item; the read-back's targets too. The dependencies the steps imply are added
 * (`withStepDependencies`): a page under a new index needs the index, a link or a routing line naming a new page needs
 * that page, an Art page needs the images it shows (they are its item). Everything starts ticked, so a package approved
 * whole runs exactly the steps it always did. A package whose steps cannot all be placed in an item is not itemized
 * (approved whole, as before), never guessed.
 */
import { EXPECT_STEP, LMR_STEP, RECORD_STEP, VERIFY_STEP } from '../../jobs/internal-steps.js';
import { withStepDependencies, type PlanItem } from '../../jobs/items.js';
import type { StepSpec } from '../../jobs/index.js';
import type { PackJob } from './job.js';
import type { PackPlan } from './plan.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const NEW_PAGES = 'New pages';
const EXISTING = 'Changes to existing pages';

/** The steps tagged with their items, and the items; `items` null when the package is not itemized. */
export function itemizePackage(
  plan: PackPlan,
  job: PackJob,
): { readonly steps: StepSpec[]; readonly items: PlanItem[] | null } {
  const steps = job.steps;
  const newIds = new Set(plan.pages.map((p) => p.id));
  const itemOf = (resourceId: string) =>
    newIds.has(resourceId) ? `page:${resourceId}` : `existing:${resourceId}`;
  const tags: (string[] | null)[] = steps.map(() => null);
  // The images: each one's folders, upload, asset and stored-file check go with the page that shows it.
  steps.forEach((s, i) => {
    if (s.op !== 'createImageAsset') return;
    const assetStep = i + 1;
    const shower = steps.find((x) => (x.bindAssetUrls ?? []).some((b) => b.step === assetStep));
    const rid = str(shower?.params?.path?.resourceId);
    if (!rid) return;
    const item = itemOf(rid);
    tags[i] = [item];
    if (steps[i - 1]?.op === 'upload_image.put') tags[i - 1] = [item];
    if (steps[i - 2]?.op === 'createImageUpload') tags[i - 2] = [item];
    for (let k = i - 3; k >= 0 && steps[k]?.op === 'createAssetFolder' && tags[k] === null; k--)
      tags[k] = [item];
    const verify = steps[i + 1];
    if (verify?.op === 'upload_image.verify') tags[i + 1] = [item];
  });
  const parts: (StepSpec['itemParts'] | null)[] = steps.map(() => null);
  let unplaced = false;
  steps.forEach((s, i) => {
    if (tags[i] !== null) return;
    const body = (s.params?.body ?? null) as Obj | null;
    const rid = str(s.params?.path?.resourceId);
    if ((s.op === 'createResourceFromTemplate' || s.op === 'createResource') && str(body?.id)) {
      tags[i] = [itemOf(body!.id as string)];
    } else if (s.op === EXPECT_STEP) {
      if (i === 0) return; // the package's own check (governance, absent): shared
      const checks = Array.isArray(body?.checks) ? (body.checks as Obj[]) : [];
      const ids = [...new Set(checks.map((c) => str(c.resourceId)).filter((x): x is string => x !== null))];
      if (ids.length === 0) unplaced = true;
      else tags[i] = ids.map(itemOf);
    } else if (s.op === VERIFY_STEP) {
      const targets = Array.isArray(body?.targets) ? (body.targets as Obj[]) : [];
      parts[i] = [
        {
          path: 'body.targets',
          items: targets.map((t) => {
            const r = str(t.resourceId);
            if (r) return [itemOf(r)];
            const from = isObj(t.assetFrom) && typeof t.assetFrom.step === 'number' ? t.assetFrom.step : null;
            return from !== null ? (tags[from - 1] ?? []) : [];
          }),
        },
      ];
    } else if (s.op === LMR_STEP) {
      const r = str(body?.resourceId);
      if (r) tags[i] = [itemOf(r)];
      else unplaced = true;
    } else if (s.op === RECORD_STEP) {
      const record = isObj(body?.record) ? body.record : {};
      const r = str(record.resourceId);
      if (r) tags[i] = [itemOf(r)];
      else unplaced = true;
    } else if (rid) {
      tags[i] = [itemOf(rid)];
    } else if (!s.op.startsWith('bridge.')) {
      unplaced = true;
    }
  });
  if (unplaced) return { steps, items: null };

  const items: PlanItem[] = [];
  for (const p of plan.pages) {
    const images = p.images.map((im) => im.name);
    const facts = p.factValues.map((f) => ({ what: f.key, before: null, after: f.value }));
    items.push({
      id: `page:${p.id}`,
      kind: p.kind === 'index' ? 'new_index' : 'new_page',
      group: NEW_PAGES,
      label: `New page ${p.rawName} under ${p.parentName}${images.length ? ` (with ${images.length} image${images.length === 1 ? '' : 's'})` : ''}`,
      page: { id: p.id, name: p.rawName },
      diff: {
        after: (p.markdown ?? '').slice(0, 8000),
        changes: [
          ...facts,
          ...(p.tags && p.tags.length > 0 ? [{ what: 'tags', before: null, after: p.tags.join(', ') }] : []),
          ...images.map((n) => ({ what: 'image', before: null, after: n })),
        ],
      },
      dependsOn: [],
      selected: true,
    });
  }
  const byPage = new Map<
    string,
    { name: string; said: string[]; changes: NonNullable<PlanItem['diff']>['changes'] }
  >();
  const note = (
    id: string,
    name: string,
    said: string,
    changes: NonNullable<PlanItem['diff']>['changes'] = [],
  ) => {
    const e = byPage.get(id) ?? { name, said: [], changes: [] };
    e.said.push(said);
    e.changes = [...(e.changes ?? []), ...(changes ?? [])];
    byPage.set(id, e);
  };
  for (const c of plan.existing) {
    if (c.kind === 'move') note(c.page.id, c.page.rawName, `moved under ${c.toName} (id kept)`);
    else if (c.kind === 'rename')
      note(c.page.id, c.from, `renamed to ${c.to} (its Character Core)`, [
        { what: 'name', before: c.from, after: c.to },
      ]);
    else if (c.kind === 'facts')
      note(
        c.page.id,
        c.page.rawName,
        c.why.join('; '),
        c.plan.facts
          .filter((f) => f.change !== 'unchanged' && f.change !== 'not_present')
          .map((f) => ({ what: f.key, before: f.before, after: f.after })),
      );
    else if (c.kind === 'routing')
      note(
        c.page.id,
        c.page.rawName,
        c.what ?? `${c.section}: ${c.lines.length} line(s) added`,
        c.lines.map((l) => ({ what: c.section, before: null, after: l })),
      );
    else if (c.kind === 'images')
      note(
        c.page.id,
        c.page.rawName,
        `${c.section}: ${c.images.length} image(s) added`,
        c.images.map((im) => ({ what: 'image', before: null, after: im.name })),
      );
  }
  for (const [id, e] of byPage)
    items.push({
      id: `existing:${id}`,
      kind: 'page_change',
      group: EXISTING,
      label: `${e.name}: ${e.said.join('; ')}`,
      page: { id, name: e.name },
      diff: { changes: e.changes ?? [] },
      dependsOn: [],
      selected: true,
    });
  // A new character's set: its index is made for its identity page (the Core, or the Compact Reference), so the two are
  // one item, and every other new page hangs off it (the design: "unticking a character's Core in a package drops the
  // pages that hang off it").
  const identity =
    plan.mode === 'new' ? plan.pages.find((p) => p.role === 'core' || p.role === 'compact') : undefined;
  if (identity) {
    const parentKey = 'item' in identity.parent ? identity.parent.item : null;
    const index = parentKey ? plan.pages.find((p) => p.kind === 'index' && p.key === parentKey) : undefined;
    const idItem = `page:${identity.id}`;
    if (index) {
      const ixItem = `page:${index.id}`;
      const swap = (l: string[]) => [...new Set(l.map((x) => (x === ixItem ? idItem : x)))];
      for (let i = 0; i < tags.length; i++) if (tags[i]) tags[i] = swap(tags[i]!);
      for (let i = 0; i < parts.length; i++)
        if (parts[i]) parts[i] = parts[i]!.map((pt) => ({ ...pt, items: pt.items.map((x) => swap([...x])) }));
      const at = items.findIndex((i) => i.id === ixItem);
      const ixDiff = at >= 0 ? items[at]!.diff : undefined;
      if (at >= 0) items.splice(at, 1);
      const me = items.findIndex((i) => i.id === idItem);
      if (me >= 0)
        items[me] = {
          ...items[me]!,
          kind: 'new_character',
          label: `New character ${plan.subject}: ${index.rawName} with ${identity.rawName} under ${index.parentName}`,
          diff: {
            ...items[me]!.diff,
            changes: [
              { what: 'index', before: null, after: index.rawName },
              ...(items[me]!.diff?.changes ?? []),
              ...(ixDiff?.after ? [{ what: 'index text', before: null, after: ixDiff.after }] : []),
            ],
          },
        };
    }
    for (let k = 0; k < items.length; k++) {
      const it = items[k]!;
      if (it.id !== idItem && it.id.startsWith('page:'))
        items[k] = { ...it, dependsOn: [...new Set([...it.dependsOn, idItem])] };
    }
  }
  const known = new Set(items.map((i) => i.id));
  // A step tagged with a page the plan does not list (it should not happen): the package is approved whole instead.
  if (tags.some((t) => t !== null && t.some((x) => !known.has(x)))) return { steps, items: null };
  const tagged = steps.map((s, i) => ({
    ...s,
    ...(tags[i] ? { items: tags[i]! } : {}),
    ...(parts[i] ? { itemParts: parts[i]! } : {}),
  }));
  // A change to an existing page made for new pages (a routing line, a link) needs them; between new pages, a link or
  // a line is soft (removed when its page is left out).
  return {
    steps: tagged,
    items: withStepDependencies(items, tagged, { all: (id) => id.startsWith('existing:') }),
  };
}
