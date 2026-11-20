/**
 * The Arkona pack's free read tools of v3 F4a (ADR 0063), each read-only (Repository Automation's Default Boundary:
 * report, never repair) and listed while the pack is attached to a project the bridge serves:
 *
 * - `arkona_name_check`: namesakes among the current characters (full name in either order, given name, surname,
 *   aliases) and, for a naming culture, its culture owner's naming sections and the characters recorded with it. Part of
 *   every character intake and rename; it never suggests or infers a culture, race or nationality from a name.
 * - `arkona_brief`: the brief on any subject (a nation, polity, culture, religion, place, event, magic system, item…):
 *   its owners, their Dependencies one level, Source Boundaries and Unresolved Material, Related Sources, chronology
 *   rows, work in progress, open findings and how fresh each is, every item labelled by lifecycle. The first step for a
 *   question about a subject; a character delegates to `arkona_character_brief`.
 */
import * as z from 'zod';
import { nameCheck } from '../../packs/naming/check.js';
import { topicBrief } from '../../packs/topic-brief.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { projectArg, withProject, type ToolDeps } from './shape.js';

export function arkonaReadTools(deps: ToolDeps): McpToolProvider[] {
  const packs = () => deps.services?.packs;
  const listed = () => packs()?.toolListed('arkona') ?? false;
  const hasCharacters = () =>
    listed() &&
    (packs()
      ?.get('arkona')
      ?.rules.types.some((t) => t.hook === 'character') ??
      false);
  return [
    defineTool({
      name: 'arkona_name_check',
      title: 'Check a character name for namesakes and its naming culture (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only and free: part of EVERY character intake and rename (Character Architecture’s naming-culture review). Characters share names: give the name (and its parts and aliases when known) to list the current characters (Authoritative, Working and AU, each labelled) sharing the full name, the given name, the surname or an alias, each with the page holding their identity, their Naming Culture and Life State, and what matched. Names are compared without case, accents or prefixes, and a full name in either order (“Asagiri Miyabi” finds “Miyabi Asagiri”). An exact full-name match is a warning, a partial one info; nothing is ever refused, since names may be shared. ' +
        'With namingCulture: its culture owner under Arkonan Cultures (through the pack’s culture map), that owner’s naming sections, and the characters recorded with that culture and their names, for consistency; an unmapped culture is said so. exclude leaves a character out (the one being renamed). ' +
        'It NEVER suggests or infers a naming culture, race or nationality from a name, surname or etymology, and never proposes a rename: bring what it reports to the owner and ask. arkona_create_character and arkona_rename run the namesake part themselves. ' +
        'Cost: none (the bridge’s tree, stored sidebars and snapshots).',
      inputSchema: z.object({
        name: z.string().min(1).max(200).optional().describe('The full name, as it is or will be shown.'),
        givenName: z.string().min(1).max(200).optional().describe('The given (personal) name, when known.'),
        surname: z.string().min(1).max(200).optional().describe('The family name, when known.'),
        aliases: z.array(z.string().min(1).max(200)).max(20).optional().describe('Other names it goes by.'),
        namingCulture: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('A Naming Culture value the owner gave (never one guessed from the name).'),
        exclude: z
          .array(z.string().min(1).max(300))
          .max(20)
          .optional()
          .describe('Characters (names or ids) left out: the one being renamed is not its own namesake.'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe('"full": up to 200 namesakes and members, and longer naming sections.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed: hasCharacters,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', (pd) =>
          nameCheck(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_name_check',
            input: {
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.givenName !== undefined ? { givenName: args.givenName } : {}),
              ...(args.surname !== undefined ? { surname: args.surname } : {}),
              ...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
              ...(args.namingCulture !== undefined ? { namingCulture: args.namingCulture } : {}),
              ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
            },
            full: args.detail === 'full',
          }),
        ),
    }),
    defineTool({
      name: 'arkona_brief',
      title: 'Brief on any Arkona subject (pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: the FIRST step for a question about any subject (a nation, polity, culture, religion, place, event, magic system, item or character), before search and read_document: one free call instead of reading five pages (Project Navigation’s smallest sufficient retrieval). `subject` resolves to its owner (an [INDEX] and the pages directly in it, or a single owner page), each with its lifecycle (Authoritative, Working, Archived, AU), Reference Type, Scope, Last Major Revision and tags; its Dependencies one level (a Dependency on a Working or Archived page is flagged) and the count of incoming Dependencies; its Source Boundaries and Unresolved Material (long sections cut with a handle for bridge_result_page); its Related Sources; the chronology rows naming it or an alias, with KCY and age table; Working pages that mention or depend on it, and pending proposals touching its pages; its open audit findings; and how fresh each source is. ' +
        'EVERY item is labelled by lifecycle: never treat Working material as canon, and never merge them. The Legacy Canon Archive and the Design References are left out unless include names them. A name meaning several subjects is refused with the candidates: pass the id. A character is briefed by arkona_character_brief (delegated). Then read only what the brief points to. ' +
        'Cost: none (the bridge’s tree, snapshots, chronology, proposals and findings); live: true re-reads the head owner’s sidebar (1 read).',
      inputSchema: z.object({
        subject: z.string().min(1).max(300).describe('The subject: a name, alias, path or id.'),
        include: z
          .array(z.enum(['legacy', 'design']))
          .max(2)
          .optional()
          .describe('Bring in the Legacy Canon Archive (legacy) or the Design References (design).'),
        live: z.boolean().optional().describe('Re-read the head owner’s sidebar now (one read).'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe(
            '"full": longer lists (100 an owner) and longer section text (cut at 20,000 characters).',
          ),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', (pd) =>
          topicBrief(pd, mctx, {
            packId: 'arkona',
            tool: 'arkona_brief',
            input: {
              subject: args.subject,
              live: args.live === true,
              include: args.include ?? [],
              full: args.detail === 'full',
            },
          }),
        ),
    }),
  ];
}
