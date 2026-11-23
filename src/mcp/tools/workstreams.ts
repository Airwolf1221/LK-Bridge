/**
 * v3 F5c (ADR 0069, H8): workstreams.
 *
 * - `bridge_workstream { set }`: the calling connection's default label, held on the server and expiring after 12
 *   hours of no use, so an agent that forgets the `workstream` argument is still grouped. With no `set`, it says which
 *   label is in force.
 * - `bridge_workstream_report { workstream | since | principal | jobIds }`: one report of what was done (read-only and
 *   free; src/workstreams/report.ts). The design's `arkona_workstream_report` is this tool: it is not Arkona-specific.
 */
import * as z from 'zod';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { finish } from './repo.js';
import { errorResult, projectArg, render, withProject, type ToolDeps } from './shape.js';
import { normaliseWorkstream, WORKSTREAM_MAX } from '../../workstreams/context.js';
import { DEFAULT_TTL_MS } from '../../workstreams/defaults.js';

const iso = (t: number) => new Date(t).toISOString();

export function workstreamTools(deps: ToolDeps): McpToolProvider[] {
  return [
    defineTool({
      name: 'bridge_workstream',
      title: 'Workstream label',
      access: 'read',
      description:
        'Sets (or clears, with null) the default workstream label for THIS connection: every later write or proposal you make without a `workstream` argument is recorded under it, so one maintenance objective (for example "Menkheti culture split") can be reported as a whole with bridge_workstream_report. Held on the bridge; it lapses after 12 hours with no write using it. With no `set`, says which label is in force. A `workstream` argument on a write always wins. It writes nothing to LegendKeeper. Cost: none.',
      inputSchema: z.object({
        set: z
          .union([z.string().min(1).max(WORKSTREAM_MAX), z.null()])
          .optional()
          .describe('The label (at most 80 characters), or null to clear it. Omit to read the current one.'),
      }),
      annotations: READ_ANNOTATIONS,
      handler: (args, mctx) =>
        withProject(deps, undefined, 'read', (pd) => {
          const store = pd.services?.workstreams;
          const pid = mctx.principal?.principalId;
          if (!store || !pid)
            return errorResult(
              {
                code: 'TOOL_UNAVAILABLE',
                message: pid
                  ? 'Workstream labels are not available on this bridge.'
                  : 'This connection is not known to the bridge, so it has no default label.',
              },
              pd,
            );
          if (args.set !== undefined) {
            const label = args.set === null ? null : normaliseWorkstream(args.set);
            if (args.set !== null && label === null)
              return errorResult({ code: 'INVALID_PARAMS', message: 'The label is empty.' }, pd);
            const d = store.set(pid, label);
            return render(
              d
                ? {
                    status: 'set',
                    workstream: d.label,
                    expiresAt: iso(d.expiresAt),
                    note: `Every write or proposal you make without a workstream argument is now recorded under “${d.label}”. It lapses after ${DEFAULT_TTL_MS / 3_600_000} hours with no write using it; bridge_workstream_report reports it.`,
                  }
                : { status: 'cleared', workstream: null, note: 'No default label: writes are grouped only by their own argument.' },
              pd,
            );
          }
          const d = store.get(pid, { touch: true });
          return render(
            d
              ? { workstream: d.label, setAt: iso(d.setAt), expiresAt: iso(d.expiresAt) }
              : { workstream: null, note: 'No default label is set for this connection (or it lapsed).' },
            pd,
          );
        }),
    }),
    defineTool({
      name: 'bridge_workstream_report',
      title: 'Workstream report',
      access: 'read',
      description:
        'One report of a maintenance objective: give a workstream label (as passed to writes or set with bridge_workstream), or a since time, a principal, or jobIds (together they narrow). It lists, in five groups: WRITTEN AND VERIFIED (every page changed, each write with its version before and after and who made it, and what the job’s read-back found); ACCEPTED BUT NOT YET RUN (queued or running jobs, approved proposals); DELIBERATELY EXCLUDED (items the owner left unticked, items skipped as changed meanwhile, refusals, with why); AWAITING THE AUTHOR’S JUDGEMENT (pending and conflicted proposals, tags held for the owner); RESIDUAL INCONSISTENCIES (writes whose outcome was unknown and how each was settled, read-backs that differed, failed jobs, audit and consistency findings still open on the pages touched). Then a short "still to do" list drawn only from those groups. Read-only. Cost: none (the bridge’s own records; nothing is read from LegendKeeper).',
      inputSchema: z.object({
        workstream: z.string().min(1).max(WORKSTREAM_MAX).optional(),
        since: z
          .string()
          .min(4)
          .max(40)
          .optional()
          .describe('An ISO date or time (2026-11-23 or 2026-11-23T09:00Z): work started from then on.'),
        principal: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Only this connection’s work (grant_… or pat_…).'),
        jobIds: z.array(z.string().min(1).max(100)).min(1).max(200).optional(),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', (pd) => {
          const reports = pd.services?.workstreamReports;
          if (!reports)
            return errorResult(
              { code: 'TOOL_UNAVAILABLE', message: 'Workstream reports are not available on this bridge.' },
              pd,
            );
          let since: number | undefined;
          if (args.since !== undefined) {
            since = Date.parse(args.since);
            if (Number.isNaN(since))
              return errorResult(
                { code: 'INVALID_PARAMS', message: `“${args.since}” is not a date or time (use ISO, 2026-11-23).` },
                pd,
              );
          }
          const workstream = args.workstream !== undefined ? normaliseWorkstream(args.workstream) : undefined;
          if (
            workstream === undefined &&
            since === undefined &&
            args.principal === undefined &&
            args.jobIds === undefined
          )
            return errorResult(
              {
                code: 'INVALID_PARAMS',
                message: 'Give a workstream, a since time, a principal or jobIds.',
                hint: 'bridge_workstream (no arguments) says which label this connection uses by default.',
              },
              pd,
            );
          const report = reports.report(pd.project.id, {
            ...(workstream ? { workstream } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(args.principal !== undefined ? { principal: args.principal } : {}),
            ...(args.jobIds !== undefined ? { jobIds: args.jobIds } : {}),
          });
          return finish(pd, mctx, 'bridge_workstream_report', report, () => ({
            counts: report.counts,
            stillToDo: (report.stillToDo as string[]).slice(0, 20),
          }));
        }),
    }),
  ];
}
