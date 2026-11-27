/**
 * RV3-2: a sidebar restore writes the rows of the key-value properties other than PROPERTIES (an INFOBOX, say) one by
 * one with updatePropertyRow / deletePropertyRow, with no journal pre-image (set_facts' own row writes carry one:
 * src/facts/expand.ts journalPreImage). What the restore overwrote cannot be found in the journal. (Checked and sound:
 * an edit made between the proposal and its approval is caught at approval, the proposal ends conflicted.)
 *
 * v3 F12 (ADR 0081): at scope `write` the sidebar restore runs at once as one job (no proposal to approve).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

/** v3 F12 (ADR 0081): at scope write a restore runs at once as one job; how it ended, and the job. */
async function ran(r: ToolCall) {
  expect(r.body, r.text).toMatchObject({ status: 'written' });
  const jobId = String(r.body.jobId);
  return { status: (await w!.stack.runtime.engine.wait(PROJECT, jobId, 30_000)).status, jobId };
}

type Row = { id: string; key: string; content: { text?: string }[] };
const infobox = () =>
  (w!.sidebars.pages.get(S.atlas)!.props.find((p) => p.id === 'kvinfo01') as unknown as { rows: Row[] }).rows;
const text = (key: string) =>
  infobox()
    .find((r) => r.key === key)!
    .content.map((x) => x.text ?? '')
    .join('');

async function setup() {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  // The Atlas has a second key-value property (an infobox) beside PROPERTIES.
  w.sidebars.outside(S.atlas, (sb) => {
    sb.props.push({
      ...SidebarModel.kv('kvinfo01', 'INFOBOX', [
        ['Ruler', 'Queen Mara'],
        ['Capital', 'Ashgate'],
      ]),
      rank: 'zzzz0001',
    });
  });
  const full = await w.stack.runtime.snapshots.full(PROJECT, 'manual');
  // In the app: the ruler changes.
  w.sidebars.outside(S.atlas, () => {
    infobox().find((r) => r.key === 'Ruler')!.content = [{ text: 'King Oren' }];
  });
  return full.snapshotId!;
}

it('RV3-2b: the restore’s updatePropertyRow keeps the row it replaces as a journal pre-image', async () => {
  const snap = await setup();
  const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'sidebar' });
  const res = await ran(r);
  expect(res.status).toBe('succeeded');
  expect(text('Ruler')).toBe('Queen Mara');
  const entries = w!.stack.runtime.engine.queries.journalLookup(PROJECT, {
    jobId: res.jobId,
    includePreImage: true,
    limit: 50,
  });
  const e = entries.find((x) => x.opId === 'updatePropertyRow');
  expect(e, JSON.stringify(entries.map((x) => x.opId))).toBeDefined();
  // What was overwritten ("King Oren") must be recoverable from the journal.
  expect(JSON.stringify((e as { preImage?: unknown }).preImage ?? null)).toMatch(/King Oren/);
});
