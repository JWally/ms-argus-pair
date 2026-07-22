import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MerchantWordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';
import { SsoStatusShell } from '../components/SsoStatusShell';
import { HttpError } from '../lib/json-http';
import { validateSsoReturn, type SsoValidateResult } from '../lib/sso-client';
import { clearTrustToken, loadTrustToken } from '../lib/device-trust';
import { isOAuthError, PROVIDERS_CONFIGURED, runGoogleProofOfLife } from '../lib/oauth';
import { clearPasskeyHint, hasPasskeyHint } from '../lib/passkey-client';
import { loadSsoFailureReturnUrl } from '../lib/sso-failure-return';

export function MerchantValidate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [result, setResult] = useState<SsoValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [validating, setValidating] = useState(false);
  const [passkeySeen, setPasskeySeen] = useState(false);
  const sessionId = params.get('session');
  const cpi = params.get('cpi');
  const isMerchantCallback = params.get('flow') === 'merchant';
  const approved = result?.verdict === 'approved';
  const failed = !!error || result?.verdict === 'failed';
  const returningToSite = isMerchantCallback && (approved || failed);

  useEffect(() => {
    const sessionId = params.get('session');
    const returnCode = params.get('code');
    const cpi = params.get('cpi');
    if (!sessionId || !returnCode || !cpi) {
      queueMicrotask(() => setError('Missing return material'));
      return;
    }
    const nonce = window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`);
    if (!nonce) {
      queueMicrotask(() => setError('Missing session state'));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        setPasskeySeen(hasPasskeyHint());
        if (cpi.endsWith('.fastpass')) {
          if (!cancelled) setValidating(true);
          const validation = await validateSsoReturn({
            sessionId,
            nonce,
            returnCode,
            cpi,
            mode: 'integrity-only',
          });
          if (!cancelled) setResult(validation);
          return;
        }
        if (cpi.endsWith('.forceauth')) {
          if (!cancelled) setNeedsProof(true);
          return;
        }
        const trustToken = await loadTrustToken();
        if (!trustToken) {
          if (!cancelled) setNeedsProof(true);
          return;
        }
        if (!cancelled) setValidating(true);
        const validation = await validateSsoReturn({
          sessionId,
          nonce,
          returnCode,
          cpi,
          mode: 'device-trust',
          deviceTrustToken: trustToken,
        });
        if (!cancelled) setResult(validation);
      } catch (cause) {
        if (cause instanceof HttpError && cause.status === 401) {
          await clearTrustToken();
          if (!cancelled) {
            setNeedsProof(true);
            setPasskeySeen(hasPasskeyHint());
          }
        } else if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setValidating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (!sessionId || !cpi) return;
    if (isMerchantCallback) {
      if (result?.merchantCallbackUrl && result.merchantChallengeId) {
        const callback = new URL(result.merchantCallbackUrl);
        callback.searchParams.set('session', sessionId);
        callback.searchParams.set('cpi', cpi);
        callback.searchParams.set('challengeId', result.merchantChallengeId);
        if (approved && result.approvalCode) {
          callback.searchParams.set('code', result.approvalCode);
        } else if (failed) {
          callback.searchParams.set('status', 'failed');
        } else {
          return;
        }
        window.location.replace(callback.toString());
        return;
      }
      if (approved || failed) {
        const failureReturnUrl = loadSsoFailureReturnUrl(sessionId);
        if (failureReturnUrl) window.location.replace(failureReturnUrl);
      }
      return;
    }
    if (!approved) return;
    const merchantParams = new URLSearchParams({ complete: '1', session: sessionId, cpi });
    navigate(`/merchant?${merchantParams.toString()}`, {
      replace: true,
    });
  }, [approved, cpi, failed, isMerchantCallback, navigate, result, sessionId]);

  async function runProof(mode: 'passkey-create' | 'passkey-auth' | 'google') {
    const sessionId = params.get('session');
    const returnCode = params.get('code');
    const cpi = params.get('cpi');
    if (!sessionId || !returnCode || !cpi || validating) return;
    const nonce = window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`);
    if (!nonce) {
      setError('Missing session state');
      return;
    }
    setValidating(true);
    setError(null);
    try {
      if (mode === 'google') {
        const oauthResult = await runGoogleProofOfLife(nonce);
        if (isOAuthError(oauthResult)) {
          setError(oauthResult.error);
          return;
        }
        setResult(
          await validateSsoReturn({
            sessionId,
            nonce,
            returnCode,
            cpi,
            mode: 'oauth',
            oauthResult,
          })
        );
      } else {
        const validation = await validateSsoReturn({
          sessionId,
          nonce,
          returnCode,
          cpi,
          mode,
        });
        if (
          mode === 'passkey-auth' &&
          validation.verdict === 'failed' &&
          validation.reason === 'credential_not_registered'
        ) {
          clearPasskeyHint();
          setPasskeySeen(false);
        }
        setResult(validation);
      }
      setNeedsProof(false);
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 401) {
        setError('Proof required');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setValidating(false);
    }
  }

  function renderProofActions(className: string) {
    if (!needsProof || result) return null;
    return (
      <div className={className}>
        <button
          type="button"
          className="merchant-primary"
          onClick={() => void runProof(passkeySeen ? 'passkey-auth' : 'passkey-create')}
          disabled={validating}
        >
          {passkeySeen ? 'Use passkey' : 'Create passkey'}
        </button>
        {passkeySeen && (
          <button
            type="button"
            className="merchant-secondary"
            onClick={() => void runProof('passkey-create')}
            disabled={validating}
          >
            Create passkey
          </button>
        )}
        {PROVIDERS_CONFIGURED.google && (
          <button
            type="button"
            className="merchant-secondary"
            onClick={() => void runProof('google')}
            disabled={validating}
          >
            Continue with Google
          </button>
        )}
      </div>
    );
  }

  if (isMerchantCallback) {
    const callbackStatus = returningToSite
      ? 'Returning securely'
      : needsProof
        ? 'Confirm your identity'
        : error
          ? 'Automatic return unavailable'
          : 'Completing secure check';
    const callbackDetail = returningToSite
      ? 'Finishing the secure handoff.'
      : needsProof
        ? error
          ? 'That verification did not complete. Try another option.'
          : 'Choose a verification method to continue.'
        : error
          ? 'Use the button below to continue back.'
          : 'This usually takes only a moment.';

    return (
      <SsoStatusShell
        step={3}
        status={callbackStatus}
        detail={callbackDetail}
        isBusy={validating || returningToSite}
        action={
          error && !needsProof && !returningToSite
            ? { label: 'RETURN', onClick: () => window.history.back() }
            : undefined
        }
      >
        {renderProofActions('sso-proof-actions')}
      </SsoStatusShell>
    );
  }

  return (
    <div className="merchant-page">
      <div className="merchant-layout merchant-layout-narrow">
        <header className="merchant-header">
          <MerchantWordmark />
          <span className="merchant-secured">
            <IconShield className="h-4 w-4" /> Returned from Argus
          </span>
        </header>

        <main className="merchant-main">
          <section className="merchant-card merchant-result" aria-live="polite">
            <span
              className={`merchant-result-icon ${approved ? 'is-approved' : failed ? 'is-failed' : ''}`}
            >
              {approved ? (
                <IconCheck className="h-7 w-7" />
              ) : failed ? (
                <IconX className="h-7 w-7" />
              ) : (
                <IconShield className="h-7 w-7" />
              )}
            </span>
            <p className="merchant-eyebrow">Site response</p>
            <h1>
              {approved
                ? 'Returning securely'
                : failed
                  ? 'Session could not be confirmed'
                  : needsProof
                    ? 'Confirm your identity'
                    : 'Validating session'}
            </h1>
            <p className={approved ? 'merchant-approved' : 'merchant-copy'}>
              {approved
                ? 'redeeming approval'
                : needsProof
                  ? 'proof required'
                  : (result?.reason.replace(/_/g, ' ') ?? error ?? 'checking return')}
            </p>
            {validating && <span className="spinner merchant-spinner" />}
          </section>

          {needsProof && !result && (
            <section className="merchant-proof">
              <p className="merchant-eyebrow">Proof required</p>
              {renderProofActions('merchant-proof-actions')}
            </section>
          )}

          {failed && (
            <Link className="merchant-done" to="/merchant">
              BACK
            </Link>
          )}
        </main>
      </div>
    </div>
  );
}
