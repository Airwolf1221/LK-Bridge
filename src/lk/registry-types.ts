/**
 * Types shared by the generated operation registry (src/lk/registry.generated.ts),
 * the registry accessors and, later, the governor and job engine.
 */

/** Every rate tier the governor models. `upload` is reactive only (limits unpublished by LK). */
export const TIER_IDS = [
  'write-min',
  'write-hour',
  'key-min',
  'key-hour',
  'key-day',
  'project-hour',
  'items-min',
  'items-hour',
  'upload',
] as const;
export type TierId = (typeof TIER_IDS)[number];

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type OperationKind = 'read' | 'write' | 'upload';
/** Which lock a write step must hold: none, the owning document, or the resource. */
export type Concurrency = 'none' | 'document' | 'resource';
export type Risk = 'safe' | 'destructive' | 'admin';

/** A JSON Schema fragment. `$ref`s point at `#/$defs/<Name>` (see registry.defs.generated.ts). */
export type JsonSchema = Record<string, unknown>;

export interface OperationDef {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Relative to `/api/v3`. `{projectId}` is always injected by the bridge, never by the caller. */
  readonly pathTemplate: string;
  readonly tag: string;
  readonly summary: string;
  readonly kind: OperationKind;
  /** Tiers this operation draws one unit from. */
  readonly costs: readonly TierId[];
  /** Dotted path into the call input whose array length is the `items-*` tier cost (createManyResources). */
  readonly itemsFrom?: string;
  readonly concurrency: Concurrency;
  /** Accepts `If-Match`, so the bridge must supply a version. */
  readonly versioned: boolean;
  /** Takes `cursor`/`limit`. */
  readonly paged: boolean;
  readonly risk: Risk;
  /**
   * Caller-facing input: `{ path?, query?, ifMatch?, body? }`. `projectId` and `Idempotency-Key`
   * are excluded because the bridge supplies them.
   */
  readonly inputJsonSchema: JsonSchema;
}
