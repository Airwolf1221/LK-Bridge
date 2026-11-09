/** Formatting helpers. British English, 24-hour times, no external date library. */

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : n.toLocaleString('en-GB');

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
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

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

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
};
