/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * CR-2026-11-R4, the owner's queued request for F4.1: the one alias parser (`splitAliases`) splits an Aliases value at
 * ";" (and line breaks) AND at commas outside brackets. F4.1 had dropped commas altogether (ADR 0064 amendment 2,
 * decision 3's departure), so "Rita von Katzen, Yamato" was one alias. A comma inside a bracketed note ("(from Zahras
 * 1st, 4A 192)") or inside a bracket that is part of a name ("(the Elder, of Hohenfalk)") never splits.
 *
 * - OW-10: commas outside brackets split; inside brackets they do not; ";" and line breaks still split.
 * - OW-11: a piece that is only a date (an unbracketed note's tail: "…, 4A 192") is never an alias.
 * - OW-12: end to end, `arkona_as_of` reads a birth through the second of two comma-separated aliases.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitAliases } from '../../../src/packs/naming/namesakes.js';
import { SidebarModel } from '../../resources/world.js';
import { IDENTITY_KEYS } from '../../packs/world.js';
import { L, liveRunWorld, type LiveWorld } from '../../consistency/live-world.js';

vi.setConfig({ testTimeout: 120_000 });

describe('the alias parser splits at commas outside brackets (the owner’s rule)', () => {
  it('OW-10: commas outside brackets split; inside a bracket they do not; ";" and line breaks still split', () => {
    expect(splitAliases('Rita von Katzen, Yamato, Katsuragi Yamato')).toEqual([
      'Rita von Katzen',
      'Yamato',
      'Katsuragi Yamato',
    ]);
    expect(splitAliases('Rita von Katzen (4A 99-192), Yamato (from Zahras 1st, 4A 192)')).toEqual([
      'Rita von Katzen',
      'Yamato',
    ]);
    expect(splitAliases('Takamori Ayame (birth); Ayame al-Jabaal, the Jade Heron')).toEqual([
      'Takamori Ayame',
      'Ayame al-Jabaal',
      'the Jade Heron',
    ]);
    expect(splitAliases('Leopold (the Elder, of Hohenfalk), Leo\nLeopold I')).toEqual([
      'Leopold (the Elder, of Hohenfalk)',
      'Leo',
      'Leopold I',
    ]);
    // F4.1's own fixtures are unchanged.
    expect(
      splitAliases('Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)'),
    ).toEqual(['Rita von Katzen', 'Yamato', 'Katsuragi Yamato']);
    expect(splitAliases('Ayame (from Zahras 1st, 4A 47); Leopold (the Elder)')).toEqual([
      'Ayame',
      'Leopold (the Elder)',
    ]);
    expect(splitAliases('Takamori Ayame (birth); Ayame al-Jabaal (from 4A 47); …')).toEqual([
      'Takamori Ayame',
      'Ayame al-Jabaal',
    ]);
  });

  it('OW-11: a piece that is only a date is never an alias', () => {
    const got = splitAliases('Yamato from Zahras 1st, 4A 192; Katsuragi Yamato');
    expect(got).not.toContain('4A 192');
    expect(got).toContain('Katsuragi Yamato');
    expect(splitAliases(', , ;')).toEqual([]);
  });
});

describe('end to end (OW-12)', () => {
  let w: LiveWorld;
  const ID = 'jdheron1';
  beforeAll(async () => {
    w = await liveRunWorld();
    w.repo.seed({
      id: ID,
      name: '[BSRC] Ayame Kurosaki - Character Reference',
      parentId: L.idx,
      referenceType: 'Compact Character Reference',
      canonical: 'Ayame Kurosaki',
      tags: ['CANON', 'Character', 'Human'],
    });
    const v: Record<string, string> = {
      Status: 'Authoritative',
      'Continuity Type': 'CANON',
      Continuity: 'Main',
      Inheritance: 'None',
      Subject: 'Ayame Kurosaki',
      'Canonical Display Name': 'Ayame Kurosaki',
      'Personal / Given Name': 'Ayame',
      'Family / Surname': 'Kurosaki',
      Aliases: 'Lady of the Jade Gate, the Jade Heron',
      'Naming Culture': 'Velaran',
      'Reference Type': 'Compact Character Reference',
      Scope: 'Ayame Kurosaki, a person of Arkona',
      'Race / Species': 'Human',
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
    };
    w.sidebars.page(ID, [
      SidebarModel.kv(
        'kvjdher1',
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links('dpjdher1', 'Dependencies', []),
      SidebarModel.links('rljdher1', 'Related Sources', []),
      { id: 'tgjdher1', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    w.setBody(ID, [
      { id: 'jh1', kind: 'paragraph', content: [{ text: 'The Jade Heron was born on Camue 1st, 4A 100.' }] },
    ]);
    w.rebuildTree();
    await w.snapshot();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  it('OW-12: arkona_as_of reads the birth through the second of two comma-separated aliases', async () => {
    const r = await w.call('arkona_as_of', { characters: ['Ayame Kurosaki'], date: '4A 120' });
    const c = r.body.characters?.[0];
    expect(c?.born, r.text.slice(0, 500)).toMatchObject({ value: 'Camue 1st, 4A 100' });
  });
});
