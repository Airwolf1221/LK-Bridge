/**
 * Rules, template checks and tag rules (v2 E2, ADR 0044; PLAN-v2 4.12; the old bridge's audits carried over).
 *
 * Pages are selected by rule (`referenceType`, `namePrefix`, `ancestorName`, and v2's `registryType` with a `role`, and
 * `kind`; every given selector must match). Overlapping rules, a duplicate ancestor or template name, and a page no rule
 * matches are findings, never guesses. A page with exactly one rule is compared with that rule's template:
 *
 * - sidebar property titles, kinds, relative order, visibility and title/display flags;
 * - key-value row keys and their relative order;
 * - document tab names, types and relative order (a blank template tab may become a populated page).
 *
 * NEVER values. Extra fields of the owner's are not errors (only what the template has is required).
 *
 * Tag rules come from the tag-definition document: exactly one `json` code block, `{ "schema": 1, "rules": [ { "id",
 * "required_tags", "allowed_tags"? } ] }`, the ids naming audit rules. A missing required tag is a finding with an
 * additive fix; a tag outside `allowed_tags` is a finding with no removal proposal; duplicate tags are a finding.
 */
import * as z from 'zod';
import { templateBaseKey } from '../../registry/names.js';
import type { RegistryType } from '../../registry/index.js';
import type { AuditRule } from '../config.js';
import { contentPages, fact, factAmbiguous, pathOf, type AuditContext } from '../context.js';
import { nameKey, type AuditPage, type PropertySummary } from '../model.js';
import type { FindingDraft } from '../types.js';

const key = (s: string | null | undefined): string => nameKey((s ?? '').replace(/\s+/g, ' '));

// ============================================================================================ selecting pages

type Match = 'yes' | 'no' | 'ambiguous_ancestor' | 'incomplete_ancestry';

/** The registry types a name (singular or plural) stands for. */
export function typesNamed(types: readonly RegistryType[], name: string): RegistryType[] {
  const k = key(name);
  return types.filter((t) => key(t.singular) === k || key(t.plural) === k);
}

/** A rule's registry selector resolved: the type, or why it could not be. */
function registrySelector(
  ctx: AuditContext,
  rule: AuditRule,
): { ok: true; type: RegistryType } | { ok: false; why: string } {
  const name = rule.selectors.registryType;
  if (name === undefined) return { ok: false, why: 'no registry type' };
  const t = typesNamed(ctx.types, name);
  if (t.length === 0) return { ok: false, why: `the registry has no type “${name}”` };
  if (t.length > 1) return { ok: false, why: `“${name}” names ${t.length} registry types` };
  const type = t[0]!;
  const role = rule.selectors.role;
  if (role !== undefined && role !== 'index') {
    const known = type.placementKind === 'character' && (role === 'core' || role === 'compact');
    if (!known)
      return {
        ok: false,
        why: `the type “${type.singular}” has no page role “${role}” the audits can recognise (a character type has core and compact; any type has index)`,
      };
  }
  return { ok: true, type };
}

function matchRule(ctx: AuditContext, rule: AuditRule, p: AuditPage): Match {
  const s = rule.selectors;
  if (s.kind !== undefined && p.kind !== s.kind) return 'no';
  if (s.namePrefix !== undefined && !p.rawName.startsWith(s.namePrefix)) return 'no';
  if (s.referenceType !== undefined) {
    if (factAmbiguous(p, ctx.treeSettings.referenceTypeRow)) return 'no';
    const rt = fact(ctx, p, ctx.treeSettings.referenceTypeRow);
    if (rt === null || key(rt) !== key(s.referenceType)) return 'no';
  }
  if (s.registryType !== undefined) {
    const r = registrySelector(ctx, rule);
    if (!r.ok) return 'no';
    const type = r.type;
    if (s.role === 'index') {
      if (p.kind !== 'index') return 'no';
    } else if (s.role !== undefined) {
      const rt = fact(ctx, p, ctx.treeSettings.referenceTypeRow);
      const want =
        s.role === 'core' ? type.placement?.referenceTypes.core : type.placement?.referenceTypes.compact;
      if (p.kind === 'index' || rt === null || want === undefined || key(rt) !== key(want)) return 'no';
    } else if (type.rootIndexId !== null) {
      const n = ctx.snapshotTree.node(p.id);
      if (!n || !n.path.ids.includes(type.rootIndexId) || p.id === type.rootIndexId) return 'no';
    } else return 'no';
  }
  if (s.ancestorName !== undefined) {
    const want = key(s.ancestorName);
    let hits = 0;
    let cur = p.parentId ? ctx.model.pages.get(p.parentId) : undefined;
    let complete = p.parentId === null;
    const seen = new Set<string>([p.id]);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (key(cur.displayName) === want) hits++;
      if (cur.id === ctx.model.rootId || cur.parentId === null) {
        complete = true;
        break;
      }
      cur = ctx.model.pages.get(cur.parentId);
    }
    if (!complete) return 'incomplete_ancestry';
    if (hits === 0) return 'no';
    if (hits > 1) return 'ambiguous_ancestor';
  }
  return 'yes';
}

// ============================================================================================ templates

type TemplateResult = { ok: true; template: AuditPage } | { ok: false; draft: FindingDraft };

function resolveTemplate(ctx: AuditContext, rule: AuditRule): TemplateResult {
  const templates = ctx.model.templates!;
  const t = rule.template;
  const fail = (
    code: 'template_not_found' | 'ambiguous_template',
    message: string,
    evidence: Record<string, unknown>,
  ): TemplateResult => ({
    ok: false,
    draft: { code, key: rule.id, message, evidence: { rule: rule.id, ...evidence } },
  });
  if (t.templateId !== undefined) {
    const hit = templates.get(t.templateId);
    return hit
      ? { ok: true, template: hit }
      : fail(
          'template_not_found',
          `Rule “${rule.name}”: the template ${t.templateId} is not in the snapshot.`,
          {
            templateId: t.templateId,
            available: [...templates.values()].map((x) => x.rawName).sort(),
          },
        );
  }
  if (t.templateName !== undefined) {
    const want = templateBaseKey(t.templateName);
    const hits = [...templates.values()].filter((x) => templateBaseKey(x.rawName) === want);
    if (hits.length === 1) return { ok: true, template: hits[0]! };
    if (hits.length === 0)
      return fail('template_not_found', `Rule “${rule.name}”: no template is named “${t.templateName}”.`, {
        templateName: t.templateName,
        available: [...templates.values()].map((x) => x.rawName).sort(),
      });
    return fail(
      'ambiguous_template',
      `Rule “${rule.name}”: ${hits.length} templates are named “${t.templateName}”; the rule does not guess.`,
      { templateName: t.templateName, templates: hits.map((x) => ({ id: x.id, name: x.rawName })) },
    );
  }
  // A registry role.
  const reg = t.registry!;
  const types = typesNamed(ctx.types, reg.type);
  if (types.length !== 1)
    return fail(
      types.length === 0 ? 'template_not_found' : 'ambiguous_template',
      `Rule “${rule.name}”: ${types.length === 0 ? `the registry has no type “${reg.type}”` : `“${reg.type}” names ${types.length} registry types`}.`,
      { registryType: reg.type },
    );
  const type = types[0]!;
  const id =
    reg.role === 'index'
      ? type.indexTemplateId
      : (type.pageTemplates.find((x) => x.role === reg.role)?.templateId ?? null);
  if (id === null)
    return fail(
      'template_not_found',
      `Rule “${rule.name}”: the registry type “${type.singular}” has no template for the role “${reg.role}”.`,
      { registryType: type.singular, role: reg.role },
    );
  const hit = templates.get(id);
  return hit
    ? { ok: true, template: hit }
    : fail(
        'template_not_found',
        `Rule “${rule.name}”: the registry’s ${reg.role} template ${id} is not in the snapshot.`,
        {
          templateId: id,
          registryType: type.singular,
          role: reg.role,
        },
      );
}

const titleKey = (p: PropertySummary): string => key(p.title ?? '');

/** The positions (in `page`) of the template's items, matched in order of appearance. */
function matchByKey<T>(
  tpl: readonly T[],
  page: readonly T[],
  k: (x: T) => string,
): { tpl: T; page: T | null; pageIndex: number }[] {
  const used = new Set<number>();
  return tpl.map((t) => {
    const idx = page.findIndex((x, i) => !used.has(i) && k(x) === k(t));
    if (idx >= 0) used.add(idx);
    return { tpl: t, page: idx >= 0 ? page[idx]! : null, pageIndex: idx };
  });
}

/** Whether the matched positions are in increasing order (the template's relative order is kept). */
const inOrder = (idx: readonly number[]): boolean => idx.every((v, i) => i === 0 || v > idx[i - 1]!);

export function compareWithTemplate(page: AuditPage, tpl: AuditPage, rule: AuditRule): FindingDraft[] {
  const out: FindingDraft[] = [];
  const base = { pageId: page.id };
  const ev = (more: Record<string, unknown>) => ({ rule: rule.id, template: tpl.rawName, ...more });
  // ---- sidebar
  if (page.properties !== null && tpl.properties !== null) {
    const m = matchByKey(tpl.properties, page.properties, titleKey);
    const present = m.filter((x) => x.page !== null);
    for (const x of m) {
      if (x.page === null) {
        out.push({
          ...base,
          code: 'property_missing',
          key: `${rule.id}:${titleKey(x.tpl)}`,
          message: `The sidebar lacks “${x.tpl.title ?? ''}” (${x.tpl.kind}), which the template “${tpl.rawName}” has.`,
          evidence: ev({ expected: { title: x.tpl.title, kind: x.tpl.kind }, found: null }),
        });
        continue;
      }
      if (x.page.kind !== x.tpl.kind) {
        out.push({
          ...base,
          code: 'property_kind_mismatch',
          key: `${rule.id}:${titleKey(x.tpl)}`,
          message: `“${x.tpl.title ?? ''}” is a ${x.page.kind} property; the template has a ${x.tpl.kind}.`,
          evidence: ev({ title: x.tpl.title, expected: x.tpl.kind, found: x.page.kind }),
        });
        continue;
      }
      const diffs: Record<string, { expected: unknown; found: unknown }> = {};
      if (x.page.isHidden !== x.tpl.isHidden)
        diffs.isHidden = { expected: x.tpl.isHidden, found: x.page.isHidden };
      if (x.page.isTitleHidden !== x.tpl.isTitleHidden)
        diffs.isTitleHidden = { expected: x.tpl.isTitleHidden, found: x.page.isTitleHidden };
      if (x.tpl.display !== null && x.page.display !== x.tpl.display)
        diffs.display = { expected: x.tpl.display, found: x.page.display };
      if (Object.keys(diffs).length > 0)
        out.push({
          ...base,
          code: 'property_presentation_mismatch',
          key: `${rule.id}:${titleKey(x.tpl)}`,
          message: `“${x.tpl.title ?? ''}” is shown differently from the template (${Object.keys(diffs).join(', ')}).`,
          evidence: ev({ title: x.tpl.title, differences: diffs }),
        });
      // ---- key-value rows: keys and their order, never values
      if (x.tpl.rows !== null && x.page.rows !== null) {
        const rm = matchByKey(x.tpl.rows, x.page.rows, (r) => key(r.key));
        for (const r of rm)
          if (r.page === null)
            out.push({
              ...base,
              code: 'property_row_missing',
              key: `${rule.id}:${titleKey(x.tpl)}:${key(r.tpl.key)}`,
              message: `“${x.tpl.title ?? ''}” lacks the row “${r.tpl.key}”, which the template has.`,
              evidence: ev({ property: x.tpl.title, expected: r.tpl.key, found: null }),
            });
        const idx = rm.filter((r) => r.page !== null).map((r) => r.pageIndex);
        if (!inOrder(idx))
          out.push({
            ...base,
            code: 'property_row_order_mismatch',
            key: `${rule.id}:${titleKey(x.tpl)}`,
            message: `The rows of “${x.tpl.title ?? ''}” are in another order than the template’s.`,
            evidence: ev({
              property: x.tpl.title,
              expected: x.tpl.rows.map((r) => r.key),
              found: x.page.rows.map((r) => r.key),
            }),
          });
      }
    }
    if (!inOrder(present.map((x) => x.pageIndex)))
      out.push({
        ...base,
        code: 'property_order_mismatch',
        key: rule.id,
        message: 'The sidebar properties are in another order than the template’s.',
        evidence: ev({
          expected: tpl.properties.map((p) => p.title),
          found: page.properties.map((p) => p.title),
        }),
      });
  }
  // ---- document tabs
  const dm = matchByKey(tpl.documents, page.documents, (d) => key(d.name ?? ''));
  for (const x of dm) {
    if (x.page === null) {
      out.push({
        ...base,
        code: 'document_missing',
        key: `${rule.id}:${key(x.tpl.name ?? '')}`,
        message: `The page has no document tab “${x.tpl.name ?? ''}”, which the template has.`,
        evidence: ev({ expected: { name: x.tpl.name, type: x.tpl.type }, found: null }),
      });
      continue;
    }
    // A blank template tab may have become a populated page (or anything else): only a typed tab must keep its type.
    if (x.tpl.type !== 'blank' && x.page.type !== x.tpl.type)
      out.push({
        ...base,
        code: 'document_type_mismatch',
        key: `${rule.id}:${key(x.tpl.name ?? '')}`,
        message: `The tab “${x.tpl.name ?? ''}” is a ${x.page.type}; the template has a ${x.tpl.type}.`,
        evidence: ev({ name: x.tpl.name, expected: x.tpl.type, found: x.page.type }),
      });
  }
  if (!inOrder(dm.filter((x) => x.page !== null).map((x) => x.pageIndex)))
    out.push({
      ...base,
      code: 'document_order_mismatch',
      key: rule.id,
      message: 'The document tabs are in another order than the template’s.',
      evidence: ev({ expected: tpl.documents.map((d) => d.name), found: page.documents.map((d) => d.name) }),
    });
  return out;
}

// ============================================================================================ tag rules

const tagRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    required_tags: z.array(z.string().min(1).max(200)).max(200),
    allowed_tags: z.array(z.string().min(1).max(200)).max(1000).optional(),
  })
  .strict();
export const tagDefinitionSchema = z
  .object({ schema: z.literal(1), rules: z.array(tagRuleSchema).max(200) })
  .strict();
export type TagRule = z.infer<typeof tagRuleSchema>;

export type TagDefinition = { ok: true; rules: TagRule[] } | { ok: false; error: string };

/**
 * The tag definition from the source document's code blocks: exactly one `json` block holding the schema; unknown
 * fields, duplicate rule ids, a missing or a malformed block are refused with a clear error.
 */
export function parseTagDefinition(
  blocks: readonly { readonly language: string; readonly text: string }[],
): TagDefinition {
  const json = blocks.filter((b) => b.language.trim().toLowerCase() === 'json');
  if (json.length === 0)
    return { ok: false, error: 'The tag-definition document holds no `json` code block.' };
  if (json.length > 1)
    return {
      ok: false,
      error: `The tag-definition document holds ${json.length} \`json\` code blocks; it must hold exactly one.`,
    };
  let value: unknown;
  try {
    value = JSON.parse(json[0]!.text);
  } catch (e) {
    return {
      ok: false,
      error: `The \`json\` code block is not valid JSON: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
  const r = tagDefinitionSchema.safeParse(value);
  if (!r.success)
    return {
      ok: false,
      error: `The tag definition is not valid: ${r.error.issues.map((i) => `${i.path.join('.') || 'document'}: ${i.message}`).join('; ')}.`,
    };
  const ids = r.data.rules.map((x) => x.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0)
    return {
      ok: false,
      error: `The tag definition repeats the rule id${dup.length > 1 ? 's' : ''} ${[...new Set(dup)].join(', ')}.`,
    };
  return { ok: true, rules: r.data.rules };
}

/** The tag definition the run read (or why it could not), from the model's kept code blocks. */
export function tagDefinitionOf(ctx: AuditContext): TagDefinition | null {
  if (!ctx.tagSource) return null;
  const page = ctx.model.pages.get(ctx.tagSource.pageId);
  if (!page)
    return { ok: false, error: `The tag-definition page ${ctx.tagSource.pageId} is not in the snapshot.` };
  const scan = page.scans.find((s) => s.documentId === ctx.tagSource!.documentId);
  if (!scan)
    return {
      ok: false,
      error: `The tag-definition document ${ctx.tagSource.documentId} is not a page document of “${page.displayName}” in the snapshot.`,
    };
  return parseTagDefinition(scan.codeBlocks);
}

// ============================================================================================ the check

export function rulesCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const rules = ctx.rules.filter((r) => r.enabled);
  const pages = contentPages(ctx).filter((p) => p.kind !== 'unclassified');

  // The rule-level problems, once each.
  for (const r of rules) {
    if (r.selectors.registryType !== undefined) {
      const sel = registrySelector(ctx, r);
      if (!sel.ok)
        out.push({
          code: 'rule_selector_unknown',
          key: r.id,
          message: `Rule “${r.name}”: ${sel.why}.`,
          evidence: {
            rule: r.id,
            registryType: r.selectors.registryType,
            role: r.selectors.role ?? null,
            why: sel.why,
          },
        });
    }
  }

  // Which rule owns which page.
  const owner = new Map<string, AuditRule>();
  for (const p of pages) {
    const yes: AuditRule[] = [];
    let incomplete: AuditRule | null = null;
    let ambiguousAncestor: AuditRule | null = null;
    for (const r of rules) {
      const m = matchRule(ctx, r, p);
      if (m === 'yes') yes.push(r);
      else if (m === 'incomplete_ancestry') incomplete ??= r;
      else if (m === 'ambiguous_ancestor') ambiguousAncestor ??= r;
    }
    if (incomplete && yes.length === 0) {
      out.push({
        code: 'incomplete_owner_ancestry',
        key: incomplete.id,
        pageId: p.id,
        message: `Rule “${incomplete.name}” names the ancestor “${incomplete.selectors.ancestorName}”, but the page’s parent chain does not reach the root in the snapshot.`,
        evidence: {
          rule: incomplete.id,
          ancestorName: incomplete.selectors.ancestorName,
          parentId: p.parentId,
        },
      });
      continue;
    }
    if (ambiguousAncestor && yes.length === 0) {
      out.push({
        code: 'ambiguous_ancestor',
        key: ambiguousAncestor.id,
        pageId: p.id,
        message: `Rule “${ambiguousAncestor.name}” names the ancestor “${ambiguousAncestor.selectors.ancestorName}”, but several ancestors of the page have that name; the rule does not guess.`,
        evidence: { rule: ambiguousAncestor.id, ancestorName: ambiguousAncestor.selectors.ancestorName },
      });
      continue;
    }
    if (yes.length > 1) {
      out.push({
        code: 'ambiguous_owner_rule',
        pageId: p.id,
        message: `${yes.length} rules match this page (${yes.map((r) => `“${r.name}”`).join(', ')}); none is applied.`,
        evidence: { rules: yes.map((r) => r.id).sort() },
      });
      continue;
    }
    if (yes.length === 0) {
      if (ctx.settings.reportUnmatched)
        out.push({
          code: 'no_matching_rule',
          pageId: p.id,
          message: 'No rule matches this page.',
          evidence: { kind: p.kind, referenceType: fact(ctx, p, ctx.treeSettings.referenceTypeRow) },
        });
      continue;
    }
    owner.set(p.id, yes[0]!);
  }

  // Template comparisons.
  if (ctx.model.templates === null) {
    if (owner.size > 0)
      out.push({
        code: 'templates_unavailable',
        message:
          'The newest full snapshot holds no templates (it was taken before the audits existed, or its template read failed), so no page was compared with its template. The next full snapshot takes them.',
        evidence: { snapshot: ctx.model.base.id, pagesWithARule: owner.size },
        sourceKind: 'bridge',
      });
  } else {
    const resolved = new Map<string, TemplateResult>();
    for (const r of new Set(owner.values())) {
      const t = resolveTemplate(ctx, r);
      resolved.set(r.id, t);
      if (!t.ok) out.push(t.draft);
    }
    for (const p of pages) {
      const r = owner.get(p.id);
      if (!r) continue;
      const t = resolved.get(r.id);
      if (!t?.ok) continue;
      out.push(...compareWithTemplate(p, t.template, r));
    }
  }

  // Tag rules.
  const def = tagDefinitionOf(ctx);
  if (def !== null) {
    if (!def.ok) {
      out.push({
        code: 'tag_definition_invalid',
        pageId: ctx.tagSource!.pageId,
        documentId: ctx.tagSource!.documentId,
        message: def.error,
        evidence: { error: def.error },
      });
    } else {
      const ruleIds = new Set(ctx.rules.map((r) => r.id));
      for (const tr of def.rules)
        if (!ruleIds.has(tr.id))
          out.push({
            code: 'tag_rule_unknown',
            key: tr.id,
            pageId: ctx.tagSource!.pageId,
            documentId: ctx.tagSource!.documentId,
            message: `The tag rule “${tr.id}” names no audit rule.`,
            evidence: { tagRule: tr.id, rules: [...ruleIds].sort() },
          });
      const byId = new Map(def.rules.map((x) => [x.id, x]));
      for (const p of pages) {
        const r = owner.get(p.id);
        const tr = r ? byId.get(r.id) : undefined;
        if (!r || !tr) continue;
        const have = p.tags.map((t) => key(t));
        const dupes = [...new Set(have.filter((t, i) => have.indexOf(t) !== i))];
        if (dupes.length > 0)
          out.push({
            code: 'duplicate_tags',
            pageId: p.id,
            message: `The page carries ${dupes.map((d) => `“${d}”`).join(', ')} more than once.`,
            evidence: { duplicates: dupes, tags: p.tags },
          });
        const missing = tr.required_tags.filter((t) => !have.includes(key(t)));
        if (missing.length > 0)
          out.push({
            code: 'missing_required_tags',
            key: r.id,
            pageId: p.id,
            message: `Rule “${r.name}” requires the tag${missing.length > 1 ? 's' : ''} ${missing.map((t) => `“${t}”`).join(', ')}.`,
            evidence: { rule: r.id, required: tr.required_tags, missing, tags: p.tags },
            fix: {
              kind: 'add_tags',
              args: { pageId: p.id, add: missing },
              summary: `Add the tag${missing.length > 1 ? 's' : ''} ${missing.join(', ')} to ${p.displayName}.`,
            },
          });
        if (tr.allowed_tags) {
          const allowed = new Set([...tr.allowed_tags, ...tr.required_tags].map((t) => key(t)));
          const outside = [...new Set(p.tags.filter((t) => !allowed.has(key(t))))];
          if (outside.length > 0)
            out.push({
              code: 'tags_outside_definition',
              key: r.id,
              pageId: p.id,
              message: `The tag${outside.length > 1 ? 's' : ''} ${outside.map((t) => `“${t}”`).join(', ')} ${outside.length > 1 ? 'are' : 'is'} not allowed by rule “${r.name}”.`,
              evidence: { rule: r.id, outside, allowed: tr.allowed_tags },
            });
        }
      }
    }
  }
  void pathOf;
  return out;
}
