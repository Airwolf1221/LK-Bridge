/**
 * v2 E5.4: LegendKeeper's label-size contradiction, as the mock LegendKeeper reproduces it (Arkona's second rehearsal,
 * 15 November 2026):
 *
 * - `createFeature` / `updateFeature` take only `xs`–`3xl` and refuse the app's `small`/`medium`/`large`;
 * - `listFeatures` validates what it RETURNS against `small | medium | large` only, so one feature holding any other
 *   value makes LegendKeeper refuse to list every feature of that map.
 */
import type { MockResponse } from '../contract/mock-lk.js';

export const WRITE_LABEL_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'] as const;
export const READ_LABEL_SIZES = ['small', 'medium', 'large'] as const;

const bad = (path: string, message: string): MockResponse => ({
  status: 400,
  body: {
    code: 'VALIDATION_ERROR',
    message: 'Validation error',
    requestId: 'model-labelsize',
    errors: [{ path, message }],
  },
});

/** The 400 a write gets for a label size outside xs–3xl (the first rehearsal's failure), or undefined. */
export function labelSizeWriteRefusal(body: Record<string, unknown>): MockResponse | undefined {
  const v = body.labelSize;
  if (v === undefined) return undefined;
  if (typeof v === 'string' && (WRITE_LABEL_SIZES as readonly string[]).includes(v)) return undefined;
  return bad(
    'labelSize',
    `Invalid enum value. Expected ${WRITE_LABEL_SIZES.map((x) => `'${x}'`).join(' | ')}, received '${JSON.stringify(v)}'`,
  );
}

/** The 400 `listFeatures` gives when any feature holds a label size other than small/medium/large, or undefined. */
export function labelSizeListRefusal(features: readonly Record<string, unknown>[]): MockResponse | undefined {
  const f = features.find(
    (x) =>
      x.labelSize !== undefined && !(READ_LABEL_SIZES as readonly unknown[]).includes(x.labelSize as unknown),
  );
  if (!f) return undefined;
  return bad(
    'labelSize',
    `Invalid enum value. Expected 'small' | 'medium' | 'large', received '${String(f.labelSize)}'`,
  );
}
