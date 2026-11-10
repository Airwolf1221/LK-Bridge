/** Helpers for the Markdown converter tests. */
import fc from 'fast-check';
import { parseDrafts, type Draft } from '../../src/markdown/parse.js';
import type { LkBlock } from '../../src/markdown/types.js';

/** What the parser makes of Markdown, as projections (keep regions as `{ kind: '@keep', id }`), without a base page. */
export function parsedProjection(md: string): LkBlock[] {
  const conv = (d: Draft): LkBlock => {
    if (d.t === 'keep') return { kind: '@keep', id: d.id };
    if (d.t === 'raw') return { kind: '@raw', block: d.block };
    return d.children ? { ...d.own, children: d.children.map(conv) } : d.own;
  };
  return parseDrafts(md).drafts.map(conv);
}

/** Removes every `id` (to compare blocks made from Markdown alone with the originals). */
export function stripIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripIds) as T;
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== 'id') out[k] = stripIds(x);
  return out as T;
}

/** All blocks of a tree, depth first. */
export function allBlocks(blocks: readonly LkBlock[]): LkBlock[] {
  const out: LkBlock[] = [];
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      if (typeof b !== 'object' || b === null) continue;
      out.push(b as LkBlock);
      const kids = (b as LkBlock).children;
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(blocks);
  return out;
}

export const p = (text: string, id?: string): LkBlock => ({
  ...(id ? { id } : {}),
  kind: 'paragraph',
  content: text === '' ? [] : [{ text }],
});
export const h = (level: number, text: string, id?: string): LkBlock => ({
  ...(id ? { id } : {}),
  kind: 'heading',
  level,
  content: [{ text }],
});

/**
 * fast-check parameters from the environment: FC_RUNS (runs per property, default `runs`), FC_SEED and FC_PATH (replay
 * one failure: the seed and path a failure logs; FC_PATH needs FC_SEED).
 */
export function fcParams(runs = 300): { numRuns: number; seed?: number; path?: string } {
  const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
  const path = process.env.FC_PATH || undefined;
  return {
    numRuns: Number(process.env.FC_RUNS ?? runs),
    ...(seed !== undefined ? { seed } : {}),
    ...(seed !== undefined && path !== undefined ? { path } : {}),
  };
}

/**
 * `fc.assert`, but a failure is reproducible from the log alone: the seed, the path and the shrunk counterexample are
 * printed (with the command that replays it) before fast-check's own report is thrown. Paste the counterexample into
 * the property's `examples` to keep it as a fixed regression case.
 */
export function assertProperty<Ts>(
  name: string,
  property: fc.IProperty<Ts>,
  params: fc.Parameters<Ts>,
): void {
  const details = fc.check(property, params);
  if (!details.failed) return;
  const replay = `FC_SEED=${details.seed} FC_PATH="${details.counterexamplePath ?? ''}"`;
  console.error(
    [
      `fast-check: the property "${name}" failed after ${details.numRuns} run(s), ${details.numShrinks} shrink(s).`,
      `  seed: ${details.seed}`,
      `  path: ${details.counterexamplePath ?? '(none)'}`,
      `  replay: ${replay} npx vitest run test/markdown -t ${JSON.stringify(name)}`,
      `  counterexample (for examples): ${details.counterexample ? fc.stringify(details.counterexample) : '(none)'}`,
    ].join('\n'),
  );
  throw new Error(`${fc.defaultReportMessage(details)}\n(${replay})`);
}
