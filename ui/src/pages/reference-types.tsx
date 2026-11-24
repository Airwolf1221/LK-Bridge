import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { qs } from '../api';
import { useProjectApi, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import { Link } from '../router';

/**
 * Reference Types (v3 F6a, ADR 0076; design T2), in the Setup group next to Repository Mappings: every Reference Type
 * value in use across the AI REPOSITORY (the Legacy Canon Archive, Design References, Working, Archived and Narratives
 * pages left out), one row per value and primary category, with the bridge's suggestion (rules only) and its status.
 *
 * Per row the owner can **Accept** the suggestion, **Edit** (pick another canonical value of the category, or type a new
 * one with its role word, added to the vocabulary), **Reject** (leave it as it is; never suggested again) or **Keep as
 * specialist** (an approved additional type for exactly the pages listed, or any page in the category). **Accept all
 * confident suggestions** takes every open row the filter shows that has one. A decision not yet applied (no fix written
 * with it) nor published can be undone. Every decision asks for the step-up and is recorded in the audit log.
 *
 * **Publish vocabulary** previews the exact section text, then writes "Reference Type Vocabulary" under "Sidebar
 * Metadata" in Source Formatting (one job, journalled). The governance page changes, so the Packs page asks for the
 * pack's approval again; once approved, the section is the authority. A section edited by hand wins: the decisions it
 * contradicts are marked.
 */

type Status = 'canonical' | 'mapped' | 'specialist' | 'rejected' | 'open';
const STATUSES: Status[] = ['open', 'mapped', 'specialist', 'rejected', 'canonical'];
const STATUS_TONE: Record<Status, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  canonical: 'ok',
  mapped: 'ok',
  specialist: 'neutral',
  rejected: 'neutral',
  open: 'warn',
};

interface Decision {
  id: string;
  value: string;
  category: string;
  action: 'map' | 'reject' | 'specialist';
  target: string | null;
  targetNew: boolean;
  role: string | null;
  pages: { id: string; name: string }[] | null;
  via: string;
  by: string;
  at: number;
  publishedAt: number | null;
  appliedCount: number;
}
interface Candidate {
  name: string;
  category: string;
  role: string;
}
interface Row {
  value: string;
  category: string;
  count: number;
  status: Status;
  pages: {
    id: string;
    name: string;
    path: string;
    lifecycle: string | null;
    coverage: string;
    specialist?: boolean;
  }[];
  suggestion: {
    value: string | null;
    kind: 'canonical' | 'suggested' | 'none';
    reason: string;
    candidates: Candidate[];
  };
  decision: Decision | null;
  conflict: string | null;
}
interface Category {
  category: string;
  types: { name: string; role: string; aliases?: string[] }[];
}
interface Response {
  report: {
    pack: { id: string; version: number; approvedVersion: number | null };
    vocabulary: { status: 'draft' | 'published'; approved: boolean };
    rows: Row[];
    totalRows: number;
    coverage: {
      pages: number;
      ok: number;
      stale: number;
      missing: number;
      withoutReferenceType: number;
      oldestRead: string | null;
      unread: { id: string; name: string; path: string }[];
      tree: { status: string; confirmedAt: string | null };
    };
    excluded: Record<string, number>;
  };
  vocabulary: {
    status: 'draft' | 'published';
    approved: boolean;
    rule: string;
    categories: Category[];
    specialist: { type: string; category: string; pages: { id: string; name: string }[] | null }[];
    pending: string[];
  };
  conflicts: { decision: Decision; reason: string }[];
  publications: { id: string; jobId: string | null; state: string; at: number; replaced: boolean }[];
}
interface PublishPreview {
  lines: string[];
  replaced: boolean;
  confirmation: string;
  decisions: number;
  page: { id: string; name: string };
}

const initialParam = (name: string): string => {
  try {
    return new URLSearchParams(window.location.search).get(name) ?? '';
  } catch {
    return '';
  }
};

export function ReferenceTypesPage() {
  const [category, setCategory] = useState(initialParam('category'));
  const [status, setStatus] = useState<Status | ''>(initialParam('value') ? '' : 'open');
  const [minCount, setMinCount] = useState('');
  const [valueText, setValueText] = useState(initialParam('value'));
  const path = `/reference-types${qs({
    category: category || undefined,
    status: status || undefined,
    minCount: minCount || undefined,
    limit: 500,
  })}`;
  const r = useScopedApi<Response>(path);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  const rows = valueText
    ? d.report.rows.filter((x) => x.value.toLowerCase().includes(valueText.toLowerCase()))
    : d.report.rows;
  const categories = d.vocabulary.categories.map((c) => c.category);
  return (
    <>
      <PageHeader title="Reference Types" />
      <p>
        A Reference Type names the page’s role, from a closed list per primary category: time goes in Temporal
        Scope, geography in placement, detail in Scope. Decide each value in use below; nothing is renamed or
        retyped until a fix you approve (or switch on in Automation) applies your mapping.
      </p>
      <VocabularyCard data={d} onChanged={r.reload} />
      <Coverage data={d} />
      {d.conflicts.length > 0 && (
        <section aria-labelledby="rt-conflicts" className="card" data-conflicts>
          <h2 id="rt-conflicts">The published section and your decisions disagree</h2>
          <p className="note note-bad">
            The section in Source Formatting wins: these decisions add nothing until you decide again.
          </p>
          <ul>
            {d.conflicts.map((c) => (
              <li key={c.decision.id}>
                <strong>{c.decision.value}</strong> ({c.decision.category || 'no category'}): {c.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="rt-values">
        <h2 id="rt-values">Values in use</h2>
        <div className="filters" role="group" aria-label="Filters">
          <label>
            Category{' '}
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">Any</option>
              <option value="none">No primary category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>{' '}
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
                  {s}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            At least{' '}
            <input
              aria-label="Minimum count"
              type="number"
              min={1}
              value={minCount}
              onChange={(e) => setMinCount(e.target.value)}
              style={{ width: '5em' }}
            />{' '}
            pages
          </label>{' '}
          <label>
            Value contains{' '}
            <input
              aria-label="Value contains"
              value={valueText}
              onChange={(e) => setValueText(e.target.value)}
            />
          </label>
        </div>
        <BulkAccept rows={rows} filter={{ category, status, minCount }} onChanged={r.reload} />
        {rows.length === 0 ? (
          <Empty>No value matches.</Empty>
        ) : (
          <div className="table-wrap">
            <table aria-label="Reference Type values">
              <thead>
                <tr>
                  <th>Value</th>
                  <th>Category</th>
                  <th>Pages</th>
                  <th>Status</th>
                  <th>Suggestion</th>
                  <th>Decide</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ValueRow
                    key={`${row.value}\u0000${row.category}`}
                    row={row}
                    vocabulary={d.vocabulary.categories}
                    onChanged={r.reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small-text">
          {d.report.totalRows} value(s) match. The audits’ findings link here: see{' '}
          <Link to="/audits">Audits</Link> (category taxonomy) and switch the fix on in{' '}
          <Link to="/automation">Automation</Link> once your mappings are approved.
        </p>
      </section>
    </>
  );
}

function VocabularyCard({ data, onChanged }: { data: Response; onChanged: () => void }) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const v = data.vocabulary;
  const publish = () =>
    void run(() => api.post<PublishPreview>('/reference-types/publish', { dryRun: true })).then((dry) => {
      if (!dry) return;
      void confirm({
        title: dry.replaced ? 'Publish the vocabulary again?' : 'Publish the vocabulary?',
        message: (
          <>
            <p>{dry.confirmation}</p>
            <p className="small-text">The exact text of the section ({dry.page.name}):</p>
            <pre className="small-text" data-preview>
              {dry.lines.join('\n\n')}
            </pre>
          </>
        ),
        confirmLabel: 'Publish vocabulary',
      }).then((ok) => {
        if (!ok) return;
        void run(
          () => withReauth(() => api.post('/reference-types/publish', { confirm: true })),
          'Published: approve the pack again on the Packs page.',
        ).then((x) => {
          if (x) onChanged();
        });
      });
    });
  const types = v.categories.reduce((n, c) => n + c.types.length, 0);
  return (
    <section aria-labelledby="rt-vocabulary" className="card" data-vocabulary>
      <h2 id="rt-vocabulary">
        Vocabulary{' '}
        <Badge tone={v.status === 'published' ? 'ok' : 'warn'}>
          {v.status === 'published' ? 'published (the governance section is the authority)' : 'draft'}
        </Badge>{' '}
        {!v.approved && <Badge tone="warn">the pack version is not approved</Badge>}
      </h2>
      <p className="small-text">
        {v.categories.length} categories, {types} canonical types, {v.specialist.length} specialist type(s);{' '}
        {v.pending.length} decision(s) not published yet. Pack {data.report.pack.id} version{' '}
        {data.report.pack.version}
        {data.report.pack.approvedVersion !== null ? ` (approved ${data.report.pack.approvedVersion})` : ''}.
      </p>
      <details>
        <summary>The vocabulary in force</summary>
        <p>{v.rule}</p>
        <ul className="small-text">
          {v.categories.map((c) => (
            <li key={c.category}>
              <strong>{c.category}</strong>: {c.types.map((t) => `${t.name} (${t.role})`).join('; ')}
            </li>
          ))}
          {v.specialist.map((s) => (
            <li key={`${s.type}:${s.category}`}>
              Specialist: <strong>{s.type}</strong> ({s.category}),{' '}
              {s.pages === null ? 'any page in this category' : s.pages.map((p) => p.name).join(', ')}
            </li>
          ))}
        </ul>
      </details>
      <Button busy={busy} onClick={publish}>
        Publish vocabulary…
      </Button>
      {data.publications.length > 0 && (
        <p className="small-text">
          Last published: {new Date(data.publications[0]!.at).toLocaleString('en-GB')} (
          {data.publications[0]!.state}
          {data.publications[0]!.jobId ? (
            <>
              , job <Link to={`/jobs/${data.publications[0]!.jobId}`}>{data.publications[0]!.jobId}</Link>
            </>
          ) : null}
          ).
        </p>
      )}
    </section>
  );
}

function Coverage({ data }: { data: Response }) {
  const c = data.report.coverage;
  const excluded = Object.entries(data.report.excluded);
  return (
    <p className="small-text" data-coverage>
      {c.pages} pages in scope: {c.ok} read recently, {c.stale} stale, {c.missing} never read (their Reference
      Type is unknown
      {c.unread.length > 0
        ? `: ${c.unread
            .slice(0, 5)
            .map((u) => u.name)
            .join(', ')}…`
        : ''}
      ), {c.withoutReferenceType} without a Reference Type. Oldest read:{' '}
      {c.oldestRead ? new Date(c.oldestRead).toLocaleString('en-GB') : 'none'}. Tree {c.tree.status}
      {c.tree.confirmedAt ? `, confirmed ${new Date(c.tree.confirmedAt).toLocaleString('en-GB')}` : ''}.
      {excluded.length > 0 && <> Left out: {excluded.map(([k, n]) => `${k} ${n}`).join(', ')}.</>}
    </p>
  );
}

function BulkAccept({
  rows,
  filter,
  onChanged,
}: {
  rows: Row[];
  filter: { category: string; status: string; minCount: string };
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const confident = rows.filter((r) => r.status === 'open' && r.suggestion.kind === 'suggested');
  if (confident.length === 0) return null;
  const go = () =>
    void confirm({
      title: `Accept ${confident.length} confident suggestion(s)?`,
      message: (
        <ul className="small-text">
          {confident.slice(0, 30).map((r) => (
            <li key={`${r.value}:${r.category}`}>
              {r.value} → {r.suggestion.value} ({r.count} page(s))
            </li>
          ))}
          {confident.length > 30 && <li>… and {confident.length - 30} more</li>}
        </ul>
      ),
      confirmLabel: 'Accept all',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post('/reference-types/bulk-accept', {
              ...(filter.category ? { category: filter.category } : {}),
              ...(filter.minCount ? { minCount: Number(filter.minCount) } : {}),
              confirm: true,
            }),
          ),
        'Accepted.',
      ).then((x) => {
        if (x) onChanged();
      });
    });
  return (
    <p>
      <Button busy={busy} onClick={go}>
        Accept all {confident.length} confident suggestion(s) in this filter
      </Button>
    </p>
  );
}

function ValueRow({
  row,
  vocabulary,
  onChanged,
}: {
  row: Row;
  vocabulary: Category[];
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const mine = vocabulary.find((c) => c.category.toLowerCase() === row.category.toLowerCase())?.types ?? [];
  const decide = (body: Record<string, unknown>, title: string, ok: string) =>
    void confirm({
      title,
      message: <p>Recorded in the audit log; it can be undone until it is applied or published.</p>,
    }).then((yes) => {
      if (!yes) return;
      void run(
        () =>
          withReauth(() =>
            api.post('/reference-types/decide', {
              value: row.value,
              category: row.category,
              ...body,
              confirm: true,
            }),
          ),
        ok,
      ).then((x) => {
        if (x) {
          setEditing(false);
          onChanged();
        }
      });
    });
  const undo = () =>
    void run(
      () => withReauth(() => api.post('/reference-types/undo', { id: row.decision!.id, confirm: true })),
      'Undone.',
    ).then((x) => {
      if (x) onChanged();
    });
  const target = pick === '__new__' ? newName.trim() : pick;
  const s = row.suggestion;
  return (
    <tr data-value={row.value} data-status={row.status} className={row.conflict ? 'row-conflict' : undefined}>
      <td>
        <strong>{row.value}</strong>
        <details>
          <summary className="small-text">pages</summary>
          <ul className="small-text">
            {row.pages.map((p) => (
              <li key={p.id}>
                {p.name} <span className="mono">{p.id}</span> ({p.lifecycle ?? 'no lifecycle'}
                {p.coverage !== 'ok' ? `, ${p.coverage}` : ''}
                {p.specialist ? ', specialist' : ''}) <span className="small-text">{p.path}</span>
              </li>
            ))}
          </ul>
        </details>
      </td>
      <td>{row.category || <em>none</em>}</td>
      <td>{row.count}</td>
      <td>
        <Badge tone={row.conflict ? 'bad' : STATUS_TONE[row.status]}>
          {row.conflict ? 'conflict' : row.status}
        </Badge>
        {row.decision && (
          <div className="small-text">
            {row.decision.action === 'map' ? `→ ${row.decision.target}` : row.decision.action}
            {row.decision.targetNew ? ` (new, role “${row.decision.role}”)` : ''}
            {row.decision.appliedCount > 0 ? `; applied ${row.decision.appliedCount}` : ''}
            {row.decision.publishedAt ? '; published' : ''}
          </div>
        )}
        {row.conflict && <div className="small-text note-bad">{row.conflict}</div>}
      </td>
      <td>
        {s.value ? <strong>{s.value}</strong> : <em>no confident suggestion</em>}
        <div className="small-text">{s.reason}</div>
        {s.candidates.length > 0 && (
          <div className="small-text">
            Candidates: {s.candidates.map((c) => `${c.name} (${c.category})`).join(', ')}
          </div>
        )}
      </td>
      <td>
        {row.decision ? (
          <Button
            className="small"
            busy={busy}
            disabled={row.decision.appliedCount > 0 || row.decision.publishedAt !== null}
            onClick={undo}
          >
            Undo
          </Button>
        ) : row.status === 'canonical' ? (
          <span className="small-text">canonical</span>
        ) : (
          <>
            <Button
              className="small"
              busy={busy}
              disabled={s.kind !== 'suggested'}
              onClick={() =>
                decide({ action: 'accept' }, `Map “${row.value}” to “${s.value}”?`, `Mapped to ${s.value}.`)
              }
            >
              Accept
            </Button>{' '}
            <Button className="small" busy={busy} onClick={() => setEditing((e) => !e)}>
              Edit…
            </Button>{' '}
            <Button
              className="small"
              busy={busy}
              onClick={() =>
                decide({ action: 'reject' }, `Reject “${row.value}”?`, 'Rejected: left as it is.')
              }
            >
              Reject
            </Button>{' '}
            <Button
              className="small"
              busy={busy}
              onClick={() =>
                decide(
                  { action: 'specialist', scope: 'pages' },
                  `Keep “${row.value}” as a specialist type for these ${row.count} page(s)?`,
                  'Kept as specialist.',
                )
              }
            >
              Keep as specialist
            </Button>
            {row.category !== '' && (
              <>
                {' '}
                <Button
                  className="small"
                  busy={busy}
                  onClick={() =>
                    decide(
                      { action: 'specialist', scope: 'category' },
                      `Keep “${row.value}” as a specialist type for any ${row.category} page?`,
                      'Kept as specialist for the category.',
                    )
                  }
                >
                  … for any {row.category} page
                </Button>
              </>
            )}
            {editing && (
              <div className="edit-picker" data-picker>
                <label>
                  Map to{' '}
                  <select
                    aria-label={`Map ${row.value} to`}
                    value={pick}
                    onChange={(e) => setPick(e.target.value)}
                  >
                    <option value="">Choose a {row.category || ''} type…</option>
                    {mine.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} ({t.role})
                      </option>
                    ))}
                    {row.category !== '' && <option value="__new__">A new canonical value…</option>}
                  </select>
                </label>
                {pick === '__new__' && (
                  <>
                    {' '}
                    <input
                      aria-label="New canonical value"
                      placeholder="New canonical value"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />{' '}
                    <input
                      aria-label="Its role word"
                      placeholder="Its role word"
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value)}
                    />
                  </>
                )}{' '}
                <Button
                  className="small"
                  busy={busy}
                  disabled={target === '' || (pick === '__new__' && newRole.trim() === '')}
                  onClick={() =>
                    decide(
                      {
                        action: 'edit',
                        target,
                        ...(pick === '__new__' ? { role: newRole.trim() } : {}),
                      },
                      `Map “${row.value}” to “${target}”?`,
                      `Mapped to ${target}.`,
                    )
                  }
                >
                  Map
                </Button>
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
