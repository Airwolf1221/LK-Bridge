/**
 * v3 F9 (ADR 0074): the classification of every maintenance caller, kept honest by reading the source.
 *
 * - each routine caller still asks for P3 (and never P4), named by its file and the function the request is made in;
 * - each bulk caller asks for P4 (its class constant, used where its requests are made);
 * - the guard: a NEW `'P3'` in a file this session classified as bulk fails here, until it is classified (added to
 *   `BULK_FILES` with the reason in ADR 0074), so a whole-repository pass cannot slip back into P3 unnoticed.
 *
 * The behaviour behind it is tested where it runs: test/f9/snapshot-classes, pass-classes and link-sweep-class (bulk),
 * test/automation/engine, test/blockids/sweep, test/chronology/check and test/maintenance/scheduler (routine at P3).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const SIG =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?(?:(?:private|public|protected|static|readonly|async|get)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const CONST_FN =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*(?::\s*[^=]+)?=>/;
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'await',
  'new',
  'typeof',
  'function',
]);

/** The function each code (not comment) occurrence of `literal` is in, by the nearest declaration above it. */
function sites(file: string, literal: string): string[] {
  const lines = read(file).split('\n');
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!l.includes(literal) || /^\s*(\*|\/\/|\/\*)/.test(l)) return;
    let name = '(top level)';
    for (let j = i; j >= 0; j--) {
      const t = lines[j]!;
      if (!/^ {0,4}\S/.test(t)) continue; // a declaration at the top level or a class member's
      const m = CONST_FN.exec(t) ?? SIG.exec(t);
      if (m && !KEYWORDS.has(m[1]!)) {
        name = m[1]!;
        break;
      }
    }
    out.push(name);
  });
  return out.sort();
}

/**
 * The files holding a bulk caller, and the routine `'P3'` requests each may still make (by function, with how many).
 * Anything else at P3 in these files is a new caller: classify it (here and in ADR 0074) before it can pass.
 */
const BULK_FILES: Record<string, { readonly bulk: string; readonly routineP3: readonly string[] }> = {
  'src/snapshots/service.ts': { bulk: 'FULL_SNAPSHOT_PRIORITY', routineP3: [] },
  'src/lifecycle/index.ts': { bulk: 'LINK_SWEEP_PRIORITY', routineP3: [] },
  'src/maintenance/asset-jobs.ts': { bulk: "budgetClass: 'P4'", routineP3: [] },
  'src/assets/service.ts': {
    bulk: 'ASSET_PASS_PRIORITY',
    // A finished build's job record (a job row, P0 to P3), and the re-reads after a bridge write (retried).
    routineP3: ['processPending', 'recordPassJob'],
  },
  'src/tree/service.ts': {
    bulk: 'passPriority(',
    // passPriority itself (the listing and the sweep), a build's job record, the root suggestion's one listing, and
    // the re-reads after a bridge write (retried).
    routineP3: ['findRoot', 'passPriority', 'passPriority', 'processPending', 'recordPassJob'],
  },
};

/** The routine callers (stay P3): file, the function the P3 request is made in, and why it is routine. */
const ROUTINE: readonly (readonly [file: string, fn: string, why: string])[] = [
  ['src/automation/service.ts', 'governanceState', 'automation: the governance reads before a run'],
  ['src/automation/service.ts', 'applyOne', 'automation: one fix (a page, re-checked live, then written)'],
  ['src/automation/service.ts', 'guarded', 'automation: a fix under the page lock'],
  ['src/automation/service.ts', 'proposeAll', 'automation: one proposal per code'],
  ['src/automation/service.ts', 'budgetWaits', 'automation: whether the P3 budget says wait'],
  ['src/blockids/service.ts', 'dryRun', 'block-id upkeep: the dry run’s estimate'],
  ['src/blockids/service.ts', 'read', 'block-id upkeep: one document’s blocks'],
  ['src/blockids/service.ts', 'write', 'block-id upkeep: one document, its own job'],
  ['src/blockids/service.ts', 'budgetWaits', 'block-id upkeep: whether the P3 budget says wait'],
  ['src/chronology/index.ts', 'check', 'chronology on demand and its weekly check (about 15 requests)'],
  ['src/maintenance/scheduler.ts', 'executeOne', 'a maintenance job’s own engine calls and its job record'],
  ['src/packs/retag/service.ts', 'submitApply', 'automation’s retag batch'],
  ['src/snapshots/rehearsal.ts', 'job', 'the restore rehearsal’s jobs (in a sandbox project; job rows)'],
  ['src/tree/service.ts', 'processPending', 'the tree’s re-reads after a bridge write'],
  ['src/tree/service.ts', 'findRoot', 'the AI REPOSITORY root suggestion (one listing)'],
  ['src/assets/service.ts', 'processPending', 'the asset tree’s re-reads after a bridge write'],
];

describe('bulk callers ask for P4', () => {
  it.each(Object.entries(BULK_FILES))('%s', (file, c) => {
    const src = read(file);
    expect(src).toContain(c.bulk);
    expect(src).toMatch(/'P4'/);
  });
});

describe('routine callers stay P3', () => {
  it.each(ROUTINE)('%s %s (%s)', (file, fn) => {
    expect(sites(file, "'P3'")).toContain(fn);
    expect(sites(file, "'P4'")).not.toContain(fn);
  });
});

describe('the guard: no new P3 caller in a file classified as bulk', () => {
  it.each(Object.entries(BULK_FILES))('%s', (file, c) => {
    expect(sites(file, "'P3'"), `classify any new P3 request in ${file} (ADR 0074)`).toEqual(
      [...c.routineP3].sort(),
    );
  });

  it('the guard sees a P3 request (it would fail on one added to a bulk pass)', () => {
    // The scanner itself: a request inside a function is attributed to that function.
    expect(sites('src/tree/service.ts', "'P3'")).toContain('processPending');
    expect(sites('src/snapshots/service.ts', 'FULL_SNAPSHOT_PRIORITY')).toContain('runPages');
  });
});
