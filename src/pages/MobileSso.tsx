import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SsoStatusShell } from '../components/SsoStatusShell';
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
    <SsoStatusShell
      step={1}
      status={returnUnavailable ? 'Automatic return unavailable' : 'Checking this device'}
      detail={
        returnUnavailable
          ? 'Use the button below to continue back.'
          : 'This usually takes only a moment.'
      }
      isBusy={!returnUnavailable}
      action={
        returnUnavailable ? { label: 'RETURN', onClick: () => window.history.back() } : undefined
      }
    />
  );
}
