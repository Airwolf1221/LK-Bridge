/**
 * v3 F10 (ADR 0078): the chronology repair's test world. D1's chronology world (the REAL server, runtime, engine, tree
 * and the Universal Chronology against the mock LegendKeeper) built on the pack world (the Arkona pack attached with
 * its seed switches), with F5b's Repository Automation governance, so the automation runs as it does on Arkona. The
 * other proposal-only codes are switched Off, so a run is the chronology codes' alone; the chronology codes keep their
 * default (Propose).
 */
import { PROPOSE_ONLY } from '../../src/automation/registry.js';
import { withAutomationGovernance, type AutomationWorld } from '../automation/world.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';
import { packWorld } from '../packs/world.js';
import { PROJECT } from '../tools/helpers.js';

export { PROJECT };
export const FOURTH = 'Fourth Arkonan Age';
export const LIMITS = { 'key-min': 5000, 'write-min': 2000 } as const;

type Obj = Record<string, unknown>;

export type F10World = ChronologyWorld &
  Pick<AutomationWorld, 'governanceDoc' | 'governanceBlocks' | 'editAutomationPage'>;

export async function f10World(
  o: { readonly env?: Record<string, string>; readonly checkDelayMs?: number } = {},
): Promise<F10World> {
  const base = await chronologyWorld({
    base: (x) => packWorld({ ...x, toolModes: 'seed' }),
    env: { LK_TIER_LIMITS: JSON.stringify(LIMITS), ...(o.env ?? {}) },
    limits: LIMITS,
    // CHRONOLOGY_CHECK_DELAY_MS, shortened for the end-to-end run.
    ...(o.checkDelayMs !== undefined ? { tools: { chronologyCheckDelayMs: o.checkDelayMs } } : {}),
  });
  const w = await withAutomationGovernance(base);
  const a = w.stack.runtime.automation;
  for (const e of PROPOSE_ONLY)
    if (e.source !== 'chronology') a.store.setMode(PROJECT, e.code, 'off', 'owner');
  return w;
}

/** An age table's rows as the mock holds them (the stored blocks themselves: an edit "in the app"). */
export function tableRows(w: ChronologyWorld, age: string): Obj[] {
  const doc = w.repo.blocks.get(w.ages[age]!.table)! as { version: number; blocks: Obj[] };
  const table = doc.blocks.find((b) => b.kind === 'table')!;
  return (table.children as Obj[]).slice(1);
}

/** The text of a row's cell (0: Historical Event, 1: Date, 2: KCY). */
export function cellText(row: Obj, i: number): string {
  const cell = (row.children as Obj[])[i]!;
  const para = (cell.children as Obj[])[0]!;
  return ((para.content as Obj[] | undefined) ?? [])
    .map((r) => (typeof r.text === 'string' ? r.text : ''))
    .join('');
}

/** Sets a row's cell "in the app" (no request; the document's version moves on). */
export function setCellInApp(w: ChronologyWorld, age: string, row: Obj, i: number, text: string): void {
  const cell = (row.children as Obj[])[i]!;
  ((cell.children as Obj[])[0] as Obj).content = [{ text }];
  (w.repo.blocks.get(w.ages[age]!.table)! as { version: number }).version++;
}

/** Moves a row "in the app" to another position among the data rows. */
export function moveRowInApp(w: ChronologyWorld, age: string, from: number, to: number): void {
  const doc = w.repo.blocks.get(w.ages[age]!.table)! as { version: number; blocks: Obj[] };
  const table = doc.blocks.find((b) => b.kind === 'table')!;
  const kids = table.children as Obj[];
  const [r] = kids.splice(from + 1, 1);
  kids.splice(to + 1, 0, r!);
  doc.version++;
}

export const rowByDate = (w: ChronologyWorld, age: string, date: string): Obj => {
  const r = tableRows(w, age).find((x) => cellText(x, 1) === date);
  if (!r)
    throw new Error(
      `no ${age} row dated ${date}: ${tableRows(w, age)
        .map((x) => cellText(x, 1))
        .join(', ')}`,
    );
  return r;
};

export async function check(w: ChronologyWorld) {
  await w.stack.runtime.chronology.check(PROJECT, 'manual', 'P0');
  return w.stack.runtime.chronology.store.lastCheck(PROJECT)!;
}

export async function approve(w: ChronologyWorld, id: string) {
  const proposals = w.stack.runtime.policy.proposals;
  await w.stack.runtime.policy.commands.approve('owner', id);
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  return proposals.get(id)!;
}
