import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SsoStatusShell } from '../components/SsoStatusShell';
import { submitSsoChallenge } from '../lib/pair';
import {
  failureReturnUrlFrom,
  loadSsoFailureReturnUrl,
  rememberSsoFailureReturnUrl,
} from '../lib/sso-failure-return';

function ReturnFallback() {
  return (
    <SsoStatusShell
      step={2}
      status="Automatic return unavailable"
      detail="Use the button below to continue back."
      action={{ label: 'RETURN', onClick: () => window.history.back() }}
    />
  );
}

export function SsoChallenge() {
  const navigate = useNavigate();
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
        navigate(challenge.returnUrl, { replace: true });
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
  }, [cpi, navigate, nonce, sessionId]);

  if (!sessionId || !nonce || !cpi || returnUnavailable) return <ReturnFallback />;

  return (
    <SsoStatusShell
      step={2}
      status="Confirming this session"
      detail="You will return automatically."
      isBusy
    />
  );
}
