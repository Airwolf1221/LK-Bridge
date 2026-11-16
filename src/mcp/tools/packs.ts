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
import { projectArg, withProject, type ToolDeps } from './shape.js';

const identityValue = z.union([
  z.string().max(500),
  z
    .object({
      value: z.string().max(500),
      reason: z.string().max(2000).optional().describe('Required when value is "Unestablished": why it is open.'),
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
      .describe('“{Visual Role} - {Descriptor}”, e.g. “Primary Reference - Character Portrait”; no file extension.'),
    interpretation: z.string().min(1).max(5000).describe('What this reference establishes (required).'),
    subfolder: z
      .string()
      .max(300)
      .nullable()
      .optional()
      .describe('“Forms / <named form>”, “Outfits / <named outfit>” or “Details”; omit for the character’s folder.'),
  })
  .strict();

const page = z
  .object({
    role: z
      .string()
      .min(1)
      .max(40)
      .describe('core | compact | specialist | art | relationship (only the domains with real content).'),
    title: z.string().max(200).optional().describe('specialist: the domain, e.g. "Biography" (name “{Name} - {title}”).'),
    referenceType: z.string().max(200).optional().describe('specialist: its Reference Type (a suggestion is offered).'),
    specialistTag: z
      .string()
      .max(100)
      .optional()
      .describe(
        'specialist: at most one of Biography, Personality, Relationship, Character Art, Visual Reference, Wardrobe, Magic, Equipment.',
      ),
    scope: z.string().max(1000).optional().describe('The Scope row: one line of what the page covers.'),
    markdown: z.string().max(200_000).optional().describe('The page text: “## Purpose” first (no title, no metadata).'),
    dependencies: z.array(z.string().max(500)).max(50).optional().describe('Pages it depends on (names or ids).'),
    related: z.array(z.string().max(500)).max(50).optional().describe('Related Sources (names or ids).'),
    images: z.array(image).max(30).optional().describe('art: the staged images, each with its interpretation.'),
    with: z.string().max(200).optional().describe('relationship: the other character (name or id).'),
    label: z.string().max(100).optional().describe('relationship: the label (default "Relationship").'),
    host: z.enum(['self', 'other']).optional().describe('relationship: whose index holds it (default self).'),
  })
  .strict();

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
        'Cost: about 6 reads to plan (3 of them the pack’s governance); the job about 8 reads and 6 writes per page, plus 4 writes per image.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('The character’s Canonical Display Name (no prefix).'),
        depth: z.enum(['compact', 'developed']).optional().describe('compact: a Reference; developed: index and Core.'),
        status: z
          .enum(['working', 'authoritative'])
          .optional()
          .describe('working (default for a new character): a Working set; authoritative: canon (a canonical proposal).'),
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
        split: z.unknown().optional().describe('Not supported: splitting an existing page is refused (a later tool).'),
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
            args: args as Record<string, unknown>,
          });
        }),
    }),
  ];
}
