/**
 * Custom (non-registry) step types. The only one today is the signed-URL `PUT` of an `upload_image` job
 * (PLAN §4 rule 5): it is not an LK API call, so it has no registry entry; the handler lives with the MCP tools
 * (src/mcp/tools/upload-step.ts) and is passed to the engine as `customSteps`.
 *
 * A handler reaches the network only through `ctx.lk` (the governor), so pacing, retries and the upload tier's
 * reactive backoff apply to it as to every LK call. It must be safe to run again: a step left `running` by a
 * crash is simply run again.
 */
import type { LkClient } from '../lk/client.js';
import type { OpParams, PriorityClass } from './types.js';

/** The step id of the signed-URL PUT in an `upload_image` job. */
export const UPLOAD_PUT_STEP = 'upload_image.put';
/**
 * v2 D3 (ADR 0041): the step after createImageAsset that downloads the stored file from the asset host (anonymous GET,
 * through the governor and the guarded transport) and compares its SHA-256 with the bytes the bridge uploaded.
 */
export const UPLOAD_VERIFY_STEP = 'upload_image.verify';

export interface CustomStepContext {
  readonly jobId: string;
  readonly stepNo: number;
  readonly priority: PriorityClass;
  readonly lk: LkClient;
  /** This step's stored params. */
  readonly params: OpParams;
  /** The stored result of an earlier step of the same job, or null (from the row, or its result artefact). */
  resultOf(stepNo: number): unknown;
  /** Replaces this step's stored params, e.g. to discard payload bytes once nothing needs them again. */
  replaceParams(params: OpParams): void;
}

/** Returns the step's result (stored in the step summary). Throws to fail the step. */
export type CustomStepHandler = (ctx: CustomStepContext) => Promise<unknown>;

export type CustomStepHandlers = Readonly<Record<string, CustomStepHandler>>;
