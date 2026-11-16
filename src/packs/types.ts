/**
 * Setting packs (v3 F3a, ADR 0050; PLAN-v2 section 10): the shape of a pack's rules. A pack is DATA: everything a type
 * needs to plan its pages (roles, templates by role, names, placement, sidebar facts, the closed tag grammar, the text
 * rules, assets) is in this document, stored per pack in the `packs` table, versioned and approved by the owner. The
 * engine (src/packs/engine) reads it; per-type code is limited to small hooks (src/packs/hooks) for what data cannot say.
 */
import * as z from 'zod';

// ============================================================================================ errors

export class PackError extends Error {
  override readonly name = 'PackError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

// ============================================================================================ the rules

const text = (max: number) => z.string().trim().min(1).max(max);
const key = text(200);

/**
 * One kind of page a type can create (`core`, `compact`, `art`, `relationship`, `specialist`, `index`, or any role a
 * later type names). The engine never assumes a role's meaning beyond these fields; a hook may add more.
 */
export const roleRuleSchema = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    /** The template role it is made from (mapped to a template id per project). */
    template: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    /**
     * The page name without its lifecycle prefix. Placeholders: `{Name}` (the subject), `{Title}` (a specialist page's
     * title), `{A}`, `{B}`, `{Label}` (a relationship's participants and label).
     */
    name: text(200),
    /** The Reference Type the page gets; null when the package gives it (a specialist page). */
    referenceType: z.string().trim().max(200).nullable(),
    /**
     * The tags in order: literal tokens, or slots: `$status` (the status tag: CANON or Working), `$race`, `$culture`
     * (the token maps), `$specialist` (the page's one specialist tag from the closed list). A Working page drops nothing
     * else: its status tag comes first. An empty list: no tags (an index).
     */
    tags: z.array(text(100)).max(12),
    /** Which facts the page gets: `identity` (every fact), `general` (the type's general keys only), `none`. */
    facts: z.enum(['identity', 'general', 'none']),
    /** Whether the package must give the page a body (an index's body may be drafted instead). */
    body: z.enum(['required', 'optional', 'drafted']),
    /** Headings whose absence is warned about (Source Boundaries, Unresolved Material). */
    warnMissing: z.array(text(200)).max(10),
    /** At most this many per package (1 for a Core). */
    max: z.number().int().min(1).max(50),
  })
  .strict();
export type RoleRule = z.infer<typeof roleRuleSchema>;

/** Where a type's pages go. */
export const placementRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      /** By a fact's value through the A3 taxonomy of a registry type (characters: Race / Species). */
      kind: z.literal('taxonomy'),
      /** The registry type whose root and taxonomy are used (`Character`). */
      registryType: text(100),
      /** The identity field that names the category (`race`). */
      field: text(100),
      /** An unmatched value goes here (directly under the type root), with a warning. */
      fallbackIndex: text(200),
    })
    .strict(),
  z
    .object({
      /** Under one fixed index, found by name inside the AI REPOSITORY (F3b: a nation's own index, and so on). */
      kind: z.literal('fixed'),
      index: text(200),
    })
    .strict(),
]);
export type PlacementRule = z.infer<typeof placementRuleSchema>;

/** An identity field of a package and the sidebar row it fills. */
export const identityFieldSchema = z
  .object({
    /** The package's field (`givenName`). */
    field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
    /** The sidebar row (`Personal / Given Name`). */
    key,
    /** Gated: must be given, never blank or a placeholder; `Unestablished` only with a reason. */
    gated: z.boolean(),
  })
  .strict();
export type IdentityField = z.infer<typeof identityFieldSchema>;

export const typeRulesSchema = z
  .object({
    /** The type's name (`Character`), unique in the pack. */
    name: text(100),
    /** The tool, without the pack's prefix (`create_character` → `arkona_create_character`). */
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    /** The code hook for what data cannot express (`character`), or null for a type that is data only. */
    hook: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .nullable(),
    placement: placementRuleSchema,
    roles: z.array(roleRuleSchema).min(1).max(20),
    identity: z.array(identityFieldSchema).max(30),
    /** The value a gated field may take deliberately, with a reason. */
    unestablished: text(100),
    /** Values that count as a template placeholder (compared without case and surrounding brackets). */
    placeholders: z.array(z.string().max(100)).max(50),
    /** Facts every page that takes them gets, unless the package or a target says otherwise. */
    fixedFacts: z.record(key, z.string().max(500)),
    /** The keys a `general` page gets. */
    generalKeys: z.array(key).max(40),
    /** The closed list of specialist tags (a specialist page takes at most one). */
    specialistTags: z.array(text(100)).max(30),
    /** Suggested Reference Types for specialist pages: a title's key word → the suggestion. */
    suggestedReferenceTypes: z.record(text(100), text(200)),
    /** Asset placement. */
    assets: z
      .object({
        /** The subfolders a package may name, by kind (`form` → `Forms`), under the character's own folder. */
        subfolders: z.record(z.enum(['form', 'outfit', 'details']), text(100)),
        /** An image's display name; `{Subject}` and `{Label}`. */
        displayName: text(200),
        /** The section of the Art page the images go in, and the role that holds images. */
        section: text(200),
        role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
      })
      .strict(),
    /** The index: its role, and the drafted text's sections and wording (`{Name}`). */
    index: z
      .object({
        role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        purpose: text(1000),
        routing: text(200),
        collection: text(200),
        boundaries: text(200),
        boundariesText: text(1000),
      })
      .strict(),
    /** Text rules. */
    text: z
      .object({
        firstHeading: text(200),
        /** The section `Unestablished` reasons go in. */
        unresolved: text(200),
        /** Overload heuristic for identity pages (documented in ADR 0050). */
        overload: z
          .object({
            roles: z.array(z.string()).max(10),
            /** Heading words of each specialist domain, by the domain's name. */
            domains: z.record(text(100), z.array(text(100)).max(20)),
            /** A matching section longer than this many characters is a large block. */
            minChars: z.number().int().min(100).max(100_000),
          })
          .strict(),
      })
      .strict(),
    /** Relationships: the role, the subject pattern, the default label. */
    relationship: z
      .object({
        role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        subject: text(200),
        defaultLabel: text(100),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TypeRules = z.infer<typeof typeRulesSchema>;

export const packRulesSchema = z
  .object({
    schema: z.literal(1),
    settings: z
      .object({
        /** Every package is a proposal for the owner, whatever the caller's scope (the pack's first weeks). */
        alwaysPropose: z.boolean(),
      })
      .strict(),
    /** The closed tag grammar's tokens. */
    tags: z
      .object({
        authoritative: text(100),
        working: text(100),
        /** Never tags (`Unknown`, `Unestablished`, `None`). */
        never: z.array(text(100)).max(20),
        /** fact value → tag token (`Draconic (True Dragons)` → `Draconic`); the owner edits these on the Packs page. */
        race: z.record(text(200), text(100)),
        culture: z.record(text(200), text(100)),
        /** Exceptional identity kinds accepted as race tokens as they are (`Kami`, `Heavenly Beast`). */
        exceptional: z.array(text(100)).max(30),
      })
      .strict(),
    /** Page names: words and date forms a name may never hold, and the dash rule. */
    names: z
      .object({
        forbiddenWords: z.array(text(100)).max(20),
        /** Regular expressions (sources) of a date in a name. */
        datePatterns: z.array(text(300)).max(20),
      })
      .strict(),
    /** The link collections and the sidebar property. */
    sidebar: z
      .object({
        property: text(200),
        dependencies: text(200),
        related: text(200),
      })
      .strict(),
    types: z.array(typeRulesSchema).min(1).max(40),
  })
  .strict()
  .superRefine((r, ctx) => {
    const names = new Set<string>();
    for (const t of r.types) {
      const k = t.name.toLowerCase();
      if (names.has(k)) ctx.addIssue({ code: 'custom', message: `type ${t.name} twice` });
      names.add(k);
      const roles = new Set(t.roles.map((x) => x.role));
      if (roles.size !== t.roles.length) ctx.addIssue({ code: 'custom', message: `${t.name}: a role twice` });
      if (!roles.has(t.index.role))
        ctx.addIssue({ code: 'custom', message: `${t.name}: no role ${t.index.role} for the index` });
      if (!roles.has(t.assets.role))
        ctx.addIssue({ code: 'custom', message: `${t.name}: no role ${t.assets.role} for images` });
      if (t.relationship && !roles.has(t.relationship.role))
        ctx.addIssue({ code: 'custom', message: `${t.name}: no role ${t.relationship.role}` });
    }
    for (const p of r.names.datePatterns) {
      try {
        new RegExp(p, 'iu');
      } catch {
        ctx.addIssue({ code: 'custom', message: `not a pattern: ${p}` });
      }
    }
  });
export type PackRules = z.infer<typeof packRulesSchema>;

/** A governance document the rules were derived from. */
export const governanceSourceSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    /** The project it lives in, by name (the pack's home: `arkona`). */
    project: text(64),
    resourceId: text(64),
    documentId: text(64),
    name: text(200),
    /** The version the standard calls itself by, for people (`v1.8`); the approval records the document's version. */
    label: z.string().max(100).optional(),
  })
  .strict();
export type GovernanceSource = z.infer<typeof governanceSourceSchema>;

/** What an approval records. */
export interface PackApproval {
  /** The rules' version approved. */
  readonly version: number;
  readonly at: number;
  readonly by: string;
  /** Each governance source's document version at that moment. */
  readonly sources: readonly { readonly key: string; readonly version: string }[];
}

export interface PackDrift {
  readonly at: number;
  readonly changed: readonly {
    readonly key: string;
    readonly name: string;
    readonly approved: string | null;
    readonly current: string | null;
    readonly reason?: string;
  }[];
}

/** A pack as stored. */
export interface Pack {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly rules: PackRules;
  readonly version: number;
  readonly governance: readonly GovernanceSource[];
  readonly approved: PackApproval | null;
  readonly drift: PackDrift | null;
  readonly seed: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A pack's attachment to a project. */
export interface PackAttachment {
  readonly packId: string;
  readonly projectId: string;
  /** Template role → this project's template id (null: not worked out). */
  readonly templates: Readonly<Record<string, string | null>>;
  readonly notes: readonly string[];
  readonly attachedAt: number;
  readonly attachedBy: string;
}

/** The seed of a pack: its rules, governance sources, the projects it attaches to, and template ids where known. */
export interface PackSeed {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  /** A version name for the seed itself (a newer seed of the same pack is offered, never applied by itself). */
  readonly seed: string;
  readonly rules: PackRules;
  readonly governance: readonly GovernanceSource[];
  /** Attached at start to the projects with these names, when they exist. */
  readonly projects: readonly {
    readonly name: string;
    /** Template ids for this project, by role, when known (else worked out from the home project's template names). */
    readonly templates?: Readonly<Record<string, string>>;
  }[];
  /** The project whose template ids are the reference for working out another project's (by template name). */
  readonly home: string;
}
