/**
 * The setting packs' tools (v3 F3a, ADR 0050; PLAN-v2 section 10). Each carries its pack's prefix, is listed only while
 * its pack is attached to a project the bridge serves, and refuses any project its pack is not attached to. F3a has one:
 * `arkona_create_character`, the Arkona pack's Character type, with the package of the owner-approved design
 * (docs/design/F3-character-pack.md, section 3). The engine behind it is the pack's (src/packs), driven by its data.
 */
import * as z from 'zod';
import { runPackage } from '../../packs/run.js';
import type { PackageInput } from '../../packs/engine/plan.js';
import type { McpToolProvider } from '../server.js';
import { defineTool } from './define.js';
import { CREATE_ANNOTATIONS, operationIdArg } from './resources.js';
import { errorResult, projectArg, withProject, type ToolDeps } from './shape.js';

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
  const typesOf = () =>
    deps.services?.packs
      ?.get(packId)
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
      listed: () => (deps.services?.packs?.toolListed(packId) ?? false) && typesOf().length > 0,
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

/** The explicit pack tools (their own schemas): `arkona_create_character`. */
export const EXPLICIT_PACK_TOOLS: ReadonlySet<string> = new Set(['arkona_create_character']);

export function packTools(deps: ToolDeps): McpToolProvider[] {
  const packs = () => deps.services?.packs;
  return [
    defineTool({
      name: 'arkona_create_character',
      title: 'Create an Arkona character (pack)',
      access: 'write',
      description:
        'The Arkona pack: builds a whole character from ONE package by Arkona’s rules: the right set of linked pages (only the domains you give), each from its template, named, placed under its race, its sidebar filled in template order, its tags COMPUTED (never typed), links resolved, images placed, then verified. Use it instead of separate creates for a new character, and with `target` to add new pages to an existing one (its name, alias or id). ' +
        'depth "compact": one Character Reference; "developed": an [INDEX] with a Character Core. status "working" (default): a Working set to promote later; "authoritative": canon. The six identity fields (givenName, surname, race, namingCulture, lifeState, temporalScope) are required: if one is unknown, ASK THE OWNER, never guess ("Unestablished" only with a reason the owner gave). ' +
        'dryRun shows the full preview (pages, facts, tags, links, folders, every dash replaced, refusals and warnings) and writes nothing: preview first. Otherwise it is ONE proposal for the owner, whatever your scope; never resubmit it, follow it with bridge_proposal_status. A refusal names the fix. ' +
        'Example: { "name": "Asagiri Ren", "depth": "compact", "identity": { "givenName": "Ren", "surname": "Asagiri", "race": "Foxian", "namingCulture": "Fujimatsuan", "lifeState": "Alive", "temporalScope": "5A 931" }, "pages": [{ "role": "compact", "scope": "Shrine guard", "markdown": "## Purpose\\n…" }], "dryRun": true, "project": "test" }. ' +
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
          });
        }),
    }),
  ];
}
