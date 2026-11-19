import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ApiError, api, apiConfig, formText } from './api';

/**
 * OPS2, ADR 0062: the step-up for sensitive actions (keys and secrets, scope changes, settings, pack approval, the
 * guarded rails' approvals, the account). The bridge answers such a request with 403 `REAUTH_REQUIRED` unless the owner
 * stepped up on this session in the last ten minutes: the authenticator code (or a recovery code), or the password when
 * no authenticator is set up. Every request's answer of that kind opens this dialog (`apiConfig.onReauthRequired`, set
 * here), which confirms it with the bridge, and the request is sent once more; `withReauth(fn)` does the same around a
 * whole function. Cancelling rejects with `REAUTH_CANCELLED`, which `useAction` shows no toast for.
 *
 * The code or password never leaves this dialog except in the one request to `/api/admin/security/reauth`; it is not
 * kept.
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

  // One dialog at a time: requests refused together (a page sending two changes at once) wait for the same answer.
  const waiting = useRef<Promise<void> | null>(null);
  const ask = useCallback(() => {
    if (waiting.current) return waiting.current;
    const asked = new Promise<void>((resolve, reject) => {
      setError(null);
      setPending({ resolve, reject });
      api
        .get<{ totp?: { enabled?: boolean } }>('/security')
        .then((s) => setTotp(s.totp?.enabled === true))
        .catch(() => undefined);
    }).finally(() => {
      waiting.current = null;
    });
    waiting.current = asked;
    return asked;
  }, []);

  // ADR 0062: every request answered REAUTH_REQUIRED asks here, then is sent again (api.ts).
  useEffect(() => {
    apiConfig.onReauthRequired = ask;
    return () => {
      if (apiConfig.onReauthRequired === ask) delete apiConfig.onReauthRequired;
    };
  }, [ask]);

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
      // ADR 0062: the authenticator code (or a recovery code) when one is set up, else the password.
      await api.post('/security/reauth', totp ? { totp: code } : { password });
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
                  This is a sensitive change, so the bridge asks for{' '}
                  {totp ? 'an authenticator code' : 'your password'} again. It lasts ten minutes.
                </p>
                {error && (
                  <p className="note note-bad" role="alert">
                    {error}
                  </p>
                )}
                {totp ? (
                  <>
                    <label htmlFor="reauth-code">Authenticator code (or a recovery code)</label>
                    <input
                      id="reauth-code"
                      name="code"
                      autoComplete="one-time-code"
                      inputMode="text"
                      maxLength={40}
                      required
                      autoFocus
                    />
                  </>
                ) : (
                  <>
                    <label htmlFor="reauth-password">Password</label>
                    <input
                      id="reauth-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      autoFocus
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
