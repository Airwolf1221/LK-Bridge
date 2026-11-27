/**
 * v3 F6d (ADR 0082; design T13 as amended on 26 November 2026): templated source names, category `taxonomy`, from the
 * snapshots, free.
 *
 * - **The report** (`templatedNamesReport`): every source in scope with its status (src/packs/names/template.ts), worked
 *   out ONCE per audit run (memoised on the run's context): the check reads it, and the audit service stores it for the
 *   Templated Names page.
 * - **`name_nontemplated`** (info; switchable per project, `checkTemplatedNames`): one finding per `rename` row. Held
 *   rows are on the page only, never findings, so they do not swamp Audits. Its fix (`templated_name`) is a rename
 *   through the rename engine (src/packs/rename/, arkona_rename's path, in its page mode): mentions show the new name by
 *   themselves, routing lines follow, the journal records the rename; the id, the prefix, the tags and the links stay.
 *
 * In scope (N1): sources ([BSRC], [BWRK], [BARC]) in the AI REPOSITORY. Never: indexes; Narratives; the Legacy Canon
 * Archive and the Design References; Working's infrastructure pages (a [BSRC] page directly in the Working or the
 * Archive index: an Authoritative page there is about the index, not a source of a subject); a registered character's
 * pages (primary category Character, a Character type of the vocabulary, or under a character's repository index): the
 * character tools name them.
 */
import { labelContext, labelsOf } from '../../appraisal/scope.js';
import { nameProblem } from '../../packs/engine/text.js';
import {
  judgeTemplatedNames,
  type NamePage,
  type TemplatedRow,
  type TemplateVocabulary,
} from '../../packs/names/template.js';
import { categoryFromTags, vocabularyOf } from '../../packs/retag/engine.js';
import { typeKey } from '../../packs/reftypes/vocabulary.js';
import type { PackRules } from '../../packs/types.js';
import { fact, factAmbiguous, isNarrativePage, type AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';

/** What the check needs besides the snapshots (built by the Templated Names service). */
export interface TemplatedNamesAuditInput {
  /** The approved pack's rules (they carry `templatedNames`). */
  readonly rules: PackRules;
  /** The vocabulary in force (its status: draft or published). Null: none. */
  readonly vocabulary: TemplateVocabulary | null;
  /** The owner's "Keep this name" rulings: page → the state hash. */
  readonly rulings: ReadonlyMap<string, string>;
  /** `checkTemplatedNames` (default on): off, the check reports nothing (the report is still built). */
  readonly check: boolean;
  /** Pages under a registered character's repository index. */
  readonly characterPages?: ReadonlySet<string>;
}

export interface TemplatedNamesReport {
  readonly rows: readonly TemplatedRow[];
  /** Sources left out of scope, by reason. */
  readonly excluded: Readonly<Record<string, number>>;
}

/** The Templated Names page's row for a page (the dashboard route). */
export const templatedRowLink = (pageId: string): string =>
  `/ui/templated-names?page=${encodeURIComponent(pageId)}`;

const memo = new WeakMap<AuditContext, TemplatedNamesReport | null>();

/** The report of a run (null: the approved pack carries no templated names). Memoised on the context. */
export function templatedNamesReport(ctx: AuditContext): TemplatedNamesReport | null {
  if (memo.has(ctx)) return memo.get(ctx)!;
  const input = ctx.templatedNames;
  const out = input?.rules.templatedNames ? build(ctx, input) : null;
  memo.set(ctx, out);
  return out;
}

function build(ctx: AuditContext, input: TemplatedNamesAuditInput): TemplatedNamesReport {
  const rules = input.rules;
  const t = rules.templatedNames!;
  const vocab = vocabularyOf(rules);
  const excluded: Record<string, number> = {};
  const skip = (why: string) => {
    excluded[why] = (excluded[why] ?? 0) + 1;
  };
  const characterTypes = new Set(
    (input.vocabulary?.lists.categories ?? [])
      .filter((c) => typeKey(c.category) === typeKey('Character'))
      .flatMap((c) => c.types.map((x) => x.name)),
  );
  const lc = labelContext(ctx.model.rootId, ctx.lifecycle);
  const lifecycleIndexes = new Set(
    [ctx.lifecycle.workingIndexId, ctx.lifecycle.archiveIndexId].filter((x): x is string => !!x),
  );
  const children = new Map<string, { id: string; rawName: string }[]>();
  for (const p of ctx.model.pages.values()) {
    if (!p.parentId) continue;
    const list = children.get(p.parentId) ?? [];
    list.push({ id: p.id, rawName: p.rawName });
    children.set(p.parentId, list);
  }
  const refRow = ctx.treeSettings.referenceTypeRow;
  const pages: NamePage[] = [];
  for (const p of ctx.model.pages.values()) {
    if (p.kind !== 'bsrc' && p.kind !== 'bwrk' && p.kind !== 'barc') continue;
    if (isNarrativePage(ctx, p.id)) {
      skip('narrative');
      continue;
    }
    const n = ctx.snapshotTree.node(p.id);
    if (!n) continue;
    const kinds = n.path.ids.map((x) => ctx.model.pages.get(x)?.kind ?? '');
    const l = labelsOf({ ids: n.path.ids, names: n.path.names, kinds }, lc);
    if (l.area === 'legacy') {
      skip('legacy canon archive');
      continue;
    }
    if (l.area !== null) {
      skip('design references');
      continue;
    }
    if (p.kind === 'bsrc' && p.parentId !== null && lifecycleIndexes.has(p.parentId)) {
      skip('working infrastructure');
      continue;
    }
    const c = categoryFromTags(p.tags, vocab);
    const category = 'primary' in c ? c.primary : null;
    const referenceType = factAmbiguous(p, refRow) ? null : fact(ctx, p, refRow);
    if (
      (category !== null && typeKey(category) === typeKey('Character')) ||
      (referenceType !== null && characterTypes.has(referenceType)) ||
      input.characterPages?.has(p.id) === true
    ) {
      skip('registered character');
      continue;
    }
    pages.push({
      id: p.id,
      rawName: p.rawName,
      displayName: p.displayName,
      parentId: p.parentId,
      category,
      subject: fact(ctx, p, t.subjectRow),
      ...(factAmbiguous(p, t.subjectRow) ? { subjectAmbiguous: true } : {}),
      referenceType,
      ...(factAmbiguous(p, refRow) ? { referenceTypeAmbiguous: true } : {}),
    });
  }
  const rows = judgeTemplatedNames({
    pages,
    vocabulary: input.vocabulary,
    siblings: (id) => children.get(id) ?? [],
    rulings: input.rulings,
    nameProblem: (name) => nameProblem(name, rules)?.message ?? null,
  });
  return { rows, excluded };
}

export function templatedNamesCheck(ctx: AuditContext): FindingDraft[] {
  const input = ctx.templatedNames;
  if (!input?.check) return [];
  const report = templatedNamesReport(ctx);
  if (!report) return [];
  const t = input.rules.templatedNames!;
  const out: FindingDraft[] = [];
  report.rows.forEach((r, i) => {
    if (r.status !== 'rename') return;
    out.push({
      code: 'name_nontemplated',
      key: r.proposed!,
      pageId: r.pageId,
      message: `${r.rawName} is not named by the template <Subject> - <Role>: it would be “${r.proposed}” (Subject “${r.subject}”, the role word of ${r.referenceType}: ${r.role}). The fix renames it through the rename engine; the id, the prefix, the tags and every link stay, and text naming the old name is listed for review.`,
      evidence: {
        current: r.rawName,
        proposed: r.proposed,
        subject: r.subject,
        referenceType: r.referenceType,
        role: r.role,
        category: r.category,
        // The run order (primary category, then name): the automation renames in this order.
        order: i,
        link: templatedRowLink(r.pageId),
      },
      fix: {
        kind: 'templated_name',
        args: {
          pageId: r.pageId,
          name: r.rawName,
          to: r.proposed,
          subject: r.subject,
          referenceType: r.referenceType,
          subjectRow: t.subjectRow,
          referenceTypeRow: ctx.treeSettings.referenceTypeRow,
        },
        summary: `Rename ${r.rawName} to ${r.proposed} (the template).`,
      },
    });
  });
  return out;
}
