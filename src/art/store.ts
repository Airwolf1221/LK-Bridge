/**
 * v3 F7 (ADR 0070, G3): the outfit record: character (its asset folder) → outfits (name, aliases) → pieces (asset
 * ids) and folder (null while loose). Written by the art jobs (`recordPlacement`, after the job's writes), by the owner's
 * seeding (`saveSeed`, after review) and the owner's aliases. The bridge's own database only.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import { outfitKey } from './names.js';

export interface OutfitRecord {
  readonly id: string;
  readonly projectId: string;
  readonly characterFolderId: string;
  readonly characterName: string;
  readonly name: string;
  readonly folderId: string | null;
  readonly aliases: readonly string[];
  readonly pieces: readonly { readonly assetId: string; readonly name: string }[];
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a seeding found for one outfit. */
export interface SeedOutfit {
  readonly name: string;
  readonly folderId: string | null;
  readonly pieces: readonly { readonly assetId: string; readonly name: string }[];
  /** Where it was read from, in words ("folder Wardrobe / Jade Moon Kimono", "loose piece …"). */
  readonly from: string;
}

export interface SeedResult {
  readonly outfits: readonly SeedOutfit[];
  /** What could not be read without guessing, each with why: never recorded. */
  readonly ambiguous: readonly { readonly assetId: string; readonly name: string; readonly why: string }[];
  /** What was read live (G9), and when. */
  readonly read: {
    readonly requests: number;
    readonly at: number;
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly wardrobeFolderId: string | null;
}

export interface SeedView {
  readonly id: string;
  readonly projectId: string;
  readonly characterFolderId: string;
  readonly characterName: string;
  readonly result: SeedResult;
  readonly state: 'pending' | 'saved' | 'discarded';
  readonly createdBy: string;
  readonly createdAt: number;
  readonly decidedBy: string | null;
  readonly decidedAt: number | null;
}

interface OutfitRow {
  id: string;
  project_id: string;
  character_folder_id: string;
  character_name: string;
  name: string;
  name_key: string;
  folder_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export class OutfitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutfitError';
  }
}

const newId = (p: string) => `${p}_${randomBytes(8).toString('hex')}`;

export class OutfitStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  private view(r: OutfitRow): OutfitRecord {
    const aliases = this.db
      .prepare('SELECT alias FROM art_outfit_aliases WHERE outfit_id = ? ORDER BY at, alias')
      .all(r.id) as { alias: string }[];
    const pieces = this.db
      .prepare('SELECT asset_id, name FROM art_outfit_pieces WHERE outfit_id = ? ORDER BY added_at, name')
      .all(r.id) as { asset_id: string; name: string }[];
    return {
      id: r.id,
      projectId: r.project_id,
      characterFolderId: r.character_folder_id,
      characterName: r.character_name,
      name: r.name,
      folderId: r.folder_id,
      aliases: aliases.map((a) => a.alias),
      pieces: pieces.map((p) => ({ assetId: p.asset_id, name: p.name })),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** A character's outfits, by name. */
  forCharacter(projectId: string, characterFolderId: string): OutfitRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM art_outfits WHERE project_id = ? AND character_folder_id = ? ORDER BY name_key')
      .all(projectId, characterFolderId) as OutfitRow[];
    return rows.map((r) => this.view(r));
  }

  /** Every character with outfits in a project. */
  characters(projectId: string): { characterFolderId: string; characterName: string; outfits: number }[] {
    return (
      this.db
        .prepare(
          `SELECT character_folder_id, MAX(character_name) AS character_name, COUNT(*) AS n FROM art_outfits
           WHERE project_id = ? GROUP BY character_folder_id ORDER BY character_name`,
        )
        .all(projectId) as { character_folder_id: string; character_name: string; n: number }[]
    ).map((r) => ({
      characterFolderId: r.character_folder_id,
      characterName: r.character_name,
      outfits: r.n,
    }));
  }

  get(projectId: string, id: string): OutfitRecord | null {
    const r = this.db
      .prepare('SELECT * FROM art_outfits WHERE project_id = ? AND id = ?')
      .get(projectId, id) as OutfitRow | undefined;
    return r ? this.view(r) : null;
  }

  /** The outfit an asset is a piece of (any character), or null. */
  outfitOfAsset(projectId: string, assetId: string): OutfitRecord | null {
    const r = this.db
      .prepare(
        `SELECT o.* FROM art_outfits o JOIN art_outfit_pieces p ON p.outfit_id = o.id
         WHERE o.project_id = ? AND p.asset_id = ? LIMIT 1`,
      )
      .get(projectId, assetId) as OutfitRow | undefined;
    return r ? this.view(r) : null;
  }

  /**
   * After an art job's writes (G2): the outfit found by name (created when new), its new pieces added, its folder set
   * when one was made or used. Idempotent: a piece or alias already there is kept.
   */
  recordPlacement(r: {
    readonly projectId: string;
    readonly characterFolderId: string;
    readonly characterName: string;
    readonly outfit: string;
    readonly folderId: string | null;
    readonly pieces: readonly { readonly assetId: string; readonly name: string }[];
    readonly by: string;
  }): OutfitRecord {
    const t = this.now();
    return this.db.transaction(() => {
      const key = outfitKey(r.outfit);
      let row = this.db
        .prepare(
          'SELECT * FROM art_outfits WHERE project_id = ? AND character_folder_id = ? AND name_key = ?',
        )
        .get(r.projectId, r.characterFolderId, key) as OutfitRow | undefined;
      if (!row) {
        const id = newId('otf');
        this.db
          .prepare(
            `INSERT INTO art_outfits (id, project_id, character_folder_id, character_name, name, name_key, folder_id,
               created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, r.projectId, r.characterFolderId, r.characterName, r.outfit, key, r.folderId, r.by, t, t);
        row = this.db.prepare('SELECT * FROM art_outfits WHERE id = ?').get(id) as OutfitRow;
      } else {
        this.db
          .prepare(
            'UPDATE art_outfits SET folder_id = COALESCE(?, folder_id), character_name = ?, updated_at = ? WHERE id = ?',
          )
          .run(r.folderId, r.characterName, t, row.id);
      }
      const add = this.db.prepare(
        'INSERT OR IGNORE INTO art_outfit_pieces (outfit_id, asset_id, name, added_at) VALUES (?, ?, ?, ?)',
      );
      for (const p of r.pieces) add.run(row.id, p.assetId, p.name, t);
      return this.view(this.db.prepare('SELECT * FROM art_outfits WHERE id = ?').get(row.id) as OutfitRow);
    })();
  }

  /** The owner adds an alias (G3). Refused when another outfit of the character already answers to that name. */
  addAlias(projectId: string, outfitId: string, alias: string, by: string): OutfitRecord {
    const o = this.get(projectId, outfitId);
    if (!o) throw new OutfitError('OUTFIT_NOT_FOUND', 'No such outfit.');
    const a = alias.replace(/\s+/g, ' ').trim();
    if (a === '') throw new OutfitError('INVALID_ALIAS', 'An alias needs some text.');
    const key = outfitKey(a);
    for (const other of this.forCharacter(projectId, o.characterFolderId)) {
      if (other.id === o.id) continue;
      if (outfitKey(other.name) === key || other.aliases.some((x) => outfitKey(x) === key))
        throw new OutfitError('ALIAS_TAKEN', `“${a}” already names ${other.name}.`);
    }
    if (outfitKey(o.name) === key) throw new OutfitError('ALIAS_IS_NAME', `“${a}” is the outfit’s own name.`);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO art_outfit_aliases (outfit_id, alias, alias_key, by, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(o.id, a, key, by, this.now());
    return this.get(projectId, outfitId)!;
  }

  removeAlias(projectId: string, outfitId: string, alias: string): OutfitRecord {
    const o = this.get(projectId, outfitId);
    if (!o) throw new OutfitError('OUTFIT_NOT_FOUND', 'No such outfit.');
    this.db
      .prepare('DELETE FROM art_outfit_aliases WHERE outfit_id = ? AND alias_key = ?')
      .run(o.id, outfitKey(alias));
    return this.get(projectId, outfitId)!;
  }

  // ------------------------------------------------------------------------------------------ seeding

  createSeed(s: {
    projectId: string;
    characterFolderId: string;
    characterName: string;
    result: SeedResult;
    by: string;
  }): SeedView {
    const id = newId('seed');
    this.db
      .prepare(
        `INSERT INTO art_outfit_seeds (id, project_id, character_folder_id, character_name, result, state, created_by,
           created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, s.projectId, s.characterFolderId, s.characterName, JSON.stringify(s.result), s.by, this.now());
    return this.seed(s.projectId, id)!;
  }

  seed(projectId: string, id: string): SeedView | null {
    const r = this.db
      .prepare('SELECT * FROM art_outfit_seeds WHERE project_id = ? AND id = ?')
      .get(projectId, id) as
      | {
          id: string;
          project_id: string;
          character_folder_id: string;
          character_name: string;
          result: string;
          state: SeedView['state'];
          created_by: string;
          created_at: number;
          decided_by: string | null;
          decided_at: number | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      projectId: r.project_id,
      characterFolderId: r.character_folder_id,
      characterName: r.character_name,
      result: JSON.parse(r.result) as SeedResult,
      state: r.state,
      createdBy: r.created_by,
      createdAt: r.created_at,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    };
  }

  /**
   * The owner saves a reviewed seeding: each outfit it found is recorded (an existing one of the same name keeps its
   * aliases; its pieces and folder become what was read). Outfits it did not find are left as they are.
   */
  saveSeed(projectId: string, id: string, by: string): { seed: SeedView; outfits: OutfitRecord[] } {
    const s = this.seed(projectId, id);
    if (!s) throw new OutfitError('SEED_NOT_FOUND', 'No such seeding.');
    if (s.state !== 'pending') throw new OutfitError('SEED_DECIDED', `This seeding was already ${s.state}.`);
    const t = this.now();
    this.db.transaction(() => {
      for (const o of s.result.outfits) {
        const rec = this.recordPlacement({
          projectId,
          characterFolderId: s.characterFolderId,
          characterName: s.characterName,
          outfit: o.name,
          folderId: o.folderId,
          pieces: [],
          by,
        });
        this.db
          .prepare('UPDATE art_outfits SET folder_id = ?, updated_at = ? WHERE id = ?')
          .run(o.folderId, t, rec.id);
        this.db.prepare('DELETE FROM art_outfit_pieces WHERE outfit_id = ?').run(rec.id);
        const add = this.db.prepare(
          'INSERT OR IGNORE INTO art_outfit_pieces (outfit_id, asset_id, name, added_at) VALUES (?, ?, ?, ?)',
        );
        for (const p of o.pieces) add.run(rec.id, p.assetId, p.name, t);
      }
      this.db
        .prepare("UPDATE art_outfit_seeds SET state = 'saved', decided_by = ?, decided_at = ? WHERE id = ?")
        .run(by, t, id);
    })();
    return { seed: this.seed(projectId, id)!, outfits: this.forCharacter(projectId, s.characterFolderId) };
  }

  discardSeed(projectId: string, id: string, by: string): SeedView {
    const s = this.seed(projectId, id);
    if (!s) throw new OutfitError('SEED_NOT_FOUND', 'No such seeding.');
    if (s.state !== 'pending') throw new OutfitError('SEED_DECIDED', `This seeding was already ${s.state}.`);
    this.db
      .prepare("UPDATE art_outfit_seeds SET state = 'discarded', decided_by = ?, decided_at = ? WHERE id = ?")
      .run(by, this.now(), id);
    return this.seed(projectId, id)!;
  }

  recentSeeds(projectId: string, limit = 20): SeedView[] {
    const ids = this.db
      .prepare('SELECT id FROM art_outfit_seeds WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(projectId, limit) as { id: string }[];
    return ids.map((r) => this.seed(projectId, r.id)!);
  }
}
