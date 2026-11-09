/**
 * The round-trip check of one page, used by the round-trip script (scripts/markdown-roundtrip.ts) on every page of a
 * project before agents may write to it (docs/PLAN-v2.md 7, step 4). Pure: the script reads the pages.
 *
 * A page passes when blocks → Markdown → blocks gives back exactly the same JSON (ids, attributes and key order) and
 * writing the unchanged Markdown back gives an empty plan. Anything else is a failure with its first difference, so it
 * can be reproduced and fixed before it can touch real data.
 */
import { MarkdownError } from './errors.js';
import { fromMarkdown } from './index.js';
import { toMarkdown } from './render.js';
import type { KeepRegion, LkBlock } from './types.js';

export type RoundTripStage = 'toMarkdown' | 'fromMarkdown' | 'identity' | 'plan' | 'stable';

export interface RoundTripFailure {
  readonly stage: RoundTripStage;
  readonly message: string;
  /** Where the result first differs from the page, e.g. `[3].children[12].children[0].content[1].text`. */
  readonly path?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  /** The converter's error code, when it threw one. */
  readonly code?: string;
}

export interface RoundTripResult {
  readonly ok: boolean;
  readonly blocks: number;
  readonly markdownLength: number;
  readonly regions: readonly KeepRegion[];
  /** Blocks the self-check had to show as keep regions (exact, but worth reporting: Markdown could not express them). */
  readonly fallbacks: readonly string[];
  readonly failure?: RoundTripFailure;
  readonly ms: number;
}

const short = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…` : v;
};

/** The first place two JSON values differ (key order included), or null when they are identical. */
export function firstDifference(
  expected: unknown,
  actual: unknown,
  path = '',
): { path: string; expected: unknown; actual: unknown } | null {
  if (expected === actual) return null;
  const te = Array.isArray(expected) ? 'array' : typeof expected;
  const ta = Array.isArray(actual) ? 'array' : typeof actual;
  if (te !== ta || expected === null || actual === null || (te !== 'object' && te !== 'array')) {
    return Object.is(expected, actual)
      ? null
      : { path: path || '(root)', expected: short(expected), actual: short(actual) };
  }
  if (te === 'array') {
    const e = expected as unknown[];
    const a = actual as unknown[];
    for (let i = 0; i < Math.max(e.length, a.length); i++) {
      if (i >= e.length || i >= a.length)
        return { path: `${path}[${i}]`, expected: short(e[i]), actual: short(a[i]) };
      const d = firstDifference(e[i], a[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const eo = expected as Record<string, unknown>;
  const ao = actual as Record<string, unknown>;
  const ek = Object.keys(eo);
  const ak = Object.keys(ao);
  for (let i = 0; i < Math.max(ek.length, ak.length); i++) {
    if (ek[i] !== ak[i]) {
      const k = ek[i] ?? ak[i]!;
      return {
        path: path ? `${path}.${k}` : k,
        expected: ek[i] === undefined ? '(no field)' : `field order: ${ek.join(', ')}`,
        actual: ak[i] === undefined ? '(no field)' : `field order: ${ak.join(', ')}`,
      };
    }
    const k = ek[i]!;
    const d = firstDifference(eo[k], ao[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

function countBlocks(blocks: readonly unknown[]): number {
  let n = 0;
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      n++;
      const kids = (b as { children?: unknown } | null)?.children;
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(blocks);
  return n;
}

/** Checks one page. Never throws: a converter error is a failure of the page. */
export function checkRoundTrip(blocks: readonly LkBlock[]): RoundTripResult {
  const t0 = performance.now();
  const base = {
    blocks: countBlocks(blocks),
    markdownLength: 0,
    regions: [] as KeepRegion[],
    fallbacks: [] as string[],
  };
  const done = (r: Omit<RoundTripResult, 'ms'>): RoundTripResult => ({
    ...r,
    ms: Math.round(performance.now() - t0),
  });
  const fail = (stage: RoundTripStage, e: unknown, extra: Partial<RoundTripFailure> = {}) =>
    done({
      ...base,
      ok: false,
      failure: {
        stage,
        message: e instanceof Error ? e.message : String(e),
        ...(e instanceof MarkdownError ? { code: e.code } : {}),
        ...extra,
      },
    });
  const before = JSON.stringify(blocks);
  let md: string;
  try {
    const r = toMarkdown(blocks);
    md = r.markdown;
    base.markdownLength = md.length;
    base.regions = [...r.regions];
    base.fallbacks = r.warnings
      .filter((w) => w.code === 'RENDERED_AS_KEEP_REGION')
      .map((w) => w.at ?? '(no id)');
  } catch (e) {
    return fail('toMarkdown', e);
  }
  let back: ReturnType<typeof fromMarkdown>;
  try {
    back = fromMarkdown(md, blocks);
  } catch (e) {
    return fail('fromMarkdown', e);
  }
  if (JSON.stringify(blocks) !== before)
    return fail('identity', 'the conversion changed the page it was given');
  const diff = firstDifference(blocks, back.blocks);
  if (diff) return fail('identity', 'blocks → Markdown → blocks is not the same page', diff);
  if (!back.plan.empty) {
    const what = [
      ...back.plan.changed.map((c) => `changed ${c.kind} ${c.id ?? ''}`),
      ...back.plan.added.map((a) => `added ${a.kind}`),
      ...back.plan.removed.map((r) => `removed ${r.kind} ${r.id ?? ''}`),
      ...back.plan.moved.map((m) => `moved ${m.kind} ${m.id ?? ''}`),
    ];
    return fail(
      'plan',
      `writing the unchanged Markdown back would not be empty: ${what.slice(0, 5).join('; ')}`,
    );
  }
  try {
    const again = toMarkdown(back.blocks).markdown;
    if (again !== md) {
      const i = [...again].findIndex((c, k) => c !== md[k]);
      return fail('stable', 'converting the result again does not give the same Markdown', {
        path: `character ${i}`,
        expected: md.slice(Math.max(0, i - 40), i + 40),
        actual: again.slice(Math.max(0, i - 40), i + 40),
      });
    }
  } catch (e) {
    return fail('stable', e);
  }
  return done({ ...base, ok: true });
}

/**
 * The smallest part of a failing page that still fails: the first top-level block that fails on its own, else the
 * whole page.
 */
export function minimalRepro(
  blocks: readonly LkBlock[],
  check: (b: readonly LkBlock[]) => RoundTripResult = checkRoundTrip,
): LkBlock[] {
  for (const b of blocks) if (!check([b]).ok) return [b];
  return [...blocks];
}
