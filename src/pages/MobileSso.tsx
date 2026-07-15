import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconShield } from '../components/Icons';
import { startSsoSession } from '../lib/pair';
import { failureReturnUrlFrom, rememberSsoFailureReturnUrl } from '../lib/sso-failure-return';

export function MobileSso() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const started = useRef(false);
  const [returnUnavailable, setReturnUnavailable] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const cpi = params.get('cpi');
    const challengeId = params.get('challengeId');
    const callbackUrl = params.get('returnUrl');
    if (!cpi || !challengeId || !callbackUrl) {
      queueMicrotask(() => setReturnUnavailable(true));
      return;
    }
    let cancelled = false;
    void startSsoSession(challengeId, cpi, { challengeId, callbackUrl })
      .then((session) => {
        if (cancelled) return;
        window.sessionStorage.setItem(`argus-demo-sso-nonce:${session.sessionId}`, session.nonce);
        rememberSsoFailureReturnUrl(session.sessionId, session.failureReturnUrl);
        const challengeParams = new URLSearchParams({ n: session.nonce, cpi: session.cpi });
        void navigate(`${session.challengeUrl}?${challengeParams.toString()}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failureReturnUrl = failureReturnUrlFrom(cause);
        if (failureReturnUrl) {
          window.location.replace(failureReturnUrl);
        } else {
          setReturnUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, params]);

  return (
    <div className="argus-page">
      <div className="argus-layout">
        <header className="argus-header">
          <Wordmark />
          <span className="pill">Mobile check</span>
        </header>
        <main className="argus-main">
          <section className="sso-shell text-center" aria-live="polite">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-accent/50 bg-accent/15 text-accent">
              <IconShield className="h-8 w-8" />
            </div>
            <div className="mt-5 label">Argus</div>
            <h1 className="mt-2 text-2xl font-semibold">
              {returnUnavailable ? 'Return to merchant' : 'Checking this device'}
            </h1>
            <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted">
              {!returnUnavailable && <span className="spinner" />}
              <span>
                {returnUnavailable
                  ? 'The handoff could not finish automatically.'
                  : 'You will return automatically'}
              </span>
            </div>
            {returnUnavailable && (
              <button
                className="merchant-done mt-6"
                type="button"
                onClick={() => window.history.back()}
              >
                RETURN
              </button>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
