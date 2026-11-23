/**
 * v3 F7 (ADR 0070; design G7): the art layout audit. Every finding on hand-made layouts (and none on the owner's
 * real, cleaned-up ones), then the audit → automation → proposal path against the mock: every fix is a proposal
 * (Propose by default, never Apply), and an approved one does exactly its moves and deletes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readLayout } from '../../src/art/layout.js';
import { artLayoutFindings } from '../../src/audits/checks/art-layout.js';
import { PROPOSE_ONLY, entryOf } from '../../src/automation/registry.js';
import { automationWorld, PROJECT, type AutomationWorld } from '../automation/world.js';
import { approve } from '../packs/world.js';
import { library, MEHRANA, mehranaTree, SORAYA, sorayaTree } from './fixtures.js';

vi.setConfig({ testTimeout: 180_000 });

const findings = (
  tree: Record<string, unknown>,
  path: string,
  o: Parameters<typeof artLayoutFindings>[1] = {},
) => {
  const lib = library(tree);
  const layout = readLayout(lib, lib.folderId(path))!;
  return artLayoutFindings(layout, { view: lib, ...o });
};

describe('G7: the findings', () => {
  it('the owner’s cleaned-up layouts have none (G4 accepts Mehrana’s labelless loose pieces)', () => {
    expect(findings(sorayaTree(), `Characters / Humans / Rangawan / ${SORAYA}`)).toEqual([]);
    expect(findings(mehranaTree(), `Characters / Beastkin / Qishen / ${MEHRANA}`)).toEqual([]);
  });

  const S = SORAYA;
  const messy = () => ({
    Characters: {
      [S]: {
        _items: [`${S} - Primary Reference - Portrait.png`, 'Soraya - Profile'],
        Wardrobe: {
          _items: [`${S} - Twin Coat - Front`, `${S} - Twin Coat - Back`, `${S} - Lone Sash - Front`],
          'Single Robe': [`${S} - Single Robe - Front`],
          'Jade Moon Kimono': [`${S} - Jade Moon Kimono - Front`, `${S} - Outfit Reference - Back`],
        },
        Forms: { 'Primary Appearance': [] },
        Outfits: { 'Court Dress': [`${S} - Court Dress - Front`] },
      },
    },
  });

  it('each finding, with its fix (or none, for the owner)', () => {
    const page = {
      pageId: 'art1',
      documentId: 'doc1',
      blocks: [
        {
          id: 'b1',
          kind: 'paragraph',
          content: [{ text: `Asset folder: Characters / ${S} / Outfits / Jade Moon Kimono.` }],
        },
        {
          id: 'b2',
          kind: 'paragraph',
          content: [{ text: `Old forms: Characters / ${S} / Forms / Primary Appearance / Gone` }],
        },
        {
          id: 'b3',
          kind: 'paragraph',
          content: [{ text: `Current: Characters / ${S} / Wardrobe / Jade Moon Kimono` }],
        },
        { id: 'b4', kind: 'paragraph', content: [{ text: 'Was folder deletedfold01 before.' }] },
        {
          id: 'b5',
          kind: 'paragraph',
          content: [{ text: 'Robes kept in folder movedaway01; sashes in insideok01.' }],
        },
      ],
    };
    const f = findings(messy(), `Characters / ${S}`, {
      pages: [page],
      goneFolder: (id) => id === 'deletedfold01',
      folderPath: (id) =>
        id === 'movedaway01'
          ? ['Characters', 'Mehrana al-Khalid', 'Wardrobe', 'Court Robes']
          : id === 'insideok01'
            ? ['Characters', S, 'Wardrobe', 'Sashes']
            : null,
    });
    const by = (code: string) => f.filter((x) => x.code === code);
    expect(by('art_outfit_folder_single')).toHaveLength(1);
    expect(by('art_outfit_folder_single')[0]!.fix?.args).toMatchObject({
      action: 'unfold',
      folderPath: `Characters / ${S} / Wardrobe / Single Robe`,
    });
    expect(by('art_loose_outfit_pieces').map((x) => x.evidence.outfit)).toEqual(['Twin Coat']);
    expect(by('art_loose_outfit_pieces')[0]!.fix?.args).toMatchObject({
      action: 'fold',
      folderId: null,
      folderName: 'Twin Coat',
    });
    expect(by('art_legacy_folder_empty')).toHaveLength(1);
    expect(by('art_legacy_folder_empty')[0]!.fix?.args.deletes).toEqual([
      expect.objectContaining({ path: `Characters / ${S} / Forms / Primary Appearance` }),
      expect.objectContaining({ path: `Characters / ${S} / Forms` }),
    ]);
    expect(by('art_legacy_folder_holds_assets')).toHaveLength(1);
    expect(by('art_legacy_folder_holds_assets')[0]!.fix).toBeNull();
    const names = by('art_asset_name');
    expect(names.map((x) => [x.evidence.asset, x.fix?.args.to ?? null])).toEqual([
      [`${S} - Primary Reference - Portrait.png`, `${S} - Primary Reference - Portrait`],
      ['Soraya - Profile', null],
      [`${S} - Outfit Reference - Back`, `${S} - Jade Moon Kimono - Outfit Reference - Back`],
    ]);
    const stale = by('art_stale_folder_ref');
    expect(
      stale.map((x) => [x.blockId, x.evidence.stale ?? x.evidence.staleId, x.fix?.args.to ?? null]),
    ).toEqual([
      [
        'b1',
        `Characters / ${S} / Outfits / Jade Moon Kimono`,
        `Characters / ${S} / Wardrobe / Jade Moon Kimono`,
      ],
      ['b2', `Characters / ${S} / Forms / Primary Appearance / Gone`, null],
      ['b4', 'deletedfold01', null],
      ['b5', 'movedaway01', null],
    ]);
    // An id now elsewhere: its current name suggested (a folder still the character's is not a finding).
    expect(stale[3]!.evidence).toMatchObject({
      suggested: 'Characters / Mehrana al-Khalid / Wardrobe / Court Robes',
      currentName: 'Court Robes',
    });
    expect(stale[3]!.message).toMatch(/no longer Soraya bint al-Noor’s/);
    // Every finding with a fix proposes; none is ever applied directly.
    for (const x of f) if (x.fix) expect(x.fix.kind).toBe('art_layout');
  });

  it('the codes work with F5b: proposal-only, Propose by default, never Apply', () => {
    expect(PROPOSE_ONLY.map((e) => e.code)).toEqual([
      'art_outfit_folder_single',
      'art_loose_outfit_pieces',
      'art_legacy_folder_empty',
      'art_asset_name',
      'art_stale_folder_ref',
      // v3 F7.1 (ADR 0072): also Propose by default, and its Apply is the owner's switch (`applyDirect`).
      'character_core_missing',
      'core_compact_wording',
    ]);
    expect(PROPOSE_ONLY.filter((e) => e.applyDirect === true).map((e) => e.code)).toEqual([
      'character_core_missing',
      'core_compact_wording',
    ]);
    for (const e of PROPOSE_ONLY) expect(e).toMatchObject({ automatable: 'propose', defaultMode: 'propose' });
    expect(entryOf('art_legacy_folder_holds_assets')?.automatable).toBeUndefined();
  });
});

describe('G7: audit → automation → proposals (mock LegendKeeper)', () => {
  let w: AutomationWorld;
  let char = '';
  beforeAll(async () => {
    w = await automationWorld({ artCodes: true });
    // G7: a line on Nadira's Core page (not her Art page) names a folder path that will not exist, and a folder id that
    // is not hers (Qishen's). The page is in the snapshot the audit reads.
    const core = w.repo.liveDocs(w.repo.res.get('nadircor')!).find((d) => d.name === 'Main')!;
    (core as { type: string }).type = 'page';
    w.repo.blocks.set(core.id, {
      version: 1,
      blocks: [
        {
          id: 'f7stale1',
          kind: 'paragraph',
          content: [
            { text: 'Robe art: Characters / Beastkin / Qishen / Nadira al-Khalid / Outfits / Single Robe.' },
          ],
        },
        { id: 'f7stale2', kind: 'paragraph', content: [{ text: 'Older art sat in folder afqishe1.' }] },
      ],
    });
    // A complete snapshot first (the audit's pages); the art below is added after it (the mock serves no bytes for
    // it), and the audit reads the asset library from the asset tree, not the snapshot.
    await w.stack.runtime.snapshots.full(PROJECT, 'manual');
    await w.stack.runtime.audits.settled();
    char = w.assets.byName('Nadira al-Khalid').find((a) => a.type === 'FOLDER')!.id;
    const N = 'Nadira al-Khalid';
    const wardrobe = w.assets.folder('Wardrobe', char);
    w.assets.image(`${N} - Twin Coat - Front`, wardrobe);
    w.assets.image(`${N} - Twin Coat - Back`, wardrobe);
    const single = w.assets.folder('Single Robe', wardrobe);
    w.assets.image(`${N} - Single Robe - Front`, single);
    // An empty Details folder with an empty folder inside (the world's own Forms folder of Nadira's holds an image).
    const details = w.assets.folder('Details', char);
    w.assets.folder('Primary Appearance', details);
    const outfits = w.assets.folder('Outfits', char);
    w.assets.image(`${N} - Court Dress - Front`, w.assets.folder('Court Dress', outfits));
    // G9: the character's folder read live into the asset tree.
    const r = await w.stack.runtime.assets.refreshFolder(PROJECT, char, { depth: 3 });
    expect(r.ok, r.error).toBe(true);
    const audit = await w.stack.runtime.audits.run(PROJECT, 'manual');
    expect(audit.state, audit.summary).toBe('succeeded');
  });
  afterAll(async () => w?.close());

  const a = () => w.stack.runtime.automation;
  const open = (code: string) =>
    w.stack.runtime.audits.store.list(PROJECT, { code: [code], state: 'open', limit: 100 }).findings;

  it('a stale path and a foreign folder id on another of the character’s pages (her Core)', () => {
    const f = open('art_stale_folder_ref').filter((x) => x.pageId === 'nadircor');
    expect(f.map((x) => [x.blockId, x.fix?.args.to ?? x.evidence.suggested ?? null])).toEqual(
      expect.arrayContaining([
        ['f7stale1', 'Characters / Beastkin / Qishen / Nadira al-Khalid / Wardrobe / Single Robe'],
        ['f7stale2', 'Characters / Beastkin / Qishen'],
      ]),
    );
  });

  it('the audit finds each problem', () => {
    expect(open('art_outfit_folder_single')).toHaveLength(1);
    expect(open('art_loose_outfit_pieces')).toHaveLength(1);
    expect(open('art_legacy_folder_empty')).toHaveLength(1);
    // Forms (the world's, with its image) and Outfits / Court Dress: listed for the owner, no fix.
    expect(open('art_legacy_folder_holds_assets').map((f) => f.evidence.folder)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/ Forms$/), expect.stringMatching(/\/ Outfits$/)]),
    );
    expect(open('art_legacy_folder_holds_assets').every((f) => f.fix === null)).toBe(true);
  });

  it('the automation (Propose by default) makes one proposal per finding and writes nothing', async () => {
    const before = w.assets.mutations.length;
    const run = await a().run(PROJECT, 'manual');
    expect(run.state, run.summary ?? '').toBe('succeeded');
    const items = a()
      .store.items(run.id)
      .filter((i) => i.code.startsWith('art_'));
    expect(
      items
        .filter((i) => i.outcome === 'proposed')
        .map((i) => i.code)
        .sort(),
    ).toEqual(
      expect.arrayContaining([
        'art_legacy_folder_empty',
        'art_loose_outfit_pieces',
        'art_outfit_folder_single',
      ]),
    );
    expect(items.every((i) => i.outcome === 'proposed' && i.jobId === null)).toBe(true);
    expect(w.assets.mutations.length).toBe(before);
    // A second run does not propose the same findings again.
    const again = await a().run(PROJECT, 'manual');
    expect(
      a()
        .store.items(again.id)
        .filter((i) => i.code.startsWith('art_')),
    ).toEqual([]);
  });

  it('Apply is refused for a proposal-only code; Off is the owner’s', async () => {
    await expect(a().setMode('owner', PROJECT, 'art_outfit_folder_single', 'apply')).rejects.toMatchObject({
      code: 'PROPOSE_ONLY',
    });
    expect(
      a()
        .codes(PROJECT)
        .find((c) => c.code === 'art_asset_name'),
    ).toMatchObject({
      mode: 'propose',
      modes: ['off', 'propose'],
    });
  });

  it('an approved proposal does exactly its moves and deletes', async () => {
    const items = a()
      .store.codeItems(PROJECT, 'art_outfit_folder_single', 10)
      .concat(a().store.codeItems(PROJECT, 'art_legacy_folder_empty', 10))
      .concat(a().store.codeItems(PROJECT, 'art_loose_outfit_pieces', 10))
      .filter((i) => i.proposalId);
    for (const i of items) {
      const done = await approve(w, i.proposalId!);
      expect(done.job?.status, `${i.code}: ${JSON.stringify(done.job?.lastError)}`).toBe('succeeded');
    }
    const wardrobe = w.assets.byName('Wardrobe', char)[0]!.id;
    expect(w.assets.byName('Single Robe')).toEqual([]);
    expect(w.assets.byName('Nadira al-Khalid - Single Robe - Front')[0]!.folderId).toBe(wardrobe);
    expect(w.assets.byName('Details')).toEqual([]);
    expect(w.assets.byName('Primary Appearance')).toEqual([]);
    const twin = w.assets.byName('Twin Coat', wardrobe)[0]!;
    expect(
      w.assets
        .inside(twin.id)
        .map((x) => x.name)
        .sort(),
    ).toEqual(['Nadira al-Khalid - Twin Coat - Back', 'Nadira al-Khalid - Twin Coat - Front']);
    // The Outfits folder with an asset is left for the owner.
    expect(w.assets.byName('Court Dress')).toHaveLength(1);
  });
});
