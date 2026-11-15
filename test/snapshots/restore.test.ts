/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- parsed tool results */
/**
 * v2 E1a (ADR 0042): restore_snapshot, always a proposal (here at scope `write`), approved by the owner and run through
 * the ordinary machinery: every document type, the sidebar, a deleted page (undeleted, or recreated with its original or
 * new ids), the canon, lifecycle and decision-5 guards, `unsupported` blocks and inline icons, and conflicts at approval
 * and inside the lock.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function setup(o: Parameters<typeof snapshotsWorld>[0] = {}) {
  w = await snapshotsWorld(o);
  c = await w.stack.connect();
  const full = await w.stack.runtime.snapshots.full(PROJECT, 'manual');
  return full.snapshotId!;
}
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

/** As the owner does on the Proposals page: approve (or accept as canon), then wait for the job. */
async function approve(
  r: ToolCall,
  asCanon = false,
): Promise<{ state: string; job: { status: string; lastError: unknown } | null }> {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  if (asCanon) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  const job = p.jobId ? w!.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  return { state: p.state, job: job ? { status: job.status, lastError: job.lastError } : null };
}
const mainBlocks = () =>
  w!.repo.blocks.get(w!.d.main)!.blocks as { id: string; kind: string; content?: { text?: string }[] }[];
const texts = () => mainBlocks().map((b) => b.content?.map((r) => r.text ?? '').join('') ?? `[${b.kind}]`);

describe('restore_snapshot: a page document', () => {
  it('is always a proposal (even at scope write); approved, the page is back, unsupported blocks echoed by id', async () => {
    const snap = await setup();
    const before = texts();
    await call('write_page', {
      page: S.atlas,
      mode: 'replace_section',
      section: 'Notes',
      markdown: '## Notes\n\nRewritten notes.',
    });
    expect(texts()).not.toEqual(before);
    const dry = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
      dryRun: true,
    });
    expect(dry.body).toMatchObject({ status: 'dry_run', writes: 1 });
    expect(dry.body.changes[0].diff).toMatch(/\+First notes\./);
    expect(dry.body.kept).toEqual([expect.objectContaining({ what: 'unsupported block aun1' }) as unknown]);
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
    });
    expect(r.body.status).toBe('proposal_captured');
    expect(r.body.hint).toMatch(/always a proposal/);
    expect(texts()).not.toEqual(before); // nothing written yet
    expect(await approve(r)).toMatchObject({ state: 'executed' });
    expect(texts()).toEqual(before);
    expect(mainBlocks().find((b) => b.id === 'aun1')).toEqual({ id: 'aun1', kind: 'unsupported' });
    const p = w!.stack.runtime.restores.list(PROJECT)[0]!;
    expect(p).toMatchObject({ scope: 'document', state: 'executed', pageId: S.atlas });
  });

  it('an unsupported block no longer on the page is listed as lost; one added since is kept (at the end)', async () => {
    const snap = await setup();
    // In the app: the unsupported block goes, another comes.
    const blocks = mainBlocks().filter((b) => b.id !== 'aun1');
    blocks.push({ id: 'aun2', kind: 'unsupported' });
    blocks.find((b) => b.id === 'ap2')!.content = [{ text: 'Notes rewritten in the app.' }];
    w!.repo.blocks.set(w!.d.main, { version: 9, blocks });
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
    });
    expect(r.body.cannotRestore).toEqual([
      expect.objectContaining({ what: 'unsupported block aun1' }) as unknown,
    ]);
    expect(r.body.kept).toEqual([expect.objectContaining({ what: 'unsupported block aun2' }) as unknown]);
    await approve(r);
    const ids = mainBlocks().map((b) => b.id);
    expect(ids).not.toContain('aun1');
    expect(ids.at(-1)).toBe('aun2');
    expect(texts()).toContain('First notes.');
  });

  it('a page that now holds an inline icon is restored block by block around it (E4): the icon paragraph stays as it is, and is listed', async () => {
    // E1a refused this page (RESTORE_NOT_WRITABLE: the whole document cannot be written back). v2 E4 (ADR 0046)
    // restores the other blocks one by one and leaves the icon paragraph as the page holds it now.
    const snap = await setup();
    const atSnapshot = structuredClone(mainBlocks());
    mainBlocks()[1]!.content!.push({ icon: 'star' } as never);
    // Another block is changed after the snapshot too: that one comes back.
    const other = mainBlocks().findIndex((b, i) => i > 1 && b.kind === 'paragraph');
    expect(other).toBeGreaterThan(1);
    mainBlocks()[other]!.content = [{ text: 'Changed after the snapshot.' }];
    const iconBlock = structuredClone(mainBlocks()[1]);
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
    });
    expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
    expect(JSON.stringify(r.body)).toMatch(/inline icon/);
    const since = w!.repo.mutations.length;
    expect(await approve(r)).toMatchObject({ state: 'executed' });
    const ops = w!.repo.mutations.slice(since).map((m) => m.op);
    expect(ops).toContain('replaceBlock');
    expect(ops).not.toContain('replaceDocumentBlocks');
    expect(mainBlocks()[1]).toEqual(iconBlock); // the icon paragraph, untouched
    expect(mainBlocks()[other]).toEqual(atSnapshot[other]); // the other block, back as it was
  });

  it('an inline icon in the snapshot that the page no longer has is restored without it, and listed as lost', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    mainBlocks()[1]!.content!.push({ icon: 'star' } as never);
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    mainBlocks()[1]!.content = [{ text: 'Plain now.' }];
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
      dryRun: true,
    });
    expect(r.body.cannotRestore).toEqual([
      expect.objectContaining({ what: expect.stringMatching(/inline icon/) as unknown }) as unknown,
    ]);
  });

  it('a version change between capture and approval: conflicted at approval, nothing written', async () => {
    const snap = await setup();
    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Later text.' });
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Main',
    });
    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Even later.' });
    const after = texts();
    expect((await approve(r)).state).toBe('conflicted');
    expect(texts()).toEqual(after);
  });
});

describe('restore_snapshot: maps, timelines, boards and blank documents', () => {
  it('a map: features deleted, added and changed since come back as they were; checked inside the lock', async () => {
    const snap = await setup();
    const feats = w!.features.get(w!.d.map)!;
    feats.splice(
      feats.findIndex((f) => f.id === 'pin00002'),
      1,
    );
    feats.find((f) => f.id === 'pin00001')!.name = 'Ashgate (renamed)';
    feats.push({ id: 'new00001', type: 'pin', name: 'Newcomer', pos: [-1, 1], rank: 'a9' });
    w!.docExtra.set(w!.d.map, {
      ...w!.docExtra.get(w!.d.map),
      mapImage: {
        assetId: S.imgSea,
        url: w!.url(S.imgSea),
        width: 64,
        height: 32,
        bounds: [
          [-32, 0],
          [0, 64],
        ],
      },
    });
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    expect(r.body.writes).toBe(4); // delete, create, update, and the map image
    expect((await approve(r)).state).toBe('executed');
    const now = w!.features.get(w!.d.map)!;
    expect(now.map((f) => f.id).sort()).toEqual(['fold0001', 'pin00001', 'pin00002', 'reg00001']);
    expect(now.find((f) => f.id === 'pin00001')!.name).toBe('Ashgate');
    expect(now.find((f) => f.id === 'pin00002')).toMatchObject({ parentId: 'fold0001', pos: [-40, 60] });
    expect((w!.docExtra.get(w!.d.map)!.mapImage as { assetId: string }).assetId).toBe(S.imgMap);
  });

  it('a map changed after the approval’s re-read: the check inside the lock refuses, conflicted, nothing written', async () => {
    const snap = await setup();
    w!.features.get(w!.d.map)!.find((f) => f.id === 'pin00001')!.name = 'Changed once';
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
    });
    // Features carry no version, so the approval cannot see this; the job's own check inside the lock does.
    w!.features.get(w!.d.map)!.find((f) => f.id === 'pin00002')!.name = 'Changed by someone else';
    const res = await approve(r);
    expect(res.state).toBe('conflicted');
    expect(w!.features.get(w!.d.map)!.find((f) => f.id === 'pin00001')!.name).toBe('Changed once');
  });

  it('a timeline: lanes and events back (an event deleted, one changed, one added, a lane removed)', async () => {
    const snap = await setup();
    const ev = w!.events.get(w!.d.chronicle)!;
    ev.splice(
      ev.findIndex((e) => e.id === 'evt00002'),
      1,
    );
    ev.find((e) => e.id === 'evt00001')!.name = 'Founding (renamed)';
    ev.push({
      id: 'evt00009',
      laneId: 'lane0001',
      type: 'event',
      name: 'Spurious',
      start: 900,
      end: 900,
      detail: 1,
      rank: 'z',
    });
    w!.lanes.get(w!.d.chronicle)!.push({ id: 'lane0009', name: 'Extra lane', rank: 'c' });
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Chronicle',
    });
    expect((await approve(r)).state).toBe('executed');
    expect(
      w!.events
        .get(w!.d.chronicle)!
        .map((e) => e.id)
        .sort(),
    ).toEqual(['evt00001', 'evt00002', 'evt00003']);
    expect(w!.events.get(w!.d.chronicle)!.find((e) => e.id === 'evt00001')!.name).toBe('Founding of Ashgate');
    expect(
      w!.lanes
        .get(w!.d.chronicle)!
        .map((l) => l.id)
        .sort(),
    ).toEqual(['lane0001', 'lane0002']);
  });

  it('a board: shapes, bindings and assets back with If-Match (its pages cannot be written, and are listed)', async () => {
    const snap = await setup();
    const b = w!.boards.get(w!.d.plot)!;
    b.content.shapes = (b.content.shapes as unknown[]).slice(0, 1);
    b.content.bindings = [];
    b.version++;
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Plot',
    });
    expect((await approve(r)).state).toBe('executed');
    expect((w!.boards.get(w!.d.plot)!.content.shapes as unknown[]).length).toBe(3);
    expect((w!.boards.get(w!.d.plot)!.content.bindings as unknown[]).length).toBe(1);
  });

  it('a blank document: its settings (a rename undone)', async () => {
    const snap = await setup();
    w!.repo.docs.get(w!.d.notes)!.name = 'Scribbles';
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: w!.d.notes,
    });
    expect((await approve(r)).state).toBe('executed');
    expect(w!.repo.docs.get(w!.d.notes)!.name).toBe('Notes');
  });

  it('scope page: every document the page had, in one proposal; a document added since is left alone (decision 5)', async () => {
    const snap = await setup();
    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Changed.' });
    w!.features
      .get(w!.d.map)!
      .push({ id: 'new00002', type: 'pin', name: 'Another', pos: [-2, 2], rank: 'a8' });
    const added = w!.repo.outside.addDocument(S.atlas, 'Added later', 'page');
    w!.repo.blocks.set(added.id, {
      version: 1,
      blocks: [{ id: 'x1', kind: 'paragraph', content: [{ text: 'mine' }] }],
    });
    const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'page' });
    expect(r.body.notRestored).toEqual([
      expect.objectContaining({ what: 'document Added later' }) as unknown,
    ]);
    expect((await approve(r)).state).toBe('executed');
    expect(w!.features.get(w!.d.map)!.some((f) => f.id === 'new00002')).toBe(false);
    expect(texts()).not.toContain('Changed.');
    expect(w!.repo.blocks.get(added.id)!.blocks).toEqual([
      { id: 'x1', kind: 'paragraph', content: [{ text: 'mine' }] },
    ]);
  });

  it('nothing to do when the page already matches the snapshot: no proposal', async () => {
    const snap = await setup();
    const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'page' });
    expect(r.body.status).toBe('nothing_to_do');
  });
});

describe('restore_snapshot: the sidebar and the guards', () => {
  it('facts and links back to the snapshot (by set_facts’ planner, with its check and verify)', async () => {
    const snap = await setup();
    await call('set_facts', {
      page: S.atlas,
      facts: { Scope: 'Changed scope', Added: 'new row', Region: null },
      links: { Dependencies: { add: ['ashg0001'] } },
    });
    const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'sidebar' });
    expect((await approve(r)).state).toBe('executed');
    const rows = w!.sidebars.rows(S.atlas).map((x) => `${x.key}=${x.text}`);
    expect(rows).toEqual(expect.arrayContaining(['Scope=Every document type', 'Status=Outline']));
    expect(rows.some((x) => x.startsWith('Added='))).toBe(false);
    expect(rows.some((x) => x.startsWith('Region='))).toBe(true);
    expect(w!.sidebars.items(S.atlas, 'Dependencies').map((i) => i.resourceId)).toEqual(['miyabi01']);
  });

  it('canon: bringing a Status back to Authoritative needs the owner’s canonical approval', async () => {
    const snap = await setup();
    const changed = await call('set_facts', { page: S.harbour, facts: { Status: 'Outline' } });
    // Leaving Authoritative is canon too: the owner accepts it.
    const { asCanon } = await import('../resources/world.js');
    expect((await asCanon(w!, changed)).body.status).toBe('written');
    const r = await call('restore_snapshot', { page: S.harbour, snapshot: snap, scope: 'sidebar' });
    expect(r.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    await expect(
      w!.stack.runtime.policy.commands.approve('owner', String(r.body.proposalId)),
    ).rejects.toThrow();
    expect((await approve(r, true)).state).toBe('executed');
    expect(w!.sidebars.rows(S.harbour).find((x) => x.key === 'Status')!.text).toBe('Authoritative');
  });

  it('lifecycle: a restore that would change a page’s lifecycle state is refused, naming the lifecycle tools', async () => {
    const snap = await setup();
    const { asCanon } = await import('../resources/world.js');
    expect((await asCanon(w!, await call('archive_page', { page: S.harbour }))).body.status).toBe('written');
    const r = await call('restore_snapshot', { page: S.harbour, snapshot: snap, scope: 'sidebar' });
    expect(r.body.error).toMatchObject({ code: 'RESTORE_LIFECYCLE' });
    expect(r.body.error.message).toMatch(/unarchive_page/);
  });

  it('a dashboard restore (the owner’s own request) is a proposal too; a canonical one waits for “accept as canon”', async () => {
    const snap = await setup();
    const { asCanon } = await import('../resources/world.js');
    await asCanon(w!, await call('set_facts', { page: S.harbour, facts: { Status: 'Outline' } }));
    const rs = w!.stack.runtime.restores;
    const r = await rs.propose(
      { projectId: PROJECT, pageId: S.harbour, snapshotId: snap, scope: 'sidebar' },
      { kind: 'ui', client: 'owner', tool: 'restore_snapshot' },
      'owner',
    );
    expect(r).toMatchObject({
      status: 'proposal_captured',
      canonical: { reason: expect.any(String) as unknown },
    });
  });
});

describe('restore_snapshot: a deleted page', () => {
  it('within soft delete: undeleted, then its content comes back as a second proposal', async () => {
    const snap = await setup();
    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'Written before the delete.' });
    expect((await call('delete_resource', { page: S.atlas, confirm: true })).isError).toBe(false);
    const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'deleted' });
    expect(r.body).toMatchObject({ status: 'proposal_captured', mode: 'undelete', writes: 1 });
    expect((await approve(r)).state).toBe('executed');
    expect(w!.repo.live(S.atlas)).toBeDefined();
    // The second proposal: the content back to the snapshot.
    const rs = w!.stack.runtime.restores;
    let rec = rs.list(PROJECT).find((x) => x.scope === 'deleted')!;
    for (let i = 0; i < 100 && !rec.followUpProposalId; i++) {
      await new Promise((res) => setTimeout(res, 20));
      rec = rs.list(PROJECT).find((x) => x.scope === 'deleted')!;
    }
    expect(rec.followUpProposalId).toBeTruthy();
    const follow = {
      body: { status: 'proposal_captured', proposalId: rec.followUpProposalId },
    } as unknown as ToolCall;
    expect((await approve(follow)).state).toBe('executed');
    expect(texts()).not.toContain('Written before the delete.');
  });

  it('recreated from the snapshot alone (purged): original ids, documents with their content, features, events, board, sidebar', async () => {
    const snap = await setup();
    await call('delete_resource', { page: S.atlas, confirm: true });
    // LegendKeeper purged it: the id is free again.
    w!.repo.res.delete(S.atlas);
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
    });
    expect(r.body).toMatchObject({ status: 'proposal_captured', mode: 'recreate' });
    // Canon: a page created [BSRC] is a canonical proposal (ADR 0036 decision 1).
    expect(r.body.requiresCanonicalApproval).toBe(true);
    expect(r.body.cannotRestore).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'unsupported block aun1' }) as unknown]),
    );
    const res = await approve(r, true);
    expect(res.state, JSON.stringify(res.job)).toBe('executed');
    const page = w!.repo.live(S.atlas)!;
    expect(page.name).toBe('[BSRC] Atlas of Snapshots');
    expect(page.parentId).toBe(S.locations);
    const docs = w!.repo.liveDocs(page);
    expect(docs.map((x) => `${x.name}:${x.type}`).sort()).toEqual([
      'Chronicle:time',
      'Main:page',
      'Map:map',
      'Notes:blank',
      'Plot:board',
    ]);
    const main = docs.find((x) => x.name === 'Main')!;
    expect((w!.repo.blocks.get(main.id)!.blocks as { id: string }[]).map((b) => b.id)).not.toContain('aun1');
    expect(
      w!.features
        .get(docs.find((x) => x.name === 'Map')!.id)!
        .map((f) => f.id)
        .sort(),
    ).toEqual(['fold0001', 'pin00001', 'pin00002', 'reg00001']);
    expect(w!.events.get(docs.find((x) => x.name === 'Chronicle')!.id)!.length).toBe(3);
    expect((w!.boards.get(docs.find((x) => x.name === 'Plot')!.id)!.content.shapes as unknown[]).length).toBe(
      3,
    );
    expect(w!.sidebars.rows(S.atlas).map((x) => x.key)).toEqual(
      expect.arrayContaining(['Scope', 'Status', 'Region']),
    );
  });

  it('recreated with new ids when asked (the result maps the old id to the new)', async () => {
    const snap = await setup();
    await call('delete_resource', { page: S.atlas, confirm: true });
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
      ids: 'new',
    });
    const newId = r.body.idMap[S.atlas] as string;
    expect(newId).toMatch(/^[a-z][0-9a-z]{23}$/);
    expect((await approve(r, true)).state).toBe('executed');
    expect(w!.repo.live(newId)!.name).toBe('[BSRC] Atlas of Snapshots');
  });

  it('the original id still held by the soft-deleted page: the create is refused, nothing is written', async () => {
    const snap = await setup();
    await call('delete_resource', { page: S.atlas, confirm: true });
    const count = w!.repo.res.size;
    const r = await call('restore_snapshot', {
      page: S.atlas,
      snapshot: snap,
      scope: 'deleted',
      mode: 'recreate',
    });
    expect(r.body.warnings.join(' ')).toMatch(/DUPLICATE_ID/);
    const res = await approve(r, true);
    expect(res.state).toBe('failed');
    expect(w!.repo.res.size).toBe(count);
  });

  it('a page that is not deleted is refused for scope deleted; a deleted page for scope page', async () => {
    const snap = await setup();
    expect(
      (await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'deleted' })).body.error,
    ).toMatchObject({ code: 'NOT_DELETED' });
    await call('delete_resource', { page: S.atlas, confirm: true });
    expect(
      (await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'page' })).body.error,
    ).toMatchObject({ code: 'PAGE_DELETED' });
  });
});

describe('list_snapshots and snapshot_diff', () => {
  it('lists a page’s snapshots, newest first, with what changed; diffs a document against now and between snapshots', async () => {
    const snap = await setup();
    await call('write_page', { page: S.atlas, mode: 'append', markdown: 'A later line.' });
    const l = await call('list_snapshots', { page: S.atlas, piece: 'Main' });
    expect(l.body.count).toBe(2);
    expect(l.body.snapshots[0]).toMatchObject({
      kind: 'change',
      madeBy: 'write_page',
      pieces: [{ change: 'changed' }],
    });
    expect(l.body.snapshots[1]).toMatchObject({
      snapshot: snap,
      kind: 'full',
      pieces: [{ change: 'first seen' }],
    });
    const d = await call('snapshot_diff', { page: S.atlas, piece: 'Main', from: snap });
    // The new paragraph and the blank line before it.
    expect(d.body).toMatchObject({ identical: false, added: 2, removed: 0 });
    expect(d.body.diff).toMatch(/\+A later line\./);
    const between = await call('snapshot_diff', {
      page: S.atlas,
      piece: 'Main',
      from: snap,
      to: l.body.snapshots[0].snapshot,
    });
    expect(between.body).toMatchObject({ added: 2, reads: 0 });
    const sb = await call('snapshot_diff', { page: S.atlas, piece: 'sidebar', from: snap });
    expect(sb.body.identical).toBe(true);
  });
});

describe('restore_snapshot: a deleted image', () => {
  it('comes back as a new asset (staged now, placed by the proposal), and the pages that showed it are updated when asked', async () => {
    const snap = await setup();
    const oldUrl = w!.url(S.imgSea);
    const del = await call('lk_api_write', {
      operationId: 'deleteAsset',
      params: { path: { assetId: S.imgSea } },
    });
    expect(del.isError, JSON.stringify(del.body)).toBe(false);
    const dry = await call('restore_snapshot', {
      snapshot: snap,
      scope: 'image',
      asset: S.imgSea,
      dryRun: true,
    });
    expect(dry.body).toMatchObject({
      status: 'dry_run',
      old: { assetId: S.imgSea, name: 'Weeping Sea', url: oldUrl },
    });
    expect(dry.body.references).toEqual([
      expect.objectContaining({
        pageId: S.atlas,
        documents: [expect.objectContaining({ what: 'image blocks' }) as unknown],
      }) as unknown,
    ]);
    const r = await call('restore_snapshot', {
      snapshot: snap,
      scope: 'image',
      asset: S.imgSea,
      updateReferences: true,
    });
    expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
    const newId = r.body.newAsset.id as string;
    expect(newId).not.toBe(S.imgSea);
    // Staged: in the library, hidden, until the owner approves.
    expect(w!.assets.assets.get(newId)).toMatchObject({ isHidden: true });
    expect((await approve(r)).state).toBe('executed');
    expect(w!.assets.assets.get(newId)).toMatchObject({
      isHidden: false,
      name: 'Weeping Sea',
      folderId: S.folderA,
    });
    const img = mainBlocks().find((b) => b.id === 'aimg') as unknown as { url: string };
    expect(img.url).toBe(w!.url(newId));
    // The same bytes: the snapshot store's object.
    expect(w!.sha(newId)).toBe(w!.sha(S.imgSea));
  });

  it('without updateReferences, the pages are listed and left as they are', async () => {
    const snap = await setup();
    await call('lk_api_write', { operationId: 'deleteAsset', params: { path: { assetId: S.imgSea } } });
    const r = await call('restore_snapshot', { snapshot: snap, scope: 'image', asset: S.imgSea });
    expect(r.body.notes).toEqual([
      expect.objectContaining({ what: '1 page(s) refer to the old URL' }) as unknown,
    ]);
    expect((await approve(r)).state).toBe('executed');
    expect((mainBlocks().find((b) => b.id === 'aimg') as unknown as { url: string }).url).toBe(
      w!.url(S.imgSea),
    );
  });

  it('an image still in the library is refused', async () => {
    const snap = await setup();
    const r = await call('restore_snapshot', { snapshot: snap, scope: 'image', asset: S.imgSea });
    expect(r.body.error).toMatchObject({ code: 'IMAGE_NOT_DELETED' });
  });
});
