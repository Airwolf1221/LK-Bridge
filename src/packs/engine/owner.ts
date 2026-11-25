/**
 * The owner planner (v3 F3b, ADR 0052; the owner-approved design docs/design/F3b-owner-tools.md, section 1): ONE
 * non-character owner package to a plan the shared job builder (src/packs/engine/job.ts) runs, with no write. It refuses
 * rather than guesses, and says everything it decided:
 *
 * - the type (the pack's owner table: template, primary tag, allowed specialist, allowed homes), and for Species its
 *   `kind` on the race roster (race, racial group, subrace: their own homes, names, Reference Types and tags);
 * - the home: required, by name, id or path, checked against the type's allowed homes as the tree names them
 *   (HOME_NOT_ALLOWED with up to five suitable indexes nearby; `homeOverride` lets one through with its reason, printed
 *   in the proposal); never an invented home, never a category index made;
 * - a nation: `nation` names it; a nation that is only a compact Reference in a Polities index needs its own index
 *   (NATION_NEEDS_INDEX), which `promoteNation` makes in the same proposal (the index, the Reference moved into it with
 *   its ids, the owner beside it); `createSubindex` makes one national subindex, by name, as its own step;
 * - a new race or racial group's character navigation (`Characters / <Group> / <Race>`): warned about, and made only
 *   with `createCharacterNavigation`;
 * - the page: `<Subject> - <descriptor>` with its lifecycle prefix, the shared sidebar in template order, the computed
 *   tags (CANON, AU or Working first; the primary; the specialist), Purpose-first text with the template's own
 *   placeholder headings left out, Dependencies on current Authoritative owners only.
 */
import { factKey } from '../../facts/index.js';
import { factValueKey } from '../../facts/rules.js';
import type { LinkTarget } from '../../facts/plan.js';
import { mintClientId } from '../../jobs/ids.js';
import { readSidebar, statusValue } from '../../mcp/tools/create-support.js';
import { fromMarkdown, MarkdownError, type FromMarkdownContext, type LkBlock } from '../../markdown/index.js';
import { pageConverterContext, withImageCheck } from '../../pages/index.js';
import { cleanPrefixes, key as nameKey, singularFor, templateBaseKey } from '../../registry/names.js';
import { templateIdByName, templateMissingMessage } from '../indextax/rules.js';
import type { TreeNode } from '../../tree/index.js';
import type {
  HomeRule,
  OwnerKind,
  OwnerKindName,
  OwnerType,
  PackRules,
  RoleRule,
  TypeRules,
} from '../types.js';
import {
  describeHome,
  findNation,
  homeTree,
  isPolities,
  matchesHome,
  nationOf,
  nodesByPath,
  suggestHomes,
  type HomeTree,
  type NationLookup,
} from './homes.js';
import {
  draftIndexText,
  identityOf,
  keysOf,
  planOnTemplate,
  repointRoutingLine,
  routingChange,
  withUnresolved,
  type AbsentUnder,
  type ExistingChange,
  type IdentityValue,
  type Issue,
  type PackPlan,
  type PlanEnv,
  type PlannedPage,
  type PresentCheck,
} from './plan.js';
import { computeTags, type HeldSlot } from './tags.js';
import {
  checkBody,
  isPlaceholder,
  nameProblem,
  oneLine,
  replaceDashes,
  replaceDashesInMarkdown,
  sectionsOf,
  textKey,
  type Replacement,
} from './text.js';

type Obj = Record<string, unknown>;

/** An owner package, as `arkona_create_owner` hands it to the planner. */
export interface OwnerInput {
  readonly type: string;
  readonly kind?: OwnerKindName | undefined;
  /** The Subject (the name's first part). */
  readonly name: string;
  /** The name's second part (`Historical Polity Reference`); default: the Reference Type. */
  readonly descriptor?: string | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
  /** `Main` (default: CANON) or the name of an alternate universe (AU). */
  readonly continuity?: string | undefined;
  readonly home: string;
  readonly homeOverride?: { readonly reason: string } | undefined;
  readonly nation?: string | undefined;
  readonly promoteNation?: boolean | undefined;
  readonly createSubindex?: string | undefined;
  readonly createCharacterNavigation?: boolean | undefined;
  readonly referenceType?: IdentityValue | undefined;
  readonly scope?: IdentityValue | undefined;
  readonly temporalScope?: IdentityValue | undefined;
  readonly supersedes?: string | undefined;
  readonly specialistTag?: string | undefined;
  readonly markdown?: string | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly related?: readonly string[] | undefined;
}

export type OwnerEnv = Omit<PlanEnv, 'type' | 'hook'>;

/** The owner type as the shared engine reads a type (in memory only; the pack stores the owner table). */
export function ownerTypeRules(rules: PackRules, otype: OwnerType): TypeRules {
  const o = rules.owners!;
  return {
    name: otype.name,
    tool: o.tool,
    hook: null,
    placement: { kind: 'fixed', index: '(the package’s home)' },
    roles: [indexRole(rules), ownerRole(rules, otype)],
    identity: [],
    unestablished: o.unestablished,
    placeholders: o.placeholders,
    fixedFacts: o.facts.fixed,
    generalKeys: o.facts.keys,
    specialistTags: otype.specialist,
    suggestedReferenceTypes: {},
    assets: {
      displayName: '{Subject} - {Label}',
      section: 'Reference Images',
      role: 'owner',
    },
    index: {
      role: 'index',
      purpose: o.index.purpose,
      routing: o.index.routing,
      collection: o.index.collection,
      boundaries: o.index.boundaries,
      boundariesText: o.index.boundariesText,
    },
    text: {
      firstHeading: o.text.firstHeading,
      unresolved: o.text.unresolved,
      overload: { roles: [], domains: {}, minChars: 1200 },
    },
    relationship: null,
  };
}

function ownerRole(rules: PackRules, otype: OwnerType): RoleRule {
  const o = rules.owners!;
  return {
    role: 'owner',
    template: otype.template,
    name: '{Name}',
    referenceType: null,
    tags: o.tags.authoritative,
    workingTags: o.tags.working,
    facts: 'general',
    body: 'required',
    warnMissing: o.text.warnMissing,
    max: 1,
  };
}

function indexRole(rules: PackRules): RoleRule {
  return {
    role: 'index',
    template: rules.owners!.index.template,
    name: '{Name}',
    referenceType: null,
    tags: [],
    facts: 'none',
    body: 'drafted',
    warnMissing: [],
    max: 3,
  };
}

const k = (s: string) => nameKey(cleanPrefixes(s).name.replace(/\s+/g, ' ').trim());
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
/** CR-2026-11-R2 (R2-36): an invisible character (zero-width, soft hyphen, word joiner, BOM and the like). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

/** The fact a required key is given by, in the package. */
const FIELD_OF: Readonly<Record<string, 'referenceType' | 'scope' | 'temporalScope'>> = {
  'reference type': 'referenceType',
  scope: 'scope',
  'temporal scope': 'temporalScope',
};

export async function planOwner(env: OwnerEnv, input: OwnerInput): Promise<PackPlan> {
  const { pd, ctx, pack } = env;
  const rules = pack.rules;
  const owners = rules.owners!;
  const otype = owners.types.find((x) => textKey(x.name) === textKey(input.type))!;
  const type = ownerTypeRules(rules, otype);
  const t = homeTree(ctx, owners);
  const refusals: Issue[] = [];
  const warnings: Issue[] = [];
  const replacements: Replacement[] = [];
  const held: HeldSlot[] = [];
  const notes: string[] = [];
  const refuse = (code: string, message: string, more: Obj = {}) => refusals.push({ code, message, ...more });
  const warn = (code: string, message: string, more: Obj = {}) => warnings.push({ code, message, ...more });
  const tagsCurrent = env.governance.state === 'current';
  const props = rules.sidebar.property;

  // ---------------------------------------------------------------------------------- the kind (Species only)
  const kindName = input.kind ?? null;
  let kind: OwnerKind | null = null;
  if (kindName) {
    kind = otype.kinds?.[kindName] ?? null;
    if (!kind)
      refuse(
        'KIND_NOT_FOR_TYPE',
        `kind "${kindName}" places a page on the race roster and is for ${owners.types
          .filter((x) => x.kinds)
          .map((x) => x.name)
          .join(', ')} only (race, racialGroup, subrace); a ${otype.name} takes no kind.`,
      );
  }
  const homeRules: readonly HomeRule[] = kind ? kind.homes : otype.homes;

  // ---------------------------------------------------------------------------------- the text rules
  let name = replaceDashes(tidy(cleanPrefixes(input.name).name), 'name', 'name', replacements);
  let descriptor =
    input.descriptor !== undefined
      ? replaceDashes(tidy(input.descriptor), 'name', 'descriptor', replacements)
      : null;
  if (!kind && descriptor === null && name.includes(' - ')) {
    const at = name.indexOf(' - ');
    descriptor = name.slice(at + 3).trim();
    name = name.slice(0, at).trim();
    notes.push(`The name was read as Subject “${name}” and descriptor “${descriptor}”.`);
  }
  if (name === '' || name.length > 200)
    refuse('INVALID_NAME', 'The name (the Subject, 1 to 200 characters) is required.');
  const fact = (v: IdentityValue | undefined, field: string) => {
    const x = identityOf(v);
    return {
      // CR-2026-11-R2 (R2-37): Reference Type, Scope and Temporal Scope are one-line rows (line breaks collapsed).
      value: x.value === null ? null : replaceDashes(oneLine(x.value), 'facts', field, replacements),
      reason: x.reason,
    };
  };
  const facts = {
    referenceType: fact(input.referenceType, 'Reference Type'),
    scope: fact(input.scope, 'Scope'),
    temporalScope: fact(input.temporalScope, 'Temporal Scope'),
  };
  const supersedes =
    input.supersedes !== undefined && input.supersedes.trim() !== ''
      ? replaceDashes(tidy(input.supersedes), 'facts', 'Supersedes', replacements)
      : owners.facts.supersedes;
  const continuityIn =
    input.continuity !== undefined && input.continuity.trim() !== ''
      ? replaceDashes(tidy(input.continuity), 'facts', 'Continuity', replacements)
      : null;
  const markdown = replaceDashesInMarkdown(input.markdown ?? '', 'markdown', replacements);

  // ---------------------------------------------------------------------------------- the facts (design 1.4)
  const unestablishedKey = textKey(owners.unestablished);
  const unestablished: { key: string; reason: string }[] = [];
  if (kind?.referenceType) {
    const given = facts.referenceType.value;
    if (given && textKey(given) !== textKey(kind.referenceType))
      refuse(
        'REFERENCE_TYPE_FIXED',
        `A ${kindName} page's Reference Type is “${kind.referenceType}” (not “${given}”); leave referenceType out or give that.`,
      );
    facts.referenceType = { value: kind.referenceType, reason: null };
  }
  const missing: string[] = [];
  for (const key of owners.facts.required) {
    const field = FIELD_OF[textKey(key)];
    if (!field) {
      if (factKey(key) !== factKey('Subject'))
        refuse('FACT_UNSUPPORTED', `The pack requires “${key}”, which this tool cannot take; ask the owner.`);
      continue;
    }
    const v = facts[field];
    if (v.value === null || v.value === '' || isPlaceholder(v.value, owners.placeholders)) {
      missing.push(key);
      continue;
    }
    if (textKey(v.value) === unestablishedKey) {
      if (!v.reason)
        refuse(
          'UNESTABLISHED_NEEDS_REASON',
          `${key} is “${owners.unestablished}” with no reason. It is a deliberate, stated outcome: give { "value": "${owners.unestablished}", "reason": "…" } (the reason goes into ${owners.text.unresolved}), or ask the owner for the value.`,
          { key },
        );
      else unestablished.push({ key, reason: v.reason });
    }
  }
  if (missing.length > 0)
    refuse(
      'OWNER_FACTS_INCOMPLETE',
      `Missing or blank: ${missing.join(', ')}. Every owner page states its Subject, Reference Type, Scope and Temporal Scope. Do not invent them: ask the owner, then call again (or "${owners.unestablished}" with a reason, when the owner leaves one open on purpose).`,
      { fields: missing, hint: 'Ask the owner for these values; never invent them.' },
    );

  // ---------------------------------------------------------------------------------- the page name (design 1.4)
  if (kind) {
    if (descriptor !== null)
      refuse(
        'DESCRIPTOR_FIXED',
        `A ${kindName} page is named “${kind.name.replace('{Name}', '<name>')}”; leave descriptor out.`,
      );
  } else if (descriptor === null || descriptor === '') {
    const rt = facts.referenceType.value;
    if (rt && textKey(rt) !== unestablishedKey && !isPlaceholder(rt, owners.placeholders)) descriptor = rt;
    else
      refuse(
        'DESCRIPTOR_REQUIRED',
        'The page is named “<Subject> - <descriptor>”: give descriptor (the Reference Type is used when it is set).',
      );
  }
  const display = kind ? kind.name.replace(/\{Name\}/g, name) : `${name} - ${descriptor ?? ''}`;
  const np = nameProblem(display, rules);
  if (np) refuse(np.code, np.message, { page: display });

  // ---------------------------------------------------------------------------------- continuity and status
  const fixed = owners.facts.fixed;
  const mainName = fixed['Continuity'] ?? 'Main';
  // CR-2026-11-R2 (R2-36): compared through the facts' own fold (NFKC, invisible characters removed, case, look-alikes),
  // so "Main" spelt with a zero-width space is Main (and written as Main); an alternate universe's name with an
  // invisible character in it is refused rather than written into the facts.
  const au = continuityIn !== null && factValueKey(continuityIn) !== factValueKey(mainName);
  if (au && continuityIn !== null && INVISIBLE.test(continuityIn))
    refuse(
      'CONTINUITY_INVISIBLE_CHARACTER',
      `continuity “${continuityIn}” holds an invisible character (a zero-width space, a soft hyphen or the like). Type the alternate universe's name without it.`,
      { continuity: continuityIn },
    );
  const continuityType = au ? (rules.tags.au?.continuityType ?? 'AU') : (fixed['Continuity Type'] ?? null);
  const continuity = au ? continuityIn : mainName;
  const status: 'working' | 'authoritative' = input.status ?? 'working';
  const working = status === 'working';
  const wi = env.lifecycle.workingIndexId ? t.node(env.lifecycle.workingIndexId) : null;
  if (working && (!wi || wi.kind !== 'index'))
    refuse(
      'LIFECYCLE_NOT_CONFIGURED',
      'Working pages go under [INDEX] Working, which the owner has not confirmed (Projects page, Lifecycle). Ask the owner, or use status "authoritative".',
    );

  // ---------------------------------------------------------------------------------- the nation (design 1.3)
  const nationName =
    input.nation !== undefined && input.nation.trim() !== ''
      ? replaceDashes(tidy(cleanPrefixes(input.nation).name), 'nation', 'nation', replacements)
      : null;
  let nation: NationLookup = null;
  if (input.promoteNation === true && nationName === null)
    refuse(
      'NATION_REQUIRED',
      'promoteNation needs `nation`: the nation whose compact Reference gets its own index.',
    );
  if (nationName !== null) {
    nation = findNation(t, nationName);
    if (nation === null)
      refuse(
        'NATION_NOT_FOUND',
        `No nation “${nationName}”: neither a nation index nor a compact Reference (“${nationName} - …”) in a <Continent> ${owners.nations} index.`,
      );
    else if (nation.kind === 'ambiguous')
      refuse(
        'NATION_AMBIGUOUS',
        `“${nationName}” names ${nation.nodes.length} nations; give the id of the one meant.`,
        {
          candidates: nation.nodes.map((n) => ({
            id: n.id,
            name: n.rawName,
            path: n.path.names.join(' / '),
          })),
        },
      );
    else if (nation.kind === 'reference' && input.promoteNation !== true)
      refuse(
        'NATION_NEEDS_INDEX',
        `${nationName} is a compact polity: all it has is its Reference, ${nation.node.rawName}, directly in ${nation.polities.rawName}. A nation with several developed owners gets its own index (Source Formatting: Nation-Centred Territorial Navigation). Call again with promoteNation: true to do it in this proposal: [INDEX] ${nationName} made in ${nation.polities.rawName}, the Reference moved into it (its id, Dependencies and tags kept), and this owner placed beside it.`,
        {
          nation: {
            reference: { id: nation.node.id, name: nation.node.rawName },
            in: nation.polities.rawName,
          },
          hint: 'Call again with promoteNation: true.',
        },
      );
    else if (nation.kind === 'index' && input.promoteNation === true)
      refuse(
        'NATION_ALREADY_INDEXED',
        `${nationName} already has its index (${nation.node.rawName}): leave promoteNation out and give that index (or one of its subindexes) as home.`,
        { nation: { id: nation.node.id, name: nation.node.rawName } },
      );
  }
  const promote = input.promoteNation === true && nation?.kind === 'reference' ? nation : null;
  const nationIndexNode = nation?.kind === 'index' ? nation.node : null;

  // ---------------------------------------------------------------------------------- the home (design 1.2)
  const subName =
    input.createSubindex !== undefined && input.createSubindex.trim() !== ''
      ? replaceDashes(tidy(cleanPrefixes(input.createSubindex).name), 'createSubindex', 'name', replacements)
      : null;
  const homeText = input.home.trim();
  const homeQuery = tidy(cleanPrefixes(homeText).name);
  let home: { kind: 'node'; node: TreeNode } | { kind: 'planned'; key: 'nation' | 'subindex' } | null = null;
  if (promote && k(homeQuery) === k(nationName!)) home = { kind: 'planned', key: 'nation' };
  else if (subName && k(homeQuery) === k(subName)) home = { kind: 'planned', key: 'subindex' };
  else {
    const byPath = nodesByPath(ctx, homeText);
    if (byPath !== null) {
      if (byPath.length === 1) home = { kind: 'node', node: byPath[0]! };
      else if (byPath.length > 1)
        refuse('HOME_AMBIGUOUS', `The home “${homeText}” names ${byPath.length} places; give an id.`, {
          candidates: byPath.map((n) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') })),
        });
      else
        refuse('HOME_NOT_FOUND', `No index at “${homeText}” in the repository.`, {
          suggestions: suggestHomes(t, homeRules, null),
        });
    } else {
      const r = ctx.types.resolve(homeQuery, {});
      if (r.status === 'resolved') {
        const n = t.node(r.node.id);
        if (n) home = { kind: 'node', node: n };
      } else if (r.status === 'ambiguous')
        refuse(
          'HOME_AMBIGUOUS',
          `The home “${homeText}” names ${r.candidates.length} places; give its id or path.`,
          {
            candidates: r.candidates.map((c) => ({ id: c.id, name: c.rawName, path: c.path })),
          },
        );
      else
        refuse('HOME_NOT_FOUND', `No index named “${homeText}” in the repository.`, {
          suggestions: suggestHomes(t, homeRules, null),
        });
    }
  }
  // promoteNation: the Polities index that holds the Reference stands for the new nation index.
  if (promote && home?.kind === 'node' && home.node.id === promote.polities.id) {
    notes.push(
      `The owner goes into the new [INDEX] ${nationName} (promoteNation), not ${promote.polities.rawName}.`,
    );
    home = { kind: 'planned', key: subName ? 'subindex' : 'nation' };
  }
  const override = input.homeOverride?.reason?.trim() || null;
  if (input.homeOverride !== undefined && !override)
    refuse(
      'OVERRIDE_NEEDS_REASON',
      'homeOverride needs a reason (it is printed in the proposal for the owner).',
    );
  let homeFits: string | null = null;
  let overridden = false;
  const allowed = homeRules.map((r) => describeHome(t, r));
  const notAllowed = (n: TreeNode, why: string) => {
    const hint =
      homeRules.some((r) => r.kind === 'nation') && isPolities(t, n)
        ? ` To give a compact polity its own index, name it as nation with promoteNation: true.`
        : '';
    refuse(
      'HOME_NOT_ALLOWED',
      `${n.rawName} is not a home for a ${otype.name}${kindName ? ` (${kindName})` : ''}: ${why} Allowed: ${allowed.join('; ')}. Pass homeOverride { "reason": "…" } only when the owner has decided otherwise.${hint}`,
      {
        home: { id: n.id, name: n.rawName, path: n.path.names.join(' / ') },
        allowed,
        suggestions: suggestHomes(t, homeRules, n),
      },
    );
  };
  if (home?.kind === 'node') {
    const n = home.node;
    const area =
      env.lifecycle.workingIndexId &&
      (n.id === env.lifecycle.workingIndexId || n.path.ids.includes(env.lifecycle.workingIndexId))
        ? 'Working'
        : env.lifecycle.archiveIndexId &&
            (n.id === env.lifecycle.archiveIndexId || n.path.ids.includes(env.lifecycle.archiveIndexId))
          ? 'Archived'
          : null;
    if (area)
      refuse(
        'HOME_IN_LIFECYCLE_AREA',
        `${n.rawName} is in the ${area} area: an owner's home is its place in canon (a Working page is drafted under [INDEX] Working by status "working").`,
      );
    else if (subName) {
      // createSubindex: the owner goes in the new subindex, beneath this nation index.
      const nat = nationIndexNode ?? (n.kind === 'index' ? nationOf(t, n) : null);
      if (!nat || nat.id !== n.id)
        refuse(
          'HOME_NOT_ALLOWED',
          `With createSubindex, home is the new subindex's name (“${subName}”) or its nation's index; ${n.rawName} is neither.`,
          { allowed: [subName, ...(nat ? [nat.rawName] : [])] },
        );
      else home = { kind: 'planned', key: 'subindex' };
    } else {
      const rule = homeRules.find((r) => matchesHome(t, n, r));
      if (rule) homeFits = describeHome(t, rule);
      else if (override) {
        overridden = true;
        warn(
          'HOME_OVERRIDDEN',
          `${n.rawName} is not one of a ${otype.name}'s allowed homes (${allowed.join('; ')}); placed there by homeOverride: “${override}”.`,
          { reason: override },
        );
      } else
        notAllowed(
          n,
          n.kind === 'index'
            ? 'the index is not one of its allowed homes.'
            : 'a substantive page is never a home (Races of Arkona and its racial group and race pages hold only the race roster).',
        );
      if (nationIndexNode && rule && !n.path.ids.includes(nationIndexNode.id) && n.id !== nationIndexNode.id)
        warn(
          'HOME_OUTSIDE_NATION',
          `The home ${n.rawName} is not inside ${nationIndexNode.rawName} (nation “${nationName}”).`,
        );
    }
  }
  // A planned home must itself be an allowed one.
  if (
    home?.kind === 'planned' &&
    home.key === 'nation' &&
    !homeRules.some((r) => r.kind === 'nation') &&
    !override
  )
    refuse(
      'HOME_NOT_ALLOWED',
      `A ${otype.name} does not live directly in a nation index (allowed: ${allowed.join('; ')}); with promoteNation, name its national subindex in createSubindex.`,
      { allowed },
    );

  // ---------------------------------------------------------------------------------- the national subindex
  let subParent: { existing: TreeNode } | { planned: true } | null = null;
  if (subName) {
    const natNode = promote
      ? null
      : (nationIndexNode ?? (home?.kind === 'node' ? nationOf(t, home.node) : null));
    const natName = promote ? nationName! : (natNode?.displayName ?? null);
    if (!natName)
      refuse(
        'SUBINDEX_NEEDS_NATION',
        `createSubindex makes a national subindex: name its nation (\`nation\`), or give the nation's index as home.`,
      );
    else {
      const cats = homeRules
        .filter(
          (r): r is Extract<HomeRule, { kind: 'category' }> => r.kind === 'category' && r.level === 'nation',
        )
        .map((r) => r.category);
      const fits =
        k(subName).startsWith(`${k(natName)} `) && cats.some((c) => k(`${natName} ${c}`) === k(subName));
      if (!fits && !override)
        refuse(
          'SUBINDEX_NOT_ALLOWED',
          `createSubindex “${subName}” is not a national subindex a ${otype.name} lives in: ${cats.length ? cats.map((c) => `“${natName} ${c}”`).join(' or ') : 'it has none'}.`,
          { allowed: cats.map((c) => `${natName} ${c}`) },
        );
      if (natNode) {
        const there = t.children(natNode.id).find((c) => k(c.displayName) === k(subName));
        if (there)
          refuse(
            'SUBINDEX_EXISTS',
            `${there.rawName} exists in ${natNode.rawName}: give it as home instead of createSubindex.`,
            {
              existing: { id: there.id, name: there.rawName },
            },
          );
        subParent = { existing: natNode };
      } else if (promote) subParent = { planned: true };
      if (home === null || home.kind !== 'planned' || home.key !== 'subindex')
        refuse(
          'HOME_NOT_ALLOWED',
          `With createSubindex the owner goes into the new [INDEX] ${subName}: give that name (or its nation's index) as home.`,
        );
    }
  }

  // ---------------------------------------------------------------------------------- character navigation (1.1a)
  let navPlan: { parent: TreeNode; name: string; path: string } | null = null;
  if (kind?.navigation) {
    const roots = t
      .indexes()
      .filter((n) => k(n.displayName) === k(owners.races.navigation))
      .sort((a, b) => a.depth - b.depth);
    const navRoot = roots[0] ?? null;
    const groupSuffix = (t.kinds.racialGroup?.name ?? '{Name} - Racial Group Reference').replace(
      '{Name}',
      '',
    );
    const group =
      kind.navigation === 'group'
        ? null
        : home?.kind === 'node' &&
            home.node.kind === 'bsrc' &&
            k(home.node.displayName).endsWith(k(groupSuffix))
          ? home.node.displayName.slice(0, home.node.displayName.length - groupSuffix.length).trim()
          : null;
    const chain = [...(group ? [group] : []), name];
    const path = [owners.races.navigation, ...chain].join(' / ');
    let parent: TreeNode | null = navRoot;
    for (const step of chain.slice(0, -1))
      parent = parent
        ? (t.children(parent.id).find((c) => c.kind === 'index' && k(c.displayName) === k(step)) ?? null)
        : null;
    const exists = parent
      ? t.children(parent.id).find((c) => c.kind === 'index' && k(c.displayName) === k(name))
      : undefined;
    if (exists) {
      if (input.createCharacterNavigation === true)
        notes.push(`${path} exists already (${exists.rawName}): no navigation is made.`);
    } else if (input.createCharacterNavigation === true) {
      if (!parent)
        refuse(
          'NAVIGATION_PARENT_MISSING',
          `${path} cannot be made: ${[owners.races.navigation, ...chain.slice(0, -1)].join(' / ')} does not exist. Make the racial group's navigation first (its own package with createCharacterNavigation).`,
        );
      else {
        navPlan = { parent, name, path };
        const s = singularFor(name);
        if (s.source === 'rule')
          warn(
            'TAXONOMY_SINGULAR_GUESS',
            `${name} is added to the Character taxonomy with the singular “${s.singular}”, a guess: the owner checks it on the Repository Mappings page before a character of ${name} can be placed.`,
            { plural: name, singular: s.singular },
          );
      }
    } else
      warn(
        'CHARACTER_NAVIGATION_MISSING',
        `${path} does not exist, so arkona_create_character cannot place a character of ${name} yet. Call again with createCharacterNavigation: true to add [INDEX] ${name}${parent ? ` under ${parent.rawName}` : ''} in this proposal (its own step), or ask the owner.`,
        { path },
      );
  } else if (input.createCharacterNavigation === true)
    refuse(
      'NAVIGATION_NOT_FOR_KIND',
      'createCharacterNavigation is for a new race or racial group (type Species, kind "race" or "racialGroup").',
    );

  // ---------------------------------------------------------------------------------- templates
  const templateId = (role: string): string | null => {
    const id = env.templates[role] ?? null;
    if (!id) {
      refuse(
        'PACK_TEMPLATE_UNSET',
        `The ${pack.name} pack has no ${role} template for this project. The owner refreshes the project's templates (Repository Mappings) and approves the pack again on the Packs page.`,
        { template: role },
      );
      return null;
    }
    const snap = ctx.types.store.templates();
    if (snap.readAt === null) {
      refuse(
        'TEMPLATES_NOT_READ',
        'The bridge has not read this project’s templates, so the pack’s template ids cannot be checked. The owner refreshes them on the Repository Mappings page.',
      );
      return null;
    }
    if (!snap.templates.some((x) => x.id === id)) {
      refuse(
        'PACK_TEMPLATE_UNKNOWN',
        `The ${pack.name} pack's ${role} template (${id}) is not one of this project's templates as last read. The owner checks the pack on the Packs page.`,
        { template: role, templateId: id },
      );
      return null;
    }
    return id;
  };
  const templateName = (id: string) =>
    ctx.types.store.templates().templates.find((x) => x.id === id)?.name ?? id;
  const tid = templateId(otype.template);
  const needsIndex = promote !== null || subName !== null || navPlan !== null;
  const indexTid = needsIndex ? templateId(owners.index.template) : null;
  // v3 F6b (ADR 0079, T11): where the pack carries the index rules, a nation subindex and a race's or racial group's
  // navigation are [NAV] (from "[NAV] AI Navigation", by name); a nation's own index stays [INDEX].
  const tax = rules.indexTaxonomy ?? null;
  const navPrefix = tax ? '[NAV] ' : '[INDEX] ';
  let navTid: string | null = null;
  if (tax && (subName !== null || navPlan !== null)) {
    navTid = templateIdByName(ctx.types.store.templates().templates, tax.templates.nav, (x) =>
      templateBaseKey(cleanPrefixes(x).name),
    );
    if (!navTid) refuse('TEMPLATE_MISSING', templateMissingMessage(tax), { template: tax.templates.nav });
  }

  // ---------------------------------------------------------------------------------- the pages, their places
  const prefix = working ? '[BWRK] ' : '[BSRC] ';
  const rawPage = `${prefix}${display}`;
  const ownerId = mintClientId();
  const nationRaw = promote ? `[INDEX] ${nationName}` : null;
  const subRaw = subName ? `${navPrefix}${subName}` : null;
  const ids = { nation: mintClientId(), subindex: mintClientId(), navigation: mintClientId() };
  const destinationName =
    home?.kind === 'planned' ? (home.key === 'nation' ? nationRaw : subRaw) : (home?.node.rawName ?? '?');
  let ownerParent: { existing: string } | { item: string } | null = null;
  let ownerParentName = '?';
  if (working && wi) {
    ownerParent = { existing: wi.id };
    ownerParentName = wi.rawName;
    notes.push(
      `status "working": drafted as ${rawPage} directly under [INDEX] Working; promote it with promote_page (destination: ${destinationName}) when it is ready.`,
    );
  } else if (home?.kind === 'planned') {
    ownerParent = { item: home.key };
    ownerParentName = (home.key === 'nation' ? nationRaw : subRaw) ?? '?';
  } else if (home?.kind === 'node') {
    ownerParent = { existing: home.node.id };
    ownerParentName = home.node.rawName;
  }
  // A sibling of the same name (design 1.4): refused, in its place now and (Working) in the place it is promoted to.
  const sameNamed = (parentId: string) =>
    t.children(parentId).find((c) => c.kind !== 'index' && k(c.displayName) === k(display));
  for (const p of [
    ...(ownerParent && 'existing' in ownerParent ? [ownerParent.existing] : []),
    ...(working && home?.kind === 'node' ? [home.node.id] : []),
  ]) {
    const hit = sameNamed(p);
    if (hit)
      refuse(
        'OWNER_EXISTS',
        `${hit.rawName} exists in ${t.node(p)?.rawName ?? p}: a page of that name is there already.`,
        {
          existing: { id: hit.id, name: hit.rawName },
        },
      );
  }
  if (promote) {
    if (k(promote.node.displayName) === k(display))
      refuse('DUPLICATE_PAGE', `The new owner and ${promote.node.rawName} would both be named “${display}”.`);
    const clash = t.children(promote.polities.id).find((c) => k(c.displayName) === k(nationName!));
    if (clash)
      refuse('NATION_INDEX_EXISTS', `${clash.rawName} exists in ${promote.polities.rawName} already.`, {
        existing: { id: clash.id, name: clash.rawName },
      });
  }

  // ---------------------------------------------------------------------------------- the sidebar (template order)
  const sidebarRead = tid
    ? await readSidebar(pd, env.mctx, env.tool, tid, env.cc.sidebars, env.cc.templateTags)
    : null;
  if (sidebarRead && !sidebarRead.ok)
    refuse('TEMPLATE_UNREADABLE', `${display}: its template could not be read now.`);
  const tSidebar = sidebarRead?.ok ? sidebarRead.value : [];
  const tKeys = keysOf(tSidebar, props);
  const want: { key: string; value: string }[] = [];
  const put = (key: string, v: string | null | undefined) => {
    if (v === null || v === undefined || v === '') return;
    if (!want.some((x) => factKey(x.key) === factKey(key))) want.push({ key, value: v });
  };
  put(env.lifecycle.fields.status, statusValue(env.lifecycle, status));
  put(env.lifecycle.fields.continuityType, continuityType);
  put('Continuity', continuity);
  put('Inheritance', fixed['Inheritance'] ?? null);
  put('Subject', name);
  put('Reference Type', facts.referenceType.value);
  put('Scope', facts.scope.value);
  put('Temporal Scope', facts.temporalScope.value);
  put('Supersedes', supersedes);
  const allowedKeys = new Set(owners.facts.keys.map(factKey));
  const order = (key: string) => tKeys?.findIndex((x) => factKey(x) === factKey(key)) ?? -1;
  const factValues = want
    .filter((f) => allowedKeys.has(factKey(f.key)) && order(f.key) >= 0)
    .sort((a, b) => order(a.key) - order(b.key));
  if (tKeys)
    for (const key of ['Subject', ...owners.facts.required])
      if (!tKeys.some((x) => factKey(x) === factKey(key)))
        warn(
          'TEMPLATE_ROW_MISSING',
          `${display}: the template has no “${key}” row, so it cannot be written there.`,
          {
            page: display,
          },
        );

  // ---------------------------------------------------------------------------------- the tags (design 1.4, 1.5)
  let specialist: string | null = null;
  if (kind) {
    specialist = kind.specialist;
    if (
      input.specialistTag &&
      (!kind.specialist || textKey(input.specialistTag) !== textKey(kind.specialist))
    )
      refuse(
        'TAG_NOT_ALLOWED',
        `${display}: a ${kindName} page's tags are computed (${kind.specialist ? `its specialist tag is always ${kind.specialist}` : 'it takes no specialist tag'}).`,
      );
  } else if (input.specialistTag) {
    const hit = otype.specialist.find((x) => textKey(x) === textKey(input.specialistTag!));
    if (!hit)
      refuse(
        'TAG_NOT_ALLOWED',
        `${display}: “${input.specialistTag}” is not a ${otype.name} specialist tag (${otype.specialist.join(', ') || 'it has none'}); tags are never typed freely.`,
      );
    else specialist = hit;
  }
  const role = ownerRole(rules, otype);
  const tagResult = tagsCurrent
    ? computeTags({
        rules,
        role,
        page: rawPage,
        status,
        specialist,
        primary: otype.primary,
        continuityType,
        unestablished: owners.unestablished,
      })
    : { tags: [], held: [] };
  held.push(...tagResult.held);

  // ---------------------------------------------------------------------------------- links (design 1.4)
  const own = new Map<string, { id: string; name: string }>();
  own.set(k(display), { id: ownerId, name: rawPage });
  if (nationRaw) own.set(k(nationRaw), { id: ids.nation, name: nationRaw });
  if (subRaw) own.set(k(subRaw), { id: ids.subindex, name: subRaw });
  const linkTitle = { dependencies: rules.sidebar.dependencies, related: rules.sidebar.related };
  const resolveLink = (ref: string, which: 'dependency' | 'related'): LinkTarget | null => {
    const mine = own.get(k(ref));
    if (mine) {
      refuse(
        which === 'dependency' ? 'DEPENDENCY_NOT_AUTHORITATIVE' : 'LINK_TARGET_NOT_CURRENT',
        `${display}: “${mine.name}” is made by this package; ${which === 'dependency' ? 'Dependencies name current Authoritative owners only' : 'link existing pages only'}.`,
      );
      return null;
    }
    const r = ctx.types.resolve(cleanPrefixes(ref).name.trim() || ref, {});
    if (r.status !== 'resolved') {
      refuse(
        r.status === 'ambiguous' ? 'LINK_TARGET_AMBIGUOUS' : 'LINK_TARGET_NOT_FOUND',
        r.status === 'ambiguous'
          ? `${display}: the link “${ref}” names ${r.candidates.length} pages; give the id of the one meant.`
          : `${display}: the link “${ref}” names no page of the repository.`,
        r.status === 'ambiguous'
          ? { candidates: r.candidates.map((c) => ({ id: c.id, name: c.rawName, path: c.path })) }
          : {},
      );
      return null;
    }
    const kindOf = r.node.kind;
    if (which === 'dependency' && kindOf !== 'bsrc') {
      refuse(
        'DEPENDENCY_NOT_AUTHORITATIVE',
        `${display}: “${r.node.rawName}” is ${kindOf === 'bwrk' ? 'a Working page' : kindOf === 'barc' ? 'an Archived page' : kindOf === 'index' ? 'an index' : 'not an owner page'}. Dependencies name current Authoritative owners only (Source Formatting).`,
        { target: { id: r.node.id, name: r.node.rawName, kind: kindOf } },
      );
      return null;
    }
    const ok = status === 'authoritative' ? kindOf === 'bsrc' : kindOf === 'bsrc' || kindOf === 'bwrk';
    if (!ok) {
      refuse(
        'LINK_TARGET_NOT_CURRENT',
        status === 'authoritative'
          ? `${display}: “${r.node.rawName}” is ${kindOf === 'bwrk' ? 'a Working' : kindOf === 'barc' ? 'an Archived' : 'not a [BSRC]'} page; a CANON page links only current [BSRC] pages.`
          : `${display}: “${r.node.rawName}” is ${kindOf === 'barc' ? 'an Archived page' : 'not a page'}; links go to current pages.`,
        { target: { id: r.node.id, name: r.node.rawName, kind: kindOf } },
      );
      return null;
    }
    return { resourceId: r.node.id, name: r.node.rawName };
  };
  const deps = (input.dependencies ?? [])
    .map((r) => resolveLink(r, 'dependency'))
    .filter((x): x is LinkTarget => x !== null);
  const rel = (input.related ?? [])
    .map((r) => resolveLink(r, 'related'))
    .filter((x): x is LinkTarget => x !== null);
  const linkTargets: { title: string; targets: LinkTarget[] }[] = [];
  if (deps.length) linkTargets.push({ title: linkTitle.dependencies, targets: deps });
  if (rel.length) linkTargets.push({ title: linkTitle.related, targets: rel });

  // ---------------------------------------------------------------------------------- the text (design 1.4)
  const plain = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
  // v3 F7 (ADR 0070, G11): an image in the page's text must be one of the project's assets (live once for a miss).
  const base = plain ? await withImageCheck(pd.services?.assets, ctx.projectId, plain, markdown) : undefined;
  const converter: FromMarkdownContext | undefined = base
    ? {
        ...base,
        resolveMention: (n: string) => {
          const hit = own.get(k(n));
          if (hit) return { status: 'resolved', resourceId: hit.id };
          return base.resolveMention ? base.resolveMention(n) : { status: 'not_found' };
        },
      }
    : undefined;
  if (!converter) refuse('TOOL_UNAVAILABLE', 'The repository tree cannot resolve names now.');
  let md = markdown;
  if (unestablished.length > 0) md = withUnresolved(md, owners.text.unresolved, unestablished);
  let blocks: LkBlock[] | null = null;
  const headings: string[] = [];
  if (md.trim() === '')
    refuse('BODY_REQUIRED', `${display}: the page needs its text (markdown); no empty or token pages.`, {
      page: display,
    });
  else if (converter) {
    try {
      blocks = fromMarkdown(md, { blocks: [] }, converter).blocks;
      const check = checkBody({
        page: display,
        role: 'owner',
        blocks,
        titles: [display, rawPage, name],
        type,
        warnMissing: owners.text.warnMissing,
      });
      refusals.push(...check.refusals.map((x) => ({ ...x })));
      warnings.push(...check.warnings.map((x) => ({ ...x })));
      for (const s of sectionsOf(blocks)) if (s.heading) headings.push(s.title);
    } catch (e) {
      if (e instanceof MarkdownError) refuse(e.code, `${display}: ${e.message}`, { page: display });
      else throw e;
    }
  }

  // ---------------------------------------------------------------------------------- the planned pages
  const indexRule = indexRole(rules);
  const pages: PlannedPage[] = [];
  const indexPage = (
    key: 'nation' | 'subindex' | 'navigation',
    raw: string,
    parent: { existing: string } | { item: string },
    parentName: string,
    note: string,
    tid: string | null = indexTid,
  ): PlannedPage => ({
    key,
    id: ids[key],
    rawName: raw,
    displayName: raw.replace(/^\[(?:INDEX|NAV)\]\s*/, ''),
    kind: 'index',
    parent,
    templateId: tid ?? 'missing',
    facts: null,
    parentName,
    templateName: tid ? templateName(tid) : '?',
    status: null,
    role: 'index',
    rule: indexRule,
    templateRole: indexRule.template,
    subject: raw.replace(/^\[(?:INDEX|NAV)\]\s*/, ''),
    referenceType: null,
    scope: null,
    factValues: [],
    gatedKeys: [],
    templateKeys: null,
    linkTargets: [],
    markdown: null,
    blocks: null,
    drafted: true,
    images: [],
    headings: [],
    notes: [note],
  });
  const nationPage =
    promote && nationRaw
      ? indexPage(
          'nation',
          nationRaw,
          { existing: promote.polities.id },
          promote.polities.rawName,
          `nation index (promoteNation): ${promote.node.rawName} moves into it`,
        )
      : null;
  const subPage =
    subRaw && subParent
      ? indexPage(
          'subindex',
          subRaw,
          'planned' in subParent ? { item: 'nation' } : { existing: subParent.existing.id },
          'planned' in subParent ? (nationRaw ?? '?') : subParent.existing.rawName,
          'national subindex (createSubindex): its own, named step',
          tax ? navTid : indexTid,
        )
      : null;
  const navPage = navPlan
    ? indexPage(
        'navigation',
        `${navPrefix}${navPlan.name}`,
        { existing: navPlan.parent.id },
        navPlan.parent.rawName,
        `character navigation (createCharacterNavigation): ${navPlan.path}, added to the Character taxonomy`,
        tax ? navTid : indexTid,
      )
    : null;
  const ownerPage: PlannedPage = {
    key: 'owner',
    id: ownerId,
    rawName: rawPage,
    displayName: display,
    kind: working ? 'bwrk' : 'bsrc',
    parent: ownerParent ?? { existing: 'missing' },
    templateId: tid ?? 'missing',
    facts: null,
    parentName: ownerParentName,
    templateName: tid ? templateName(tid) : '?',
    status,
    tags: tagResult.tags,
    role: 'owner',
    rule: role,
    templateRole: otype.template,
    subject: name,
    referenceType: facts.referenceType.value,
    scope: facts.scope.value,
    factValues,
    gatedKeys: [],
    templateKeys: tKeys,
    linkTargets,
    markdown: md || null,
    blocks,
    drafted: false,
    images: [],
    headings,
    notes: [
      `${otype.name}${kindName ? ` (${kindName})` : ''}: home ${destinationName}${homeFits ? ` (${homeFits})` : ''}${overridden ? `; home override: ${override}` : ''}`,
    ],
  };
  // The facts plan of the owner page on its template's sidebar.
  if (tid && tSidebar.length > 0) {
    const fp = planOnTemplate(ownerPage, tSidebar, props, refuse);
    if (fp)
      (ownerPage as { facts: PlannedPage['facts'] }).facts = {
        plan: fp,
        templateSidebar: tSidebar,
        status: statusValue(env.lifecycle, status),
      };
  }
  // The created indexes' drafted text: one routing line per page they hold.
  const drafted = (
    p: PlannedPage,
    purpose: string,
    children: { id: string; name: string; scope: string | null }[],
  ) => {
    const text = draftIndexText(
      { ...owners.index, purpose },
      p.displayName,
      children.sort((a, b) => (a.name < b.name ? -1 : 1)),
      owners.index.emptyRouting,
    );
    if (!converter) return p;
    try {
      const b = fromMarkdown(text, { blocks: [] }, converter).blocks;
      const check = checkBody({
        page: p.rawName,
        role: 'index',
        blocks: b,
        titles: [p.displayName, p.rawName],
        type,
        warnMissing: [owners.index.routing, owners.index.boundaries],
        allowEmpty: [owners.index.collection],
      });
      refusals.push(...check.refusals.map((x) => ({ ...x })));
      return {
        ...p,
        markdown: text,
        blocks: b,
        headings: sectionsOf(b)
          .filter((s) => s.heading)
          .map((s) => s.title),
      };
    } catch (e) {
      if (e instanceof MarkdownError) refuse(e.code, `${p.rawName}: ${e.message}`);
      else throw e;
      return p;
    }
  };
  const ownerLine = !working ? [{ id: ownerId, name: rawPage, scope: facts.scope.value }] : [];
  if (nationPage)
    pages.push(
      drafted(nationPage, owners.index.purpose, [
        { id: promote!.node.id, name: promote!.node.rawName, scope: promote!.node.scope },
        ...(subPage ? [{ id: subPage.id, name: subPage.rawName, scope: null }] : ownerLine),
      ]),
    );
  if (subPage) pages.push(drafted(subPage, owners.index.purpose, [...ownerLine]));
  if (navPage) pages.push(drafted(navPage, owners.index.navigationPurpose, []));
  pages.push(ownerPage);
  if (needsIndex)
    notes.push(
      `The new index text is drafted (Purpose, ${owners.index.routing}, ${owners.index.collection}, ${owners.index.boundaries}); it is in the preview, to edit afterwards with write_page if needed.`,
    );

  // ---------------------------------------------------------------------------------- changes to existing pages
  const existing: ExistingChange[] = [];
  if (promote && nationPage) {
    existing.push({
      kind: 'move',
      page: ctx.types.resolveOne(promote.node.id),
      to: { item: 'nation' },
      toName: nationPage.rawName,
      name: promote.node.rawName,
    });
  }
  // v3 F3d (ADR 0053): the routing lines, as F3a's character tool adds them (C2's routing lines). Not recognised: nothing
  // added, and the preview says so (a note). ADR 0051's rule decides Last Major Revision for the edited index.
  const routingEnv = { pd: env.pd, mctx: env.mctx, tool: env.tool, ctx, type };
  const sayNote = (_code: string, message: string) => notes.push(message);
  // An Authoritative owner filed directly into an existing home: one line in the home's routing section. A Working
  // owner sits under [INDEX] Working (no line until it is promoted); a new nation index or subindex has drafted text.
  if (!working && home?.kind === 'node' && ownerParent && 'existing' in ownerParent) {
    const r = await routingChange(routingEnv, home.node, [ownerPage], refuse, sayNote);
    if (r) existing.push(r);
  }
  // promoteNation: the Polities index's line for the nation now points to the nation's new index.
  if (promote && nationPage) {
    const r = await repointRoutingLine(
      routingEnv,
      promote.polities,
      { id: promote.node.id, rawName: promote.node.rawName },
      { id: nationPage.id, rawName: nationPage.rawName },
      refuse,
      sayNote,
    );
    if (r) existing.push(r);
  }

  if (!tagsCurrent)
    refuse(
      'PACK_NOT_CURRENT',
      `${env.governance.message} No tags were computed (fail closed), so nothing can be proposed now.`,
      {
        governance: { state: env.governance.state, sources: env.governance.sources },
      },
    );
  if (status === 'authoritative')
    notes.push(
      'status "authoritative": the page is made in place as canon, so this is a canonical proposal ("Approve and accept as canon").',
    );

  // ---------------------------------------------------------------------------------- the job's re-checks (design 5)
  const under: AbsentUnder[] = [];
  const reservations: string[] = [];
  const destKey =
    home?.kind === 'node'
      ? home.node.id
      : home?.kind === 'planned'
        ? `${home.key}:${promote?.polities.id ?? (subParent && 'existing' in subParent ? subParent.existing.id : '')}:${k(destinationName ?? '')}`
        : 'none';
  reservations.push(`owner:${destKey}:${k(display)}`);
  if (ownerParent && 'existing' in ownerParent)
    under.push({ parentId: ownerParent.existing, names: [display], code: 'OWNER_EXISTS' });
  if (working && home?.kind === 'node')
    under.push({ parentId: home.node.id, names: [display], code: 'OWNER_EXISTS' });
  const present: PresentCheck[] = [];
  if (promote) {
    reservations.push(`nation:${promote.polities.id}:${k(nationName!)}`);
    under.push({ parentId: promote.polities.id, names: [nationName!], code: 'NATION_INDEX_EXISTS' });
    present.push({
      resourceId: promote.node.id,
      parentId: promote.polities.id,
      name: promote.node.rawName,
      code: 'NATION_REFERENCE_MOVED',
    });
  }
  if (subName && subParent && 'existing' in subParent)
    under.push({ parentId: subParent.existing.id, names: [subName], code: 'SUBINDEX_EXISTS' });
  if (navPlan) under.push({ parentId: navPlan.parent.id, names: [navPlan.name], code: 'NAVIGATION_EXISTS' });

  return {
    pack,
    type,
    mode: 'new',
    subject: display,
    status,
    pages,
    existing,
    images: [],
    refusals,
    warnings,
    replacements,
    held,
    governance: env.governance,
    absent: { reservation: null, reservations, under, present, kind: 'owner' },
    target: null,
    notes,
    extra: {
      ownerType: otype.name,
      ...(kindName ? { kind: kindName } : {}),
      home:
        home?.kind === 'node'
          ? {
              id: home.node.id,
              name: home.node.rawName,
              path: home.node.path.names.join(' / '),
              fits: homeFits,
              ...(overridden ? { override } : {}),
            }
          : home?.kind === 'planned'
            ? { planned: destinationName }
            : null,
      ...(nationName ? { nation: nationName } : {}),
      ...(promote
        ? {
            promoteNation: {
              index: nationRaw,
              in: promote.polities.rawName,
              moves: { id: promote.node.id, name: promote.node.rawName, idKept: true },
            },
          }
        : {}),
      ...(subRaw ? { createSubindex: subRaw } : {}),
      ...(navPlan ? { createCharacterNavigation: navPlan.path } : {}),
      continuity: { type: continuityType, name: continuity },
    },
    ...(promote
      ? {
          canonical: {
            reason: `moves the Authoritative page ${promote.node.rawName} into the new ${nationRaw} (promoteNation)`,
          },
        }
      : {}),
    ...(navPage && navPlan
      ? { taxonomy: [{ resourceId: navPage.id, plural: navPlan.name, parentNodeId: navPlan.parent.id }] }
      : {}),
    ...(overridden && override ? { summaryNote: `home override: ${override}` } : {}),
  };
}

/** The owner types a pack's tool makes (for its refusal and its description). */
export function ownerTypeNames(rules: PackRules): string[] {
  return rules.owners?.types.map((x) => x.name) ?? [];
}

export type { HomeTree };
