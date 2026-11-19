import { useState, type FormEvent } from 'react';
import { api, apiConfig, formText } from '../api';
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
import { fmtTime } from '../format';
import { useApi, useNow } from '../hooks';
import { QrCode } from '../qr';
import { useReauth } from '../reauth';
import type { SecurityInfo } from '../types';

/**
 * The owner's account (OPS2, ADR 0062): the sessions (30 days from their last use) and "Sign out everywhere", the
 * password, the authenticator app and its recovery codes, and the encrypted secret store's state. Every sensitive change
 * asks for the step-up (the authenticator code, or the password without one) if the last is over ten minutes old. Two
 * things are shown once and never again: the authenticator secret while it is being set up, and recovery codes.
 */
export function AccountPage() {
  const s = useApi<SecurityInfo>('/security');
  const now = useNow();
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const until = d.reauth.until !== null && d.reauth.until > now ? d.reauth.until : null;
  return (
    <>
      <PageHeader title="Account">
        <button type="button" className="small" onClick={s.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        Signed in as <strong>{d.username}</strong>.{' '}
        {until
          ? `You confirmed it is you for sensitive changes until ${fmtTime(until)}.`
          : `Sensitive changes (keys, scopes, settings, pack approvals, deletes and bulk changes) ask for ${d.totp.enabled ? 'an authenticator code' : 'your password'} again.`}
      </p>
      <SessionsCard info={d} />
      {!d.totp.enabled && (
        <section className="card card-alert" aria-labelledby="totp-advice-h">
          <h2 id="totp-advice-h">Turn on the authenticator app</h2>
          <p>
            API keys can now be added and replaced from this dashboard, so your password alone guards them. An
            authenticator app (a code on your phone at every sign-in) stops anyone who learns the password.
          </p>
        </section>
      )}
      {d.warnings.length > 0 && (
        <section className="card" aria-labelledby="acct-warn-h">
          <h2 id="acct-warn-h">The env file and the store</h2>
          <ul className="plain">
            {d.warnings.map((w) => (
              <li key={w} className="note note-warn small-text">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TotpCard info={d} onChanged={s.reload} />
      <PasswordCard info={d} onChanged={s.reload} />
      <StoreCard info={d} />
    </>
  );
}

/** ADR 0062: the sessions kept on the server, and "Sign out everywhere" (this one included). */
function SessionsCard({ info }: { info: SecurityInfo }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const s = info.sessions;
  const signOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out everywhere?',
      message: 'Every signed-in dashboard ends, this one included. You will sign in again here.',
      confirmLabel: 'Sign out everywhere',
      danger: true,
    });
    if (!ok) return;
    const r = await run(() =>
      api.post<{ revoked: number }>('/security/sessions/revoke-all', { confirm: true }),
    );
    // Signed out here too: the sign-in page, which brings the owner back to this page.
    if (r) apiConfig.onUnauthenticated();
  };
  return (
    <section className="card" aria-labelledby="sessions-h">
      <h2 id="sessions-h">Sessions</h2>
      <p>
        A session lasts 30 days from its last use.
        {s ? ` ${s.active} ${s.active === 1 ? 'is' : 'are'} signed in now.` : ''}
        {s?.thisEndsAt ? ` This one ends ${fmtTime(s.thisEndsAt)} unless you use it before then.` : ''}
      </p>
      <div className="actions">
        <Button onClick={() => void signOutEverywhere()} disabled={busy}>
          Sign out everywhere
        </Button>
      </div>
    </section>
  );
}

function PasswordCard({ info, onChanged }: { info: SecurityInfo; onChanged: () => void }) {
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const toast = useToast();
  const [mismatch, setMismatch] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const f = new FormData(formEl);
    const next = formText(f, 'new');
    if (next !== formText(f, 'repeat')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    void run(() =>
      withReauth(() =>
        api.post<{ otherSessionsSignedOut: number }>('/security/password', {
          currentPassword: formText(f, 'current'),
          newPassword: next,
        }),
      ),
    ).then((r) => {
      if (!r) return;
      formEl.reset();
      toast(
        'ok',
        `Password changed. ${r.otherSessionsSignedOut === 1 ? 'One other session was' : `${r.otherSessionsSignedOut} other sessions were`} signed out.`,
      );
      onChanged();
    });
  };
  return (
    <section className="card" aria-labelledby="pw-h">
      <h2 id="pw-h">Password</h2>
      {info.password.problem && <p className="note note-bad">{info.password.problem}</p>}
      <p className="muted small-text">
        {info.password.source === 'store'
          ? 'Kept in the encrypted store (Argon2id).'
          : 'Still read from the env file (OWNER_PASSWORD_HASH): changing it here moves it into the encrypted store.'}{' '}
        Changing it signs out every other dashboard session; this one stays signed in.
      </p>
      <form className="stack-form" onSubmit={submit} autoComplete="off">
        <label htmlFor="pw-current">Current password</label>
        <input id="pw-current" name="current" type="password" autoComplete="current-password" required />
        <label htmlFor="pw-new">New password (at least 12 characters)</label>
        <input id="pw-new" name="new" type="password" autoComplete="new-password" minLength={12} required />
        <label htmlFor="pw-repeat">New password again</label>
        <input
          id="pw-repeat"
          name="repeat"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        {mismatch && (
          <p className="note note-bad" role="alert">
            The two new passwords differ.
          </p>
        )}
        <div className="actions">
          <Button busy={busy} type="submit" className="primary" disabled={!info.store.available}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="recovery" data-testid="recovery-codes">
      <p className="note note-warn">
        Your recovery codes, shown <strong>once</strong>. Each signs you in once instead of an authenticator
        code, if you lose your phone. Keep them somewhere safe and offline; the bridge keeps only their
        hashes.
      </p>
      <ul className="codes mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="actions">
        <CopyButton text={codes.join('\n')} label="Copy all" what="the recovery codes" />
        <button type="button" className="primary" onClick={onDone}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

function TotpCard({ info, onChanged }: { info: SecurityInfo; onChanged: () => void }) {
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const t = info.totp;

  if (codes) {
    return (
      <section className="card" aria-labelledby="totp-h">
        <h2 id="totp-h">Authenticator app</h2>
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            onChanged();
          }}
        />
      </section>
    );
  }

  const start = () =>
    void run(() =>
      withReauth(() => api.post<{ secret: string; otpauthUri: string }>('/security/totp/enrol')),
    ).then((r) => r && setEnrol(r));
  const finish = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), 'code');
    void run(() =>
      withReauth(() => api.post<{ recoveryCodes: string[] }>('/security/totp/confirm', { code })),
    ).then((r) => {
      if (!r) return;
      setEnrol(null);
      setCodes(r.recoveryCodes);
      toast('ok', 'The authenticator is on: sign-in now asks for a code.');
    });
  };
  const remove = () =>
    void confirm({
      title: 'Remove the authenticator?',
      message: (
        <p>
          Sign-in will ask for your password only, and your recovery codes stop working. Anyone with your
          password could then change the API keys here.
        </p>
      ),
      confirmLabel: 'Remove it',
      danger: true,
    }).then(
      (ok) =>
        ok &&
        void run(
          () => withReauth(() => api.post('/security/totp/remove', { confirm: true })),
          'The authenticator was removed.',
        ).then(onChanged),
    );
  const regenerate = () =>
    void confirm({
      title: 'Make new recovery codes?',
      message: <p>The old codes stop working at once; the new ones are shown once.</p>,
      confirmLabel: 'Make new codes',
    }).then(
      (ok) =>
        ok &&
        void run(() =>
          withReauth(() =>
            api.post<{ recoveryCodes: string[] }>('/security/recovery-codes', { confirm: true }),
          ),
        ).then((r) => r && setCodes(r.recoveryCodes)),
    );

  return (
    <section className="card" aria-labelledby="totp-h">
      <h2 id="totp-h">
        Authenticator app {t.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="warn">off</Badge>}
      </h2>
      {t.problem && <p className="note note-bad">{t.problem}</p>}
      {t.enabled ? (
        <>
          <p className="small-text">
            Sign-in and sensitive changes ask for a code from your app.{' '}
            {t.source === 'env'
              ? 'It was set up in the env file (OWNER_TOTP_SECRET).'
              : 'It is kept in the encrypted store.'}{' '}
            Recovery codes left: <strong>{t.recoveryCodesLeft}</strong>.
          </p>
          <div className="actions">
            <Button busy={busy} onClick={regenerate} disabled={!info.store.available}>
              New recovery codes…
            </Button>
            <Button busy={busy} className="danger" onClick={remove} disabled={!info.store.available}>
              Remove the authenticator…
            </Button>
          </div>
        </>
      ) : enrol ? (
        <div className="enrol">
          <p>
            Scan this with your authenticator app (for example Google Authenticator, 1Password or Aegis), or
            type the secret below into it. Then enter the 6-digit code it shows to switch it on.
          </p>
          <QrCode value={enrol.otpauthUri} label="QR code for your authenticator app" />
          <p className="small-text">
            Secret (shown during set-up only): <span className="mono secret-text">{enrol.secret}</span>{' '}
            <CopyButton text={enrol.secret} label="Copy" what="the secret" />
          </p>
          <form className="stack-form" onSubmit={finish} autoComplete="off">
            <label htmlFor="totp-code">Code from the app</label>
            <input
              id="totp-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              required
            />
            <div className="actions">
              <button type="button" onClick={() => setEnrol(null)}>
                Cancel
              </button>
              <Button busy={busy} type="submit" className="primary">
                Switch it on
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <p className="small-text">
            Off: sign-in asks for your password only. Turning it on is strongly recommended now that keys can
            be managed here.
          </p>
          <div className="actions">
            <Button busy={busy} className="primary" onClick={start} disabled={!info.store.available}>
              Set up the authenticator…
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function StoreCard({ info }: { info: SecurityInfo }) {
  const st = info.store;
  return (
    <section className="card" aria-labelledby="store-h">
      <h2 id="store-h">Encrypted secret store</h2>
      {st.problem ? (
        <p className="note note-bad" role="alert">
          {st.problem}
        </p>
      ) : (
        <p className="small-text">
          <Badge tone="ok">working</Badge> {st.stored} secret(s) stored, encrypted with the master key{' '}
          <span className="mono">{st.keyId}</span> (SECRETS_MASTER_KEY in the env file; this is its
          fingerprint, not the key).
        </p>
      )}
      {st.underPrevious > 0 && (
        <p className="note note-warn small-text">
          {st.underPrevious} secret(s) are still sealed with the previous master key: finish the rotation
          (runbook, “Rotating the master key”).
        </p>
      )}
      <p className="muted small-text">
        Keys added on the Projects page, the password and the authenticator live here, encrypted
        (AES-256-GCM). The env file keeps only the master key.
      </p>
    </section>
  );
}
