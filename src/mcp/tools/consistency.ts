/**
 * v3 F4b (ADR 0064; the owner-approved design docs/design/F4b-consistency-and-as-of.md): the Arkona pack's consistency
 * check and "as of a date", listed while the pack is attached:
 *
 * - `arkona_consistency` (D1 to D5): dates of life events and identity facts restated differently across pages, each
 *   labelled by the owner's evidence classes (Contradictory, Proposal differs from canon, Gap); free; a run is stored
 *   and read a page at a time with its `runId`. It never decides which side is right;
 * - `arkona_as_of` (D7, D9, D10): characters at a date: born, elapsed calendar years (never apparent age), the state
 *   recorded, the chronology rows around it, and any open contradiction on the birth or death; free;
 * - `arkona_as_of_coverage` (D8): how many characters have a birth the engine can read, a recorded death, attested
 *   bounds, or none; a report, never a task list;
 * - `arkona_consistency_suggest` (D6): an agent suggests a value for a finding; the owner sees it on the dashboard. An
 *   agent can never pick: the owner's pick ("Pick the right value") is the only way a fix is proposed.
 */
import * as z from 'zod';
import { ConsistencyError, MAX_AS_OF } from '../../consistency/service.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { answer, liveReader } from './appraisal.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { finish, repoContext, resolvePage } from './repo.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';

const GROUPS = ['contradictory', 'differs', 'gaps', 'historical', 'unreadable'] as const;
const include = z
  .array(z.enum(['archived', 'legacy', 'design', 'pre-rewrite']))
  .max(4)
  .optional()
  .describe(
    'Bring in Archived pages (archived), the Legacy Canon Archive (legacy), the Design References (design) or sections and chronology rows marked pre-rewrite or author-facing (pre-rewrite, labelled Historical material differs): left out by default.',
  );
const continuity = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    '“Main CANON” (the default), or an AU’s name (its Continuity): AU pages are compared only within their AU.',
  );

function refusal(e: unknown, pd: ProjectDeps): McpToolResult {
  if (e instanceof ConsistencyError)
    return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
  return errorFromThrown(e, pd);
}

function service(pd: ProjectDeps) {
  const c = pd.services?.consistency;
  if (!c)
    return {
      ok: false as const,
      result: errorResult(
        { code: 'TOOL_UNAVAILABLE', message: 'The consistency check is not available here.' },
        pd,
      ),
    };
  return { ok: true as const, c };
}

const actorOf = (mctx: McpToolContext, tool: string): string =>
  mcpOrigin(mctx, tool).principal?.principalId ?? 'agent';

export function consistencyTools(deps: ToolDeps): McpToolProvider[] {
  const packs = () => deps.services?.packs;
  const listed = () =>
    (packs()?.toolListed('arkona') ?? false) && packs()?.get('arkona')?.rules.consistency !== undefined;
  return [
    defineTool({
      name: 'arkona_consistency',
      title: 'Find dates and identity facts restated differently (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only and free: run it BEFORE changing a date (a birth, a death, a chronology row) or an identity fact. For one subject (a character), a branch (under) or everything (all): births, deaths and identity facts (Race / Species, Naming Culture, Life State, Personal / Given Name, Family / Surname) that the subject’s identity page (its Core or Compact Reference) states one way and another page restates another, and chronology rows whose date differs from the same event on a page they mention. Dates are read by the calendar engine with their precision; two values conflict only when they cannot both be true (“4A 100” and “Camue 1st, 4A 100” agree; a “c.” date has a margin of years). ' +
        'Each finding shows the identity page’s value first, then each disagreeing restatement with its page, lifecycle, section, excerpt and precision, labelled Contradictory (Authoritative against Authoritative), Proposal differs from canon (Working), Gap (“Unestablished” against a value: never a conflict) or Unreadable. It NEVER decides which side is right: tell the owner, who picks the value on the dashboard; you may suggest one with arkona_consistency_suggest. Only the pack’s phrasings are read: a sentence about someone is read only when the name governing its verb is theirs (never a pronoun, never another name in the sentence). Archived pages, the Legacy Canon Archive, the Design References and sections or chronology rows marked pre-rewrite are left out unless include names them. ' +
        'A long run is stored: page through it with runId and offset. Cost: none (the bridge’s snapshots, full-text index, chronology tables and calendar); live: true re-reads the identity pages’ sidebars (1 read each, at most 25).',
      inputSchema: z.object({
        subject: z.string().min(1).max(300).optional().describe('A character: a name, alias, page or id.'),
        under: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('A branch: the characters whose identity page is under this page.'),
        all: z.boolean().optional().describe('Every current character.'),
        include,
        continuity,
        live: z.boolean().optional().describe('Re-read the identity pages’ sidebars now (one read each).'),
        runId: z
          .string()
          .regex(/^apr_[0-9a-f]{16}$/)
          .optional()
          .describe('Read a stored run again, a page at a time: nothing is re-run.'),
        group: z.enum(GROUPS).optional().describe('Only this label’s findings.'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Findings per answer. Default 50.'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe('"full" adds each finding’s values (the identity page’s and every restatement’s).'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          const tool = 'arkona_consistency';
          const paging = { group: args.group, offset: args.offset, limit: args.limit, detail: args.detail };
          const readOnly =
            'Nothing was written, and no side was picked. Show the owner both values: the owner picks the right one on the dashboard (“Pick the right value”), which becomes ONE proposal. You may suggest a value with arkona_consistency_suggest { findingId, value, reason }.';
          try {
            if (args.runId) {
              const r = pd.services!.appraisal!.store.report(pd.project.id, args.runId);
              if (!r || r.tool !== (tool as typeof r.tool))
                return errorResult(
                  {
                    code: 'RUN_NOT_FOUND',
                    message: `No stored ${tool} run ${args.runId} in this project (only the latest run of each scope is kept: run it again).`,
                  },
                  pd,
                );
              return answer(pd, mctx, tool, r, paging, 'free (a stored run)', readOnly);
            }
            const chosen = [args.subject !== undefined, args.under !== undefined, args.all === true].filter(
              Boolean,
            ).length;
            if (chosen !== 1)
              return errorResult(
                { code: 'INVALID_PARAMS', message: 'Give exactly one of subject, under or all: true.' },
                pd,
              );
            let underId: string | undefined;
            if (args.under !== undefined) {
              const rc = repoContext(pd);
              if (!rc.ok) return rc.result;
              const rp = resolvePage(rc.ctx, args.under);
              if (!rp.ok) return rp.result;
              underId = rp.node.id;
            }
            const r = await s.c.run({
              projectId: pd.project.id,
              ...(args.subject !== undefined ? { subject: args.subject } : {}),
              ...(underId !== undefined ? { underId } : {}),
              ...(args.all ? { all: true } : {}),
              ...(args.include ? { include: args.include } : {}),
              ...(args.continuity !== undefined ? { continuity: args.continuity } : {}),
              actor: actorOf(mctx, tool),
              ...(args.live ? { live: liveReader(pd, mctx, tool) } : {}),
            });
            const reads = r.source.live?.reads ?? 0;
            return answer(
              pd,
              mctx,
              tool,
              r,
              paging,
              reads ? `${reads} read(s) (live); the rest free` : 'free',
              readOnly,
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_as_of',
      title: 'Characters as of a date (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only and free: run it BEFORE writing about a character at a date (a chapter, a scene, a history). For each character (at most 25) at `date` (a date of the calendar, or "now": the pack’s present): when it was born and where that is recorded (or “birth unestablished”); the elapsed CALENDAR years (a number when both dates are exact days, a range when either is approximate, “not yet born” before the birth, none when the birth is unknown); the state recorded: Alive (recorded) between its birth and a recorded death, inside its attested span, or from its birth to the present when its Life State records it alive; Deceased (recorded) after a recorded death, or “Deceased (recorded by <date>)” at or after a Life State’s “Deceased by <date>” (an upper bound, never compared); Unestablished otherwise (an attested life never proves survival past it); the chronology rows naming it nearest the date on each side (window, default 3); and any open Contradictory finding on its birth or death. ' +
        'It NEVER gives apparent or biological age: Arkona’s races mature and age differently, so read the race reference it links for the maturation rules. continuity: an AU’s own pages first, else Main CANON’s values labelled “inherited from Main CANON”. Cost: none; live: true re-reads each identity page’s sidebar (1 read each).',
      inputSchema: z.object({
        characters: z
          .array(z.string().min(1).max(300))
          .min(1)
          .max(MAX_AS_OF)
          .describe('Characters: names, aliases, pages or ids.'),
        date: z
          .string()
          .min(1)
          .max(200)
          .describe('A date of the calendar (“Camue 1st, 4A 100”, “c. 4A 640”, “4A 100”), or "now".'),
        continuity,
        window: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Chronology rows each side of the date. Default 3.'),
        live: z.boolean().optional().describe('Re-read each identity page’s sidebar now (one read each).'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          const tool = 'arkona_as_of';
          try {
            const body = await s.c.asOf({
              projectId: pd.project.id,
              characters: args.characters,
              date: args.date,
              ...(args.continuity !== undefined ? { continuity: args.continuity } : {}),
              ...(args.window !== undefined ? { window: args.window } : {}),
              ...(args.live ? { live: liveReader(pd, mctx, tool) } : {}),
            });
            return finish(pd, mctx, tool, body, () => ({
              date: body.date,
              characters: args.characters.length,
            }));
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_as_of_coverage',
      title: 'Which characters have dates the calendar can read (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only and free: how many current characters have a birth the calendar engine can read, a birth deliberately unestablished, attested bounds only, or nothing readable, from their identity pages (one bucket each, so the buckets add up to the total), with a recorded death and an unreadable birth counted as separate flags; and which have nothing readable. A report for the owner, NEVER a task list: an unrecorded birth is often deliberate (“birth date unestablished”); never invent or ask for a date to fill a gap. Cost: none.',
      inputSchema: z.object({
        detail: z.enum(['summary', 'full']).optional().describe('"full": up to 1,000 characters listed.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          try {
            const body = await s.c.coverage({ projectId: pd.project.id, full: args.detail === 'full' });
            return finish(pd, mctx, 'arkona_as_of_coverage', body, () => body.counts);
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_consistency_suggest',
      title: 'Suggest the right value for a consistency finding (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack: records YOUR suggestion of the right value for an arkona_consistency finding (its findingId, “cf_…”), with your reason, for the owner to see beside the finding on the dashboard. It changes nothing in LegendKeeper and applies nothing: only the owner picks the value (“Pick the right value”), which becomes one proposal. Suggest only from evidence the owner can check (say which page and why), never from a guess. Cost: none.',
      inputSchema: z.object({
        findingId: z
          .string()
          .regex(/^cf_[0-9a-f]{20}$/)
          .describe('The finding’s id, from arkona_consistency.'),
        value: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .describe('The value you suggest, exactly as it should be written.'),
        reason: z.string().trim().min(1).max(2000).describe('Why: the evidence, with its page.'),
        project: projectArg,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          try {
            const r = s.c.suggest({
              projectId: pd.project.id,
              findingId: args.findingId,
              value: args.value,
              reason: args.reason,
              principalId: actorOf(mctx, 'arkona_consistency_suggest'),
            });
            return finish(
              pd,
              mctx,
              'arkona_consistency_suggest',
              {
                ...r,
                status: 'suggested',
                message:
                  'Recorded for the owner, shown beside the finding on the dashboard. Nothing was changed or proposed: only the owner picks the value.',
              },
              () => r,
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
  ];
}
