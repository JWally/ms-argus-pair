import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconShield } from '../components/Icons';
import { submitSsoChallenge } from '../lib/pair';
import {
  failureReturnUrlFrom,
  loadSsoFailureReturnUrl,
  rememberSsoFailureReturnUrl,
} from '../lib/sso-failure-return';

function SsoStatus({
  title,
  message,
  isChecking = false,
  onReturn,
}: {
  title: string;
  message: string;
  isChecking?: boolean;
  onReturn?: () => void;
}) {
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
            <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
            <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted">
              {isChecking && <span className="spinner" />}
              <span>{message}</span>
            </div>
            {onReturn && (
              <button className="merchant-done mt-6" type="button" onClick={onReturn}>
                RETURN
              </button>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function ReturnFallback() {
  return (
    <SsoStatus
      title="Return to merchant"
      message="The handoff could not finish automatically."
      onReturn={() => window.history.back()}
    />
  );
}

export function SsoChallenge() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [params] = useSearchParams();
  const [returnUnavailable, setReturnUnavailable] = useState(false);
  const nonce = sessionId
    ? (params.get('n') ?? window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`))
    : null;
  const cpi = params.get('cpi');

  useEffect(() => {
    if (!sessionId || !nonce || !cpi) return;
    let cancelled = false;
    void submitSsoChallenge(sessionId, nonce, cpi)
      .then((challenge) => {
        if (cancelled) return;
        window.sessionStorage.setItem(`argus-demo-sso-nonce:${sessionId}`, nonce);
        window.location.replace(challenge.returnUrl);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const failureReturnUrl = failureReturnUrlFrom(cause) ?? loadSsoFailureReturnUrl(sessionId);
        if (failureReturnUrl) {
          rememberSsoFailureReturnUrl(sessionId, failureReturnUrl);
          window.location.replace(failureReturnUrl);
        } else {
          setReturnUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cpi, nonce, sessionId]);

  if (!sessionId || !nonce || !cpi || returnUnavailable) return <ReturnFallback />;

  return (
    <SsoStatus
      title="Checking this session"
      message="You will return to the merchant automatically"
      isChecking
    />
  );
}
