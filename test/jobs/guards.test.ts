/** PLAN §4 guards: unsupported blocks, cascade confirmation, member admin, read-only; and the write journal. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CascadeConfirmationRequiredError,
  MemberAdminDisabledError,
  ReadOnlyError,
  UnsupportedBlockLossError,
  pruneJournal,
  unsupportedBlockIds,
  unsupportedLoss,
} from '../../src/jobs/index.js';
import type { Block } from './lk-model.js';
import { harness, origin, seen, settle, type Harness, queue, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const page: Block[] = [
  { id: 'p1', kind: 'paragraph', content: [{ text: 'intro' }] },
  { id: 'u1', kind: 'unsupported' },
  {
    id: 'c1',
    kind: 'callout',
    tone: 'info',
    children: [
      { id: 'p2', kind: 'paragraph', content: [] },
      { id: 'u2', kind: 'unsupported' }, // nested
    ],
  },
];

describe('unsupported-block helpers', () => {
  it('finds unsupported ids at any depth and reports what a replace would drop', () => {
    expect([...unsupportedBlockIds(page)].sort()).toEqual(['u1', 'u2']);
    const keepsTop = [
      { kind: 'unsupported', id: 'u1' },
      { kind: 'paragraph', content: [] },
    ];
    expect(unsupportedLoss(page, keepsTop)).toEqual(['u2']);
    expect(
      unsupportedLoss(page, [
        { kind: 'unsupported', id: 'u1' },
        { kind: 'callout', tone: 'info', children: [{ kind: 'unsupported', id: 'u2' }] },
      ]),
    ).toEqual([]);
  });
});

describe('unsupported-block guard (PLAN §4 rule 2)', () => {
  it('refuses a lossy replaceDocumentBlocks, including a nested unsupported block, without writing', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: page });
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        // Echoes u1 but drops the nested u2.
        {
          path: { resourceId, documentId },
          body: {
            blocks: [
              { kind: 'unsupported', id: 'u1' },
              { kind: 'paragraph', content: [] },
            ],
          },
        },
        { project: PROJECT, origin },
      ),
    );
    expect(r.error).toBeInstanceOf(UnsupportedBlockLossError);
    expect((r.error as UnsupportedBlockLossError).blockIds).toEqual(['u2']);
    expect(seen(h.mock, 'PUT', /\/blocks$/)).toHaveLength(0);
    expect(seen(h.mock, 'GET', /\/blocks$/)).toHaveLength(1); // one read: version, guard and pre-image together
    expect(h.model.docs.get(documentId)!.blocks).toEqual(page);
    const job = e.engine.queries.getJob(PROJECT, (r.error as UnsupportedBlockLossError).jobId!)!;
    expect(job.status).toBe('failed');
    expect(job.lastError).toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS', blockIds: ['u2'] });
    expect(e.engine.queries.listErrorGroups(PROJECT)[0]).toMatchObject({
      code: 'UNSUPPORTED_BLOCK_LOSS',
      classification: 'user_fixable',
    });
  });

  it('refuses a lossy replaceBlock of a container whose child is unsupported', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: page });
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run(
        'replaceBlock',
        {
          path: { resourceId, documentId, blockId: 'c1' },
          body: { kind: 'callout', tone: 'info', children: [{ kind: 'paragraph', content: [] }] },
        },
        { project: PROJECT, origin },
      ),
    );
    expect(r.error).toBeInstanceOf(UnsupportedBlockLossError);
    expect((r.error as UnsupportedBlockLossError).blockIds).toEqual(['u2']);
    expect(seen(h.mock, 'PUT', /\/blocks\/c1$/)).toHaveLength(0);
  });

  it('refuses a deleteBlock whose subtree holds an unsupported block, and allows it with allowUnsupportedLoss (chunk 8, F-03)', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: page });
    const e = h.newEngine();
    const path = { resourceId, documentId, blockId: 'c1' };
    const refused = await settle(h, e, e.engine.run('deleteBlock', { path }, { project: PROJECT, origin }));
    expect(refused.error).toBeInstanceOf(UnsupportedBlockLossError);
    expect((refused.error as UnsupportedBlockLossError).blockIds).toEqual(['u2']);
    expect(seen(h.mock, 'DELETE', /\/blocks\/c1$/)).toHaveLength(0);
    // Deleting the unsupported block itself is refused too.
    const self = await settle(
      h,
      e,
      e.engine.run('deleteBlock', { path: { ...path, blockId: 'u1' } }, { project: PROJECT, origin }),
    );
    expect((self.error as UnsupportedBlockLossError).blockIds).toEqual(['u1']);
    // A block with nothing unsupported under it is deleted as before.
    const plain = await settle(
      h,
      e,
      e.engine.run('deleteBlock', { path: { ...path, blockId: 'p1' } }, { project: PROJECT, origin }),
    );
    expect(plain.error).toBeUndefined();
    // The owner of the intent can allow the loss explicitly.
    const allowed = await settle(
      h,
      e,
      e.engine.run('deleteBlock', { path }, { project: PROJECT, origin, allowUnsupportedLoss: true }),
    );
    expect(allowed.error).toBeUndefined();
    expect(seen(h.mock, 'DELETE', /\/blocks\/c1$/)).toHaveLength(1);
  });

  it('counts an unsupported block without an id as lost: it can never be echoed (chunk 8, F-06)', () => {
    const legacy = [
      { kind: 'paragraph', content: [] },
      { kind: 'unsupported' },
      {
        kind: 'callout',
        children: [
          { kind: 'unsupported', id: '' },
          { kind: 'unsupported', id: 'u9' },
        ],
      },
    ];
    expect(unsupportedLoss(legacy, [{ kind: 'unsupported', id: 'u9' }])).toEqual([
      '(no id) #1',
      '(no id) #2',
    ]);
    // An id-less block in the incoming tree keeps nothing.
    expect(
      unsupportedLoss(legacy, [{ kind: 'unsupported' }, { kind: 'unsupported', id: 'u9' }]),
    ).toHaveLength(2);
    const err = new UnsupportedBlockLossError('replaceDocumentBlocks', ['(no id) #1']);
    expect(err.message).toMatch(/assignBlockIds/);
  });

  it('lets an echoing replace through, and allowUnsupportedLoss lets a lossy one through; the journal holds the pre-image', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: page });
    const e = h.newEngine();
    const ok = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        {
          path: { resourceId, documentId },
          body: {
            blocks: [
              { kind: 'unsupported', id: 'u1' },
              { kind: 'callout', tone: 'info', children: [{ kind: 'unsupported', id: 'u2' }] },
            ],
          },
        },
        { project: PROJECT, origin },
      ),
    );
    expect(ok.error).toBeUndefined();

    const lossy = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        {
          path: { resourceId, documentId },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: 'only this' }] }] },
        },
        { project: PROJECT, origin, allowUnsupportedLoss: true },
      ),
    );
    expect(lossy.error).toBeUndefined();
    expect(unsupportedBlockIds(h.model.docs.get(documentId)!.blocks).size).toBe(0);
    expect(seen(h.mock, 'GET', /\/blocks$/)).toHaveLength(2); // one read per destructive write

    const entries = e.engine.queries.journalLookup(PROJECT, { documentId });
    expect(entries).toHaveLength(2);
    const latest = entries[0]!;
    expect(latest).toMatchObject({
      opId: 'replaceDocumentBlocks',
      risk: 'destructive',
      outcome: 'applied',
      version: 'v2',
    });
    expect([...unsupportedBlockIds((latest.preImage as { blocks: Block[] }).blocks)].sort()).toEqual([
      'u1',
      'u2',
    ]);
    expect(entries[1]!.preImage).toMatchObject({ version: 'v1', blocks: page });
  });
});

describe('other guards', () => {
  it('deleteResource with cascade needs confirm: "cascade"', async () => {
    h = await harness();
    h.model.seedResource('rparent1');
    h.model.seedResource('rchild01', { parentId: 'rparent1' });
    const e = h.newEngine();
    await expect(
      e.engine.run(
        'deleteResource',
        { path: { resourceId: 'rparent1' }, query: { cascade: true } },
        { project: PROJECT, origin },
      ),
    ).rejects.toBeInstanceOf(CascadeConfirmationRequiredError);
    await expect(
      e.engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'deleteResource', params: { path: { resourceId: 'rparent1' }, query: { cascade: true } } },
        ],
      }),
    ).rejects.toThrow(CascadeConfirmationRequiredError);
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
    const r = await settle(
      h,
      e,
      e.engine.run(
        'deleteResource',
        { path: { resourceId: 'rparent1' }, query: { cascade: true } },
        { project: PROJECT, origin, confirm: 'cascade' },
      ),
    );
    expect(r.error).toBeUndefined();
    expect(h.model.resources.get('rchild01')!.deletedAt).toBeDefined();
    expect(e.engine.queries.journalLookup(PROJECT, { resourceId: 'rparent1' })[0]).toMatchObject({
      opId: 'deleteResource',
      params: { query: { cascade: true } },
      preImage: null,
    });
  });

  it('member and invite writes refuse unless LK_ALLOW_MEMBER_ADMIN=true', async () => {
    h = await harness();
    const e = h.newEngine();
    await expect(
      e.engine.run('inviteMember', { body: { email: 'a@example.invalid' } }, { project: PROJECT, origin }),
    ).rejects.toBeInstanceOf(MemberAdminDisabledError);
    await expect(
      e.engine.run('removeMember', { path: { userId: 'u1' } }, { project: PROJECT, origin }),
    ).rejects.toBeInstanceOf(MemberAdminDisabledError);
    await expect(
      e.engine.run('revokeInvite', { path: { inviteId: 'i1' } }, { project: PROJECT, origin }),
    ).rejects.toBeInstanceOf(MemberAdminDisabledError);
    expect(h.mock.calls).toHaveLength(0);
    // Reading members is not an admin write.
    const list = await settle(h, e, e.engine.run('listMembers', {}, { project: PROJECT, origin }));
    expect(list.error).toBeUndefined();

    const e2 = h.newEngine({ settings: { allowMemberAdmin: true } });
    const ok = await settle(
      h,
      e2,
      e2.engine.run('inviteMember', { body: { email: 'a@example.invalid' } }, { project: PROJECT, origin }),
    );
    expect(ok.error).toBeUndefined();
    expect(h.model.count('inviteMember')).toBe(1);
  });

  it('read-only mode refuses every write before it is queued; the runtime override is persisted', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine({ settings: { readOnly: true } });
    await expect(
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      ),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(
      e.engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'getResource', params: { path: { resourceId: 'r1' } } },
          { op: 'createResource', params: { body: { name: 'n' } } },
        ],
      }),
    ).rejects.toThrow(ReadOnlyError);
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
    // Reads still work.
    expect(
      (
        await settle(
          h,
          e,
          e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin }),
        )
      ).error,
    ).toBeUndefined();

    // Runtime override: off, persisted across a restart.
    e.engine.controls.setReadOnly(false, 'owner');
    expect(e.engine.queries.controls()).toMatchObject({ readOnly: false, readOnlyOverride: false });
    await e.engine.stop();
    const e2 = h.newEngine({ settings: { readOnly: true } });
    expect(e2.engine.queries.controls().readOnly).toBe(false);
    const w = await settle(
      h,
      e2,
      e2.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      ),
    );
    expect(w.error).toBeUndefined();
    // Override back on: refuses again.
    e2.engine.controls.setReadOnly(true);
    await expect(
      e2.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'y' } },
        { project: PROJECT, origin },
      ),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    expect(e2.engine.queries.runtimeSettings().find((s) => s.key === 'jobs.read_only_override')?.value).toBe(
      true,
    );
  });

  it('read-only switched on while a write job is queued holds it; nothing is sent', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    // Accepted while writes are paused (so it stays queued), then read-only is switched on and writes resumed.
    e.engine.controls.pauseWrites();
    const { jobId } = await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'x' } } }],
    });
    e.engine.controls.setReadOnly(true);
    e.engine.controls.resumeWrites();
    await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.waitReason?.held === 'read_only');
    expect(seen(h.mock, 'PATCH', /\/resources\/r1$/)).toHaveLength(0);
    e.engine.controls.setReadOnly(false);
    await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.status === 'succeeded');
    expect(h.model.count('updateResource')).toBe(1);
  });
});

describe('write journal', () => {
  it('captures resource metadata before updates and moves, and ids for deletes; prunes by age and size', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Before' });
    h.model.seedResource('r2');
    h.model.seedResource('r3');
    const e = h.newEngine();
    const { jobId } = await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: [
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'After' } } },
        { op: 'moveResource', params: { path: { resourceId: 'r1' }, body: { parentId: 'r2' } } },
        { op: 'deleteResource', params: { path: { resourceId: 'r3' } } },
      ],
    });
    await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.status === 'succeeded');
    const entries = e.engine.queries.journalLookup(PROJECT, { jobId });
    expect(entries.map((x) => [x.opId, x.outcome])).toEqual([
      ['deleteResource', 'applied'],
      ['moveResource', 'applied'],
      ['updateResource', 'applied'],
    ]);
    expect(entries[2]!.preImage).toMatchObject({ id: 'r1', name: 'Before' });
    expect(entries[1]!.preImage).toMatchObject({ id: 'r1', name: 'After' });
    expect(entries[0]).toMatchObject({ targetId: 'r3', preImage: null });
    expect(
      e.engine.queries.journalLookup(PROJECT, { resourceId: 'r1', includePreImage: false })[0],
    ).not.toHaveProperty('preImage');

    // Size cap: keep only what fits in ~the newest entry.
    const newest = entries[0]!.bytes;
    const bySize = pruneJournal(e.db, { retentionDays: 30, maxBytes: newest }, h.clock.now());
    expect(bySize).toMatchObject({ removedByAge: 0, removedBySize: 2 });
    // Age: 31 days later everything goes.
    const byAge = pruneJournal(
      e.db,
      { retentionDays: 30, maxBytes: 2 ** 31 },
      h.clock.now() + 31 * 86_400_000,
    );
    expect(byAge.removedByAge).toBe(1);
    expect(e.engine.queries.journalLookup(PROJECT)).toHaveLength(0);
  });
});
