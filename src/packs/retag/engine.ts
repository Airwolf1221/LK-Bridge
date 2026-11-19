/**
 * The retag engine (v3 F3f, ADR 0060): one page's expected tag array under the closed grammar, with a rationale for each
 * slot and a disposition, from the Controlled Native Tagging Standard's "Classification and Manual Implementation
 * Procedure". PURE: the page's facts, tags, place and records in; the verdict out. The audit (`arkona_retag_audit`), the
 * apply's in-job re-check and the audits' tag findings all call it, so they cannot disagree.
 *
 * - **Scope.** Current Authoritative pages (`[BSRC]`, Status Authoritative) whose Continuity Type is CANON with
 *   Continuity Main, or AU (the owner's ruling of 16 November 2026: `AU` in place of `CANON`), get the automatic grammar.
 *   Working and Archived pages are checked only for the lifecycle grammar (the audits' "lifecycle tag not leading",
 *   reused). Navigation indexes, the governance sources' pages and the excluded areas (the Legacy Canon Archive, the
 *   Design References, repository governance) are never retagged by inference.
 * - **The primary category** comes only from deterministic evidence: the owner's confirmed classification, else the
 *   page's own pack record (a pack tool made it), else its current tags when they hold exactly one valid primary
 *   category that its Reference Type does not contradict. Two sources that disagree, or none, is a hold ("uncertain
 *   category; owner classification needed"). A name, a parent or the body is never evidence.
 * - **The specialist tag**, on the closed list for that category, backed the same way; otherwise omitted, with a hold.
 * - **Identity tokens** (a Character Core, a Compact Reference, the eligible references): Race / Species through the race
 *   map, Naming Culture through the culture map, each typed (a culture never borrows the race map), de-duplicated when
 *   the token is the same (the Standard's Otheiralth example). Missing, `Unestablished`, unmapped or contradictory: that
 *   slot is omitted, with a hold.
 * - **No other tag is ever proposed.** A tag outside the grammar is removed only when the Standard's Excluded Routine
 *   Tags list it (a deterministic correction); any other is an owner exception, kept.
 * - **Status and lifecycle tags are never added or removed**: a required status tag present is moved first; one missing
 *   or wrong is a hold (the lifecycle tools' work).
 *
 * The array itself comes from F3a's tag engine (`computeTags`) with the approved pack version's rules, so a page a pack
 * tool made and the retag agree by construction.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../../jobs/sidebar-state.js';
import { leadingProblem, sameTag, type LifecycleTagRules } from '../../lifecycle/tags.js';
import { computeTags, statusTag } from '../engine/tags.js';
import { textKey } from '../engine/text.js';
import { factValueKey } from '../../facts/rules.js';
import type { OwnerType, PackRules, RetagRules, RoleRule, TypeRules } from '../types.js';

// ============================================================================================ types

export type Disposition = 'compliant' | 'correction' | 'hold' | 'exception';
export type Slot = 'status' | 'primary' | 'specialist' | 'race' | 'culture' | 'other';

/** Why a page is outside the automatic grammar. */
export type ExclusionCode =
  'index' | 'governance' | 'area' | 'unclassified' | 'continuity' | 'not_in_snapshots';

export type HoldKind = 'uncertain_category' | 'specialist' | 'identity' | 'status' | 'scope';

export interface SlotRationale {
  readonly slot: Slot;
  /** The tag the slot holds in the proposed array (null: omitted). */
  readonly tag: string | null;
  /** Which fact, record or rule it comes from, in words. */
  readonly source: string;
  /** Set when the slot is held (omitted, or kept as it is for the owner). */
  readonly held?: string;
}

export interface Hold {
  readonly kind: HoldKind;
  readonly slot: Slot;
  readonly reason: string;
  readonly value?: string | null;
}

export interface RetagException {
  readonly tag: string;
  readonly reason: string;
}

/** An owner-confirmed classification (C), or a pack tool's record of a page it made. */
export interface ClassificationRecord {
  readonly primary: string;
  readonly specialist: string | null;
  /** Words for the rationale: who, when, which tool. */
  readonly detail: string;
}

/** A fact as the snapshots hold it: its text, and how many rows of that key the page has. */
export interface FactCell {
  readonly text: string;
  readonly count: number;
}

export interface RetagPageInput {
  readonly id: string;
  /** The name as stored, prefix included. */
  readonly rawName: string;
  /** `bsrc`, `bwrk`, `barc`, `index`, `root`, `plain`… (the tree's classification of the name). */
  readonly kind: string;
  readonly tags: readonly string[];
  /** The PROPERTIES rows by lower-case key (the audits' extraction). */
  readonly facts: ReadonlyMap<string, FactCell>;
  /** Working or Archived by place (inside a lifecycle area), when the prefix does not say. */
  readonly lifecycle: 'Authoritative' | 'Working' | 'Archived' | null;
  /** The names of the indexes above it (root first): an excluded area is found among them. */
  readonly ancestors: readonly string[];
  /** The appraisal's non-current area label (`legacy`, `design`), when one. */
  readonly area: string | null;
  readonly templateId: string | null;
  readonly packRecord: ClassificationRecord | null;
  readonly owner: ClassificationRecord | null;
  /**
   * CR-2026-11-R3 (R3-04): the page's parent when audited. Recorded with the verdict (not in its basis, so the inputs
   * hash is unchanged): the apply's check and its write compare it, so a page moved since is never written.
   */
  readonly parentId?: string | null;
}

export interface RetagContext {
  /** The approved pack version's rules. */
  readonly rules: PackRules;
  /** The lifecycle settings: status values, the fields and the lifecycle tags. */
  readonly lifecycle: {
    readonly status: { readonly authoritative: string; readonly working: string; readonly archived: string };
    readonly tags: { readonly canon: string; readonly working: string; readonly archived: string };
    readonly fields: { readonly status: string; readonly continuityType: string };
  };
  readonly tagRules: LifecycleTagRules;
  /** The sidebar row holding the Reference Type. */
  readonly referenceTypeRow: string;
  /** The governance sources' pages (never retagged). */
  readonly governanceIds: ReadonlySet<string>;
}

export interface RetagVerdict {
  readonly pageId: string;
  readonly name: string;
  readonly scope: 'grammar' | 'lifecycle' | 'excluded';
  readonly excluded?: { readonly code: ExclusionCode; readonly reason: string };
  /** Working and Archived pages: the lifecycle grammar only (the audits' `lifecycle_tag_not_leading`). */
  readonly lifecycleCheck?: {
    readonly lifecycleTag: string;
    readonly ok: boolean;
    readonly notFirst: boolean;
    readonly statusTags: readonly string[];
    readonly finding: 'lifecycle_tag_not_leading' | null;
  };
  readonly current: readonly string[];
  readonly proposed: readonly string[];
  readonly slots: readonly SlotRationale[];
  readonly holds: readonly Hold[];
  readonly exceptions: readonly RetagException[];
  /** Tags the proposal removes, each with why (an Excluded Routine Tag, a duplicate, a held slot). */
  readonly removals: readonly { readonly tag: string; readonly why: string }[];
  readonly classification: {
    readonly primary: string;
    readonly specialist: string | null;
    readonly source: string;
  } | null;
  readonly disposition: Disposition | null;
  /** What the verdict was computed from (facts, Reference Type, template, records, tags): a change makes it stale. */
  readonly inputsHash: string;
  /** The inputs in words (Status, Continuity Type, Continuity, Inheritance, Subject, Scope, Reference Type, race, culture). */
  readonly inputs: Readonly<Record<string, string | null>>;
  /** What the hash covers besides the tags (so the hash a page will have once the proposed array is applied is known). */
  readonly basis: Readonly<Record<string, unknown>>;
  /** CR-2026-11-R3 (R3-04): the page's parent when audited (absent in runs stored before). */
  readonly parentId?: string | null;
}

/** The inputs hash of a page: its basis (facts, template, records, name) and its tags in order. */
export const inputsHashOf = (basis: Readonly<Record<string, unknown>>, tags: readonly string[]): string =>
  hash({ ...basis, tags });

// ============================================================================================ the vocabulary

/** The closed primary categories with their specialists, and what each Reference Type the pack fixes implies. */
export interface Vocabulary {
  readonly primaries: ReadonlyMap<string, Primary>;
  /** Reference Type (key) → the category and specialist it implies (`*`: some specialist, unnamed). */
  readonly referenceTypes: ReadonlyMap<string, { primary: string; specialist: string | null }>;
  /** Reference Types whose pages carry identity tokens (keys). */
  readonly identityReferenceTypes: ReadonlySet<string>;
  /** Every race token, culture token and exceptional kind (keys): a held identity slot's tags. */
  readonly identityTokens: ReadonlySet<string>;
  /** Every specialist tag of every category (keys). */
  readonly allSpecialists: ReadonlySet<string>;
}

export type Primary =
  | {
      readonly kind: 'type';
      readonly tag: string;
      readonly type: TypeRules;
      readonly specialists: readonly string[];
      readonly identityRole: RoleRule | null;
      readonly specialistRole: RoleRule | null;
    }
  | {
      readonly kind: 'owner';
      readonly tag: string;
      readonly owner: OwnerType;
      readonly specialists: readonly string[];
    };

const isSlot = (t: string) => t.startsWith('$');

/** A type's primary tag: the first literal after the status slot in its roles' grammars (`Character`). */
function typePrimary(t: TypeRules): string | null {
  for (const r of t.roles) {
    const lit = r.tags.find((x) => !isSlot(x));
    if (lit) return lit;
  }
  return null;
}

export function vocabularyOf(rules: PackRules): Vocabulary {
  const primaries = new Map<string, Primary>();
  const referenceTypes = new Map<string, { primary: string; specialist: string | null }>();
  const identity = new Set<string>((rules.retag?.identityReferenceTypes ?? []).map(textKey));
  const allSpecialists = new Set<string>();
  for (const t of rules.types) {
    const tag = typePrimary(t);
    if (!tag) continue;
    const identityRole = t.roles.find((r) => r.tags.includes('$race') || r.tags.includes('$culture')) ?? null;
    const specialistRole = t.roles.find((r) => r.tags.includes('$specialist')) ?? null;
    primaries.set(textKey(tag), {
      kind: 'type',
      tag,
      type: t,
      specialists: t.specialistTags,
      identityRole,
      specialistRole,
    });
    for (const s of t.specialistTags) allSpecialists.add(textKey(s));
    for (const r of t.roles) {
      if (!r.referenceType || r.tags.length === 0) continue;
      const lits = r.tags.filter((x) => !isSlot(x) && textKey(x) !== textKey(tag));
      const named = lits[0] ?? null;
      referenceTypes.set(textKey(r.referenceType), {
        primary: tag,
        specialist: r.tags.includes('$specialist') ? '*' : named,
      });
      if (r.tags.includes('$race') || r.tags.includes('$culture')) identity.add(textKey(r.referenceType));
    }
    for (const rt of Object.values(t.suggestedReferenceTypes))
      if (!referenceTypes.has(textKey(rt)))
        referenceTypes.set(textKey(rt), { primary: tag, specialist: '*' });
  }
  for (const o of rules.owners?.types ?? []) {
    const specialists = [
      ...o.specialist,
      ...Object.values(o.kinds ?? {})
        .map((k) => k?.specialist ?? null)
        .filter((x): x is string => x !== null),
    ];
    if (!primaries.has(textKey(o.primary)))
      primaries.set(textKey(o.primary), { kind: 'owner', tag: o.primary, owner: o, specialists });
    for (const s of specialists) allSpecialists.add(textKey(s));
    for (const k of Object.values(o.kinds ?? {}))
      if (k?.referenceType)
        referenceTypes.set(textKey(k.referenceType), { primary: o.primary, specialist: k.specialist });
  }
  const identityTokens = new Set<string>([
    ...Object.values(rules.tags.race).map(textKey),
    ...Object.values(rules.tags.culture).map(textKey),
    ...rules.tags.exceptional.map(textKey),
  ]);
  return { primaries, referenceTypes, identityReferenceTypes: identity, identityTokens, allSpecialists };
}

/** Whether `tag` is a valid specialist of the category `primary`. */
export function specialistOf(v: Vocabulary, primary: string, tag: string): string | null {
  const p = v.primaries.get(textKey(primary));
  return p?.specialists.find((s) => textKey(s) === textKey(tag)) ?? null;
}

// ============================================================================================ helpers

const factOf = (facts: ReadonlyMap<string, FactCell>, key: string) => {
  const f = facts.get(key.normalize('NFC').trim().toLowerCase());
  if (!f) return { value: null as string | null, ambiguous: false };
  const t = f.text.trim();
  return { value: t === '' ? null : t, ambiguous: f.count > 1 };
};

const hash = (v: unknown) => createHash('sha1').update(stableJson(v)).digest('hex');

/** The identity fields' sidebar rows (the Character type's `race` and `namingCulture`). */
function identityKeys(rules: PackRules): { race: string; culture: string } {
  for (const t of rules.types) {
    const race = t.identity.find((f) => f.field === 'race')?.key;
    const culture = t.identity.find((f) => f.field === 'namingCulture')?.key;
    if (race && culture) return { race, culture };
  }
  return { race: 'Race / Species', culture: 'Naming Culture' };
}

const STATUS_WORDS = (ctx: RetagContext): string[] => {
  const t = ctx.lifecycle.tags;
  return [t.canon, t.working, t.archived, ...(ctx.tagRules.au ? [ctx.tagRules.au.tag] : [])];
};

// ============================================================================================ the verdict

export function retagPage(page: RetagPageInput, ctx: RetagContext): RetagVerdict {
  const rules = ctx.rules;
  const keys = identityKeys(rules);
  const lc = ctx.lifecycle;
  const f = (k: string) => factOf(page.facts, k);
  const inputs: Record<string, string | null> = {
    Status: f(lc.fields.status).value,
    'Continuity Type': f(lc.fields.continuityType).value,
    Continuity: f('Continuity').value,
    Inheritance: f('Inheritance').value,
    Subject: f('Subject').value,
    Scope: f('Scope').value,
    'Reference Type': f(ctx.referenceTypeRow).value,
    [keys.race]: f(keys.race).value,
    [keys.culture]: f(keys.culture).value,
  };
  const basis = {
    inputs,
    ambiguous: [
      lc.fields.status,
      lc.fields.continuityType,
      ctx.referenceTypeRow,
      keys.race,
      keys.culture,
    ].filter((k) => f(k).ambiguous),
    template: page.templateId,
    packRecord: page.packRecord ? [page.packRecord.primary, page.packRecord.specialist] : null,
    owner: page.owner ? [page.owner.primary, page.owner.specialist] : null,
    name: page.rawName,
    kind: page.kind,
  };
  const inputsHash = inputsHashOf(basis, page.tags);
  const base = {
    pageId: page.id,
    name: page.rawName,
    current: [...page.tags],
    inputsHash,
    basis,
    inputs,
    ...(page.parentId !== undefined ? { parentId: page.parentId } : {}),
  };
  const excluded = (code: ExclusionCode, reason: string): RetagVerdict => ({
    ...base,
    scope: 'excluded',
    excluded: { code, reason },
    proposed: [...page.tags],
    slots: [],
    holds: [],
    exceptions: [],
    removals: [],
    classification: null,
    disposition: null,
  });

  // ---- scope
  if (page.kind === 'root' || page.kind === 'index')
    return excluded('index', 'a navigation index: never retagged by inference');
  if (ctx.governanceIds.has(page.id))
    return excluded('governance', 'a governance source of the pack: repository governance is never retagged');
  const areas = (rules.retag?.excludedAreas ?? []).map(textKey);
  const inArea = page.ancestors.find((a) => areas.includes(textKey(a)));
  if (inArea || page.area)
    return excluded(
      'area',
      `inside ${inArea ?? (page.area === 'legacy' ? 'the Legacy Canon Archive' : 'the Design References')}: never retagged by inference`,
    );
  const state =
    page.kind === 'bwrk' || (page.kind !== 'bsrc' && page.lifecycle === 'Working')
      ? 'working'
      : page.kind === 'barc' || (page.kind !== 'bsrc' && page.lifecycle === 'Archived')
        ? 'archived'
        : page.kind === 'bsrc'
          ? 'authoritative'
          : null;
  if (state === null)
    return excluded(
      'unclassified',
      'no lifecycle prefix ([BSRC], [BWRK] or [BARC]): its standing cannot be told',
    );
  if (state !== 'authoritative') {
    const tag = state === 'working' ? lc.tags.working : lc.tags.archived;
    const status = [lc.tags.canon, ...(ctx.tagRules.au ? [ctx.tagRules.au.tag] : [])];
    const lp = ctx.tagRules.position === 'lead' ? leadingProblem(page.tags, tag, status) : null;
    return {
      ...base,
      scope: 'lifecycle',
      lifecycleCheck: {
        lifecycleTag: tag,
        ok: lp === null,
        notFirst: lp?.notFirst ?? false,
        statusTags: lp?.statusTags ?? [],
        finding: lp ? 'lifecycle_tag_not_leading' : null,
      },
      proposed: [...page.tags],
      slots: [],
      holds: [],
      exceptions: [],
      removals: [],
      classification: null,
      disposition: null,
    };
  }

  const holds: Hold[] = [];
  const slots: SlotRationale[] = [];
  const exceptions: RetagException[] = [];
  const removals: { tag: string; why: string }[] = [];
  const v = vocabularyOf(rules);
  const ct = f(lc.fields.continuityType);
  const continuity = f('Continuity');
  const status = f(lc.fields.status);
  const rt = f(ctx.referenceTypeRow);
  const fixedCt = rules.types[0]?.fixedFacts['Continuity Type'] ?? 'CANON';
  const fixedContinuity = rules.types[0]?.fixedFacts.Continuity ?? 'Main';
  const isAu =
    ctx.tagRules.au !== null && ct.value !== null && sameTag(ct.value, ctx.tagRules.au.continuityType);

  if (ct.ambiguous || ct.value === null)
    holds.push({
      kind: 'scope',
      slot: 'status',
      reason: ct.ambiguous
        ? `${lc.fields.continuityType} appears more than once: whether the automatic grammar applies cannot be told`
        : `${lc.fields.continuityType} is missing: whether the automatic grammar applies cannot be told`,
    });
  else if (!isAu) {
    if (!sameTag(ct.value, fixedCt))
      return excluded(
        'continuity',
        `${lc.fields.continuityType} ${ct.value}: only Main ${fixedCt} and AU owners get the automatic grammar`,
      );
    if (continuity.ambiguous || (continuity.value !== null && !sameTag(continuity.value, fixedContinuity)))
      return excluded(
        'continuity',
        `Continuity ${continuity.value ?? '(more than one)'}: only Main ${fixedCt} and AU owners get the automatic grammar`,
      );
    if (continuity.value === null)
      holds.push({
        kind: 'scope',
        slot: 'status',
        reason: 'Continuity is missing: Main cannot be confirmed',
      });
  }
  if (status.ambiguous || status.value === null || !sameTag(status.value, lc.status.authoritative))
    holds.push({
      kind: 'status',
      slot: 'status',
      reason: `${lc.fields.status} is ${status.ambiguous ? 'given more than once' : (status.value ?? 'missing')}, not ${lc.status.authoritative}: the lifecycle tools’ (and the audit’s lifecycle_inconsistent), never retagging`,
    });

  // ---- the status tag: never added or removed; a required one present is moved first
  const required = statusTag(rules, 'authoritative', isAu ? ct.value : (ct.value ?? null));
  const statusWords = STATUS_WORDS(ctx);
  // CR-2026-11-R3 (R3-06, R3-07): every spelling of a status or lifecycle tag, as the facts fold reads it.
  const statusKeys = new Set(statusWords.map(factValueKey));
  const statusPresent = dedupe(page.tags.filter((t) => statusWords.some((s) => sameTag(s, t))));
  const hasRequired = statusPresent.some((t) => sameTag(t, required));
  const wrongStatus = statusPresent.filter((t) => !sameTag(t, required));
  const statusLead = hasRequired
    ? [statusPresent.find((t) => sameTag(t, required))!, ...wrongStatus]
    : [...statusPresent];
  if (!hasRequired)
    holds.push({
      kind: 'status',
      slot: 'status',
      reason: `the status tag ${required} is missing: retagging never adds a status tag (the lifecycle tools’ work)`,
      value: required,
    });
  if (wrongStatus.length > 0)
    holds.push({
      kind: 'status',
      slot: 'status',
      reason: `${wrongStatus.join(', ')} on an Authoritative ${isAu ? 'AU' : fixedCt} page: retagging never removes a status or lifecycle tag (the lifecycle tools’ work)`,
      value: wrongStatus.join(', '),
    });
  slots.push({
    slot: 'status',
    tag: hasRequired ? required : null,
    source: isAu
      ? `${required}: ${lc.fields.status} ${lc.status.authoritative}, ${lc.fields.continuityType} ${ct.value} (the owner’s AU ruling of 16 November 2026)`
      : `${required}: ${lc.fields.status} ${status.value ?? '(missing)'}, ${lc.fields.continuityType} ${ct.value ?? '(missing)'}, Continuity ${continuity.value ?? '(missing)'}`,
    ...(hasRequired ? {} : { held: 'missing: never added by retagging' }),
  });

  // ---- the primary category and specialist
  const cls = classify(page, v, rt);
  if ('hold' in cls) {
    holds.push(...cls.hold);
    slots.push({
      slot: 'primary',
      tag: null,
      source: cls.evidence,
      held: cls.hold[0]?.reason ?? 'uncertain',
    });
    return finish({
      base,
      proposed: [...page.tags],
      slots,
      holds,
      exceptions,
      removals,
      classification: null,
    });
  }
  const { primary, specialist } = cls;
  const prim = v.primaries.get(textKey(primary))!;
  slots.push({ slot: 'primary', tag: prim.tag, source: `${prim.tag}: ${cls.source}` });
  if (cls.specialistHold) holds.push(cls.specialistHold);

  // ---- the grammar, by F3a's tag engine
  let role: RoleRule;
  let identity = false;
  if (prim.kind === 'type') {
    if (specialist === null) {
      const rtKey = rt.value ? textKey(rt.value) : null;
      if (rtKey !== null && v.identityReferenceTypes.has(rtKey) && prim.identityRole) {
        role = prim.identityRole;
        identity = true;
      } else {
        role = prim.specialistRole ?? prim.type.roles[0]!;
        if (!cls.specialistHold)
          holds.push({
            kind: 'specialist',
            slot: 'specialist',
            reason:
              rt.value === null
                ? `no specialist tag and no ${ctx.referenceTypeRow}: whether it is an identity page or a specialist page cannot be told (owner classification needed)`
                : `no specialist tag, and ${ctx.referenceTypeRow} “${rt.value}” is not an identity reference: its specialist needs the owner’s classification`,
          });
      }
    } else role = prim.specialistRole ?? prim.type.roles[0]!;
  } else {
    role = {
      role: 'owner',
      template: prim.owner.template,
      name: '{Name}',
      referenceType: null,
      tags: rules.owners?.tags.authoritative ?? ['$status', '$primary', '$specialist'],
      facts: 'general',
      body: 'optional',
      warnMissing: [],
      max: 1,
    };
  }
  const race = f(keys.race);
  const culture = f(keys.culture);
  const unestablished =
    prim.kind === 'type' ? prim.type.unestablished : (rules.owners?.unestablished ?? 'Unestablished');
  const computed = computeTags({
    rules,
    role,
    page: page.id,
    status: 'authoritative',
    race: identity ? (race.ambiguous ? null : race.value) : null,
    culture: identity ? (culture.ambiguous ? null : culture.value) : null,
    specialist,
    unestablished,
    continuityType: ct.value,
    primary: prim.tag,
  });
  // The status slot is the one above (never added): F3a's array without its own status tag.
  const grammar = computed.tags.filter(
    (t) => !sameTag(t, required) && !statusWords.some((s) => sameTag(s, t)),
  );
  if (specialist !== null)
    slots.push({
      slot: 'specialist',
      tag: grammar.find((t) => sameTag(t, specialist)) ?? specialist,
      source: `${specialist}: ${cls.specialistSource}`,
    });
  else if (!identity)
    slots.push({
      slot: 'specialist',
      tag: null,
      source: cls.specialistHold ? cls.specialistSource : 'none',
      ...(holds.some((h) => h.slot === 'specialist') ? { held: 'omitted: owner classification needed' } : {}),
    });
  if (identity) {
    let raceToken: string | null = null;
    for (const [slot, cell, key, map] of [
      ['race', race, keys.race, 'race'],
      ['culture', culture, keys.culture, 'culture'],
    ] as const) {
      const held = computed.held.find((h) => h.slot === slot);
      if (cell.ambiguous) {
        holds.push({
          kind: 'identity',
          slot,
          reason: `${key} is given more than once (contradictory): the ${slot} token is omitted`,
        });
        slots.push({ slot, tag: null, source: `${key}: more than one value`, held: 'contradictory' });
        continue;
      }
      if (held) {
        holds.push({
          kind: 'identity',
          slot,
          reason: `${key} ${held.value === null ? 'is missing' : `“${held.value}”`}: ${held.reason}; the ${slot} token is omitted`,
          value: held.value,
        });
        slots.push({
          slot,
          tag: null,
          source: `${key} ${held.value === null ? '(missing)' : `“${held.value}”`}`,
          held: held.reason,
        });
        continue;
      }
      const token = grammarToken(grammar, rules, map, cell.value!);
      // CR-2026-11-R3 (R3-07): a token map that gives a status or lifecycle tag (or a spelling of one) is never used.
      if (token !== null && statusKeys.has(factValueKey(token))) {
        holds.push({
          kind: 'identity',
          slot,
          reason: `the ${map} token map gives “${token}” for ${key} “${cell.value}”, which reads as a status or lifecycle tag: never added; the owner corrects the token map`,
          value: cell.value,
        });
        slots.push({ slot, tag: null, source: `${key} “${cell.value}”`, held: 'its token is a status tag' });
        continue;
      }
      if (slot === 'race') raceToken = token;
      const dup = slot === 'culture' && raceToken !== null && token !== null && sameTag(token, raceToken);
      slots.push({
        slot,
        tag: token,
        source: `${token}: ${key} “${cell.value}” through the ${map} token map${dup ? ` (the same token as the race, kept once: the race and the culture stay distinct facts)` : ''}`,
      });
    }
  }

  // ---- every other tag: an Excluded Routine Tag is removed; a held slot's token omitted; anything else an exception
  const routine = new Set((rules.retag?.excludedRoutineTags ?? []).map(textKey));
  const kept: string[] = [];
  const seen = new Set<string>();
  const heldIdentity = holds.some((h) => h.kind === 'identity');
  const heldSpecialist = holds.some((h) => h.kind === 'specialist');
  for (const t of page.tags) {
    const k = textKey(t);
    if (seen.has(k)) {
      removals.push({ tag: t, why: 'a duplicate (the same tag twice)' });
      continue;
    }
    seen.add(k);
    if (statusWords.some((s) => sameTag(s, t))) continue;
    if (grammar.some((g) => sameTag(g, t))) continue;
    if (routine.has(k)) {
      removals.push({ tag: t, why: 'listed in the Tagging Standard’s Excluded Routine Tags' });
      continue;
    }
    if (heldIdentity && v.identityTokens.has(k)) {
      removals.push({
        tag: t,
        why: 'an identity token whose slot is held (omitted until the fact is settled)',
      });
      continue;
    }
    if (heldSpecialist && v.allSpecialists.has(k)) {
      removals.push({
        tag: t,
        why: 'a specialist whose slot is held (omitted until the owner classifies it)',
      });
      continue;
    }
    if (v.primaries.has(k) && cls.from === 'owner') {
      removals.push({
        tag: t,
        why: `a second primary category: the owner classified the page as ${prim.tag}`,
      });
      continue;
    }
    if (v.primaries.has(k)) {
      removals.push({ tag: t, why: `a second primary category (the page is ${prim.tag})` });
      holds.push({
        kind: 'uncertain_category',
        slot: 'primary',
        reason: `the tags also carry the primary category ${t}: uncertain category; owner classification needed`,
        value: t,
      });
      continue;
    }
    exceptions.push({
      tag: t,
      reason: `“${t}” is outside the grammar and not an Excluded Routine Tag: whether it is incidental is the owner’s judgement (kept)`,
    });
    kept.push(t);
    slots.push({
      slot: 'other',
      tag: t,
      source: `“${t}”: an existing tag outside the grammar`,
      held: 'an owner exception: kept',
    });
  }
  const proposed = dedupe([...statusLead, ...grammar, ...kept]);
  // CR-2026-11-R3 (R3-06, R3-07): status and lifecycle tags are never added or removed, only moved first, whatever
  // spelling they carry. Every tag that reads as one of them through the facts fold (case, width, invisible characters,
  // Cyrillic, Greek, Cherokee and small-capital look-alikes) must be in the proposed array exactly as on the page, as
  // many times; anything else (a "duplicate" spelling dropped, a token map or an Excluded Routine Tag naming one) is a
  // status hold: the lifecycle tools' or the owner's, never a correction.
  const statusLike = (tags: readonly string[]) =>
    tags.filter((t) => statusKeys.has(factValueKey(t))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const was = statusLike(page.tags);
  const will = statusLike(proposed);
  if (was.length !== will.length || was.some((t, i) => t !== will[i]))
    holds.push({
      kind: 'status',
      slot: 'status',
      reason:
        `the correction would change the status or lifecycle tags (${was.join(', ') || 'none'} → ${will.join(', ') || 'none'}), ` +
        'counting every spelling of them: retagging never adds or removes one (the lifecycle tools’ work, or the owner’s)',
      value: was.join(', '),
    });
  return finish({
    base,
    proposed,
    slots,
    holds,
    exceptions,
    removals,
    classification: { primary: prim.tag, specialist, source: cls.source },
  });
}

function finish(o: {
  base: Pick<RetagVerdict, 'pageId' | 'name' | 'current' | 'inputsHash' | 'inputs' | 'basis' | 'parentId'>;
  proposed: string[];
  slots: SlotRationale[];
  holds: Hold[];
  exceptions: RetagException[];
  removals: { tag: string; why: string }[];
  classification: RetagVerdict['classification'];
}): RetagVerdict {
  const same =
    o.proposed.length === o.base.current.length && o.proposed.every((t, i) => t === o.base.current[i]);
  const disposition: Disposition =
    o.holds.length > 0 ? 'hold' : o.exceptions.length > 0 ? 'exception' : same ? 'compliant' : 'correction';
  return {
    ...o.base,
    scope: 'grammar',
    proposed: o.proposed,
    slots: o.slots,
    holds: o.holds,
    exceptions: o.exceptions,
    removals: o.removals,
    classification: o.classification,
    disposition,
  };
}

function dedupe(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (!out.some((x) => sameTag(x, t))) out.push(t);
  return out;
}

/** The token the grammar holds for a value of this map (as `computeTags` found it). */
function grammarToken(
  grammar: readonly string[],
  rules: PackRules,
  map: 'race' | 'culture',
  value: string,
): string | null {
  const table = map === 'race' ? rules.tags.race : rules.tags.culture;
  const k = textKey(value);
  const hit = Object.entries(table).find(([key]) => textKey(key) === k)?.[1];
  const token =
    hit ?? (map === 'race' ? (rules.tags.exceptional.find((x) => textKey(x) === k) ?? null) : null);
  return token ? (grammar.find((g) => sameTag(g, token)) ?? token) : null;
}

// ============================================================================================ classification

type Classified =
  | {
      readonly primary: string;
      readonly specialist: string | null;
      readonly source: string;
      readonly specialistSource: string;
      readonly specialistHold?: Hold;
      /** Which evidence decided the category. */
      readonly from: 'owner' | 'pack' | 'tags';
    }
  | { readonly hold: Hold[]; readonly evidence: string };

/** The category the tags show: exactly one valid primary (another primary read as its specialist), else why not. */
export function categoryFromTags(
  tags: readonly string[],
  v: Vocabulary,
): { primary: string; specialists: string[] } | { problem: string } {
  const prims = dedupe(tags.filter((t) => v.primaries.has(textKey(t))));
  if (prims.length === 0) return { problem: 'no primary category tag' };
  const readings = prims
    .map((p) => {
      const others = prims.filter((x) => !sameTag(x, p));
      const ok = others.length <= 1 && others.every((o) => specialistOf(v, p, o) !== null);
      return ok ? p : null;
    })
    .filter((x): x is string => x !== null);
  if (readings.length !== 1)
    return {
      problem:
        readings.length === 0
          ? `${prims.length} primary categories (${prims.join(', ')})`
          : `the tags read as more than one category (${readings.join(', ')})`,
    };
  const primary = readings[0]!;
  const specialists = dedupe(
    tags.filter((t) => !sameTag(t, primary) && specialistOf(v, primary, t) !== null),
  );
  return { primary, specialists };
}

function classify(
  page: RetagPageInput,
  v: Vocabulary,
  rt: { value: string | null; ambiguous: boolean },
): Classified {
  const uncertain = (why: string, evidence: string): Classified => ({
    hold: [
      {
        kind: 'uncertain_category',
        slot: 'primary',
        reason: `uncertain category; owner classification needed (${why})`,
      },
    ],
    evidence,
  });
  // 1. The owner's confirmed classification decides (C): it is the owner's judgement, recorded and audited.
  if (page.owner) {
    const p = v.primaries.get(textKey(page.owner.primary));
    if (!p)
      return uncertain(
        `the owner’s classification names ${page.owner.primary}, which is not on the closed list`,
        'the owner’s classification',
      );
    const s = page.owner.specialist === null ? null : specialistOf(v, p.tag, page.owner.specialist);
    if (page.owner.specialist !== null && s === null)
      return uncertain(
        `the owner’s classification names the specialist ${page.owner.specialist}, which ${p.tag} does not have`,
        'the owner’s classification',
      );
    return {
      primary: p.tag,
      specialist: s,
      source: `the owner’s classification (${page.owner.detail})`,
      specialistSource: s
        ? `the owner’s classification (${page.owner.detail})`
        : 'none (the owner’s classification)',
      from: 'owner',
    };
  }
  const rtInfo = rt.value && !rt.ambiguous ? v.referenceTypes.get(textKey(rt.value)) : undefined;
  const fromTags = categoryFromTags(page.tags, v);
  // 2. The page's own pack record (a pack tool made it).
  if (page.packRecord) {
    const p = v.primaries.get(textKey(page.packRecord.primary));
    if (!p)
      return uncertain(
        `its pack record names ${page.packRecord.primary}, not on the closed list`,
        'its pack record',
      );
    if ('primary' in fromTags && !sameTag(fromTags.primary, p.tag))
      return uncertain(
        `its pack record says ${p.tag}, its tags say ${fromTags.primary}`,
        'its pack record and its tags disagree',
      );
    if (rtInfo && !sameTag(rtInfo.primary, p.tag))
      return uncertain(
        `its Reference Type “${rt.value}” belongs to ${rtInfo.primary}, its pack record says ${p.tag}`,
        'its pack record and its Reference Type disagree',
      );
    const recSpec =
      page.packRecord.specialist === null ? null : specialistOf(v, p.tag, page.packRecord.specialist);
    const tagSpecs = 'primary' in fromTags ? fromTags.specialists : [];
    const src = `its pack record (${page.packRecord.detail})`;
    if (tagSpecs.length > 0 && !(tagSpecs.length === 1 && recSpec !== null && sameTag(tagSpecs[0], recSpec)))
      return {
        primary: p.tag,
        specialist: null,
        source: src,
        specialistSource: `its pack record says ${recSpec ?? 'none'}, its tags carry ${tagSpecs.join(', ')}`,
        from: 'pack',
        specialistHold: {
          kind: 'specialist',
          slot: 'specialist',
          reason: `its pack record says ${recSpec ?? 'no specialist'}, its tags carry ${tagSpecs.join(', ')}: the specialist is omitted (owner classification needed)`,
        },
      };
    return {
      primary: p.tag,
      specialist: recSpec,
      source: src,
      specialistSource: recSpec ? src : 'none',
      from: 'pack',
    };
  }
  // 3. Its current tags, when they hold exactly one valid primary and the Reference Type does not contradict it.
  if ('problem' in fromTags)
    return uncertain(fromTags.problem, `its tags: ${page.tags.join(', ') || '(none)'}`);
  const primary = fromTags.primary;
  if (rt.ambiguous)
    return uncertain('its Reference Type is given more than once', 'its tags and Reference Type');
  if (rtInfo && !sameTag(rtInfo.primary, primary))
    return uncertain(
      `its tags say ${primary}, its Reference Type “${rt.value}” belongs to ${rtInfo.primary}`,
      'its tags and Reference Type disagree',
    );
  const src = `its current tags (exactly one primary category${rt.value ? `; ${rt.value} does not contradict it` : ''})`;
  const specs = fromTags.specialists;
  if (specs.length > 1)
    return {
      primary,
      specialist: null,
      source: src,
      specialistSource: `several specialist tags (${specs.join(', ')})`,
      from: 'tags',
      specialistHold: {
        kind: 'specialist',
        slot: 'specialist',
        reason: `several specialist tags (${specs.join(', ')}): at most one; the specialist is omitted (owner classification needed)`,
      },
    };
  const spec = specs[0] ?? null;
  if (
    rtInfo &&
    rtInfo.specialist !== '*' &&
    spec !== null &&
    (rtInfo.specialist === null || !sameTag(rtInfo.specialist, spec))
  )
    return {
      primary,
      specialist: null,
      source: src,
      specialistSource: `its tags carry ${spec}, its Reference Type “${rt.value}” ${rtInfo.specialist ? `means ${rtInfo.specialist}` : 'carries none'}`,
      from: 'tags',
      specialistHold: {
        kind: 'specialist',
        slot: 'specialist',
        reason: `its tags carry ${spec}, but its Reference Type “${rt.value}” ${rtInfo.specialist ? `means ${rtInfo.specialist}` : 'carries no specialist'}: omitted (owner classification needed)`,
      },
    };
  if (rtInfo && spec === null && rtInfo.specialist !== null)
    return {
      primary,
      specialist: null,
      source: src,
      specialistSource: `its Reference Type “${rt.value}” needs a specialist the tags do not carry`,
      from: 'tags',
      specialistHold: {
        kind: 'specialist',
        slot: 'specialist',
        reason: `its Reference Type “${rt.value}” needs ${rtInfo.specialist === '*' ? 'a specialist' : `the specialist ${rtInfo.specialist}`}, and the tags carry none: never inferred (owner classification needed)`,
      },
    };
  return { primary, specialist: spec, source: src, specialistSource: spec ? src : 'none', from: 'tags' };
}

// ============================================================================================ the policy

/** The policy a verdict was computed under: the approved pack version, its governance versions and a digest of both. */
export interface RetagPolicy {
  readonly packId: string;
  readonly version: number;
  /** The Tagging Standard's own label (`v1.8`), for people. */
  readonly label: string | null;
  readonly sources: readonly { readonly key: string; readonly version: string }[];
  readonly digest: string;
}

export function policyOf(
  pack: { readonly id: string; readonly governance: readonly { key: string; label?: string | undefined }[] },
  rules: PackRules,
  approved: {
    readonly version: number;
    readonly sources: readonly {
      readonly key: string;
      readonly version: string;
      readonly sections?: readonly unknown[];
    }[];
  },
  /** CR-2026-11-R3 (R3-08): the project's lifecycle settings a verdict depends on, folded into the digest. */
  settings?: Readonly<Record<string, unknown>>,
): RetagPolicy {
  const sources = approved.sources.map((s) => ({ key: s.key, version: s.version }));
  const digest = createHash('sha256')
    .update(
      stableJson({
        version: approved.version,
        rules,
        sources: approved.sources,
        ...(settings !== undefined ? { settings } : {}),
      }),
    )
    .digest('hex');
  const label = pack.governance.find((g) => g.key === 'tagging-standard')?.label ?? null;
  return { packId: pack.id, version: approved.version, label, sources, digest };
}

/** The retag rules of a pack, or null when it has none (an older version). */
export const retagRulesOf = (rules: PackRules): RetagRules | null => rules.retag ?? null;
