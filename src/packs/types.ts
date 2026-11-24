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
    /**
     * v3 F3b (ADR 0052): the tags of a Working page when they differ from `tags` (an owner page in Arkona's seed:
     * `Working`, the primary tag, then the specialist if any, by the owner's ruling of 16 November 2026). A slot of
     * `tags` it leaves out is held and reported, never silently dropped. Absent: a Working page has `tags` with
     * `Working` as its status tag.
     */
    workingTags: z.array(text(100)).max(12).optional(),
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
    /**
     * Asset placement. v3 F7 (ADR 0070, G1 and G6): the old `subfolders` (Forms, Outfits, Details) is gone: design pieces
     * go in the character's folder and outfit pieces in its Wardrobe, decided by the bridge. A stored pack version that
     * still carries `subfolders` is read with it dropped.
     */
    assets: z.preprocess(
      (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v) || !('subfolders' in v)) return v;
        const { subfolders: _legacy, ...rest } = v as Record<string, unknown>;
        return rest;
      },
      z
        .object({
          /** An image's display name; `{Subject}` and `{Label}`. */
          displayName: text(200),
          /** The section of the Art page the images go in, and the role that holds images. */
          section: text(200),
          role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        })
        .strict(),
    ),
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

// ============================================================================================ v3 F3b: owners

const roleName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/**
 * v3 F3b (ADR 0052; the owner-approved design docs/design/F3b-owner-tools.md, section 1): where an owner page may live,
 * recognised by the index's own name and place, never invented:
 * - `category`: `<Continent> <Category>` (an index named so beneath its continent's own `[INDEX] <Continent>`),
 *   `<Nation> <Category>` (beneath a nation index), or `<worldPrefix> <Category>` (`Arkonan Cultures`);
 * - `nation`: a nation index (an index directly in a `<Continent> Polities` index);
 * - `named`: an index of exactly this name (`Divine Realm Cultures`);
 * - `under`: an index directly beneath an index of this name (a Divine Realm index, under `Divine Realms`);
 * - `index`: one index by id, else by name (the Bestiary);
 * - `races`: the race roster's own pages (owner ruling, design 1.1a): `root` Races of Arkona itself, `group` a Racial
 *   Group Reference in it, `race` a race's Core Information page.
 */
export const homeRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('category'),
      level: z.enum(['continent', 'nation', 'world']),
      category: text(100),
    })
    .strict(),
  z.object({ kind: z.literal('nation') }).strict(),
  z.object({ kind: z.literal('named'), name: text(200) }).strict(),
  z.object({ kind: z.literal('under'), parent: text(200), label: text(200) }).strict(),
  z.object({ kind: z.literal('index'), id: text(64), name: text(200) }).strict(),
  z.object({ kind: z.literal('races'), as: z.enum(['root', 'group', 'race']) }).strict(),
]);
export type HomeRule = z.infer<typeof homeRuleSchema>;

/** A kind of the Species type on the race roster (design 1.1a): its homes, name, Reference Type and tags. */
export const ownerKindSchema = z
  .object({
    homes: z.array(homeRuleSchema).min(1).max(10),
    /** The page name without its prefix (`{Name} - Core Information`). */
    name: text(200),
    /** The Reference Type it always gets, or null when the package gives it. */
    referenceType: z.string().trim().max(200).nullable(),
    /** The one specialist tag it always gets (`Racial Group`), or null: none. */
    specialist: z.string().trim().max(100).nullable(),
    /** Its character navigation (`Characters / <Group> / <Race>`): `race`, `group`, or null for none. */
    navigation: z.enum(['race', 'group']).nullable(),
  })
  .strict();
export type OwnerKind = z.infer<typeof ownerKindSchema>;
export const OWNER_KINDS = ['race', 'racialGroup', 'subrace'] as const;
export type OwnerKindName = (typeof OWNER_KINDS)[number];

/** One row of the design's type table (section 1.1). */
export const ownerTypeSchema = z
  .object({
    /** The `type` argument (`Polity`). */
    name: text(100),
    /** The template role it is made from (mapped to a template id per project). */
    template: roleName,
    /** Its primary tag from the closed list (`Polity`). */
    primary: text(100),
    /** The specialist tags it may carry, at most one per page (`Government`). */
    specialist: z.array(text(100)).max(10),
    homes: z.array(homeRuleSchema).min(1).max(20),
    /** Species only: the race roster's kinds; a Species with no `kind` uses `homes` (the Bestiary). */
    kinds: z.partialRecord(z.enum(OWNER_KINDS), ownerKindSchema).optional(),
    /** For people: why the row is as it is (the owner's ★ confirmations). */
    note: z.string().max(500).optional(),
  })
  .strict();
export type OwnerType = z.infer<typeof ownerTypeSchema>;

/** The shared rules of every non-character owner (design section 1): one tool, typed by `types`. */
export const ownersRulesSchema = z
  .object({
    /** The tool, without the pack's prefix (`create_owner`). */
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    facts: z
      .object({
        /** The facts a package must give (besides Subject, which is its name). */
        required: z.array(key).max(10),
        /** The sidebar rows an owner page may get, in no particular order (the template gives the order). */
        keys: z.array(key).min(1).max(40),
        /** Facts every owner page gets unless the package says otherwise (Continuity Type, Continuity, Inheritance). */
        fixed: z.record(key, z.string().max(500)),
        /** Supersedes when the package gives none. */
        supersedes: z.string().max(200),
      })
      .strict(),
    unestablished: text(100),
    placeholders: z.array(z.string().max(100)).max(50),
    /** The tags of an owner page: slots `$status`, `$primary`, `$specialist`; a Working page's own list. */
    tags: z.object({ authoritative: z.array(text(100)).max(6), working: z.array(text(100)).max(6) }).strict(),
    /** The prefix of the world-level category indexes (`Arkonan Cultures`). */
    worldPrefix: text(100),
    /** The category whose indexes hold the nations (`Polities`). */
    nations: text(100),
    text: z
      .object({
        firstHeading: text(200),
        unresolved: text(200),
        warnMissing: z.array(text(200)).max(10),
      })
      .strict(),
    /** The indexes a package may create (a nation, a national subindex, character navigation): drafted text. */
    index: z
      .object({
        template: roleName,
        purpose: text(1000),
        navigationPurpose: text(1000),
        routing: text(200),
        collection: text(200),
        boundaries: text(200),
        boundariesText: text(1000),
        /** The routing section of an index made with no page in it yet (character navigation). */
        emptyRouting: text(300),
      })
      .strict(),
    /** The race roster (design 1.1a): Races of Arkona, and the Characters navigation a new race needs. */
    races: z
      .object({
        root: z.object({ id: text(64), name: text(200) }).strict(),
        navigation: text(200),
      })
      .strict(),
    types: z.array(ownerTypeSchema).min(1).max(40),
  })
  .strict();
export type OwnersRules = z.infer<typeof ownersRulesSchema>;

// ============================================================================================ v3 F3e: splits

/** CR-2026-11-R4: the split completeness sections a kind of new owner is expected to address (ADR 0059 amendment 1). */
const splitFrameList = z.array(z.enum(['sourceBoundaries', 'unresolvedMaterial'])).max(2);

/**
 * v3 F3e (ADR 0059; the owner-approved design docs/design/F3e-splits.md): the measurable Split Triggers of Character
 * Architecture, with Anti-Fragmentation as their counterweight, and what `arkona_split_owner` checks. DATA the owner
 * tunes with a new pack version (decision D4: Scope Overload at `scopeOverload.minDomains` or more domains; Retrieval Cost
 * needs `retrievalCost.minWords` words AND `retrievalCost.minDomains` or more domains, never length alone).
 */
export const splitsRulesSchema = z
  .object({
    /** Scope Overload: the Scope (or the top-level sections) name this many separate domains or more (D4: 3). */
    scopeOverload: z.object({ minDomains: z.number().int().min(2).max(20) }).strict(),
    /** Retrieval Cost: this many words or more AND top-level sections in this many domains or more (D4). */
    retrievalCost: z
      .object({
        minWords: z.number().int().min(100).max(1_000_000),
        minDomains: z.number().int().min(2).max(20),
      })
      .strict(),
    /**
     * Asset Ownership: a non-Art page whose body holds this many image blocks or more, or a section whose heading
     * carries one of `sectionWords` (wardrobe, form, outfit) and holds an image.
     */
    assetOwnership: z
      .object({
        minImages: z.number().int().min(1).max(100),
        sectionWords: z.array(text(100)).min(1).max(30),
      })
      .strict(),
    /** Shared Ownership: a section about one named character, at least this many words (it could stand alone). */
    sharedOwnership: z.object({ minWords: z.number().int().min(10).max(100_000) }).strict(),
    /** Distinct Unresolved Material: at least this many of its items under one domain. */
    unresolved: z.object({ minItems: z.number().int().min(2).max(100) }).strict(),
    /** A character page's domains: the domain's name → the words of a heading (or Scope) that names it. */
    domains: z.record(text(100), z.array(text(100)).min(1).max(40)),
    /** Any other owner page's domains (an owner type's name where one owns it: Military, Religion, Law…). */
    ownerDomains: z.record(text(100), z.array(text(100)).min(1).max(40)),
    /** Headings that are the page's own frame (Purpose, Identity, Source Boundaries…): they stay in a draft map. */
    stays: z.array(text(200)).max(30),
    /**
     * The Anti-Fragmentation Rule's examples: groups of heading words whose sections should probably stay together
     * (personality and habits; body, face and forms; a shared romantic hierarchy).
     */
    together: z
      .array(z.object({ example: text(300), words: z.array(text(100)).min(2).max(40) }).strict())
      .max(20),
    /** A character domain → the new owner a draft destination map suggests (an F3a role, its title, Reference Type). */
    destinations: z.record(
      text(100),
      z
        .object({
          role: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
          title: text(200).optional(),
          referenceType: text(200).optional(),
        })
        .strict(),
    ),
    /** The visual audit (step 5): an Art or visual owner is one of these roles, Reference Types or tags. */
    visual: z
      .object({
        roles: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)).max(10),
        referenceTypes: z.array(text(200)).max(20),
        tags: z.array(text(100)).max(20),
      })
      .strict(),
    /** Universal owners (step 4): an Authoritative owner page tagged with one of these owner types' primary tags. */
    universalTypes: z.array(text(100)).max(40),
    /** The triggers the bridge cannot measure, put to the owner as questions. */
    questions: z.array(z.object({ trigger: text(100), question: text(1000) }).strict()).max(10),
    /**
     * Steering away from manual splits (as F3d.1 steers renames): `write_page` that would remove whole top-level
     * sections holding this many words or more from a pack page is refused with `USE_ARKONA_SPLIT` (`plainEdit` with a
     * reason lets it through).
     */
    guardWords: z.number().int().min(20).max(100_000),
    /**
     * CR-2026-11-R4 (the owner's request; ADR 0066 A): which of the source's Source Boundaries and Unresolved Material
     * a NEW owner of a split must address (ADR 0059 amendment 1), by the kind of page it is: its Reference Type first
     * (ignoring case), else its role in a character's set (`core`, `compact`, `relationship`, `art`, `specialist`), else
     * its owner type (`Polity`, `Culture`…), else `otherwise`. A section a new owner is not expected to carry is neither
     * asked for nor refused (items of it may still move there, its text may still be given). Absent (a version before
     * it): every new owner addresses both, as amendment 1 built.
     */
    sections: z
      .object({
        referenceTypes: z.record(text(200), splitFrameList),
        roles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), splitFrameList),
        ownerTypes: z.record(text(100), splitFrameList),
        otherwise: splitFrameList,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SplitsRules = z.infer<typeof splitsRulesSchema>;

// ============================================================================================ v3 F3f: retagging

/**
 * v3 F3f (ADR 0060): the retag tools' data, a derived translation of the Controlled Native Tagging Standard's
 * "Classification and Manual Implementation Procedure" and "Bridge and Audit Interface" (never a competing source).
 * Absent (an older pack): no retag tools.
 */
export const retagRulesSchema = z
  .object({
    /** The most pages one `arkona_retag_apply` proposal takes (the Standard's bounded batches; each page an item). */
    batchSize: z.number().int().min(1).max(100),
    /**
     * Reference Types whose pages carry the identity tokens (race, then culture): the Character Core, the Compact
     * Character Reference and any other reference the Standard makes eligible. Together with the Reference Types of the
     * roles whose grammar names `$race` or `$culture`.
     */
    identityReferenceTypes: z.array(text(200)).max(20),
    /**
     * The Standard's "Excluded Routine Tags" (a pinned section): tags confirmed incidental, so proposing their removal
     * is a deterministic correction. Any other tag outside the grammar is an owner exception (never removed by itself).
     */
    excludedRoutineTags: z.array(text(100)).max(100),
    /**
     * v3 F5a (ADR 0067, H1): the Standard's "Approved Supplementary Tags" (a pinned section, read by its governing name,
     * F4b.1's rule): tags permitted wherever they appear, kept after the grammar's slots, never added by inference and
     * never proposed for removal. `tags` is the list as the section states it when this version was made; the bridge
     * parses the section at each governance check and offers a new version when the list there differs (an author
     * decision recorded on the page). Absent: no supplementary tags (an older version).
     */
    supplementary: z
      .object({
        /** The governance source holding the section (its key). */
        source: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
        /** The section's heading, as pinned. */
        section: text(200),
        tags: z.array(text(100)).max(100),
      })
      .strict()
      .optional(),
    /**
     * Indexes (by name, prefix aside) whose pages are never retagged by inference: the Legacy Canon Archive, the Design
     * References, repository governance. Navigation indexes and the governance sources' own pages are always excluded.
     */
    excludedAreas: z.array(text(200)).max(20),
  })
  .strict();
export type RetagRules = z.infer<typeof retagRulesSchema>;

// ============================================================================================ v3 F4a: drift and names

/**
 * v3 F4a (ADR 0063): one entry of the governance drift audit's equivalence map: a name the governance pages may still use
 * (an old bridge call such as `write_lk`, or a kebab-case skill such as `format-baisheng-owners`) and the bridge's
 * equivalent, which the finding suggests as the replacement to copy into a `write_page` edit by hand. Data, never code:
 * the owner changes it with a new pack version.
 */
export const governanceEquivalentSchema = z
  .object({
    /** The name as the governance pages write it. */
    name: z.string().regex(/^[a-z][a-z0-9_-]{1,99}$/),
    /** Arguments the call must carry for this equivalent (`{ job_action: 'guide' }`); absent: any. */
    when: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), text(100)).optional(),
    /** The bridge's equivalent: a tool's name, or the words for one (`the chronology audit`). */
    use: text(300),
    /** More about it: where it lives, or what a partial equivalent leaves out. */
    note: z.string().trim().max(500).optional(),
    /** The equivalent covers only part of what the name did (the finding says so). */
    partial: z.boolean().optional(),
  })
  .strict();
export type GovernanceEquivalent = z.infer<typeof governanceEquivalentSchema>;

/**
 * v3 F4a (ADR 0063): the governance drift audit's data (the audits' `governance` category). It reads the governance
 * root's tabs from the snapshots and reports, never repairs: governance edits are the owner's.
 */
export const governanceAuditSchema = z
  .object({
    /** The old bridge's call shapes, flagged wherever they appear as a whole word (`write_lk`, `read_lk`, `job_action`). */
    legacyNames: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,60}$/)).max(30),
    /** The equivalence map (an old call or an external skill → the bridge's equivalent). */
    equivalents: z.array(governanceEquivalentSchema).max(200),
    /**
     * Missing references are looked for only in sections whose heading holds one of these (`Startup`, `Related
     * Guidance`, `Source Boundaries`, `Dependencies`): anywhere else a capitalised phrase is too often not a name.
     */
    referenceSections: z.array(text(100)).min(1).max(20),
    /**
     * How generously a short name resolves before anything is reported (the owner's review of v3 F4a). Besides a page's
     * name, subject, aliases and tags and every tab's name, a page's name resolves with its lifecycle prefix, a `leading`
     * project prefix (`Arkona - `, any dash) and a trailing `generic` word (`Reference`, `Standard`, `Workflow`, `Index`)
     * removed ("Fiction Writing" for "Arkona – Fiction Writing Reference"), and a name in the text is also tried without
     * its trailing generic word. Absent: no leading prefix, and those four generic words.
     */
    resolution: z
      .object({
        leading: z.array(text(100)).max(20),
        generic: z.array(z.string().regex(/^[\p{L}][\p{L}\p{N}'’-]{0,39}$/u)).max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GovernanceAuditRules = z.infer<typeof governanceAuditSchema>;

/**
 * v3 F4a (ADR 0063): the name check's data (`arkona_name_check`). It reports; it never suggests or infers a naming
 * culture, race or nationality from a name, and never proposes a rename (Character Architecture).
 */
export const namingRulesSchema = z
  .object({
    /** The index whose subtree holds the culture owners a Naming Culture resolves to (`Arkonan Cultures`). */
    culturesIndex: text(200),
    /** Sections of a culture owner returned besides those whose heading matches "name" or "naming". */
    sections: z.array(text(200)).max(20),
    /** The governance tab that sets out how a personal name is presented (its order), pointed to in every answer. */
    presentationStandard: text(200).optional(),
  })
  .strict();
export type NamingRules = z.infer<typeof namingRulesSchema>;

/**
 * v3 F4b (ADR 0064, design D2): one phrasing the consistency check reads. Deliberately narrow: precision over recall.
 *
 * - `source`: where it is read: `temporalScope` (each `;` clause of a Temporal Scope field), `lifeState` (the Life State
 *   field: "Deceased" with a date), `prose` (each sentence of a block of a page's text) or `chronology` (a chronology
 *   row's Historical Event cell: only the event's kind and subject are read there, its date is the row's Date cell).
 * - `regex`: a regular expression source (matched case-insensitively, Unicode). Its named group `date` holds the text
 *   the date is read from: the date must START that text (`leading`) or is the first date in it (`first`, up to the
 *   clause's end); whatever follows the date is ignored. `{name}` stands for the subject: only a name, alias or Canonical
 *   Display Name of a character (in either order), never a pronoun. A pattern of kind `gap` reads no date: it records
 *   that the owner left the fact unestablished.
 */
export const consistencyPatternSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/),
    source: z.enum(['temporalScope', 'lifeState', 'prose', 'chronology']),
    /** `attested`: the bounds of a subject's attested life ("attested through", "alive at", "active at"). */
    kind: z.enum(['birth', 'death', 'attested']),
    regex: text(500),
    /**
     * How the date is read from the `date` group (absent: `leading`). `scan` (ADR 0064 amendment 1): the first
     * date-shaped substring of the clause (a day, a month or a year form of the calendar), cut at a clause word or `;`;
     * none found, no fact is recorded; one the calendar refuses is unreadable, with its reason.
     */
    date: z.enum(['leading', 'first', 'scan']).optional(),
    /** The bound an attested date gives: `to` (through, until: an open start), `from`, or `both` (a span, the default). */
    bound: z.enum(['from', 'to', 'both']).optional(),
    /** A deliberate gap ("birth date unestablished"): no date is read. */
    gap: z.boolean().optional(),
    /**
     * CR-2026-11-R4 (the owner's request L, characters with more than one life): `return` and `restoration` mark an
     * attested start (`bound: from`) that begins a new life ("Reborn 4A 300"; "restored to life … Camue 1st, 5A 1");
     * `span` reads the `date` group as a life's range, its start that life's birth and its end that life's death
     * ("First life Camue 1st, 4A 100–Camue 33rd, 4A 325"). A named group `life` holds the life's ordinal ("first",
     * "second", "2nd": `lifeOrdinals`), for a birth or a death of a named life.
     */
    life: z.enum(['return', 'restoration', 'span']).optional(),
  })
  .strict();
export type ConsistencyPattern = z.infer<typeof consistencyPatternSchema>;

/**
 * v3 F4b (ADR 0064): the consistency check's and "as of a date"'s data (`arkona_consistency`, `arkona_as_of`). Report
 * only, never a repair: a fix is the owner's pick, proposed for approval (design D6).
 */
export const consistencyRulesSchema = z
  .object({
    /** The present day (design D10): "now" in both tools, and what "alive at" the present attests up to. */
    present: text(100),
    /** The margin of a "c." date, in years each side (design D3). */
    approxMargin: z.number().int().min(0).max(1000),
    /** The sidebar field births, deaths and attested bounds are read from. */
    temporalScope: text(100),
    /** The sidebar field a dated "Deceased" is read from. */
    lifeState: text(100),
    /** The identity facts compared where another page restates them in a field of the same name (design D1). */
    identityFields: z.array(text(100)).max(20),
    /** Values meaning "deliberately not established": never a conflict, reported as a gap (design D3). */
    unestablished: z.array(text(100)).max(20),
    patterns: z.array(consistencyPatternSchema).min(1).max(100),
    /**
     * ADR 0064 amendment 1 (rule A): titles allowed between a clause's start and the name governing its verb ("Kaiser
     * Soren von Woerfels dies"), and stripped before a name standing alone in an appositive. Absent: Kaiser, Kaiserin.
     */
    titles: z.array(text(100)).max(100).optional(),
    /**
     * ADR 0064 amendment 1 (rule A): the words that start a new clause, besides commas, semicolons and a spaced dash.
     * Absent: after, when, before, until, while.
     */
    clauseWords: z.array(text(50)).max(30).optional(),
    /**
     * CR-2026-11-R4 (RC-1): the relational particles ("of", "bint", "ibn", "née"…): a name right after one of them is a
     * relation of the subject ("The daughter of Rashad al-Khalid was born"), never the subject; nobody is read. Absent:
     * of, bint, ibn, bin, ben, bat, née, by, with, for, to, from, and, or, nor.
     */
    relational: z.array(text(50)).max(60).optional(),
    /**
     * ADR 0064 amendment 1 (F): sections (by any heading above them) and chronology rows (by their text) holding one of
     * these markers are non-current material inside current pages ("Author-Facing Pre-Rewrite History"). With
     * `exclude` on, they are left out unless `include: ["pre-rewrite"]` asks for them, and labelled "Historical material
     * differs" when included; with it off, nothing changes.
     */
    nonCurrent: z
      .object({
        markers: z.array(text(100)).max(30),
        exclude: z.boolean(),
      })
      .strict()
      .optional(),
    /**
     * v3 F4c (ADR 0065, design E6): the phrasings of an age written in prose, read by `arkona_chapter_check` only (never
     * by the consistency check): "<Name> is / was <n> (years old)", "<Name>, aged <n>". `{name}` stands for a
     * character's name, alias or Canonical Display Name (never a pronoun); the named group `age` holds the number.
     */
    ages: z
      .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/), regex: text(500) }).strict())
      .max(20)
      .optional(),
    /**
     * v3 F4c (ADR 0065; the owner's ruling from F4b.1's review, 20 November 2026): the Life State phrasings of an upper
     * bound on death ("Deceased by 5A 931"), one `;` clause at a time; the named group `date` holds the bound. Read by
     * `arkona_as_of` only: at or after the bound the state is "Deceased (recorded by <date>)", before it the other rules
     * apply. Never a fact, so never compared by the consistency check.
     */
    deceasedBy: z
      .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/), regex: text(500) }).strict())
      .max(10)
      .optional(),
    /**
     * v3 F4c (ADR 0065, amending F4b's D7 by the owner's ruling of 20 November 2026; ADR 0064 amendment 2: a principal
     * part STARTING with one of them, as a whole word): Life State values (their principal
     * part) that record the character alive at the pack's `present`. Read by `arkona_as_of` only: with a recorded birth,
     * the life is recorded from the birth to the present ("Alive (recorded)"); with none, at the present only. Never a
     * fact, never compared. Absent: a Life State says nothing about a date.
     */
    aliveValues: z.array(text(100)).max(10).optional(),
    /**
     * ADR 0064 amendment 2 (v3 F4.1): the phrasings of a date inside an alive Life State's principal part ("Alive in 5A
     * 931", "Living and immortal at 5A 931"); the named group `date` holds it. The Life State then attests the life up
     * to that date (not the present). Read by `arkona_as_of` only; never a fact, never compared. Absent: no date read.
     */
    aliveAt: z
      .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/), regex: text(500) }).strict())
      .max(10)
      .optional(),
    /**
     * CR-2026-11-R4 (RC-13): words or marks that make a Life State no record of the living wherever they stand in it
     * ("Alive (presumed)", "Alive - unconfirmed", "Alive?"). Read by `arkona_as_of` only. Absent: none.
     */
    aliveDoubt: z.array(text(50)).max(30).optional(),
    /**
     * CR-2026-11-R4 (RC-13): the words that may follow an alive value in a Life State's principal part ("Living and
     * immortal at 5A 931", "Alive as of 4A 500"); any other word after it ("Living memory") is no Life State of the living.
     * Absent: any word may follow (as F4.1 read it).
     */
    aliveFollowers: z.array(text(50)).max(30).optional(),
    /**
     * CR-2026-11-R4 (the owner's request L): the ordinal words of lives, in order ("first" is life 1), read from a
     * phrasing's `life` group and used to name a character's lives. Absent: first to tenth.
     */
    lifeOrdinals: z.array(text(30)).max(20).optional(),
  })
  .strict();
export type ConsistencyRules = z.infer<typeof consistencyRulesSchema>;

// ============================================================================================ v3 F4c: fiction

/**
 * v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md, E1 and E9): the layout of Narratives, as DATA.
 * Every name here is found by name in the repository tree (never by id); the templates by name through the project's
 * template list. A change is a new pack version the owner approves. Absent (an older pack): no narrative tools, no
 * narrative audit, and Narratives is ordinary repository content.
 */
export const narrativeRulesSchema = z
  .object({
    /** The indexes, by name: Narratives (every story under it), Continuities (each direct child an AU), Main CANON. */
    indexes: z.object({ narratives: text(200), continuities: text(200), main: text(200) }).strict(),
    /** The word only the main continuity index may carry in its name (E1: "the only index allowed CANON"). */
    reservedWord: text(50),
    /** The Continuity values that mean the main continuity (the index's own name, and Arkona's "Main"). */
    mainContinuityValues: z.array(text(100)).min(1).max(10),
    /** Continuity Type values (an AU's, and the main continuity's), written where a template has the field. */
    continuityType: z.object({ main: text(100), au: text(100) }).strict(),
    /** The name patterns (`{n}` a number, `{Title}` a title): unique within a story. */
    names: z
      .object({
        storyMap: text(100),
        actMap: text(100),
        chapterPlan: text(100),
        act: text(100),
        chapter: text(100),
        /** The optional overview page of a continuity index (any of these names). */
        chronologyMap: z.array(text(100)).min(1).max(10),
      })
      .strict(),
    /** The templates, by name (they sit outside the AI REPOSITORY; resolved through the template list). */
    templates: z
      .object({ storyMap: text(200), actMap: text(200), chapterPlan: text(200), chapter: text(200) })
      .strict(),
    /** The tags: `Narrative`, then the kind, then `AU` for an AU story; `Flashback` marks a chapter dated earlier. */
    tags: z
      .object({
        narrative: text(100),
        au: text(100),
        flashback: text(100),
        story: text(100),
        storyMap: text(100),
        act: text(100),
        actMap: text(100),
        chapterPlan: text(100),
        chapter: text(100),
        chronologyMap: text(100),
        continuity: text(100).optional(),
      })
      .strict(),
    /** The sidebar fields the tools read and write, by name (a field a template lacks is a template mismatch). */
    fields: z
      .object({
        story: text(100),
        act: text(100),
        chapterNumber: text(100),
        actNumber: text(100),
        inWorldDate: text(100),
        continuity: text(100),
        continuityType: text(100),
        pov: text(100),
        chapterPlan: text(100),
        chapter: text(100),
        draftStatus: text(100),
        lastMajorRevision: text(100),
        charactersPresent: text(100),
        locations: text(100),
        plannedDate: text(100),
        questionGate: text(100),
        planningStatus: text(100),
        storySpan: text(100),
        actSpan: text(100),
        principalCharacters: text(100),
      })
      .strict(),
    /** The Question Gate's values (the Workflow's Drafting Gate: a chapter is drafted only with its gate Closed). */
    gate: z.object({ open: text(50), closed: text(50) }).strict(),
    /** Planning Status values the tools write. */
    planning: z
      .object({ planned: text(50), drafted: text(50), reassessed: text(50), planning: text(50) })
      .strict(),
    /** The Chapter Plan's sections the reading tools return (the Workflow's chapter-plan format). */
    planSections: z.object({ canonConstraints: text(200), closingState: text(200) }).strict(),
    /** The dateline: In-world Date, then (with a place) this separator, spaced, and the place. Never an em dash. */
    dateline: z.object({ separator: text(10) }).strict(),
    /**
     * Template placeholder text (regular expression sources, matched case-insensitively against a whole field value):
     * a field still holding one in a real page is reported by the narrative audit (E8).
     */
    placeholders: z.array(text(300)).max(100),
    /** `arkona_chapter_check`: at most this many new-lore candidates are listed. */
    candidateCap: z.number().int().min(1).max(500),
    /** Capitalised words that are never a new-lore candidate on their own (weekdays, honorifics, "I"). */
    notNames: z.array(text(100)).max(500),
  })
  .strict();
export type NarrativeRules = z.infer<typeof narrativeRulesSchema>;

/** An owner's ruling the pack follows that its governance pages do not record yet (design 1.5: the AU tag). */
export const rulingSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    by: text(100),
    summary: text(2000),
  })
  .strict();
export type Ruling = z.infer<typeof rulingSchema>;

// ============================================================================================ v3 F6a: Reference Types

/** A Reference Type's name or role word: no `;`, `(`, `)` or `:` (the published section's own separators). */
const referenceTypeName = text(200).refine((s) => !/[;():]/.test(s) && !/,\s*also\b/i.test(s), {
  message: 'a Reference Type or role word may not hold ; ( ) : or “, also”',
});

/**
 * v3 F6a (ADR 0076; design T1, T13): the Reference Type vocabulary. A Reference Type names the page's ROLE, from a closed
 * list per primary category; time goes in Temporal Scope, geography in placement, detail in Scope. Each canonical type
 * carries its role word, the word templated names will use (F6d; nothing renames pages in F6a).
 *
 * `status: 'draft'`: the seed's own list, offered until the owner publishes the vocabulary to governance (Source
 * Formatting's "Reference Type Vocabulary", under "Sidebar Metadata"). `published`: the list as that section states it,
 * parsed at each governance check exactly as F5a parses the Approved Supplementary Tags; the section is then the
 * authority and the draft is ignored.
 */
export const referenceTypesRulesSchema = z
  .object({
    /** The governance source holding the section (its key). */
    source: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
    /** The section's heading, as pinned. */
    section: text(200),
    /** The section it is written under (a heading of the same source). */
    under: text(200),
    status: z.enum(['draft', 'published']),
    /** The rule, one paragraph (the section's first). */
    rule: text(2000),
    categories: z
      .array(
        z
          .object({
            /** A primary category tag (`Polity`, `Character`…). */
            category: text(100),
            types: z
              .array(
                z
                  .object({
                    name: referenceTypeName,
                    /** The role word templated names use (`Polity`, `Constitution`, `Language & Naming`). */
                    role: referenceTypeName,
                    /** Variants the vocabulary itself says mean this type (a confident suggestion). */
                    aliases: z.array(referenceTypeName).max(20).optional(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .max(60),
    /** Approved additional types (T13's Specialist exemption): kept as they are, never suggested away. */
    specialist: z
      .array(
        z
          .object({
            type: referenceTypeName,
            category: text(100),
            /** The pages it is approved for; null: any page in this category. */
            pages: z
              .array(z.object({ id: z.string().min(1).max(64), name: text(500) }).strict())
              .max(200)
              .nullable(),
          })
          .strict(),
      )
      .max(500),
    /** The rules' own words (pack data, edited as a new version): synonyms, time words, scope adjectives. */
    normalise: z
      .object({
        /** A word → the word it means (`Cultural` → `Culture`). */
        synonyms: z.record(text(100), text(100)),
        /** Words that carry time (they belong in Temporal Scope). */
        timeWords: z.array(text(100)).max(60),
        /** Scope adjectives (geography belongs in placement, detail in Scope). */
        scopeWords: z.array(text(100)).max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Map<string, string>();
    for (const c of r.categories)
      for (const t of c.types) {
        const k = t.name.toLowerCase();
        const had = seen.get(k);
        if (had !== undefined && had !== c.category.toLowerCase())
          ctx.addIssue({ code: 'custom', message: `${t.name} is canonical in two categories` });
        seen.set(k, c.category.toLowerCase());
      }
  });
export type ReferenceTypeRules = z.infer<typeof referenceTypesRulesSchema>;

export const packRulesSchema = z
  .object({
    schema: z.literal(1),
    settings: z
      .object({
        /**
         * Every package is a proposal for the owner, whatever the caller's scope (the pack's first weeks). Since v3 F3.4
         * (ADR 0055) the default for a tool the per-tool switches (`tools`) do not name.
         */
        alwaysPropose: z.boolean(),
        /**
         * v3 F3.4 (ADR 0055 decision D): per tool (its full name, `arkona_create_character`), `propose` (every package is
         * a proposal, whatever the agent's scope) or `scope` (it follows the agent's scope: a proposal at `propose`,
         * direct at `write`). A tool not named follows `alwaysPropose`. Changed on the Packs page: a new version.
         */
        tools: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.enum(['propose', 'scope'])).optional(),
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
        /**
         * v3 F3b (ADR 0052; the owner's ruling of 16 November 2026, design 1.5): an Authoritative page whose Continuity
         * Type is `continuityType` carries `tag` as its status tag in place of `authoritative`. A Working or Archived
         * page leads with its lifecycle tag instead, so it carries neither. Absent (an older pack): `authoritative`.
         */
        au: z
          .object({ continuityType: text(100), tag: text(100) })
          .strict()
          .optional(),
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
    /** v3 F3b (ADR 0052): the non-character owners (one tool, `{prefix}{owners.tool}`, typed by `owners.types`). */
    owners: ownersRulesSchema.optional(),
    /** v3 F3b: the owner's rulings the rules follow that the governance pages do not record yet, with their dates. */
    rulings: z.array(rulingSchema).max(20).optional(),
    /**
     * v3 F3d (ADR 0053): where the four lifecycle tools put the lifecycle tag, per attached project, by the project's
     * NAME: `lead` (first, as the Controlled Native Tagging Standard orders it: `Archived, Magic`) or `append` (last, ADR
     * 0035). A project not listed is `append`. Applies once the version holding it is approved.
     */
    lifecycleTagPosition: z.record(text(200), z.enum(['lead', 'append'])).optional(),
    /** v3 F3e (ADR 0059): the split appraisal's triggers and the split tool's audits (absent: no split tools). */
    splits: splitsRulesSchema.optional(),
    /** v3 F3f (ADR 0060): the retag audit and apply (absent: no retag tools). */
    retag: retagRulesSchema.optional(),
    /** v3 F4a (ADR 0063): the governance drift audit's data (absent: the `governance` category reports nothing). */
    governanceAudit: governanceAuditSchema.optional(),
    /** v3 F4a (ADR 0063): the name check's data (absent: no culture lookup; namesakes are still found). */
    naming: namingRulesSchema.optional(),
    /** v3 F4b (ADR 0064): the consistency check and "as of a date" (absent: neither tool applies). */
    consistency: consistencyRulesSchema.optional(),
    /** v3 F4c (ADR 0065): the fiction layout and its tools (absent: no narrative tools, no narrative audit). */
    narrative: narrativeRulesSchema.optional(),
    /**
     * v3 F5b (ADR 0068, H5): the automation framework's limits: at most `perCode` pages for each code a run, and at most
     * `perRun` pages for every code together (absent: 25 and 100). Which codes run is the owner's setting per project,
     * stored in the bridge's database and recorded in Repository Automation, never pack data.
     */
    automation: z
      .object({
        perCode: z.number().int().min(1).max(500),
        perRun: z.number().int().min(1).max(2000),
        /** The governance source that records the approved narrow automations (Repository Automation). */
        source: text(100),
        /** Its section, read by its governing name. */
        section: text(200),
        /** The words of the block-id sweep's paragraph, which the bridge's paragraphs follow. */
        sweepMarker: text(200),
      })
      .strict()
      .optional(),
    /**
     * v3 F7b (ADR 0071, D2): what `arkona_get_art` reads an image's written authority from. `ownerPages`: the pages
     * looked at first and marked `ownerPage` (a character's Art and Wardrobe pages), by Reference Type or by the pack's
     * art role's page name; `textChars`: the text under an image kept for each embedding page. Absent: the defaults
     * (`DEFAULT_ART_VIEW`, the same values as Arkona's seed).
     */
    artView: z
      .object({
        ownerPages: z
          .object({
            referenceTypes: z.array(text(200)).max(20),
            tags: z.array(text(100)).max(20),
          })
          .strict(),
        textChars: z.number().int().min(200).max(5000),
      })
      .strict()
      .optional(),
    /**
     * v3 F6a (ADR 0076): the Reference Type vocabulary (absent: no vocabulary; the report, the two checks and the
     * creation tools' guard do nothing).
     */
    referenceTypes: referenceTypesRulesSchema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.owners) {
      const seen = new Set<string>();
      for (const t of r.owners.types) {
        const k = t.name.toLowerCase();
        if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `owner type ${t.name} twice` });
        seen.add(k);
        if (t.kinds && t.name.toLowerCase() !== 'species')
          ctx.addIssue({ code: 'custom', message: `${t.name}: only Species has kinds` });
      }
      if (r.types.some((t) => t.tool === r.owners!.tool))
        ctx.addIssue({
          code: 'custom',
          message: `${r.owners.tool} is both a type's tool and the owners' tool`,
        });
    }
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
export type ArtViewRules = NonNullable<PackRules['artView']>;

/** v3 F7b (ADR 0071): `artView` when a pack's rules carry none (a version stored before the F7b seed). */
export const DEFAULT_ART_VIEW: ArtViewRules = {
  ownerPages: {
    referenceTypes: [
      'Character Art',
      'Character Physical & Visual Reference',
      'Character Wardrobe & Personal Presentation Reference',
    ],
    tags: ['Character Art', 'Visual Reference', 'Wardrobe'],
  },
  textChars: 1200,
};

/** v3 F3.4 (ADR 0055 decision D): how a pack tool's packages are submitted. */
export type PackToolMode = 'propose' | 'scope';

/**
 * Whether a pack tool's packages are always proposals (`propose`) or follow the agent's scope (`scope`): its switch in
 * `settings.tools`, else `alwaysPropose`. Canon and lifecycle changes stay proposals either way (the write guard), and
 * an agent's safety rails still apply at scope `write`.
 */
export function packToolMode(rules: Pick<PackRules, 'settings'>, tool: string): PackToolMode {
  const m = rules.settings.tools?.[tool];
  if (m === 'propose' || m === 'scope') return m;
  return rules.settings.alwaysPropose ? 'propose' : 'scope';
}

/** A governance document the rules were derived from. */
export const governanceSourceSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    /** The project it lives in, by name (the pack's home: `arkona`). */
    project: text(64),
    /** Empty when the source is found by `page` (v3 F4c): its ids are worked out from the repository tree. */
    resourceId: z.string().trim().max(64),
    documentId: z.string().trim().max(64),
    name: text(200),
    /**
     * v3 F4c (ADR 0065): the page the source is, found by its display name in the project's tree (any dash, any
     * spacing: "Arkona – Fiction Writing Reference" and "Arkona - Fiction Writing Reference" are one name), its main
     * page document read. Used when `resourceId` is empty (a Design References page whose id the pack does not hold).
     */
    page: text(200).optional(),
    /** The version the standard calls itself by, for people (`v1.8`); the approval records the document's version. */
    label: z.string().max(100).optional(),
    /**
     * v3 F3b (ADR 0052): the sections (headings) of the document the rules depend on, pinned one by one: the approval
     * records each one's digest and refuses when one cannot be found. The whole document's version still decides
     * drift (fail closed, as F3a); the sections say which pinned part changed.
     */
    sections: z.array(text(200)).max(20).optional(),
  })
  .strict()
  .refine((g) => (g.resourceId !== '' && g.documentId !== '') || g.page !== undefined, {
    message: 'a governance source needs its resource and document ids, or the page to find it by',
  });
export type GovernanceSource = z.infer<typeof governanceSourceSchema>;

/** v3 F3b: a pinned section as an approval records it. */
export interface PinnedSection {
  readonly heading: string;
  /** SHA-256 of the section's blocks (its heading and everything up to the next heading of its level or higher). */
  readonly digest: string;
}

/** What an approval records. */
export interface PackApproval {
  /** The rules' version approved. */
  readonly version: number;
  readonly at: number;
  readonly by: string;
  /** Each governance source's document version at that moment (and, v3 F3b, each pinned section's digest). */
  readonly sources: readonly {
    readonly key: string;
    readonly version: string;
    readonly sections?: readonly PinnedSection[];
  }[];
}

export interface PackDrift {
  readonly at: number;
  readonly changed: readonly {
    readonly key: string;
    readonly name: string;
    readonly approved: string | null;
    readonly current: string | null;
    readonly reason?: string;
    /** v3 F3b: the pinned sections that changed (or are gone); empty when only unpinned text changed. */
    readonly sections?: readonly string[];
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
  /** A version name for the seed itself (a seed is stored once; it never overwrites a stored pack). */
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
  /**
   * v3 F3b (ADR 0052): template roles whose home id is not known, by the template's name (`AI Polity and Institution`):
   * worked out in every project, the home one included, from its templates as last read (exactly, ignoring the word
   * "Template" and the prefix), as another project's ids always are.
   */
  readonly templateNames?: Readonly<Record<string, string>>;
  /**
   * v3 F3b: the seeds this one replaces. A stored pack seeded from one of them is offered this seed's rules as a NEW
   * version (never approved by the bridge): the owner's token maps are kept, the governance sources keep their stored
   * places and gain this seed's pinned sections, and the owner approves it on the Packs page.
   */
  readonly supersedes?: readonly string[];
}
