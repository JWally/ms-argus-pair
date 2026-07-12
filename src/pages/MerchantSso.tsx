import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MerchantWordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';
import { defaultSsoCpi, redeemSsoApproval, startSsoSession } from '../lib/pair';

const CAPTCHA_DEMO_URL = 'https://www-dev-jw.argus.pw/captcha';
type MerchantStatus = 'idle' | 'profiling' | 'redeeming' | 'approved' | 'error';

function newMerchantSessionId(): string {
  const existing = window.sessionStorage.getItem('argus-demo-merchant-session');
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.sessionStorage.setItem('argus-demo-merchant-session', id);
  return id;
}

function MerchantResult({ status, error }: { status: MerchantStatus; error: string | null }) {
  const approved = status === 'approved';
  const failed = status === 'error';
  return (
    <div className="merchant-result" aria-live="polite">
      <span
        className={`merchant-result-icon ${approved ? 'is-approved' : failed ? 'is-failed' : ''}`}
      >
        {approved ? (
          <IconCheck className="h-7 w-7" />
        ) : failed ? (
          <IconX className="h-7 w-7" />
        ) : (
          <span className="spinner merchant-spinner" />
        )}
      </span>
      <p className="merchant-eyebrow">Merchant response</p>
      <h1>
        {approved
          ? 'Session is Valid'
          : failed
            ? 'Session could not be confirmed'
            : 'Confirming session'}
      </h1>
      <p className={approved ? 'merchant-approved' : 'merchant-copy'}>
        {approved ? 'approved' : failed ? error : 'redeeming approval'}
      </p>
      {approved && (
        <a className="merchant-done merchant-done-flat" href={CAPTCHA_DEMO_URL}>
          DONE
        </a>
      )}
    </div>
  );
}

function MerchantLaunch({
  profiling,
  error,
  onBegin,
}: {
  profiling: boolean;
  error: string | null;
  onBegin: () => Promise<void>;
}) {
  return (
    <>
      <p className="merchant-eyebrow">Single sign-on</p>
      <h1>Try the SSO demo</h1>
      <p className="merchant-copy">
        No account or sign-in is required. Argus will check this session, then return you here
        automatically.
      </p>
      <button
        type="button"
        className="merchant-primary"
        onClick={() => void onBegin()}
        disabled={profiling}
      >
        {profiling ? 'Opening Argus...' : 'Run demo'}
      </button>
      {error && <div className="merchant-error">{error}</div>}
    </>
  );
}

export function MerchantSso() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isReturn = params.get('complete') === '1';
  const approvalSessionId = params.get('session');
  const requestedCpi = params.get('cpi');
  const expectedCpi = requestedCpi ?? defaultSsoCpi();
  const [status, setStatus] = useState<MerchantStatus>(isReturn ? 'redeeming' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const merchantSessionId = useMemo(() => newMerchantSessionId(), []);

  useEffect(() => {
    if (!isReturn) return;
    if (!approvalSessionId || !requestedCpi) {
      queueMicrotask(() => {
        setStatus('error');
        setError('Missing approval binding');
      });
      return;
    }
    let cancelled = false;
    void redeemSsoApproval(approvalSessionId, requestedCpi)
      .then(() => {
        if (cancelled) return;
        window.sessionStorage.removeItem('argus-demo-merchant-session');
        setStatus('approved');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [approvalSessionId, isReturn, requestedCpi]);

  useEffect(() => {
    if (status !== 'approved') return;
    const timer = window.setTimeout(() => {
      window.location.assign(CAPTCHA_DEMO_URL);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function begin() {
    setStatus('profiling');
    setError(null);
    try {
      const session = await startSsoSession(merchantSessionId, expectedCpi);
      window.sessionStorage.setItem(`argus-demo-sso-nonce:${session.sessionId}`, session.nonce);
      const challengeParams = new URLSearchParams({ n: session.nonce, cpi: session.cpi });
      navigate(`${session.challengeUrl}?${challengeParams.toString()}`);
    } catch (cause) {
      setStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const returned = isReturn || status === 'approved';

  return (
    <div className="merchant-page">
      <div className="merchant-layout">
        <header className="merchant-header">
          <MerchantWordmark />
          <span className="merchant-secured">
            <IconShield className="h-4 w-4" /> Secured by Argus
          </span>
        </header>

        <main className="merchant-main">
          <section className="merchant-card">
            {returned ? (
              <MerchantResult status={status} error={error} />
            ) : (
              <MerchantLaunch profiling={status === 'profiling'} error={error} onBegin={begin} />
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
