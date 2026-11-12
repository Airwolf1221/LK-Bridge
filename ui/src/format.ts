/** Formatting helpers. British English, 24-hour times, no external date library. */

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : n.toLocaleString('en-GB');

/**
 * A time as "10 Nov, 14:02:11"; with the year ("3 Nov 2027, 02:12:35") when it is not in the current year, so a
 * date a year away (a 360-day token's expiry) is never read as one in the current year. British English, 24-hour.
 * `now` and `timeZone` exist for tests (a year boundary, a fixed zone); the dashboard passes neither.
 */
export function fmtTime(ms: number | null | undefined, now: number = Date.now(), timeZone?: string): string {
  if (ms === null || ms === undefined) return '–';
  const zone = timeZone ? { timeZone } : {};
  const year = (t: number) => Number(new Date(t).toLocaleString('en-GB', { year: 'numeric', ...zone }));
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(year(ms) === year(now) ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...zone,
  });
}

export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** "2 min 05 s" style countdown/duration from milliseconds. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Bytes in binary units (v2 E1a added GB and TB: the snapshot store and the disk's free space). */
export const fmtBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : n < 1024 ** 4
          ? `${(n / 1024 ** 3).toFixed(1)} GB`
          : `${(n / 1024 ** 4).toFixed(1)} TB`;

export const pct = (used: number, limit: number | null): number =>
  limit === null || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));

export const shortId = (id: string, keep = 10): string =>
  id.length > keep + 2 ? `${id.slice(0, keep)}…` : id;

export const prettyJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? 'undefined';
  } catch {
    return String(v);
  }
};

export const TIER_LABELS: Record<string, string> = {
  'write-min': 'Writes per minute',
  'write-hour': 'Writes per hour',
  'key-min': 'All requests per minute',
  'key-hour': 'All requests per hour',
  'key-day': 'All requests per day',
  'project-hour': 'Project, per hour (all keys)',
  'items-min': 'Bulk-create items per minute',
  'items-hour': 'Bulk-create items per hour',
  upload: 'Image uploads',
};

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_budget: 'Waiting for budget',
  waiting_lock: 'Waiting for a lock',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Pending',
  uncertain: 'Uncertain',
  approved: 'Approved',
  rejected: 'Rejected',
  conflicted: 'Conflicted',
  expired: 'Expired',
  executing: 'Executing',
  executed: 'Executed',
};

/** A project's status (v2 A1), in words. */
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: 'active',
  verifying: 'checking its key',
  unverified: 'not verified',
  stopped: 'stopped',
  not_configured: 'no key configured',
  archived: 'removed',
};

/** A principal's name as the server resolved it (src/policy/store.ts `PrincipalName`). */
export interface PrincipalInfo {
  id: string;
  name: string;
  type: 'grant' | 'pat' | 'system' | 'removed';
  removedAt: number | null;
}
export type PrincipalNames = Record<string, PrincipalInfo>;

/**
 * Who a journal entry, job, error or proposal belongs to, in words: never a bare id, never empty. A removed connection
 * reads "ChatGPT (removed 10 Nov 2026)" (from its tombstone). `fallback` is what the row itself holds (its profile,
 * or a proposal's snapshot label); `preferFallback` shows it even for a live connection.
 */
export function principalText(
  id: string,
  names: PrincipalNames | undefined,
  fallback?: string,
  preferFallback = false,
): string {
  const n = names?.[id];
  if (n?.type === 'removed') return n.name;
  if (preferFallback && fallback) return fallback;
  return n?.name ?? fallback ?? (id === 'system' ? 'System' : 'Unknown connection');
}
