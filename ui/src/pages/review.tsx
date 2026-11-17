/**
 * v3 F3.4 (ADR 0055 decision A): Review. At scope `write` an agent's ordinary changes go straight through, so this page
 * lists them afterwards: every job an agent ran directly, newest first, with the agent, the tool, the summary its
 * proposal would have shown and the pages it touched, each expandable to its diff. Mark reviewed (one, or all of the
 * filtered set, confirmed), or Revert (decision B: the shared `RevertButton`, also on the Jobs page). Approved proposals
 * are never listed: the owner saw them before they happened.
 */
import { useState } from 'react';
import { api, qs } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  StatusBadge,
  useAction,
  useConfirm,
  useToast,
} from '../components';
import { fmtAgo, fmtTime, prettyJson } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectReloadOn, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import { Link } from '../router';
import type {
  ReviewChange,
  ReviewDetail,
  ReviewItem,
  ReviewResponse,
  RevertPreview,
  RevertTarget,
} from '../types';
import { MarkdownDiffView } from './proposals';

const STATE_TEXT: Record<RevertTarget['state'], string> = {
  ready: 'will be put back',
  changed: 'changed since: not reverted',
  gone: 'gone: not reverted',
  not_revertible: 'not reverted',
  nothing_to_do: 'already as it was',
};

const STATE_TONE: Record<RevertTarget['state'], 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ready: 'ok',
  changed: 'bad',
  gone: 'bad',
  not_revertible: 'warn',
  nothing_to_do: 'neutral',
};

const show = (v: unknown) =>
  v === null || v === undefined ? '(none)' : typeof v === 'string' ? v : prettyJson(v);

/**
 * Revert a finished direct-write job (owner): reads what a revert would do now (each target read live), asks for
 * confirmation (and, when some targets would not be reverted, a deliberate yes to a partial revert), then the owner's
 * password (re-authentication), and submits ONE revert job.
 */
export function RevertButton({
  jobId,
  project,
  onDone,
  className,
}: {
  jobId: string;
  project: string | null;
  onDone?: () => void;
  className?: string;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const withReauth = useReauth();
  const { withProject } = useProject();
  const start = async () => {
    const r = await run(() =>
      api.get<{ preview: RevertPreview }>(withProject(`/jobs/${encodeURIComponent(jobId)}/revert`, project)),
    );
    if (!r) return;
    const p = r.preview;
    if (!p.eligible.ok) {
      toast('error', p.eligible.message);
      return;
    }
    if (p.ready === 0) {
      const why = p.targets.filter((t) => t.state !== 'nothing_to_do');
      toast(
        'error',
        why.length === 0
          ? 'Everything this job changed is already as it was before it.'
          : `Nothing of this job can be reverted: ${why.map((t) => `${t.what} (${t.detail})`).join('; ')}`,
      );
      return;
    }
    const partial = p.notReverted > 0;
    const ok = await confirm({
      title: partial ? 'Revert part of this job?' : 'Revert this job?',
      message: (
        <>
          <p>
            Each target is checked again inside the revert job before anything is written; an outside edit is
            never overwritten. The journal and the snapshots keep everything as it was.
          </p>
          <ul className="revert-targets">
            {p.targets.map((t) => (
              <li key={t.key} data-state={t.state}>
                <Badge tone={STATE_TONE[t.state]}>{STATE_TEXT[t.state]}</Badge>{' '}
                <strong>{t.page?.name ?? t.page?.id ?? 'no page'}</strong>: {t.what}
                <span className="muted small-text"> ({t.detail})</span>
                {t.instead && <span className="small-text"> Use {t.instead}.</span>}
                {t.differences && t.differences.length > 0 && (
                  <ul className="small-text">
                    {t.differences.slice(0, 5).map((d, i) => (
                      <li key={i}>
                        <span className="mono">{d.path}</span>: the job left {show(d.expected)}, now{' '}
                        {show(d.actual)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: partial ? 'Revert the rest' : 'Revert',
      danger: true,
      ...(partial
        ? {
            acknowledge: `${p.notReverted} of ${p.targets.length} cannot be reverted. Revert the other ${p.ready} anyway (a partial revert).`,
          }
        : {}),
    });
    if (!ok) return;
    const done = await run(
      () =>
        withReauth(() =>
          api.post<{ revert: { revertJobId: string; message: string } }>(
            withProject(`/jobs/${encodeURIComponent(jobId)}/revert`, project),
            // CR-2026-11-R2 (R2-23): a partial revert names the targets the owner confirmed; refused if they changed.
            partial
              ? {
                  confirm: true,
                  confirmPartial: true,
                  confirmed: p.targets.filter((t) => t.state === 'ready').map((t) => t.key),
                }
              : { confirm: true, confirmPartial: false },
          ),
        ),
      'Revert submitted.',
    );
    if (done) onDone?.();
  };
  return (
    <Button className={className ?? 'small'} variant="danger" busy={busy} onClick={() => void start()}>
      Revert…
    </Button>
  );
}

function ChangeBody({ c }: { c: ReviewChange }) {
  return (
    <div className="review-change" data-kind={c.kind}>
      <h4>
        {c.what}
        {c.uncertain && (
          <>
            {' '}
            <Badge tone="warn">outcome unknown</Badge>
          </>
        )}
      </h4>
      {c.markdownDiff && (
        <MarkdownDiffView
          diff={c.markdownDiff}
          title={c.document?.name ? `Text of “${c.document.name}”` : 'Text'}
        />
      )}
      {c.facts && c.facts.length > 0 && (
        <table className="facts">
          <thead>
            <tr>
              <th>Fact</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {c.facts.map((f, i) => (
              <tr key={i}>
                <td>{f.key}</td>
                <td>{f.before ?? <span className="muted">(none)</span>}</td>
                <td>{f.after ?? <span className="muted">(removed)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.links?.map((l) => (
        <p key={l.title} className="small-text">
          <strong>{l.title}</strong>
          {l.added.length > 0 && <> · added {l.added.map((x) => x.name ?? x.id).join(', ')}</>}
          {l.removed.length > 0 && <> · removed {l.removed.map((x) => x.name ?? x.id).join(', ')}</>}
        </p>
      ))}
      {c.fields && c.fields.length > 0 && (
        <dl className="meta">
          {c.fields.map((f, i) => (
            <div key={i}>
              <dt>{f.field}</dt>
              <dd>
                {show(f.before)} → {show(f.after)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {c.notRevertible && (
        <p className="note small-text">
          Revert does not put this back: {c.notRevertible.reason}
          {c.notRevertible.journal.length > 0 && <> (journal entries {c.notRevertible.journal.join(', ')})</>}
          .
        </p>
      )}
    </div>
  );
}

function ItemDetail({ jobId }: { jobId: string }) {
  const d = useScopedApi<{ item: ReviewDetail }>(`/review/${encodeURIComponent(jobId)}`);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const item = d.data.item;
  return (
    <div className="review-detail">
      {item.pageChanges.length === 0 && (
        <p className="muted">The journal no longer holds this job’s changes.</p>
      )}
      {item.pageChanges.map((g, i) => (
        <section key={g.page?.id ?? `none-${i}`} className="review-page">
          <h3>{g.page ? (g.page.name ?? g.page.id) : 'Not on a page'}</h3>
          {g.changes.map((c) => (
            <ChangeBody key={c.key} c={c} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ItemRow({ item, onChanged }: { item: ReviewItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { run, busy } = useAction();
  const { selected, withProject } = useProject();
  const now = useNow(30_000);
  return (
    <li className="review-item card" data-job={item.jobId}>
      <div className="row row-between">
        <div>
          <p>
            <strong>{item.summary}</strong>
            {item.agentTitle && (
              <span className="muted small-text" title="The title the agent gave this job (its own words)">
                {' '}
                · agent’s title: {item.agentTitle}
              </span>
            )}
          </p>
          <p className="muted small-text">
            {item.agent.name} ({item.agent.profile}) · {item.tool ?? 'a tool'} ·{' '}
            <span title={fmtTime(item.createdAt)}>{fmtAgo(item.createdAt, now)}</span> ·{' '}
            <Link to={`/jobs/${encodeURIComponent(item.jobId)}`}>job {item.jobId}</Link>
          </p>
          {item.pages.length > 0 && (
            <p className="small-text">Pages: {item.pages.map((p) => p.name ?? p.id).join(', ')}</p>
          )}
        </div>
        <div className="row">
          {item.status !== 'succeeded' && <StatusBadge status={item.status} />}
          {item.reviewed && (
            <Badge tone="ok">{item.reviewed.via === 'revert' ? 'reverted' : 'reviewed'}</Badge>
          )}
          {item.revert && item.revert.state !== 'succeeded' && (
            <Badge tone={item.revert.state === 'submitted' ? 'warn' : 'bad'}>
              revert {item.revert.state}
            </Badge>
          )}
        </div>
      </div>
      <div className="row">
        <Button className="small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide the changes' : 'Show the changes'}
        </Button>
        {!item.reviewed && (
          <Button
            className="small"
            busy={busy}
            onClick={() =>
              void run(
                () => api.post(withProject('/review/mark', selected), { ids: [item.jobId] }),
                'Marked reviewed.',
              ).then(onChanged)
            }
          >
            Mark reviewed
          </Button>
        )}
        {(!item.revert || item.revert.state === 'failed' || item.revert.state === 'cancelled') && (
          <RevertButton jobId={item.jobId} project={selected} onDone={onChanged} />
        )}
      </div>
      {open && <ItemDetail jobId={item.jobId} />}
    </li>
  );
}

export function ReviewPage() {
  const { selected, withProject } = useProject();
  const [state, setState] = useState<'unreviewed' | 'reviewed' | 'all'>('unreviewed');
  const [profile, setProfile] = useState('');
  const [tool, setTool] = useState('');
  const r = useScopedApi<ReviewResponse>(
    `/review${qs({ state, ...(profile ? { profile } : {}), ...(tool ? { tool } : {}) })}`,
  );
  useProjectReloadOn(['job', 'policy', 'proposal'], r.reload, 800);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const data = r.data;
  const markAll = async () => {
    if (!data) return;
    const n = state === 'unreviewed' ? data.counts.matching : data.counts.unreviewed;
    // CR-2026-11-R2 (R2-09): the set the owner confirms, exactly (a changed set under the same count is refused).
    const fingerprint = state === 'unreviewed' ? data.markAll?.fingerprint : undefined;
    const ok = await confirm({
      title: `Mark ${n} item${n === 1 ? '' : 's'} reviewed?`,
      message: (
        <p>
          Every unreviewed direct write{profile ? ` by ${profile}` : ''}
          {tool ? ` made with ${tool}` : ''} is marked reviewed. Nothing in LegendKeeper changes.
        </p>
      ),
      confirmLabel: 'Mark all reviewed',
    });
    if (!ok) return;
    await run(
      () =>
        api.post(withProject('/review/mark-all', selected), {
          filter: { ...(profile ? { profile } : {}), ...(tool ? { tool } : {}) },
          expect: n,
          ...(fingerprint ? { fingerprint } : {}),
          confirm: true,
        }),
      'Marked reviewed.',
    );
    r.reload();
  };
  return (
    <>
      <PageHeader title="Review" project={selected}>
        <span className="muted small-text">Agents’ direct writes at scope write, to look at afterwards</span>
      </PageHeader>
      <section className="card">
        <div className="row">
          <label htmlFor="review-state">Show</label>
          <select id="review-state" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            <option value="unreviewed">Unreviewed</option>
            <option value="reviewed">Reviewed</option>
            <option value="all">All</option>
          </select>
          <label htmlFor="review-agent">Agent</label>
          <select id="review-agent" value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">Every agent</option>
            {data?.facets.profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label htmlFor="review-tool">Tool</label>
          <select id="review-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">Every tool</option>
            {data?.facets.tools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {state === 'unreviewed' && (data?.counts.matching ?? 0) > 0 && (
            <Button busy={busy} onClick={() => void markAll()}>
              Mark all reviewed ({data!.counts.matching})
            </Button>
          )}
        </div>
        <p className="muted small-text">
          Proposals you approved are not listed (you saw them before they happened); nor are canon and
          lifecycle changes, which are always proposals.
        </p>
      </section>
      <ErrorNote error={r.error} onRetry={r.reload} />
      {!data ? (
        !r.error && <Loading />
      ) : data.items.length === 0 ? (
        <Empty>
          {state === 'unreviewed'
            ? 'Nothing to review: no unreviewed direct writes.'
            : 'No direct writes here.'}
        </Empty>
      ) : (
        <ul className="review-list" role="list">
          {data.items.map((item) => (
            <ItemRow key={item.jobId} item={item} onChanged={r.reload} />
          ))}
        </ul>
      )}
    </>
  );
}
