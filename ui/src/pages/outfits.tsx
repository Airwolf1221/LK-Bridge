import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, useAction } from '../components';
import { fmtTime } from '../format';
import { useProjectApi, useScopedApi } from '../project';

/**
 * v3 F7 (ADR 0070, G3): the outfit record, on the Asset Tree page. "Seed" reads one character's folders LIVE and lists
 * the outfits G3's rules find (a Wardrobe folder is an outfit; a loose piece named “<Character> - <Outfit> - …” is
 * one), with anything ambiguous listed and never guessed; nothing is recorded until you save it. Aliases are yours to
 * add or remove; an art call naming an alias adds to that outfit.
 */

interface Piece {
  assetId: string;
  name: string;
}
interface Outfit {
  id: string;
  name: string;
  folderId: string | null;
  aliases: string[];
  pieces: Piece[];
}
interface SeedOutfit {
  name: string;
  folderId: string | null;
  pieces: Piece[];
  from: string;
}
interface Seed {
  id: string;
  characterFolderId: string;
  characterName: string;
  state: 'pending' | 'saved' | 'discarded';
  createdAt: number;
  result: {
    outfits: SeedOutfit[];
    ambiguous: { assetId: string; name: string; why: string }[];
    read: { requests: number };
  };
}
interface OutfitsResponse {
  characters: { characterFolderId: string; characterName: string; outfits: number }[];
  outfits?: Outfit[];
  seeds: Seed[];
}

export function OutfitsCard() {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const [character, setCharacter] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [alias, setAlias] = useState<Record<string, string>>({});
  const list = useScopedApi<OutfitsResponse>(
    folderId ? `/art/outfits?folderId=${encodeURIComponent(folderId)}` : '/art/outfits',
  );
  const data = list.data;
  const pending = (data?.seeds ?? []).filter((s) => s.state === 'pending');

  const seed = () =>
    void run(
      () => api.post<{ seed: Seed }>('/art/outfits/seed', { character: character.trim() }),
      'Read live: review the outfits below, then save or discard.',
    ).then(list.reload);
  const save = (id: string) =>
    void run(() => api.post(`/art/outfits/seed/${id}/save`, {}), 'Outfits saved.').then(list.reload);
  const discard = (id: string) =>
    void run(() => api.post(`/art/outfits/seed/${id}/discard`, {}), 'Seeding discarded.').then(list.reload);
  const addAlias = (o: Outfit) =>
    void run(
      () => api.post(`/art/outfits/${o.id}/aliases`, { alias: (alias[o.id] ?? '').trim() }),
      'Alias added.',
    ).then(() => {
      setAlias({ ...alias, [o.id]: '' });
      list.reload();
    });
  const removeAlias = (o: Outfit, a: string) =>
    void run(() => api.post(`/art/outfits/${o.id}/aliases/remove`, { alias: a }), 'Alias removed.').then(
      list.reload,
    );

  return (
    <section className="card" aria-labelledby="assets-outfits-h" data-testid="assets-outfits">
      <h2 id="assets-outfits-h">Outfits</h2>
      <p className="muted small-text">
        Each character’s outfits decide where outfit art goes: an outfit’s only piece loose in Wardrobe, two
        or more in Wardrobe / &lt;Outfit&gt;. Seeding reads a character’s folders live and shows what it
        found; anything it cannot read without guessing is listed. Nothing is recorded until you save it.
      </p>
      <ErrorNote error={list.error} onRetry={list.reload} />
      <div className="row">
        <label>
          Character folder (its name)
          <input
            value={character}
            onChange={(e) => setCharacter(e.target.value)}
            placeholder="Soraya bint al-Noor"
            data-testid="outfits-character"
          />
        </label>
        <Button onClick={seed} disabled={busy || character.trim() === ''}>
          Seed (read live)
        </Button>
      </div>

      {pending.map((s) => (
        <div key={s.id} className="card" data-testid="outfits-seed">
          <h3>
            {s.characterName} <Badge tone="warn">Waiting for your review</Badge>
          </h3>
          <p className="muted small-text">
            Read live {fmtTime(s.createdAt)} ({s.result.read.requests} request(s)).
          </p>
          {s.result.outfits.length === 0 ? (
            <Empty>No outfit found.</Empty>
          ) : (
            <ul>
              {s.result.outfits.map((o) => (
                <li key={o.name}>
                  <strong>{o.name}</strong>: {o.pieces.length} piece(s), {o.from}
                </li>
              ))}
            </ul>
          )}
          {s.result.ambiguous.length > 0 && (
            <>
              <p>Not read (for you to decide):</p>
              <ul data-testid="outfits-ambiguous">
                {s.result.ambiguous.map((a) => (
                  <li key={a.assetId}>
                    “{a.name}”: {a.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <Button onClick={() => save(s.id)} disabled={busy}>
              Save
            </Button>
            <Button onClick={() => discard(s.id)} disabled={busy}>
              Discard
            </Button>
          </div>
        </div>
      ))}

      {(data?.characters ?? []).length > 0 && (
        <div className="row">
          {(data?.characters ?? []).map((c) => (
            <button
              key={c.characterFolderId}
              type="button"
              className="small"
              aria-pressed={folderId === c.characterFolderId}
              onClick={() => setFolderId(c.characterFolderId)}
            >
              {c.characterName} ({c.outfits})
            </button>
          ))}
        </div>
      )}
      {data?.outfits && (
        <table data-testid="outfits-table">
          <thead>
            <tr>
              <th>Outfit</th>
              <th>Pieces</th>
              <th>Folder</th>
              <th>Aliases</th>
            </tr>
          </thead>
          <tbody>
            {data.outfits.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td>{o.pieces.length}</td>
                <td>{o.folderId ? 'Wardrobe / ' + o.name : 'loose in Wardrobe'}</td>
                <td>
                  {o.aliases.map((a) => (
                    <span key={a} className="row">
                      {a}{' '}
                      <button
                        type="button"
                        className="small"
                        onClick={() => removeAlias(o, a)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </span>
                  ))}
                  <input
                    value={alias[o.id] ?? ''}
                    onChange={(e) => setAlias({ ...alias, [o.id]: e.target.value })}
                    aria-label={`New alias for ${o.name}`}
                  />
                  <button
                    type="button"
                    className="small"
                    onClick={() => addAlias(o)}
                    disabled={busy || (alias[o.id] ?? '').trim() === ''}
                  >
                    Add alias
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
