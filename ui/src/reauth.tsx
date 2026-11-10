import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ApiError, api, formText } from './api';

/**
 * OPS2: re-authentication for sensitive actions (adding, replacing or removing a key; the password; the authenticator).
 * The bridge answers such a request with 403 `REAUTH_REQUIRED` unless the owner confirmed their password (and
 * authenticator code) in the last five minutes. `withReauth(fn)` runs `fn`; on that answer it asks for the password
 * (and code) in a dialog, confirms them with the bridge, and runs `fn` once more. Cancelling rejects with
 * `REAUTH_CANCELLED`, which `useAction` shows no toast for.
 *
 * The password never leaves this dialog except in the one request to `/api/admin/security/reauth`; it is not kept.
 */

type WithReauth = <T>(fn: () => Promise<T>) => Promise<T>;
const ReauthContext = createContext<WithReauth>((fn) => fn());
export const useReauth = () => useContext(ReauthContext);

export const isReauthCancelled = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'REAUTH_CANCELLED';

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
}

export function ReauthProvider({ children, totp: initialTotp }: { children: ReactNode; totp: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Whether to ask for a code: known at sign-in, and checked again each time the dialog opens (the authenticator may
  // have been set up or removed since).
  const [totp, setTotp] = useState(initialTotp);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const ask = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        setError(null);
        setPending({ resolve, reject });
        api
          .get<{ totp?: { enabled?: boolean } }>('/security')
          .then((s) => setTotp(s.totp?.enabled === true))
          .catch(() => undefined);
      }),
    [],
  );

  const withReauth = useCallback<WithReauth>(
    async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'REAUTH_REQUIRED')) throw e;
      }
      await ask();
      return fn();
    },
    [ask],
  );

  const cancel = () => {
    pending?.reject(new ApiError(0, 'REAUTH_CANCELLED', 'Cancelled.'));
    setPending(null);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = formText(data, 'password');
    const code = formText(data, 'code').trim();
    setBusy(true);
    try {
      await api.post('/security/reauth', { password, ...(code ? { totp: code } : {}) });
      form.current?.reset();
      const p = pending;
      setPending(null);
      p?.resolve();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReauthContext.Provider value={withReauth}>
      {children}
      {pending && (
        <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && cancel()}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
            <h2 id="reauth-title">Confirm it’s you</h2>
            <form ref={form} onSubmit={(e) => void submit(e)} autoComplete="off">
              <div className="dialog-body">
                <p>
                  This changes a key or your sign-in, so the bridge asks for your password
                  {totp ? ' and an authenticator code' : ''} again. It lasts five minutes.
                </p>
                {error && (
                  <p className="note note-bad" role="alert">
                    {error}
                  </p>
                )}
                <label htmlFor="reauth-password">Password</label>
                <input
                  id="reauth-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                />
                {totp && (
                  <>
                    <label htmlFor="reauth-code">Authenticator code (or a recovery code)</label>
                    <input
                      id="reauth-code"
                      name="code"
                      autoComplete="one-time-code"
                      maxLength={40}
                      required
                    />
                  </>
                )}
              </div>
              <div className="actions">
                <button type="button" onClick={cancel}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Checking…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </ReauthContext.Provider>
  );
}
