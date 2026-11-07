/**
 * Deterministic idempotency keys (PLAN §5.3): `lkb.{jobId}.{stepNo}.{attempt0}`. The same step resent after a
 * bridge restart reuses its key, so LK replays instead of writing twice. `attempt0` changes only when the step is
 * deliberately re-run as new work (for example after the 24 h key window has passed).
 */
const KEY = /^[A-Za-z0-9._-]{1,255}$/;

export function idempotencyKeyFor(jobId: string, stepNo: number, attempt0 = 0): string {
  if (!Number.isInteger(stepNo) || stepNo < 0) throw new RangeError('stepNo must be a non-negative integer');
  if (!Number.isInteger(attempt0) || attempt0 < 0)
    throw new RangeError('attempt0 must be a non-negative integer');
  const key = `lkb.${jobId}.${stepNo}.${attempt0}`;
  if (!KEY.test(key)) {
    throw new RangeError('jobId must use only A-Z a-z 0-9 . _ - and keep the key within 255 characters');
  }
  return key;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY.test(key);
}
