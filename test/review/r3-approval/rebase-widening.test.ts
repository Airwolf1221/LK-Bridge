/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 2.3 ("only the approved set runs") against the Amendment's A
 * (rebasing a write on a conflict part-way). A rename's block write carries every item whose occurrence is in that
 * block (`items: [a, b]`); the filter keeps the step when ANY of them is approved and trims the check's edits, so the
 * body the check works out holds only the approved occurrence. The attempts: an occurrence the owner left out (by hand,
 * or by D1 (a)'s default untick) sharing its block with an approved one, while another writer edits the same document
 * between the job's check and that write. The safe behaviour: the left-out occurrence keeps the old name whatever the
 * rebase does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approve } from '../../packs/world.js';
import { O, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import {
  NEW,
  OLD,
  PROJECT,
  approveItems,
  intercept,
  itemsOf,
  outsideEdit,
  proposeRename,
  textOf,
} from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const QS4 = /\/blocks\/qs4$/;
const QUOTED = `The plaque reads “${OLD}, keeper of charters”.`;
const TWO_PLAIN = `${OLD} catalogued the charters. ${OLD} also bound them in red leather.`;

let open: RenameWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('selective approval meets a rebase (ADR 0058 2.3 with the Amendment A)', () => {
  it('AP-01 default approval (D1 (a) leaves a quotation out): a 412 on its block never renames it', async () => {
    const w = (open = await renameWorld());
    // One paragraph, two occurrences: an ordinary sentence (ticked) and a quotation (D1 (a): left out by default).
    outsideEdit(w, O.qasr, 'qs4', `${OLD} catalogued the charters in her youth. ${QUOTED}`);
    const id = await proposeRename(w);
    const items = itemsOf(w, id).items;
    const a = items.find((i) => i.id.endsWith(':qs4:0'))!;
    const b = items.find((i) => i.id.endsWith(':qs4:1'))!;
    expect(a.selected).toBe(true);
    expect(b.selected, JSON.stringify(b)).toBe(false);
    // Another writer edits ANOTHER paragraph of Qasr's page just as the approved occurrence is sent: LegendKeeper
    // answers 412 and the write is rebased on the fresh content.
    intercept(w, 'PUT', QS4, (n) => {
      if (n === 0) outsideEdit(w, O.qasr, 'qs2', 'The reference for the Emirate of Qasr, revised.');
      return undefined;
    });
    const done = await approve(w, id); // the plan's ticks: the quotation is left out
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(itemsOf(w, id).omitted).toContain(b.id);
    const text = textOf(w, O.qasr, 'qs4');
    expect(text.startsWith(`${NEW} catalogued`), text).toBe(true);
    // SAFE: the occurrence the owner did not approve keeps the old name.
    expect(text, 'the left-out quotation was renamed by the rebase').toContain(QUOTED);
  });

  it('AP-02 an occurrence unticked by hand: an edit seen on the write’s own read never renames it', async () => {
    const w = (open = await renameWorld());
    outsideEdit(w, O.qasr, 'qs4', TWO_PLAIN);
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const second = plan.items.find((i) => i.id.endsWith(':qs4:1'))!;
    expect(second.selected).toBe(true);
    const keep = plan.items.filter((i) => i.selected && i.id !== second.id).map((i) => i.id);
    // The edit lands between the job's check and the restatement's own read inside its lock.
    intercept(w, 'GET', QS4, (n) => {
      if (n === 0) outsideEdit(w, O.qasr, 'qs2', 'The reference for the Emirate of Qasr, revised.');
      return undefined;
    });
    const done = await approveItems(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const text = textOf(w, O.qasr, 'qs4');
    expect(text.startsWith(`${NEW} catalogued`), text).toBe(true);
    // SAFE: the second sentence, unticked by the owner, is as it was.
    expect(text, 'the unticked occurrence was renamed by the rebase').toContain(`${OLD} also bound them`);
    // And the read-back did not notice either way: what it checked is recorded.
    const verify = done.job!.steps.find((s) => s.opId === 'bridge.verify');
    expect(verify?.status).toBe('succeeded');
  });

  it('AP-03 control: with no concurrent edit, the same selection leaves the unticked occurrence alone', async () => {
    const w = (open = await renameWorld());
    outsideEdit(w, O.qasr, 'qs4', TWO_PLAIN);
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const second = plan.items.find((i) => i.id.endsWith(':qs4:1'))!;
    const keep = plan.items.filter((i) => i.selected && i.id !== second.id).map((i) => i.id);
    const done = await approveItems(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const text = textOf(w, O.qasr, 'qs4');
    expect(text).toBe(`${NEW} catalogued the charters. ${OLD} also bound them in red leather.`);
    expect(w.stack.runtime.engine.skippedItems(PROJECT, done.job!.id)).toEqual([]);
  });
});
