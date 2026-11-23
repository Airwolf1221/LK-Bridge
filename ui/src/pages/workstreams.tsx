import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction } from '../components';
import { fmtAgo } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useProjectReloadOn, useScopedApi } from '../project';
import { Link } from '../router';
import type { WorkstreamReport, WorkstreamRow, WorkstreamsPayload } from '../types';

/**
 * v3 F5c (ADR 0069, H8): the Workstreams page. Each workstream label agents worked under (the `workstream` argument of
 * their writes, or the default set with `bridge_workstream`): who worked under it, when, and what came of it, each
 * linking to its report (the one `bridge_workstream_report` gives). Read-only and free.
 */
export function WorkstreamsPage() {
  const { selected } = useProject();
  const data = useScopedApi<WorkstreamsPayload>('/workstreams');
  useProjectReloadOn(['job', 'proposal'], data.reload, 2000);
  const api = useProjectApi();
  const { run, busy } = useAction();
  const now = useNow(30_000);
  const [open, setOpen] = useState<{ label: string; report: WorkstreamReport } | null>(null);

  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const rows = data.data.workstreams;

  const show = (label: string) =>
    run(() =>
      api.get<{ report: WorkstreamReport }>(`/workstreams/report?workstream=${encodeURIComponent(label)}`),
    ).then((r) => {
      if (r) setOpen({ label, report: r.report });
    });

  return (
    <>
      <PageHeader title="Workstreams" project={selected} />
      <p className="muted">
        A workstream groups the writes and proposals of one maintenance objective, as the agent labelled them.
        Its report lists what was written and verified, what is accepted but not yet run, what was deliberately
        left out, what waits for your judgement and what still looks inconsistent. Nothing here reads
        LegendKeeper.
      </p>
      <section className="card" aria-labelledby="ws-h">
        <h2 id="ws-h">Workstreams</h2>
        {rows.length === 0 ? (
          <Empty>No workstream yet: agents label their work with the workstream argument.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Workstream</th>
                  <th scope="col">Principal</th>
                  <th scope="col">First activity</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Counts</th>
                  <th scope="col">Report</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <Row key={w.workstream} w={w} now={now} busy={busy} onShow={() => void show(w.workstream)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <ReportView label={open.label} report={open.report} onClose={() => setOpen(null)} />}
    </>
  );
}

function Row(props: { w: WorkstreamRow; now: number; busy: boolean; onShow: () => void }) {
  const { w } = props;
  return (
    <tr data-workstream={w.workstream}>
      <th scope="row">{w.workstream}</th>
      <td>{w.principals.map((p) => p.name ?? p.id).join(', ') || '—'}</td>
      <td>{w.first ? fmtAgo(Date.parse(w.first), props.now) : '—'}</td>
      <td>{w.last ? fmtAgo(Date.parse(w.last), props.now) : '—'}</td>
      <td>
        {w.jobs} job{w.jobs === 1 ? '' : 's'}, {w.pages} page{w.pages === 1 ? '' : 's'} written
        {w.proposals > 0 ? `, ${w.proposals} proposal${w.proposals === 1 ? '' : 's'}` : ''}
        {w.awaitingOwner > 0 && (
          <>
            {' '}
            <Badge tone="info">{w.awaitingOwner} awaiting you</Badge>
          </>
        )}
        {w.unknownOutcomes > 0 && (
          <>
            {' '}
            <Badge tone="warn">{w.unknownOutcomes} unknown outcome</Badge>
          </>
        )}
        {w.failedJobs > 0 && (
          <>
            {' '}
            <Badge tone="bad">{w.failedJobs} failed</Badge>
          </>
        )}
      </td>
      <td>
        <Button onClick={props.onShow} busy={props.busy} aria-label={`Report of ${w.workstream}`}>
          Report
        </Button>
      </td>
    </tr>
  );
}

function ReportView(props: { label: string; report: WorkstreamReport; onClose: () => void }) {
  const r = props.report;
  const g = r.groups;
  const res = g.residualInconsistencies;
  return (
    <section className="card mt" aria-labelledby="report-h" data-testid="workstream-report">
      <h2 id="report-h">Report: {props.label}</h2>
      <p className="muted small-text">{r.cost}</p>
      <h3>Still to do</h3>
      {r.stillToDo.length === 0 ? (
        <p>Nothing: every change was written and verified, and nothing waits.</p>
      ) : (
        <ul>
          {r.stillToDo.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      <h3>Written and verified ({g.writtenAndVerified.length} pages)</h3>
      <ul className="plain">
        {g.writtenAndVerified.map((p) => (
          <li key={p.page.id}>
            <Badge tone={p.verified === true ? 'ok' : p.verified === false ? 'bad' : 'neutral'}>
              {p.verified === true ? 'verified' : p.verified === false ? 'differs' : 'not checked'}
            </Badge>{' '}
            {p.page.name ?? p.page.id}: {p.writes.length} write{p.writes.length === 1 ? '' : 's'} (
            {p.writes
              .map((w) => `${w.what ?? w.op}${w.versionAfter ? ` → ${w.versionAfter}` : ''}`)
              .slice(0, 4)
              .join('; ')}
            )
          </li>
        ))}
      </ul>
      <h3>Accepted but not yet run ({g.acceptedNotYetRun.length})</h3>
      <Lines items={g.acceptedNotYetRun} />
      <h3>Deliberately excluded ({g.deliberatelyExcluded.length})</h3>
      <Lines items={g.deliberatelyExcluded} />
      <h3>Awaiting your judgement ({g.awaitingJudgement.length})</h3>
      <Lines items={g.awaitingJudgement} />
      <p>
        <Link to="/proposals">Proposals</Link> · <Link to="/review">Review</Link>
      </p>
      <h3>Residual inconsistencies</h3>
      <ul>
        <li>{res.unknownOutcomes.length} write(s) whose outcome was unknown</li>
        <li>{res.verificationMismatches.length} read-back(s) that differed</li>
        <li>{res.failedJobs.length} failed or cancelled job(s)</li>
        <li>{res.openFindings.length} audit finding(s) still open on the pages touched</li>
        <li>{res.consistencyFollowUps.length} consistency follow-up(s)</li>
      </ul>
      <Button onClick={props.onClose}>Close the report</Button>
    </section>
  );
}

function Lines(props: { items: readonly Record<string, unknown>[] }) {
  if (props.items.length === 0) return <p className="muted">None.</p>;
  return (
    <ul>
      {props.items.map((x, i) => (
        <li key={i}>
          {String(x.kind ?? '')}
          {x.title ? `: ${String(x.title)}` : ''}
          {x.character ? `: ${String(x.character)}` : ''}
          {x.label ? `: ${String(x.label)}` : ''}
          {x.why ? ` (${String(x.why)})` : ''}
          {x.state ? ` [${String(x.state)}]` : x.status ? ` [${String(x.status)}]` : ''}
        </li>
      ))}
    </ul>
  );
}
