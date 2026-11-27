/**
 * The fields the vendored spec (spec/legendkeeper-openapi.json) defines for an object type, as the read-backs need
 * them: a field LegendKeeper returns that is not here is API drift, never a reason on its own to fail a verification.
 */
import { defs } from './registry.defs.generated.js';

export type SpecObjectType = 'Resource' | 'Asset';

const cache = new Map<string, ReadonlySet<string>>();

export function specFields(objectType: SpecObjectType): ReadonlySet<string> {
  let f = cache.get(objectType);
  if (!f) {
    const props = (defs[objectType] as { properties?: Record<string, unknown> } | undefined)?.properties;
    f = new Set(Object.keys(props ?? {}));
    cache.set(objectType, f);
  }
  return f;
}
