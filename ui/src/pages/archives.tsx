import { useEffect, useState } from 'react';
import { background } from '../api';
import { Badge, Empty, ErrorNote, useAction, useConfirm } from '../components';
import { fmtAgo, fmtBytes, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProjectApi, useScopedApi } from '../project';

/**
 * v3 F7c (ADR 0075, Z6): the image archives (zips) on the Asset Tree page: each archive's rows with their status,
 * expected time and reason, the three limits kept apart (holding, processing, the hourly brake), and a Discard button
 * (it asks you to confirm it is you first). Everything here is on the bridge's own server: nothing reaches LegendKeeper
 * until a placement job runs.
 */

interface ArchiveRowView {
  readonly entry: string;
  readonly path: string;
  readonly folder: string | null;
  readonly suggestedOutfit: string | null;
  readonly size: number;
  readonly format?: string;
  readonly width?: number;
  readonly height?: number;
  readonly status: string;
  readonly staged_id?: string;
  readonly heldBy?: 'rate' | 'storage';
  readonly expectedAt?: string;
  readonly queuePosition?: number;
  readonly reason?: string;
  readonly duplicateOf?: string | null;
}

interface ArchiveView {
  readonly archive_id: string;
  readonly fileName?: string;
  readonly state: string;
  readonly bytes: number;
  readonly entries: number;
  readonly skipped?: number;
  readonly counts: Record<string, number>;
  readonly serverCopy: boolean;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly referenced: boolean;
  readonly rows: readonly ArchiveRowView[];
}

interface Limits {
  readonly holding: { stagedBytes: number; capBytes: number; freeBytes: number };
  readonly processing: { converting: number; waitingInQueue: number; concurrency: number };
  readonly brake: { perHour: number };
}

interface ArchivesResponse {
  readonly archives: readonly ArchiveView[];
  readonly limits: Limits;
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  listed: 'neutral',
  queued: 'info',
  converting: 'info',
  held: 'warn',
  staged: 'ok',
  refused: 'bad',
  failed: 'bad',
  duplicate: 'neutral',
  discarded: 'neutral',
};

const LABEL: Record<string, string> = {
  listed: 'Listed',
  queued: 'Queued',
  converting: 'Converting',
  held: 'Held',
  staged: 'Staged',
  refused: 'Refused',
  failed: 'Failed',
  duplicate: 'Duplicate',
  discarded: 'Discarded',
};

function statusText(r: ArchiveRowView): string {
  if (r.status === 'held')
    return r.heldBy === 'rate'
      ? `waiting for the hour’s brake${r.expectedAt ? `, expected ${fmtTime(Date.parse(r.expectedAt))}` : ''}`
      : 'waiting for space';
  if (r.status === 'queued') return r.queuePosition ? `queue position ${r.queuePosition}` : 'queued';
  if (r.status === 'duplicate') return `the same bytes as ${r.duplicateOf ?? 'an earlier entry'}`;
  if (r.status === 'staged') return r.staged_id ?? '';
  return r.reason ?? '';
}

export function ArchivesCard() {
  const list = useScopedApi<ArchivesResponse>('/archives');
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  const active = (list.data?.archives ?? []).some((a) =>
    a.rows.some((r) => r.status === 'queued' || r.status === 'converting' || r.status === 'held'),
  );
  useEffect(() => {
    const t = setInterval(background(list.reload), active ? 3000 : 30_000);
    return () => clearInterval(t);
  }, [list.reload, active]);

  const discard = (a: ArchiveView) => {
    void confirm({
      title: 'Discard this archive?',
      message: (
        <>
          <p>
            Its server copy is removed, and every entry not yet staged is discarded
            {a.referenced
              ? ': an art job waiting for one of them leaves that image out and places the rest'
              : ''}
            . Images already staged stay on the Staging page.
          </p>
          <p className="muted small-text">You will be asked to confirm it is you first.</p>
        </>
      ),
      confirmLabel: 'Discard the archive',
      danger: true,
    }).then((ok) => {
      if (ok)
        void run(
          () => projectApi.post(`/archives/${encodeURIComponent(a.archive_id)}/discard`, {}),
          'Archive discarded.',
        ).then(list.reload);
    });
  };

  const archives = list.data?.archives ?? [];
  const limits = list.data?.limits;
  return (
    <section className="card table-wrap" aria-labelledby="assets-archives-h" data-testid="assets-archives">
      <h2 id="assets-archives-h">Image archives</h2>
      <p className="muted small-text">
        Zips of images uploaded for staging (upload_image_archive). Every entry is listed at once and
        converted only when an art call uses it (or all at once on request). Held entries finish on their own.
      </p>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {limits && (
        <dl className="kv" data-testid="archive-limits">
          <dt>Holding (staging capacity)</dt>
          <dd>
            {fmtBytes(limits.holding.stagedBytes)} of {fmtBytes(limits.holding.capBytes)} staged ·{' '}
            {fmtBytes(limits.holding.freeBytes)} free
          </dd>
          <dt>Processing</dt>
          <dd>
            {fmtInt(limits.processing.converting)} converting, {fmtInt(limits.processing.waitingInQueue)}{' '}
            waiting · at most {fmtInt(limits.processing.concurrency)} at once
          </dd>
          <dt>Hourly brake</dt>
          <dd>{fmtInt(limits.brake.perHour)} images per connection per hour</dd>
          <dt>LegendKeeper</dt>
          <dd>the governor’s budgets, on the Budgets page</dd>
        </dl>
      )}
      {!list.data ? null : archives.length === 0 ? (
        <Empty>No image archives in this project.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Archive</th>
              <th>Entries</th>
              <th>State</th>
              <th>Last activity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {archives.map((a) => (
              <ArchiveRows
                key={a.archive_id}
                a={a}
                now={now}
                open={open === a.archive_id}
                onToggle={() => setOpen(open === a.archive_id ? null : a.archive_id)}
                onDiscard={() => discard(a)}
                busy={busy}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ArchiveRows({
  a,
  now,
  open,
  onToggle,
  onDiscard,
  busy,
}: {
  a: ArchiveView;
  now: number;
  open: boolean;
  onToggle: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  return (
    <>
      <tr data-testid={`archive-${a.archive_id}`}>
        <td>
          <button type="button" className="link" onClick={onToggle} aria-expanded={open}>
            {a.fileName ?? a.archive_id}
          </button>
          <div className="muted small-text">
            {a.archive_id} · {fmtBytes(a.bytes)}
          </div>
        </td>
        <td>
          {fmtInt(a.entries)}{' '}
          {Object.entries(a.counts).map(([s, n]) => (
            <Badge key={s} tone={TONE[s] ?? 'neutral'}>
              {`${LABEL[s] ?? s} ${n}`}
            </Badge>
          ))}
        </td>
        <td>
          {a.state}
          {a.referenced ? ' · an art job waits for it' : ''}
          {a.serverCopy ? '' : ' · no server copy'}
        </td>
        <td>{fmtAgo(Date.parse(a.lastActivityAt), now)}</td>
        <td>
          {a.state !== 'discarded' && (
            <button type="button" className="small danger" disabled={busy} onClick={onDiscard}>
              Discard
            </button>
          )}
        </td>
      </tr>
      {open &&
        a.rows.map((r) => (
          <tr key={r.path} className="sub-row">
            <td>
              {r.entry}
              {r.folder ? <div className="muted small-text">{r.folder}</div> : null}
            </td>
            <td>
              {r.format ?? ''} {r.width && r.height ? `${r.width}×${r.height}` : ''} · {fmtBytes(r.size)}
            </td>
            <td>
              <Badge tone={TONE[r.status] ?? 'neutral'}>{LABEL[r.status] ?? r.status}</Badge>
            </td>
            <td colSpan={2}>{statusText(r)}</td>
          </tr>
        ))}
    </>
  );
}
