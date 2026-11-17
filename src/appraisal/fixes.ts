/**
 * "Propose a fix" for an appraisal finding (v3 F3c, ADR 0054; the design's section F, the owner's addition of 17
 * November 2026). Repository Automation: a diagnostic job never repairs by itself; an owner (or an agent at the owner's
 * request) choosing to act on a finding is the interactive follow-up. So the appraisal stays read-only, and a fix is a
 * separate, explicit request that becomes **one ordinary proposal** for the owner to approve, whatever the caller's
 * scope (`forceProposal`). Nothing is ever applied without the owner's approval.
 *
 * Each fix **re-reads its target live** (one read), checks the finding still holds (else `FIX_STALE`, with what is there
 * now, and nothing is proposed), and plans the smallest change through the bridge's existing machinery:
 *
 * - an **em dash in the name**: `updateResource` with the name's dashes replaced (the pack's own rule, ADR 0050 decision
 *   7), the prefix kept, re-placed alphabetically when its place changes (update_resource's own steps);
 * - an **em dash in the headings or prose**, **decorative blank paragraphs**, **links inside headings**: write_page's
 *   block-by-block path (ADR 0046 decision 1): only the blocks that change are replaced (or deleted), every other
 *   character and block kept, the document compared inside the lock, the result verified;
 * - an **asset name with an extension**: `updateAsset` with the extension dropped, refused when the folder already
 *   holds that name (the collision check, from the asset tree);
 * - a **Working or Archived page in an Authoritative page's Related Sources**: that one link removed (set_facts' own
 *   plan and expansion);
 * - **sibling order** and **closed-grammar tags**: handed over to the audits' own "Propose a fix" (never duplicated).
 *
 * Last Major Revision is decided by ADR 0051's rule like any edit's: the engine's planner measures the change from the
 * read the fix made (a dash, a blank paragraph or a heading's link is punctuation or nothing: skipped; names, tags,
 * moves and Related Sources do not count).
 */
import { planFacts, FactsPlanError } from '../facts/plan.js';
import { expandFacts } from '../facts/expand.js';
import { sidebarFrom } from '../facts/index.js';
import { isKnownRun } from '../audits/model.js';
import { VERIFY_STEP, type VerifyTarget } from '../jobs/internal-steps.js';
import type { JobOrigin, StepSpec } from '../jobs/index.js';
import { stateHash } from '../jobs/sidebar-state.js';
import { hasForbiddenDash } from '../packs/engine/text.js';
import { planBlockwise } from '../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../pages/blockwise-job.js';
import { SiblingSim } from '../resources/plan.js';
import { classifyName, nameKey } from '../tree/classify.js';
import type { TreeNode } from '../tree/index.js';
import { dashBlocks, headingLinks, isBlankParagraph } from './owner.js';
import type { LiveRead } from './reader.js';
import { AppraisalError, type AppraisalFinding } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

export type FixResult =
  | {
      readonly status: 'proposal_captured';
      readonly proposalId: string;
      readonly summary: string | null;
      readonly fix: string;
      readonly reads: number;
      readonly requiresCanonicalApproval?: boolean;
      /** v3 F3.4 (ADR 0055 decision C): the safety rail that made it a proposal at scope `write`, in words. */
      readonly proposedBecause?: string;
    }
  /**
   * v3 F3.4 (ADR 0055 decision D): the pack's switch says the fix follows the caller's scope, and at scope `write` it was
   * accepted as a job (the owner reviews it afterwards, on the Review page).
   */
  | {
      readonly status: 'submitted';
      readonly jobId: string;
      readonly summary: string | null;
      readonly fix: string;
      readonly reads: number;
    }
  | { readonly status: 'nothing_to_do'; readonly message: string; readonly reads: number };

export interface FixDeps {
  readonly projectId: string;
  /** One governed live read (P1). */
  readonly read: LiveRead;
  readonly submit: (req: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Who asks: the agent's own principal (MCP), or the owner's system principal (the dashboard). */
  readonly origin: JobOrigin;
  /**
   * v3 F3.4 (ADR 0055 decision D): whether the fix is ONE proposal whatever the caller's scope (true: the dashboard's
   * "Propose a fix", and the pack tool while its switch says "always propose"), or follows the caller's scope (false:
   * the pack tool's switch "follow the agent's scope"; at scope `write` it runs, still within every guard and rail).
   */
  readonly forceProposal: boolean;
  /** The bridge's tree (names, places, siblings): free. */
  readonly node: (id: string) => TreeNode | null;
  readonly children: (parentId: string) => readonly TreeNode[];
  /** The asset tree's assets of a folder (the rename's collision check). */
  readonly assetsIn: (folderId: string | null) => readonly { readonly id: string; readonly name: string }[];
  readonly propertiesName: string;
}

const stale = (what: string, details: Obj = {}): AppraisalError =>
  new AppraisalError(
    'FIX_STALE',
    `${what} The finding is out of date; nothing was proposed. Run the appraisal again (after the next snapshot, or with live: true).`,
    details,
  );

const DASH_EM = /[ \t]*—[ \t]*/g;
const DASH_EN = /[ \t]+–[ \t]*|[ \t]*–[ \t]+/g;

/** A text run's dashes replaced as the pack's rule replaces them (an ASCII hyphen with a space either side). */
export function replaceRunDashes(text: string): string {
  return text.replace(DASH_EM, ' - ').replace(DASH_EN, ' - ');
}

/** A block's runs with their dashes replaced (code runs and every other run kept); the block's own edges trimmed. */
function undashBlock(b: Obj): Obj {
  if (!Array.isArray(b.content)) return b;
  const runs = (b.content as unknown[]).map((r) =>
    isObj(r) && typeof r.text === 'string' && r.code !== true && hasForbiddenDash(r.text)
      ? { ...r, text: replaceRunDashes(r.text) }
      : r,
  );
  // A dash that was at the very start (or end) of the block keeps no space on that side.
  const first = runs[0];
  if (isObj(first) && typeof first.text === 'string' && first.text.startsWith(' - '))
    runs[0] = { ...first, text: first.text.slice(1) };
  const last = runs[runs.length - 1];
  if (isObj(last) && typeof last.text === 'string' && last.text.endsWith(' - '))
    runs[runs.length - 1] = { ...last, text: last.text.slice(0, -1) };
  return { ...b, content: runs };
}

/** A heading with its links dropped: a mention becomes its text, a link mark goes; every other run as it was. */
function unlinkHeading(b: Obj): Obj {
  if (b.kind !== 'heading' || !Array.isArray(b.content)) return b;
  const runs: Obj[] = [];
  for (const r of b.content as unknown[]) {
    if (!isObj(r)) continue;
    if (isObj(r.mention)) {
      const text = asText(r.mention.text) || asText(r.mention.name);
      if (text !== '') runs.push({ text });
      continue;
    }
    if (typeof r.text === 'string' && 'link' in r) {
      const { link: _drop, ...rest } = r;
      runs.push(rest);
      continue;
    }
    runs.push(r);
  }
  // Neighbouring plain runs with the same marks are merged, as LegendKeeper stores them.
  const merged: Obj[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      typeof prev.text === 'string' &&
      typeof r.text === 'string' &&
      JSON.stringify({ ...prev, text: '' }) === JSON.stringify({ ...r, text: '' })
    )
      merged[merged.length - 1] = { ...prev, text: `${prev.text}${r.text}` };
    else merged.push(r);
  }
  return { ...b, content: merged };
}

/** Maps every block of a tree (depth first), keeping ids and order. */
function mapBlocks(blocks: readonly unknown[], fn: (b: Obj) => Obj): Obj[] {
  return blocks.filter(isObj).map((b) => {
    const next = fn(b);
    return Array.isArray(next.children) ? { ...next, children: mapBlocks(next.children, fn) } : next;
  });
}

/** The blocks the write format cannot take back (a paragraph holding an inline icon): never edited. */
function unwritableIds(blocks: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (Array.isArray(b.content) && (b.content as unknown[]).some((r) => isObj(r) && !isKnownRun(r)))
        if (typeof b.id === 'string') out.add(b.id);
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

async function submit(
  d: FixDeps,
  spec: {
    readonly steps: readonly StepSpec[];
    readonly title: string;
    readonly holdLock?: { readonly resourceId: string };
    readonly holdDocuments?: readonly string[];
    readonly operation: Obj;
    readonly page: { readonly id: string; readonly name: string };
    readonly pageParts: readonly string[];
    readonly prefetched?: readonly Obj[];
    readonly fix: string;
    readonly reads: number;
  },
): Promise<FixResult> {
  const r = await d.submit({
    kind: 'batch_ops',
    project: d.projectId,
    steps: spec.steps,
    onError: 'stop',
    priority: 'P1',
    origin: d.origin,
    title: spec.title.slice(0, 300),
    ...(spec.holdLock ? { holdLock: spec.holdLock } : {}),
    ...(spec.holdDocuments ? { holdDocuments: spec.holdDocuments } : {}),
    internal: true,
    forceProposal: d.forceProposal,
    proposal: {
      operation: spec.operation,
      operations: [
        { ...spec.operation, page: spec.page, pageParts: spec.pageParts, summaryLabel: spec.title },
      ],
      summary: spec.title,
      ...(spec.prefetched ? { prefetched: spec.prefetched } : {}),
    },
  });
  if (typeof r.proposalId === 'string')
    return {
      status: 'proposal_captured',
      proposalId: r.proposalId,
      summary: typeof r.summary === 'string' ? r.summary : null,
      fix: spec.fix,
      reads: spec.reads,
      ...(r.canonical ? { requiresCanonicalApproval: true } : {}),
      ...(typeof r.proposedBecause === 'string' ? { proposedBecause: r.proposedBecause } : {}),
    };
  if (!d.forceProposal && typeof r.jobId === 'string')
    return { status: 'submitted', jobId: r.jobId, summary: spec.title, fix: spec.fix, reads: spec.reads };
  throw new AppraisalError('NOT_PROPOSED', 'The fix was not captured as a proposal; nothing was done.');
}

// ============================================================================================ the page name

async function fixName(d: FixDeps, f: AppraisalFinding): Promise<FixResult> {
  const pageId = f.page!.id;
  const res = await d.read('getResource', { path: { resourceId: pageId } });
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const raw = asText(res.name);
  const c = classifyName(raw);
  if (!hasForbiddenDash(c.displayName))
    throw stale(`The page name no longer holds a dash (it is “${raw}”).`, { name: raw });
  const prefix = raw.slice(0, raw.length - c.displayName.length);
  const display = replaceRunDashes(c.displayName).replace(/^ - /, '- ').replace(/ - $/, ' -').trim();
  const rawName = `${prefix}${display}`;
  const parentId = typeof res.parentId === 'string' ? res.parentId : null;
  if (parentId) {
    const twin = d
      .children(parentId)
      .find((n) => n.id !== pageId && n.kind === c.kind && nameKey(n.displayName) === nameKey(display));
    if (twin)
      throw new AppraisalError(
        'FIX_NOT_APPLICABLE',
        `A sibling is already named “${twin.rawName}”, so the page cannot take that name. Nothing was proposed.`,
        { existing: { id: twin.id, name: twin.rawName } },
      );
  }
  const page = { id: pageId, name: raw };
  const steps: StepSpec[] = [
    {
      op: 'updateResource',
      params: { path: { resourceId: pageId }, body: { name: rawName } },
      journalOperation: { tool: 'update_resource', page, from: 'arkona_appraisal_fix', finding: f.id },
      expectCurrent: {
        state: 'resource',
        hash: stateHash({ name: raw, tags: Array.isArray(res.tags) ? res.tags : [] }),
        label: raw,
      },
    },
  ];
  let placement: { parentId: string; after: string | null; before: string | null } | undefined;
  if (parentId) {
    const sim = new SiblingSim((pid) => d.children(pid));
    const now = sim.neighbours(parentId, pageId);
    sim.remove(parentId, pageId);
    const slot = sim.slot(parentId, { displayName: display, kind: c.kind });
    sim.insert(parentId, { id: pageId, displayName: display, kind: c.kind }, slot);
    const then = sim.neighbours(parentId, pageId);
    placement = { parentId, ...then };
    if (now.after !== then.after || now.before !== then.before)
      steps.push({
        op: 'moveResource',
        params: { path: { resourceId: pageId }, body: { parentId, ...slot } },
        journalOperation: { tool: 'update_resource', page, write: 're-placed after the rename' },
      });
  }
  steps.push({
    op: VERIFY_STEP,
    params: {
      body: {
        targets: [
          {
            kind: 'resource',
            label: rawName,
            resourceId: pageId,
            fields: { name: rawName },
            ...(placement ? { placement } : {}),
          } satisfies VerifyTarget,
        ],
      },
    },
  });
  return submit(d, {
    steps,
    title: `Replace the dash in “${raw}”: “${rawName}”`,
    holdLock: { resourceId: pageId },
    operation: {
      tool: 'update_resource',
      fromAppraisal: f.id,
      check: f.check,
      changes: { name: { before: raw, after: rawName } },
    },
    page,
    pageParts: ['name'],
    prefetched: [{ op: 'getResource', path: { resourceId: pageId }, body: res }],
    fix: 'em_dash_name',
    reads: 1,
  });
}

// ============================================================================================ the body, block by block

async function fixBody(
  d: FixDeps,
  f: AppraisalFinding,
  kind: 'em_dash_text' | 'blank_paragraphs' | 'heading_links',
): Promise<FixResult> {
  const pageId = f.page!.id;
  const documentId = asText(f.fix?.args.documentId) || (f.documentId ?? '');
  if (!documentId)
    throw new AppraisalError('FIX_NOT_APPLICABLE', 'The finding names no document; nothing was proposed.');
  const path = { resourceId: pageId, documentId };
  const body = await d.read('getDocumentBlocks', { path });
  if (!isObj(body) || !Array.isArray(body.blocks)) throw stale(`The document ${documentId} is gone.`);
  const before = body.blocks as Obj[];
  const unwritable = unwritableIds(before);
  let after: Obj[];
  let skipped: string[] = [];
  let what: string;
  if (kind === 'em_dash_text') {
    const dashed = dashBlocks(before);
    if (dashed.length === 0) throw stale('The body no longer holds a dash.');
    skipped = dashed.filter((x) => x.id !== null && unwritable.has(x.id)).map((x) => x.id!);
    const fixable = new Set(dashed.filter((x) => x.id !== null && !unwritable.has(x.id)).map((x) => x.id!));
    if (fixable.size === 0)
      throw new AppraisalError(
        'FIX_NOT_APPLICABLE',
        'Every block with a dash also holds an inline icon, which LegendKeeper’s write format cannot write back. Nothing was proposed.',
        { blocks: skipped },
      );
    after = mapBlocks(before, (b) => (typeof b.id === 'string' && fixable.has(b.id) ? undashBlock(b) : b));
    what = `replace the dash in ${fixable.size} block${fixable.size === 1 ? '' : 's'}`;
  } else if (kind === 'blank_paragraphs') {
    const blanks = before
      .filter((b) => isBlankParagraph(b))
      .map((b) => b.id)
      .filter((x): x is string => typeof x === 'string');
    if (blanks.length === 0) throw stale('The body no longer holds a blank paragraph.');
    if (blanks.length === before.length)
      throw new AppraisalError(
        'FIX_NOT_APPLICABLE',
        'The body holds nothing but blank paragraphs; nothing was proposed.',
      );
    const gone = new Set(blanks);
    after = before.filter((b) => !(typeof b.id === 'string' && gone.has(b.id)));
    what = `remove ${blanks.length} blank paragraph${blanks.length === 1 ? '' : 's'}`;
  } else {
    const linked = before.filter((b) => headingLinks(b).length > 0);
    if (linked.length === 0) throw stale('No heading holds a link now.');
    skipped = linked.map((b) => asText(b.id)).filter((id) => unwritable.has(id));
    const fixable = new Set(linked.map((b) => asText(b.id)).filter((id) => id !== '' && !unwritable.has(id)));
    if (fixable.size === 0)
      throw new AppraisalError(
        'FIX_NOT_APPLICABLE',
        'Each linked heading also holds an inline icon; nothing was proposed.',
      );
    after = before.map((b) => (typeof b.id === 'string' && fixable.has(b.id) ? unlinkHeading(b) : b));
    what = `drop the link from ${fixable.size} heading${fixable.size === 1 ? '' : 's'}`;
  }
  const plan = planBlockwise(before, after, {
    unwritable,
    validate: (op) => validateBlockOp(pageId, documentId, op),
  });
  if (!plan.ok)
    throw new AppraisalError(
      'FIX_NOT_APPLICABLE',
      `The change cannot be written block by block: ${plan.refusal.message} Nothing was proposed.`,
      { reason: plan.refusal.reason },
    );
  if (plan.empty) return { status: 'nothing_to_do', message: 'Nothing to change.', reads: 1 };
  const name = d.node(pageId)?.rawName ?? f.page!.name;
  const page = { id: pageId, name };
  const job = blockwiseJob({
    resourceId: pageId,
    documentId,
    before,
    after,
    ops: plan.ops,
    journalOperation: { tool: 'write_page', page, from: 'arkona_appraisal_fix', finding: f.id, fix: kind },
  });
  return submit(d, {
    steps: job.steps,
    title: `${what[0]!.toUpperCase()}${what.slice(1)} on “${name}”${skipped.length ? ` (${skipped.length} block(s) with an inline icon left as they are)` : ''}`,
    holdDocuments: [documentId],
    operation: {
      tool: 'write_page',
      fromAppraisal: f.id,
      check: f.check,
      document: documentId,
      blocks: plan.ops.map((o) => ({ op: o.op, id: o.id })),
      ...(skipped.length ? { leftAsTheyAre: skipped } : {}),
    },
    page,
    pageParts: ['page content'],
    prefetched: [{ op: 'getDocumentBlocks', path, body }],
    fix: kind,
    reads: 1,
  });
}

// ============================================================================================ an asset's extension

async function fixAsset(d: FixDeps, f: AppraisalFinding): Promise<FixResult> {
  const assetId = asText(f.fix?.args.assetId);
  const a = await d.read('getAsset', { path: { assetId } });
  if (!isObj(a)) throw stale(`The asset ${assetId} is gone.`);
  const name = asText(a.name);
  const ext = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|heif)$/i;
  if (!ext.test(name))
    throw stale(`The asset’s name no longer has an extension (it is “${name}”).`, { name });
  const newName = name.replace(ext, '').trim();
  if (newName === '')
    throw new AppraisalError('FIX_NOT_APPLICABLE', 'Without its extension the name would be empty.');
  const folderId = typeof a.folderId === 'string' && a.folderId !== '' ? a.folderId : null;
  const taken = d.assetsIn(folderId).find((x) => x.id !== assetId && nameKey(x.name) === nameKey(newName));
  if (taken)
    throw new AppraisalError(
      'FIX_NOT_APPLICABLE',
      `The folder already holds an asset named “${taken.name}”, so “${name}” cannot take that name. Nothing was proposed.`,
      { existing: taken },
    );
  const steps: StepSpec[] = [
    {
      op: 'updateAsset',
      params: { path: { assetId }, body: { name: newName } },
      journalOperation: {
        tool: 'arkona_appraisal_fix',
        write: `rename “${name}” to “${newName}”`,
        finding: f.id,
      },
    },
  ];
  return submit(d, {
    steps,
    title: `Rename the asset “${name}” to “${newName}” (no file extension)`,
    operation: {
      tool: 'arkona_appraisal_fix',
      fromAppraisal: f.id,
      check: f.check,
      asset: { id: assetId, before: name, after: newName },
    },
    page: { id: assetId, name },
    pageParts: ['asset name'],
    fix: 'asset_extension',
    reads: 1,
  });
}

// ============================================================================================ Related Sources

async function fixRelated(d: FixDeps, f: AppraisalFinding): Promise<FixResult> {
  const pageId = f.page!.id;
  const targetId = asText(f.fix?.args.targetId);
  const title = asText(f.fix?.args.propertyTitle) || 'Related Sources';
  const node = d.node(pageId);
  if (node && node.kind !== 'bsrc')
    throw stale(`The page is no longer Authoritative (it is “${node.rawName}”).`);
  const target = d.node(targetId);
  if (target && target.kind !== 'bwrk' && target.kind !== 'barc')
    throw stale(`“${target.rawName}” is no longer Working or Archived.`, { target: target.rawName });
  const path = { resourceId: pageId };
  const body = await d.read('listProperties', { path });
  const sidebar = sidebarFrom(body);
  const coll = sidebar.find(
    (p) => p.kind !== 'keyValue' && p.title.trim().toLowerCase() === title.trim().toLowerCase(),
  );
  const items = (coll?.raw?.items ?? []) as unknown[];
  if (!coll || !items.some((i) => isObj(i) && i.resourceId === targetId))
    throw stale(`“${title}” no longer lists that page.`);
  const name = node?.rawName ?? f.page!.name;
  let plan;
  try {
    plan = planFacts({
      resourceId: pageId,
      sidebar,
      propertyTitle: d.propertiesName,
      facts: [],
      links: [
        {
          title,
          add: [],
          remove: [
            { resourceId: targetId, name: target?.rawName ?? (asText(f.fix?.args.targetName) || targetId) },
          ],
        },
      ],
      templateKeys: null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) throw new AppraisalError(e.code, e.message, e.details);
    throw e;
  }
  if (plan.empty)
    return { status: 'nothing_to_do', message: `“${title}” no longer lists that page.`, reads: 1 };
  const job = expandFacts(plan, { id: pageId, name }, sidebar, {
    facts: {},
    links: { [title]: { remove: [target?.rawName ?? targetId] } },
  });
  return submit(d, {
    steps: job.steps,
    title: `Remove “${target?.rawName ?? targetId}” from the Related Sources of “${name}”`,
    holdLock: { resourceId: pageId },
    operation: { ...job.operation, fromAppraisal: f.id, check: f.check },
    page: { id: pageId, name },
    pageParts: job.pageParts,
    prefetched: [{ op: 'listProperties', path, body }],
    fix: 'related_noncurrent',
    reads: 1,
  });
}

/** Plans and captures one finding's fix (never the audits' own: the service hands those over). */
export async function proposeAppraisalFix(d: FixDeps, f: AppraisalFinding): Promise<FixResult> {
  if (f.followUp.kind !== 'fix' || !f.fix)
    throw new AppraisalError(
      'NO_FIX',
      f.followUp.kind === 'judgement'
        ? `This finding has no single right repair: ${f.followUp.decide} (${f.followUp.tool}).`
        : 'This finding is reported only; there is nothing to propose.',
    );
  switch (f.fix.kind) {
    case 'em_dash_name':
      return fixName(d, f);
    case 'em_dash_text':
    case 'blank_paragraphs':
    case 'heading_links':
      return fixBody(d, f, f.fix.kind);
    case 'asset_extension':
      return fixAsset(d, f);
    case 'related_noncurrent':
      return fixRelated(d, f);
    case 'audit':
      throw new AppraisalError('USE_AUDIT', 'This fix is the audit’s own “Propose a fix”.');
  }
}
