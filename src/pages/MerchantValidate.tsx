import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconPhone, IconShield, IconX } from '../components/Icons';
import {
  clearPasskeyHint,
  hasPasskeyHint,
  HttpError,
  submitSsoClaim,
  validateSsoReturn,
  type SsoValidateResult,
} from '../lib/pair';
import { clearTrustToken, loadTrustToken } from '../lib/device-trust';
import { isOAuthError, PROVIDERS_CONFIGURED, runOAuthProofOfLife } from '../lib/oauth';

export function MerchantValidate() {
  const [params] = useSearchParams();
  const [result, setResult] = useState<SsoValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [claimedName, setClaimedName] = useState<string | null>(null);
  const [claimCode, setClaimCode] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [needsProof, setNeedsProof] = useState(false);
  const [validating, setValidating] = useState(false);
  const [passkeySeen, setPasskeySeen] = useState(false);

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
    (async () => {
      try {
        setPasskeySeen(hasPasskeyHint());
        const trustToken = await loadTrustToken();
        if (!trustToken) {
          if (!cancelled) setNeedsProof(true);
          return;
        }
        if (!cancelled) setValidating(true);
        const r = await validateSsoReturn({
          sessionId,
          nonce,
          returnCode,
          mode: 'device-trust',
          deviceTrustToken: trustToken,
        });
        if (!cancelled) setResult(r);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) {
          await clearTrustToken();
          if (!cancelled) {
            setNeedsProof(true);
            setPasskeySeen(hasPasskeyHint());
          }
        } else if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setValidating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  const approved = result?.verdict === 'approved';
  const complete = !!result || !!error;
  const stateLabel = result
    ? approved
      ? 'VERIFIED'
      : 'NOT VERIFIED'
    : error
      ? 'NOT VERIFIED'
      : 'CHECKING';

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
        const r = await validateSsoReturn({
          sessionId,
          nonce,
          returnCode,
          mode,
        });
        if (
          mode === 'passkey-auth' &&
          r.verdict === 'failed' &&
          r.reason === 'credential_not_registered'
        ) {
          clearPasskeyHint();
          setPasskeySeen(false);
        }
        setResult(r);
      }
      setNeedsProof(false);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        setError('Proof required');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setValidating(false);
    }
  }

  async function submitName(e: { preventDefault(): void }) {
    e.preventDefault();
    const name = nameInput.trim();
    const ssoSessionId = params.get('session');
    if (!name || !ssoSessionId || claiming) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const entry = await submitSsoClaim(ssoSessionId, name);
      window.localStorage.setItem('argus-demo-claim-name', name);
      setClaimedName(name);
      setClaimCode(`${entry.code} · ${entry.count} ${entry.count === 1 ? 'entry' : 'entries'}`);
    } catch (e) {
      if (e instanceof HttpError) {
        const err = (e.bodyJson?.error as string | undefined) ?? `http_${e.status}`;
        if (err === 'rate_limited') {
          setClaimError('Entry limit reached for this device. Try again next hour.');
        } else if (err === 'session_already_entered') {
          const code = e.bodyJson?.code as string | undefined;
          setClaimError(
            code ? `This check already counted for ${code}.` : 'This check already counted.'
          );
        } else if (err === 'invalid_handle') {
          setClaimError('Use 3-64 chars: letters, digits, . _ @ -');
        } else {
          setClaimError(err);
        }
      } else {
        setClaimError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-5 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge/60 pb-4">
        <Wordmark />
        <span className="pill">{stateLabel}</span>
      </header>

      <main className="flex flex-1 flex-col gap-5">
        <section className="sso-shell p-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <span
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
                error || result?.verdict === 'failed'
                  ? 'bg-red-500/15 text-red-300'
                  : approved
                    ? 'bg-green-500/15 text-green-300'
                    : 'bg-accent/15 text-accent'
              }`}
            >
              {result ? (
                approved ? (
                  <IconCheck className="h-6 w-6" />
                ) : (
                  <IconX className="h-6 w-6" />
                )
              ) : (
                <IconShield className="h-6 w-6" />
              )}
            </span>
            <div className="min-w-0">
              <div className="label mb-2">{stateLabel}</div>
              <h1 className="text-2xl font-semibold">
                {result
                  ? approved
                    ? 'You are valid'
                    : 'Could not verify'
                  : error
                    ? 'Validation failed'
                    : 'Validating'}
              </h1>
              <div className="mt-1 text-sm text-muted">
                {needsProof
                  ? 'confirm this is really you'
                  : (result?.reason.replace(/_/g, ' ') ?? error ?? 'final merchant profile')}
              </div>
            </div>
            {validating && <span className="spinner" />}
          </div>
        </section>

        {needsProof && !result && (
          <section className="sso-side-panel p-5">
            <div className="label mb-3">proof required</div>
            <div className="grid gap-3">
              <button
                type="button"
                className="btn btn-primary w-full px-5 py-4"
                onClick={() => void runProof(passkeySeen ? 'passkey-auth' : 'passkey-create')}
                disabled={validating}
              >
                {passkeySeen ? 'Use passkey' : 'Create passkey'}
              </button>
              {PROVIDERS_CONFIGURED.google && (
                <button
                  type="button"
                  className="btn w-full px-5 py-4"
                  onClick={() => void runProof('google')}
                  disabled={validating}
                >
                  Continue with Google
                </button>
              )}
            </div>
          </section>
        )}

        <div className="sso-route">
          <div className="sso-route-node sso-route-node-done">
            <IconPhone className="h-4 w-4" />
            <span>merchant</span>
          </div>
          <div className="sso-route-line sso-route-line-active" />
          <div className="sso-route-node sso-route-node-done">
            <IconShield className="h-4 w-4" />
            <span>argus</span>
          </div>
          <div className="sso-route-line sso-route-line-active" />
          <div className={`sso-route-node ${complete ? 'sso-route-node-active' : ''}`}>
            {approved ? <IconCheck className="h-4 w-4" /> : <IconShield className="h-4 w-4" />}
            <span>return</span>
          </div>
        </div>

        {approved && (
          <section className="sso-side-panel p-5">
            {claimedName ? (
              <div>
                <div className="label text-accent-bright">name saved</div>
                <div className="mt-2 text-lg font-semibold">{claimedName}</div>
                {claimCode && <div className="mt-1 font-mono text-sm text-muted">{claimCode}</div>}
              </div>
            ) : (
              <form onSubmit={submitName} className="flex flex-col gap-3">
                <label className="label" htmlFor="claim-name">
                  Your name
                </label>
                <input
                  id="claim-name"
                  type="text"
                  autoCapitalize="words"
                  autoComplete="name"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="sso-input"
                  placeholder="name or handle"
                  minLength={2}
                  maxLength={64}
                  required
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full px-6 py-4 text-base"
                  disabled={claiming || nameInput.trim().length < 2}
                >
                  {claiming ? 'Saving...' : 'Save'}
                </button>
                {claimError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                    {claimError}
                  </div>
                )}
              </form>
            )}
          </section>
        )}

        <div className="mt-auto pt-4">
          <Link
            className="btn w-full px-6 py-4 text-center text-base"
            to={complete ? '/merchant' : '/'}
          >
            DONE
          </Link>
        </div>
      </main>
    </div>
  );
}
