/**
 * Type hooks (v3 F3a, ADR 0050): the only per-type code of a setting pack. Everything else a type does comes from its
 * rules (src/packs/types.ts); a hook decides only what data cannot say well. A type whose rules name no hook gets the
 * generic behaviour below, which is what a data-only type (F3b's owner types, or the test's dummy Polity) uses.
 *
 * Extension points (named in ADR 0050 for F3b):
 * - `identityRole`: which role a NEW subject's identity page has (Character: `core` or `compact` from `depth`);
 * - `wantsIndex`: whether a NEW subject's set gets an index (Character: a Core always; a Compact only with siblings);
 * - `relationships`: whether the type handles relationship pages (partner, hosting, automatic Related Sources);
 * - `upgrade`: the role an existing identity page can be upgraded from and to (Character: compact → core);
 * - `routing`: whether new pages are announced in an existing index's routing section (Character: yes).
 */
import type { TypeRules } from './types.js';

export interface TypeHook {
  readonly name: string;
  /** The identity role of a NEW subject, or a refusal message. */
  identityRole(
    input: {
      readonly depth?: string | undefined;
      readonly roles: readonly string[];
    },
    type: TypeRules,
  ): { role: string } | { refusal: { code: string; message: string } };
  /** Whether a NEW subject's set gets its own index, given its identity role and the roles hosted beside it. */
  wantsIndex(identityRole: string, siblingRoles: readonly string[], type: TypeRules): boolean;
  readonly relationships: boolean;
  readonly upgrade: { readonly from: string; readonly to: string } | null;
  readonly routing: boolean;
}

/** The roles of a type that hold its identity facts. */
const identityRoles = (type: TypeRules) =>
  type.roles.filter((r) => r.facts === 'identity').map((r) => r.role);

/** The generic behaviour: the first identity role; an index whenever another page sits beside the identity page. */
export const GENERIC_HOOK: TypeHook = Object.freeze({
  name: 'generic',
  identityRole(input: { readonly roles: readonly string[] }, type: TypeRules) {
    const ids = identityRoles(type);
    const given = input.roles.filter((r) => ids.includes(r));
    if (given.length === 1) return { role: given[0]! };
    if (given.length === 0 && ids.length === 1) return { role: ids[0]! };
    return {
      refusal: {
        code: 'IDENTITY_PAGE_REQUIRED',
        message: `A ${type.name} package brings exactly one identity page (role ${ids.join(' or ') || 'none defined'}).`,
      },
    };
  },
  wantsIndex: (_identityRole: string, siblingRoles: readonly string[]) => siblingRoles.length > 0,
  relationships: false,
  upgrade: null,
  routing: false,
});

/**
 * The Character hook (Arkona's Character Architecture): `depth` "compact" makes one Compact Character Reference,
 * "developed" an index with a Character Core; a Compact Reference gets an index only when the package brings a sibling
 * page (as Kamigawa Miyuki); relationships are hosted under one participant and linked from both; a Compact Reference
 * can be upgraded to a Core; new pages are announced in the index's "How to Use This Index" section.
 */
export const CHARACTER_HOOK: TypeHook = Object.freeze({
  name: 'character',
  identityRole(input: { readonly depth?: string | undefined; readonly roles: readonly string[] }) {
    const hasCore = input.roles.includes('core');
    const hasCompact = input.roles.includes('compact');
    if (hasCore && hasCompact)
      return {
        refusal: {
          code: 'IDENTITY_PAGE_CONFLICT',
          message:
            'A package brings a Character Core or a Compact Character Reference, not both: a developed character has a Core (depth "developed"), a minor one a Compact Reference (depth "compact").',
        },
      };
    const depth = input.depth ?? (hasCompact ? 'compact' : 'developed');
    if (depth === 'compact') {
      if (hasCore)
        return {
          refusal: {
            code: 'DEPTH_MISMATCH',
            message: 'depth "compact" makes a Compact Character Reference (role "compact"), not a Core.',
          },
        };
      return { role: 'compact' };
    }
    if (depth === 'developed') {
      if (hasCompact)
        return {
          refusal: {
            code: 'DEPTH_MISMATCH',
            message: 'depth "developed" makes a Character Core (role "core"), not a Compact Reference.',
          },
        };
      return { role: 'core' };
    }
    return {
      refusal: { code: 'INVALID_DEPTH', message: `depth is "compact" or "developed" (not “${depth}”).` },
    };
  },
  wantsIndex: (identityRole: string, siblingRoles: readonly string[]) =>
    identityRole === 'core' || siblingRoles.length > 0,
  relationships: true,
  upgrade: { from: 'compact', to: 'core' },
  routing: true,
});

const HOOKS: Readonly<Record<string, TypeHook>> = { character: CHARACTER_HOOK };

/** The hook a type names (the generic one for none). An unknown hook name is a refusal for that type's tool. */
export function hookFor(type: TypeRules): TypeHook | null {
  if (type.hook === null) return GENERIC_HOOK;
  return HOOKS[type.hook] ?? null;
}
