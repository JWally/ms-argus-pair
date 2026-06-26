import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PROVIDERS_CONFIGURED } from '../lib/oauth';
import { runHostedChallenge, tryHostedTrustChallenge } from '../lib/hosted';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';

type Phase = 'ready' | 'working' | 'done' | 'error';

function readQuery() {
  const params = new URLSearchParams(window.location.search);
  return {
    merchantId: params.get('m') ?? '',
    state: params.get('state') ?? '',
    nonce: params.get('n') ?? '',
  };
}

export function HostedVerify() {
  const { hostedSessionId } = useParams<{ hostedSessionId: string }>();
  const query = useMemo(() => readQuery(), []);
  const [phase, setPhase] = useState<Phase>('ready');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const triedTrustRef = useRef(false);

  async function verify(mode: 'passkey-auth' | 'passkey-create' | 'google') {
    if (!hostedSessionId || !query.nonce) {
      setPhase('error');
      setError('Missing verification session');
      return;
    }
    setPhase('working');
    setStatus(mode === 'google' ? 'opening google' : 'checking this phone');
    setError(null);
    try {
      const result = await runHostedChallenge(hostedSessionId, query.nonce, mode);
      setStatus('returning');
      window.location.assign(result.callbackUrl);
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (triedTrustRef.current || !hostedSessionId || !query.nonce) return;
    triedTrustRef.current = true;
    let alive = true;
    void (async () => {
      setPhase('working');
      setStatus('checking saved device');
      const result = await tryHostedTrustChallenge(hostedSessionId, query.nonce);
      if (!alive) return;
      if (result) {
        setStatus('returning');
        window.location.assign(result.callbackUrl);
      } else {
        setPhase('ready');
        setStatus('');
      }
    })().catch((e) => {
      if (!alive) return;
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
    };
  }, [hostedSessionId, query.nonce]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">verify</span>
      </header>

      {phase === 'ready' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent/15 text-accent">
            <IconShield className="h-12 w-12" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Verify this phone</h1>
            <p className="text-sm leading-relaxed text-muted">
              Complete one proof and we&apos;ll send you back to the checkout.
            </p>
          </div>
          <div className="w-full space-y-3">
            <button
              onClick={() => verify('passkey-auth')}
              className="btn btn-primary w-full py-4 text-base"
            >
              Use existing passkey
            </button>
            {PROVIDERS_CONFIGURED.google && (
              <button onClick={() => verify('google')} className="btn w-full py-4 text-base">
                Continue with Google
              </button>
            )}
            <button onClick={() => verify('passkey-create')} className="btn w-full py-4 text-base">
              Create a new passkey
            </button>
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted/70">
            {query.merchantId || 'merchant'} · mobile redirect
          </div>
        </div>
      )}

      {phase === 'working' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/20 text-accent">
              <IconShield className="h-10 w-10" />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
            <span className="spinner" />
            <span className="pulse-fade">{status || 'working'}</span>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/15 text-green-300">
            <IconCheck className="h-10 w-10" />
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/15 text-red-300">
            <IconX className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">Verification failed</div>
            <p className="break-all text-xs text-muted">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
