import { useEffect, useState } from 'react';
import { Link } from './router';

/**
 * The sidebar's navigation (v3 F3c): three pages always at the top (Overview, Jobs, Proposals), then the rest in
 * expandable groups. Groups sort by name and pages by label, in code, so a new page only needs its group named.
 */

export interface NavItem {
  to: string;
  label: string;
  /** The group it is filed under; none for the top links. */
  group?: string;
}

export interface NavGroup {
  name: string;
  /** A stable, id-safe key for the group (its aria-controls target and its stored state). */
  key: string;
  items: NavItem[];
}

/** Locale-aware and case-insensitive, so "Off-site copy" and "archive" sort as a reader expects. */
const collator = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true });
export const byText = (a: string, b: string): number => collator.compare(a, b);

export const groupKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Groups the filed pages: groups by name, their pages by label. Pages without a group are left out. */
export function groupNav(items: readonly NavItem[]): NavGroup[] {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) {
    if (!item.group) continue;
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([name, list]) => ({
      name,
      key: groupKey(name),
      items: [...list].sort((a, b) => byText(a.label, b.label)),
    }));
}

/** Whether `path` is the page `to` or one of its sub-paths (`/jobs/abc` is under `/jobs`). */
export const isCurrent = (to: string, path: string): boolean =>
  to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);

export const NAV_STORAGE_KEY = 'lkb-nav-open';

type OpenState = Record<string, boolean>;

function readOpen(): OpenState {
  try {
    const raw = window.localStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpenState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeOpen(state: OpenState): void {
  try {
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be blocked or full: the choice just is not remembered.
  }
}

function Badge({ n, label }: { n: number; label: string }) {
  return (
    <span className="count" aria-label={label}>
      {n}
    </span>
  );
}

function NavLink({
  item,
  path,
  badge,
  word = 'pending',
}: {
  item: NavItem;
  path: string;
  badge: number;
  word?: string;
}) {
  const current = isCurrent(item.to, path);
  return (
    <Link to={item.to} {...(current ? { 'aria-current': 'page' as const } : {})}>
      <span>{item.label}</span>
      {badge > 0 && <Badge n={badge} label={`${badge} ${word}`} />}
    </Link>
  );
}

/**
 * The navigation. `top` stays as given; `items` are filed into their groups. `badges` maps a page's path to its count.
 * The group holding the current page opens whenever the page changes; the owner's own choices are kept in this browser.
 */
export function Sidebar({
  top,
  items,
  path,
  badges = {},
  badgeWords = {},
}: {
  top: readonly NavItem[];
  items: readonly NavItem[];
  path: string;
  badges?: Record<string, number>;
  /** v3 F3.4: what a page's count counts, for its label (`3 unreviewed`); `pending` when not given. */
  badgeWords?: Record<string, string>;
}) {
  const groups = groupNav(items);
  const currentGroup = groups.find((g) => g.items.some((i) => isCurrent(i.to, path)))?.key;
  const [open, setOpen] = useState<OpenState>(() => {
    const stored = readOpen();
    return currentGroup ? { ...stored, [currentGroup]: true } : stored;
  });

  // A new page opens its group (it is where the owner now is).
  useEffect(() => {
    if (currentGroup) setOpen((s) => (s[currentGroup] ? s : { ...s, [currentGroup]: true }));
  }, [path, currentGroup]);

  useEffect(() => writeOpen(open), [open]);

  const badgeOf = (to: string) => badges[to] ?? 0;

  return (
    <nav className="nav" aria-label="Main">
      <ul className="nav-top" role="list">
        {top.map((item) => (
          <li key={item.to}>
            <NavLink
              item={item}
              path={path}
              badge={badgeOf(item.to)}
              {...(badgeWords[item.to] ? { word: badgeWords[item.to] } : {})}
            />
          </li>
        ))}
      </ul>
      <ul className="nav-groups" role="list">
        {groups.map((g) => {
          const isOpen = open[g.key] === true;
          const sum = g.items.reduce((n, i) => n + badgeOf(i.to), 0);
          const listId = `nav-group-${g.key}`;
          return (
            <li key={g.key} className="nav-group" data-group={g.name}>
              <button
                type="button"
                className="nav-group-toggle"
                aria-expanded={isOpen}
                aria-controls={listId}
                onClick={() => setOpen((s) => ({ ...s, [g.key]: !isOpen }))}
              >
                <span className="chevron" aria-hidden="true" />
                <span className="nav-group-name">{g.name}</span>
                {!isOpen && sum > 0 && <Badge n={sum} label={`${sum} pending in ${g.name}`} />}
              </button>
              <ul id={listId} className="nav-group-items" role="list" hidden={!isOpen}>
                {g.items.map((item) => (
                  <li key={item.to}>
                    <NavLink item={item} path={path} badge={badgeOf(item.to)} />
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
