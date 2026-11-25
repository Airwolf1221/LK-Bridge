import type { FastifyInstance, FastifyReply } from 'fastify';
import * as z from 'zod';
import type { AdminActions } from '../actions.js';
import type { PrincipalName } from '../../policy/index.js';
import { AdminHttpError } from '../http.js';
import type { StreamHub } from '../stream.js';
import type { AdminDeps } from '../types.js';
import type { Health } from '../health.js';

/** The project a dashboard request is about (v2 A1). */
export interface RouteProject {
  /** The LegendKeeper project id. */
  readonly id: string;
  readonly name: string;
}

export interface RouteContext {
  readonly deps: AdminDeps;
  readonly actions: AdminActions;
  readonly hub: StreamHub;
  /** The health of one project's LegendKeeper connection (cached a minute per project). */
  readonly health: (project: RouteProject, refresh: boolean) => Promise<Health>;
  readonly now: () => number;
  /**
   * Hotfix (ADR 0033): the names of principal ids (a grant, a PAT or `system`), keyed by id. History rows hold only the
   * id; a removed connection is named from its tombstone, so a row never shows a bare id. Responses carry this as
   * `principals` next to the rows.
   */
  readonly principals: (ids: Iterable<string>) => Record<string, PrincipalName>;
  /**
   * The `project` query parameter (a name or id; default: the default project), as a project with stored data. Unknown:
   * 400 UNKNOWN_PROJECT. Configured but never verified (so it has no id and no data yet): 409 PROJECT_UNAVAILABLE.
   */
  readonly project: (ref: string | undefined) => RouteProject;
}

/** The optional `project` query parameter of every project-scoped route. */
export const projectParam = z.string().min(1).max(64).optional();

export type Register = (api: FastifyInstance, ctx: RouteContext) => void;

/** Validates input; a failure is a 400 naming the fields, never a stack. */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  throw new AdminHttpError(
    400,
    'INVALID_INPUT',
    r.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '),
  );
}

export const limitSchema = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

export const idSchema = z.string().min(1).max(200);

/** `a,b,c` or a repeated parameter, into a list. */
export const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export const confirmBody = z.object({ confirm: z.literal(true) });

/**
 * v3 F5b follow-up: the project a mutating dashboard request acts on. The dashboard sends the selected project in the
 * address (`?project=`, `useProjectApi`); some pages also name it in the body. The address decides; a body that names
 * another project is refused (`400 PROJECT_MISMATCH`), so an action can only ever touch the project in view. With
 * neither, the default project (as every route).
 */
export function projectFor(
  ctx: RouteContext,
  req: { readonly query: unknown },
  bodyProject: string | undefined,
): RouteProject {
  const address = parseInput(z.object({ project: projectParam }).loose(), req.query ?? {}).project;
  if (address === undefined) return ctx.project(bodyProject);
  const p = ctx.project(address);
  if (bodyProject !== undefined && ctx.project(bodyProject).id !== p.id)
    throw new AdminHttpError(
      400,
      'PROJECT_MISMATCH',
      `The request names two projects: “${address.slice(0, 64)}” in the address and “${bodyProject.slice(0, 64)}” in the body. Nothing was done.`,
    );
  return p;
}

/**
 * The 25 November 2026 freeze (ADR 0061 amendment 2): a signal aborted when the client closes its connection before
 * the answer is sent (the dashboard navigated away, or gave up on a poll), so the rest of the request's work stops
 * where it allows (its LegendKeeper reads leave the queue; its chunks stop between yields).
 */
export function closedSignal(reply: FastifyReply): AbortSignal {
  const c = new AbortController();
  const raw = reply.raw;
  const onClose = () => {
    if (!raw.writableEnded)
      c.abort(new AdminHttpError(499, 'REQUEST_CLOSED', 'The client closed the request.'));
  };
  raw.once('close', onClose);
  return c.signal;
}

/** Throws the closed request's error when its client has gone (between chunks of work). */
export function stopIfClosed(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new AdminHttpError(499, 'REQUEST_CLOSED', 'The client closed the request.');
}
