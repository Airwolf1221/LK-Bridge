/**
 * `create_character` (v2 C2b, ADR 0034; PLAN-v2 section 5 and section 9, the old bridge's rules) on A3's
 * `planCharacterPlacement`:
 *
 * - **Core**: an existing unique `[INDEX] {name}` under the race index is reused, else made from the Index template;
 *   then `{name} - Character Core` (the type's page-name pattern) beneath it from the Core template.
 * - **Compact**: `{name} - Character Reference` directly under the race index, with no index of its own.
 * - An existing Core or Reference is returned, not duplicated (with a note).
 * - The identity facts in the same job: Reference Type (exactly the type's), Subject and Canonical Display Name (the
 *   name), Race / Species (exactly as given, or `Unestablished` for an unknown or omitted race), Status `Working`, then
 *   the caller's facts and links.
 * - An unknown or omitted race goes to `[INDEX] Undetermined / Unknown`; a declared race that does not resolve fails.
 *   Nothing is ever automatic: no race or classification index is made, nothing is moved or reclassified, no tag is
 *   inferred.
 * - Two overlapping requests for one character (same name without case, prefixes or extra spaces), from any
 *   connection, are duplicates: the second is refused with DUPLICATE_REQUEST naming the first's job or proposal.
 */
import * as z from 'zod';
import { RegistryError } from '../../registry/index.js';
import type { McpToolProvider } from '../server.js';
import {
  STATUS_DESCRIPTION,
  characterClaim,
  createCtx,
  newPage,
  planNewPageFacts,
  statusValue,
  withRequest,
  withStatusTag,
  workingIndex,
  type CreateOutcome,
  type CreateStatus,
  type NewPage,
} from './create-support.js';
import { factsVersionOfRead } from './discover.js';
import { defineTool } from './define.js';
import { liveRead, registryError, repoContext } from './repo.js';
import { CREATE_ANNOTATIONS, factsArg, finishCreate, linksArg, operationIdArg } from './resources.js';
import { projectArg, render, withProject, type ToolDeps } from './shape.js';

export function createCharacterTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'create_character',
    title: 'Create a character',
    access: 'write',
    description:
      'Creates a character’s pages by fixed rules: kind "core" (an [INDEX] {name} with a Character Core under it) or "compact" (one Character Reference page, no index). `status` "working" (default): under [INDEX] Working as [BWRK]; the character goes under its race only when promoted. "authoritative": under its race as [BSRC]: canon, so always a proposal the owner accepts as canon. TO BUILD A WORKING CHARACTER: create_character (core, Working) first, then create_resource (Working) for each specialist page (Art, Relationship, …) with `parent` = the character’s [INDEX]; promote_page with subtree: true later promotes the whole set in one approval. An existing Core or Reference is returned, not duplicated. The bridge sets Reference Type, Subject, Canonical Display Name, Race / Species (as you give it) and Status, then your `facts` and `links`. A `race` that is unknown or omitted goes to Undetermined / Unknown; a race that does not resolve is refused (never created or guessed): ask the person. Two requests for the same character at once are refused (DUPLICATE_REQUEST: follow the first). dryRun shows the plan. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Example: { "kind": "core", "name": "Asagiri Ren", "race": "Foxian", "facts": { "Scope": "Shrine guard" }, "project": "test" }. Cost: about 11 reads and 9 writes (a compact page 8 and 7; an existing page 1 and 0).',
    inputSchema: z.object({
      kind: z
        .enum(['core', 'compact'])
        .describe('core: index + Character Core; compact: a Character Reference only.'),
      name: z.string().min(1).max(200).describe('The character’s name (no prefix).'),
      race: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe(
          'The race or species, as the taxonomy knows it (plural, singular or alias). Omitted or unknown: Undetermined / Unknown.',
        ),
      type: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('The character type, when the project has more than one.'),
      status: z.enum(['working', 'authoritative']).optional().describe(STATUS_DESCRIPTION),
      facts: factsArg,
      links: linksArg,
      dryRun: z.boolean().optional().describe('Show the plan; write nothing.'),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const name = args.name.trim();
        return withRequest(
          pd,
          mctx,
          'create_character',
          args,
          { key: characterClaim(name), label: `the character “${name}”` },
          async (): Promise<CreateOutcome> => {
            const cc = createCtx(pd, mctx, ctx, 'create_character');
            const status: CreateStatus = args.status ?? 'working';
            // v2 C2c: a Working character's set goes under [INDEX] Working (it must be confirmed).
            let working: { indexId: string } | undefined;
            let lookUnder: string | undefined;
            if (status === 'working') {
              const wi = workingIndex(cc);
              if (!wi.ok) return { kind: 'answer', result: wi.result };
              working = { indexId: wi.value.id };
            } else {
              // An Authoritative request still finds (and returns) a Working page of the character.
              const wi = workingIndex(cc);
              if (wi.ok) lookUnder = wi.value.id;
            }
            let plan;
            try {
              plan = ctx.types.planCharacterPlacement({
                characterName: name,
                race: args.race ?? null,
                kind: args.kind,
                ...(args.type !== undefined ? { type: args.type } : {}),
                ...(working ? { working } : {}),
                ...(lookUnder ? { lookUnder } : {}),
              });
            } catch (e) {
              if (e instanceof RegistryError) return { kind: 'answer', result: registryError(e, ctx) };
              throw e;
            }
            const head = {
              character: plan.characterName,
              kind: plan.kind,
              type: plan.type.singular,
              race: {
                given: plan.race.given,
                ...(plan.race.unknown ? { unknown: true } : {}),
                ...(plan.race.entry ? { matched: plan.race.entry.plural, by: plan.race.matchedBy } : {}),
                index: plan.raceIndex.rawName,
              },
              species: { [plan.species.row]: plan.species.value },
              lifecycleStatus: status,
              ...(plan.working ? { placedUnder: plan.home.rawName } : {}),
              ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            };
            if (plan.page.action === 'return_existing') {
              const existing = plan.page.node;
              const read = await liveRead(pd, mctx, 'create_character', 'getResource', {
                path: { resourceId: existing.id },
              });
              if (!read.ok) return { kind: 'answer', result: read.result };
              const body = {
                ...head,
                status: 'existing',
                page: { id: existing.id, name: existing.rawName, path: existing.path },
                factsVersion: factsVersionOfRead(ctx, existing.id, read.value),
                note:
                  `${plan.kind === 'core' ? 'A Character Core' : 'A Compact Character Reference'} for “${plan.characterName}” already exists; ` +
                  'it was returned and nothing was created. Change it with set_facts and write_page' +
                  (existing.kind === 'bwrk' ? '; it is Working: promote_page makes it Authoritative.' : '.'),
              };
              return { kind: 'answer', result: render(body, pd), final: body };
            }
            const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
            const refRow =
              typeof settings.treeReferenceTypeRow === 'string'
                ? settings.treeReferenceTypeRow
                : 'Reference Type';
            const cdnRow =
              typeof settings.treeCanonicalNameRow === 'string'
                ? settings.treeCanonicalNameRow
                : 'Canonical Display Name';
            const type = ctx.types.store.typeByName(plan.type.singular);
            const subjectRow = type?.placement?.subjectRow ?? 'Subject';
            const pages: NewPage[] = [];
            let indexPage: NewPage | null = null;
            const ci = plan.characterIndex;
            if (ci?.action === 'create') {
              const p = newPage({
                key: 'index',
                rawName: ci.rawName,
                parent: { existing: ci.parentId },
                templateId: ci.templateId,
                facts: null,
                parentName: plan.home.rawName,
                templateName: `the ${plan.type.singular} Index template`,
                status: null,
              });
              const f = await planNewPageFacts(cc, {
                pageId: p.id,
                pageName: p.rawName,
                templateId: ci.templateId,
                status: null,
                what: p.rawName,
              });
              if (!f.ok) return { kind: 'answer', result: f.result };
              indexPage = { ...p, facts: f.value };
              pages.push(indexPage);
            }
            const pg = plan.page;
            const parentName =
              ci?.action === 'create'
                ? ci.rawName
                : ci?.action === 'reuse'
                  ? ci.node.rawName
                  : plan.home.rawName;
            const page = newPage({
              key: 'page',
              rawName: pg.rawName,
              parent: indexPage
                ? { item: 'index' }
                : { existing: ci?.action === 'reuse' ? ci.node.id : (pg.parentId ?? plan.home.id) },
              templateId: pg.templateId,
              facts: null,
              parentName,
              templateName: `the ${plan.type.singular} ${pg.templateRole === 'core' ? 'Core' : 'Compact'} template`,
              status,
            });
            const f = await planNewPageFacts(cc, {
              pageId: page.id,
              pageName: page.rawName,
              templateId: pg.templateId,
              identity: [
                { key: refRow, value: pg.referenceType },
                { key: subjectRow, value: plan.characterName },
                { key: cdnRow, value: plan.characterName },
                { key: plan.species.row, value: plan.species.value },
              ],
              ...(args.facts ? { facts: args.facts } : {}),
              ...(args.links ? { links: args.links } : {}),
              status: statusValue(cc.lifecycle, status),
              what: page.rawName,
            });
            if (!f.ok) return { kind: 'answer', result: f.result };
            const tags = withStatusTag(cc.lifecycle, cc.templateTags.get(pg.templateId) ?? [], status);
            pages.push({ ...page, facts: f.value, tags });
            return finishCreate(cc, pages, {
              batch: false,
              dryRun: args.dryRun === true,
              extraHead: {
                ...head,
                ...(ci?.action === 'reuse'
                  ? { characterIndex: { reused: ci.node.rawName, id: ci.node.id } }
                  : {}),
              },
              // v2 C2c: a Working character's own index under [INDEX] Working is part of the lifecycle change.
              ...(indexPage && plan.working ? { markerPages: [{ id: indexPage.id, to: null }] } : {}),
              summary: `create_character: ${page.rawName}${indexPage ? ` (with ${indexPage.rawName})` : ''} under ${plan.home.rawName}`,
            });
          },
        );
      }),
  });
}
