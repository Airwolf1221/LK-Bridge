import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { qs } from '../api';
import { useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';

/**
 * Index Classification (v3 F6b, ADR 0079; design T12 step 1), in the Setup group next to Reference Types: every current
 * index with the role the rules propose, nav ([NAV], an index that only groups or routes) or subject ([INDEX], an index
 * about one subject), or undecided, and the rule that decided it. Rules use only the bridge's own data (the registry,
 * the narrative layout, the pack's exact-name lists, position): a page's kind is never guessed from its name or body.
 * Working, Archive, Legacy and Design References pages are listed but never proposed.
 *
 * Filter, then per row **Approve** (as proposed), **Change** (to nav or subject, with the subject's kind) or **Leave
 * undecided**. **Approve all as proposed** takes every proposed row of the filter (every page of it, not only the one
 * shown): their ids in ONE request, at most INDEX_CLASSIFY_BULK_MAX at a time, decided in one transaction (running it
 * again touches only the rows still proposed). Every decision is recorded in the audit log.
 * Nothing is renamed or retagged here: approved rows become proposals through the audits (`index_prefix`,
 * `index_tags`), which the Automation page runs (default Propose).
 *
 * **Structural names**: the pack's exact-name lists the rules read, edited here as a new pack version you approve on
 * the Packs page.
 */

type Status = 'proposed' | 'undecided' | 'approved' | 'changed' | 'left_undecided' | 'out_of_scope';
const STATUSES: Status[] = ['proposed', 'undecided', 'approved', 'changed', 'left_undecided', 'out_of_scope'];
const STATUS_LABEL: Record<Status, string> = {
  proposed: 'proposed',
  undecided: 'no rule',
  approved: 'approved',
  changed: 'changed',
  left_undecided: 'left undecided',
  out_of_scope: 'out of scope',
};
const STATUS_TONE: Record<Status, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  proposed: 'warn',
  undecided: 'bad',
  approved: 'ok',
  changed: 'ok',
  left_undecided: 'neutral',
  out_of_scope: 'neutral',
};
type Role = 'nav' | 'subject';
const ROLE_PREFIX: Record<Role, string> = { nav: '[NAV]', subject: '[INDEX]' };

interface Decision {
  id: string;
  pageId: string;
  action: 'approve' | 'change' | 'undecided';
  role: Role | null;
  subject: string | null;
  via: string;
  by: string;
  at: number;
}
interface Row {
  id: string;
  name: string;
  displayName: string;
  path: string;
  currentRole: Role;
  tags: string[];
  proposed: Role | 'undecided';
  subject: string | null;
  rule: string;
  why: string;
  scope: 'in' | 'out';
  area: string | null;
  status: Status;
  decision: Decision | null;
  approvedRole: Role | null;
  approvedSubject: string | null;
  drifted: boolean;
}
type Structural = Record<string, string[] | string>;
interface Response {
  report: {
    pack: { id: string; version: number; approvedVersion: number | null };
    rules: {
      approved: boolean;
      tagSection: 'draft' | 'published';
      orderingInForce: boolean;
      structural: Structural;
      outOfScope: string[];
      templates: { nav: string; subject: string };
    };
    rows: Row[];
    totalRows: number;
    counts: Record<Status, number>;
    ruleText: Record<string, string>;
  };
  approvable: string[];
  bulkMax: number;
  subjects: string[];
}

/** Rows a page of the table shows (fetched a page at a time). */
export const PAGE_ROWS = 100;

const LIST_LABELS: [string, string][] = [
  ['topLevel', 'Top-level branches'],
  ['named', 'Routing indexes by exact name'],
  ['continentCategories', 'Category words of continents and Realmships (“<Continent> <word>”)'],
  ['continentParents', 'Indexes holding the continents'],
  ['realmshipParents', 'Indexes holding the Realmships'],
  ['settingFrameworkCategories', 'Setting Framework’s category indexes'],
  ['divineRealmCategories', 'Divine Realms’ realm categories'],
  ['nationSubindexes', 'Nation subindex words'],
  ['cultureCategories', 'Category words holding culture families'],
  ['religionCategories', 'Category words holding religion families'],
];

const initialParam = (name: string): string => {
  try {
    return new URLSearchParams(window.location.search).get(name) ?? '';
  } catch {
    return '';
  }
};

export function IndexClassificationPage() {
  const [status, setStatus] = useState<Status | ''>(initialParam('page') ? '' : 'proposed');
  const [proposed, setProposed] = useState<Role | 'undecided' | ''>('');
  const [rule, setRule] = useState('');
  const [nameText, setNameText] = useState('');
  const [offset, setOffset] = useState(0);
  const filterKey = `${status}\u0000${proposed}\u0000${rule}\u0000${nameText}`;
  const [seenFilter, setSeenFilter] = useState(filterKey);
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey);
    setOffset(0);
  }
  const path = `/index-classification${qs({
    status: status || undefined,
    proposed: proposed || undefined,
    rule: rule || undefined,
    name: nameText.trim() || undefined,
    offset: offset || undefined,
    limit: PAGE_ROWS,
  })}`;
  const r = useScopedApi<Response>(path);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  const rows = d.report.rows;
  const rules = d.report.rules;
  return (
    <>
      <PageHeader title="Index Classification" />
      <p>
        An index is either a navigation index, <code>[NAV]</code>, that only groups or routes, or a subject
        index, <code>[INDEX]</code>, about one subject (a character, a nation or polity, a continent, a
        Realmship, a named Divine Realm, a culture or religion family, a story). The rules below propose a
        role from the bridge’s own data only; you decide each one. Nothing is renamed or retagged here:
        approved rows become proposals in the <Link to="/audits">Audits</Link> (<code>index_prefix</code>,{' '}
        <code>index_tags</code>).
      </p>
      <section aria-labelledby="ic-rules" className="card" data-rules>
        <h2 id="ic-rules">The rules in force</h2>
        <ul>
          <li>
            Pack {d.report.pack.id} version {d.report.pack.version}
            {d.report.pack.approvedVersion !== null
              ? ` (approved: ${d.report.pack.approvedVersion})`
              : ' (not approved: approve it on the Packs page)'}
            .
          </li>
          <li>
            Order ([NAV], then [INDEX], then sources):{' '}
            <Badge tone={rules.orderingInForce ? 'ok' : 'neutral'}>
              {rules.orderingInForce ? 'in force' : 'not yet: the approved pack does not carry it'}
            </Badge>
          </li>
          <li>
            Index tags (Navigation, or the subject’s category):{' '}
            <Badge tone={rules.tagSection === 'published' ? 'ok' : 'neutral'}>
              {rules.tagSection === 'published'
                ? 'published in the Tagging Standard'
                : 'unpublished: the old tag rules stay in force'}
            </Badge>
          </li>
          <li>
            Templates: <code>{rules.templates.nav}</code> and <code>{rules.templates.subject}</code>.
          </li>
        </ul>
        <p className="small-text" data-counts>
          {STATUSES.map((s) => `${STATUS_LABEL[s]}: ${d.report.counts[s] ?? 0}`).join(' · ')}
        </p>
      </section>
      <section aria-labelledby="ic-indexes">
        <h2 id="ic-indexes">Indexes</h2>
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
            Proposed{' '}
            <select
              value={proposed}
              onChange={(e) => setProposed(e.target.value as Role | 'undecided' | '')}
              aria-label="Proposed"
            >
              <option value="">Any</option>
              <option value="nav">[NAV]</option>
              <option value="subject">[INDEX]</option>
              <option value="undecided">undecided</option>
            </select>
          </label>{' '}
          <label>
            Rule{' '}
            <select value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Rule">
              <option value="">Any</option>
              {Object.keys(d.report.ruleText).map((k) => (
                <option key={k} value={k}>
                  {k}
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
          </label>
        </div>
        <BulkApprove ids={d.approvable} bulkMax={d.bulkMax} onChanged={r.reload} />
        {rows.length === 0 ? (
          <Empty>No index matches.</Empty>
        ) : (
          <div className="table-wrap">
            <table aria-label="Indexes">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Now</th>
                  <th>Proposed</th>
                  <th>Rule</th>
                  <th>Status</th>
                  <th>Decide</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <IndexRow key={row.id} row={row} subjects={d.subjects} onChanged={r.reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.report.totalRows > PAGE_ROWS && (
          <p className="pager" role="group" aria-label="Pages">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_ROWS))}>
              Previous
            </Button>{' '}
            <span className="small-text">
              Rows {offset + 1} to {Math.min(offset + PAGE_ROWS, d.report.totalRows)} of {d.report.totalRows}
            </span>{' '}
            <Button
              disabled={offset + PAGE_ROWS >= d.report.totalRows}
              onClick={() => setOffset(offset + PAGE_ROWS)}
            >
              Next
            </Button>
          </p>
        )}
      </section>
      <StructuralCard structural={rules.structural} outOfScope={rules.outOfScope} onChanged={r.reload} />
    </>
  );
}

function IndexRow({ row, subjects, onChanged }: { row: Row; subjects: string[]; onChanged: () => void }) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const [changing, setChanging] = useState(false);
  const [role, setRole] = useState<Role>(row.proposed === 'nav' ? 'subject' : 'nav');
  const [subject, setSubject] = useState<string>(row.subject ?? '');
  const decide = (body: Record<string, unknown>, done: string) =>
    void run(
      () => api.post('/index-classification/decide', { pageId: row.id, confirm: true, ...body }),
      done,
    ).then((x) => {
      if (x) {
        setChanging(false);
        onChanged();
      }
    });
  const out = row.scope === 'out';
  return (
    <tr data-row={row.id}>
      <td>
        <strong>{row.name}</strong>
        <div className="small-text">{row.path}</div>
        {row.tags.length > 0 && <div className="small-text">Tags: {row.tags.join(', ')}</div>}
      </td>
      <td>{ROLE_PREFIX[row.currentRole]}</td>
      <td>
        {row.proposed === 'undecided' ? 'undecided' : ROLE_PREFIX[row.proposed]}
        {row.subject && <div className="small-text">{row.subject}</div>}
      </td>
      <td className="small-text">
        <code>{row.rule}</code>: {row.why}
      </td>
      <td>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        {row.approvedRole && (
          <div className="small-text">
            → {ROLE_PREFIX[row.approvedRole]}
            {row.approvedSubject ? ` (${row.approvedSubject})` : ''}
          </div>
        )}
        {row.drifted && <div className="small-text note-bad">the proposal changed since you approved it</div>}
      </td>
      <td>
        {out ? (
          <span className="small-text">{row.area}: reported, never proposed</span>
        ) : changing ? (
          <span role="group" aria-label={`Change ${row.name}`}>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="nav">[NAV] navigation</option>
              <option value="subject">[INDEX] subject</option>
            </select>{' '}
            {role === 'subject' && (
              <select aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">(no category: tags left to you)</option>
                {subjects.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}{' '}
            <Button
              disabled={busy}
              onClick={() =>
                decide(
                  { action: 'change', role, ...(role === 'subject' ? { subject: subject || null } : {}) },
                  `${row.name}: ${ROLE_PREFIX[role]}.`,
                )
              }
            >
              Save
            </Button>{' '}
            <Button onClick={() => setChanging(false)}>Cancel</Button>
          </span>
        ) : (
          <span role="group" aria-label={`Decide ${row.name}`}>
            {row.proposed !== 'undecided' && row.status !== 'approved' && (
              <Button disabled={busy} onClick={() => decide({ action: 'approve' }, `${row.name}: approved.`)}>
                Approve
              </Button>
            )}{' '}
            <Button disabled={busy} onClick={() => setChanging(true)}>
              Change
            </Button>{' '}
            {row.status !== 'left_undecided' && (
              <Button
                disabled={busy}
                onClick={() => decide({ action: 'undecided' }, `${row.name}: left undecided.`)}
              >
                Leave undecided
              </Button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

function BulkApprove({
  ids: all,
  bulkMax,
  onChanged,
}: {
  ids: string[];
  bulkMax: number;
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  if (all.length === 0) return null;
  const ids = all.slice(0, bulkMax);
  const partial = all.length > ids.length;
  const go = () =>
    void confirm({
      title: partial
        ? `Approve the first ${ids.length} of ${all.length} proposed rows?`
        : `Approve ${all.length} proposed row(s) as proposed?`,
      message: (
        <p className="small-text">
          Each takes the role its rule proposes.{' '}
          {partial && `At most ${bulkMax} are approved at once; approve again for the rest. `}
          Rows already decided are left as they are.
        </p>
      ),
      confirmLabel: 'Approve all',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () => api.post('/index-classification/bulk-approve', { ids, confirm: true }),
        'Approved.',
      ).then((x) => {
        if (x) onChanged();
      });
    });
  return (
    <p>
      <Button disabled={busy} onClick={go}>
        Approve all as proposed ({all.length})
      </Button>
    </p>
  );
}

function StructuralCard({
  structural,
  outOfScope,
  onChanged,
}: {
  structural: Structural;
  outOfScope: string[];
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const text = (v: string[] | string | undefined) => (Array.isArray(v) ? v.join('\n') : (v ?? ''));
  const [draft, setDraft] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(LIST_LABELS.map(([k]) => [k, text(structural[k])])),
    outOfScope: outOfScope.join('\n'),
  }));
  const lines = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  const save = () =>
    void run(
      () =>
        api.put('/index-classification/structural', {
          structural: Object.fromEntries(LIST_LABELS.map(([k]) => [k, lines(draft[k] ?? '')])),
          outOfScope: lines(draft.outOfScope ?? ''),
          confirm: true,
        }),
      'Saved as a new pack version: approve it on the Packs page.',
    ).then((x) => {
      if (x) onChanged();
    });
  return (
    <section aria-labelledby="ic-structural" className="card" data-structural>
      <h2 id="ic-structural">Structural names</h2>
      <p className="small-text">
        The exact names the rules read (case and spacing aside), one per line. Saving makes a new version of
        the pack, which you approve on the <Link to="/packs">Packs</Link> page before the report uses it.
      </p>
      {[...LIST_LABELS, ['outOfScope', 'Areas reported but never proposed']].map(([k, label]) => (
        <label key={k} className="block">
          {label}
          <textarea
            aria-label={label}
            rows={4}
            value={draft[k!] ?? ''}
            onChange={(e) => setDraft({ ...draft, [k!]: e.target.value })}
          />
        </label>
      ))}
      <Button disabled={busy} onClick={save}>
        Save as a new pack version
      </Button>
    </section>
  );
}
