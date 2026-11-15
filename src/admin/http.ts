import type { FastifyReply } from 'fastify';
import { JobsError } from '../jobs/index.js';
import { MaintenanceError } from '../maintenance/scheduler.js';
import { MappingError } from '../mappings/types.js';
import { PolicyError } from '../policy/index.js';
import { AssetError } from '../assets/index.js';
import { TreeError } from '../tree/index.js';
import { ProjectChangeError } from '../projects/registry.js';
import { SecretStoreError } from '../secrets/store.js';
import { RegistryError } from '../registry/index.js';

/** An error with an HTTP status, for admin routes. The body is always `{ error: { code, message } }`. */
export class AdminHttpError extends Error {
  override readonly name = 'AdminHttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const POLICY_STATUS: Readonly<Record<string, number>> = {
  NOT_OWNER: 403,
  INVALID_INPUT: 400,
  PROFILE_EXISTS: 409,
  PROFILE_NOT_FOUND: 404,
  CONNECTION_NOT_FOUND: 404,
  CONNECTION_ACTIVE: 409,
  PROPOSAL_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  PROPOSAL_EXPIRED: 409,
  BRIDGE_READ_ONLY: 409,
  WRITES_PAUSED: 409,
  DRAINING: 409,
  NO_ENGINE: 503,
  REREAD_FAILED: 502,
  CANONICAL_APPROVAL_REQUIRED: 409,
  NOT_CANONICAL: 409,
};

// Chunk 6: maintenance and mapping errors.
const MAINTENANCE_STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  NOT_IMPLEMENTED: 409,
  ALREADY_RUNNING: 409,
  INVALID_SCHEDULE: 400,
  NOT_OWNER: 403,
  PROJECT_NOT_SERVED: 409,
};

const MAPPING_STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_IMPORT: 400,
  NAME_TAKEN: 409,
  DUPLICATE_FIELD: 409,
  NOT_OWNER: 403,
};

// v2 A2: repository tree errors are all "not now" conflicts.
const TREE_STATUS: Readonly<Record<string, number>> = {
  NOT_CONFIGURED: 409,
  PASS_RUNNING: 409,
  NOTHING_TO_CONFIRM: 409,
  NOTHING_TO_CANCEL: 409,
};

// OPS2: managing projects and their keys.
const PROJECT_CHANGE_STATUS: Readonly<Record<string, number>> = {
  INVALID_NAME: 400,
  NAME_TAKEN: 409,
  ALREADY_SERVED: 409,
  RESTORE_UNDER_NAME: 409,
  NOT_FOUND: 404,
  NOT_REGISTERED: 409,
  KEY_WRONG_PROJECT: 409,
  STORE_UNAVAILABLE: 503,
  KEY_REFUSED: 422,
  PAID_PLAN_REQUIRED: 422,
  KEY_SEES_SEVERAL: 422,
  KEY_CHECK_FAILED: 422,
  LK_UNREACHABLE: 502,
};

// v2 A3: the type registry, taxonomy, resolver and planners. Refusals of a lookup or a plan are 409 (the request
// was understood; the repository does not allow an answer), with every detail (candidates, available labels).
const REGISTRY_STATUS: Readonly<Record<string, number>> = {
  NOT_OWNER: 403,
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  TEMPLATES_UNREADABLE: 502,
};

// v2 A4: asset tree errors are all "not now" conflicts.
const ASSET_STATUS: Readonly<Record<string, number>> = {
  PASS_RUNNING: 409,
  NOTHING_TO_CONFIRM: 409,
  NOTHING_TO_CANCEL: 409,
};

const JOBS_STATUS: Readonly<Record<string, number>> = {
  JOB_NOT_FOUND: 404,
  INVALID_CONTROL: 409,
  INVALID_PARAMS: 400,
  READ_ONLY: 409,
  DRAINING: 409,
};

/** The status and body for anything a route throws. Unknown errors are a generic 500: no message, no stack. */
export function describeError(err: unknown): { status: number; body: { error: Record<string, unknown> } } {
  if (err instanceof AdminHttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...err.extra } } };
  }
  if (err instanceof PolicyError) {
    return {
      status: POLICY_STATUS[err.code] ?? 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof ProjectChangeError) {
    return {
      status: PROJECT_CHANGE_STATUS[err.code] ?? 409,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof SecretStoreError) {
    return {
      status: err.code === 'UNAVAILABLE' ? 503 : 409,
      body: {
        error: { code: err.code === 'UNAVAILABLE' ? 'STORE_UNAVAILABLE' : err.code, message: err.message },
      },
    };
  }
  if (err instanceof TreeError) {
    return {
      status: TREE_STATUS[err.code] ?? 409,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof RegistryError) {
    return { status: REGISTRY_STATUS[err.code] ?? 409, body: { error: err.toJSON() } };
  }
  if (err instanceof AssetError) {
    return {
      status: ASSET_STATUS[err.code] ?? 409,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof MaintenanceError) {
    return {
      status: MAINTENANCE_STATUS[err.code] ?? 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof MappingError) {
    return {
      status: MAPPING_STATUS[err.code] ?? 400,
      body: {
        error: { code: err.code, message: err.message, ...(err.issues.length ? { issues: err.issues } : {}) },
      },
    };
  }
  if (err instanceof JobsError) {
    return {
      status: JOBS_STATUS[err.code] ?? 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown; validation?: unknown };
  // Fastify's own errors (bad JSON, body too large, unsupported media type) carry a 4xx status and a safe message.
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return {
      status: e.statusCode,
      body: {
        error: {
          code: typeof e.code === 'string' ? e.code : 'BAD_REQUEST',
          message: typeof e.message === 'string' ? e.message : 'Bad request',
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } },
  };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const { status, body } = describeError(err);
  return reply.code(status).type('application/json; charset=utf-8').send(body);
}
