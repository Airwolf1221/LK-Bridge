/**
 * A package's ONE job (v3 F3a, ADR 0050): the plan (src/packs/engine/plan.ts) as steps, in this order, so a stop part-way
 * never leaves a page that claims more than it holds:
 *
 * 1. `bridge.expect`: the pack's governance is still the approved version (read again: "compare policy version/digest
 *    before writing"), and, for a new subject, nothing of its name appeared since it was planned (the name is reserved
 *    inside the job, atomically, then each planned parent is listed live: CHARACTER_EXISTS otherwise, before any write);
 *    for new pages under existing indexes, no page of their name appeared there (DOMAIN_EXISTS);
 * 2. the index, then the pages from their templates (`createResourceFromTemplate`), each with its computed tags and its
 *    facts (C2b's copy check, bound ids and If-Match chain);
 * 3. changes to existing pages: an upgraded Reference renamed, gate fixes and the Reference Type, the automatic
 *    relationship links, the index's routing lines (append to its section, with the in-lock re-plan);
 * 4. the pages' text (the template copy's body is filled inside the lock: what Markdown cannot express there, such as the
 *    index's Subpages collection, is kept);
 * 5. the images: folders found or created when the job runs, each image uploaded from the bridge's server and its stored
 *    bytes checked; then the Art page's text with each image block bound to its new asset's address;
 * 6. a moved Reference under its new index (last, so its place is worked out among the new pages);
 * 7. Last Major Revision, dated when the job runs, on every page created, and on an existing page the package changes
 *    when the owner's rule (ADR 0051) or the caller's `lastMajorRevision` says so (src/packs/engine/lmr.ts);
 * 8. `bridge.verify`: each page's parent and place, its six gated fields as six checks, its template rows (none added or
 *    dropped), its tags in order, its links, each image's asset; the text writes verify themselves as they go.
 */
import type { FactsPlan, LinkTarget } from '../../facts/plan.js';
import type { SidebarProperty } from '../../facts/sidebar.js';
import { expandFacts } from '../../facts/expand.js';
import { LMR_STEP, VERIFY_STEP, type ExpectCheck, type VerifyTarget } from '../../jobs/internal-steps.js';
import type { StepSpec } from '../../jobs/index.js';
import { stateHash } from '../../jobs/sidebar-state.js';
import { WRITE_PAGE_PLANNER } from '../../pages/index.js';
import { compareSiblings } from '../../registry/ordering.js';
import type { ResolveKind } from '../../registry/index.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import { lmrConfigFrom, textUnits } from '../../lmr/index.js';
import { createMarker, planCreateJob, type Result } from '../../mcp/tools/create-support.js';
import { errorResult } from '../../mcp/tools/shape.js';
import {
  decisionOf,
  editOf,
  keyOf,
  noteFact,
  noteLinks,
  noteNameOrMove,
  type ExistingEdit,
  type LmrDecision,
} from './lmr.js';
import type { PackPlan, PlannedPage } from './plan.js';
import type { PlanEnv } from './plan.js';

type Obj = Record<string, unknown>;

export const PACK_CHECKS = {
  governance: 'pack.governance',
  absent: 'pack.absent',
  page: 'pack.page',
} as const;
export const PACK_FILLER = 'pack.body';
/** v3 F3b (ADR 0052): appends new image sections to an existing Art page inside the lock. */
export const PACK_ART_FILLER = 'pack.art_append';
export const PACK_RECORD_STORE = 'pack';

/** Adds `base` to every step number a step names (its bindings, and the bridge's own steps' references). */
export function shiftStep(s: StepSpec, base: number): StepSpec {
  if (base === 0) return s;
  const out: Record<string, unknown> = { ...s };
  const at = (o: { step: number } | undefined) => (o ? { ...o, step: o.step + base } : undefined);
  if (s.ifMatchFrom) out.ifMatchFrom = at(s.ifMatchFrom);
  if (s.bindIds) out.bindIds = at(s.bindIds);
  if (s.bindBody) out.bindBody = at(s.bindBody);
  if (s.bindFrom) out.bindFrom = at(s.bindFrom);
  if (s.decisionFrom) out.decisionFrom = at(s.decisionFrom);
  if (s.bindAssetUrls) out.bindAssetUrls = s.bindAssetUrls.map((b) => ({ ...b, step: b.step + base }));
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
                  step: x.step + base,
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
        after: (body.after as number[]).map((n) => n + base),
        ...(typeof body.chainFrom === 'number' ? { chainFrom: body.chainFrom + base } : {}),
      },
    };
  } else if (body && s.op === 'upload_image.verify' && typeof body.assetStep === 'number') {
    out.params = { ...s.params, body: { ...body, assetStep: body.assetStep + base } };
  }
  return out as unknown as StepSpec;
}

const isStepRef = (v: unknown): v is { step: number } =>
  typeof v === 'object' && v !== null && typeof (v as { step?: unknown }).step === 'number';

export interface PackJob {
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly operations: Obj[];
  readonly summary: string;
  readonly writes: number;
  /** Each image's createImageAsset step, by staged id (for the staged rows). */
  readonly assetSteps: ReadonlyMap<string, number>;
  /** Each new page's parent and final neighbours (for the preview). */
  readonly placement: ReadonlyMap<string, { parentId: string; after: string | null; before: string | null }>;
  readonly marker: ReturnType<typeof createMarker>;
  /**
   * v3 F3b with ADR 0051 (ADR 0052 decision 14): Last Major Revision. Every page the package makes is dated; each
   * existing page it changes is decided by the owner's rule or the caller's `lastMajorRevision`, and why.
   */
  readonly lmr: {
    readonly mode: LmrMode;
    readonly newPages: readonly string[];
    readonly existing: readonly LmrDecision[];
  };
}

export function buildPackJob(env: PlanEnv, plan: PackPlan): Result<PackJob> {
  const { ctx, tool, pack, type } = env;
  const steps: StepSpec[] = [];
  const labels: string[] = [];
  const operations: Obj[] = [];
  const targets: VerifyTarget[] = [];
  const lmrKey = env.lifecycle.fields.lastMajorRevision;
  const lmrCfg = env.lmr?.config ?? lmrConfigFrom({}, lmrKey);
  const lmrMode: LmrMode = env.lmr?.mode ?? 'auto';
  // The existing pages the package changes, with what the Last Major Revision rule needs to judge each.
  const edits = new Map<string, ExistingEdit>();
  const hasLmrRow = (rows: readonly { readonly key: string }[]) =>
    rows.some((r) => keyOf(r.key) === keyOf(lmrKey));
  /** Whether a page has the row, as the tree last read its sidebar (null: not read). */
  const treeHasRow = (id: string): boolean | null => {
    const sb = ctx.tree.sidebars(ctx.projectId, [id]).data.get(id);
    if (!sb) return null;
    return sb.some((p) => p.kind === 'keyValue' && hasLmrRow(p.rows ?? []));
  };
  const journal = (page: { id: string; name: string } | null, write: string): Obj => ({
    tool,
    pack: pack.id,
    ...(page ? { page } : {}),
    write,
  });

  // 1. The checks inside the job.
  const checks: ExpectCheck[] = [
    {
      label: 'governance',
      kind: 'registered',
      checker: PACK_CHECKS.governance,
      input: {
        packId: pack.id,
        version: pack.version,
        sources: pack.approved?.sources ?? [],
        // CR-2026-11-R2 (R2-29): the tool, so a direct job re-reads its switch when it checks (again) before writing.
        tool,
      },
    },
  ];
  if (
    plan.absent.reservation ||
    plan.absent.under.length > 0 ||
    (plan.absent.reservations?.length ?? 0) > 0 ||
    (plan.absent.present?.length ?? 0) > 0 ||
    (plan.absent.images?.length ?? 0) > 0
  ) {
    checks.push({
      label: 'absent',
      kind: 'registered',
      checker: PACK_CHECKS.absent,
      input: {
        reservation: plan.absent.reservation,
        subject: plan.subject,
        mode: plan.mode,
        under: plan.absent.under,
        type: type.name,
        // v3 F3b (ADR 0052): the owner tools' run-time re-checks (design section 5).
        ...(plan.absent.reservations?.length ? { reservations: plan.absent.reservations } : {}),
        ...(plan.absent.present?.length ? { present: plan.absent.present } : {}),
        ...(plan.absent.kind ? { kind: plan.absent.kind } : {}),
        ...(plan.absent.images?.length ? { images: plan.absent.images } : {}),
        // CR-2026-11-R2 (R2-34): each image's own pending placement proposal this package takes over (a direct job runs
        // before that proposal is withdrawn: it is withdrawn once the job has succeeded).
        ...(plan.takeovers?.length ? { takeovers: plan.takeovers } : {}),
      },
    });
  }
  steps.push({ op: 'bridge.expect', params: { body: { checks } } });
  labels.push('check');

  // 2. The creates, tags and facts (C2b's job, whose step numbers start at 1: shifted after the check).
  const created = plan.pages;
  let placement: PackJob['placement'] = new Map();
  if (created.length > 0) {
    const cj = planCreateJob(ctx, created, { batch: false, tool });
    if (!cj.ok) return cj;
    placement = cj.value.plan.placement;
    const base = steps.length;
    for (const [i, s] of cj.value.job.steps.entries()) {
      if (s.op === VERIFY_STEP) {
        const body = (s.params?.body ?? {}) as { targets?: VerifyTarget[] };
        for (const t of body.targets ?? []) if (t.kind === 'resource') targets.push(t);
        continue;
      }
      steps.push(withPack(shiftStep(s, base), pack.id));
      labels.push(cj.value.job.labels[i] ?? s.op);
    }
  }
  const createStepOf = new Map<string, number>();
  steps.forEach((s, i) => {
    const b = (s.params?.body ?? {}) as Obj;
    if (s.op === 'createResourceFromTemplate' && typeof b.id === 'string') createStepOf.set(b.id, i + 1);
  });

  // 3. Changes to existing pages.
  // An existing page's facts: verified by its own plan's checks, or, when this job dates the page, by the pack's row
  // check (its other rows as planned, Last Major Revision as dated when the job runs).
  const factChecks: {
    id: string;
    name: string;
    plan: FactsPlan;
    sidebar: readonly SidebarProperty[];
    targets: VerifyTarget[];
  }[] = [];
  for (const c of plan.existing) {
    if (c.kind === 'rename') {
      const node = ctx.tree.node(ctx.projectId, c.page.id).data;
      steps.push({
        op: 'updateResource',
        params: { path: { resourceId: c.page.id }, body: { name: c.to } },
        expectCurrent: {
          state: 'resource',
          hash: stateHash({ name: c.from, tags: node?.tags ?? [] }),
          label: c.from,
        },
        deferTreeReread: true,
        journalOperation: journal({ id: c.page.id, name: c.from }, `rename to ${c.to}`),
      });
      labels.push(`rename ${c.from} to ${c.to}`);
      const at = steps.length;
      steps.push({
        op: 'bridge.record',
        params: {
          body: {
            action: 'complete',
            store: 'pack',
            record: { kind: 'set_template', resourceId: c.page.id, templateId: c.coreTemplateId },
          },
        },
      });
      labels.push('record the template');
      const e = editOf(edits, c.page.id, c.to);
      e.name = c.to;
      e.after.push(at);
      noteNameOrMove(e, lmrCfg, 'a new name');
      e.hasRow ??= treeHasRow(c.page.id);
      targets.push(pageTarget(`${c.to}: name`, c.page.id, { check: 'name', name: c.to }));
      operations.push({
        tool,
        pack: pack.id,
        page: { id: c.page.id, name: c.from },
        pageParts: [
          `renamed to ${c.to}`,
          'Reference Type Character Core',
          `the ${type.name} Core template recorded`,
        ],
        summaryLabel: `${c.from}: upgraded to ${c.to} (id, documents, facts, links and text kept)`,
      });
    } else if (c.kind === 'facts') {
      const fx = expandFacts(c.plan, { id: c.page.id, name: c.page.rawName }, c.sidebar, {
        facts: c.why,
        links: null,
      });
      const base = steps.length;
      const firstWrite = base + 2;
      for (const s of fx.steps) {
        if (s.op === VERIFY_STEP) {
          const body = (s.params?.body ?? {}) as { targets?: VerifyTarget[] };
          factChecks.push({
            id: c.page.id,
            name: c.page.rawName,
            plan: c.plan,
            sidebar: c.sidebar,
            targets: body.targets ?? [],
          });
          continue;
        }
        const shifted = shiftStep(s, base);
        steps.push(
          s.op === 'bridge.expect'
            ? shifted
            : { ...shifted, journalOperation: { ...(shifted.journalOperation ?? {}), tool, pack: pack.id } },
        );
        const write = (s.journalOperation as Obj | undefined)?.write;
        labels.push(
          s.op === 'bridge.expect'
            ? 'check'
            : `${c.page.rawName}: ${typeof write === 'string' ? write : s.op}`,
        );
      }
      // The rule's evidence: each fact as it was and as planned, each link collection's additions and removals.
      const e = editOf(edits, c.page.id, c.page.rawName);
      for (let n = firstWrite; n <= steps.length; n++) e.after.push(n);
      for (const f of c.plan.facts)
        if (f.change === 'added' || f.change === 'changed' || f.change === 'removed')
          noteFact(e, lmrCfg, f.key, f.before, f.after);
      for (const l of c.plan.links) noteLinks(e, lmrCfg, l.title, l.added.length, l.removed.length);
      e.hasRow = c.sidebar.some((p) => hasLmrRow(p.rows ?? []));
      operations.push({
        tool,
        pack: pack.id,
        page: { id: c.page.id, name: c.page.rawName },
        pageParts: ['sidebar', ...c.why],
        summaryLabel: `${c.page.rawName}: ${c.why.join('; ')}`,
      });
    } else if (c.kind === 'routing') {
      // v3 F3d (ADR 0053): a line rewritten in place (the Polities line of a promoted nation) or lines appended (F3a).
      const said = c.what ?? `${c.section}: ${c.lines.length} line(s) added`;
      steps.push({
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: c.page.id, documentId: c.documentId },
          ifMatch: c.version,
          body: { blocks: c.planned },
        },
        verifyAfterWrite: true,
        replan: {
          planner: WRITE_PAGE_PLANNER,
          input: {
            mode: c.mode ?? 'append_to_section',
            section: c.section,
            markdown: c.markdown,
            sectionHash: c.sectionHash,
          },
        },
        journalOperation: journal({ id: c.page.id, name: c.page.rawName }, said),
      });
      labels.push(
        c.what ? `${c.page.rawName}: ${c.what}` : `${c.page.rawName}: ${c.section} +${c.lines.length}`,
      );
      const e = editOf(edits, c.page.id, c.page.rawName);
      e.after.push(steps.length);
      e.evidence.push({ kind: 'text', before: textUnits(c.blocks), after: textUnits(c.planned) });
      e.hasRow ??= treeHasRow(c.page.id);
      operations.push({
        tool,
        pack: pack.id,
        page: { id: c.page.id, name: c.page.rawName },
        pageParts: [said],
        summaryLabel: c.what
          ? `${c.page.rawName}: ${c.what}`
          : `${c.page.rawName}: ${c.section} gains ${c.lines.length} line(s)`,
        lines: c.lines,
      });
    }
  }

  // 4. The pages' text (all but the image page, whose blocks name assets uploaded below).
  const imagePage = created.find((p) => p.images.length > 0) ?? null;
  const bodyStep = (p: PlannedPage, extra: Partial<StepSpec> = {}) => {
    const createStep = createStepOf.get(p.id);
    if (!createStep || !p.blocks) return;
    steps.push({
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: p.id, documentId: 'pending' }, body: { blocks: p.blocks } },
      bindFrom: { step: createStep, to: 'path.documentId', from: 'documents.main.id' },
      fill: {
        filler: PACK_FILLER,
        input: {
          // The template's sections the plan names but leaves empty keep the template's own content (the collection).
          keepSections: p.kind === 'index' ? [type.index.collection] : [],
        },
      },
      verifyAfterWrite: true,
      ...extra,
      journalOperation: journal({ id: p.id, name: p.rawName }, 'text'),
    });
    labels.push(`text of ${p.rawName}`);
  };
  for (const p of created) if (p !== imagePage) bodyStep(p);

  // 5. The images, then the image page's text.
  const assetSteps = new Map<string, number>();
  for (const im of plan.images) {
    const first = steps.length + 1;
    im.creates.forEach((c, i) => {
      steps.push({
        op: 'createAssetFolder',
        params: {
          body: { name: c.name, ...(i === 0 && c.parentFolderId ? { folderId: c.parentFolderId } : {}) },
        },
        ...(i > 0 ? { bindFrom: { step: first + i - 1, to: 'body.folderId' as const } } : {}),
        findOrCreate: true,
        journalOperation: journal(
          null,
          `folder ${im.path.slice(0, im.path.length - im.creates.length + i + 1).join(' / ')}`,
        ),
      });
      labels.push(`folder ${c.name}`);
    });
    const lastFolder = im.creates.length > 0 ? steps.length : 0;
    const contentHash = im.row.webp.sha256;
    steps.push({
      op: 'createImageUpload',
      params: { body: { contentType: 'image/webp', contentLength: im.row.webp.bytes, contentHash } },
    });
    labels.push(`upload ${im.name}`);
    steps.push({
      op: 'upload_image.put',
      params: {
        body: {
          contentType: 'image/webp',
          contentLength: im.row.webp.bytes,
          contentHash,
          stagedSha256: im.row.serverSha256!,
        },
      },
    });
    labels.push(`send ${im.name} (from the bridge’s server)`);
    const assetStep = steps.length + 1;
    steps.push({
      op: 'createImageAsset',
      params: {
        body: {
          uploadKey: 'pending',
          name: im.name,
          folderId: lastFolder > 0 ? 'pending' : im.folderId!,
        },
      },
      ...(lastFolder > 0 ? { bindFrom: { step: lastFolder, to: 'body.folderId' as const } } : {}),
      journalOperation: { ...journal(null, `image “${im.name}”`), stagedId: im.stagedId },
    });
    labels.push(`image ${im.name} in ${im.path.join(' / ')}`);
    steps.push({
      op: 'upload_image.verify',
      params: { body: { assetStep, contentLength: im.row.webp.bytes, contentHash } },
    });
    labels.push(`verify the stored file of ${im.name}`);
    assetSteps.set(im.stagedId, assetStep);
    targets.push({
      kind: 'asset',
      label: `image “${im.name}”`,
      assetFrom: { step: assetStep },
      fields: { isHidden: false, name: im.name, ...(lastFolder === 0 ? { folderId: im.folderId } : {}) },
      ...(lastFolder > 0 ? { folderFrom: { step: lastFolder } } : {}),
    });
    operations.push({
      kind: 'place_image',
      tool,
      pack: pack.id,
      stagedId: im.stagedId,
      name: im.name,
      to: im.path,
      createsFolders: im.creates.map((c) => c.name),
    });
  }
  if (imagePage) {
    bodyStep(imagePage, {
      bindAssetUrls: plan.images
        .filter((im) => assetSteps.has(im.stagedId))
        .map((im) => ({ step: assetSteps.get(im.stagedId)!, placeholder: im.placeholder })),
    });
  }
  // v3 F3b (ADR 0052): new images on an existing Art page, appended under its images section inside the lock.
  for (const c of plan.existing) {
    if (c.kind !== 'images') continue;
    const at = steps.length + 1;
    steps.push({
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: c.page.id, documentId: c.documentId }, body: { blocks: [...c.blocks] } },
      fill: { filler: PACK_ART_FILLER, input: { section: c.section, boundaries: c.boundaries } },
      judgedInLock: true,
      verifyAfterWrite: true,
      bindAssetUrls: c.images
        .filter((im) => assetSteps.has(im.stagedId))
        .map((im) => ({ step: assetSteps.get(im.stagedId)!, placeholder: im.placeholder })),
      journalOperation: journal(
        { id: c.page.id, name: c.page.rawName },
        `${c.section}: ${c.images.length} image(s) added`,
      ),
    });
    labels.push(`${c.page.rawName}: ${c.section} +${c.images.length} image(s)`);
    // The new sections are appended: each image's label (a heading) and its interpretation are new page text. The
    // images section's own heading is left out: the filler makes it only when the page lacks it.
    const e = editOf(edits, c.page.id, c.page.rawName);
    e.after.push(at);
    e.evidence.push({
      kind: 'text',
      before: [],
      after: textUnits(c.blocks).filter((u) => !(u.kind === 'heading' && keyOf(u.text) === keyOf(c.section))),
    });
    e.hasRow ??= treeHasRow(c.page.id);
    operations.push({
      tool,
      pack: pack.id,
      page: { id: c.page.id, name: c.page.rawName },
      pageParts: [`${c.section}: ${c.images.length} image(s) added, each with its label and interpretation`],
      summaryLabel: `${c.page.rawName}: ${c.section} gains ${c.images.map((im) => `“${im.name}”`).join(', ')}`,
    });
  }

  // v3 F3b (design 1.1a): a character navigation index made here is recorded in the Character taxonomy (one entry).
  for (const t of plan.taxonomy ?? []) {
    steps.push({
      op: 'bridge.record',
      params: {
        body: {
          action: 'complete',
          store: PACK_RECORD_STORE,
          record: {
            kind: 'taxonomy_entry',
            resourceId: t.resourceId,
            plural: t.plural,
            parentNodeId: t.parentNodeId,
          },
        },
      },
    });
    labels.push(`add ${t.plural} to the Character taxonomy`);
    operations.push({
      tool,
      pack: pack.id,
      kind: 'taxonomy_entry',
      summaryLabel: `${t.plural}: added to the Character taxonomy (Repository Mappings), so characters of it can be placed`,
    });
  }

  // 6. A Reference moved under its new index, placed among the new pages there.
  for (const c of plan.existing) {
    if (c.kind !== 'move') continue;
    const index = created.find((p) => p.key === c.to.item);
    if (!index) continue;
    const siblings = created
      .filter((p) => 'item' in p.parent && p.parent.item === c.to.item)
      .map((p) => ({ id: p.id, displayName: p.displayName, kind: p.kind }));
    const me = { displayName: c.name.replace(/^\[[A-Z]{4,5}\]\s*/, ''), kind: c.page.kind as ResolveKind };
    let after: string | undefined;
    let before: string | undefined;
    for (const s of siblings.sort(compareSiblings)) {
      if (compareSiblings(s, me) <= 0) after = s.id;
      else if (before === undefined) before = s.id;
    }
    const node = ctx.tree.node(ctx.projectId, c.page.id).data;
    steps.push({
      op: 'moveResource',
      params: {
        path: { resourceId: c.page.id },
        body: { parentId: index.id, ...(after ? { after } : before ? { before } : {}) },
      },
      deferTreeReread: true,
      journalOperation: journal({ id: c.page.id, name: c.page.rawName }, `moved under ${c.toName}`),
    });
    labels.push(`move ${c.page.rawName} under ${c.toName}`);
    const moved = editOf(edits, c.page.id, c.name);
    moved.after.push(steps.length);
    noteNameOrMove(moved, lmrCfg, 'a move');
    moved.hasRow ??= treeHasRow(c.page.id);
    targets.push(pageTarget(`${c.name}: place`, c.page.id, { check: 'parent', parentId: index.id }));
    // The new pages under that index now stand beside the moved page: their expected neighbours, in sibling order.
    const order = [...siblings, { id: c.page.id, displayName: me.displayName, kind: me.kind }].sort(
      compareSiblings,
    );
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (t.kind !== 'resource' || !t.placement || t.placement.parentId !== index.id) continue;
      const at = order.findIndex((o) => o.id === t.resourceId);
      if (at < 0) continue;
      targets[i] = {
        ...t,
        placement: {
          parentId: index.id,
          after: at > 0 ? order[at - 1]!.id : null,
          before: at + 1 < order.length ? order[at + 1]!.id : null,
        },
      };
    }
    // v3 F3b (ADR 0052): the pages made beside the moved page (the new index itself, in the moved page's old parent)
    // stand beside whatever was on the moved page's other side once it has gone: their expected neighbours are worked
    // out again from the old parent's order (its pages as the tree has them, the new ones in their planned places).
    const oldParent = node?.parentId ?? null;
    if (oldParent) {
      const list = ctx.tree.children(ctx.projectId, oldParent).data.map((x) => x.id);
      for (const p of created) {
        const w = placement.get(p.id);
        if (!w || w.parentId !== oldParent) continue;
        const ia = w.after ? list.indexOf(w.after) : -1;
        const ib = w.before ? list.indexOf(w.before) : -1;
        list.splice(ia >= 0 ? ia + 1 : ib >= 0 ? ib : w.after ? list.length : 0, 0, p.id);
      }
      const remaining = list.filter((id) => id !== c.page.id);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        if (t.kind !== 'resource' || !t.placement || t.placement.parentId !== oldParent) continue;
        if (t.placement.after !== c.page.id && t.placement.before !== c.page.id) continue;
        const at = remaining.indexOf(t.resourceId);
        if (at < 0) continue;
        targets[i] = {
          ...t,
          placement: {
            parentId: oldParent,
            after: at > 0 ? remaining[at - 1]! : null,
            before: at + 1 < remaining.length ? remaining[at + 1]! : null,
          },
        };
      }
    }
    operations.push({
      tool,
      pack: pack.id,
      page: { id: c.page.id, name: c.page.rawName },
      pageParts: [`moved under ${c.toName} (id, name, documents, facts, links and text kept)`],
      summaryLabel: `${c.page.rawName}: moved from ${node?.parentId ? (ctx.tree.node(ctx.projectId, node.parentId).data?.rawName ?? '?') : '?'} under ${c.toName}`,
    });
  }

  // 7. Last Major Revision, dated when the job runs: every page made; an existing page as the rule or the caller says.
  const lmrStepOf = new Map<string, number>();
  const addLmr = (pageId: string, name: string, after: number[], why: string) => {
    const stepNo = steps.length + 1;
    steps.push({
      op: LMR_STEP,
      params: {
        body: { resourceId: pageId, key: lmrKey, after, page: name.slice(0, 500), why: why.slice(0, 500) },
      },
      followUp: 'lmr_failed',
    });
    labels.push(`${lmrKey} of ${name}`);
    steps.push({
      op: 'updatePropertyRow',
      params: {
        path: { resourceId: pageId, propertyId: pageId, rowId: pageId },
        body: { content: [{ text: 'date of approval' }] },
      },
      decisionFrom: { step: stepNo },
      ifMatchFrom: { step: stepNo, key: 'lmr' },
      followUp: 'lmr_failed',
      judgedInLock: true,
      deferTreeReread: true,
      journalOperation: { tool, pack: pack.id, page: { id: pageId, name }, write: `${lmrKey}: today` },
    });
    labels.push(`${lmrKey} of ${name}: today`);
    lmrStepOf.set(pageId, stepNo);
  };
  const newPages: string[] = [];
  for (const p of created) {
    if (!p.templateKeys?.some((k) => k.trim().toLowerCase() === lmrKey.trim().toLowerCase())) continue;
    const at = createStepOf.get(p.id);
    if (!at) continue;
    addLmr(p.id, p.rawName, [at], 'a page this package makes (always dated)');
    newPages.push(p.rawName);
  }
  // v3 F3b with ADR 0051: each existing page by the owner's rule, or the caller's lastMajorRevision. A page known to
  // have no such row is left out (nothing to set, nothing to say).
  const decisions: LmrDecision[] = [];
  for (const e of edits.values()) {
    if (e.hasRow === false) continue;
    const d = decisionOf(e, lmrCfg, lmrMode);
    decisions.push(d);
    if (d.set) addLmr(e.id, e.name, e.after, d.why);
    // The page's line in the proposal (its first operation's label) says what was decided, and why.
    const first = operations.find((o) => (o.page as { id?: string } | undefined)?.id === e.id);
    if (first) {
      if (Array.isArray(first.pageParts)) (first.pageParts as string[]).push(d.note);
      if (typeof first.summaryLabel === 'string') first.summaryLabel = `${first.summaryLabel}; ${d.note}`;
    }
  }

  // 8. Verify: each new page's own checks (one target per gated field), then everything else gathered above.
  for (const p of created) {
    if (p.kind === 'index') continue;
    const lmr = lmrStepOf.get(p.id);
    for (const k of p.gatedKeys) {
      const v = p.factValues.find((f) => f.key.toLowerCase() === k.toLowerCase())?.value ?? null;
      targets.push(
        pageTarget(`${p.rawName}: ${k}`, p.id, {
          check: 'field',
          property: env.pack.rules.sidebar.property,
          key: k,
          value: v,
        }),
      );
    }
    if (p.templateKeys) {
      targets.push(
        pageTarget(
          `${p.rawName}: sidebar rows`,
          p.id,
          {
            check: 'rows',
            property: env.pack.rules.sidebar.property,
            keys: p.templateKeys,
            values: Object.fromEntries(p.factValues.map((f) => [f.key, f.value])),
            lmrKey,
          },
          lmr ? [{ step: lmr, as: 'lmr' }] : undefined,
        ),
      );
    }
    targets.push(pageTarget(`${p.rawName}: tags`, p.id, { check: 'tags', tags: p.tags ?? [] }));
    const links = p.linkTargets.filter((l) => l.targets.length > 0);
    if (links.length > 0) {
      targets.push(
        pageTarget(`${p.rawName}: links`, p.id, {
          check: 'links',
          collections: links.map((l) => ({
            title: l.title,
            ids: l.targets.map((t: LinkTarget) => t.resourceId),
          })),
        }),
      );
    }
  }
  for (const x of factChecks) {
    const lmr = lmrStepOf.get(x.id);
    // Not dated by this job: its facts plan's own checks (Last Major Revision as it was).
    if (lmr === undefined) {
      targets.push(...x.targets);
      continue;
    }
    // A change of links only plans no rows: the rows are then the page's as read, only Last Major Revision checked.
    const rows =
      x.plan.rowsAfter.length > 0
        ? x.plan.rowsAfter
        : (x.sidebar.find(
            (p) => p.kind === 'keyValue' && keyOf(p.title) === keyOf(env.pack.rules.sidebar.property),
          )?.rows ?? []);
    targets.push(
      pageTarget(
        `${x.name}: sidebar rows`,
        x.id,
        {
          check: 'rows',
          property: env.pack.rules.sidebar.property,
          keys: rows.map((r) => r.key),
          // The planned values (none for a change of links only: rows it did not write are not judged).
          values: Object.fromEntries(
            x.plan.rowsAfter
              .filter((r) => r.key.trim().toLowerCase() !== lmrKey.trim().toLowerCase())
              .map((r) => [r.key, r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')]),
          ),
          lmrKey,
        },
        [{ step: lmr, as: 'lmr' }],
      ),
    );
    const added = x.plan.links.filter((l) => l.added.length > 0);
    if (added.length > 0) {
      targets.push(
        pageTarget(`${x.name}: links`, x.id, {
          check: 'links',
          collections: added.map((l) => ({ title: l.title, ids: l.added.map((a) => a.resourceId) })),
        }),
      );
    }
  }
  steps.push({ op: VERIFY_STEP, params: { body: { targets } } });
  labels.push('verify');

  // The proposal's page-level summary: one operation per new page, in creation order.
  for (const p of created) {
    const facts = p.factValues;
    const parts = [
      `under ${p.parentName}`,
      `from ${p.templateName}`,
      ...(facts.length ? [`${facts.length} facts`] : []),
      ...(p.tags && p.tags.length ? [`tags ${p.tags.join(', ')}`] : p.kind === 'index' ? ['no tags'] : []),
      ...(p.blocks ? [`text (${p.blocks.length} blocks)`] : []),
      ...(p.images.length ? [`${p.images.length} image${p.images.length === 1 ? '' : 's'}`] : []),
      ...(p.notes ?? []),
    ];
    operations.unshift({
      tool,
      pack: pack.id,
      page: { id: p.id, name: p.rawName },
      isNew: true,
      pageParts: parts,
      summaryLabel: `New page ${p.rawName} under ${p.parentName}: ${parts.slice(1).join(', ')}`,
      templateId: p.templateId,
      role: p.role,
      facts: facts.map((f) => ({ key: f.key, value: f.value })),
      tags: p.tags ?? [],
      links: p.linkTargets.map((l) => ({ title: l.title, added: l.targets.map((t) => t.name) })),
      ...(p.markdown ? { markdown: p.markdown.slice(0, 20_000) } : {}),
    });
  }
  operations.reverse();

  const writes = steps.filter((s) => !s.op.startsWith('bridge.') && !s.op.startsWith('upload_image.')).length;
  const created0 = createMarker(tool, [
    ...created.filter((p) => p.status).map((p) => ({ id: p.id, to: p.status! })),
    ...created.filter((p) => p.kind === 'index').map((p) => ({ id: p.id, to: null })),
  ]);
  // v3 F3b (ADR 0052): a package that moves an Authoritative page (promoteNation) is a canonical proposal, as always.
  const marker: ReturnType<typeof createMarker> = plan.canonical
    ? {
        tool,
        canonical: true,
        reason: created0?.canonical
          ? `${created0.reason ?? ''}; ${plan.canonical.reason}`
          : plan.canonical.reason,
        pages: created0?.pages ?? [],
      }
    : created0;
  const summary = `${tool}: ${plan.mode === 'new' ? '' : 'extend '}${plan.subject} (${plan.status === 'working' ? 'Working' : 'Authoritative'}): ${created.length} new page${created.length === 1 ? '' : 's'}${plan.images.length ? `, ${plan.images.length} image${plan.images.length === 1 ? '' : 's'}` : ''}${plan.existing.length ? `, ${plan.existing.length} change${plan.existing.length === 1 ? '' : 's'} to existing pages` : ''}${plan.summaryNote ? `; ${plan.summaryNote}` : ''}`;
  return {
    ok: true,
    value: {
      steps,
      labels,
      operations,
      summary,
      writes,
      assetSteps,
      placement,
      marker,
      lmr: { mode: lmrMode, newPages, existing: decisions },
    },
  };
}

function pageTarget(
  label: string,
  resourceId: string,
  input: Obj,
  inputFrom?: { step: number; as: string }[],
): VerifyTarget {
  return {
    kind: 'registered',
    label: label.slice(0, 300),
    checker: PACK_CHECKS.page,
    resourceId,
    input: { ...input, resourceId },
    ...(inputFrom ? { inputFrom } : {}),
  };
}

/** The journal of a create step names the pack (so the Last Major Revision rule and the journal know it). */
function withPack(s: StepSpec, packId: string): StepSpec {
  if (!s.journalOperation) return s;
  return { ...s, journalOperation: { ...s.journalOperation, pack: packId } };
}

export function packFail(env: PlanEnv, code: string, message: string) {
  return { ok: false as const, result: errorResult({ code, message }, env.pd) };
}
