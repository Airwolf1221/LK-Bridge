/**
 * Display units for the settings registry (v3 F8, ADR 0073). A setting is stored and validated in its BASE unit, the
 * one its variable is written in (bytes, milliseconds, seconds, days, ...); the Settings page shows it in a DISPLAY unit
 * (MB, seconds, minutes, ...). `factor` is how many base units one display unit is: display = base / factor.
 *
 * Only these conversions exist, and a value that does not come out whole where the setting needs a whole number is
 * refused, never rounded silently.
 */

export type BaseUnit =
  | 'bytes'
  | 'megabytes'
  | 'gibibytes'
  | 'milliseconds'
  | 'seconds'
  | 'days'
  | 'weeks'
  | 'fraction'
  | 'count'
  | 'characters'
  | 'pixels'
  | 'frames';

export interface UnitSpec {
  /** What the variable itself is written in. */
  readonly base: BaseUnit;
  /** The unit the Settings page shows and accepts. */
  readonly display: string;
  /** Base units per display unit. */
  readonly factor: number;
}

const unit = (base: BaseUnit, display: string, factor: number): UnitSpec => ({ base, display, factor });

/** The display units in use. */
export const UNITS = {
  bytesAsMb: unit('bytes', 'MB', 1024 * 1024),
  bytesAsGb: unit('bytes', 'GB', 1024 ** 3),
  bytesAsKb: unit('bytes', 'KB', 1024),
  megabytes: unit('megabytes', 'MB', 1),
  gigabytes: unit('gibibytes', 'GB', 1),
  msAsSeconds: unit('milliseconds', 'seconds', 1000),
  msAsMinutes: unit('milliseconds', 'minutes', 60_000),
  seconds: unit('seconds', 'seconds', 1),
  secondsAsMinutes: unit('seconds', 'minutes', 60),
  secondsAsHours: unit('seconds', 'hours', 3600),
  secondsAsDays: unit('seconds', 'days', 86_400),
  days: unit('days', 'days', 1),
  weeks: unit('weeks', 'weeks', 1),
  percent: unit('fraction', '%', 0.01),
  count: unit('count', '', 1),
  characters: unit('characters', 'characters', 1),
  pixels: unit('pixels', 'pixels', 1),
  frames: unit('frames', 'frames', 1),
} as const;

/** A base value in the display unit (for showing it). */
export function toDisplay(value: number, u: UnitSpec): number {
  const v = value / u.factor;
  // Rounded to 6 significant decimals, so 0.1 × 100 shows as 10, not 10.000000000000002.
  return Math.round(v * 1e6) / 1e6;
}

export class UnitConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitConversionError';
  }
}

/**
 * A display value back in the base unit. `integer`: the setting is a whole number, so the result must come out whole
 * (allowing only floating-point noise); otherwise it is refused.
 */
export function fromDisplay(amount: number, unitName: string, u: UnitSpec, integer: boolean): number {
  if (unitName !== u.display) {
    throw new UnitConversionError(
      `This setting is given in ${u.display === '' ? 'plain numbers' : u.display}, not ${unitName === '' ? 'plain numbers' : unitName}.`,
    );
  }
  if (!Number.isFinite(amount)) throw new UnitConversionError('Not a number.');
  const v = amount * u.factor;
  if (!integer) return Math.round(v * 1e9) / 1e9;
  const r = Math.round(v);
  if (Math.abs(v - r) > 1e-6 * Math.max(1, Math.abs(v))) {
    throw new UnitConversionError(
      `${amount} ${u.display} is not a whole number of ${u.base} (${v}); use a value that converts exactly.`,
    );
  }
  return r;
}
