import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { useProject, useProjectApi, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import { Link } from '../router';

/**
 * Tagging (v3 F3f, ADR 0060), in the Repository group: the Controlled Native Tagging Standard's workflows for the Arkona
 * pack. **Audit**: a free, read-only policy audit (the snapshots) of a page, a branch or everything, each page with its
 * current and proposed arrays, a rationale per slot and its disposition; deterministic corrections can be proposed as
 * ONE batch (a proposal, approved on the Proposals page). **Holds**: what needs the owner, with agents' suggestions; an
 * uncertain category is resolved by choosing the category (and specialist) from the closed list (re-authenticated,
 * audited). **Batches**: each batch's proposal and what became of each page. **Reconciliation**: a named record across
 * batches; Resume audits what remains afresh and proposes the next batch. Nothing here writes to LegendKeeper.
 */

type Disposition = 'compliant' | 'correction' | 'hold' | 'exception';
type Filter = Disposition | 'lifecycle' | 'excluded';

interface Policy {
  packId: string;
  version: number;
  label: string | null;
  digest: string;
  sources: { key: string; version: string }[];
}
interface Counts {
  pages: number;
  compliant: number;
  correction: number;
  hold: number;
  exception: number;
  lifecycleOnly: number;
  lifecycleProblems: number;
  excluded: number;
}
interface Run {
  id: string;
  policy: Policy;
  scope: Record<string, unknown>;
  counts: Counts;
  reconciliationId: string | null;
  actor: string;
  createdAt: number;
}
interface PageView {
  pageId: string;
  name: string;
  disposition: Disposition | null;
  scope: 'grammar' | 'lifecycle' | 'excluded';
  current: string[];
  proposed: string[];
  excluded?: string;
  lifecycle?: string;
  rationale: { slot: string; tag: string | null; source: string; held?: string }[];
  holds?: { kind: string; slot: string; reason: string }[];
  exceptions?: { tag: string; reason: string }[];
  removals?: { tag: string; why: string }[];
}
interface Classification {
  pageId: string;
  pageName: string;
  primary: string;
  specialist: string | null;
  reason: string;
  by: string;
  at: number;
}
interface Suggestion {
  id: number;
  primary: string;
  specialist: string | null;
  reason: string;
  by: string;
  at: number;
}
interface Batch {
  id: string;
  runId: string;
  reconciliationId: string | null;
  proposalId: string | null;
  jobId: string | null;
  state: string;
  pages: { pageId: string; name: string; current: string[]; proposed: string[] }[];
  dispositions: Record<
    string,
    { outcome: string; reason: string; verified: boolean | null; differences?: string[] }
  > | null;
  createdAt: number;
}
interface Reconciliation {
  id: string;
  name: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}
interface Overview {
  policy: Policy | null;
  unavailable: { code: string; message: string } | null;
  closedList: { primary: string; specialists: string[]; kind: string }[];
  runs: Run[];
  classifications: Classification[];
  reconciliations: Reconciliation[];
  batches: Batch[];
}

const TABS = ['Audit', 'Holds', 'Exceptions', 'Batches', 'Reconciliation'] as const;
type Tab = (typeof TABS)[number];

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  compliant: 'ok',
  correction: 'info',
  hold: 'warn',
  exception: 'warn',
  applied: 'ok',
  already_compliant: 'ok',
  held: 'warn',
  conflicted: 'bad',
  inaccessible: 'bad',
};

const tags = (t: string[]) => (t.length ? t.join(', ') : '(none)');

export function TaggingPage() {
  const { selected } = useProject();
  const r = useScopedApi<Overview>('/tagging');
  const [tab, setTab] = useState<Tab>('Audit');
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  return (
    <>
      <PageHeader title="Tagging" project={selected}>
        <button type="button" className="small" onClick={r.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The Controlled Native Tagging Standard, for the Arkona pack: audit first (free, from the snapshots),
        holds go to you, and every apply is a proposal you approve on the Proposals page.
      </p>
      {d.unavailable ? (
        <div className="note note-warn" role="status">
          {d.unavailable.message}
        </div>
      ) : (
        d.policy && (
          <p className="small-text">
            Policy: pack {d.policy.packId} version {d.policy.version}
            {d.policy.label ? ` (Tagging Standard ${d.policy.label})` : ''}, digest{' '}
            <span className="mono">{d.policy.digest.slice(0, 16)}</span>
          </p>
        )
      )}
      <div role="tablist" aria-label="Tagging" className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'primary small' : 'small'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Audit' && <AuditTab overview={d} onChanged={r.reload} />}
      {tab === 'Holds' && <HoldsTab overview={d} onChanged={r.reload} />}
      {tab === 'Exceptions' && <ExceptionsTab onChanged={r.reload} />}
      {tab === 'Batches' && <BatchesTab batches={d.batches} />}
      {tab === 'Reconciliation' && <ReconciliationTab overview={d} onChanged={r.reload} />}
    </>
  );
}

function ScopeForm({
  onRun,
  busy,
  label,
}: {
  onRun: (s: Record<string, unknown>) => void;
  busy: boolean;
  label: string;
}) {
  const [kind, setKind] = useState<'all' | 'page' | 'under'>('all');
  const [ref, setRef] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        onRun(kind === 'all' ? { all: true } : { [kind]: ref.trim() });
      }}
    >
      <label>
        Scope{' '}
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Scope">
          <option value="all">Everything</option>
          <option value="page">One page</option>
          <option value="under">A branch</option>
        </select>
      </label>
      {kind !== 'all' && (
        <input
          aria-label="Page (name, path or id)"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="Name, path or id"
        />
      )}
      <Button type="submit" variant="primary" busy={busy} disabled={kind !== 'all' && ref.trim() === ''}>
        {label}
      </Button>
    </form>
  );
}

function AuditTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [runId, setRunId] = useState<string | null>(overview.runs[0]?.id ?? null);
  const [filter, setFilter] = useState<Filter | ''>('correction');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const q = new URLSearchParams({ limit: '500', ...(filter ? { filter } : {}) });
  const pages = useScopedApi<{ run: Run; total: number; pages: PageView[] }>(
    runId ? `/tagging/runs/${runId}?${q.toString()}` : null,
  );
  const audit = (scope: Record<string, unknown>) =>
    void run(() => api.post<{ run: Run }>('/tagging/audit', scope), 'Audit done (free: the snapshots).').then(
      (x) => {
        if (!x) return;
        setRunId(x.run.id);
        setPicked(new Set());
        onChanged();
      },
    );
  const propose = () =>
    void confirm({
      title: `Propose ${picked.size} correction${picked.size === 1 ? '' : 's'} as one batch?`,
      message: (
        <p>
          ONE proposal, each page an item. Nothing is written until you approve it on the Proposals page; its
          job compares the policy, reads each page fresh (a page changed since the audit is skipped as
          conflicted) and reads it back.
        </p>
      ),
      confirmLabel: 'Propose the batch',
    }).then((ok) => {
      if (!ok || !runId) return;
      void run(
        () =>
          api.post<{ proposalId: string | null }>('/tagging/batches', {
            runId,
            pageIds: [...picked],
            confirm: true,
          }),
        'Batch proposed: approve it on the Proposals page.',
      ).then((x) => {
        if (x) {
          setPicked(new Set());
          onChanged();
        }
      });
    });
  return (
    <section className="card" aria-labelledby="tagging-audit-h">
      <h2 id="tagging-audit-h">Audit</h2>
      <ScopeForm onRun={audit} busy={busy} label="Run the audit (free)" />
      {overview.runs.length > 0 && (
        <label className="small-text">
          Run{' '}
          <select value={runId ?? ''} onChange={(e) => setRunId(e.target.value || null)} aria-label="Run">
            {overview.runs.map((x) => (
              <option key={x.id} value={x.id}>
                {new Date(x.createdAt).toISOString().slice(0, 16)} · {x.counts.correction} corrections,{' '}
                {x.counts.hold} holds, {x.counts.exception} exceptions, {x.counts.compliant} compliant
              </option>
            ))}
          </select>
        </label>
      )}{' '}
      <label className="small-text">
        Show{' '}
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter | '')} aria-label="Show">
          <option value="">Every page</option>
          <option value="correction">Deterministic corrections</option>
          <option value="hold">Holds</option>
          <option value="exception">Exceptions</option>
          <option value="compliant">Compliant</option>
          <option value="lifecycle">Working and Archived (lifecycle only)</option>
          <option value="excluded">Excluded</option>
        </select>
      </label>
      {!runId ? (
        <Empty>No audit yet.</Empty>
      ) : !pages.data ? (
        pages.error ? (
          <ErrorNote error={pages.error} onRetry={pages.reload} />
        ) : (
          <Loading />
        )
      ) : pages.data.pages.length === 0 ? (
        <Empty>No page here.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Page</th>
                  <th>Disposition</th>
                  <th>Current</th>
                  <th>Proposed</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {pages.data.pages.map((p) => (
                  <tr key={p.pageId} data-page={p.pageId}>
                    <td>
                      {p.disposition === 'correction' && (
                        <input
                          type="checkbox"
                          aria-label={`Pick ${p.name}`}
                          checked={picked.has(p.pageId)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(p.pageId);
                            else next.delete(p.pageId);
                            setPicked(next);
                          }}
                        />
                      )}
                    </td>
                    <td>
                      <span className="mono small-text">{p.pageId}</span> {p.name}
                    </td>
                    <td>
                      <Badge tone={TONE[p.disposition ?? ''] ?? 'neutral'}>{p.disposition ?? p.scope}</Badge>
                    </td>
                    <td>{tags(p.current)}</td>
                    <td>{tags(p.proposed)}</td>
                    <td className="small-text">
                      {p.excluded ?? p.lifecycle ?? null}
                      <ul>
                        {p.rationale.map((s, i) => (
                          <li key={i}>
                            <strong>{s.slot}</strong>: {s.source}
                            {s.held ? <em> (held: {s.held})</em> : null}
                          </li>
                        ))}
                        {(p.holds ?? []).map((h, i) => (
                          <li key={`h${i}`}>Hold: {h.reason}</li>
                        ))}
                        {(p.removals ?? []).map((x, i) => (
                          <li key={`r${i}`}>
                            Remove “{x.tag}”: {x.why}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button variant="primary" busy={busy} disabled={picked.size === 0} onClick={propose}>
            Propose the picked corrections ({picked.size})
          </Button>
        </>
      )}
      {runId && (
        <ApplyAll runId={runId} corrections={runCorrections(overview, runId)} onChanged={onChanged} />
      )}
    </section>
  );
}

/** How many deterministic corrections a run found (its counts). */
const runCorrections = (o: Overview, runId: string): number =>
  o.runs.find((x) => x.id === runId)?.counts.correction ?? 0;

/**
 * v3 F5a (ADR 0067, H4): "Apply all corrections" of the run shown: the usual bounded batches (the pack's batch size,
 * each page an item), then "Approve all these batches" (a bulk approval: the step-up).
 */
function ApplyAll({
  runId,
  corrections,
  onChanged,
}: {
  runId: string;
  corrections: number;
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [made, setMade] = useState<{ proposalId: string | null; pages: number }[] | null>(null);
  const [approved, setApproved] = useState<{ id: string; ok: boolean; error?: { message: string } }[] | null>(
    null,
  );
  const applyAll = () =>
    void confirm({
      title: `Propose all ${corrections} correction${corrections === 1 ? '' : 's'} of this run?`,
      message: (
        <p>
          They are proposed in the usual bounded batches (each page an item); pages already in an open batch
          are left out. Nothing is written until the batches are approved.
        </p>
      ),
      confirmLabel: 'Make the batches',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post<{ pages: number; batches: { proposalId: string | null; pages: number }[] }>(
              '/tagging/apply-all',
              { runId, confirm: true },
            ),
          ),
        'Batches made.',
      ).then((x) => {
        if (!x) return;
        setMade(x.batches);
        setApproved(null);
        onChanged();
      });
    });
  const ids = (made ?? []).map((b) => b.proposalId).filter((x): x is string => x !== null);
  const approveAll = () =>
    void confirm({
      title: `Approve all ${ids.length} batch${ids.length === 1 ? '' : 'es'}?`,
      message: (
        <p>
          Each batch is approved whole and runs on its own: its job checks the policy, reads each page fresh
          (a page changed since the audit is skipped as conflicted) and reads it back. A bulk approval asks
          for your authenticator code.
        </p>
      ),
      confirmLabel: 'Approve all these batches',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post<{ results: { id: string; ok: boolean; error?: { message: string } }[] }>(
              '/tagging/approve-batches',
              { proposalIds: ids, confirm: true },
            ),
          ),
        'Batches approved.',
      ).then((x) => {
        if (!x) return;
        setApproved(x.results);
        onChanged();
      });
    });
  return (
    <div className="mt" role="group" aria-label="Apply all corrections">
      <Button busy={busy} disabled={corrections === 0} onClick={applyAll}>
        Apply all corrections ({corrections})
      </Button>
      {made && (
        <>
          <p className="small-text">
            {made.length === 0
              ? 'No correction is left to propose (each is in an open batch already).'
              : `${made.length} batch${made.length === 1 ? '' : 'es'} made: ${made.map((b) => b.pages).join(', ')} pages.`}
          </p>
          {ids.length > 0 && !approved && (
            <Button variant="primary" busy={busy} onClick={approveAll}>
              Approve all these batches ({ids.length})
            </Button>
          )}
        </>
      )}
      {approved && (
        <ul className="plain small-text" aria-label="Batch approvals">
          {approved.map((a) => (
            <li key={a.id}>
              <Badge tone={a.ok ? 'ok' : 'bad'}>{a.ok ? 'approved' : 'refused'}</Badge>{' '}
              <Link to={`/proposals?id=${encodeURIComponent(a.id)}`}>{a.id}</Link>
              {a.ok ? '' : `: ${a.error?.message ?? 'refused'}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RulingRecord {
  pageId: string;
  tag: string;
  tags: string[];
  reason: string;
  by: string;
  at: number;
}
interface RulingSuggestion {
  id: number;
  tag: string;
  action: 'keep_here' | 'allow_everywhere';
  reason: string;
  by: string;
  at: number;
}

/**
 * v3 F5a (ADR 0067, H2): the latest audit's exceptions, each with the owner's two actions: "Keep this tag here" (a ruling
 * for this page, while its tags are unchanged) and "Allow this tag everywhere" (the Tagging Standard's Approved
 * Supplementary Tags edited: a dry run first, then the step-up). Agents' suggestions are shown beside them.
 */
function ExceptionsTab({ onChanged }: { onChanged: () => void }) {
  const r = useScopedApi<{
    run: Run | null;
    supplementary: string[];
    exceptions: (PageView & { rulings: RulingRecord[]; suggestions: RulingSuggestion[] })[];
  }>('/tagging/exceptions');
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return (
    <section className="card" aria-labelledby="tagging-exceptions-h">
      <h2 id="tagging-exceptions-h">Exceptions ({r.data.exceptions.length})</h2>
      <p className="muted small-text">
        From the latest audit: a tag outside the grammar that no rule settles is yours to judge. The Approved
        Supplementary Tags ({r.data.supplementary.length ? r.data.supplementary.join(', ') : 'none'}) are kept
        wherever they appear. Agents may suggest a ruling with a reason; only you take one.
      </p>
      {r.data.exceptions.length === 0 ? (
        <Empty>No exceptions in the latest audit.</Empty>
      ) : (
        r.data.exceptions.map((x) => (
          <ExceptionCard
            key={x.pageId}
            page={x}
            onChanged={() => {
              r.reload();
              onChanged();
            }}
          />
        ))
      )}
    </section>
  );
}

function ExceptionCard({
  page,
  onChanged,
}: {
  page: PageView & { rulings: RulingRecord[]; suggestions: RulingSuggestion[] };
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [reason, setReason] = useState('');
  const keep = (tag: string) =>
    void confirm({
      title: `Keep “${tag}” on ${page.name}?`,
      message: (
        <p>
          A ruling for this page alone, tied to its tags as they are now ({tags(page.current)}). If they
          change, the ruling lapses and the audit asks again. Audited.
        </p>
      ),
      confirmLabel: 'Keep this tag here',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post('/tagging/keep-here', { pageId: page.pageId, tag, reason, confirm: true }),
          ),
        'Kept: the next audit treats it as allowed on this page.',
      ).then((x) => {
        if (x) onChanged();
      });
    });
  const allow = (tag: string) =>
    void run(
      () =>
        api.post<{ before: string; after: string; tags: string[] }>('/tagging/allow-everywhere', {
          tag,
          pageId: page.pageId,
          dryRun: true,
        }),
      'The edit, as a dry run (nothing written).',
    ).then((dry) => {
      if (!dry) return;
      void confirm({
        title: `Allow “${tag}” everywhere?`,
        message: (
          <>
            <p>
              The bridge edits the Tagging Standard’s Approved Supplementary Tags as your action (journalled;
              it can be Reverted). Then approve the pack’s new version on the Packs page.
            </p>
            <p className="small-text">
              <strong>Before:</strong> {dry.before}
            </p>
            <p className="small-text">
              <strong>After:</strong> {dry.after}
            </p>
          </>
        ),
        confirmLabel: 'Allow this tag everywhere',
      }).then((ok) => {
        if (!ok) return;
        void run(
          () =>
            withReauth(() =>
              api.post('/tagging/allow-everywhere', { tag, pageId: page.pageId, confirm: true }),
            ),
          'The Tagging Standard is edited: approve the pack’s new version on the Packs page.',
        ).then((x) => {
          if (x) onChanged();
        });
      });
    });
  const withdraw = (tag: string) =>
    void run(
      () => api.post('/tagging/unkeep', { pageId: page.pageId, tag, confirm: true }),
      'Ruling withdrawn.',
    ).then((x) => {
      if (x) onChanged();
    });
  return (
    <article className="card" data-exception={page.pageId}>
      <h3>
        <span className="mono small-text">{page.pageId}</span> {page.name}
      </h3>
      <p className="small-text">Tags: {tags(page.current)}</p>
      <input
        aria-label={`Reason for ${page.name}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What you checked (for Keep this tag here)"
      />
      <ul className="small-text">
        {(page.exceptions ?? []).map((e) => {
          const ruling = page.rulings.find((x) => x.tag === e.tag);
          const suggested = page.suggestions.filter((s) => s.tag === e.tag);
          return (
            <li key={e.tag}>
              <strong>{e.tag}</strong>: {e.reason}{' '}
              <Button
                className="small"
                busy={busy}
                disabled={reason.trim() === ''}
                onClick={() => keep(e.tag)}
              >
                Keep this tag here
              </Button>{' '}
              <Button className="small" busy={busy} onClick={() => allow(e.tag)}>
                Allow this tag everywhere
              </Button>
              {ruling && (
                <div>
                  Your ruling of {new Date(ruling.at).toISOString().slice(0, 10)} (on {tags(ruling.tags)}):{' '}
                  {ruling.reason}{' '}
                  <Button className="small" busy={busy} onClick={() => withdraw(e.tag)}>
                    Withdraw
                  </Button>
                </div>
              )}
              {suggested.length > 0 && (
                <div>
                  Suggested:{' '}
                  {suggested
                    .map(
                      (s) =>
                        `${s.action === 'keep_here' ? 'keep it here' : 'allow it everywhere'} (${s.by}: ${s.reason})`,
                    )
                    .join('; ')}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function HoldsTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const r = useScopedApi<{
    run: Run | null;
    holds: (PageView & {
      uncertainCategory: boolean;
      suggestions: Suggestion[];
      classification: Classification | null;
    })[];
  }>('/tagging/holds');
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return (
    <section className="card" aria-labelledby="tagging-holds-h">
      <h2 id="tagging-holds-h">Holds ({r.data.holds.length})</h2>
      <p className="muted small-text">
        From the latest audit. An uncertain category or specialist is yours to classify from the closed list:
        the next audit uses it. Agents may suggest one with a reason; nothing changes until you classify.
      </p>
      {r.data.holds.length === 0 ? (
        <Empty>No holds in the latest audit.</Empty>
      ) : (
        r.data.holds.map((h) => (
          <HoldCard
            key={h.pageId}
            hold={h}
            closedList={overview.closedList}
            onChanged={() => {
              r.reload();
              onChanged();
            }}
          />
        ))
      )}
    </section>
  );
}

function HoldCard({
  hold,
  closedList,
  onChanged,
}: {
  hold: PageView & {
    uncertainCategory: boolean;
    suggestions: Suggestion[];
    classification: Classification | null;
  };
  closedList: Overview['closedList'];
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [primary, setPrimary] = useState(hold.classification?.primary ?? '');
  const [specialist, setSpecialist] = useState(hold.classification?.specialist ?? '');
  const [reason, setReason] = useState('');
  const specs = closedList.find((c) => c.primary === primary)?.specialists ?? [];
  const classify = () =>
    void confirm({
      title: `Classify ${hold.name} as ${primary}${specialist ? `, ${specialist}` : ''}?`,
      message: <p>Stored as your classification of this page and used by every later audit. Audited.</p>,
      confirmLabel: 'Classify',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post('/tagging/classify', {
              pageId: hold.pageId,
              primary,
              specialist: specialist || null,
              reason,
              confirm: true,
            }),
          ),
        'Classified: the next audit uses it.',
      ).then((x) => {
        if (x) onChanged();
      });
    });
  const withdraw = () =>
    void run(
      () => withReauth(() => api.post('/tagging/unclassify', { pageId: hold.pageId, confirm: true })),
      'Classification withdrawn.',
    ).then((x) => {
      if (x) onChanged();
    });
  return (
    <article className="card" data-hold={hold.pageId}>
      <h3>
        <span className="mono small-text">{hold.pageId}</span> {hold.name}
      </h3>
      <p className="small-text">Tags: {tags(hold.current)}</p>
      <ul className="small-text">
        {(hold.holds ?? []).map((x, i) => (
          <li key={i}>{x.reason}</li>
        ))}
      </ul>
      {hold.suggestions.length > 0 && (
        <p className="small-text">
          Suggested:{' '}
          {hold.suggestions
            .map((s) => `${s.primary}${s.specialist ? `, ${s.specialist}` : ''} (${s.by}: ${s.reason})`)
            .join('; ')}
        </p>
      )}
      {hold.classification && (
        <p className="small-text">
          Your classification: {hold.classification.primary}
          {hold.classification.specialist ? `, ${hold.classification.specialist}` : ''} (
          {hold.classification.reason}){' '}
          <Button className="small" busy={busy} onClick={withdraw}>
            Withdraw
          </Button>
        </p>
      )}
      {hold.uncertainCategory && (
        <div className="inline-form">
          <label>
            Category{' '}
            <select
              aria-label={`Category for ${hold.name}`}
              value={primary}
              onChange={(e) => {
                setPrimary(e.target.value);
                setSpecialist('');
              }}
            >
              <option value="">Choose…</option>
              {closedList.map((c) => (
                <option key={c.primary} value={c.primary}>
                  {c.primary}
                </option>
              ))}
            </select>
          </label>
          <label>
            Specialist{' '}
            <select
              aria-label={`Specialist for ${hold.name}`}
              value={specialist}
              onChange={(e) => setSpecialist(e.target.value)}
            >
              <option value="">None</option>
              {specs.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label={`Reason for ${hold.name}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What you checked"
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={!primary || reason.trim() === ''}
            onClick={classify}
          >
            Classify
          </Button>
        </div>
      )}
    </article>
  );
}

function BatchesTab({ batches }: { batches: Batch[] }) {
  return (
    <section className="card table-wrap" aria-labelledby="tagging-batches-h">
      <h2 id="tagging-batches-h">Batches ({batches.length})</h2>
      {batches.length === 0 ? (
        <Empty>No batch proposed yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>State</th>
              <th>Proposal / job</th>
              <th>Pages</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} data-batch={b.id}>
                <td className="mono small-text">{b.id}</td>
                <td>
                  <Badge
                    tone={
                      b.state === 'done'
                        ? 'ok'
                        : b.state === 'stopped' || b.state === 'rejected'
                          ? 'warn'
                          : 'info'
                    }
                  >
                    {b.state}
                  </Badge>
                </td>
                <td className="small-text">
                  {b.proposalId && <Link to="/proposals">{b.proposalId}</Link>}{' '}
                  {b.jobId && <Link to={`/jobs/${b.jobId}`}>{b.jobId}</Link>}
                </td>
                <td className="small-text">
                  <ul>
                    {b.pages.map((p) => {
                      const d = b.dispositions?.[p.pageId];
                      return (
                        <li key={p.pageId}>
                          {p.name}: {tags(p.current)} → {tags(p.proposed)}{' '}
                          {d ? (
                            <Badge tone={TONE[d.outcome] ?? 'neutral'}>
                              {d.outcome.replace('_', ' ')}
                              {d.verified === false ? ' (read-back differs)' : ''}
                            </Badge>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface RecView {
  reconciliation: Reconciliation;
  counts: Record<string, number>;
  remaining: string[];
  pages: {
    pageId: string;
    name: string;
    disposition: string | null;
    outcome: string | null;
    stale: boolean;
  }[];
}

function ReconciliationTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const api = useProjectApi();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(overview.reconciliations[0]?.id ?? null);
  const view = useScopedApi<RecView>(open ? `/tagging/reconciliations/${open}` : null);
  const start = (scope: Record<string, unknown>) =>
    void run(
      () =>
        api.post<{ reconciliation: Reconciliation }>('/tagging/reconciliations', {
          name,
          ...scope,
          confirm: true,
        }),
      'Reconciliation started with a first audit (free).',
    ).then((x) => {
      if (!x) return;
      setOpen(x.reconciliation.id);
      onChanged();
    });
  const resume = () =>
    void confirm({
      title: 'Resume this reconciliation?',
      message: (
        <p>
          What remains is audited afresh (free, from the snapshots), then its next batch of deterministic
          corrections is proposed: ONE proposal for you to approve on the Proposals page.
        </p>
      ),
      confirmLabel: 'Resume',
    }).then((ok) => {
      if (!ok || !open) return;
      void run(() =>
        api.post<{ status: string }>(`/tagging/reconciliations/${open}/resume`, { confirm: true }),
      ).then((x) => {
        if (!x) return;
        view.reload();
        onChanged();
      });
    });
  return (
    <section className="card" aria-labelledby="tagging-rec-h">
      <h2 id="tagging-rec-h">Reconciliation</h2>
      <label>
        Name <input aria-label="Reconciliation name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <ScopeForm onRun={start} busy={busy || name.trim() === ''} label="Start (a first audit, free)" />
      {overview.reconciliations.length > 0 && (
        <label className="small-text">
          Open{' '}
          <select
            value={open ?? ''}
            onChange={(e) => setOpen(e.target.value || null)}
            aria-label="Reconciliation"
          >
            {overview.reconciliations.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {open && view.data && (
        <>
          <dl className="kv">
            {Object.entries(view.data.counts).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <Button variant="primary" busy={busy} disabled={view.data.counts.remaining === 0} onClick={resume}>
            Resume: audit what remains, propose the next batch
          </Button>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Latest verdict</th>
                  <th>Last apply</th>
                  <th>Stale</th>
                </tr>
              </thead>
              <tbody>
                {view.data.pages.map((p) => (
                  <tr key={p.pageId}>
                    <td>{p.name}</td>
                    <td>
                      {p.disposition ? (
                        <Badge tone={TONE[p.disposition] ?? 'neutral'}>{p.disposition}</Badge>
                      ) : null}
                    </td>
                    <td>
                      {p.outcome ? (
                        <Badge tone={TONE[p.outcome] ?? 'neutral'}>{p.outcome.replace('_', ' ')}</Badge>
                      ) : null}
                    </td>
                    <td>{p.stale ? <Badge tone="warn">stale: audit again</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
