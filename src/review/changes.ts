/**
 * The Review page's diffs (v3 F3.4, ADR 0055 decision A): each target of a direct-write job shown as the change it made,
 * in the same forms a proposal shows (a page's Markdown before and after, a facts table, link lists, field changes).
 * Pure: from the targets (src/review/targets.ts) and names the bridge already holds; no LegendKeeper request.
 */
import { valueText } from '../facts/sidebar.js';
import type { CollectionState, RowState } from '../jobs/sidebar-state.js';
import { stableJson } from '../jobs/sidebar-state.js';
import { toMarkdown, type DocumentInput } from '../markdown/index.js';
import { markdownDiff, type MarkdownDiff } from '../pages/diff.js';
import type { Target } from './targets.js';

type Obj = Record<string, unknown>;

/** One target's change, for the dashboard. */
export interface ChangeView {
  readonly key: string;
  readonly kind: Target['kind'];
  readonly what: string;
  readonly steps: readonly number[];
  readonly uncertain: boolean;
  /** Text: the page's Markdown before and after, in hunks (as a proposal's). */
  readonly markdownDiff?: MarkdownDiff;
  readonly document?: { readonly id: string; readonly name: string | null };
  /** Facts: every row that changed (key, before, after). */
  readonly facts?: readonly { readonly key: string; readonly before: string | null; readonly after: string | null }[];
  /** Link collections: the pages added and removed. */
  readonly links?: readonly {
    readonly title: string;
    readonly added: readonly { readonly id: string; readonly name: string | null }[];
    readonly removed: readonly { readonly id: string; readonly name: string | null }[];
  }[];
  /** Any other change, field by field (a page's name or tags, a move, a chronology row, an image's folder). */
  readonly fields?: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
  /** Not reverted: why, and what to use instead. */
  readonly notRevertible?: {
    readonly reason: string;
    readonly deletion: boolean;
    readonly creation: boolean;
    readonly instead: string | null;
    readonly journal: readonly number[];
  };
}

export interface ChangeNames {
  readonly pageName?: (id: string) => string | null;
  readonly folderName?: (id: string | null) => string | null;
}

const md = (blocks: readonly unknown[]): string => {
  try {
    return toMarkdown({ blocks: [...blocks] } as DocumentInput, { selfCheck: false }).markdown;
  } catch {
    return JSON.stringify(blocks, null, 1);
  }
};

const rowText = (r: RowState | undefined): string | null => (r ? valueText(r.content) : null);

/** The rows that differ between two states (by id, else by key), in the later state's order. */
export function factRows(
  before: readonly RowState[],
  after: readonly RowState[],
): { key: string; before: string | null; after: string | null }[] {
  const out: { key: string; before: string | null; after: string | null }[] = [];
  const keyOf = (r: RowState) => r.key.trim().toLowerCase();
  const match = (r: RowState, list: readonly RowState[]) =>
    (r.id !== null ? list.find((x) => x.id === r.id) : undefined) ?? list.find((x) => keyOf(x) === keyOf(r));
  for (const a of after) {
    const b = match(a, before);
    if (!b) out.push({ key: a.key, before: null, after: rowText(a) });
    else if (stableJson(b.content) !== stableJson(a.content) || b.key !== a.key)
      out.push({ key: a.key, before: rowText(b), after: rowText(a) });
  }
  for (const b of before) if (!match(b, after)) out.push({ key: b.key, before: rowText(b), after: null });
  return out;
}

function linkDiff(
  before: CollectionState,
  after: CollectionState,
  name: (id: string) => string | null,
): { added: { id: string; name: string | null }[]; removed: { id: string; name: string | null }[] } {
  const k = (i: { resourceId: string; documentId: string | null }) => `${i.resourceId}/${i.documentId ?? ''}`;
  const b = new Set(before.items.map(k));
  const a = new Set(after.items.map(k));
  return {
    added: after.items.filter((i) => !b.has(k(i))).map((i) => ({ id: i.resourceId, name: name(i.resourceId) })),
    removed: before.items.filter((i) => !a.has(k(i))).map((i) => ({ id: i.resourceId, name: name(i.resourceId) })),
  };
}

/** One target as the change it made. */
export function changeView(t: Target, n: ChangeNames = {}): ChangeView {
  const base = { key: t.key, kind: t.kind, what: t.what, steps: t.steps, uncertain: t.uncertain === true };
  const pageName = (id: string) => n.pageName?.(id) ?? null;
  switch (t.kind) {
    case 'text':
      return {
        ...base,
        document: { id: t.documentId, name: t.documentName },
        markdownDiff: markdownDiff(md(t.before), md(t.left[t.left.length - 1] ?? t.before)),
      };
    case 'block':
      return {
        ...base,
        document: { id: t.documentId, name: null },
        markdownDiff: markdownDiff(
          t.before ? md([t.before]) : '',
          t.change === 'updated' && t.before ? md([{ ...t.before, ...t.sent, id: t.blockId }]) : md([t.sent]),
        ),
      };
    case 'facts':
      return {
        ...base,
        ...(t.rowsBefore && t.rowsLeft ? { facts: factRows(t.rowsBefore, t.rowsLeft) } : {}),
        ...(t.collections.length > 0
          ? {
              links: t.collections.map((c) => ({ title: c.title, ...linkDiff(c.before, c.left, pageName) })),
            }
          : {}),
      };
    case 'lmr':
      return { ...base, facts: [{ key: t.rowKey, before: t.before, after: t.after }] };
    case 'resource':
      return {
        ...base,
        fields: Object.keys(t.left).map((f) => ({
          field: f,
          before: (t.before as Obj)[f] ?? null,
          after: (t.left as Obj)[f] ?? null,
        })),
      };
    case 'move':
      return {
        ...base,
        fields: [
          {
            field: 'parent',
            before: t.before.parentId ? (pageName(t.before.parentId) ?? t.before.parentId) : '(the top level)',
            after: t.left.parentId ? (pageName(t.left.parentId) ?? t.left.parentId) : '(the top level)',
          },
        ],
      };
    case 'chronology': {
      const fields: { field: string; before: unknown; after: unknown }[] = [];
      for (const w of t.record.target.writes) {
        if (w.kind === 'row.insert') fields.push({ field: `${w.age} table row`, before: null, after: rowLine(w.texts) });
        if (w.kind === 'row.replace')
          fields.push({ field: `${w.age} table row`, before: rowLine(w.before), after: rowLine(w.texts) });
        if (w.kind === 'event.create')
          fields.push({ field: `${w.age} timeline event`, before: null, after: String(w.body.name ?? w.eventId) });
        if (w.kind === 'event.update')
          fields.push({ field: `${w.age} timeline event`, before: t.oldEvents[w.eventId] ?? null, after: w.fields });
        if (w.kind === 'count')
          fields.push({ field: `${w.age} count (Main table)`, before: null, after: `${w.delta > 0 ? '+' : ''}${w.delta}` });
      }
      return { ...base, fields };
    }
    case 'image': {
      const folder = (id: string | null) => n.folderName?.(id) ?? (id ?? '(the library’s root)');
      return {
        ...base,
        fields: [
          {
            field: 'place',
            before: t.from.kind === 'created' ? 'staged on the bridge (not in LegendKeeper yet)' : `${folder(t.from.folderId)}${t.from.isHidden ? ', hidden' : ''}`,
            after: `${folder(t.left.folderId)}${t.left.isHidden ? ', hidden' : ''}`,
          },
          ...(t.from.kind === 'asset' && t.from.name !== t.left.name
            ? [{ field: 'name', before: t.from.name, after: t.left.name }]
            : []),
        ],
      };
    }
    case 'none':
      return {
        ...base,
        notRevertible: {
          reason: t.reason,
          deletion: t.deletion === true,
          creation: t.creation === true,
          instead: t.instead ?? null,
          journal: t.journal,
        },
      };
  }
}

const rowLine = (t: { description: string; date: string; kcy: string }) =>
  `${t.description} | ${t.date} | ${t.kcy}`;
