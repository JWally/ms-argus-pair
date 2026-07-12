import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconShield } from '../components/Icons';
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
    <div className="argus-page">
      <div className="argus-layout">
        <header className="argus-header">
          <Wordmark />
          <span className="pill">Argus secure check</span>
        </header>

        <main className="argus-main">
          <section className="sso-shell text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/50 bg-accent/15 text-accent">
              <IconShield className="h-8 w-8" />
            </div>
            <div className="mt-5 label">Argus</div>
            <h1 className="mt-2 text-2xl font-semibold">
              {error ? 'Session check failed' : 'Checking this session'}
            </h1>
            <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted">
              {!error && <span className="spinner" />}
              <span>{error ?? 'You will return to the merchant automatically'}</span>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
