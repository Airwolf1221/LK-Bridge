import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Json,
  Loading,
  PageHeader,
  StatusBadge,
  useAction,
  useConfirm,
  useToast,
} from '../components';
import { diffBlocks, looksLikeBlocks } from '../diff';
import { fmtAgo, fmtTime, prettyJson } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectReloadOn, useScopedApi } from '../project';
import { useRoute } from '../router';
import type {
  FactsOperation,
  MarkdownDiff,
  Proposal,
  ProposalCounts,
  ProposalDetail,
  ProposalOp,
} from '../types';

type Tab = 'pending' | 'conflicted' | 'history';

export function ProposalsPage() {
  const { query, navigate } = useRoute();
  const tab =
    (['pending', 'conflicted', 'history'] as const).find((t) => t === query.get('tab')) ?? 'pending';
  const openId = query.get('id');
  const { selected } = useProject();
  const list = useScopedApi<{ proposals: Proposal[] }>(`/proposals${qs({ group: tab, limit: 100 })}`);
  const counts = useScopedApi<ProposalCounts>('/proposals/counts');
  const reloadAll = () => {
    list.reload();
    counts.reload();
  };
  useProjectReloadOn(['proposal'], reloadAll, 300);
  const now = useNow();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [tab]);
  const go = (patch: { tab?: Tab; id?: string | null }) =>
    navigate(
      `/proposals${qs({ tab: (patch.tab ?? tab) === 'pending' ? undefined : (patch.tab ?? tab), id: patch.id === undefined ? openId : patch.id })}`,
      { replace: true },
    );

  const c = counts.data?.counts ?? {};
  const tabs: [Tab, string, number | undefined][] = [
    ['pending', 'Pending', c.pending],
    ['conflicted', 'Conflicted', c.conflicted],
    ['history', 'History', undefined],
  ];

  return (
    <>
      <PageHeader title="Proposals" project={selected} />
      <p className="muted">
        Writes that agents at the “propose” scope asked for. Nothing is sent to LegendKeeper until you approve
        it.
      </p>
      <div className="tabs" role="group" aria-label="Which proposals">
        {tabs.map(([t, label, n]) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => go({ tab: t, id: null })}>
            {label}
            {n !== undefined && n > 0 ? ` (${n})` : ''}
          </button>
        ))}
      </div>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {tab === 'pending' && picked.size > 0 && (
        <BulkBar
          ids={[...picked]}
          onDone={() => {
            setPicked(new Set());
            reloadAll();
          }}
        />
      )}
      {!list.data ? (
        <Loading />
      ) : list.data.proposals.length === 0 ? (
        <Empty>
          {tab === 'pending'
            ? 'Nothing is waiting for you.'
            : tab === 'conflicted'
              ? 'No conflicted proposals.'
              : 'No decided proposals yet.'}
        </Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                {tab === 'pending' && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all pending proposals"
                      checked={picked.size === list.data.proposals.length}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked ? new Set(list.data!.proposals.map((p) => p.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                )}
                <th>Proposal</th>
                <th>Proposed by</th>
                <th>State</th>
                <th className="num">Operations</th>
                <th>Proposed</th>
                <th>{tab === 'pending' ? 'Expires' : 'Decided'}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.proposals.map((p) => (
                <tr key={p.id} className={openId === p.id ? 'selected' : ''} data-proposal={p.id}>
                  {tab === 'pending' && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.title || p.id}`}
                        checked={picked.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          setPicked(next);
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <button
                      type="button"
                      className="small"
                      onClick={() => go({ id: openId === p.id ? null : p.id })}
                    >
                      {openId === p.id ? 'Hide' : 'Review'}
                    </button>{' '}
                    {p.title || p.summary}
                    {p.requiresCanonicalApproval && (
                      <>
                        {' '}
                        <Badge tone="warn">canon</Badge>
                      </>
                    )}
                    <div className="muted small-text">{p.summary}</div>
                    {(p.pages ?? []).slice(0, 3).map((l) => (
                      <div key={l} className="small-text">
                        {l}
                      </div>
                    ))}
                  </td>
                  <td>
                    {p.profile}
                    <div className="muted small-text">{p.principalLabel}</div>
                  </td>
                  <td>
                    <StatusBadge status={p.state} />
                  </td>
                  <td className="num">{p.opCount}</td>
                  <td>{fmtAgo(p.createdAt, now)}</td>
                  <td>
                    {tab === 'pending' ? fmtTime(p.expiresAt) : fmtAgo(p.decidedAt ?? p.updatedAt, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ProposalReview id={openId} onChanged={reloadAll} onClose={() => go({ id: null })} />}
    </>
  );
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [reason, setReason] = useState('');
  type Result = { id: string; ok: boolean; state?: string; error?: { message: string } };
  const { withProject } = useProject();
  const act = (action: 'approve' | 'reject') =>
    run(() =>
      api.post<{ results: Result[] }>(withProject('/proposals/bulk'), {
        action,
        ids,
        ...(action === 'reject' && reason ? { reason } : {}),
      }),
    ).then((r) => {
      if (r) {
        const bad = r.results.filter((x) => !x.ok);
        if (bad.length > 0)
          toast(
            'error',
            `${bad.length} of ${r.results.length} could not be ${action === 'approve' ? 'approved' : 'rejected'}: ${bad.map((b) => b.error?.message ?? b.state).join('; ')}`,
          );
        else toast('ok', `${r.results.length} ${action === 'approve' ? 'approved' : 'rejected'}.`);
      }
      onDone();
    });
  return (
    <div className="card" role="group" aria-label="Bulk actions">
      <div className="row">
        <strong>{ids.length} selected</strong>
        <Button
          variant="primary"
          busy={busy}
          onClick={() => {
            void confirm({
              title: `Approve ${ids.length} proposal${ids.length === 1 ? '' : 's'}?`,
              message: (
                <p>
                  Each one is checked against LegendKeeper again, then run one at a time. A proposal whose
                  targets have changed becomes conflicted and runs nothing. A proposal that touches protected
                  canon is not approved here: open it and use “Approve and accept as canon”.
                </p>
              ),
              confirmLabel: 'Approve all',
            }).then((ok) => {
              if (ok) void act('approve');
            });
          }}
        >
          Approve selected
        </Button>
        <label className="inline" htmlFor="bulk-reason">
          Reason
        </label>
        <input
          id="bulk-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Shown to the agent (optional)"
        />
        <Button
          variant="danger"
          busy={busy}
          onClick={() => {
            void confirm({
              title: `Reject ${ids.length} proposal${ids.length === 1 ? '' : 's'}?`,
              message: <p>Nothing is sent to LegendKeeper. The agents can read your reason.</p>,
              confirmLabel: 'Reject all',
              danger: true,
            }).then((ok) => {
              if (ok) void act('reject');
            });
          }}
        >
          Reject selected
        </Button>
      </div>
    </div>
  );
}

export function ChangeView({ change }: { change: { path: string; before: unknown; after: unknown } }) {
  const blocks = looksLikeBlocks(change.before) || looksLikeBlocks(change.after);
  const lines = useMemo(() => (blocks ? diffBlocks(change.before, change.after) : []), [blocks, change]);
  return (
    <div className="change" data-path={change.path}>
      <h4 className="mono">{change.path || 'whole value'}</h4>
      {blocks ? (
        <div className="diff" role="group" aria-label={`Changes to ${change.path || 'content'}`}>
          {lines.map((l, i) => (
            <div
              key={i}
              className={`diff-line ${l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}`}
              data-kind={l.kind}
            >
              <span
                className="diff-mark"
                aria-label={l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : 'unchanged'}
              >
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="before-after">
          <div className="before">
            <strong>Before</strong>
            <pre>{typeof change.before === 'string' ? change.before : prettyJson(change.before)}</pre>
          </div>
          <div className="after">
            <strong>After</strong>
            <pre>{typeof change.after === 'string' ? change.after : prettyJson(change.after)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** v2 C1: a page write's Markdown diff, in hunks; keep regions are one labelled placeholder line each. */
export function MarkdownDiffView({ diff, title }: { diff: MarkdownDiff; title: string }) {
  return (
    <div className="change" data-path="markdown">
      <h4>{title}</h4>
      <p className="muted small-text">
        {diff.added} line{diff.added === 1 ? '' : 's'} added, {diff.removed} removed. Lines in square brackets
        are keep regions: blocks Markdown cannot show, kept exactly as they are unless the agent dropped them.
        {diff.coarse
          ? ' The page is too large to align line by line here, so the changed part is shown whole.'
          : ''}
      </p>
      {diff.hunks.length === 0 ? (
        <p className="muted">No change to the page’s text.</p>
      ) : (
        diff.hunks.map((h, i) => (
          <div key={i} className="diff" role="group" aria-label={`Markdown changes, part ${i + 1}`}>
            <div className="diff-line muted mono small-text">
              Lines {h.beforeStart}–{h.beforeStart + Math.max(0, h.beforeLines - 1)} before, {h.afterStart}–
              {h.afterStart + Math.max(0, h.afterLines - 1)} after
            </div>
            {h.lines.map((l, j) => (
              <div
                key={j}
                className={`diff-line ${l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}`}
                data-kind={l.kind}
              >
                <span
                  className="diff-mark"
                  aria-label={l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : 'unchanged'}
                >
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                </span>
                <span className="mono">{l.text}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** v2 C1: what a high-level page write asks for, and its Markdown diff. */
function PageWriteView({ p }: { p: ProposalDetail }) {
  const o = p.operationDetail;
  if (!o || (o.tool !== undefined && o.tool !== 'write_page')) return null;
  return (
    <section className="card" aria-label="Page write">
      <div className="row row-between">
        <h3>
          <span className="mono">{o.tool ?? 'write'}</span>: {o.mode}
          {o.section ? <> of “{o.section}”</> : null} on <strong>{o.page?.name ?? o.page?.id}</strong>
          {o.document?.name ? <span className="muted"> ({o.document.name})</span> : null}
        </h3>
        {o.plannedOn && <span className="muted small-text mono">planned on {o.plannedOn}</span>}
      </div>
      {o.counts && (
        <p className="small-text">
          Blocks: {o.counts.kept ?? 0} kept, {o.counts.changed ?? 0} changed, {o.counts.added ?? 0} added,{' '}
          {o.counts.removed ?? 0} removed. Keep regions: {o.counts.regionsKept ?? 0} kept
          {o.counts.regionsDropped ? `, ${o.counts.regionsDropped} dropped` : ''}.
        </p>
      )}
      {o.dropRegions && o.dropRegions.length > 0 && (
        <p className="note note-warn">
          The agent deliberately removes these keep regions:{' '}
          <span className="mono">{o.dropRegions.join(', ')}</span>.
        </p>
      )}
      <p className="muted small-text">
        Approving runs exactly this change. If the page has changed since it was planned, the proposal becomes
        conflicted instead and nothing is written.
      </p>
      {p.markdownDiff && (
        <MarkdownDiffView diff={p.markdownDiff} title="Markdown diff (the page before and after)" />
      )}
      {p.execution && (
        <p className={`note ${p.execution.verified === false ? 'note-bad' : ''}`} role="status">
          {p.execution.verified === true
            ? 'Written and verified: the page read back after the write is exactly what was planned.'
            : p.execution.verified === false
              ? 'Written but not as planned: the page read back after the write differs (see the job). The journal holds the page as it was before.'
              : 'Written; the page could not be read back to verify it.'}
        </p>
      )}
      {o.markdown !== undefined && (
        <details>
          <summary className="small-text">The agent’s Markdown</summary>
          <pre>{o.markdown}</pre>
        </details>
      )}
    </section>
  );
}

/** v2 C2a: the proposal's operations grouped by the page they affect, shown first. */
function PageSummaryView({ p }: { p: ProposalDetail }) {
  const pages = p.pageSummary ?? [];
  if (pages.length === 0) return null;
  return (
    <section className="card" aria-label="Pages affected">
      <h3>Pages affected</h3>
      <ul className="plain">
        {pages.map((e) => (
          <li key={`${e.resourceId ?? ''}:${e.page}`} data-page={e.resourceId ?? ''}>
            <strong>{e.page}</strong>: {e.parts.join(', ')}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** v2 C2a: the banner of a proposal that touches protected canon. */
function CanonBanner({ p }: { p: ProposalDetail }) {
  if (!p.requiresCanonicalApproval) return null;
  const changes = p.canonical?.changes ?? [];
  return (
    <div className="note note-warn" role="alert" aria-label="Protected canon">
      <strong>This changes protected canon.</strong> It can only be approved with “Approve and accept as
      canon”, a separate decision that is recorded with your name; the ordinary Approve is not available for
      it.
      {changes.length > 0 && (
        <ul>
          {changes.map((c, i) => (
            <li key={i}>
              {c.page ? <strong>{c.page}: </strong> : null}
              {c.text ?? c.unchecked ?? JSON.stringify(c)}
            </li>
          ))}
        </ul>
      )}
      {p.canonicalApprovedBy && (
        <p className="small-text">
          Accepted as canon by {p.canonicalApprovedBy}
          {p.canonicalApprovedAt ? ` on ${fmtTime(p.canonicalApprovedAt)}` : ''}.
        </p>
      )}
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  added: 'added',
  changed: 'changed',
  removed: 'removed',
  unchanged: 'no change',
  not_present: 'not there',
};

/** v2 C2a: a set_facts proposal: the facts before and after, and the links added and removed. */
function FactsView({ o, execution }: { o: FactsOperation; execution: ProposalDetail['execution'] }) {
  const facts = o.facts ?? [];
  const name = (l: { name: string; document?: string }) =>
    l.document ? `${l.name} / ${l.document}` : l.name;
  return (
    <section className="card" aria-label="Facts and links">
      <h3>
        <span className="mono">set_facts</span> on <strong>{o.page?.name ?? o.page?.id}</strong>
        {o.property ? <span className="muted"> ({o.property})</span> : null}
      </h3>
      {facts.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Facts before and after">
            <thead>
              <tr>
                <th>Fact</th>
                <th>Before</th>
                <th>After</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => (
                <tr key={f.key} data-fact={f.key} data-change={f.change}>
                  <td>{f.key}</td>
                  <td className={f.change === 'removed' || f.change === 'changed' ? 'diff-del' : ''}>
                    {f.before ?? <span className="muted">—</span>}
                  </td>
                  <td className={f.change === 'added' || f.change === 'changed' ? 'diff-add' : ''}>
                    {f.after ?? <span className="muted">—</span>}
                  </td>
                  <td>{CHANGE_LABEL[f.change] ?? f.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(o.links ?? []).map((l) => (
        <div key={l.title} className="mt" aria-label={`Links: ${l.title}`} role="group">
          <h4>{l.title}</h4>
          {l.added.length > 0 && (
            <p className="small-text">
              <strong>Added:</strong> {l.added.map(name).join(', ')}
            </p>
          )}
          {l.removed.length > 0 && (
            <p className="small-text">
              <strong>Removed:</strong> {l.removed.map(name).join(', ')}
            </p>
          )}
          {l.alreadyLinked.length > 0 && (
            <p className="muted small-text">Already linked: {l.alreadyLinked.map(name).join(', ')}</p>
          )}
          {l.filtered && <p className="muted small-text">The collection’s filter is kept as it is.</p>}
        </div>
      ))}
      {(o.notes ?? []).map((n) => (
        <p key={n} className="note small-text">
          {n}
        </p>
      ))}
      <p className="muted small-text">
        Approving runs exactly this change: the sidebar is checked again inside the page’s lock, and if it has
        changed since this was planned, nothing is written.
      </p>
      {execution && (
        <p className={`note ${execution.verified === false ? 'note-bad' : ''}`} role="status">
          {execution.verified === true
            ? 'Written and verified: the sidebar read back after the writes is exactly what was planned.'
            : execution.verified === false
              ? 'Written but not as planned: the sidebar read back after the writes differs (see the job). The journal holds what each write changed.'
              : 'Written; the sidebar could not be read back to verify it.'}
        </p>
      )}
    </section>
  );
}

function OpView({ op, conflict }: { op: ProposalOp; conflict: ProposalDetail['conflict'] }) {
  const isConflict = conflict?.index === op.index;
  return (
    <section
      className={`card ${isConflict ? 'conflict' : ''}`}
      aria-label={`Operation ${op.index + 1}: ${op.op}`}
    >
      <div className="row row-between">
        <h3>
          {op.index + 1}. <span className="mono">{op.op}</span>
        </h3>
        <span className="row">
          <Badge>{op.opKind}</Badge>
          {isConflict && <Badge tone="bad">changed since proposed</Badge>}
          {op.targetExists === false && <Badge>new</Badge>}
          {op.version && <span className="muted small-text mono">captured at {op.version}</span>}
        </span>
      </div>
      {op.unsupportedLoss.length > 0 && (
        <p className="note note-bad" role="alert">
          This would remove {op.unsupportedLoss.length} block{op.unsupportedLoss.length === 1 ? '' : 's'} the
          bridge cannot represent ({op.unsupportedLoss.join(', ')}). The agent explicitly allowed the loss.
        </p>
      )}
      {op.preStateTruncated && (
        <p className="note note-warn">The captured state was too large to keep, so no diff is shown.</p>
      )}
      {op.changes.length === 0 && !op.preStateTruncated ? (
        <p className="muted">No change from the captured state.</p>
      ) : (
        op.changes.map((c) => <ChangeView key={c.path} change={c} />)
      )}
      <details>
        <summary className="small-text">Parameters as sent</summary>
        <Json value={op.params} />
      </details>
    </section>
  );
}

function ProposalReview({
  id,
  onChanged,
  onClose,
}: {
  id: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { withProject } = useProject();
  const d = useScopedApi<{ proposal: ProposalDetail }>(`/proposals/${encodeURIComponent(id)}`);
  useProjectReloadOn(['proposal'], d.reload, 300);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const p = d.data?.proposal;
  const done = () => {
    onChanged();
    d.reload();
  };
  return (
    <section className="card mt" aria-label="Proposal review">
      <div className="row row-between">
        <h2>Review</h2>
        <button type="button" className="small" onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorNote error={d.error} onRetry={d.reload} />
      {!p ? (
        !d.error && <Loading />
      ) : (
        <>
          <div className="row">
            <StatusBadge status={p.state} />
            <span>
              Proposed by <strong>{p.profile}</strong> <span className="muted">({p.principalLabel})</span>
            </span>
            <span className="muted small-text">{fmtTime(p.createdAt)}</span>
          </div>
          <p>{p.summary}</p>
          {p.state === 'conflicted' && p.conflict && (
            <p className="note note-bad" role="alert">
              <strong>Operation {p.conflict.index + 1}</strong> (<span className="mono">{p.conflict.op}</span>
              ) changed in LegendKeeper after it was proposed: {p.conflict.reason}
              {p.conflict.capturedVersion && p.conflict.currentVersion && (
                <>
                  {' '}
                  (captured at {p.conflict.capturedVersion}, now {p.conflict.currentVersion})
                </>
              )}
              . Nothing was run. You can only reject it; the agent can propose again from the current content.
            </p>
          )}
          {p.state === 'rejected' && p.rejectReason && <p className="note">Rejected: {p.rejectReason}</p>}
          {p.state === 'failed' && p.error && (
            <p className="note note-bad">
              It failed: {typeof p.error.message === 'string' ? p.error.message : JSON.stringify(p.error)}
            </p>
          )}
          <PageSummaryView p={p} />
          <CanonBanner p={p} />
          <PageWriteView p={p} />
          {(p.operations ?? [])
            .filter((o) => o.tool === 'set_facts')
            .map((o, i) => (
              <FactsView key={i} o={o as unknown as FactsOperation} execution={p.execution ?? null} />
            ))}
          {p.ops.map((op) => (
            <OpView key={op.index} op={op} conflict={p.conflict} />
          ))}

          {(p.state === 'pending' || p.state === 'conflicted') && (
            <div className="stack">
              <div className="row">
                {p.state === 'pending' && p.requiresCanonicalApproval && (
                  <>
                    <Button
                      variant="primary"
                      busy={busy}
                      onClick={() => {
                        void confirm({
                          title: 'Approve and accept as canon?',
                          message: (
                            <>
                              <p>
                                This makes a change to <strong>protected canon</strong>. Approving it accepts
                                the result as canon, and the decision is recorded with your name.
                              </p>
                              <ul>
                                {(p.canonical?.changes ?? []).map((c, i) => (
                                  <li key={i}>{c.text ?? c.unchecked}</li>
                                ))}
                              </ul>
                              <p className="muted small-text">{p.summary}</p>
                            </>
                          ),
                          confirmLabel: 'Approve and accept as canon',
                        }).then((ok) => {
                          if (ok)
                            void run(
                              () =>
                                api.post(
                                  withProject(`/proposals/${encodeURIComponent(p.id)}/approve-as-canon`),
                                  { confirm: true },
                                ),
                              'Approved and accepted as canon.',
                            ).then(done);
                        });
                      }}
                    >
                      Approve and accept as canon
                    </Button>
                    <Button disabled title="This change touches protected canon">
                      Approve
                    </Button>
                  </>
                )}
                {p.state === 'pending' && !p.requiresCanonicalApproval && (
                  <Button
                    variant="primary"
                    busy={busy}
                    onClick={() => {
                      void confirm({
                        title: 'Approve and run this?',
                        message: (
                          <>
                            <p>
                              {p.ops.length} operation{p.ops.length === 1 ? '' : 's'} will be sent to
                              LegendKeeper as <strong>{p.profile}</strong>, after LegendKeeper is checked once
                              more for changes.
                            </p>
                            <p className="muted small-text">{p.summary}</p>
                          </>
                        ),
                        confirmLabel: 'Approve',
                      }).then((ok) => {
                        if (ok)
                          void run(
                            () => api.post(withProject(`/proposals/${encodeURIComponent(p.id)}/approve`)),
                            'Approved.',
                          ).then(done);
                      });
                    }}
                  >
                    Approve
                  </Button>
                )}
                {!rejecting && (
                  <Button variant="danger" onClick={() => setRejecting(true)}>
                    Reject…
                  </Button>
                )}
              </div>
              {rejecting && (
                <div>
                  <label htmlFor="reject-reason">Reason (the agent can read it)</label>
                  <textarea
                    id="reject-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={1000}
                  />
                  <div className="row mt">
                    <Button
                      variant="danger"
                      busy={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api.post(
                              withProject(`/proposals/${encodeURIComponent(p.id)}/reject`),
                              reason ? { reason } : {},
                            ),
                          'Rejected.',
                        ).then((r) => {
                          if (r) setRejecting(false);
                          done();
                        })
                      }
                    >
                      Confirm rejection
                    </Button>
                    <Button onClick={() => setRejecting(false)}>Keep it</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
