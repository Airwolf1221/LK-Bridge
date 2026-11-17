/**
 * A timeline event's fields when it is made again (v2 E4, RV3-5; moved here from the timeline tools in v3 F3.4 so the
 * revert of a chronology change, ADR 0055, rebuilds an event exactly as the tools do).
 */
import { withWriteIcon } from '../lk/icons.js';
import { requireOperation } from '../lk/registry.js';
import { defs } from '../lk/registry.defs.generated.js';

/**
 * The fields of an event that a re-made copy keeps: every field `createEvent` takes, except those the update decides
 * (id, lane, type, name, dates, detail, link) and LegendKeeper's own formatted text; icons in their write form (ADR 0042
 * decision 9).
 */
export function keptEventFields(raw: Record<string, unknown>): Record<string, unknown> {
  const body = (
    requireOperation('createEvent').inputJsonSchema.properties as Record<string, unknown> | undefined
  )?.body as { $ref?: string; properties?: Record<string, unknown> } | undefined;
  const ref = typeof body?.$ref === 'string' ? body.$ref.split('/').pop()! : null;
  const def = (ref ? (defs[ref] as { properties?: Record<string, unknown> } | undefined) : body) ?? {};
  const decided = new Set([
    'id',
    'laneId',
    'type',
    'name',
    'start',
    'end',
    'detail',
    'uri',
    'formattedStart',
    'formattedEnd',
  ]);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def.properties ?? {}))
    if (!decided.has(k) && raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  return withWriteIcon(out);
}

/** The `createEvent` body that makes an event again as it was (`old`, as `getEvent` gave it), under a new id. */
export function remadeEventBody(old: Record<string, unknown>, id: string): Record<string, unknown> {
  return {
    ...keptEventFields(old),
    id,
    laneId: old.laneId,
    type: 'event',
    name: old.name,
    start: old.start,
    ...(old.end !== undefined && old.end !== null ? { end: old.end } : {}),
    detail: old.detail,
    ...(typeof old.uri === 'string' ? { uri: old.uri } : {}),
  };
}
