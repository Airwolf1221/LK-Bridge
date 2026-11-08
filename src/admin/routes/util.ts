import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import type { AdminActions } from '../actions.js';
import { AdminHttpError } from '../http.js';
import type { StreamHub } from '../stream.js';
import type { AdminDeps } from '../types.js';
import type { Health } from '../health.js';

export interface RouteContext {
  readonly deps: AdminDeps;
  readonly actions: AdminActions;
  readonly hub: StreamHub;
  readonly health: (refresh: boolean) => Promise<Health>;
  readonly now: () => number;
}

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
