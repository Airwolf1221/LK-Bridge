import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { qs } from '../api';
import { useProjectApi, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import { Link } from '../router';

/**
 * Nation Subindexes (v3 F6c, ADR 0080; the owner's rulings of 26 November 2026), in the Setup group beside Reference
 * Types and Index Classification: every direct child index of every nation (a Nation entry once that type is seeded,
 * else an index directly in a <Territory> Polities index), the role its name matches (a role name, an approved variant,
 * or your mapping), and the unified name it would take, `<Nation> <Role>` (the nation’s short name first).
 *
 * Per row: **Accept** (the role and name as proposed), **Map to a role** (an unmatched child; “for every page with this
 * name” maps every nation’s child of that exact name in one request), **Keep as a specialist subindex** (its name
 * stays, no role, exempt from the checks), **Not a subindex** (left alone), and **Undo** until the rename is applied.
 * Every decision asks for the step-up and is recorded in the audit log. Nothing is renamed here: accepted and mapped rows
 * become `nation_subindex_nonstandard` findings in the Audits, which the Automation page can run (default Off).
 *
 * Two children of one nation with one role are a collision: neither is renamed (merge or re-map first; the bridge never
 * merges or moves pages). A name that spans two roles (“Government & Institutions”) lists the index’s pages with their
 * primary category tags, so you can see what would sit under the wrong name.
 */

type Status = 'proposed' | 'unmatched' | 'accepted' | 'mapped' | 'specialist' | 'not_subindex';
const STATUSES: Status[] = ['proposed', 'unmatched', 'accepted', 'mapped', 'specialist', 'not_subindex'];
const STATUS_LABEL: Record<Status, string> = {
  proposed: 'proposed',
  unmatched: 'unmatched',
  accepted: 'accepted',
  mapped: 'mapped',
  specialist: 'specialist',
  not_subindex: 'not a subindex',
};
const STATUS_TONE: Record<Status, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  proposed: 'warn',
  unmatched: 'bad',
  accepted: 'ok',
  mapped: 'ok',
  specialist: 'neutral',
  not_subindex: 'neutral',
};
const VIA: Record<string, string> = {
  role: 'role name',
  variant: 'approved variant',
  mapping: 'your mapping',
};
const FORM: Record<string, string> = {
  bare: 'bare',
  nation: '<Nation> <word>',
  dash: '<Nation> - <word>',
  exact: 'exact name',
};

interface Row {
  id: string;
  nation: { id: string; name: string; displayName: string; shortName: string | null };
  name: string;
  displayName: string;
  path: string;
  link: string;
  children: number;
  classification: 'nav' | 'unapproved';
  match: { role: string; via: string; form: string; word: string } | null;
  role: string | null;
  proposedName: string | null;
  standard: boolean;
  status: Status;
  decision: { id: string; action: string; role: string | null; via: string; by: string; at: number } | null;
  collision: { id: string; name: string }[];
  spans: { roles: string[]; pages: { id: string; name: string; category: string | null }[] } | null;
}
interface Response {
  report: {
    pack: { id: string; version: number; approvedVersion: number | null };
    rules: {
      approved: boolean;
      roles: string[];
      variants: { variant: string; role: string }[];
      nationSeeded: boolean;
    };
    nations: { id: string; name: string; shortName: string | null }[];
    rows: Row[];
    totalRows: number;
    counts: Record<Status, number> & { collision: number };
  };
  bulkMax: number;
}

/** Rows a page of the table shows (fetched a page at a time). */
export const PAGE_ROWS = 100;

export function NationSubindexesPage() {
  const [status, setStatus] = useState<Status | ''>('');
  const [nation, setNation] = useState('');
  const [nameText, setNameText] = useState('');
  const [collision, setCollision] = useState(false);
  const [offset, setOffset] = useState(0);
  const filterKey = `${status}\u0000${nation}\u0000${nameText}\u0000${collision}`;
  const [seen, setSeen] = useState(filterKey);
  if (seen !== filterKey) {
    setSeen(filterKey);
    setOffset(0);
  }
  const path = `/nation-subindexes${qs({
    status: status || undefined,
    nation: nation || undefined,
    name: nameText.trim() || undefined,
    collision: collision ? 'true' : undefined,
    offset: offset || undefined,
    limit: PAGE_ROWS,
  })}`;
  const r = useScopedApi<Response>(path);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data.report;
  return (
    <>
      <PageHeader title="Nation Subindexes" />
      <p>
        A nation’s subindexes follow one list of roles, each named <code>&lt;Nation&gt; &lt;Role&gt;</code>{' '}
        (the nation’s short name first, set on <Link to="/mappings">Repository Mappings</Link>). You decide
        each row; nothing is renamed here: accepted and mapped rows become proposals in the{' '}
        <Link to="/audits">Audits</Link> (<code>nation_subindex_nonstandard</code>).
      </p>
      <section aria-labelledby="ns-rules" className="card" data-rules>
        <h2 id="ns-rules">The roles</h2>
        <p className="small-text">
          Pack {d.pack.id} version {d.pack.version}
          {d.pack.approvedVersion !== null
            ? ` (approved: ${d.pack.approvedVersion})`
            : ' (not approved: approve it on the Packs page)'}
          . Nations:{' '}
          {d.rules.nationSeeded
            ? 'the Nation entries'
            : 'by position (seed the Nation type to use its entries)'}
          .
        </p>
        <ol className="small-text">
          {d.rules.roles.map((x) => (
            <li key={x}>
              {x}
              {d.rules.variants.filter((v) => v.role === x).length > 0 &&
                ` (also: ${d.rules.variants
                  .filter((v) => v.role === x)
                  .map((v) => v.variant)
                  .join(', ')})`}
            </li>
          ))}
        </ol>
        <p className="small-text" data-counts>
          {STATUSES.map((s) => `${STATUS_LABEL[s]}: ${d.counts[s] ?? 0}`).join(' · ')} · collisions:{' '}
          {d.counts.collision}
        </p>
      </section>
      <section aria-labelledby="ns-rows">
        <h2 id="ns-rows">Children of nations</h2>
        <div className="filters" role="group" aria-label="Filters">
          <label>
            Status{' '}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Status | '')}
              aria-label="Status"
            >
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Nation{' '}
            <select value={nation} onChange={(e) => setNation(e.target.value)} aria-label="Nation">
              <option value="">Any</option>
              {d.nations.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Name contains{' '}
            <input
              aria-label="Name contains"
              value={nameText}
              onChange={(e) => setNameText(e.target.value)}
            />
          </label>{' '}
          <label>
            <input type="checkbox" checked={collision} onChange={(e) => setCollision(e.target.checked)} />{' '}
            Collisions only
          </label>
        </div>
        {d.rows.length === 0 ? (
          <Empty>No child of a nation matches.</Empty>
        ) : (
          <div className="table-wrap">
            <table aria-label="Children of nations">
              <thead>
                <tr>
                  <th>Nation</th>
                  <th>Child index</th>
                  <th>Pages</th>
                  <th>Role</th>
                  <th>Proposed name</th>
                  <th>Status</th>
                  <th>Decide</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((row) => (
                  <SubindexRow
                    key={row.id}
                    row={row}
                    roles={d.rules.roles}
                    bulkMax={r.data!.bulkMax}
                    onChanged={r.reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.totalRows > PAGE_ROWS && (
          <p className="pager" role="group" aria-label="Pages">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_ROWS))}>
              Previous
            </Button>{' '}
            <span className="small-text">
              Rows {offset + 1} to {Math.min(offset + PAGE_ROWS, d.totalRows)} of {d.totalRows}
            </span>{' '}
            <Button
              disabled={offset + PAGE_ROWS >= d.totalRows}
              onClick={() => setOffset(offset + PAGE_ROWS)}
            >
              Next
            </Button>
          </p>
        )}
      </section>
    </>
  );
}

function SubindexRow({
  row,
  roles,
  bulkMax,
  onChanged,
}: {
  row: Row;
  roles: string[];
  bulkMax: number;
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const withReauth = useReauth();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [mapping, setMapping] = useState(false);
  const [role, setRole] = useState(row.role ?? roles[0] ?? '');
  const [all, setAll] = useState(false);
  const post = (path: string, body: Record<string, unknown>, done: string) =>
    void run(() => withReauth(() => api.post(path, { pageId: row.id, confirm: true, ...body })), done).then(
      (x) => {
        if (x) {
          setMapping(false);
          onChanged();
        }
      },
    );
  const decide = (action: string, extra: Record<string, unknown> = {}) =>
    post('/nation-subindexes/decide', { action, ...extra }, `${row.name}: recorded.`);
  const map = () => {
    if (!all) return decide('map', { role });
    void confirm({
      title: `Map every child named “${row.displayName}” to ${role}?`,
      message: (
        <p className="small-text">
          Every nation’s child of exactly this name not decided yet takes this role, in one request (at most{' '}
          {bulkMax}).
        </p>
      ),
      confirmLabel: 'Map all',
    }).then((ok) => {
      if (ok) post('/nation-subindexes/map-all', { role }, 'Mapped.');
    });
  };
  const undo = () => post('/nation-subindexes/undo', {}, `${row.name}: undone.`);
  return (
    <tr data-row={row.id}>
      <td>
        {row.nation.name}
        {row.nation.shortName && <div className="small-text">short name: {row.nation.shortName}</div>}
      </td>
      <td>
        <Link to={`/tree?node=${encodeURIComponent(row.id)}`}>
          <strong>{row.name}</strong>
        </Link>
        {row.classification === 'unapproved' && (
          <div className="small-text">
            <Link to={`/index-classification?page=${encodeURIComponent(row.id)}`}>
              not yet approved as [NAV]
            </Link>
          </div>
        )}
        {row.spans && (
          <details className="small-text" data-spans>
            <summary>names two roles ({row.spans.roles.join(', ')}): its pages</summary>
            <ul>
              {row.spans.pages.map((p) => (
                <li key={p.id}>
                  {p.name} <span className="muted">({p.category ?? 'no primary category'})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td>{row.children}</td>
      <td>
        {row.role ?? <span className="muted">none</span>}
        {row.match && (
          <div className="small-text">
            {VIA[row.match.via] ?? row.match.via}, {FORM[row.match.form] ?? row.match.form}
          </div>
        )}
        {row.decision?.action === 'map' && <div className="small-text">your mapping</div>}
      </td>
      <td>
        {row.proposedName ?? '—'}
        {row.standard && <div className="small-text">already so named</div>}
      </td>
      <td>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        {row.collision.length > 0 && (
          <div className="small-text note-bad" data-collision>
            two subindexes for one role: merge or re-map first ({row.collision.map((c) => c.name).join(', ')})
          </div>
        )}
      </td>
      <td>
        {mapping ? (
          <span role="group" aria-label={`Map ${row.name}`}>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>{' '}
            <label className="small-text">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> for every
              page with this name
            </label>{' '}
            <Button disabled={busy} onClick={map}>
              Save
            </Button>{' '}
            <Button onClick={() => setMapping(false)}>Cancel</Button>
          </span>
        ) : row.decision ? (
          <Button disabled={busy} onClick={undo}>
            Undo
          </Button>
        ) : (
          <span role="group" aria-label={`Decide ${row.name}`}>
            {row.match && (
              <Button disabled={busy} onClick={() => decide('accept')}>
                Accept
              </Button>
            )}{' '}
            <Button disabled={busy} onClick={() => setMapping(true)}>
              Map to a role
            </Button>{' '}
            <Button disabled={busy} onClick={() => decide('specialist')}>
              Keep as a specialist subindex
            </Button>{' '}
            <Button disabled={busy} onClick={() => decide('not_subindex')}>
              Not a subindex
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}
