/**
 * The zod helpers every configuration schema is written with (v3 F8, ADR 0073). One definition, so the settings
 * registry (`./registry.ts`) can read each setting's type, default and range straight from the schema: the bounds have
 * one source. A leaf module: it imports nothing of the bridge's own, so every config file can use it.
 */
import * as z from 'zod';

/** A `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`) variable with a default. */
export const bool = (def: boolean) => z.stringbool().default(def);

/** A whole number from `min` to `max` (inclusive), read from its text, with a default. */
export const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** A number from 0 to 1 (inclusive), with a default. */
export const fraction = (def: number) => z.coerce.number().min(0).max(1).default(def);

/** A number (fractions allowed) from `min` to `max` (inclusive), with a default. */
export const numberFrom = (def: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(def);
