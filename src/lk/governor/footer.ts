/**
 * The compact budget footer appended to every MCP tool result (PLAN §5.4), e.g.
 * `budget: writes 87/120·min 2,410/3,000·h | all 241/300·min 5,102/6,000·h 48k/60k·d | project 9.8k/12k·h | queue P1:0 P2:14`
 *
 * Numbers for tiers whose limit is 10,000 or more are shortened to `k` (one decimal below 10k). P0, P3 and P4 (bulk,
 * v3 F9) queue depths are only shown when non-zero. When LK is refusing a tier (429), ` | blocked <tier> <seconds>s` is
 * appended so an agent knows not to retry before then. v2 E5.5: a learned operation group LK is refusing is named the
 * same way (` | blocked assets 12s`); learned limits are otherwise not in the line (the Budgets page lists them).
 */
import type { TierId } from '../registry-types.js';
import type { BudgetSnapshot } from './types.js';

const DOT = '·';

function grouped(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function short(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  const rounded = k < 10 ? Math.round(k * 10) / 10 : Math.round(k);
  return `${rounded}k`;
}

function pair(snapshot: BudgetSnapshot, tier: TierId, unit: string): string {
  const t = snapshot.tiers[tier];
  if (t.limit === null) return `${grouped(t.used)}/?${DOT}${unit}`;
  const fmt = t.limit >= 10_000 ? short : grouped;
  return `${fmt(t.used)}/${fmt(t.limit)}${DOT}${unit}`;
}

/**
 * The one-line footer (PLAN §5.4). With `project` (v2 A1: each project has its own governor), the line names it:
 * `budget (arkona): writes …`.
 */
export function formatBudgetFooter(snapshot: BudgetSnapshot, project?: string): string {
  const q = snapshot.queues;
  const queue = [
    ...(q.P0 > 0 ? [`P0:${q.P0}`] : []),
    `P1:${q.P1}`,
    `P2:${q.P2}`,
    ...(q.P3 > 0 ? [`P3:${q.P3}`] : []),
    ...(q.P4 > 0 ? [`P4:${q.P4}`] : []),
  ].join(' ');
  const parts = [
    `budget${project ? ` (${project})` : ''}: writes ${pair(snapshot, 'write-min', 'min')} ${pair(snapshot, 'write-hour', 'h')}`,
    `all ${pair(snapshot, 'key-min', 'min')} ${pair(snapshot, 'key-hour', 'h')} ${pair(snapshot, 'key-day', 'd')}`,
    `project ${pair(snapshot, 'project-hour', 'h')}`,
    `queue ${queue}`,
  ];
  const blocked = Object.values(snapshot.tiers)
    .filter((t) => t.blockedUntilMs !== null && t.blockedUntilMs > snapshot.atMs)
    .map((t) => `${t.tier} ${Math.ceil(((t.blockedUntilMs ?? 0) - snapshot.atMs) / 1000)}s`);
  // One entry per group (a group may hold more than one learned tier), at its latest block.
  const groups = new Map<string, number>();
  for (const g of snapshot.operationTiers ?? [])
    if (g.blockedUntilMs !== null && g.blockedUntilMs > snapshot.atMs)
      groups.set(g.group, Math.max(groups.get(g.group) ?? 0, g.blockedUntilMs));
  for (const [group, until] of groups) blocked.push(`${group} ${Math.ceil((until - snapshot.atMs) / 1000)}s`);
  if (blocked.length > 0) parts.push(`blocked ${blocked.join(', ')}`);
  return parts.join(' | ');
}
