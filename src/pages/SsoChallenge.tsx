import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconPhone, IconShield } from '../components/Icons';
import { submitSsoChallenge } from '../lib/pair';

export function SsoChallenge() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      queueMicrotask(() => setError('Missing SSO session'));
      return;
    }
    const nonce =
      params.get('n') ?? window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`);
    if (!nonce) {
      queueMicrotask(() => setError('Missing SSO nonce'));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await submitSsoChallenge(sessionId, nonce);
        if (cancelled) return;
        window.sessionStorage.setItem(`argus-demo-sso-nonce:${sessionId}`, nonce);
        navigate(r.returnUrl, { replace: true });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, params, sessionId]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-5 py-6 sm:px-6 sm:py-10">
      <header className="flex items-center justify-between border-b border-edge/60 pb-4">
        <Wordmark />
        <span className="pill">hosted check</span>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-5">
        <section className="sso-shell text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/50 bg-accent/15 text-accent">
            <IconShield className="h-8 w-8" />
          </div>
          <div className="mt-5 label">argus hosted leg</div>
          <h1 className="mt-2 text-2xl font-semibold">
            {error ? 'Challenge failed' : 'Profiling device'}
          </h1>
          <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted">
            {!error && <span className="spinner" />}
            <span>{error ?? 'binding this browser to the merchant session'}</span>
          </div>
        </section>

        <div className="sso-route">
          <div className="sso-route-node sso-route-node-done">
            <IconPhone className="h-4 w-4" />
            <span>merchant</span>
          </div>
          <div className="sso-route-line sso-route-line-active" />
          <div className="sso-route-node sso-route-node-active">
            <IconShield className="h-4 w-4" />
            <span>argus</span>
          </div>
          <div className="sso-route-line" />
          <div className="sso-route-node">
            <IconCheck className="h-4 w-4" />
            <span>return</span>
          </div>
        </div>
      </main>
    </div>
  );
}
