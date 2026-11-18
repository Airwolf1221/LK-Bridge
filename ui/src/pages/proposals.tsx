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
import { fmtAgo, fmtTime, prettyJson, principalText, type PrincipalNames } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectReloadOn, useScopedApi } from '../project';
import { useRoute } from '../router';
import type {
  FactsOperation,
  MarkdownDiff,
  PlanItem,
  Proposal,
  ProposalCounts,
  ProposalDetail,
  ProposalOp,
  ProtectedChange,
} from '../types';

type Tab = 'pending' | 'conflicted' | 'history';

export function ProposalsPage() {
  const { query, navigate } = useRoute();
  const tab =
    (['pending', 'conflicted', 'history'] as const).find((t) => t === query.get('tab')) ?? 'pending';
  const openId = query.get('id');
  const { selected } = useProject();
  const list = useScopedApi<{ proposals: Proposal[]; principals?: PrincipalNames }>(
    `/proposals${qs({ group: tab, limit: 100 })}`,
  );
  const counts = useScopedApi<ProposalCounts>('/proposals/counts');
  const reloadAll = () => {
    list.reload();
    counts.reload();
  };
  useProjectReloadOn(['proposal'], reloadAll, 300);
  const now = useNow();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<BulkReport | null>(null);
  useEffect(() => {
    setPicked(new Set());
    setReport(null);
  }, [tab]);
  // The selected proposals, in list order, split by kind: the two kinds of approval stay distinct.
  const chosen = (list.data?.proposals ?? []).filter((p) => picked.has(p.id));
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
          chosen={chosen}
          onReport={setReport}
          onDone={() => {
            setPicked(new Set());
            reloadAll();
          }}
        />
      )}
      {report && <BulkResults report={report} onClose={() => setReport(null)} />}
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
                    <div className="muted small-text">
                      {principalText(p.principalId, list.data?.principals, p.principalLabel, true)}
                    </div>
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

type BulkAction = 'approve' | 'approve-as-canon' | 'reject';
type BulkResult = {
  id: string;
  ok: boolean;
  skipped?: boolean;
  state?: string;
  error?: { code?: string; message: string };
};

/** One line per proposal of a bulk action: what happened to it, and why when it was refused or passed over. */
interface BulkReport {
  action: BulkAction;
  rows: { id: string; title: string; outcome: 'done' | 'conflicted' | 'skipped' | 'refused'; text: string }[];
}

const DONE_TEXT: Record<BulkAction, string> = {
  approve: 'Approved',
  'approve-as-canon': 'Accepted as canon',
  reject: 'Rejected',
};

/** The per-proposal outcome of a bulk call; `titles` names each proposal as the list shows it. */
function reportOf(
  action: BulkAction,
  results: BulkResult[],
  titles: Map<string, string>,
): BulkReport['rows'] {
  return results.map((r) => {
    const title = titles.get(r.id) ?? r.id;
    if (r.ok) return { id: r.id, title, outcome: 'done', text: DONE_TEXT[action] };
    if (r.skipped)
      return {
        id: r.id,
        title,
        outcome: 'skipped',
        text: 'Skipped: it changes protected canon, so it needs “Accept selected as canon”',
      };
    if (r.state === 'conflicted')
      return {
        id: r.id,
        title,
        outcome: 'conflicted',
        text: 'Conflicted: a target changed after it was proposed, so nothing ran',
      };
    return {
      id: r.id,
      title,
      outcome: 'refused',
      text: `Refused: ${r.error?.message ?? r.state ?? 'unknown'}`,
    };
  });
}

function BulkResults({ report, onClose }: { report: BulkReport; onClose: () => void }) {
  return (
    <section className="card" aria-label="Bulk results">
      <div className="row row-between">
        <h3>Results</h3>
        <button type="button" className="small" onClick={onClose}>
          Dismiss
        </button>
      </div>
      <ul className="plain small-text">
        {report.rows.map((r) => (
          <li key={r.id} data-outcome={r.outcome} data-proposal={r.id}>
            <Badge tone={r.outcome === 'done' ? 'ok' : r.outcome === 'refused' ? 'bad' : 'warn'}>
              {r.outcome === 'done' ? 'done' : r.outcome}
            </Badge>{' '}
            <strong>{r.title}</strong>: {r.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** v2 D3 (ADR 0041): a staged image to be placed (the proposal holds its asset id, never its bytes). */
interface PlaceImageOperation {
  stagedId: string;
  assetId: string;
  name: string;
  from: string[] | null;
  to: string[];
  createsFolders: string[];
  image: {
    format: string;
    width: number;
    height: number;
    frames: number;
    bytes: number;
    storedBytesVerified: boolean | null;
  };
}

function PlaceImageView({ o }: { o: PlaceImageOperation }) {
  return (
    <section className="card" aria-label="Image placement">
      <h3>Place a staged image</h3>
      <p>
        <strong>{o.name}</strong> (<code>{o.stagedId}</code>, asset <code>{o.assetId}</code>; {o.image.width}{' '}
        × {o.image.height}
        {o.image.frames > 1 ? `, ${o.image.frames} frames` : ''}, WebP from {o.image.format.toUpperCase()};{' '}
        {o.image.storedBytesVerified ? 'stored bytes verified' : 'stored bytes not verified'})
      </p>
      <p>
        From {o.from ? o.from.join(' / ') : 'the staging folder'} (hidden) to{' '}
        <strong>{o.to.join(' / ')}</strong>
        {o.createsFolders.length > 0 ? `, creating ${o.createsFolders.join(', ')}` : ''}; then shown.
      </p>
    </section>
  );
}

/** The related pages a lifecycle proposal reports (reported, never edited), or null when it reports none. */
function relatedCount(p: ProposalDetail): number | null {
  for (const o of p.operations ?? []) {
    const rel = (o as { relatedPages?: { pages: unknown[]; textSearch?: unknown[] } }).relatedPages;
    if (!rel) continue;
    // C2d: a whole set lists its related pages page by page.
    if ((o as { subtree?: unknown }).subtree === true)
      return (rel.pages as { pages?: unknown[]; textSearch?: unknown[] }[]).reduce(
        (n, x) => n + (x.pages?.length ?? 0) + (x.textSearch?.length ?? 0),
        0,
      );
    return rel.pages.length + (rel.textSearch?.length ?? 0);
  }
  return null;
}

/** The page-level summary lines of a proposal, or its summary when it has none. */
const summaryLines = (p: Pick<Proposal, 'pages' | 'summary'>) =>
  p.pages && p.pages.length > 0 ? p.pages : [p.summary];

/**
 * v2 C2d-prep (owner, 11 November): the bulk bar. "Approve selected" takes the ordinary proposals and passes the
 * canonical ones over (and says so); "Accept selected as canon" takes only the canonical ones, after a confirmation that
 * lists each change with its reasons and needs the owner to tick that they accept them. The confirmation sends exactly
 * the ids it showed.
 */
function BulkBar({
  chosen,
  onReport,
  onDone,
}: {
  chosen: Proposal[];
  onReport: (r: BulkReport) => void;
  onDone: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const { withProject } = useProject();
  const ordinary = chosen.filter((p) => !p.requiresCanonicalApproval);
  const canon = chosen.filter((p) => p.requiresCanonicalApproval);
  const titles = new Map(chosen.map((p) => [p.id, p.title || p.summary]));

  const act = (action: BulkAction, ids: string[], skipped: Proposal[] = []) =>
    run(() =>
      api.post<{ results: BulkResult[] }>(withProject('/proposals/bulk'), {
        action,
        ids,
        ...(action === 'reject' && reason ? { reason } : {}),
        ...(action === 'approve-as-canon' ? { confirm: true } : {}),
      }),
    ).then((r) => {
      if (r) {
        const bad = r.results.filter((x) => !x.ok && !x.skipped);
        const passed = skipped.length + r.results.filter((x) => x.skipped).length;
        const verb =
          action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'accepted as canon';
        const rows = reportOf(action, r.results, titles);
        for (const p of skipped)
          rows.push(...reportOf(action, [{ id: p.id, ok: false, skipped: true }], titles));
        onReport({ action, rows });
        const note =
          passed > 0
            ? ` ${passed} canonical proposal${passed === 1 ? ' was' : 's were'} skipped: use “Accept selected as canon”.`
            : '';
        if (bad.length > 0)
          toast(
            'error',
            `${bad.length} of ${r.results.length} could not be ${verb}: ${bad.map((b) => b.error?.message ?? b.state).join('; ')}${note}`,
          );
        else toast('ok', `${r.results.length} ${verb}.${note}`);
      }
      onDone();
    });

  /** Reads each canonical proposal as it stands now, shows what it changes, and sends only the ids it showed. */
  const acceptAsCanon = async () => {
    const loaded = await run(() =>
      Promise.all(
        canon.map((p) =>
          api.get<{ proposal: ProposalDetail }>(withProject(`/proposals/${encodeURIComponent(p.id)}`)),
        ),
      ),
    );
    if (!loaded) return;
    const shown = loaded
      .map((x) => x.proposal)
      .filter((p) => p.state === 'pending' && p.requiresCanonicalApproval);
    if (shown.length === 0) {
      toast('error', 'None of the selected proposals is still waiting for canonical approval.');
      onDone();
      return;
    }
    const m = shown.length;
    const ok = await confirm({
      title: `Accept ${m} selected as canon?`,
      message: (
        <>
          <p>
            These changes touch <strong>protected canon</strong>. Accepting them records each as canon with
            your name. Each is checked against LegendKeeper again and run one at a time, in this order; one
            whose target has changed becomes conflicted and runs nothing.
          </p>
          {shown.length < canon.length && (
            <p className="note note-warn small-text">
              {canon.length - shown.length} selected proposal
              {canon.length - shown.length === 1 ? ' is' : 's are'} no longer waiting for canonical approval
              and {canon.length - shown.length === 1 ? 'is' : 'are'} left out.
            </p>
          )}
          <ul className="plain" aria-label="Changes to accept as canon">
            {shown.map((p) => {
              const reasons = (p.canonical?.changes ?? [])
                .map((c) => c.text ?? c.unchecked)
                .filter((t): t is string => Boolean(t));
              const related = relatedCount(p);
              return (
                <li key={p.id} data-proposal={p.id}>
                  {summaryLines(p).map((l) => (
                    <div key={l}>
                      <strong>{l}</strong>
                    </div>
                  ))}
                  <ul className="small-text" aria-label="Canonical reasons">
                    {(reasons.length > 0
                      ? reasons
                      : [p.canonical?.reason ?? 'Protected canonical change']
                    ).map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                  {related !== null && (
                    <div className="muted small-text">Related pages: {related} (reported, never edited)</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ),
      acknowledge: m === 1 ? 'I accept this change as canon' : `I accept these ${m} changes as canon`,
      confirmLabel: `Accept ${m} as canon`,
    });
    if (ok)
      void act(
        'approve-as-canon',
        shown.map((p) => p.id),
      );
  };

  return (
    <div className="card" role="group" aria-label="Bulk actions">
      <div className="row">
        <strong>{chosen.length} selected</strong>
        <Button
          variant="primary"
          busy={busy}
          disabled={ordinary.length === 0}
          onClick={() => {
            void confirm({
              title: `Approve ${ordinary.length} proposal${ordinary.length === 1 ? '' : 's'}?`,
              message: (
                <>
                  <p>
                    Each one is checked against LegendKeeper again, then run one at a time. A proposal whose
                    targets have changed becomes conflicted and runs nothing.
                  </p>
                  {canon.length > 0 && (
                    <p className="note note-warn small-text">
                      {canon.length} selected proposal{canon.length === 1 ? ' touches' : 's touch'} protected
                      canon and {canon.length === 1 ? 'is' : 'are'} skipped here: use “Accept selected as
                      canon”.
                    </p>
                  )}
                </>
              ),
              confirmLabel: 'Approve all',
            }).then((ok) => {
              if (ok)
                void act(
                  'approve',
                  ordinary.map((p) => p.id),
                  canon,
                );
            });
          }}
        >
          Approve selected ({ordinary.length})
        </Button>
        {canon.length > 0 && (
          <Button variant="primary" busy={busy} onClick={() => void acceptAsCanon()}>
            Accept selected as canon ({canon.length})
          </Button>
        )}
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
              title: `Reject ${chosen.length} proposal${chosen.length === 1 ? '' : 's'}?`,
              message: <p>Nothing is sent to LegendKeeper. The agents can read your reason.</p>,
              confirmLabel: 'Reject all',
              danger: true,
            }).then((ok) => {
              if (ok)
                void act(
                  'reject',
                  chosen.map((p) => p.id),
                );
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

type RestoreNote = { what: string; where?: string; why: string };

/** v2 E1a: a restore from a snapshot (always a proposal): what comes back, the diff, and what cannot. */
function RestoreSnapshotView({ p }: { p: ProposalDetail }) {
  const o = p.operationDetail as
    | (Record<string, unknown> & {
        tool?: string;
        scope?: string;
        mode?: string;
        page?: { id: string; name: string };
        snapshot?: { id: string; takenAt: string; kind: string };
        pieces?: { label: string; diff: string }[];
        lost?: RestoreNote[];
        kept?: RestoreNote[];
        notRestored?: RestoreNote[];
        warnings?: string[];
        idMap?: Record<string, string>;
        followUp?: string;
        old?: { name?: string | null; url?: string | null };
        newAsset?: { id: string; url: string | null };
        references?: { pageId: string; page: string; documents: { name: string; what: string }[] }[];
        updateReferences?: boolean;
        notes?: RestoreNote[];
      })
    | null
    | undefined;
  if (!o || o.tool !== 'restore_snapshot') return null;
  const notes = (title: string, list: RestoreNote[] | undefined, warn = false) =>
    list && list.length > 0 ? (
      <div className={warn ? 'note note-warn' : 'note'}>
        <strong>{title}</strong>
        <ul>
          {list.map((n, i) => (
            <li key={i}>
              {n.what}
              {n.where ? <span className="muted"> ({n.where})</span> : null}: {n.why}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <section className="card" aria-label="Restore from a snapshot">
      <h3>
        Restore{' '}
        {o.scope === 'image' ? (
          'a deleted image'
        ) : (
          <>
            the {o.scope} of <strong>{o.page?.name}</strong>
          </>
        )}
        {o.mode ? ` (${o.mode})` : ''}
        {o.snapshot ? (
          <span className="muted">
            {' '}
            to the {o.snapshot.kind} snapshot of {fmtTime(Date.parse(o.snapshot.takenAt))}
          </span>
        ) : null}
      </h3>
      <p className="muted small-text">
        Approving writes the snapshot’s state back. If the page changed since this was planned, the proposal
        becomes conflicted instead and nothing is written; the journal keeps what each write replaces.
      </p>
      {o.scope === 'image' && (
        <div>
          “{o.old?.name ?? 'the image'}” comes back as a new asset{' '}
          {o.newAsset?.url ? <span className="mono small-text">{o.newAsset.url}</span> : null} (its old URL{' '}
          <span className="mono small-text">{o.old?.url ?? '?'}</span> no longer works).{' '}
          {o.updateReferences
            ? 'The pages below that showed the old URL are updated too.'
            : 'The pages below that showed the old URL are not changed.'}
          {o.references && o.references.length > 0 && (
            <ul>
              {o.references.map((r) => (
                <li key={r.pageId}>
                  <strong>{r.page}</strong>: {r.documents.map((d) => `${d.name} (${d.what})`).join(', ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {p.markdownDiff ? (
        <MarkdownDiffView diff={p.markdownDiff} title="Diff (now, then as at the snapshot)" />
      ) : null}
      {notes('Cannot be restored exactly', o.lost, true)}
      {notes('Kept as they are now', o.kept)}
      {notes('Left alone', o.notRestored)}
      {notes('Notes', o.notes)}
      {o.warnings && o.warnings.length > 0 && (
        <div className="note note-warn">
          {o.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      {o.idMap && Object.keys(o.idMap).length > 0 && (
        <details>
          <summary className="small-text">New ids ({Object.keys(o.idMap).length})</summary>
          <ul className="plain mono small-text">
            {Object.entries(o.idMap).map(([a, b]) => (
              <li key={a}>
                {a} → {b}
              </li>
            ))}
          </ul>
        </details>
      )}
      {o.followUp && <p className="muted">{o.followUp}</p>}
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

const LIFECYCLE_VERB: Readonly<Record<string, string>> = {
  archive_page: 'Archive',
  unarchive_page: 'Unarchive',
  move_to_working: 'Move to Working',
  promote_page: 'Promote',
};

/** `[BWRK]` of `[BWRK] Sky Ferry`, or null. */
const prefixOfName = (name: string): string | null => /^\s*(\[[A-Za-z]{4,5}\])/.exec(name)?.[1] ?? null;

/**
 * v3 F3d (ADR 0053): a lifecycle tool's protected change in words, from the plan the proposal already holds (its
 * operation's `lifecycle` summary), e.g. “Promote: Status would be set to Authoritative; name [BWRK] → [BSRC]; tags
 * Working → CANON”. Null for a change that has its own text.
 */
function lifecycleChangeWords(
  c: ProtectedChange,
  p: Pick<ProposalDetail, 'operations' | 'canonical'>,
): string | null {
  if (typeof c.lifecycle !== 'string' || c.text || c.unchecked) return null;
  const verb = LIFECYCLE_VERB[c.lifecycle] ?? c.lifecycle;
  const op = (p.operations ?? []).find(
    (o) => o.tool === c.lifecycle && typeof o.lifecycle === 'object' && o.lifecycle !== null,
  );
  if (!op) {
    // A pack tool's canonical marker (promoteNation): its reason says what is canon about it.
    const n = c.pages?.length ?? 0;
    return `${c.lifecycle}: ${p.canonical?.reason ?? `changes ${n} page${n === 1 ? '' : 's'}`}`;
  }
  if ((op as { subtree?: unknown }).subtree === true) {
    const l = (op as unknown as SetOperation).lifecycle;
    return `${verb} the whole set under ${l.set.root.name} (${l.set.pages} page${l.set.pages === 1 ? '' : 's'}): ${l.set.from ?? 'unknown'} → ${l.set.to}; its root goes under ${l.set.newParent.name}`;
  }
  const l = (op as unknown as LifecycleOperation).lifecycle;
  const parts: string[] = [];
  const status = l.facts.find((f) => f.key.trim().toLowerCase() === 'status');
  if (status) parts.push(status.after ? `Status would be set to ${status.after}` : 'Status would be removed');
  const from = prefixOfName(l.page.name);
  const to = prefixOfName(l.newName);
  if (from !== to) parts.push(`name ${from ?? '(no prefix)'} → ${to ?? '(no prefix)'}`);
  const { before, after, removed, added } = l.tags;
  if (removed.length > 0 || added.length > 0) {
    const leads = added.length > 0 && after.length > 1 && after[0] === added[0];
    parts.push(
      `tags ${removed.join(', ') || '(none)'} → ${added.join(', ') || '(none)'}${leads ? ` (${added[0]} first)` : ''}`,
    );
  } else if (before.join('\u0000') !== after.join('\u0000'))
    parts.push(`tags reordered: ${after.join(', ')}`);
  return `${verb}: ${parts.join('; ')}`;
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
              {c.text ?? c.unchecked ?? lifecycleChangeWords(c, p) ?? JSON.stringify(c)}
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
      {op.label && op.label !== op.op && <p className="small-text">{op.label}</p>}
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

/**
 * v3 F3d (ADR 0058; the design's section 2): the ticked items that can be approved. An item needs every item it depends on
 * (to the end of the chain): one whose need is left out is left out with it, and the owner sees which before confirming.
 */
export function closeSelection(
  items: readonly PlanItem[],
  ticked: ReadonlySet<string>,
): { kept: string[]; dropped: { id: string; because: string[] }[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kept = new Set([...ticked].filter((id) => byId.has(id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...kept]) {
      if (byId.get(id)!.dependsOn.some((d) => !kept.has(d))) {
        kept.delete(id);
        changed = true;
      }
    }
  }
  const dropped = items
    .filter((i) => ticked.has(i.id) && !kept.has(i.id))
    .map((i) => ({ id: i.id, because: i.dependsOn.filter((d) => !kept.has(d)) }));
  return { kept: items.filter((i) => kept.has(i.id)).map((i) => i.id), dropped };
}

function ItemDiffView({ diff }: { diff: PlanItem['diff'] }) {
  if (!diff) return null;
  if (diff.changes && diff.changes.length > 0)
    return (
      <ul className="small-text">
        {diff.changes.map((c, i) => (
          <li key={i}>
            <strong>{c.what}</strong>: <del>{c.before ?? '(none)'}</del> → <ins>{c.after ?? '(none)'}</ins>
          </li>
        ))}
      </ul>
    );
  if (diff.before === undefined && diff.after === undefined) return null;
  return (
    <p className="small-text">
      <del>{diff.before ?? '(none)'}</del> → <ins>{diff.after ?? '(none)'}</ins>
    </p>
  );
}

/**
 * v3 F3d (ADR 0058): a proposal made of items. Pending: a tickbox per item (the plan's ticks first; each says why it is
 * unticked when it is), its change, what it needs, and which ticked items are left out because they need one that is
 * not. Decided: what was approved and what was left out, with "Propose these again".
 */
function ItemsView({
  p,
  selection,
  onToggle,
  onRepropose,
  busy,
}: {
  p: ProposalDetail;
  selection: ReadonlySet<string>;
  onToggle: (ids: string[], on: boolean) => void;
  onRepropose: () => void;
  busy: boolean;
}) {
  const plan = p.itemPlan!;
  const items = plan.items;
  const pending = p.state === 'pending';
  const labels = new Map(items.map((i) => [i.id, i.label]));
  const closed = closeSelection(items, selection);
  const kept = new Set(closed.kept);
  const approved = plan.approved ? new Set(plan.approved) : null;
  const groups = [...new Set(items.map((i) => i.group))];
  const omitted = plan.omitted ?? [];
  const decided = !pending && approved !== null;
  return (
    <section className="card" aria-label="Items">
      <h3>Items</h3>
      {pending ? (
        <p>
          <strong>
            {closed.kept.length} of {items.length}
          </strong>{' '}
          item{items.length === 1 ? '' : 's'} will be approved. Untick what should not be done: an item that
          needs an unticked one is left out with it.
        </p>
      ) : decided ? (
        <p>
          {approved.size} of {items.length} approved; {omitted.length} left out.
          {p.reproposedAs && (
            <>
              {' '}
              Proposed again as <span className="mono">{p.reproposedAs}</span>.
            </>
          )}
        </p>
      ) : null}
      {p.reproposalOf && (
        <p className="muted small-text">
          The items left out of <span className="mono">{p.reproposalOf}</span>, proposed again.
        </p>
      )}
      {groups.map((g) => {
        const its = items.filter((i) => i.group === g);
        return (
          <fieldset key={g} className="stack">
            <legend>
              {g} ({its.length})
            </legend>
            {pending && its.length > 1 && (
              <div className="row">
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    onToggle(
                      its.map((i) => i.id),
                      true,
                    )
                  }
                >
                  Tick all
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    onToggle(
                      its.map((i) => i.id),
                      false,
                    )
                  }
                >
                  Untick all
                </button>
              </div>
            )}
            {its.map((i) => (
              <div key={i.id} className="item-row">
                <label>
                  <input
                    type="checkbox"
                    disabled={!pending}
                    checked={pending ? selection.has(i.id) : (approved?.has(i.id) ?? true)}
                    onChange={(e) => onToggle([i.id], e.target.checked)}
                  />{' '}
                  {i.label}
                </label>{' '}
                {(i.tags ?? []).map((t) => (
                  <Badge key={t} tone="info">
                    {t}
                  </Badge>
                ))}
                {i.why && <p className="muted small-text">Unticked by the plan: {i.why}.</p>}
                <ItemDiffView diff={i.diff} />
                {i.dependsOn.length > 0 && (
                  <p className="muted small-text">
                    Needs: {i.dependsOn.map((d) => labels.get(d) ?? d).join('; ')}
                  </p>
                )}
                {pending && selection.has(i.id) && !kept.has(i.id) && (
                  <p className="note note-warn small-text">Left out: it needs an item you unticked.</p>
                )}
              </div>
            ))}
          </fieldset>
        );
      })}
      {pending && closed.dropped.length > 0 && (
        <div className="note note-warn" role="status">
          <p>
            <strong>
              {closed.dropped.length} ticked item{closed.dropped.length === 1 ? ' is' : 's are'} left out
            </strong>{' '}
            because {closed.dropped.length === 1 ? 'it needs' : 'they need'} an item you unticked:
          </p>
          <ul>
            {closed.dropped.map((d) => (
              <li key={d.id}>
                {labels.get(d.id) ?? d.id} (needs {d.because.map((b) => labels.get(b) ?? b).join('; ')})
              </li>
            ))}
          </ul>
        </div>
      )}
      {decided && omitted.length > 0 && (
        <div className="stack">
          <details>
            <summary>Left out ({omitted.length})</summary>
            <ul>
              {omitted.map((id) => (
                <li key={id}>{labels.get(id) ?? id}</li>
              ))}
            </ul>
          </details>
          {!p.reproposedAs && ['executing', 'executed', 'failed'].includes(p.state) && (
            <div className="row">
              <Button busy={busy} onClick={onRepropose}>
                Propose these again
              </Button>
            </div>
          )}
        </div>
      )}
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
  const d = useScopedApi<{ proposal: ProposalDetail; principals?: PrincipalNames }>(
    `/proposals/${encodeURIComponent(id)}`,
  );
  useProjectReloadOn(['proposal'], d.reload, 300);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // v3 F3d (ADR 0058): the owner's ticks of a proposal made of items (null: the plan's own).
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  useEffect(() => setTicked(null), [id]);
  const p = d.data?.proposal;
  const plan = p?.itemPlan ?? null;
  const selection = useMemo(
    () => ticked ?? new Set((plan?.items ?? []).filter((i) => i.selected).map((i) => i.id)),
    [ticked, plan],
  );
  const closed = plan ? closeSelection(plan.items, selection) : null;
  const partial = closed !== null && plan !== null && closed.kept.length < plan.items.length;
  const itemsBody = closed ? { items: closed.kept } : {};
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selection);
    for (const x of ids) {
      if (on) next.add(x);
      else next.delete(x);
    }
    setTicked(next);
  };
  const itemsNote = closed && plan && (
    <>
      <p>
        <strong>
          {closed.kept.length} of {plan.items.length}
        </strong>{' '}
        items are approved; {plan.items.length - closed.kept.length} are left out (recorded, and you can
        propose them again once this has run).
      </p>
      {closed.dropped.length > 0 && (
        <>
          <p>Left out because they need an item you unticked:</p>
          <ul>
            {closed.dropped.map((x) => (
              <li key={x.id}>{plan.items.find((i) => i.id === x.id)?.label ?? x.id}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
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
              Proposed by <strong>{p.profile}</strong>{' '}
              <span className="muted">
                ({principalText(p.principalId, d.data?.principals, p.principalLabel, true)})
              </span>
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
          {plan && (
            <ItemsView
              p={p}
              selection={selection}
              onToggle={toggle}
              busy={busy}
              onRepropose={() => {
                void confirm({
                  title: 'Propose the items left out again?',
                  message: (
                    <p>
                      One new proposal is made of the {plan.omitted?.length ?? 0} items left out, planned as
                      they were and checked against LegendKeeper again. You approve it (whole or in part) like
                      any other.
                    </p>
                  ),
                  confirmLabel: 'Propose these again',
                }).then((ok) => {
                  if (ok)
                    void run(
                      () =>
                        api.post<{ proposalId: string }>(
                          withProject(`/proposals/${encodeURIComponent(p.id)}/repropose`),
                          { confirm: true },
                        ),
                      'Proposed again.',
                    ).then(done);
                });
              }}
            />
          )}
          <CanonBanner p={p} />
          <PageWriteView p={p} />
          <RestoreSnapshotView p={p} />
          {(p.operations ?? [])
            .filter((o) => o.tool === 'set_facts')
            .map((o, i) => (
              <FactsView key={i} o={o as unknown as FactsOperation} execution={p.execution ?? null} />
            ))}
          {(p.operations ?? [])
            .filter((o) => o.kind === 'place_image')
            .map((o, i) => (
              <PlaceImageView key={`img${i}`} o={o as unknown as PlaceImageOperation} />
            ))}
          {(p.operations ?? [])
            .filter((o) => typeof o.lifecycle === 'object' && o.lifecycle !== null)
            .map((o, i) =>
              (o as { subtree?: unknown }).subtree === true ? (
                <SetPlanView key={`lc${i}`} o={o as unknown as SetOperation} />
              ) : (
                <LifecyclePlanView key={`lc${i}`} o={o as unknown as LifecycleOperation} />
              ),
            )}
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
                      disabled={closed !== null && closed.kept.length === 0}
                      onClick={() => {
                        void confirm({
                          title: partial
                            ? 'Approve the selected items and accept them as canon?'
                            : 'Approve and accept as canon?',
                          message: (
                            <>
                              <p>
                                This makes a change to <strong>protected canon</strong>. Approving it accepts
                                the result as canon, and the decision is recorded with your name.
                              </p>
                              <ul>
                                {(p.canonical?.changes ?? []).map((c, i) => (
                                  <li key={i}>{c.text ?? c.unchecked ?? lifecycleChangeWords(c, p)}</li>
                                ))}
                              </ul>
                              {itemsNote}
                              <p className="muted small-text">{p.summary}</p>
                            </>
                          ),
                          confirmLabel: partial
                            ? 'Approve selected and accept as canon'
                            : 'Approve and accept as canon',
                        }).then((ok) => {
                          if (ok)
                            void run(
                              () =>
                                api.post(
                                  withProject(`/proposals/${encodeURIComponent(p.id)}/approve-as-canon`),
                                  { confirm: true, ...itemsBody },
                                ),
                              'Approved and accepted as canon.',
                            ).then(done);
                        });
                      }}
                    >
                      {partial ? 'Approve selected and accept as canon' : 'Approve and accept as canon'}
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
                    disabled={closed !== null && closed.kept.length === 0}
                    onClick={() => {
                      void confirm({
                        title: partial ? 'Approve the selected items and run them?' : 'Approve and run this?',
                        message: (
                          <>
                            <p>
                              {p.ops.length} operation{p.ops.length === 1 ? '' : 's'} will be sent to
                              LegendKeeper as <strong>{p.profile}</strong>, after LegendKeeper is checked once
                              more for changes.
                            </p>
                            {itemsNote}
                            <p className="muted small-text">{p.summary}</p>
                          </>
                        ),
                        confirmLabel: partial ? 'Approve selected' : 'Approve',
                      }).then((ok) => {
                        if (ok)
                          void run(
                            () =>
                              closed
                                ? api.post(
                                    withProject(`/proposals/${encodeURIComponent(p.id)}/approve`),
                                    itemsBody,
                                  )
                                : api.post(withProject(`/proposals/${encodeURIComponent(p.id)}/approve`)),
                            'Approved.',
                          ).then(done);
                      });
                    }}
                  >
                    {partial ? 'Approve selected' : 'Approve'}
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

// ============================================================================================ v2 C2c: lifecycle plans

interface LifecycleOperation {
  tool: string;
  lifecycle: {
    page: { id: string; name: string; path?: string };
    action: string;
    newName: string;
    newParent: { id: string; name: string };
    place?: { after: string | null; before: string | null };
    facts: { key: string; before: string | null; after: string | null; change: string }[];
    tags: { before: string[]; after: string[]; removed: string[]; added: string[] };
    note?: { action: 'insert' | 'remove'; blockId: string; diff: string };
    characterIndex?: { id: string; name: string };
    flags?: string[];
    resumes?: { recordId: number };
  };
  relatedPages?: {
    pages: { id: string; name: string; path: string; links: string[] }[];
    textSearch: { id: string; name: string; path: string; found: string }[];
    freshness: string;
    note: string;
  };
}

/**
 * v2 C2c (ADR 0035): a lifecycle tool's plan, in full: the move and the new name, every fact change, the tag changes,
 * the archive note as a Markdown diff, and the pages that depend on or relate to the page (reported, never edited).
 */
function LifecyclePlanView({ o }: { o: LifecycleOperation }) {
  const l = o.lifecycle;
  const rel = o.relatedPages;
  return (
    <section className="card" aria-label="Lifecycle change">
      <h3>
        <span className="mono">{o.tool}</span> on <strong>{l.page.name}</strong>
        {l.resumes && <span className="muted"> (resumes record {l.resumes.recordId})</span>}
      </h3>
      <p>
        <strong>{l.page.name}</strong> becomes <strong>{l.newName}</strong> under{' '}
        <strong>{l.newParent.name}</strong>
        {l.place && (l.place.after || l.place.before) ? (
          <span className="muted small-text">
            {' '}
            (alphabetical: {l.place.after ? `after ${l.place.after}` : `before ${l.place.before}`})
          </span>
        ) : null}
        {l.characterIndex && <span> · the character’s index {l.characterIndex.name} moves with it</span>}
      </p>
      {l.facts.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Lifecycle facts before and after">
            <thead>
              <tr>
                <th>Fact</th>
                <th>Before</th>
                <th>After</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {l.facts.map((f) => (
                <tr key={f.key} data-fact={f.key}>
                  <td>{f.key}</td>
                  <td className="diff-del">{f.before ?? <span className="muted">—</span>}</td>
                  <td className="diff-add">{f.after ?? <span className="muted">—</span>}</td>
                  <td>{f.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small-text">
        <strong>Tags:</strong> {l.tags.before.join(', ') || '(none)'} → {l.tags.after.join(', ') || '(none)'}
        {l.tags.removed.length > 0 && <> · removed {l.tags.removed.join(', ')}</>}
        {l.tags.added.length > 0 && <> · added {l.tags.added.join(', ')}</>}
      </p>
      {l.note && (
        <pre
          className={`diff small-text ${l.note.action === 'insert' ? 'diff-add' : 'diff-del'}`}
          aria-label="The archive note"
        >
          {l.note.diff}
        </pre>
      )}
      {(l.flags ?? []).map((f) => (
        <p key={f} className="note note-warn small-text">
          {f}
        </p>
      ))}
      {rel && (
        <div className="mt" role="group" aria-label="Related pages">
          <h4>Related pages (reported, never edited)</h4>
          <p className="muted small-text">{rel.freshness}</p>
          {rel.pages.length === 0 && rel.textSearch.length === 0 ? (
            <p className="muted small-text">None found.</p>
          ) : (
            <ul className="plain small-text">
              {rel.pages.map((x) => (
                <li key={x.id}>
                  {x.path} — {x.links.join('; ')}
                </li>
              ))}
              {rel.textSearch.map((x) => (
                <li key={x.id}>
                  {x.path} — <span className="muted">{x.found}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ============================================================================================ C2d: whole sets

interface SetOperation {
  tool: string;
  subtree: true;
  lifecycle: {
    action: string;
    set: {
      root: { id: string; name: string; path?: string };
      pages: number;
      contentPages: number;
      indexes: number;
      from: string | null;
      to: string;
      newParent: { id: string; name: string };
      layout: string;
    };
    pages: {
      id: string;
      name: string;
      role: 'index' | 'page';
      from?: string;
      newName: string;
      move: { under: { id: string; name: string } } | string;
      facts: { key: string; before: string | null; after: string | null; change: string }[];
      tags: { before: string[]; after: string[] };
      note?: { action: 'insert' | 'remove'; blockId: string; diff: string };
    }[];
    estimate?: { pages: number; reads: number; writes: number; wallClock?: string; fitsToday?: boolean };
    flags?: string[];
    resumes?: { setId: number };
  };
  relatedPages?: {
    pages: {
      page: { id: string; name: string };
      pages: { id: string; name: string; path: string; links: string[] }[];
      textSearch: { id: string; name: string; path: string; found: string }[];
    }[];
    freshness: string;
    excluded: string;
  };
}

/**
 * C2d (ADR 0037): a whole-set lifecycle change, in full: the set summary (its root, its pages, the state it leaves and
 * enters, where its root goes, the estimate), then every page with its own plan (name, move, facts, tags, note), and the
 * related pages of each (links inside the set left out). One canonical proposal for the whole set.
 */
function SetPlanView({ o }: { o: SetOperation }) {
  const l = o.lifecycle;
  const rel = o.relatedPages;
  return (
    <section className="card" aria-label="Whole-set lifecycle change">
      <h3>
        <span className="mono">{o.tool}</span> of the whole set under <strong>{l.set.root.name}</strong>
        {l.resumes && <span className="muted"> (resumes set record {l.resumes.setId})</span>}
      </h3>
      <p>
        {l.set.pages} page{l.set.pages === 1 ? '' : 's'} ({l.set.contentPages} content, {l.set.indexes} index
        {l.set.indexes === 1 ? '' : 'es'}), {l.set.from ?? 'unknown'} → {l.set.to}. The root moves under{' '}
        <strong>{l.set.newParent.name}</strong>; {l.set.layout}.
      </p>
      {l.estimate && (
        <p className="muted small-text">
          Estimate: about {l.estimate.reads} reads and {l.estimate.writes} writes
          {l.estimate.wallClock ? `, ${l.estimate.wallClock}` : ''}
          {l.estimate.fitsToday === false ? ' — does not fit in today’s budget' : ''}.
        </p>
      )}
      <div className="table-wrap">
        <table aria-label="Every page of the set">
          <thead>
            <tr>
              <th>Page</th>
              <th>Becomes</th>
              <th>Place</th>
              <th>Facts</th>
              <th>Tags</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {l.pages.map((p) => (
              <tr key={p.id} data-set-page={p.id}>
                <td>
                  {p.name}
                  {p.role === 'index' && <span className="muted small-text"> (index: no Status)</span>}
                </td>
                <td>{p.newName}</td>
                <td className="small-text">
                  {typeof p.move === 'string' ? p.move : `moves under ${p.move.under.name}`}
                </td>
                <td className="small-text">
                  {p.facts.length === 0
                    ? '—'
                    : p.facts.map((f) => (
                        <div key={f.key}>
                          {f.key}: <span className="diff-del">{f.before ?? '—'}</span> →{' '}
                          <span className="diff-add">{f.after ?? '—'}</span>
                        </div>
                      ))}
                </td>
                <td className="small-text">
                  {p.tags.before.join(', ') || '(none)'} → {p.tags.after.join(', ') || '(none)'}
                </td>
                <td className="small-text">{p.note ? p.note.diff : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(l.flags ?? []).map((f) => (
        <p key={f} className="note note-warn small-text">
          {f}
        </p>
      ))}
      {rel && (
        <div className="mt" role="group" aria-label="Related pages">
          <h4>Related pages (reported, never edited; links inside the set left out)</h4>
          <p className="muted small-text">{rel.freshness}</p>
          {rel.pages.length === 0 ? (
            <p className="muted small-text">None found.</p>
          ) : (
            <ul className="plain small-text">
              {rel.pages.map((x) => (
                <li key={x.page.id}>
                  <strong>{x.page.name}</strong>:{' '}
                  {[
                    ...x.pages.map((y) => `${y.path} — ${y.links.join('; ')}`),
                    ...x.textSearch.map((y) => `${y.path} — ${y.found}`),
                  ].join(' · ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
