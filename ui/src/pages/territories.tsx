import { useState } from 'react';
import { Badge, Button, ErrorNote, Loading, useAction, useConfirm } from '../components';
import { useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';

/**
 * Territories and nations (v3 F6c, ADR 0080), a card of Repository Mappings: the five structural types (Territory,
 * Nation, Divine Realm, Culture family, Religion family), each seeded on your request from the APPROVED rows of the Index
 * Classification page (a row not approved yet is listed as “classify first”, never seeded), one type at a time,
 * Territory first, then Nation. “Add missing” adds new entries and binds unbound roles; existing entries are never
 * changed. A Territory binds the pack’s categories by exact name (`<Territory> <Category>`, Conflicts inside Historical
 * Events); a Nation binds the ten nation roles by the Nation Subindexes rules. A Nation’s short name (`Cantha`) is used
 * only to name its subindexes (`<Nation> <Role>`).
 */

type Kind = 'territory' | 'nation' | 'divine_realm' | 'culture_family' | 'religion_family';
interface TypeStatus {
  kind: Kind;
  singular: string;
  plural: string;
  type: { id: string; seededAt: number | null } | null;
  entries: number;
  needsReview: number;
  bindings: number;
  classifyFirst: number;
  needsTerritoryFirst: boolean;
}
interface Binding {
  role: string;
  nodeId: string;
  status: 'ok' | 'needs_review';
  reason: string;
  origin: string;
  node: { id: string; name: string } | null;
}
interface Entry {
  id: string;
  plural: string;
  shortName: string | null;
  status: 'ok' | 'needs_review';
  review: { code: string; message: string }[];
  source: { id: string; name: string; path: string } | null;
  bindings: Binding[];
}
interface SeedResult {
  created: unknown[];
  bound: unknown[];
  classifyFirst: { id: string; name: string; path: string }[];
  needsReview: number;
}

export function StructuralTypesCard() {
  const r = useScopedApi<{ types: TypeStatus[]; rules: { approved: boolean } | null }>(
    '/registry/structural',
  );
  const [open, setOpen] = useState<Kind | null>(null);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return (
    <section aria-labelledby="reg-structural" className="card" data-structural-types>
      <h3 id="reg-structural">Territories and nations</h3>
      <p className="small-text">
        Seeded from the approved rows of <Link to="/index-classification">Index Classification</Link>, one
        type at a time: Territory first, then Nation. Nation subindexes are decided on{' '}
        <Link to="/nation-subindexes">Nation Subindexes</Link>.
        {r.data.rules === null && ' No pack with the nation roles is attached to this project.'}
      </p>
      <table aria-label="Structural types">
        <thead>
          <tr>
            <th>Type</th>
            <th>Entries</th>
            <th>Roles bound</th>
            <th>Classify first</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {r.data.types.map((t) => (
            <TypeRow
              key={t.kind}
              t={t}
              onChanged={r.reload}
              onOpen={() => setOpen(open === t.kind ? null : t.kind)}
            />
          ))}
        </tbody>
      </table>
      {open && <Entries kind={open} onChanged={r.reload} />}
    </section>
  );
}

function TypeRow({ t, onChanged, onOpen }: { t: TypeStatus; onChanged: () => void; onOpen: () => void }) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [last, setLast] = useState<SeedResult | null>(null);
  const seeded = t.type?.seededAt != null;
  const go = (mode: 'seed' | 'add-missing') =>
    void confirm({
      title: mode === 'seed' ? `Seed ${t.singular}?` : `Add missing ${t.plural}?`,
      message: (
        <p className="small-text">
          Entries come only from rows you approved on Index Classification
          {t.kind === 'territory' || t.kind === 'nation'
            ? '; their roles are bound where the bridge is sure'
            : ''}
          . Anything it is not sure of is marked for review, never guessed.
        </p>
      ),
      confirmLabel: mode === 'seed' ? 'Seed' : 'Add missing',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () => api.post<{ result: SeedResult }>(`/registry/structural/${t.kind}/${mode}`, { confirm: true }),
        mode === 'seed' ? `${t.singular} seeded.` : 'Added.',
      ).then((x) => {
        if (x) {
          setLast(x.result);
          onChanged();
        }
      });
    });
  return (
    <tr data-kind={t.kind}>
      <td>
        <strong>{t.singular}</strong>{' '}
        {seeded ? <Badge tone="ok">seeded</Badge> : <Badge tone="neutral">not seeded</Badge>}
        {last && (
          <div className="small-text" role="status">
            {last.created.length} new, {last.bound.length} role(s) bound
            {last.classifyFirst.length > 0 &&
              `; classify first: ${last.classifyFirst.map((c) => c.name).join(', ')}`}
          </div>
        )}
      </td>
      <td>
        {t.entries}
        {t.needsReview > 0 && <div className="small-text note-bad">{t.needsReview} to review</div>}
      </td>
      <td>{t.kind === 'territory' || t.kind === 'nation' ? t.bindings : '—'}</td>
      <td>{t.classifyFirst > 0 ? <Link to="/index-classification">{t.classifyFirst}</Link> : 0}</td>
      <td>
        {!seeded ? (
          <Button
            disabled={busy || t.needsTerritoryFirst}
            title={t.needsTerritoryFirst ? 'Seed Territory first' : undefined}
            onClick={() => go('seed')}
          >
            Seed {t.singular}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => go('add-missing')}>
            Add missing
          </Button>
        )}{' '}
        {t.type && <Button onClick={onOpen}>Entries</Button>}
      </td>
    </tr>
  );
}

function Entries({ kind, onChanged }: { kind: Kind; onChanged: () => void }) {
  const r = useScopedApi<{ type: { plural: string } | null; entries: Entry[] }>(
    `/registry/structural/${kind}`,
  );
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return (
    <div className="table-wrap" data-entries={kind}>
      <table aria-label={`${r.data.type?.plural ?? kind} entries`}>
        <thead>
          <tr>
            <th>Entry</th>
            {kind === 'nation' && <th>Short name</th>}
            <th>Roles</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {r.data.entries.map((e) => (
            <EntryRow
              key={e.id}
              e={e}
              nation={kind === 'nation'}
              onChanged={() => {
                r.reload();
                onChanged();
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryRow({ e, nation, onChanged }: { e: Entry; nation: boolean; onChanged: () => void }) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const [short, setShort] = useState(e.shortName ?? '');
  const save = () =>
    void run(
      () => api.put(`/registry/taxonomy/${encodeURIComponent(e.id)}`, { shortName: short.trim() || null }),
      'Saved.',
    ).then((x) => {
      if (x) onChanged();
    });
  return (
    <tr data-entry={e.id}>
      <td>
        <strong>{e.plural}</strong>
        {e.source && <div className="small-text">{e.source.path}</div>}
      </td>
      {nation && (
        <td>
          <input
            aria-label={`Short name of ${e.plural}`}
            value={short}
            placeholder={e.plural}
            onChange={(x) => setShort(x.target.value)}
          />{' '}
          <Button disabled={busy || short.trim() === (e.shortName ?? '')} onClick={save}>
            Save
          </Button>
        </td>
      )}
      <td className="small-text">
        {e.bindings.length === 0
          ? 'none bound'
          : e.bindings.map((b) => (
              <div key={b.role}>
                {b.role}: {b.node?.name ?? b.nodeId}{' '}
                {b.status === 'needs_review' && <Badge tone="warn">review</Badge>}
                {b.reason && <span className="muted"> {b.reason}</span>}
              </div>
            ))}
      </td>
      <td className="small-text">
        {e.status === 'needs_review'
          ? e.review.map((x) => <div key={x.code + x.message}>{x.message}</div>)
          : 'ok'}
      </td>
    </tr>
  );
}
