/**
 * v3 F7d (ADR 0077, A3, A5): a groups call's proposal as ITEMS the owner approves one by one, in this order:
 *
 * 1. **"Art page"** (only when the call makes it): the page from its template (its facts, the identity copies, its
 *    links, tags and text), the Compact Reference's upgrade to a Core when the Core rule needs it, the identity check;
 * 2. **"Design pieces"**: their folders, uploads and stored-file checks;
 * 3. **one item per outfit**: its folders, uploads, the moves of its loose pieces and its outfit record.
 *
 * Every other item depends on "Art page" when that item exists (approving an outfit without it is refused, with the
 * reason, by the proposal's own selection rule). The Art page's ONE write and the sidebar are shared: an image whose
 * group is not approved is left off the page (its binding and blocks dropped by the item filter, as a withdrawn
 * image's are) and stays staged. The bridge's own checks, the read-back (each target with its group) and the report
 * are shared.
 */
import { RECORD_STEP, VERIFY_STEP, EXPECT_STEP } from '../jobs/internal-steps.js';
import { withStepDependencies, type PlanItem } from '../jobs/items.js';
import type { StepSpec } from '../jobs/index.js';
import type { PackJob } from './engine/job.js';
import type { PackPlan } from './engine/plan.js';
import { coreTextChanges, coreTextWords } from './engine/core.js';
import { textChangeEntry } from '../jobs/items.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export const ART_PAGE_ITEM = 'art:page';
export const artItemOf = (groupKey: string): string => `art:${groupKey}`;

/** v3 F7d (A5): the job's cost, from its steps: LegendKeeper writes, image uploads, and the reads it makes (an estimate). */
export function artJobCost(job: PackJob, planReads: number): Obj {
  let reads = 0;
  let uploads = 0;
  for (const s of job.steps) {
    const body = (s.params?.body ?? {}) as Obj;
    if (s.op === EXPECT_STEP) reads += Array.isArray(body.checks) ? body.checks.length : 0;
    else if (s.op === VERIFY_STEP) reads += Array.isArray(body.targets) ? body.targets.length : 0;
    else if (s.op === 'createImageUpload') uploads++;
    else if (s.op === 'upload_image.verify') reads++;
    else if (s.op === 'createAssetFolder' && s.findOrCreate) reads++;
    else if (s.op === 'bridge.lmr') reads++;
    if (s.op === 'replaceDocumentBlocks')
      reads += (s.fill || s.judgedInLock ? 1 : 0) + (s.verifyAfterWrite ? 1 : 0);
  }
  return {
    planning: { reads: planReads },
    job: { reads, writes: job.writes, uploads },
    note: 'The job’s reads are an estimate (each check, each read-back, the reads inside its locks); its writes and uploads are exact. The governor paces them; a long wait parks the job, which resumes where it stopped without uploading again.',
  };
}

/** The steps tagged with their items, and the items (null: the package is approved whole). */
export function itemizeArtGroups(
  plan: PackPlan,
  job: PackJob,
): { readonly steps: StepSpec[]; readonly items: PlanItem[] | null } {
  const art = plan.art;
  if (!art?.groupOf) return { steps: job.steps, items: null };
  const groupOf = art.groupOf;
  const pageNew = plan.pages.length > 0;
  const newIds = new Set(plan.pages.map((p) => p.id));
  // The pages the "Art page" item changes besides the new page: the upgrade's (the identity page, its index).
  const upgradeIds = new Set(
    plan.existing
      .filter((c) => c.kind !== 'images' && !(c.kind === 'facts' && c.late === true))
      .map((c) => c.page.id),
  );
  const outfitKeyByName = new Map((art.outfits ?? []).map((o) => [o.name, o.key]));
  const groupItem = (stagedId: string): string | null => {
    const g = groupOf[stagedId];
    return g ? artItemOf(g) : null;
  };
  const fromKeys = (keys: readonly string[] | undefined): string | null => {
    for (const k of keys ?? []) {
      const id = k.startsWith('folder:') ? k.slice('folder:'.length) : k;
      const g = groupItem(id);
      if (g) return g;
    }
    return null;
  };
  const pageItem = pageNew ? ART_PAGE_ITEM : null;
  const tags: (string[] | null)[] = job.steps.map(() => null);
  const parts: (StepSpec['itemParts'] | null)[] = job.steps.map(() => null);
  job.steps.forEach((s, i) => {
    const byKeys = fromKeys(s.withdrawWith);
    if (byKeys) {
      tags[i] = [byKeys];
      return;
    }
    const body = (s.params?.body ?? null) as Obj | null;
    const rid = str(s.params?.path?.resourceId) ?? str(body?.resourceId) ?? str(body?.id);
    if (s.op === RECORD_STEP) {
      const r = isObj(body?.record) ? body.record : {};
      if (r.kind === 'art_outfit') {
        const k = outfitKeyByName.get(String(r.outfit));
        if (k) tags[i] = [artItemOf(k)];
      } else if (r.kind !== 'art_groups' && pageItem) tags[i] = [pageItem];
      return;
    }
    if (s.op === VERIFY_STEP) {
      const targets = Array.isArray(body?.targets) ? (body.targets as Obj[]) : [];
      parts[i] = [
        {
          path: 'body.targets',
          items: targets.map((t) => {
            const from = isObj(t.assetFrom) && typeof t.assetFrom.step === 'number' ? t.assetFrom.step : null;
            if (from !== null) return tags[from - 1] ?? [];
            const w = Array.isArray(t.withdrawnWith) ? fromKeys(t.withdrawnWith as string[]) : null;
            if (w) return [w];
            const r = str(t.resourceId);
            if (r && pageItem && (newIds.has(r) || upgradeIds.has(r))) return [pageItem];
            return [];
          }),
        },
      ];
      return;
    }
    if (s.op === EXPECT_STEP) {
      if (i === 0 || !pageItem) return;
      const checks = Array.isArray(body?.checks) ? (body.checks as Obj[]) : [];
      // The new page's identity check, and the upgrade's own checks, go with the "Art page" item.
      if (
        checks.some(
          (c) =>
            str(c.resourceId) &&
            (newIds.has(String(c.resourceId)) ||
              upgradeIds.has(String(c.resourceId)) ||
              c.label?.toString().endsWith(': identity')),
        )
      )
        tags[i] = [pageItem];
      return;
    }
    if (rid && pageItem && (newIds.has(rid) || upgradeIds.has(rid))) {
      tags[i] = [pageItem];
      return;
    }
  });

  const items: PlanItem[] = [];
  const dep = pageItem ? [pageItem] : [];
  if (pageItem) {
    const p = plan.pages.find((x) => x.role === plan.type.assets.role) ?? plan.pages[0]!;
    const upgrade = plan.existing.filter((c) => c.kind === 'rename' || c.kind === 'core_text');
    items.push({
      id: pageItem,
      kind: 'new_page',
      group: 'Art page',
      label: `Art page: new page ${p.rawName} under ${p.parentName}${upgrade.length ? `, with ${plan.existing.find((c) => c.kind === 'rename')?.page.rawName ?? 'the Compact Reference'} upgraded to its Character Core` : ''}`,
      page: { id: p.id, name: p.rawName },
      diff: {
        after: (p.markdown ?? '').slice(0, 8000),
        changes: [
          ...p.factValues.map((f) => ({ what: f.key, before: null, after: f.value })),
          ...(p.tags && p.tags.length > 0 ? [{ what: 'tags', before: null, after: p.tags.join(', ') }] : []),
          ...p.linkTargets.map((l) => ({
            what: l.title,
            before: null,
            after: l.targets.map((t) => t.name).join(', '),
          })),
          ...plan.existing.flatMap((c): NonNullable<NonNullable<PlanItem['diff']>['changes']>[number][] =>
            c.kind === 'rename'
              ? [{ what: 'name', before: c.from, after: c.to }]
              : c.kind === 'core_text'
                ? [
                    { what: c.page.rawName, before: null, after: coreTextWords(c) },
                    ...coreTextChanges(c).map(textChangeEntry),
                  ]
                : [],
          ),
        ],
      },
      dependsOn: [],
      selected: true,
    });
  }
  for (const g of art.report ?? []) {
    const id = artItemOf(g.key);
    const outfit = (art.outfits ?? []).find((o) => o.key === g.key);
    const images = plan.images.filter((im) => groupOf[im.stagedId] === g.key);
    const where = images[0]?.path.join(' / ') ?? '';
    items.push({
      id,
      kind: outfit ? 'art_outfit' : 'art_design',
      group: outfit ? 'Outfits' : 'Design pieces',
      label: outfit
        ? `Outfit ${outfit.name}: ${images.length} image${images.length === 1 ? '' : 's'} into ${where}${outfit.moves.length ? `; ${outfit.moves.map((m) => `“${m.name}”`).join(', ')} moved in` : ''}`
        : `Design pieces: ${images.length} image${images.length === 1 ? '' : 's'} into ${where}`,
      page: null,
      diff: {
        changes: [
          ...images.map((im) => ({
            what: 'image',
            before: null,
            after: `${im.name} (${im.path.join(' / ')})`,
          })),
          ...(outfit?.moves ?? []).map((m) => ({
            what: 'move',
            before: m.fromPath,
            after: `${m.name} → ${outfit!.toPath}`,
          })),
        ],
      },
      dependsOn: dep,
      selected: true,
    });
  }
  const known = new Set(items.map((i) => i.id));
  if (tags.some((t) => t !== null && t.some((x) => !known.has(x)))) return { steps: job.steps, items: null };
  const tagged = job.steps.map((s, i) => ({
    ...s,
    ...(tags[i] ? { items: tags[i] } : {}),
    ...(parts[i] ? { itemParts: parts[i] } : {}),
  }));
  return { steps: tagged, items: withStepDependencies(items, tagged) };
}
