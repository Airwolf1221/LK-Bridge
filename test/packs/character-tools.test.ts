/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052; the owner-approved design docs/design/F3b-owner-tools.md, sections 2 to 4): the character tools
 * beside `arkona_create_character`, against the mock LegendKeeper:
 *
 * - `arkona_create_relationship`: both participants' Related Sources updated in the same proposal; CHARACTER_NOT_FOUND;
 *   RELATIONSHIP_EXISTS naming the page; a Working relationship with a canon partner leaves that link for promotion;
 *   two packages for one pair end with one page;
 * - `arkona_add_character_art`: a new Art page; an existing one extended under "Reference Images"; a bare image
 *   refused; the folder found or created when the job runs; a ChatGPT `file` and an `upload_id` staged first;
 * - `arkona_character_brief`: its content, no LegendKeeper read without `live`, exactly one with it.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, C } from './world.js';
import { ownerText, ownersWorld, PROJECT, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const related = (id: string) =>
  (w.sidebars.pages.get(id)?.props.find((p) => p.title === 'Related Sources')?.items ?? []).map(
    (i) => i.resourceId,
  );
const stage = async (file: string) => {
  const r = await w.call('upload_image', {
    data_base64: fixture(file).toString('base64'),
    name: `stage ${file}`,
    stage: true,
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  return String(r.body.staged_id);
};
const imagesOn = (id: string) => {
  const main = w.repo.liveDocs(w.repo.res.get(id)!).find((d) => d.name === 'Main')!;
  return (w.repo.blocks.get(main.id)!.blocks as { kind: string; url?: string; alt?: string }[]).filter(
    (b) => b.kind === 'image',
  );
};

describe('arkona_create_relationship (design section 2)', () => {
  const rel = (over: Record<string, unknown> = {}) => ({
    a: 'Nadira al-Khalid',
    b: 'Mehrana II al-Khalid',
    scope: 'Cousins of the house of al-Khalid',
    markdown: ownerText('The bond of the two cousins.'),
    project: 'test',
    ...over,
  });

  it('makes the joint page under a’s index and updates BOTH participants’ Related Sources in one proposal', async () => {
    const dry = await w.call('arkona_create_relationship', { ...rel(), dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree[0]).toMatchObject({
      page: '[BSRC] Nadira al-Khalid & Mehrana II al-Khalid - Relationship',
      parent: '[INDEX] Nadira al-Khalid',
    });
    expect(dry.body.pages[0].tags).toEqual(['CANON', 'Character', 'Relationship']);
    expect(dry.body.pages[0].facts).toContainEqual({
      key: 'Subject',
      value: 'Nadira al-Khalid & Mehrana II al-Khalid',
    });
    expect(dry.body.existing.map((x: { page: string }) => x.page)).toEqual(
      expect.arrayContaining([
        '[BSRC] Nadira al-Khalid - Character Core',
        '[BSRC] Mehrana II al-Khalid - Character Core',
      ]),
    );
    const p = await w.call('arkona_create_relationship', rel());
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const page = pageNamed('[BSRC] Nadira al-Khalid & Mehrana II al-Khalid - Relationship')!;
    expect(w.repo.res.get(page.parentId!)!.name).toBe('[INDEX] Nadira al-Khalid');
    expect(related(C.nadira)).toContain(page.id);
    expect(related(C.mehrana2)).toContain(page.id);
  });

  it('refuses a pair that already has a relationship owner (either order), naming it', async () => {
    const r = await w.call('arkona_create_relationship', {
      ...rel({ a: 'Mehrana II al-Khalid', b: 'Nadira al-Khalid' }),
      dryRun: true,
    });
    expect(r.body.error.code).toBe('RELATIONSHIP_EXISTS');
    expect(r.body.error.existing[0].name).toBe(
      '[BSRC] Nadira al-Khalid & Mehrana II al-Khalid - Relationship',
    );
    const labelled = await w.call('arkona_create_relationship', {
      ...rel({ label: 'Rivalry' }),
      dryRun: true,
    });
    expect(labelled.body.error.code).toBe('RELATIONSHIP_EXISTS');
  });

  it('refuses a character that does not exist, pointing to arkona_create_character', async () => {
    const r = await w.call('arkona_create_relationship', {
      ...rel({ b: 'Nobody of Nowhere' }),
      dryRun: true,
    });
    expect(r.body.error.code).toBe('CHARACTER_NOT_FOUND');
    expect(r.body.error.hint).toMatch(/arkona_create_character/);
    const self = await w.call('arkona_create_relationship', {
      ...rel({ b: 'Nadira al-Khalid' }),
      dryRun: true,
    });
    expect(self.body.error.code).toBe('RELATIONSHIP_WITH_SELF');
  });

  it('a Working relationship with a canon partner: hosted in the Working set, the partner’s link waits for promotion', async () => {
    const r = await w.call('arkona_create_relationship', {
      ...rel({ a: 'Tamsin Reed', b: 'Nadira al-Khalid', markdown: ownerText('A courier and an archivist.') }),
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree[0]).toMatchObject({
      page: '[BWRK] Tamsin Reed & Nadira al-Khalid - Relationship',
      parent: '[INDEX] Tamsin Reed',
    });
    expect(r.body.pages[0].tags).toEqual(['Working', 'Character', 'Relationship']);
    expect(r.body.warnings.map((x: { code: string }) => x.code)).toContain('PARTNER_LINK_DEFERRED');
    const changed = r.body.existing.map((x: { page: string }) => x.page);
    expect(changed).toContain('[BWRK] Tamsin Reed - Character Core');
    expect(changed).not.toContain('[BSRC] Nadira al-Khalid - Character Core');
  });

  it('host "b" keeps the name’s order and hosts it under b’s index', async () => {
    const r = await w.call('arkona_create_relationship', {
      ...rel({ a: 'Mehrana I al-Khalid', b: 'Nadira al-Khalid', host: 'b' }),
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree[0]).toMatchObject({
      page: '[BSRC] Mehrana I al-Khalid & Nadira al-Khalid - Relationship',
      parent: '[INDEX] Nadira al-Khalid',
    });
  });

  it('two packages for one pair: the second job stops cleanly with RELATIONSHIP_EXISTS', async () => {
    const pkg = rel({
      a: 'Mehrana I al-Khalid',
      b: 'Mehrana II al-Khalid',
      markdown: ownerText('Two Mehranas.'),
    });
    const one = await w.call('arkona_create_relationship', pkg);
    const two = await w.call('arkona_create_relationship', pkg);
    expect(one.body.status, one.text).toBe('proposal_captured');
    expect(two.body.status, two.text).toBe('proposal_captured');
    const first = await approve(w, String(one.body.proposalId));
    expect(first.job?.status, JSON.stringify(first.job?.lastError)).toBe('succeeded');
    // The second stops before writing: its proposal conflicts (the cores it links changed), or its job's re-check refuses.
    const second = await approve(w, String(two.body.proposalId));
    if (second.job) {
      expect(second.job.status).toBe('failed');
      expect(['RELATIONSHIP_EXISTS', 'DOMAIN_EXISTS']).toContain(second.job.lastError?.code);
    } else expect(second.state).toBe('conflicted');
    expect(
      [...w.repo.res.values()].filter(
        (r) =>
          r.deletedAt === null &&
          r.name === '[BSRC] Mehrana I al-Khalid & Mehrana II al-Khalid - Relationship',
      ),
    ).toHaveLength(1);
  });
});

describe('arkona_add_character_art (design section 3)', () => {
  const image = (staged_id: string, over: Record<string, unknown> = {}) => ({
    staged_id,
    label: 'Primary Reference - Character Portrait',
    interpretation: 'Her face, her hair and her archivist’s robes.',
    ...over,
  });

  it('makes the Art page when missing: AI Character Art, the image in the character’s folder, its block on the page', async () => {
    const id = await stage('alpha.png');
    const dry = await w.call('arkona_add_character_art', {
      character: 'Mehrana I al-Khalid',
      images: [image(id)],
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree[0]).toMatchObject({
      page: '[BSRC] Mehrana I al-Khalid - Character Art',
      parent: '[INDEX] Mehrana I al-Khalid',
    });
    expect(dry.body.pages[0].tags).toEqual(['CANON', 'Character', 'Character Art']);
    expect(dry.body.assets).toEqual([
      expect.objectContaining({
        name: 'Mehrana I al-Khalid - Primary Reference - Character Portrait',
        folder: 'Characters / Beastkin / Qishen / Mehrana I al-Khalid',
      }),
    ]);
    const p = await w.call('arkona_add_character_art', {
      character: 'Mehrana I al-Khalid',
      images: [image(id)],
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const art = pageNamed('[BSRC] Mehrana I al-Khalid - Character Art')!;
    expect(imagesOn(art.id)).toHaveLength(1);
    const row = w.stack.runtime.images.staged(PROJECT, id)!;
    expect(row.staged).toBe(false);
    expect(row.name).toBe('Mehrana I al-Khalid - Primary Reference - Character Portrait');
    expect(
      (done.job?.result as { foldersUsed?: { outcome: string }[] }).foldersUsed?.map((f) => f.outcome),
    ).toEqual(['created folder']);
  });

  it('extends an existing Art page under “Reference Images”, the folder found (and a subfolder made) when the job runs', async () => {
    const art = pageNamed('[BSRC] Mehrana I al-Khalid - Character Art')!;
    const a = await stage('orientation-6.jpg');
    const b = await stage('already.webp');
    const p = await w.call('arkona_add_character_art', {
      character: 'Mehrana I al-Khalid',
      images: [
        image(a, {
          label: 'Detail Reference - Signet Ring',
          interpretation: 'Her signet ring, worn on the left hand.',
        }),
        image(b, {
          label: 'Outfit Reference - Court Dress',
          interpretation: 'Her court dress.',
          subfolder: 'Outfits / Court Dress',
        }),
      ],
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const prop = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(prop.pages.join('\n')).toMatch(
      /Character Art: Reference Images gains “Mehrana I al-Khalid - Detail Reference - Signet Ring”, “Mehrana I al-Khalid - Outfit Reference - Court Dress”/,
    );
    const done = await approve(w, prop.id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    expect(w.repo.res.get(art.id)!.name).toBe('[BSRC] Mehrana I al-Khalid - Character Art');
    expect(imagesOn(art.id).map((x) => x.alt)).toEqual([
      'Primary Reference - Character Portrait',
      'Detail Reference - Signet Ring',
      'Outfit Reference - Court Dress',
    ]);
    const used =
      (done.job?.result as { foldersUsed?: { name: string; outcome: string }[] }).foldersUsed ?? [];
    // The character's folder was there when planned (used by its id); the outfit's subfolders were made in the job.
    expect(used.map((f) => [f.name, f.outcome])).toEqual([
      ['Outfits', 'created folder'],
      ['Court Dress', 'created folder'],
    ]);
  });

  it('a folder made by another job since the plan is found when the job runs, never made twice', async () => {
    // Two packages planned before either runs: both plan to make Outfits / Gown under the character's folder.
    const one = await stage('png-named.jpg');
    const two = await stage('animated.gif');
    const pkg = (id: string, label: string) => ({
      character: 'Mehrana I al-Khalid',
      images: [image(id, { label, subfolder: 'Outfits / Gown' })],
      project: 'test',
    });
    const p1 = await w.call('arkona_add_character_art', pkg(one, 'Outfit Reference - Gown Front'));
    const p2 = await w.call('arkona_add_character_art', pkg(two, 'Outfit Reference - Gown Back'));
    expect(p1.body.status, p1.text).toBe('proposal_captured');
    expect(p2.body.status, p2.text).toBe('proposal_captured');
    const d1 = await approve(w, String(p1.body.proposalId));
    const d2 = await approve(w, String(p2.body.proposalId));
    expect(d1.job?.status, JSON.stringify(d1.job?.lastError)).toBe('succeeded');
    expect(d2.job?.status, JSON.stringify(d2.job?.lastError)).toBe('succeeded');
    const outcome = (d: typeof d1) =>
      ((d.job?.result as { foldersUsed?: { name: string; outcome: string }[] }).foldersUsed ?? []).map(
        (f) => [f.name, f.outcome],
      );
    expect(outcome(d1)).toEqual([['Gown', 'created folder']]);
    expect(outcome(d2)).toEqual([['Gown', 'found existing folder']]);
    expect(w.assets.byName('Gown')).toHaveLength(1);
    const art = pageNamed('[BSRC] Mehrana I al-Khalid - Character Art')!;
    expect(
      imagesOn(art.id)
        .map((x) => x.alt)
        .slice(-2),
    ).toEqual(['Outfit Reference - Gown Front', 'Outfit Reference - Gown Back']);
  });

  it('refuses an image without its interpretation, and a label with a file extension', async () => {
    const id = await stage('animated.gif');
    const bare = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [image(id, { interpretation: undefined })],
      dryRun: true,
      project: 'test',
    });
    expect(bare.body.error.code).toBe('BARE_IMAGE');
    const ext = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [image(id, { label: 'Primary Reference - portrait.png' })],
      dryRun: true,
      project: 'test',
    });
    expect(ext.body.error.code).toBe('IMAGE_LABEL_INVALID');
    const missing = await w.call('arkona_add_character_art', {
      character: 'Nobody of Nowhere',
      images: [image(id)],
      dryRun: true,
      project: 'test',
    });
    expect(missing.body.error.code).toBe('CHARACTER_NOT_FOUND');
  });

  it('a ChatGPT file is staged on the bridge first (even on a dry run) and the same file again is the same image', async () => {
    w.files.set('nadira', { status: 200, type: 'image/png', body: fixture('alpha.png') });
    const file = { download_url: `https://assets.test:${w.port}/f/nadira`, file_id: 'file-nadira' };
    // alpha.png was placed above: the same original is never uploaded twice.
    const dup = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ label: 'Primary Reference - Character Portrait', interpretation: 'Her face.' }],
      file,
      dryRun: true,
      project: 'test',
    });
    expect(dup.body.error.code).toBe('IMAGE_ALREADY_IN_LIBRARY');
    // Another original (a trailing byte changes its hash; the image reads the same).
    w.files.set('nadira2', {
      status: 200,
      type: 'application/octet-stream',
      body: Buffer.concat([fixture('alpha.png'), Buffer.from([7, 7])]),
    });
    const file2 = { download_url: `https://assets.test:${w.port}/f/nadira2`, file_id: 'file-nadira2' };
    const dry = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ label: 'Primary Reference - Character Portrait', interpretation: 'Her face.' }],
      file: file2,
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.stagedNow).toEqual([
      expect.objectContaining({ from: 'file file-nadira2', deduplicated: false }),
    ]);
    const again = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ label: 'Primary Reference - Character Portrait', interpretation: 'Her face.' }],
      file: file2,
      project: 'test',
    });
    expect(again.body.status, again.text).toBe('proposal_captured');
    expect(again.body.stagedNow ?? []).toEqual([]);
    w.stack.runtime.policy.commands.reject('owner', String(again.body.proposalId), 'test');
  });

  it('an upload_id is staged first too; each image has exactly one source', async () => {
    const bytes = fixture('orientation-6.jpg');
    // A copy with one changed byte at the end of the file is another original.
    const other = Buffer.concat([bytes, Buffer.from([0])]);
    const c = await w.stack.connect();
    const prep = await w.stack.call(c, 'prepare_image_upload', {
      project: 'test',
      sha256: createHash('sha256').update(other).digest('hex'),
      byte_length: other.length,
      content_type: 'image/jpeg',
      name: 'ring.jpg',
    });
    expect(prep.isError, prep.text).toBe(false);
    const id = String(prep.body.upload_id);
    const sent = await fetch(new URL(`/uploads/${id}`, w.stack.base), {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Upload ${String(prep.body.capability)}`,
      },
      body: other,
    });
    expect(sent.status).toBe(201);
    const r = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [
        {
          upload_id: id,
          label: 'Detail Reference - Archive Key',
          interpretation: 'The archive key she carries.',
        },
      ],
      dryRun: true,
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.stagedNow).toEqual([expect.objectContaining({ from: `upload ${id}` })]);
    const two = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ label: 'Primary Reference - Character Portrait', interpretation: 'x' }],
      dryRun: true,
      project: 'test',
    });
    expect(two.body.error.code).toBe('IMAGE_SOURCE_INVALID');
  });
});

describe('arkona_character_brief (design section 4)', () => {
  it('who the character is, from the tree and snapshots: free without live, one read with it', async () => {
    // A character made by the pack (so the tree has read its whole sidebar), with an Unresolved Material item.
    const make = await w.call('arkona_create_character', {
      name: 'Hoshino Kaya',
      depth: 'developed',
      status: 'authoritative',
      identity: {
        givenName: 'Kaya',
        surname: 'Hoshino',
        race: 'Foxian',
        namingCulture: 'Fujimatsuan',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 900 - 5A 931',
      },
      pages: [
        {
          role: 'core',
          scope: 'A lantern-keeper',
          markdown:
            '## Purpose\n\nThe identity of Hoshino Kaya.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\n- Her mother’s name is not settled.\n',
        },
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'Her life',
          markdown: '## Purpose\n\nHer life.\n\n## Early Life\n\nRaised at the shrine.\n',
        },
      ],
      project: 'test',
    });
    expect(make.body.status, make.text).toBe('proposal_captured');
    const done = await approve(w, String(make.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    await w.stack.runtime.snapshots.settled();
    const before = w.seen.length;
    const r = await w.call('arkona_character_brief', { character: 'Hoshino Kaya', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(w.seen.slice(before)).toEqual([]);
    expect(r.body.character).toMatchObject({
      subject: 'Hoshino Kaya',
      identityPage: { name: '[BSRC] Hoshino Kaya - Character Core', role: 'core' },
      index: { name: '[INDEX] Hoshino Kaya' },
      lifecycle: 'Authoritative',
    });
    expect(r.body.identity).toEqual({
      'Personal / Given Name': 'Kaya',
      'Family / Surname': 'Hoshino',
      'Race / Species': 'Foxian',
      'Naming Culture': 'Fujimatsuan',
      'Life State': 'Alive at 5A 931',
      'Temporal Scope': '5A 900 - 5A 931',
    });
    expect(r.body.identityFrom.source).toBe('tree');
    expect(
      r.body.pages.map((p: { name: string; referenceType: string }) => [p.name, p.referenceType]),
    ).toEqual([
      ['[BSRC] Hoshino Kaya - Biography', 'Character Biography'],
      ['[BSRC] Hoshino Kaya - Character Core', 'Character Core'],
    ]);
    expect(r.body.unresolved).toEqual([
      { page: '[BSRC] Hoshino Kaya - Character Core', items: ['Her mother’s name is not settled.'] },
    ]);
    expect(r.body.freshness.tree.status).toBe('ready');
    expect(r.body.freshness.snapshots).not.toBeNull();
    // live: true is one read of the Core's sidebar.
    const b2 = w.seen.length;
    const live = await w.call('arkona_character_brief', {
      character: 'Hoshino Kaya',
      live: true,
      project: 'test',
    });
    expect(live.isError, live.text).toBe(false);
    expect(w.seen.slice(b2)).toEqual([`GET /resources/${String(r.body.character.identityPage.id)}`]);
    expect(live.body.identityFrom.source).toBe('live');
    expect(live.body.identity['Personal / Given Name']).toBe('Kaya');
  });

  it('lists the relationships, the Art pages with their image counts, and the open audit findings', async () => {
    const r = await w.call('arkona_character_brief', { character: 'Mehrana I al-Khalid', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.relationships.map((x: { name: string }) => x.name)).toContain(
      '[BSRC] Mehrana I al-Khalid & Mehrana II al-Khalid - Relationship',
    );
    expect(r.body.art).toEqual([
      expect.objectContaining({ name: '[BSRC] Mehrana I al-Khalid - Character Art', images: 5 }),
    ]);
    // An open finding on the Core (as an audit run records it).
    const audits = w.stack.runtime.audits;
    const run = audits.store.startRun(PROJECT, 'test');
    audits.store.commit(PROJECT, run.id, [
      {
        fingerprint: 'f3b-test-finding',
        code: 'lifecycle_inconsistent',
        category: 'lifecycle',
        severity: 'warning',
        pageId: C.mehrana1,
        pageName: '[BSRC] Mehrana I al-Khalid - Character Core',
        pagePath: 'Characters / Beastkin / Qishen / Mehrana I al-Khalid',
        documentId: null,
        blockId: null,
        message: 'A test finding.',
        evidence: {},
        source: 'bridge',
        fix: null,
      } as never,
    ]);
    const after = await w.call('arkona_character_brief', {
      character: 'Mehrana I al-Khalid',
      project: 'test',
    });
    expect(after.body.findings).toEqual([
      expect.objectContaining({
        page: '[BSRC] Mehrana I al-Khalid - Character Core',
        message: 'A test finding.',
      }),
    ]);
  });

  it('refuses a character that does not exist', async () => {
    const r = await w.call('arkona_character_brief', { character: 'Nobody of Nowhere', project: 'test' });
    expect(r.body.error.code).toBe('CHARACTER_NOT_FOUND');
  });
});
