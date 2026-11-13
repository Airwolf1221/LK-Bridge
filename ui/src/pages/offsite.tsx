import { useEffect, useState, type FormEvent } from 'react';
import { api, formText } from '../api';
import {
  Badge,
  Button,
  CopyButton,
  ErrorNote,
  Loading,
  PageHeader,
  useAction,
  useConfirm,
  useToast,
} from '../components';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtTime } from '../format';
import { useApi, useNow } from '../hooks';
import { useReauth } from '../reauth';
import { useRoute } from '../router';

/**
 * The off-site copy to Google Drive (v2 E1b, ADR 0043; docs/dashboard.md › Off-site copy): the Google connection, the
 * encryption keys, the last and next copies, the Drive folder, the verify results, the settings and the disaster-recovery
 * link. The copy itself is done by a separate service on the server; this page sets it up, asks it for a copy or a
 * verify, and shows what it recorded.
 */

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

interface Run {
  id: number;
  kind: 'copy' | 'verify' | 'delete_folder' | 'restore';
  trigger: string;
  folder: string | null;
  startedAt: number;
  endedAt: number | null;
  state: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'refused';
  bytes: number | null;
  files: number | null;
  errors: number | null;
  exitCode: number | null;
  rcloneVersion: string | null;
  message: string | null;
  findings?: number;
}

interface Folder {
  generation: number;
  path: string;
  createdAt: number;
  firstCopyAt: number | null;
  lastGoodCopyAt: number | null;
  adoptedAt: number | null;
  retiredAt: number | null;
  retiredReason: string | null;
  deleteRequestedAt: number | null;
  deletedAt: number | null;
}

interface Settings {
  folder: string;
  copyTime: string;
  deletedRetentionDays: number;
  bandwidthLimit: string;
  transfers: number;
  verifyEnabled: boolean;
  verifyDay: number;
  verifyTime: string;
  verifySamplePercent: number;
  verifySampleMin: number;
  staleAfterDays: number;
}

export interface OffsiteStatus {
  redirectUri: string;
  client: { saved: boolean; clientId: string | null; secretHint: string | null; savedAt: number | null };
  connection: {
    state: 'none' | 'connected' | 'broken';
    account: { email: string | null; name: string | null } | null;
    connectedAt: number | null;
    brokenAt: number | null;
    brokenReason: string | null;
    tokenCheckedAt: number | null;
  };
  keys: {
    set: boolean;
    setAt: number | null;
    source: 'generated' | 'entered' | null;
    newFolderOnChange: boolean;
  };
  settings: Settings;
  settingsProblems: string[];
  folder: Folder;
  folders: Folder[];
  configured: { ready: boolean; missing: string[] };
  health: { state: 'not_set_up' | 'ok' | 'warning' | 'bad'; messages: string[] };
  running: Run | null;
  lastCopy: Run | null;
  lastGoodCopy: Run | null;
  nextCopyAt: number;
  nextCopyWithinMs: number;
  verify: {
    last: Run | null;
    lastFindings: { id: number; kind: string; path: string | null; detail: string | null }[];
    history: Run[];
    nextAt: number | null;
  };
  runs: Run[];
  pending: { kind: string; trigger: string; at: number }[];
  now: number;
}

const DOCS = 'https://github.com/Airwolf1221/LK-Bridge/blob/main/docs';
const RUN_TONE: Record<Run['state'], Tone> = {
  running: 'info',
  succeeded: 'ok',
  failed: 'bad',
  interrupted: 'warn',
  refused: 'warn',
};
const RUN_LABEL: Record<Run['state'], string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  interrupted: 'Interrupted',
  refused: 'Refused',
};
const TRIGGER_LABEL: Record<string, string> = {
  schedule: 'scheduled',
  request: 'requested',
  after_full: 'after a full snapshot',
  cli: 'from the server',
};
const ERROR_TEXT: Record<string, string> = {
  OFFSITE_STATE_MISMATCH:
    'Google’s answer did not belong to a sign-in started from this browser session. Nothing was changed: connect again.',
  OFFSITE_STATE_EXPIRED: 'The sign-in took more than 10 minutes. Connect again.',
  OFFSITE_NO_SESSION:
    'You were not signed in to the dashboard when Google answered. Sign in, then connect again.',
  OFFSITE_GOOGLE_DENIED: 'Access was not allowed at Google. Nothing was changed.',
  OFFSITE_GOOGLE_REFUSED:
    'Google refused the sign-in. Check the client ID and secret, and that the redirect URI matches (docs/drive-setup.md).',
  OFFSITE_SCOPE:
    'Google did not grant the Drive permission (it must be allowed on the consent page). Nothing was kept: connect again.',
};

export const RunBadge = ({ run }: { run: Run }) => (
  <Badge tone={RUN_TONE[run.state]}>{RUN_LABEL[run.state]}</Badge>
);

export function OffsitePage() {
  const s = useApi<OffsiteStatus>('/offsite');
  const { query, navigate } = useRoute();
  const toast = useToast();
  const back = query.get('drive');
  const backError = query.get('drive_error');
  useEffect(() => {
    if (back === 'connected') toast('ok', 'Google Drive connected.');
    if (backError) toast('error', ERROR_TEXT[backError] ?? `Google Drive was not connected (${backError}).`);
    if (back || backError) navigate('/offsite', { replace: true });
  }, [back, backError, toast, navigate]);
  // While a run is going, look again every few seconds (the runner is a separate service, with no live events).
  const running = s.data?.running !== null && s.data?.running !== undefined;
  useEffect(() => {
    if (!running && !(s.data?.pending.length ?? 0)) return;
    const t = setInterval(s.reload, 5000);
    return () => clearInterval(t);
  }, [running, s.data?.pending.length, s.reload]);

  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  return (
    <>
      <PageHeader title="Off-site copy">
        <button type="button" className="small" onClick={s.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        An encrypted copy of the snapshot store and the nightly database copies on your Google Drive, made by
        a separate service on the server with rclone. Google sees only encrypted files with encrypted names.{' '}
        <a href={`${DOCS}/drive-setup.md`} target="_blank" rel="noreferrer">
          The one-off Google set-up
        </a>{' '}
        ·{' '}
        <a
          href={`${DOCS}/runbook-deploy.md#disaster-recovery-from-google-drive`}
          target="_blank"
          rel="noreferrer"
        >
          Disaster recovery
        </a>
      </p>
      {d.health.state !== 'ok' && d.health.state !== 'not_set_up' && (
        <section
          className={`card ${d.health.state === 'bad' ? 'card-alert' : ''}`}
          aria-labelledby="off-health-h"
        >
          <h2 id="off-health-h">{d.health.state === 'bad' ? 'Needs attention' : 'Warning'}</h2>
          <ul className="plain">
            {d.health.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      )}
      <DriveCard d={d} onChanged={s.reload} />
      <KeysCard d={d} onChanged={s.reload} />
      <CopyCard d={d} onChanged={s.reload} />
      <VerifyCard d={d} onChanged={s.reload} />
      <FolderCard d={d} onChanged={s.reload} />
      <SettingsCard d={d} onChanged={s.reload} />
      <HistoryCard d={d} />
    </>
  );
}

// ================================================================================================ Google Drive

function DriveCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const withReauth = useReauth();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const toast = useToast();
  const c = d.connection;
  const tone: Tone = c.state === 'connected' ? 'ok' : c.state === 'broken' ? 'bad' : 'neutral';
  const label =
    c.state === 'connected' ? 'Connected' : c.state === 'broken' ? 'Needs reconnecting' : 'Not connected';
  const saveClient = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(() =>
      withReauth(() =>
        api.put<{ disconnected: boolean }>('/offsite/client', {
          clientId: formText(f, 'clientId').trim(),
          clientSecret: formText(f, 'clientSecret').trim(),
        }),
      ),
    ).then((r) => {
      if (!r) return;
      form.reset();
      toast(
        'ok',
        r.disconnected ? 'Client saved. It differs from the connected one: connect again.' : 'Client saved.',
      );
      onChanged();
    });
  };
  const connect = () =>
    void run(() => withReauth(() => api.post<{ url: string }>('/offsite/connect'))).then((r) => {
      if (r) window.location.assign(r.url);
    });
  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect Google Drive?',
      message:
        'The bridge revokes its access at Google and deletes its saved sign-in. Copies stop until you connect again. The files already on Drive stay there.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    const r = await run(() =>
      withReauth(() =>
        api.post<{ revoked: boolean; message: string | null }>('/offsite/disconnect', { confirm: true }),
      ),
    );
    if (r) {
      toast(r.revoked ? 'ok' : 'error', r.message ?? 'Disconnected; Google confirmed the access is revoked.');
      onChanged();
    }
  };
  const check = () =>
    void run(() => api.post<{ ok: boolean; message: string | null }>('/offsite/check')).then((r) => {
      if (r) {
        toast(
          r.ok ? 'ok' : 'error',
          r.ok ? 'Google accepted the saved sign-in.' : (r.message ?? 'Google refused it.'),
        );
        onChanged();
      }
    });
  return (
    <section
      className={`card ${c.state === 'broken' ? 'card-alert' : ''}`}
      aria-labelledby="drive-h"
      data-testid="drive-card"
    >
      <h2 id="drive-h">
        Google Drive <Badge tone={tone}>{label}</Badge>
      </h2>
      {c.account && (
        <p>
          Account: <strong>{c.account.name ?? ''}</strong> {c.account.email ? `<${c.account.email}>` : ''}
          {c.connectedAt && <span className="muted"> · connected {fmtTime(c.connectedAt)}</span>}
        </p>
      )}
      {c.state === 'broken' && <p className="note note-bad">{c.brokenReason}</p>}
      <p className="small-text muted">
        Redirect URI for the Google client (docs/drive-setup.md, step 6): <code>{d.redirectUri}</code>{' '}
        <CopyButton text={d.redirectUri} what="the redirect URI" />
      </p>
      {d.client.saved ? (
        <p className="small-text">
          Client: <code>{d.client.clientId}</code>, secret ending <code>{d.client.secretHint}</code>
          {d.client.savedAt && <> (saved {fmtTime(d.client.savedAt)})</>}. Kept in the encrypted secret store.
        </p>
      ) : (
        <p className="small-text">
          Paste the Client ID and Client secret from Google Cloud (docs/drive-setup.md).
        </p>
      )}
      <details open={!d.client.saved}>
        <summary>{d.client.saved ? 'Replace the client' : 'The Google client'}</summary>
        <form className="stack-form" onSubmit={saveClient} autoComplete="off">
          <label htmlFor="off-client-id">Client ID</label>
          <input id="off-client-id" name="clientId" required placeholder="….apps.googleusercontent.com" />
          <label htmlFor="off-client-secret">Client secret</label>
          <input id="off-client-secret" name="clientSecret" type="password" required autoComplete="off" />
          <div className="actions">
            <Button type="submit" variant="primary" busy={busy}>
              Save the client
            </Button>
          </div>
        </form>
      </details>
      <div className="actions">
        {d.client.saved && c.state !== 'connected' && (
          <Button variant="primary" busy={busy} onClick={connect}>
            {c.state === 'broken' ? 'Reconnect' : 'Connect Google Drive'}
          </Button>
        )}
        {c.state === 'connected' && (
          <Button busy={busy} onClick={check}>
            Check the connection
          </Button>
        )}
        {c.state !== 'none' && (
          <Button variant="danger" busy={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        )}
      </div>
    </section>
  );
}

// ================================================================================================ keys

interface Generated {
  confirmId: string;
  password: string;
  salt: string;
  confirmChars: number;
  newFolder: boolean;
}

function KeysCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const withReauth = useReauth();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const toast = useToast();
  const [gen, setGen] = useState<Generated | null>(null);
  const [own, setOwn] = useState(false);
  const askNewFolder = async (): Promise<boolean> =>
    !d.keys.newFolderOnChange ||
    confirm({
      title: 'New keys mean a new Drive folder',
      message:
        'A copy already exists with the current keys. With new keys the next copy is a fresh full upload into a new Drive folder. The old folder stays on Drive (readable only with the old keys) until you delete it on this page. Keep the old keys until then.',
      confirmLabel: 'Use the new keys',
      acknowledge: 'I understand: a fresh full upload into a new folder',
    });

  const generate = () =>
    void run(() => withReauth(() => api.post<Generated>('/offsite/keys/generate'))).then(
      (r) => r && setGen(r),
    );
  const saveGenerated = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!gen) return;
    const f = new FormData(e.currentTarget);
    if (!(await askNewFolder())) return;
    const r = await run(() =>
      withReauth(() =>
        api.post('/offsite/keys/confirm', {
          confirmId: gen.confirmId,
          passwordEnd: formText(f, 'passwordEnd'),
          saltEnd: formText(f, 'saltEnd'),
          acknowledgeNewFolder: d.keys.newFolderOnChange,
        }),
      ),
    );
    if (r) {
      setGen(null);
      toast('ok', 'Encryption keys saved.');
      onChanged();
    }
  };
  const saveOwn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      formText(f, 'password') !== formText(f, 'password2') ||
      formText(f, 'salt') !== formText(f, 'salt2')
    ) {
      toast('error', 'The two copies of the password, or of the salt, differ.');
      return;
    }
    if (!(await askNewFolder())) return;
    const r = await run(() =>
      withReauth(() =>
        api.put('/offsite/keys', {
          password: formText(f, 'password'),
          salt: formText(f, 'salt'),
          acknowledgeNewFolder: d.keys.newFolderOnChange,
        }),
      ),
    );
    if (r) {
      form.reset();
      setOwn(false);
      toast('ok', 'Encryption keys saved.');
      onChanged();
    }
  };
  return (
    <section className="card" aria-labelledby="keys-h" data-testid="keys-card">
      <h2 id="keys-h">
        Encryption keys <Badge tone={d.keys.set ? 'ok' : 'warn'}>{d.keys.set ? 'Set' : 'Not set'}</Badge>
      </h2>
      <p className="small-text">
        {d.keys.set
          ? `Set ${d.keys.setAt ? fmtTime(d.keys.setAt) : ''} (${d.keys.source === 'generated' ? 'generated here' : 'entered by you'}). They are never shown again.`
          : 'A password and a second password (the salt), for rclone crypt. Files and their names are encrypted.'}
      </p>
      {gen ? (
        <form
          className="stack-form"
          onSubmit={(e) => void saveGenerated(e)}
          autoComplete="off"
          data-testid="generated"
        >
          <p className="note note-warn">
            <strong>Shown once.</strong> Without these, the Drive copy cannot be restored; keep them somewhere
            other than this server, such as a password manager, with the SECRETS_MASTER_KEY and the
            authenticator’s recovery codes.
          </p>
          <label htmlFor="gen-pw">Password</label>
          <div>
            <code id="gen-pw" className="secret-value">
              {gen.password}
            </code>{' '}
            <CopyButton text={gen.password} what="the password" />
          </div>
          <label htmlFor="gen-salt">Salt (the second password)</label>
          <div>
            <code id="gen-salt" className="secret-value">
              {gen.salt}
            </code>{' '}
            <CopyButton text={gen.salt} what="the salt" />
          </div>
          <p className="small-text">
            Once both are saved in your password manager, type their last {gen.confirmChars} characters to
            confirm. Nothing is saved before that.
          </p>
          <label htmlFor="gen-pw-end">Last {gen.confirmChars} characters of the password</label>
          <input id="gen-pw-end" name="passwordEnd" required maxLength={64} autoComplete="off" />
          <label htmlFor="gen-salt-end">Last {gen.confirmChars} characters of the salt</label>
          <input id="gen-salt-end" name="saltEnd" required maxLength={64} autoComplete="off" />
          <div className="actions">
            <Button type="submit" variant="primary" busy={busy}>
              I have saved them: use these keys
            </Button>
            <Button onClick={() => setGen(null)}>Discard</Button>
          </div>
        </form>
      ) : own ? (
        <form className="stack-form" onSubmit={(e) => void saveOwn(e)} autoComplete="off">
          <label htmlFor="own-pw">Password (at least 16 characters)</label>
          <input
            id="own-pw"
            name="password"
            type="password"
            minLength={16}
            required
            autoComplete="new-password"
          />
          <label htmlFor="own-pw2">Password again</label>
          <input
            id="own-pw2"
            name="password2"
            type="password"
            minLength={16}
            required
            autoComplete="new-password"
          />
          <label htmlFor="own-salt">Salt, a second password (at least 16 characters, not the same)</label>
          <input
            id="own-salt"
            name="salt"
            type="password"
            minLength={16}
            required
            autoComplete="new-password"
          />
          <label htmlFor="own-salt2">Salt again</label>
          <input
            id="own-salt2"
            name="salt2"
            type="password"
            minLength={16}
            required
            autoComplete="new-password"
          />
          <div className="actions">
            <Button type="submit" variant="primary" busy={busy}>
              Save my keys
            </Button>
            <Button onClick={() => setOwn(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          {d.keys.set && d.keys.newFolderOnChange && (
            <p className="note note-warn small-text">
              A copy exists with these keys: changing them means a fresh full upload into a new Drive folder
              (the old one is kept until you delete it below).
            </p>
          )}
          <div className="actions">
            <Button variant={d.keys.set ? 'default' : 'primary'} busy={busy} onClick={generate}>
              {d.keys.set ? 'Generate new keys' : 'Generate keys'}
            </Button>
            <Button busy={busy} onClick={() => setOwn(true)}>
              Enter my own
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ================================================================================================ copies

function runFacts(r: Run, now: number) {
  return (
    <>
      <RunBadge run={r} /> {fmtTime(r.startedAt)} ({fmtAgo(r.startedAt, now)},{' '}
      {TRIGGER_LABEL[r.trigger] ?? r.trigger})
      {r.endedAt !== null && <> · took {fmtDuration(r.endedAt - r.startedAt)}</>}
      {r.bytes !== null && <> · {fmtBytes(r.bytes)}</>}
      {r.files !== null && <> · {fmtInt(r.files)} files</>}
      {r.errors ? <> · {fmtInt(r.errors)} errors</> : null}
      {r.exitCode !== null && r.exitCode !== 0 && <> · rclone exit {r.exitCode}</>}
    </>
  );
}

function CopyCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const now = useNow(30_000);
  const { run, busy } = useAction();
  const copyNow = () =>
    void run(
      () => api.post('/offsite/copy', { confirm: true }),
      'Copy requested: the off-site service starts it in a few seconds.',
    ).then((r) => r && onChanged());
  const pendingCopy = d.pending.some((p) => p.kind === 'copy');
  // A request the off-site service has not taken for 10 minutes: its units are probably not installed or not running.
  const stale = d.pending.find((p) => now - p.at > 10 * 60_000);
  return (
    <section className="card" aria-labelledby="copy-h" data-testid="copy-card">
      <h2 id="copy-h">Copies</h2>
      {d.running && (
        <p className="note">
          {d.running.kind === 'copy' ? 'A copy' : d.running.kind === 'verify' ? 'A verify' : 'A run'} is
          running since {fmtTime(d.running.startedAt)}.
        </p>
      )}
      <dl className="facts">
        <dt>Last copy</dt>
        <dd>{d.lastCopy ? runFacts(d.lastCopy, now) : 'None yet.'}</dd>
        {d.lastCopy?.message && d.lastCopy.state !== 'succeeded' && (
          <>
            <dt>Why</dt>
            <dd className="note note-bad small-text">{d.lastCopy.message}</dd>
          </>
        )}
        <dt>Last good copy</dt>
        <dd>
          {d.folder.lastGoodCopyAt
            ? `${fmtTime(d.folder.lastGoodCopyAt)} (${fmtAgo(d.folder.lastGoodCopyAt, now)})`
            : 'None yet.'}
        </dd>
        <dt>Next scheduled copy</dt>
        <dd>
          {d.configured.ready
            ? d.nextCopyAt <= now
              ? 'Due now (within a quarter of an hour)'
              : `${fmtTime(d.nextCopyAt)} (daily at ${d.settings.copyTime}, London time; also after each weekly full snapshot)`
            : `Not until ${d.configured.missing.join(' and ')} ${d.configured.missing.length === 1 ? 'is' : 'are'} set up.`}
        </dd>
        {d.lastCopy?.rcloneVersion && (
          <>
            <dt>rclone</dt>
            <dd>{d.lastCopy.rcloneVersion}</dd>
          </>
        )}
      </dl>
      {stale && (
        <p className="note note-warn small-text" data-testid="stale-request">
          A request from {fmtTime(stale.at)} has not been taken by the off-site service. Check that its units
          are installed and running:{' '}
          <code>systemctl status lk-bridge-offsite.path lk-bridge-offsite.timer</code> (runbook, “Off-site
          copy to Google Drive”).
        </p>
      )}
      <div className="actions">
        <Button
          variant="primary"
          busy={busy}
          disabled={!d.configured.ready || (pendingCopy && !stale)}
          onClick={copyNow}
        >
          {pendingCopy && !stale ? 'Copy requested' : 'Copy now'}
        </Button>
      </div>
    </section>
  );
}

function VerifyCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const now = useNow(30_000);
  const { run, busy } = useAction();
  const v = d.verify;
  const verifyNow = () =>
    void run(() => api.post('/offsite/verify', { confirm: true }), 'Verify requested.').then(
      (r) => r && onChanged(),
    );
  const pending = d.pending.some((p) => p.kind === 'verify');
  return (
    <section
      className={`card ${v.last?.state === 'failed' ? 'card-alert' : ''}`}
      aria-labelledby="verify-h"
      data-testid="verify-card"
    >
      <h2 id="verify-h">Verify</h2>
      <p className="small-text muted">
        Downloads and decrypts every manifest and a sample of the pieces ({d.settings.verifySamplePercent}% of
        them, at least {d.settings.verifySampleMin}), re-hashes each against its name, checks every manifest’s
        pieces are on Drive, and runs SQLite’s integrity check on the newest database copy.
      </p>
      <dl className="facts">
        <dt>Last verify</dt>
        <dd>{v.last ? runFacts(v.last, now) : 'None yet.'}</dd>
        {v.last?.message && (
          <>
            <dt>Result</dt>
            <dd className={v.last.state === 'succeeded' ? 'small-text' : 'note note-bad small-text'}>
              {v.last.message}
            </dd>
          </>
        )}
        <dt>Next</dt>
        <dd>
          {v.nextAt
            ? `${fmtTime(v.nextAt)} (monthly on day ${d.settings.verifyDay} at ${d.settings.verifyTime})`
            : 'Monthly verify is off.'}
        </dd>
      </dl>
      {v.lastFindings.length > 0 && (
        <table className="table">
          <caption>Findings of the last verify</caption>
          <thead>
            <tr>
              <th>What</th>
              <th>Piece</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {v.lastFindings.map((f) => (
              <tr key={f.id}>
                <td>
                  <Badge tone="bad">{f.kind.replace(/_/g, ' ')}</Badge>
                </td>
                <td>
                  <code>{f.path}</code>
                </td>
                <td className="small-text">{f.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.history.length > 1 && (
        <details>
          <summary>History</summary>
          <ul className="plain small-text">
            {v.history.map((r) => (
              <li key={r.id}>
                {runFacts(r, now)} {r.message && <span className="muted">· {r.message}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="actions">
        <Button
          busy={busy}
          disabled={!d.configured.ready || pending || !d.folder.firstCopyAt}
          onClick={verifyNow}
        >
          {pending ? 'Verify requested' : 'Verify now'}
        </Button>
      </div>
    </section>
  );
}

// ================================================================================================ folders

function FolderCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const withReauth = useReauth();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const old = d.folders.filter((f) => f.generation !== d.folder.generation && f.deletedAt === null);
  const foreign = d.lastCopy?.state === 'refused' && /did not make/.test(d.lastCopy.message ?? '');
  const del = async (f: Folder) => {
    const ok = await confirm({
      title: `Delete "${f.path}" from Drive?`,
      message:
        'The old copy goes to Drive’s bin (Google empties it after 30 days). The current folder is not touched. After that, the old keys are no longer needed.',
      confirmLabel: 'Delete the old folder',
      danger: true,
      acknowledge: 'I do not need this old copy',
    });
    if (ok)
      void run(
        () => withReauth(() => api.post(`/offsite/folders/${f.generation}/delete`, { confirm: true })),
        'Deletion requested.',
      ).then((r) => r && onChanged());
  };
  const adopt = async () => {
    const ok = await confirm({
      title: 'Copy into this existing folder?',
      message:
        'The folder already holds a copy this database did not make (after a recovery from a fresh database, say). Copying into it replaces what differs; replaced pieces are kept in its deleted/ area for the retention. If you meant to recover from it, run the disaster recovery first.',
      confirmLabel: 'Use this folder',
      acknowledge: 'This folder is mine and I want to copy into it',
    });
    if (ok)
      void run(
        () => withReauth(() => api.post('/offsite/adopt', { confirm: true })),
        'The folder will be used.',
      ).then((r) => r && onChanged());
  };
  return (
    <section className="card" aria-labelledby="folder-h">
      <h2 id="folder-h">Drive folder</h2>
      <p>
        <code>{d.folder.path}</code>{' '}
        <span className="muted small-text">
          (inside it, everything is encrypted, names too; removed pieces stay in its deleted/ area for{' '}
          {d.settings.deletedRetentionDays} days)
        </span>
      </p>
      {foreign && (
        <div className="note note-warn">
          The last copy was refused: this folder already holds a copy this database did not make.{' '}
          <Button busy={busy} onClick={() => void adopt()}>
            Use this folder
          </Button>
        </div>
      )}
      {old.length > 0 && (
        <table className="table">
          <caption>Old folders (kept until you delete them)</caption>
          <thead>
            <tr>
              <th>Folder</th>
              <th>Why it was replaced</th>
              <th>Last good copy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {old.map((f) => (
              <tr key={f.generation}>
                <td>
                  <code>{f.path}</code>
                </td>
                <td>{f.retiredReason}</td>
                <td>{f.lastGoodCopyAt ? fmtTime(f.lastGoodCopyAt) : '—'}</td>
                <td>
                  {f.deleteRequestedAt ? (
                    'Deletion requested'
                  ) : (
                    <Button variant="danger" busy={busy} onClick={() => void del(f)}>
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ================================================================================================ settings

function SettingsCard({ d, onChanged }: { d: OffsiteStatus; onChanged: () => void }) {
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const s = d.settings;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (n: string) => Number(formText(f, n));
    const settings = {
      folder: formText(f, 'folder').trim(),
      copyTime: formText(f, 'copyTime'),
      deletedRetentionDays: num('deletedRetentionDays'),
      bandwidthLimit: formText(f, 'bandwidthLimit').trim(),
      transfers: num('transfers'),
      verifyEnabled: f.get('verifyEnabled') === 'on',
      verifyDay: num('verifyDay'),
      verifyTime: formText(f, 'verifyTime'),
      verifySamplePercent: num('verifySamplePercent'),
      verifySampleMin: num('verifySampleMin'),
      staleAfterDays: num('staleAfterDays'),
    };
    let ack = false;
    if (settings.folder !== s.folder && d.keys.newFolderOnChange) {
      ack = await confirm({
        title: 'A new folder means a fresh full upload',
        message:
          'A copy exists in the current folder. The next copy goes in full into the new one; the old folder is kept until you delete it.',
        confirmLabel: 'Change the folder',
      });
      if (!ack) return;
    }
    const r = await run(
      () => api.put('/offsite/settings', { settings, acknowledgeNewFolder: ack }),
      'Settings saved.',
    );
    if (r) onChanged();
  };
  return (
    <section className="card" aria-labelledby="off-settings-h">
      <h2 id="off-settings-h">Settings</h2>
      {d.settingsProblems.length > 0 && (
        <ul className="plain">
          {d.settingsProblems.map((p) => (
            <li key={p} className="note note-warn small-text">
              {p}
            </li>
          ))}
        </ul>
      )}
      <form className="stack-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="os-folder">Drive folder</label>
        <input id="os-folder" name="folder" defaultValue={s.folder} required maxLength={500} />
        <label htmlFor="os-time">Daily copy at (London time)</label>
        <input id="os-time" name="copyTime" type="time" defaultValue={s.copyTime} required />
        <label htmlFor="os-ret">Keep removed pieces on Drive for (days)</label>
        <input
          id="os-ret"
          name="deletedRetentionDays"
          type="number"
          min={1}
          max={3650}
          defaultValue={s.deletedRetentionDays}
        />
        <label htmlFor="os-bw">Bandwidth limit (e.g. 2M; empty for none)</label>
        <input id="os-bw" name="bandwidthLimit" defaultValue={s.bandwidthLimit} />
        <label htmlFor="os-tr">Parallel transfers</label>
        <input id="os-tr" name="transfers" type="number" min={1} max={16} defaultValue={s.transfers} />
        <label className="inline" htmlFor="os-ve">
          <input id="os-ve" name="verifyEnabled" type="checkbox" defaultChecked={s.verifyEnabled} /> Verify
          monthly
        </label>
        <label htmlFor="os-vd">Verify on day of the month</label>
        <input id="os-vd" name="verifyDay" type="number" min={1} max={28} defaultValue={s.verifyDay} />
        <label htmlFor="os-vt">Verify at (London time)</label>
        <input id="os-vt" name="verifyTime" type="time" defaultValue={s.verifyTime} />
        <label htmlFor="os-vp">Verify sample (% of pieces)</label>
        <input
          id="os-vp"
          name="verifySamplePercent"
          type="number"
          min={0}
          max={100}
          step="0.1"
          defaultValue={s.verifySamplePercent}
        />
        <label htmlFor="os-vm">Verify at least this many pieces</label>
        <input id="os-vm" name="verifySampleMin" type="number" min={0} defaultValue={s.verifySampleMin} />
        <label htmlFor="os-st">Warn on the Overview when the last good copy is older than (days)</label>
        <input
          id="os-st"
          name="staleAfterDays"
          type="number"
          min={0.5}
          max={365}
          step="0.5"
          defaultValue={s.staleAfterDays}
        />
        <div className="actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save settings
          </Button>
        </div>
      </form>
    </section>
  );
}

function HistoryCard({ d }: { d: OffsiteStatus }) {
  const now = useNow(30_000);
  if (d.runs.length === 0) return null;
  return (
    <section className="card" aria-labelledby="off-runs-h">
      <h2 id="off-runs-h">Runs</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>What</th>
            <th>Result</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {d.runs.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.kind.replace('_', ' ')}</td>
              <td>{runFacts(r, now)}</td>
              <td className="small-text">{r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
