import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';
import {
  PROJECT_STATUS_LABELS,
  STATUS_LABELS,
  TIER_LABELS,
  fmtDuration,
  fmtInt,
  pct,
  prettyJson,
} from './format';
import type { JobStop, ResumeView, TierSnapshot } from './types';

// ------------------------------------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// --------------------------------------------------------------------------------------------- confirmation

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Styles the confirm button as risky. */
  danger?: boolean;
  /** A tick box the owner must tick before the confirm button enables (for decisions that need a deliberate yes). */
  acknowledge?: string;
}
type Confirm = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const confirm = useCallback<Confirm>(
    (o) =>
      new Promise((resolve) => {
        setAcknowledged(false);
        setState({ ...o, resolve });
      }),
    [],
  );
  const done = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && done(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">{state.title}</h2>
            <div className="dialog-body">{state.message}</div>
            {state.acknowledge && (
              <label className="inline" htmlFor="confirm-acknowledge">
                <input
                  id="confirm-acknowledge"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />{' '}
                {state.acknowledge}
              </label>
            )}
            <div className="actions">
              <button type="button" onClick={() => done(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={state.danger ? 'danger' : 'primary'}
                autoFocus={!state.acknowledge}
                disabled={Boolean(state.acknowledge) && !acknowledged}
                onClick={() => done(true)}
              >
                {state.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/** Runs an action with a busy flag; errors become toasts (and are returned as `undefined`). */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (okText) toast('ok', okText);
        return r;
      } catch (e) {
        // A 401 sends the page to sign-in; a cancelled re-authentication (OPS2) is the owner's own choice.
        if (!(e instanceof ApiError && (e.status === 401 || e.code === 'REAUTH_CANCELLED')))
          toast('error', e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------------------------------------------------------------------------------------------- small parts

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  succeeded: 'ok',
  executed: 'ok',
  approved: 'ok',
  running: 'info',
  executing: 'info',
  queued: 'neutral',
  pending: 'neutral',
  paused: 'warn',
  waiting_budget: 'warn',
  waiting_lock: 'warn',
  conflicted: 'bad',
  failed: 'bad',
  uncertain: 'bad',
  rejected: 'neutral',
  cancelled: 'neutral',
  expired: 'neutral',
};
export const StatusBadge = ({ status }: { status: string }) => (
  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABELS[status] ?? status}</Badge>
);

const PROJECT_STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  active: 'ok',
  verifying: 'info',
  unverified: 'warn',
  stopped: 'bad',
  not_configured: 'warn',
  archived: 'neutral',
};
/** A project's status (v2 A1): active, checking its key, not verified, stopped, no key configured. */
export const ProjectStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={PROJECT_STATUS_TONE[status] ?? 'neutral'}>{PROJECT_STATUS_LABELS[status] ?? status}</Badge>
);

export function Button({
  variant = 'default',
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger'; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`${variant === 'default' ? '' : variant} ${rest.className ?? ''}`.trim()}
      disabled={rest.disabled || busy}
    >
      {children}
    </button>
  );
}

/** Copies text to the clipboard, falling back to a hidden textarea where the clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'offscreen';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="small"
      aria-label={what ? `${label} ${what}` : label}
      onClick={() => {
        void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'));
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="note note-bad" role="alert">
      {error.message}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="small" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

export const Loading = ({ what = 'Loading…' }: { what?: string }) => (
  <p className="muted" aria-busy="true">
    {what}
  </p>
);

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** A page's title. `project` names the project a scoped page shows, so the owner always knows which one it is. */
export function PageHeader({
  title,
  project,
  children,
}: {
  title: string;
  project?: string | null;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        <h1>{title}</h1>
        {project && (
          <span className="project-label" data-testid="page-project">
            Project: <strong>{project}</strong>
          </span>
        )}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}

export function Json({ value, max = 400 }: { value: unknown; max?: number }) {
  const text = useMemo(() => prettyJson(value), [value]);
  return (
    <pre className="json" tabIndex={0} aria-label="JSON" data-max={max}>
      {text}
    </pre>
  );
}

// ------------------------------------------------------------------------------------------------- gauges

export function tone(p: number): 'ok' | 'warn' | 'bad' {
  return p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok';
}

/** One budget tier: used/limit, a bar, and the reset countdown. */
export function Gauge({
  tier,
  now,
  compact = false,
}: {
  tier: TierSnapshot;
  now: number;
  compact?: boolean;
}) {
  const label = TIER_LABELS[tier.tier] ?? tier.tier;
  if (tier.reactiveOnly) {
    return (
      <div className="gauge" data-tier={tier.tier}>
        <div className="gauge-head">
          <span className="gauge-label">{label}</span>
          <Badge>reactive only</Badge>
        </div>
        <p className="muted small-text">
          LegendKeeper publishes no numbers for this tier, so the bridge only reacts when it is refused
          {tier.blockedUntilMs ? ` (blocked for another ${fmtDuration(tier.blockedUntilMs - now)})` : ''}.
        </p>
      </div>
    );
  }
  const p = pct(tier.used, tier.limit);
  const reset = tier.resetAtMs && tier.resetAtMs > now ? fmtDuration(tier.resetAtMs - now) : null;
  return (
    <div className={`gauge gauge-${tone(p)}`} data-tier={tier.tier}>
      <div className="gauge-head">
        <span className="gauge-label">{label}</span>
        <span className="gauge-figure" aria-label={`${tier.used} of ${tier.limit} used`}>
          {fmtInt(tier.used)} / {fmtInt(tier.limit)}
        </span>
      </div>
      <svg
        className="gauge-bar"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${p} per cent used`}
      >
        <rect className="gauge-track" x="0" y="0" width="100" height="4" rx="2" />
        <rect className="gauge-fill" x="0" y="0" width={p} height="4" rx="2" />
      </svg>
      {!compact && (
        <div className="gauge-foot muted small-text">
          <span>{p}% used</span>
          <span>{reset ? `resets in ${reset}` : 'nothing counted'}</span>
          {tier.blockedUntilMs && tier.blockedUntilMs > now && (
            <Badge tone="bad">refused for {fmtDuration(tier.blockedUntilMs - now)}</Badge>
          )}
        </div>
      )}
    </div>
  );
}

/** A tiny line chart of `values` (0..max). */
export function Sparkline({
  values,
  max,
  label,
  width = 220,
  height = 40,
}: {
  values: number[];
  max: number;
  label: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return (
      <svg
        className="spark"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: not enough history yet`}
      >
        <line className="spark-base" x1="0" y1={height - 1} x2={width} y2={height - 1} />
      </svg>
    );
  }
  const top = Math.max(max, 1);
  const step = width / (values.length - 1);
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(1)},${(height - 2 - (Math.min(v, top) / top) * (height - 4)).toFixed(1)}`,
  );
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <line className="spark-base" x1="0" y1={height - 1} x2={width} y2={height - 1} />
      <polyline className="spark-line" points={pts.join(' ')} fill="none" />
    </svg>
  );
}

/**
 * v3 F3d (ADR 0058; the design's section 3): where a package, a rename or a recreate stopped part-way, and Resume. It
 * continues from where the job stopped: the job's own check runs again inside its locks first, no step that succeeded
 * runs again and nothing is made twice; a step that is no longer safe is refused with its reason. Work the owner approved
 * resumes without a fresh approval (the plan is the one approved), and every resume is audited. Revert (the Review page)
 * stays the other way out.
 */
export function ResumeCard({
  jobId,
  stop,
  view,
  resumeUrl,
  onDone,
}: {
  jobId: string;
  stop: JobStop;
  view: ResumeView | null;
  /** The POST route (with its project). */
  resumeUrl: string;
  onDone: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const what = stop.kind === 'recreate' ? 'recreate' : stop.kind === 'rename' ? 'rename' : 'package';
  return (
    <section className="card" aria-label="Stopped part-way">
      <h3>Stopped part-way</h3>
      <p>
        This {what} stopped at step {stop.stoppedStep ?? '?'}
        {stop.stoppedLabel ? ` (${stop.stoppedLabel})` : ''}
        {stop.status === 'cancelled' ? ', cancelled' : ''}. Every step up to step {stop.lastVerifiedStep}
        {stop.lastVerifiedLabel ? ` (${stop.lastVerifiedLabel})` : ''} succeeded and was verified.
      </p>
      {stop.reason && <p className="note note-bad">{stop.reason}</p>}
      {stop.resumes > 0 && (
        <p className="muted small-text">
          Resumed {stop.resumes} time{stop.resumes === 1 ? '' : 's'}
          {stop.lastResumedBy ? `, last by ${stop.lastResumedBy}` : ''}.
        </p>
      )}
      {view && !view.resumable && view.reason && <p className="muted">{view.reason.message}</p>}
      {view?.resumable && (
        <Button
          variant="primary"
          busy={busy}
          onClick={() => {
            void confirm({
              title: 'Resume it?',
              message: (
                <>
                  {stop.kind === 'recreate' ? (
                    <p>
                      The recreate is finished as one new proposal of only what is still missing (F2’s
                      Finish), checked against LegendKeeper again.
                    </p>
                  ) : (
                    <>
                      <p>
                        It continues from step {view.left[0]?.stepNo ?? '?'}: {view.left.length} step
                        {view.left.length === 1 ? '' : 's'} left. Its own check runs again first, inside its
                        locks
                        {view.recheck.length > 0 ? ` (step ${view.recheck.join(', ')})` : ''}; no step that
                        succeeded is sent again, and a step that is no longer safe is refused with its reason.
                      </p>
                      {view.approvedBy && (
                        <p>
                          You approved this work; it resumes without a new approval, and the resume is
                          recorded.
                        </p>
                      )}
                    </>
                  )}
                </>
              ),
              confirmLabel: 'Resume',
            }).then((ok) => {
              if (ok) void run(() => api.post(resumeUrl, { confirm: true }), 'Resumed.').then(onDone);
            });
          }}
        >
          Resume
        </Button>
      )}
      <span className="mono muted small-text">{jobId}</span>
    </section>
  );
}
