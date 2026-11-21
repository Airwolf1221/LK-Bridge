/**
 * The setting packs' tools (v3 F3a, ADR 0050; PLAN-v2 section 10). Each carries its pack's prefix, is listed only while
 * its pack is attached to a project the bridge serves, and refuses any project its pack is not attached to. F3a's
 * `arkona_create_character` (the Arkona pack's Character type, the package of docs/design/F3-character-pack.md) and
 * v3 F3b's four (ADR 0052; docs/design/F3b-owner-tools.md): `arkona_create_owner` (every non-character owner, typed by
 * the pack's owner table), `arkona_create_relationship`, `arkona_add_character_art` and the read-only
 * `arkona_character_brief`. The engine behind them is the pack's (src/packs), driven by its data.
 */
import * as z from 'zod';
import { characterBrief } from '../../packs/brief.js';
import { runArt, runRelationship } from '../../packs/character-tools.js';
import { runOwner, runPackage } from '../../packs/run.js';
import { renameReport, runRename } from '../../packs/rename/run.js';
import { runSplit, splitReport } from '../../packs/split/run.js';
import type { PackageInput } from '../../packs/engine/plan.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { lastMajorRevisionArg } from './schemas.js';
import { CREATE_ANNOTATIONS, operationIdArg } from './resources.js';
import { errorResult, projectArg, withProject, type ToolDeps } from './shape.js';

/**
 * v3 F3b with ADR 0051 (ADR 0052 decision 14): the general tools' `lastMajorRevision`, for the EXISTING pages a package
 * changes; the pages it makes are always dated.
 */
const packLmrArg = lastMajorRevisionArg.describe(
  'Last Major Revision of the EXISTING pages the package changes (the pages it makes are always dated): "auto" (default: only for a major revision by the owner’s rule: 8+ words of text, a heading, a real fact, a Dependency; not a move, a new name, Related Sources alone), "set" or "skip". The preview says which applied to each page and why.',
);

const identityValue = z.union([
  z.string().max(500),
  z
    .object({
      value: z.string().max(500),
      reason: z
        .string()
        .max(2000)
        .optional()
        .describe('Required when value is "Unestablished": why it is open.'),
    })
    .strict(),
]);

const image = z
  .object({
    staged_id: z.string().min(1).max(64).describe('A staged upload (upload_image with stage: true).'),
    label: z
      .string()
      .min(1)
      .max(300)
      .describe(
        '“{Visual Role} - {Descriptor}”, e.g. “Primary Reference - Character Portrait”; no file extension.',
      ),
    interpretation: z.string().max(5000).optional().describe('What this reference establishes (required).'),
    subfolder: z
      .string()
      .max(300)
      .nullable()
      .optional()
      .describe(
        '“Forms / <named form>”, “Outfits / <named outfit>” or “Details”; omit for the character’s folder.',
      ),
  })
  .strict();

const page = z
  .object({
    role: z
      .string()
      .min(1)
      .max(40)
      .describe('core | compact | specialist | art | relationship (only the domains with real content).'),
    title: z
      .string()
      .max(200)
      .optional()
      .describe('specialist: the domain, e.g. "Biography" (name “{Name} - {title}”).'),
    referenceType: z
      .string()
      .max(200)
      .optional()
      .describe('specialist: its Reference Type (a suggestion is offered).'),
    specialistTag: z
      .string()
      .max(100)
      .optional()
      .describe(
        'specialist: at most one of Biography, Personality, Relationship, Character Art, Visual Reference, Wardrobe, Magic, Equipment.',
      ),
    scope: z.string().max(1000).optional().describe('The Scope row: one line of what the page covers.'),
    markdown: z
      .string()
      .max(200_000)
      .optional()
      .describe('The page text: “## Purpose” first (no title, no metadata).'),
    dependencies: z
      .array(z.string().max(500))
      .max(50)
      .optional()
      .describe('Pages it depends on (names or ids).'),
    related: z.array(z.string().max(500)).max(50).optional().describe('Related Sources (names or ids).'),
    images: z
      .array(image)
      .max(30)
      .optional()
      .describe('art: the staged images, each with its interpretation.'),
    with: z.string().max(200).optional().describe('relationship: the other character (name or id).'),
    label: z.string().max(100).optional().describe('relationship: the label (default "Relationship").'),
    host: z.enum(['self', 'other']).optional().describe('relationship: whose index holds it (default self).'),
  })
  .strict();

/**
 * v3 F3a (ADR 0050): the generic pack tool, for every tool name a pack's types name besides the explicit ones (F3b's
 * `create_owner`, or a type defined only in test data): one tool per name, its `type` argument choosing among the types
 * that share it, read from the pack's rules at each call. The same engine as `arkona_create_character`.
 */
export function genericPackTool(
  deps: ToolDeps,
  packId: string,
  prefix: string,
  toolName: string,
): McpToolProvider {
  const full = `${prefix}${toolName}`;
  const typesOf = (read: 'get' | 'peek' = 'get') =>
    deps.services?.packs?.[read](packId)
      ?.rules.types.filter((t) => t.tool === toolName)
      .map((t) => t.name) ?? [];
  return Object.assign(
    defineTool({
      name: full,
      title: `Create a pack page set (${full})`,
      access: 'write',
      description:
        `A setting pack's creation tool: builds a whole subject from ONE package by the pack's rules (only the pages you give, each from its template, named, placed, its sidebar filled in template order, its tags COMPUTED, links resolved), then verified. \`type\` chooses the kind (see the pack on get_bridge_guide). dryRun shows the full preview and writes nothing; otherwise it is ONE proposal for the owner, whatever your scope: never resubmit it, follow it with bridge_proposal_status. Missing identity values: ask the owner, never guess. ` +
        'Cost: 4 to 8 reads to plan (3 of them the pack’s governance); the job about 20 reads and 19 writes per page with a full sidebar (one write per row), fewer for an index.',
      inputSchema: z.object({
        type: z
          .string()
          .min(1)
          .max(100)
          .describe('The kind of subject (one of the pack’s types for this tool).'),
        name: z.string().min(1).max(200).describe('The subject’s name (no prefix).'),
        status: z
          .enum(['working', 'authoritative'])
          .optional()
          .describe('working (default) or authoritative (canon).'),
        identity: z
          .record(z.string().max(40), identityValue)
          .default({})
          .describe('The type’s identity facts.'),
        pages: z.array(page).max(30).default([]).describe('The pages, only those with real content.'),
        index: z
          .object({ markdown: z.string().max(100_000) })
          .strict()
          .optional()
          .describe('The index text.'),
        target: z.string().min(1).max(200).optional().describe('An EXISTING subject to add new pages to.'),
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      // CR-2026-11-R4 (LD-07): the list reads the pack through `peek` (kept until it changes).
      listed: () => (deps.services?.packs?.toolListed(packId) ?? false) && typesOf('peek').length > 0,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) => {
          const types = typesOf();
          const type = types.find((t) => t.toLowerCase() === args.type.toLowerCase());
          if (!type) {
            return errorResult(
              {
                code: 'PACK_TYPE_NOT_FOUND',
                message: `${full} makes ${types.join(', ') || 'no type now'}; not “${args.type}”.`,
                types,
              },
              pd,
            );
          }
          return runPackage(pd, mctx, {
            packId,
            type,
            tool: full,
            input: {
              name: args.name,
              ...(args.status !== undefined ? { status: args.status } : {}),
              identity: args.identity,
              pages: args.pages,
              ...(args.index !== undefined ? { index: args.index } : {}),
              ...(args.target !== undefined ? { target: args.target } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args: args,
          });
        }),
    }),
    { packGeneric: true },
  );
}

/** The tool names a set of packs needs besides the explicit tools: `{ packId, prefix, tool }` each once. */
export function genericPackToolNames(
  packs: readonly {
    readonly id: string;
    readonly prefix: string;
    readonly rules: { readonly types: readonly { readonly tool: string }[] };
  }[],
  explicit: ReadonlySet<string>,
): { packId: string; prefix: string; tool: string; name: string }[] {
  const out: { packId: string; prefix: string; tool: string; name: string }[] = [];
  for (const p of packs)
    for (const t of p.rules.types) {
      const name = `${p.prefix}${t.tool}`;
      if (explicit.has(name) || out.some((x) => x.name === name)) continue;
      out.push({ packId: p.id, prefix: p.prefix, tool: t.tool, name });
    }
  return out;
}

/** The explicit pack tools (their own schemas): F3a's character tool and v3 F3b's four. */
export const EXPLICIT_PACK_TOOLS: ReadonlySet<string> = new Set([
  'arkona_create_character',
  'arkona_create_owner',
  'arkona_create_relationship',
  'arkona_add_character_art',
  'arkona_character_brief',
  'arkona_rename',
  'arkona_split_owner',
]);

/** v3 F3b: how an agent stages art for a pack (design section 6): no destination, so nothing is proposed. */
const STAGE_HINT =
  'Stage art with upload_image { stage: true } and NO destination (that proposes nothing); a staged image whose only activity is its own pending placement proposal is taken over by the package, which withdraws that proposal.';

const linkList = (what: string) =>
  z.array(z.string().max(500)).max(50).optional().describe(`${what} (names or ids).`);

export function packTools(deps: ToolDeps): McpToolProvider[] {
  const packs = () => deps.services?.packs;
  // CR-2026-11-R4 (LD-07): the tool lists read the pack through `peek` (kept until it changes), not a parse a tool.
  const arkona = () => packs()?.peek('arkona');
  const hasCharacters = () =>
    (packs()?.toolListed('arkona') ?? false) &&
    (arkona()?.rules.types.some((t) => t.hook === 'character') ?? false);
  return [
    defineTool({
      name: 'arkona_create_character',
      title: 'Create an Arkona character (pack)',
      access: 'write',
      description:
        'The Arkona pack: builds a whole character from ONE package by Arkona’s rules: the right set of linked pages (only the domains you give), each from its template, named, placed under its race, its sidebar filled in template order, its tags COMPUTED (never typed), links resolved, images placed, then verified. Use it instead of separate creates for a new character, and with `target` to add new pages to an existing one (its name, alias or id). ' +
        'depth "compact": one Character Reference; "developed": an [INDEX] with a Character Core. status "working" (default): a Working set to promote later; "authoritative": canon. The six identity fields (givenName, surname, race, namingCulture, lifeState, temporalScope) are required: if one is unknown, ASK THE OWNER, never guess ("Unestablished" only with a reason the owner gave). At intake run arkona_name_check first (the naming-culture review); the preview lists the new name’s namesakes too: an exact full-name match is a NAMESAKE warning, also in the proposal’s summary (names may be shared: never refused); tell the person. ' +
        'dryRun shows the full preview (pages, facts, tags, links, folders, every dash replaced, refusals and warnings) and writes nothing: preview first. Otherwise it is ONE proposal for the owner, whatever your scope; never resubmit it, follow it with bridge_proposal_status. A refusal names the fix. ' +
        'Example: { "name": "Asagiri Ren", "depth": "compact", "identity": { "givenName": "Ren", "surname": "Asagiri", "race": "Foxian", "namingCulture": "Fujimatsuan", "lifeState": "Alive", "temporalScope": "5A 931" }, "pages": [{ "role": "compact", "scope": "Shrine guard", "markdown": "## Purpose\\n…" }], "dryRun": true, "project": "test" }. ' +
        `${STAGE_HINT} ` +
        'Cost: 4 to 8 reads to plan (3 of them the pack’s governance); the job about 20 reads and 19 writes for a compact character (one write per sidebar row), about 57 and 46 for a Core with a Biography and a Relationship, about 28 and 16 for an Art page with one image.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('The character’s Canonical Display Name (no prefix).'),
        depth: z
          .enum(['compact', 'developed'])
          .optional()
          .describe('compact: a Reference; developed: index and Core.'),
        status: z
          .enum(['working', 'authoritative'])
          .optional()
          .describe(
            'working (default for a new character): a Working set; authoritative: canon (a canonical proposal).',
          ),
        identity: z
          .object({
            givenName: identityValue.optional(),
            surname: identityValue.optional(),
            race: identityValue.optional(),
            namingCulture: identityValue.optional(),
            lifeState: identityValue.optional(),
            temporalScope: identityValue.optional(),
            subject: identityValue.optional(),
            canonicalDisplayName: identityValue.optional(),
            aliases: identityValue.optional(),
            supersedes: identityValue.optional(),
          })
          .strict()
          .default({})
          .describe('The identity facts: the six gated fields, plus subject, aliases, supersedes.'),
        pages: z.array(page).max(30).default([]).describe('The pages, only those with real content.'),
        index: z
          .object({ markdown: z.string().max(100_000) })
          .strict()
          .optional()
          .describe('The index text; omitted: a minimal one is drafted and shown in the preview.'),
        target: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('An EXISTING character (name, alias or id) to add new pages to.'),
        upgradeToCore: z
          .boolean()
          .optional()
          .describe('With target, a Compact Reference: rename it to its Character Core (text kept).'),
        split: z
          .unknown()
          .optional()
          .describe('Not supported: splitting an existing page is refused (a later tool).'),
        lastMajorRevision: packLmrArg,
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed: () => packs()?.toolListed('arkona') ?? false,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) => {
          const input: PackageInput = {
            name: args.name,
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            identity: args.identity,
            pages: args.pages,
            ...(args.index !== undefined ? { index: args.index } : {}),
            ...(args.target !== undefined ? { target: args.target } : {}),
            ...(args.upgradeToCore !== undefined ? { upgradeToCore: args.upgradeToCore } : {}),
            ...(args.split !== undefined ? { split: args.split } : {}),
          };
          return runPackage(pd, mctx, {
            packId: 'arkona',
            type: 'Character',
            tool: 'arkona_create_character',
            input,
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args: args,
            lastMajorRevision: args.lastMajorRevision,
          });
        }),
    }),
    // ---------------------------------------------------------------------------------- v3 F3b (ADR 0052)
    defineTool({
      name: 'arkona_create_owner',
      title: 'Create an Arkona owner page (pack)',
      access: 'write',
      description:
        'The Arkona pack: makes ONE non-character owner page by Arkona’s rules: a polity, institution, military, culture, event, place, technology, magic, material, equipment, species (a race, racial group or subrace with `kind`, or a Bestiary species), creature, religion, law, programme, education, ceremony, condition or inter-polity relationship (`type`). Its template, name “{name} - {descriptor}”, sidebar (template order), tags (COMPUTED: CANON, AU or Working, the primary, one optional specialist) and links follow the pack; the text starts with “## Purpose”. ' +
        '`home` is REQUIRED: the index it goes in (name, id or path), checked against the type’s allowed homes (HOME_NOT_ALLOWED lists suitable ones nearby; homeOverride { reason } only when the owner decided otherwise). A nation that is only a compact Reference needs its own index first: `nation` + `promoteNation: true` makes it in the same proposal; `createSubindex` names one national subindex to make. Reference Type, Scope and Temporal Scope are required: if one is unknown, ASK THE OWNER. ' +
        'dryRun shows the full preview and writes nothing; otherwise ONE proposal for the owner whatever your scope (canonical for status "authoritative" or a move of canon). Never resubmit it: follow it with bridge_proposal_status. ' +
        'Example: { "type": "Polity", "name": "Sultanate of Tarim", "descriptor": "Historical Polity Reference", "home": "Salahad Polities", "referenceType": "Historical Polity Reference", "scope": "A coastal sultanate", "temporalScope": "4A 100 - 4A 400", "markdown": "## Purpose\n…", "dryRun": true, "project": "test" }. ' +
        'An Authoritative owner gets one routing line in its home index’s routing section (as characters do); with promoteNation the Polities index’s line for the nation is pointed to the new index. ' +
        'Cost: 4 reads to plan (5 for an Authoritative owner: the home’s routing text; 3 of them the pack’s governance); the job about 20 reads and 13 writes for one page (one write per sidebar row), one more write for a routing line; with promoteNation 8 reads to plan, the job about 31 and 16.',
      inputSchema: z.object({
        type: z
          .string()
          .min(1)
          .max(100)
          .describe(
            'Polity, Institution, Military, Culture, Event, Place, Technology, Magic, Material, Equipment, Species, Creature, Religion, Law, Programme, Education, Ceremony, Condition or Relationship.',
          ),
        kind: z
          .enum(['race', 'racialGroup', 'subrace'])
          .optional()
          .describe(
            'Species on the race roster only (Races of Arkona); without it a Species goes to the Bestiary.',
          ),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('The Subject, no prefix: the page is “{name} - {descriptor}”.'),
        descriptor: z
          .string()
          .max(200)
          .optional()
          .describe(
            'The name’s second part, e.g. "Historical Polity Reference" (default: the Reference Type).',
          ),
        status: z
          .enum(['working', 'authoritative'])
          .optional()
          .describe(
            'working (default): [BWRK] under [INDEX] Working, to promote into home; authoritative: canon.',
          ),
        continuity: z
          .string()
          .max(200)
          .optional()
          .describe('"Main" (default: CANON) or an alternate universe’s name (an AU page, tagged AU).'),
        home: z.string().min(1).max(500).describe('REQUIRED: the index it goes in (name, id or path).'),
        homeOverride: z
          .object({ reason: z.string().min(1).max(1000) })
          .strict()
          .optional()
          .describe(
            'Only when the owner decided on a home the rules do not list; the reason is in the proposal.',
          ),
        nation: z.string().max(200).optional().describe('The nation it belongs to.'),
        promoteNation: z
          .boolean()
          .optional()
          .describe(
            'With nation: give a compact polity its own [INDEX] in this proposal (its Reference moved in).',
          ),
        createSubindex: z
          .string()
          .max(200)
          .optional()
          .describe('A national subindex to make for it, e.g. "Menkhet Institutions" (its own step).'),
        createCharacterNavigation: z
          .boolean()
          .optional()
          .describe('A new race or racial group: also make its Characters navigation index.'),
        referenceType: identityValue
          .optional()
          .describe('Required (free text, e.g. "Historical Polity Reference").'),
        scope: identityValue.optional().describe('Required: one line of what the page covers.'),
        temporalScope: identityValue.optional().describe('Required: the period it covers.'),
        supersedes: z.string().max(500).optional().describe('Default "None".'),
        specialistTag: z.string().max(100).optional().describe('At most one of the type’s specialist tags.'),
        markdown: z
          .string()
          .max(200_000)
          .optional()
          .describe(
            'The text: “## Purpose” first, then its sections, then Source Boundaries and Unresolved Material.',
          ),
        dependencies: linkList('Current Authoritative owners it depends on'),
        related: linkList('Related Sources'),
        lastMajorRevision: packLmrArg,
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed: () =>
        (packs()?.toolListed('arkona') ?? false) && (arkona()?.rules.owners?.types.length ?? 0) > 0,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) =>
          runOwner(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_create_owner',
            input: {
              type: args.type,
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              name: args.name,
              ...(args.descriptor !== undefined ? { descriptor: args.descriptor } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.continuity !== undefined ? { continuity: args.continuity } : {}),
              home: args.home,
              ...(args.homeOverride !== undefined ? { homeOverride: args.homeOverride } : {}),
              ...(args.nation !== undefined ? { nation: args.nation } : {}),
              ...(args.promoteNation !== undefined ? { promoteNation: args.promoteNation } : {}),
              ...(args.createSubindex !== undefined ? { createSubindex: args.createSubindex } : {}),
              ...(args.createCharacterNavigation !== undefined
                ? { createCharacterNavigation: args.createCharacterNavigation }
                : {}),
              ...(args.referenceType !== undefined ? { referenceType: args.referenceType } : {}),
              ...(args.scope !== undefined ? { scope: args.scope } : {}),
              ...(args.temporalScope !== undefined ? { temporalScope: args.temporalScope } : {}),
              ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
              ...(args.specialistTag !== undefined ? { specialistTag: args.specialistTag } : {}),
              ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
              ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}),
              ...(args.related !== undefined ? { related: args.related } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args,
            lastMajorRevision: args.lastMajorRevision,
          }),
        ),
    }),
    defineTool({
      name: 'arkona_create_relationship',
      title: 'Create an Arkona relationship (pack)',
      access: 'write',
      description:
        'The Arkona pack: ONE joint relationship page for two EXISTING characters (`a`, `b`: names, aliases or ids), named “{a} & {b} - {label}” with both names as their indexes give them, from the AI Relationship template, hosted under `host`’s index (default a), tags COMPUTED (CANON, Character, Relationship), and added to BOTH characters’ Related Sources in the same proposal (a Working relationship is linked from a canon character only after promotion: PARTNER_LINK_DEFERRED says so). A missing character is CHARACTER_NOT_FOUND (make it with arkona_create_character first); a pair that already has one is RELATIONSHIP_EXISTS, naming it. ' +
        'dryRun shows the preview; otherwise ONE proposal for the owner whatever your scope. Never resubmit it: follow it with bridge_proposal_status. ' +
        'Cost: about 14 reads to plan; the job about 40 reads and 15 writes (one write per sidebar row, each participant’s Related Sources, the host index’s routing line).',
      inputSchema: z.object({
        a: z.string().min(1).max(200).describe('One character (name, alias or id); hosts it by default.'),
        b: z.string().min(1).max(200).describe('The other character.'),
        label: z.string().max(100).optional().describe('The name’s last part (default "Relationship").'),
        host: z.enum(['a', 'b']).optional().describe('Whose index holds it (default a).'),
        status: z
          .enum(['working', 'authoritative'])
          .optional()
          .describe('Default: the hosting character’s own (a canon character’s is a canonical proposal).'),
        scope: z.string().max(1000).optional().describe('One line of what the page covers.'),
        markdown: z.string().max(200_000).optional().describe('The text: “## Purpose” first.'),
        dependencies: linkList('Pages it depends on'),
        related: linkList('More Related Sources'),
        lastMajorRevision: packLmrArg,
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed: hasCharacters,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) =>
          runRelationship(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_create_relationship',
            input: {
              a: args.a,
              b: args.b,
              ...(args.label !== undefined ? { label: args.label } : {}),
              ...(args.host !== undefined ? { host: args.host } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.scope !== undefined ? { scope: args.scope } : {}),
              ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
              ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}),
              ...(args.related !== undefined ? { related: args.related } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args,
            lastMajorRevision: args.lastMajorRevision,
          }),
        ),
    }),
    defineTool({
      name: 'arkona_add_character_art',
      title: 'Add art to an Arkona character (pack)',
      access: 'write',
      description:
        'The Arkona pack: adds reference images to an EXISTING character (`character`: name, alias or id): each placed in the character’s asset folder (Characters / race / name, with Forms, Outfits or Details subfolders; folders found or made when the job runs) under a semantic, extension-free name (“{name} - {label}”, numbered if taken), and shown on the character’s Art page with its label and interpretation: the Art page is made when missing, or extended under its “Reference Images” section. Each image needs `interpretation` (what it establishes); a bare image is refused. ' +
        'Sources: `staged_id` (from upload_image { stage: true } with NO destination, which proposes nothing), `upload_id` (prepare_image_upload), or in ChatGPT the attached `file` (for the one image with neither). An upload or file is staged on the bridge’s server first, even on a dry run (its staged_id is in the answer). ' +
        'dryRun shows the preview; otherwise ONE proposal for the owner whatever your scope: nothing reaches LegendKeeper until the owner approves it. Never resubmit it. ' +
        'Cost: 4 to 7 reads to plan; the job about 11 reads and 3 writes for one image on an existing Art page, about 27 and 16 when it makes the Art page.',
      inputSchema: z.object({
        character: z.string().min(1).max(200).describe('An existing character (name, alias or id).'),
        images: z
          .array(
            z
              .object({
                staged_id: z.string().min(1).max(64).optional().describe('A staged image.'),
                upload_id: z.string().min(1).max(64).optional().describe('A prepared binary upload.'),
                label: z
                  .string()
                  .min(1)
                  .max(300)
                  .describe('“{Visual Role} - {Descriptor}”, e.g. “Primary Reference - Character Portrait”.'),
                interpretation: z
                  .string()
                  .max(5000)
                  .optional()
                  .describe('What this reference establishes (required).'),
                subfolder: z
                  .string()
                  .max(300)
                  .nullable()
                  .optional()
                  .describe(
                    '“Forms / <form>”, “Outfits / <outfit>” or “Details”; omit for the character’s folder.',
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(30)
          .describe('The images, each with its label and interpretation.'),
        file: z
          .object({
            download_url: z.string().min(1).max(8192),
            file_id: z.string().min(1).max(256),
            mime_type: z.string().max(200).optional(),
            file_name: z.string().max(500).optional(),
          })
          .strict()
          .optional()
          .describe(
            'In ChatGPT: the attached image (ChatGPT fills this in), for the one image with no other source.',
          ),
        scope: z.string().max(1000).optional().describe('A new Art page’s Scope.'),
        markdown: z
          .string()
          .max(200_000)
          .optional()
          .describe('A new Art page’s text (“## Purpose” first); drafted when left out.'),
        status: z.enum(['working', 'authoritative']).optional().describe('A new Art page’s status.'),
        lastMajorRevision: packLmrArg,
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      meta: { 'openai/fileParams': ['file'] },
      listed: hasCharacters,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) =>
          runArt(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_add_character_art',
            input: {
              character: args.character,
              images: args.images,
              ...(args.file !== undefined ? { file: args.file } : {}),
              ...(args.scope !== undefined ? { scope: args.scope } : {}),
              ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            // A ChatGPT link is a capability that changes with every link: the request's hash names the file by its id.
            args: args.file
              ? {
                  ...args,
                  file: {
                    file_id: args.file.file_id,
                    ...(args.file.file_name ? { file_name: args.file.file_name } : {}),
                  },
                }
              : args,
            lastMajorRevision: args.lastMajorRevision,
          }),
        ),
    }),
    defineTool({
      name: 'arkona_rename',
      title: 'Rename an Arkona character or owner (pack)',
      access: 'write',
      description:
        'Use this whenever a character, culture, race, polity, place or other subject of the Arkona pack is to be renamed (never update_resource, which renames one page and leaves every reference behind, and refuses a subject’s rename with USE_ARKONA_RENAME). It renames the subject (any page of a character’s set, or an owner) EVERYWHERE, as ONE canonical proposal the owner approves whole or item by item: its pages (ids kept: the index, Core or Reference, every “<Old> - …” child, every relationship naming it), its identity facts, the old name kept as an alias (keepOldAsAlias, default true), index routing lines, chronology rows (their events in step), the art folder and asset names, a race’s taxonomy entry, a culture’s or race’s identity token (a NEW pack version the owner approves; the job waits for it) with every character’s fact and tag, and each textual restatement elsewhere, one item each with its sentence. ' +
        'Restatements start unticked inside quotation marks, after “formerly”, “previously”, “once called” or “originally”, under Unresolved Material, or in a chronology row dated before effectiveDate. Archived pages, the Legacy Canon Archive and the Design References are never edited (listed as left as historical); AU pages are included, labelled AU. ' +
        'REVIEW ONLY, never edited and never items (reviewOnly): the old given name, family name and aliases on their own (characters share names; a page in another character’s set with the same part says so) and mentions with a custom label holding the old name (LegendKeeper’s API cannot change a custom label: change it in the app if wanted). Bring them to the owner; a follow-up rename (from) can take specific ones. ' +
        'Name parts are never inferred: when the old name’s given or family part changes, give given and/or family or it is NAME_PARTS_REQUIRED. A token that is not the culture’s or race’s own name needs token. A character’s new name is checked for namesakes (arkona_name_check, the subject left out): an exact full-name match is a NAMESAKE warning in the preview and the proposal’s summary, never a refusal; tell the person. ' +
        'When its job meets another writer part-way, each item is rebased on the fresh content (at most 3 tries); an item whose exact text changed meanwhile is skipped and listed (the owner can propose it again), and the job carries on; only the subject’s own page names and identity facts stop it (resumable). ' +
        'Always a proposal (never direct), whatever your scope; never resubmit it: follow it with bridge_proposal_status. Once its job has ended, report (the rename’s id, proposal or job) lists what is still left of the old name on current pages, the items skipped and the review-only occurrences (free), and gives the follow-up call (from: the old name) that proposes exactly what is left. dryRun shows every item first. ' +
        'Cost (measured on the test fixtures): planning reads one page per page of the set and one per document holding the name, plus 3 for the pack’s governance: 22 reads for a character with seven pages, mentions on six other pages and two chronology rows; its approved job about 130 reads and 47 writes (its check, the writes, the read-back and the change snapshot). A culture with six characters: 13 reads to plan; its job about 73 reads and 20 writes. A conflict met inside a write costs no extra read when the bridge sees it before sending, and one read when LegendKeeper refuses the write (412). dryRun states the plan’s own figures.',
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe(
            'The character (any page of its set) or owner: name, alias, path or id. Not with report.',
          ),
        newName: z.string().min(1).max(200).optional().describe('The new name, as the pages are to show it.'),
        given: z
          .string()
          .max(200)
          .optional()
          .describe('A character’s new given name, when it changes (never inferred).'),
        family: z
          .string()
          .max(200)
          .optional()
          .describe('A character’s new family name, when it changes (never inferred).'),
        keepOldAsAlias: z
          .boolean()
          .optional()
          .describe('Default true: the old name is added to the Aliases fact and the pages’ search aliases.'),
        effectiveDate: z
          .string()
          .max(100)
          .optional()
          .describe('A date of the calendar: chronology rows dated before it start unticked.'),
        token: z
          .string()
          .max(100)
          .optional()
          .describe('A culture’s or race’s new tag token, when its old token is not its name.'),
        from: z
          .string()
          .max(200)
          .optional()
          .describe(
            'A follow-up of an earlier rename: the OLD name, when the subject already has newName (only what is left is planned).',
          ),
        report: z
          .string()
          .max(100)
          .optional()
          .describe('Read-only: a rename’s id, proposal or job: its state and what it left (free).'),
        lastMajorRevision: lastMajorRevisionArg.describe(
          'Last Major Revision of the pages the rename changes: "auto" (default: ADR 0051’s rule, measured when the job runs from what was approved: a name, an alias, a tag or a fact that only swaps the name never counts; 8+ words of restated text, a heading or a chronology row does), "set" or "skip".',
        ),
        dryRun: z.boolean().optional().describe('The full preview; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed: () => packs()?.toolListed('arkona') ?? false,
      handler: (args, mctx) => {
        if (args.report !== undefined)
          return withProject(deps, args.project, 'read', (pd) => renameReport(pd, mctx, args.report!));
        return withProject(deps, args.project, 'write', (pd) => {
          if (args.subject === undefined || args.newName === undefined)
            return errorResult(
              {
                code: 'INVALID_INPUT',
                message: 'Give subject and newName (or report: a rename’s id, proposal or job).',
              },
              pd,
            );
          return runRename(pd, mctx, {
            packId: 'arkona',
            input: {
              subject: args.subject,
              newName: args.newName,
              ...(args.given !== undefined ? { given: args.given } : {}),
              ...(args.family !== undefined ? { family: args.family } : {}),
              ...(args.keepOldAsAlias !== undefined ? { keepOldAsAlias: args.keepOldAsAlias } : {}),
              ...(args.effectiveDate !== undefined ? { effectiveDate: args.effectiveDate } : {}),
              ...(args.token !== undefined ? { token: args.token } : {}),
              ...(args.from !== undefined ? { from: args.from } : {}),
              ...(args.lastMajorRevision !== undefined ? { lastMajorRevision: args.lastMajorRevision } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args,
          });
        });
      },
    }),
    defineTool({
      name: 'arkona_split_owner',
      title: 'Split an Arkona owner page into owners (pack)',
      access: 'write',
      description:
        'Use this, and only this, to split an existing owner page of the Arkona pack (a character monolith, any owner covering several domains): never by hand with write_page and the create tools (write_page refuses removing substantial sections from a pack page with USE_ARKONA_SPLIT). Splitting is a deliberate, owner-approved decision (“do not split merely because a character has many facts”): appraise first with arkona_split_appraisal, bring its candidates, the Anti-Fragmentation note and the questions to the owner, and split only when the owner asks. ' +
        'You give the DESTINATION MAP: every section of the source (and, where a section must be divided, each block id in it: read_document with format "json" shows them) goes to exactly one destination: `new` (a new owner: a character’s page by F3a’s rules, role/title/referenceType, landing in the character’s index; any other owner by F3b’s, type/name/home; each with its scope and purpose), `existing` (an existing owner page; the material is appended under the heading you give, `under`), `relationship` (an existing relationship page, or a new one `with` the other character), `stays`, or `universal` (material an existing universal owner already owns, e.g. a magic rule: NOT migrated; give `owner` and the subject-specific application `text` that replaces it; the universal owner becomes a Dependency). ' +
        'Refused before anything is proposed: a block unassigned or assigned twice (SPLIT_COVERAGE, with the list), a section listed twice (SPLIT_DUPLICATED_AUTHORITY), images going to a page that is not an Art or visual owner (SPLIT_VISUAL), content LegendKeeper cannot create (unsupported blocks only stay), a missing interface summary for a moved section when the source survives (SPLIT_SUMMARY_REQUIRED), when the source is to be retired, any page depending on it not remapped (`dependencies`: each page to the new owner it actually needs; SPLIT_DEPENDENCIES_UNMAPPED), and a map that would leave a character with an index and several owners but no Character Core (SPLIT_CORE_REQUIRED: upgrade its Compact Character Reference first with arkona_create_character, target and upgradeToCore). A Compact Character Reference split into several owners becomes the character’s Character Core in the same proposal (renamed “<Name> - Character Core”, Reference Type Character Core; its id, text and identity facts kept). A section about one other character not going to a relationship owner is a warning for the owner. ' +
        'Completeness (each NEW owner): when the source has Source Boundaries or Unresolved Material, each new owner the pack expects to carry them (a Core, a Compact Reference, a relationship owner, any other owner; not an Art or specialist page, unless the pack names its Reference Type) addresses each, by items of it moved there (they go under that heading), by your text (sourceBoundaries, unresolvedMaterial), or notApplicable { section: reason }; otherwise SPLIT_SECTIONS_UNADDRESSED. The bridge never writes these sections itself. Its Dependencies start from the source’s own (suggested in the plan; keep those it relies on); an empty list needs noDependencies { reason } (SPLIT_DEPENDENCIES_UNADDRESSED). The owner reads every reason in the proposal, and nextSteps lists what is still owed afterwards, each with its tool. ' +
        'Always ONE canonical proposal, whatever your scope; never resubmit it, follow it with bridge_proposal_status. The owner approves it whole or destination by destination: a destination left out keeps its sections in the source. Phase 1 (one job) makes and extends the owners with the blocks moved verbatim (ids kept), checks every destination holds them BEFORE anything leaves the source, writes the interface summaries, index lines and remapped Dependencies, and verifies (a re-read of every page touched); a failure stops it before phase 2 (Resume and Revert stay available). With `retire: true`, once phase 1 has verified the bridge proposes archiving the source (archive_page): a separate canonical proposal. The split never deletes the source. `report` (the split’s id, proposal or job) says what became of it (free), and `verified` is its job’s own verification (a job that ran to its end but read back a difference is `unverified`, and nothing is retired). dryRun shows the whole plan first. ' +
        'Cost, measured on the test fixtures: a character monolith (a Compact Character Reference, upgraded to its Core) split into six new owners (and a new index for them) with one remapped Dependency: 26 requests to propose (10 of them the plan’s reads), then a job of 248 requests (89 writes); an owner split into one new owner and one existing owner with two remapped Dependencies: 12 to propose, then 84 (22 writes), then phase 2 is archive_page’s own cost. A conflict on an existing owner’s append costs one more read and the write again. dryRun states the plan’s reads as made and its estimate of the job (the writes exactly, the reads within about a tenth).',
      inputSchema: z.object({
        source: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('The owner page to split (name, alias, path or id).'),
        retire: z
          .boolean()
          .optional()
          .describe(
            'Archive the source once phase 1 has verified (a separate proposal). Default false: it survives.',
          ),
        destinations: z
          .array(
            z
              .object({
                key: z.string().min(1).max(60).describe('The name the map uses for it.'),
                kind: z.enum(['new', 'existing', 'relationship', 'universal']),
                role: z
                  .string()
                  .max(40)
                  .optional()
                  .describe('A new page of a character’s set: its F3a role (specialist, art).'),
                title: z
                  .string()
                  .max(200)
                  .optional()
                  .describe('A specialist page’s title (its name is “<Name> - <title>”).'),
                referenceType: z.string().max(200).optional(),
                specialistTag: z.string().max(100).optional(),
                type: z
                  .string()
                  .max(100)
                  .optional()
                  .describe('A new owner of another page: its owner type (F3b).'),
                name: z
                  .string()
                  .max(200)
                  .optional()
                  .describe('A new owner of another page: its Subject (F3b).'),
                descriptor: z.string().max(200).optional(),
                home: z
                  .string()
                  .max(500)
                  .optional()
                  .describe('A new owner of another page: its home index (F3b).'),
                homeOverride: z.object({ reason: z.string().min(1).max(500) }).optional(),
                nation: z.string().max(200).optional(),
                temporalScope: z.string().max(500).optional(),
                scope: z.string().max(1000).optional().describe('A new owner’s Scope (required).'),
                purpose: z
                  .string()
                  .max(20_000)
                  .optional()
                  .describe('A new owner’s Purpose (Markdown; required).'),
                dependencies: z
                  .array(z.string().max(500))
                  .max(50)
                  .optional()
                  .describe(
                    'A new owner’s Dependencies: start from the source’s own (dryRun lists them, completeness.suggestedDependencies) and keep those it relies on. None at all needs noDependencies.',
                  ),
                noDependencies: z
                  .object({ reason: z.string().min(1).max(500) })
                  .optional()
                  .describe('A new owner with no Dependencies: why (shown to the owner in the proposal).'),
                sourceBoundaries: z
                  .string()
                  .max(20_000)
                  .optional()
                  .describe(
                    'A new owner’s Source Boundaries, in your words (Markdown; the heading is added when it has none). Follows any items of the section moved to it.',
                  ),
                unresolvedMaterial: z
                  .string()
                  .max(20_000)
                  .optional()
                  .describe('A new owner’s Unresolved Material, as sourceBoundaries.'),
                notApplicable: z
                  .object({
                    sourceBoundaries: z.string().min(1).max(500).optional(),
                    unresolvedMaterial: z.string().min(1).max(500).optional(),
                  })
                  .strict()
                  .optional()
                  .describe(
                    'A section that does not apply to a new owner, with the reason (shown to the owner in the proposal).',
                  ),
                related: z.array(z.string().max(500)).max(50).optional(),
                page: z
                  .string()
                  .max(500)
                  .optional()
                  .describe('An existing (or existing relationship) owner page.'),
                under: z.string().max(200).optional().describe('The heading the material goes under there.'),
                with: z
                  .string()
                  .max(200)
                  .optional()
                  .describe('A new relationship owner: the other character.'),
                label: z.string().max(100).optional(),
                owner: z
                  .string()
                  .max(500)
                  .optional()
                  .describe('Universal: the universal owner it belongs to.'),
                text: z
                  .string()
                  .max(20_000)
                  .optional()
                  .describe('Universal: the subject-specific application text.'),
                in: z
                  .string()
                  .max(60)
                  .optional()
                  .describe('Universal: where the application text goes: “source”, or a destination’s key.'),
              })
              .strict(),
          )
          .min(1)
          .max(40)
          .optional(),
        map: z
          .array(
            z
              .object({
                section: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe('A heading’s text or block id; “(preamble)” before the first.'),
                to: z.string().max(60).optional().describe('A destination’s key, or “stays”.'),
                blocks: z
                  .array(
                    z
                      .object({
                        ids: z.array(z.string().min(1).max(100)).min(1).max(500),
                        to: z.string().min(1).max(60),
                        summary: z.string().max(5000).optional(),
                        under: z.string().max(200).optional(),
                      })
                      .strict(),
                  )
                  .max(100)
                  .optional()
                  .describe('The section divided block by block (every block of it in exactly one group).'),
                summary: z
                  .string()
                  .max(5000)
                  .optional()
                  .describe(
                    'The interface summary the source keeps in its place (Markdown; an exact link is added).',
                  ),
                under: z.string().max(200).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(300)
          .optional(),
        dependencies: z
          .array(
            z
              .object({
                page: z.string().min(1).max(500),
                to: z.string().min(1).max(60),
                keepSource: z.boolean().optional(),
              })
              .strict(),
          )
          .max(200)
          .optional()
          .describe(
            'Pages that depend on the source, each remapped to the destination it actually needs (D5).',
          ),
        report: z
          .string()
          .max(100)
          .optional()
          .describe('Read-only: a split’s id, proposal or job: what became of it (free).'),
        lastMajorRevision: lastMajorRevisionArg.describe(
          'Last Major Revision of the existing pages the split changes: "auto" (default: ADR 0051’s rule per page, measured when the job runs; moved material counts on the source and on an owner it is appended to), "set" or "skip". New pages are always dated.',
        ),
        dryRun: z.boolean().optional().describe('The full plan; nothing written or proposed.'),
        preview: z.boolean().optional().describe('The same as dryRun.'),
        operation_id: operationIdArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed: () => (packs()?.toolListed('arkona') ?? false) && arkona()?.rules.splits !== undefined,
      handler: (args, mctx) => {
        if (args.report !== undefined)
          return withProject(deps, args.project, 'read', (pd) => splitReport(pd, mctx, args.report!));
        return withProject(deps, args.project, 'write', (pd) => {
          if (args.source === undefined || !args.destinations || !args.map)
            return errorResult(
              {
                code: 'INVALID_INPUT',
                message: 'Give source, destinations and map (or report: a split’s id, proposal or job).',
              },
              pd,
            );
          return runSplit(pd, mctx, {
            packId: 'arkona',
            input: {
              source: args.source,
              ...(args.retire !== undefined ? { retire: args.retire } : {}),
              destinations: args.destinations,
              map: args.map,
              ...(args.dependencies ? { dependencies: args.dependencies } : {}),
              ...(args.lastMajorRevision !== undefined ? { lastMajorRevision: args.lastMajorRevision } : {}),
            },
            dryRun: args.dryRun === true || args.preview === true,
            operationId: args.operation_id,
            args,
          });
        });
      },
    }),
    defineTool({
      name: 'arkona_character_brief',
      title: 'Brief on an Arkona character (pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: who a character is before you work on them (Character Architecture’s “remind the user who is under discussion”; arkona_brief answers for any subject and hands a character to this tool): the six identity fields, every owner page of their set with its Reference Type and Scope, their relationships, Art pages and image counts, open audit findings, and Unresolved Material headings, each with how fresh it is. ' +
        'Read from the bridge’s own tree, snapshots and audits: free (no LegendKeeper read). live: true re-reads the identity page’s sidebar (one read) for the six fields. Its consistency line lists open contradictions on their dates and identity facts; to write about them at a date, arkona_as_of first. ' +
        'Cost: none; 1 read with live: true.',
      inputSchema: z.object({
        character: z.string().min(1).max(200).describe('A character (name, alias or id).'),
        live: z.boolean().optional().describe('Re-read the identity fields now (one read).'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed: hasCharacters,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', (pd) =>
          characterBrief(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_character_brief',
            character: args.character,
            live: args.live === true,
          }),
        ),
    }),
  ];
}
