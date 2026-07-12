import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MerchantWordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';
import {
  clearPasskeyHint,
  hasPasskeyHint,
  HttpError,
  validateSsoReturn,
  type SsoValidateResult,
} from '../lib/pair';
import { clearTrustToken, loadTrustToken } from '../lib/device-trust';
import { isOAuthError, PROVIDERS_CONFIGURED, runOAuthProofOfLife } from '../lib/oauth';

export function MerchantValidate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [result, setResult] = useState<SsoValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [validating, setValidating] = useState(false);
  const [passkeySeen, setPasskeySeen] = useState(false);
  const sessionId = params.get('session');
  const approved = result?.verdict === 'approved';
  const failed = !!error || result?.verdict === 'failed';

  useEffect(() => {
    const sessionId = params.get('session');
    const returnCode = params.get('code');
    if (!sessionId || !returnCode) {
      queueMicrotask(() => setError('Missing return material'));
      return;
    }
    const nonce = window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`);
    if (!nonce) {
      queueMicrotask(() => setError('Missing merchant session state'));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        setPasskeySeen(hasPasskeyHint());
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
    if (!approved || !sessionId) return;
    navigate(`/merchant?complete=1&session=${encodeURIComponent(sessionId)}`, {
      replace: true,
    });
  }, [approved, navigate, sessionId]);

  async function runProof(mode: 'passkey-create' | 'passkey-auth' | 'google') {
    const sessionId = params.get('session');
    const returnCode = params.get('code');
    if (!sessionId || !returnCode || validating) return;
    const nonce = window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`);
    if (!nonce) {
      setError('Missing merchant session state');
      return;
    }
    setValidating(true);
    setError(null);
    try {
      if (mode === 'google') {
        const oauthResult = await runOAuthProofOfLife('google', nonce);
        if (isOAuthError(oauthResult)) {
          setError(oauthResult.error);
          return;
        }
        setResult(
          await validateSsoReturn({
            sessionId,
            nonce,
            returnCode,
            mode: 'oauth',
            oauthResult,
          })
        );
      } else {
        const validation = await validateSsoReturn({
          sessionId,
          nonce,
          returnCode,
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
            <p className="merchant-eyebrow">Merchant response</p>
            <h1>
              {approved
                ? 'Returning to merchant'
                : failed
                  ? 'Session is Not Valid'
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
              <div className="merchant-proof-actions">
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
