import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectReloadOn, useScopedApi } from '../project';
import { Link } from '../router';
import type {
  AppraisalFindingView,
  AppraisalFixResponse,
  AppraisalOverviewResponse,
  AppraisalReportView,
  AppraisalRunView,
  AppraisalToolName,
  SplitDraftEntry,
} from '../types';

/**
 * Appraisal (v3 F3c, ADR 0054; the design's decision D4): the Arkona pack's read-only appraisal tools, run on a page or a
 * branch from here. Cards:
 *
 * - Full-text index: the snapshots it was built from, how fresh it is, its size, how long it took; "Rebuild" (free);
 * - Run: the owner appraisal (A2), change impact (A3), the Working digest (A4) or visual hygiene (A5);
 * - Report: in its groups (A2's four: required defects, optional polish, architectural candidates, blocked cases), each
 *   finding with its rule, evidence class, a link to the page in LegendKeeper, and its follow-up: "Propose a fix" ONLY
 *   where the finding has a deterministic repair (one ordinary proposal, approved on the Proposals page); a judgement
 *   says what has to be decided; nothing on this page writes to LegendKeeper;
 * - Latest runs: the latest stored run of each tool and scope (kept in the bridge's database, never in LegendKeeper).
 */

/**
 * A page in the LegendKeeper app. LegendKeeper's API gives no page address, so this is the app's address pattern: one
 * constant, to correct here if LegendKeeper's app uses another.
 */
export const LK_PAGE_URL = 'https://www.legendkeeper.com/app/{project}/{page}/';
export const lkPageUrl = (projectId: string, pageId: string): string =>
  LK_PAGE_URL.replace('{project}', encodeURIComponent(projectId)).replace(
    '{page}',
    encodeURIComponent(pageId),
  );

type ToolKey = 'owner' | 'impact' | 'digest' | 'visual' | 'split';
const TOOLS: { key: ToolKey; tool: AppraisalToolName; label: string }[] = [
  { key: 'owner', tool: 'arkona_appraise_owner', label: 'Owner appraisal (A2)' },
  { key: 'impact', tool: 'arkona_change_impact', label: 'Change impact (A3)' },
  { key: 'digest', tool: 'arkona_working_digest', label: 'Working digest (A4)' },
  { key: 'visual', tool: 'arkona_visual_hygiene', label: 'Visual hygiene (A5)' },
  { key: 'split', tool: 'arkona_split_appraisal', label: 'Split appraisal (A6)' },
];
const TOOL_LABEL = Object.fromEntries(TOOLS.map((t) => [t.tool, t.label])) as Record<
  AppraisalToolName,
  string
>;

export const GROUP_ORDER: Record<AppraisalToolName, { key: string; label: string }[]> = {
  arkona_appraise_owner: [
    { key: 'required', label: 'Required defects' },
    { key: 'polish', label: 'Optional polish' },
    { key: 'architectural', label: 'Architectural candidates' },
    { key: 'blocked', label: 'Blocked cases' },
  ],
  arkona_change_impact: [
    { key: 'proven', label: 'Proven breakage' },
    { key: 'candidates', label: 'Review candidates' },
    { key: 'blocked', label: 'Blocked cases' },
  ],
  arkona_working_digest: [
    { key: 'working', label: 'Working pages' },
    { key: 'proposals', label: 'Pending and conflicted proposals' },
    { key: 'unpromoted', label: 'Approved but not promoted' },
    { key: 'contradictions', label: 'Declared contradictions' },
    { key: 'blocked', label: 'Blocked cases' },
  ],
  arkona_visual_hygiene: [
    { key: 'candidates', label: 'Candidates' },
    { key: 'blocked', label: 'Blocked cases' },
  ],
  arkona_split_appraisal: [
    { key: 'architectural', label: 'Architectural candidates' },
    { key: 'blocked', label: 'Blocked cases' },
  ],
};

const EVIDENCE_TONE: Record<string, 'bad' | 'warn' | 'info' | 'neutral'> = {
  'Confirmed deterministic defect': 'bad',
  'Potential Maintenance Issue': 'warn',
  'Explicitly Unresolved': 'warn',
  Inaccessible: 'neutral',
  Incomplete: 'neutral',
  'Review signal': 'info',
};

export function AppraisalPage() {
  const { selected } = useProject();
  const overview = useScopedApi<AppraisalOverviewResponse>('/appraisal');
  const [report, setReport] = useState<AppraisalReportView | null>(null);
  const now = useNow(30_000);
  useProjectReloadOn(['proposals'], overview.reload);
  return (
    <>
      <PageHeader title="Appraisal" project={selected}>
        <button type="button" className="small" onClick={overview.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The Arkona pack’s appraisal: read-only reports from the nightly snapshot and the change snapshots
        since (no request to LegendKeeper). Nothing here writes to LegendKeeper. “Propose a fix” makes one
        ordinary proposal for you to approve on the <Link to="/proposals">Proposals</Link> page; the audits it
        reuses are on the <Link to="/audits">Audits</Link> page.
      </p>
      {!overview.data ? (
        overview.error ? (
          <ErrorNote error={overview.error} onRetry={overview.reload} />
        ) : (
          <Loading />
        )
      ) : (
        <>
          {!overview.data.attached && (
            <p className="note note-warn" data-testid="not-attached">
              The Arkona pack is not attached to this project, so its appraisal tools do not apply here.
            </p>
          )}
          <IndexCard project={selected} d={overview.data} now={now} reload={overview.reload} />
          <RunCard
            project={selected}
            disabled={!overview.data.attached}
            onReport={(r) => {
              setReport(r);
              overview.reload();
            }}
          />
          {report && <ReportCard project={selected} projectId={overview.data.project.id} report={report} />}
          <RunsCard project={selected} runs={overview.data.runs} now={now} onOpen={setReport} />
        </>
      )}
    </>
  );
}

// ================================================================================================ the index

function IndexCard({
  project,
  d,
  now,
  reload,
}: {
  project: string | null;
  d: AppraisalOverviewResponse;
  now: number;
  reload: () => void;
}) {
  const { run, busy } = useAction();
  const ix = d.index;
  const rebuild = () =>
    void run(() => api.post('/appraisal/index/rebuild', { confirm: true, project }), 'Index rebuilt.').then(
      () => reload(),
    );
  return (
    <section className="card" aria-labelledby="appraisal-index-h">
      <h2 id="appraisal-index-h">Full-text index</h2>
      {ix ? (
        <dl className="kv">
          <dt>Built from</dt>
          <dd>
            <code>{ix.baseSnapshotId}</code>{' '}
            <span className="muted small-text">({fmtAgo(ix.baseTakenAt, now)})</span>
            {ix.changes > 0 && (
              <div className="muted small-text">
                plus {fmtInt(ix.changes)} change snapshot{ix.changes === 1 ? '' : 's'}, the newest{' '}
                {fmtTime(ix.newestTakenAt)}
              </div>
            )}
          </dd>
          <dt>Complete as of</dt>
          <dd>
            {fmtTime(ix.newestTakenAt)}{' '}
            <span className="muted small-text">({fmtAgo(ix.newestTakenAt, now)})</span>
          </dd>
          <dt>Holds</dt>
          <dd>
            {fmtInt(ix.pages)} pages · {fmtInt(ix.units)} units of text · {fmtInt(ix.refs)} links
            {ix.unreadable > 0 && <> · {fmtInt(ix.unreadable)} piece(s) unreadable</>}
          </dd>
          <dt>Size</dt>
          <dd>{ix.sizeBytes === null ? '–' : fmtBytes(ix.sizeBytes)}</dd>
          <dt>Took</dt>
          <dd>
            built in {fmtDuration(ix.buildMs)}
            {ix.lastUpdateMs !== null && <> · last update {fmtDuration(ix.lastUpdateMs)}</>}
          </dd>
          {ix.notes.length > 0 && (
            <>
              <dt>Notes</dt>
              <dd>
                {ix.notes.map((n) => (
                  <div key={n} className="small-text">
                    {n}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <Empty>
          No index yet: it is built after the next nightly full snapshot (or now, from the newest one, with
          Rebuild).
        </Empty>
      )}
      <p className="muted small-text">
        Left out of the full-text search unless asked for (non-current):{' '}
        {d.areas
          .map((a) => `${a.label} (${a.found.length ? a.found.map((f) => f.name).join(', ') : 'not found'})`)
          .join('; ')}
        .
      </p>
      <div className="row mt">
        <Button busy={busy} disabled={!project} onClick={rebuild}>
          Rebuild the index now
        </Button>
        <span className="muted small-text">Reads the snapshot store only: no request to LegendKeeper.</span>
      </div>
    </section>
  );
}

// ================================================================================================ run

function RunCard({
  project,
  disabled,
  onReport,
}: {
  project: string | null;
  disabled: boolean;
  onReport: (r: AppraisalReportView) => void;
}) {
  const { run, busy } = useAction();
  const [tool, setTool] = useState<ToolKey>('owner');
  const [scope, setScope] = useState<'page' | 'under' | 'all'>('under');
  const [target, setTarget] = useState('');
  const [include, setInclude] = useState<string[]>([]);
  const [renameTo, setRenameTo] = useState('');
  const [proposal, setProposal] = useState('');
  const [since, setSince] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { confirm: true, project, tool };
    if (tool === 'owner' || tool === 'visual') {
      if (scope === 'all') body.all = true;
      else if (target.trim()) body[scope] = target.trim();
      if (tool === 'owner' && include.length) body.include = include;
    }
    if (tool === 'split') {
      if (target.trim()) body[scope === 'all' ? 'under' : scope] = target.trim();
      if (include.length && scope !== 'page') body.include = include;
    }
    if (tool === 'impact') {
      if (proposal.trim()) body.proposal = proposal.trim();
      else body.page = target.trim();
      if (renameTo.trim()) body.renameTo = renameTo.trim();
    }
    if (tool === 'digest' && since.trim()) body.sinceDays = Number(since);
    void run(() => api.post<{ report: AppraisalReportView }>('/appraisal/run', body)).then((r) => {
      if (r) onReport(r.report);
    });
  };
  return (
    <section className="card" aria-labelledby="appraisal-run-h">
      <h2 id="appraisal-run-h">Run</h2>
      <form onSubmit={submit} className="stack">
        <label>
          Tool{' '}
          <select value={tool} onChange={(e) => setTool(e.target.value as typeof tool)} aria-label="Tool">
            {TOOLS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {(tool === 'owner' || tool === 'visual' || tool === 'split') && (
          <fieldset>
            <legend>Scope</legend>
            {(tool === 'split' ? (['page', 'under'] as const) : (['page', 'under', 'all'] as const)).map(
              (s) => (
                <label key={s} className="inline">
                  <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />{' '}
                  {s === 'page'
                    ? 'One page'
                    : s === 'under'
                      ? 'A branch'
                      : tool === 'visual'
                        ? 'The whole library'
                        : 'Everything'}
                </label>
              ),
            )}
          </fieldset>
        )}
        {((tool !== 'digest' && scope !== 'all') || tool === 'impact') && (
          <label>
            {tool === 'impact' ? 'Page' : scope === 'page' ? 'Page' : 'Branch'} (name, path or id){' '}
            <input value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Page or branch" />
          </label>
        )}
        {(tool === 'owner' || tool === 'split') && scope !== 'page' && (
          <fieldset>
            <legend>Bring in the non-current areas</legend>
            {(
              [
                ['legacy', 'Legacy Canon Archive'],
                ['design', 'Design References'],
                ['archived', 'Archived pages'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="inline">
                <input
                  type="checkbox"
                  checked={include.includes(k)}
                  onChange={(e) =>
                    setInclude(e.target.checked ? [...include, k] : include.filter((x) => x !== k))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
        )}
        {tool === 'impact' && (
          <>
            <label>
              Planned new name (optional){' '}
              <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} aria-label="Rename to" />
            </label>
            <label>
              Or a pending proposal{' '}
              <input
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                aria-label="Proposal id"
              />
            </label>
          </>
        )}
        {tool === 'digest' && (
          <label>
            Changed in the last (days, optional){' '}
            <input
              value={since}
              onChange={(e) => setSince(e.target.value)}
              aria-label="Since days"
              inputMode="numeric"
            />
          </label>
        )}
        <div className="row">
          <Button variant="primary" busy={busy} disabled={!project || disabled} type="submit">
            Run
          </Button>
          <span className="muted small-text">
            Free: the snapshots, the audits and the bridge’s own database.
          </span>
        </div>
      </form>
    </section>
  );
}

// ================================================================================================ report

export function ReportCard({
  project,
  projectId,
  report,
}: {
  project: string | null;
  projectId: string;
  report: AppraisalReportView;
}) {
  const groups = GROUP_ORDER[report.tool];
  const src = report.source.index;
  return (
    <section className="card" aria-labelledby="appraisal-report-h" data-testid="appraisal-report">
      <h2 id="appraisal-report-h">
        {TOOL_LABEL[report.tool]} <span className="muted small-text">· {report.runId}</span>
      </h2>
      <p className="muted small-text">
        {src
          ? `From ${src.base.id}${src.changeSnapshots ? ` plus ${src.changeSnapshots} change snapshot(s)` : ''}; complete as of ${src.newest.takenAt} (${src.age} old).`
          : 'No snapshot.'}{' '}
        Inspected:{' '}
        {Object.entries(report.inspected)
          .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
          .map(([k, v]) => `${k} ${String(v)}`)
          .join(', ')}
        .
        {report.compared &&
          ` Since the last run of this scope (${report.compared.previousRunAt}): ${report.compared.new} new, ${report.compared.still} still present, ${report.compared.gone} gone.`}
      </p>
      {report.couldNotCheck.length > 0 && (
        <div className="note note-warn small-text" data-testid="could-not-check">
          <strong>Could not check:</strong>
          <ul>
            {report.couldNotCheck.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {report.findings.length === 0 && <Empty>Nothing found.</Empty>}
      {report.questions && report.questions.length > 0 && (
        <div className="note small-text" data-testid="split-questions">
          <strong>Questions only you can answer</strong> (the split triggers the bridge cannot measure):
          <ul>
            {report.questions.map((q) => (
              <li key={q.trigger}>
                <strong>{q.trigger}:</strong> {q.question}
              </li>
            ))}
          </ul>
        </div>
      )}
      {groups.map((g) => {
        const list = report.findings.filter((f) => f.group === g.key);
        if (list.length === 0 && g.key === 'blocked') return null;
        return (
          <section key={g.key} aria-label={g.label} data-group={g.key} className="mt">
            <h3>
              {g.label} <span className="muted small-text">({list.length})</span>
            </h3>
            {list.length === 0 ? (
              <p className="muted small-text">None.</p>
            ) : (
              <ul className="findings">
                {list.map((f) => (
                  <FindingRow key={f.id} project={project} projectId={projectId} f={f} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}

function FindingRow({
  project,
  projectId,
  f,
}: {
  project: string | null;
  projectId: string;
  f: AppraisalFindingView;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [note, setNote] = useState<string | null>(null);
  const rule = [f.rule.page, f.rule.section, f.rule.rule].filter(Boolean).join(' › ');
  const propose = async () => {
    if (f.followUp.kind !== 'fix') return;
    const yes = await confirm({
      title: 'Propose this fix?',
      message: (
        <p>
          {f.followUp.change}. The page is read again first (one read); the fix becomes ONE proposal for you
          to approve on the Proposals page. Nothing is changed until you approve it.
        </p>
      ),
      confirmLabel: 'Propose the fix',
    });
    if (!yes) return;
    void run(() =>
      api.post<AppraisalFixResponse>(`/appraisal/findings/${f.id}/propose-fix`, { confirm: true, project }),
    ).then((r) => {
      if (!r) return;
      setNote(
        r.status === 'proposal_captured'
          ? `Proposed (${r.proposalId}). Nothing is changed until you approve it.${r.summary ? ` ${r.summary}` : ''}`
          : r.message,
      );
    });
  };
  return (
    <li className="finding" data-check={f.check} data-finding={f.id}>
      <div>
        <Badge tone={EVIDENCE_TONE[f.evidence] ?? 'neutral'}>{f.evidence}</Badge>{' '}
        {f.page ? (
          <>
            <a
              href={lkPageUrl(projectId, f.page.id)}
              target="_blank"
              rel="noreferrer"
              title="Open in LegendKeeper"
            >
              {f.page.name}
            </a>{' '}
            <span className="muted small-text">{f.page.path}</span>
          </>
        ) : null}
      </div>
      <div>{f.message}</div>
      <div className="muted small-text">
        {f.check} · {rule}
        {f.labels?.lifecycle ? ` · ${f.labels.lifecycle}` : ''}
        {f.source.kind === 'audit' ? ` · from the audit (finding ${f.source.auditFindingId ?? '?'})` : ''}
      </div>
      <div className="row">
        {f.followUp.kind === 'fix' ? (
          <Button busy={busy} disabled={!project} onClick={() => void propose()}>
            Propose a fix
          </Button>
        ) : f.followUp.kind === 'judgement' ? (
          <span className="small-text" data-testid="judgement">
            Judgement: {f.followUp.decide} <span className="muted">({f.followUp.tool})</span>
          </span>
        ) : (
          <span className="muted small-text">{f.followUp.reason}</span>
        )}
      </div>
      <SplitDetails f={f} />
      {note && <div className="note small-text">{note}</div>}
    </li>
  );
}

/**
 * v3 F3e (ADR 0059): a split candidate's draft destination map and its Anti-Fragmentation note (the split appraisal's,
 * and A2's architectural candidates, which carry the same). A suggestion only: splitting is the owner's decision.
 */
function SplitDetails({ f }: { f: AppraisalFindingView }) {
  const d = f.details as {
    trigger?: unknown;
    draftMap?: unknown;
    antiFragmentation?: unknown;
  };
  if (typeof d.trigger !== 'string') return null;
  if (!Array.isArray(d.draftMap))
    return (
      <div className="muted small-text" data-testid="split-pointer">
        Split trigger: {d.trigger}. Run the Split appraisal (A6) on this page for its draft destination map,
        the Anti-Fragmentation note and the questions only you can answer.
      </div>
    );
  const map = d.draftMap as SplitDraftEntry[];
  const notes = Array.isArray(d.antiFragmentation) ? (d.antiFragmentation as string[]) : [];
  const where = (e: SplitDraftEntry) =>
    e.to === 'stays'
      ? 'stays'
      : e.to === 'divide'
        ? 'divide block by block'
        : e.to === 'review'
          ? 'the owner’s call'
          : e.to === 'relationship'
            ? `a relationship owner${typeof e.suggestion?.name === 'string' ? ` (${e.suggestion.name})` : ''}`
            : `a new owner${typeof e.suggestion?.name === 'string' ? ` (${e.suggestion.name})` : typeof e.suggestion?.type === 'string' ? ` (${e.suggestion.type})` : ''}`;
  return (
    <details className="small-text" data-testid="split-details">
      <summary>Draft destination map and Anti-Fragmentation note (a suggestion only)</summary>
      <table className="table small-text">
        <thead>
          <tr>
            <th>Section</th>
            <th>Words</th>
            <th>Might go</th>
          </tr>
        </thead>
        <tbody>
          {map.map((e) => (
            <tr key={e.section} data-to={e.to}>
              <td>{e.section}</td>
              <td>
                {e.words}
                {e.images ? ` · ${e.images} image${e.images === 1 ? '' : 's'}` : ''}
              </td>
              <td>
                {where(e)}
                {e.note ? <div className="muted">{e.note}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 && (
        <div data-testid="anti-fragmentation">
          <strong>Anti-Fragmentation:</strong>
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

// ================================================================================================ runs

function RunsCard({
  project,
  runs,
  now,
  onOpen,
}: {
  project: string | null;
  runs: AppraisalRunView[];
  now: number;
  onOpen: (r: AppraisalReportView) => void;
}) {
  const { run } = useAction();
  const open = (id: string) =>
    void run(() =>
      api.get<{ report: AppraisalReportView }>(
        `/appraisal/runs/${id}?project=${encodeURIComponent(project ?? '')}`,
      ),
    ).then((r) => r && onOpen(r.report));
  return (
    <section className="card table-wrap" aria-labelledby="appraisal-runs-h">
      <h2 id="appraisal-runs-h">Latest runs</h2>
      {runs.length === 0 ? (
        <Empty>No run yet.</Empty>
      ) : (
        <table aria-label="Latest runs">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Scope</th>
              <th>When</th>
              <th>Findings</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <button type="button" className="link" onClick={() => open(r.id)}>
                    {TOOL_LABEL[r.tool] ?? r.tool}
                  </button>
                </td>
                <td className="small-text">
                  {Object.entries(r.scope)
                    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                    .join(' · ') || 'everything'}
                </td>
                <td>{fmtAgo(r.finishedAt, now)}</td>
                <td>{fmtInt(r.counts.total ?? 0)}</td>
                <td>{fmtDuration(r.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
