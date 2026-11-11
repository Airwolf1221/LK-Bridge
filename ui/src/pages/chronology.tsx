import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo, fmtInt, fmtTime, principalText } from '../format';
import { useApi, useNow, type Resource } from '../hooks';
import { useProject, useScopedApi } from '../project';
import { Link } from '../router';
import type {
  ChronologyCheckResponse,
  ChronologyEvidence,
  ChronologyFindView,
  ChronologyFinding,
  ChronologyFindingKind,
  ChronologyProposeFixResponse,
  ChronologyLookupView,
  ChronologyRecordView,
  ChronologyRecordsResponse,
  ChronologyStyle,
  ChronologyView,
} from '../types';

/**
 * Chronology (v2 D1, ADR 0038): the chronology sync of the selected project. Three cards:
 *
 * - Settings: what the lookup by name finds in the repository tree, "Read the chronology" (the calendar, the Main table,
 *   each age table and timeline: about 3 requests per age), and the owner's confirmation of what it found, including
 *   how the tables write dates and KCY values (learned from the rows; editable before confirming). Until confirmed,
 *   the chronology tools refuse. Every change is audited.
 * - Chronology check: its last run and findings, and "Run the check now". It reads only and never repairs.
 * - Changes: the record each timeline tool's job writes, newest first, with "Mark resolved" for a change that stopped
 *   part-way and was fixed by hand (audited).
 */
export function ChronologyPage() {
  const { selected } = useProject();
  const settings = useApi<ChronologyView>(
    selected ? `/projects/${encodeURIComponent(selected)}/chronology` : null,
  );
  const check = useScopedApi<ChronologyCheckResponse>('/chronology/check');
  const records = useScopedApi<ChronologyRecordsResponse>('/chronology/records?limit=200');
  const reloadAll = () => {
    settings.reload();
    check.reload();
    records.reload();
  };
  return (
    <>
      <PageHeader title="Chronology" project={selected}>
        <button type="button" className="small" onClick={reloadAll}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The chronology sync: each age’s table and its timeline, kept in step by the timeline tools. The table
        is the authority; the timeline is a derived view of it.
      </p>
      {selected ? <SettingsCard project={selected} v={settings} /> : <Empty>No project is selected.</Empty>}
      <CheckCard project={selected} r={check} />
      <RecordsCard project={selected} r={records} />
    </>
  );
}

// ================================================================================================ settings

const findText = (f: ChronologyFindView['resource']): string =>
  f.status === 'found'
    ? `found: ${f.path} (${f.id})`
    : f.status === 'missing'
      ? `no resource named “${f.name}” in the repository tree`
      : `${f.candidates.length} resources named “${f.name}”: ${f.candidates.map((c) => c.path).join('; ')}`;

/** A separator or sign, quoted so that spaces show (" - "); an empty one reads as none. */
function Sep({ value }: { value: string }) {
  return (
    <>
      <code>&quot;{value}&quot;</code>
      {value === '' && <span className="muted small-text"> (none)</span>}
    </>
  );
}

type StyleKey =
  | 'date.rangeSeparator'
  | 'date.yearGrouping'
  | 'kcy.grouping'
  | 'kcy.minus'
  | 'kcy.rangeSeparator'
  | 'kcy.sameYearRange';
const STYLE_ROWS: { key: StyleKey; label: string }[] = [
  { key: 'date.rangeSeparator', label: 'Date range separator' },
  { key: 'date.yearGrouping', label: 'Year thousands separator' },
  { key: 'kcy.grouping', label: 'KCY thousands separator' },
  { key: 'kcy.minus', label: 'KCY minus sign' },
  { key: 'kcy.rangeSeparator', label: 'KCY range separator' },
  { key: 'kcy.sameYearRange', label: 'KCY of a range inside one year' },
];
const SAME_YEAR: Record<'single' | 'range', string> = {
  single: 'one value',
  range: 'a range with the same value at both ends',
};

const styleValue = (s: ChronologyStyle, k: StyleKey): string => {
  const [group, field] = k.split('.') as ['date' | 'kcy', string];
  return (s[group] as Record<string, string>)[field] ?? '';
};
const withStyle = (s: ChronologyStyle, k: StyleKey, value: string): ChronologyStyle => {
  const [group, field] = k.split('.') as ['date' | 'kcy', string];
  return { ...s, [group]: { ...s[group], [field]: value } };
};
const evidenceOf = (l: ChronologyLookupView, k: StyleKey): ChronologyEvidence | null => {
  if (!l.style) return null;
  const [group, field] = k.split('.') as ['date' | 'kcy', string];
  return (l.style[group] as Record<string, ChronologyEvidence>)[field] ?? null;
};

function SettingsCard({ project, v }: { project: string; v: Resource<ChronologyView> }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [lookup, setLookup] = useState<ChronologyLookupView | null>(null);
  const [style, setStyle] = useState<ChronologyStyle | null>(null);
  const path = `/projects/${encodeURIComponent(project)}/chronology`;

  const read = () =>
    void run(() => api.post<ChronologyLookupView>(`${path}/lookup`), 'The chronology has been read.').then(
      (r) => {
        if (!r) return;
        setLookup(r);
        setStyle(r.proposed?.style ?? r.style?.proposed ?? null);
      },
    );

  const put = (body: Record<string, unknown>, ok: string) =>
    void run(() => api.put<ChronologyView>(path, { ...body, confirm: true }), ok).then((r) => {
      if (!r) return;
      v.set(() => r);
      setLookup(null);
      setStyle(null);
    });

  const confirmSettings = (l: ChronologyLookupView) => {
    const proposed = l.proposed;
    if (!proposed) return;
    const settings = { ...proposed, ...(style ? { style } : {}) };
    void confirm({
      title: `Confirm the chronology settings for ${project}?`,
      message: (
        <p>
          {l.found.length} {l.found.length === 1 ? 'age' : 'ages'} ({l.found.map((a) => a.name).join(', ')})
          {l.calendar ? `, the calendar ${l.calendar.name}` : ''}. The chronology tools use these settings
          from the next call.
        </p>
      ),
      confirmLabel: 'Confirm',
    }).then((yes) => yes && put({ settings }, 'Chronology settings confirmed.'));
  };

  const reset = () =>
    void confirm({
      title: `Clear the chronology settings for ${project}?`,
      message: (
        <p>
          The confirmed resource, calendar, documents and writing style are forgotten. The chronology tools
          refuse until the chronology is read and confirmed again.
        </p>
      ),
      confirmLabel: 'Clear the settings',
      danger: true,
    }).then((yes) => yes && put({ reset: true }, 'Chronology settings cleared.'));

  if (!v.data) return v.error ? <ErrorNote error={v.error} onRetry={v.reload} /> : <Loading />;
  const d = v.data;
  const c = d.config;
  const docName = (id: string | null): ReactNode => {
    if (!id) return '–';
    const all = [d.find.main, ...d.find.ages.flatMap((a) => [a.table, a.timeline])];
    const doc = all.find((x) => x?.id === id);
    return (
      <>
        {doc && <>{doc.name} </>}
        <span className="mono small-text">{id}</span>
      </>
    );
  };
  return (
    <section className="card" aria-labelledby="chronology-settings-h">
      <h2 id="chronology-settings-h">
        Settings {d.ready.ok ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">not confirmed</Badge>}
      </h2>
      <p className="muted small-text">
        Until these settings are confirmed, the chronology tools refuse. The table is the authority; the
        timeline is a derived view.
      </p>
      {c.problem && <p className="note note-warn small-text">{c.problem}</p>}
      {!d.ready.ok && (
        <p className="note note-warn small-text" data-testid="chronology-ready">
          {d.ready.code && <span className="mono">{d.ready.code}</span>} {d.ready.message}
        </p>
      )}

      <h3>Confirmed settings</h3>
      {c.confirmed ? (
        <>
          <dl className="kv">
            <dt>Resource</dt>
            <dd>
              <span className="mono small-text">{c.resourceId ?? '–'}</span>
            </dd>
            <dt>Calendar</dt>
            <dd>
              <span className="mono small-text">{c.calendarId ?? '–'}</span>
              {c.calendarId && !d.calendarCached && <span className="muted small-text"> (not read yet)</span>}
            </dd>
            <dt>Main document</dt>
            <dd>{docName(c.mainDocumentId)}</dd>
            <dt>Confirmed</dt>
            <dd>{c.confirmedAt ? fmtTime(c.confirmedAt) : '–'}</dd>
          </dl>
          <div className="table-wrap">
            <table aria-label="Confirmed ages">
              <thead>
                <tr>
                  <th>Age</th>
                  <th>Table document</th>
                  <th>Timeline document</th>
                  <th>Lane</th>
                  <th>Main row</th>
                </tr>
              </thead>
              <tbody>
                {c.ages.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td>{docName(a.tableDocumentId)}</td>
                    <td>{docName(a.timelineDocumentId)}</td>
                    <td>
                      {a.laneName} <span className="mono small-text">{a.laneId}</span>
                    </td>
                    <td>
                      <span className="mono small-text">{a.mainRowId}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty>Nothing is confirmed yet.</Empty>
      )}

      <h3>Found in the repository tree</h3>
      <p className="muted small-text">By name, without any LegendKeeper request.</p>
      <dl className="kv">
        <dt>Resource “{c.names.resource}”</dt>
        <dd>{findText(d.find.resource)}</dd>
        <dt>Main document “{c.names.mainDocument}”</dt>
        <dd>
          {d.find.main ? (
            <>
              {d.find.main.name} <span className="mono small-text">{d.find.main.id}</span>
            </>
          ) : (
            'not found'
          )}
        </dd>
      </dl>
      {d.find.ages.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Ages found in the tree">
            <thead>
              <tr>
                <th>Age</th>
                <th>Table document</th>
                <th>Timeline document</th>
              </tr>
            </thead>
            <tbody>
              {d.find.ages.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>
                    {a.table ? (
                      <>
                        {a.table.name} <span className="mono small-text">{a.table.id}</span>
                      </>
                    ) : (
                      'not found'
                    )}
                  </td>
                  <td>
                    {a.timeline ? (
                      <>
                        {a.timeline.name} <span className="mono small-text">{a.timeline.id}</span>
                      </>
                    ) : (
                      'not found'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Problems list={d.find.problems} />

      <div className="row mt">
        <Button variant="primary" busy={busy} onClick={read}>
          Read the chronology
        </Button>
        <Button variant="danger" busy={busy} onClick={reset}>
          Clear the chronology settings
        </Button>
      </div>
      <p className="muted small-text">
        Reading the chronology reads the calendar, the Main table, and each age’s table and timeline: about
        three requests per age.
      </p>

      {lookup && (
        <LookupResult
          lookup={lookup}
          style={style}
          onStyle={setStyle}
          busy={busy}
          onConfirm={() => confirmSettings(lookup)}
        />
      )}
    </section>
  );
}

function Problems({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="note note-warn small-text" aria-label="Problems">
      {list.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

function LookupResult({
  lookup: l,
  style,
  onStyle,
  busy,
  onConfirm,
}: {
  lookup: ChronologyLookupView;
  style: ChronologyStyle | null;
  onStyle: (s: ChronologyStyle) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <section aria-label="What reading the chronology found" className="mt">
      <h3>What reading the chronology found</h3>
      <dl className="kv">
        <dt>Requests made</dt>
        <dd>{fmtInt(l.requests)}</dd>
        <dt>Resource</dt>
        <dd>{findText(l.resource)}</dd>
        <dt>Calendar</dt>
        <dd>
          {l.calendar ? (
            <>
              {l.calendar.name} <span className="mono small-text">{l.calendar.id}</span>
              {l.calendar.eras.length > 0 && (
                <span className="muted small-text">
                  {' '}
                  · eras: {l.calendar.eras.map((e) => (e.abbr ? `${e.name} (${e.abbr})` : e.name)).join(', ')}
                </span>
              )}
            </>
          ) : (
            'not found'
          )}
        </dd>
      </dl>
      {l.found.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Ages read">
            <thead>
              <tr>
                <th>Age</th>
                <th>Era</th>
                <th className="num">Rows</th>
                <th>Main count</th>
                <th>Lane</th>
                <th>Problems</th>
              </tr>
            </thead>
            <tbody>
              {l.found.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>{a.era}</td>
                  <td className="num">{fmtInt(a.rows)}</td>
                  <td>{a.count}</td>
                  <td>{a.laneName}</td>
                  <td>{a.problems.length === 0 ? '–' : a.problems.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Problems list={l.problems} />

      {l.style && (
        <>
          <h3>How the tables write dates and KCY values</h3>
          <p className="muted small-text">
            Learned from the rows. Where the rows show nothing, the default is proposed. Check each value, and
            change it before confirming if the tables should be written differently.
          </p>
          <div className="table-wrap">
            <table aria-label="Writing style">
              <thead>
                <tr>
                  <th>Aspect</th>
                  <th>The rows show</th>
                  <th>Rows</th>
                  <th>Examples</th>
                  {l.proposed && style && <th>To confirm</th>}
                </tr>
              </thead>
              <tbody>
                {STYLE_ROWS.map(({ key, label }) => {
                  const e = evidenceOf(l, key);
                  const id = `chron-style-${key.replace('.', '-')}`;
                  return (
                    <tr key={key} data-style={key}>
                      <td>{label}</td>
                      <td>
                        {!e || e.value === null ? (
                          <span className="muted">not shown by the rows</span>
                        ) : key === 'kcy.sameYearRange' ? (
                          (SAME_YEAR[e.value as 'single' | 'range'] ?? e.value)
                        ) : (
                          <Sep value={e.value} />
                        )}
                      </td>
                      <td>
                        {e && Object.keys(e.seen).length > 0
                          ? Object.entries(e.seen).map(([val, n]) => (
                              <span key={val} className="small-text">
                                {key === 'kcy.sameYearRange' ? val : <Sep value={val} />}: {fmtInt(n)}{' '}
                              </span>
                            ))
                          : '–'}
                      </td>
                      <td>
                        {e && e.examples.length > 0
                          ? e.examples.slice(0, 3).map((x, i) => (
                              <span key={i}>
                                {i > 0 && ' · '}
                                <code className="small-text">{x}</code>
                              </span>
                            ))
                          : '–'}
                      </td>
                      {l.proposed && style && (
                        <td>
                          <label className="offscreen" htmlFor={id}>
                            {label}
                          </label>
                          {key === 'kcy.sameYearRange' ? (
                            <select
                              id={id}
                              value={style.kcy.sameYearRange}
                              onChange={(ev) => onStyle(withStyle(style, key, ev.target.value))}
                            >
                              <option value="single">{SAME_YEAR.single}</option>
                              <option value="range">{SAME_YEAR.range}</option>
                            </select>
                          ) : (
                            <input
                              id={id}
                              className="mono"
                              size={6}
                              value={styleValue(style, key)}
                              onChange={(ev) => onStyle(withStyle(style, key, ev.target.value))}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {l.style.conflicts.length > 0 && (
            <div className="note note-warn small-text">
              The rows write these more than one way; choose one before confirming:{' '}
              {l.style.conflicts.join(', ')}.
            </div>
          )}
        </>
      )}

      {l.proposed ? (
        <div className="row mt">
          <Button variant="primary" busy={busy} onClick={onConfirm}>
            Confirm these settings
          </Button>
        </div>
      ) : (
        <p className="note note-warn small-text">
          Nothing can be confirmed yet: something is missing (see the problems above).
        </p>
      )}
    </section>
  );
}

// ================================================================================================== check

const KIND: Record<ChronologyFindingKind, string> = {
  row_without_event: 'Row without an event',
  date_mismatch: 'Row and event disagree about the date',
  event_without_row: 'Event without a row',
  row_out_of_order: 'Row out of order',
  wrong_kcy: 'Wrong KCY',
  count_mismatch: 'Count mismatch',
  wrong_uri: 'Event link not to its table',
  unreadable_date: 'Date the engine cannot read',
  date_text_differs: 'Written differently',
  not_found: 'Not found',
};
const CHECK_STATE: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  running: { text: 'running', tone: 'info' },
  succeeded: { text: 'finished', tone: 'ok' },
  failed: { text: 'failed', tone: 'bad' },
};

function CheckCard({ project, r }: { project: string | null; r: Resource<ChronologyCheckResponse> }) {
  const { run, busy } = useAction();
  const now = useNow();
  // After "Run the check now", poll a few times even before the run shows as running.
  const [kick, setKick] = useState(0);
  const running = r.data?.running === true;
  const { reload } = r;
  useEffect(() => {
    if (!running && kick <= 0) return;
    const t = setInterval(() => {
      reload();
      setKick((n) => Math.max(0, n - 1));
    }, 2000);
    return () => clearInterval(t);
  }, [running, kick, reload]);

  // "Propose a fix": one `sync_timeline_event` proposal for the finding's row; the owner approves it as normal.
  const [proposing, setProposing] = useState<string | null>(null);
  const [proposed, setProposed] = useState<Record<string, string>>({});
  const propose = (f: ChronologyFinding, key: string) => {
    const rowId = typeof f.detail?.rowId === 'string' ? f.detail.rowId : null;
    if (!rowId) return;
    setProposing(key);
    void run(() =>
      api.post<ChronologyProposeFixResponse>('/chronology/propose-fix', {
        confirm: true,
        project,
        age: f.age,
        rowId,
      }),
    )
      .then((res) => {
        if (!res) return;
        setProposed((p) => ({
          ...p,
          [key]:
            res.status === 'proposal_captured'
              ? `Proposal ${res.proposalId} is waiting on the Proposals page.`
              : res.message,
        }));
      })
      .finally(() => setProposing(null));
  };

  const start = () =>
    void run(
      () => api.post('/chronology/check', { confirm: true, project }),
      'The chronology check has started.',
    ).then((ok) => {
      if (!ok) return;
      setKick(5);
      reload();
    });

  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const last = r.data.last;
  const counts = new Map<ChronologyFindingKind, number>();
  for (const f of last?.findings ?? []) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const state = last ? (CHECK_STATE[last.state] ?? { text: last.state, tone: 'info' as const }) : undefined;
  return (
    <section className="card" aria-labelledby="chronology-check-h">
      <h2 id="chronology-check-h">Chronology check</h2>
      <p className="muted small-text">
        Compares each age’s table with its timeline and the Main counts. The check itself only reads and never
        repairs anything; “Propose a fix” on a row without an event, or a row and event that disagree about
        the date, makes ONE proposal (the table is the authority) for you to approve on the Proposals page. It
        also runs weekly (Maintenance Jobs page).
      </p>
      {last && state ? (
        <dl className="kv">
          <dt>Last run</dt>
          <dd>
            <Badge tone={state.tone}>{state.text}</Badge>{' '}
            <span className="muted small-text">({last.trigger})</span>
          </dd>
          <dt>Started</dt>
          <dd>
            {fmtTime(last.startedAt)} ({fmtAgo(last.startedAt, now)})
          </dd>
          <dt>Finished</dt>
          <dd>{last.finishedAt ? fmtTime(last.finishedAt) : '–'}</dd>
          <dt>Requests</dt>
          <dd>{fmtInt(last.requests)}</dd>
          {last.summary && (
            <>
              <dt>Summary</dt>
              <dd>{last.summary}</dd>
            </>
          )}
          {last.error && (
            <>
              <dt>Error</dt>
              <dd className="note note-bad small-text">{last.error}</dd>
            </>
          )}
        </dl>
      ) : (
        <Empty>The chronology check has not run yet.</Empty>
      )}
      <div className="row mt">
        <Button variant="primary" busy={busy} disabled={running || !project} onClick={start}>
          Run the check now
        </Button>
        {running && <span className="muted small-text">A check is running…</span>}
      </div>
      {last && last.findings.length > 0 && (
        <>
          <p className="small-text" data-testid="finding-counts">
            {[...counts.entries()].map(([k, n]) => `${KIND[k] ?? k}: ${n}`).join(' · ')}
          </p>
          <div className="table-wrap">
            <table aria-label="Findings">
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>Age</th>
                  <th>Message</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {last.findings.map((f, i) => {
                  const key = `${f.kind}:${typeof f.detail?.rowId === 'string' ? f.detail.rowId : i}`;
                  const fixable =
                    (f.kind === 'row_without_event' || f.kind === 'date_mismatch') &&
                    typeof f.detail?.rowId === 'string';
                  return (
                    <tr key={i} data-kind={f.kind}>
                      <td>{KIND[f.kind] ?? f.kind}</td>
                      <td>{f.age}</td>
                      <td>{f.message}</td>
                      <td>
                        {fixable && !proposed[key] && (
                          <Button
                            busy={busy && proposing === key}
                            disabled={busy || !project}
                            onClick={() => propose(f, key)}
                          >
                            Propose a fix
                          </Button>
                        )}
                        {proposed[key] && (
                          <span className="small-text">
                            {proposed[key]} <Link to="/proposals">Open Proposals</Link>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {last && last.state === 'succeeded' && last.findings.length === 0 && (
        <p className="note note-ok small-text">No findings: the tables and timelines agree.</p>
      )}
    </section>
  );
}

// ================================================================================================ changes

const TOOL: Record<ChronologyRecordView['tool'], string> = {
  create_timeline_event: 'Created',
  update_timeline_event: 'Updated',
  delete_timeline_event: 'Deleted',
  sync_timeline_event: 'Repaired the timeline',
};

function RecordsCard({ project, r }: { project: string | null; r: Resource<ChronologyRecordsResponse> }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  const resolve = (x: ChronologyRecordView) =>
    void confirm({
      title: 'Mark this change resolved?',
      message: (
        <p>
          “{x.summary}” stopped part-way. Mark it resolved only if you have finished or undone it by hand; it
          is then no longer listed as incomplete.
        </p>
      ),
      confirmLabel: 'Mark resolved',
    }).then((yes) => {
      if (!yes) return;
      void run(
        () => api.post(`/chronology/records/${x.id}/resolve`, { confirm: true, project }),
        'Marked resolved.',
      ).then((ok) => ok && r.reload());
    });
  const records = [...d.records].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="card table-wrap" aria-labelledby="chronology-records-h">
      <h2 id="chronology-records-h">
        Changes ({d.total}) {d.incomplete > 0 && <Badge tone="warn">{d.incomplete} incomplete</Badge>}
      </h2>
      <p className="muted small-text">
        Every chronology change the timeline tools made, newest first. A change that stopped part-way is
        finished by the same request again; mark it resolved only after fixing it by hand.
      </p>
      {records.length === 0 ? (
        <Empty>No chronology change yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Change</th>
              <th>Ages</th>
              <th>Writes</th>
              <th>By</th>
              <th>Date</th>
              <th>State</th>
              <th>Journal</th>
            </tr>
          </thead>
          <tbody>
            {records.map((x) => (
              <tr key={x.id} data-record={x.id}>
                <td>
                  {TOOL[x.tool] ?? x.tool}: {x.summary}
                </td>
                <td>{x.ages.join(', ')}</td>
                <td className="small-text">{x.writes.join(', ')}</td>
                <td>
                  {principalText(x.principalId, d.principals)}
                  {x.approver && <span className="muted small-text"> · approved by {x.approver}</span>}
                </td>
                <td>
                  {fmtTime(x.createdAt)}
                  {x.completedAt && (
                    <span className="muted small-text"> · done {fmtTime(x.completedAt)}</span>
                  )}
                </td>
                <td>
                  {x.state === 'complete' ? (
                    <Badge tone="ok">complete</Badge>
                  ) : x.state === 'resolved' ? (
                    <Badge>resolved</Badge>
                  ) : (
                    <>
                      <Badge tone="warn">incomplete</Badge>{' '}
                      <Button className="small" busy={busy} onClick={() => resolve(x)}>
                        Mark resolved
                      </Button>
                    </>
                  )}
                </td>
                <td>
                  {x.jobs.map((j) => (
                    <span key={j}>
                      <Link to={`/journal?jobId=${encodeURIComponent(j)}`}>{j}</Link>{' '}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
