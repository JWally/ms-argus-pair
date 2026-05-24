import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { awaitDesktopReady, submitPhoneAttestation, type PhoneSessionInfo } from '../lib/pair';
import { loadTrustToken } from '../lib/device-trust';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconX, IconShield } from '../components/Icons';

type Phase = 'awaiting-desktop' | 'ready' | 'returning' | 'pairing' | 'paired' | 'failed' | 'error';

export function Pair() {
  const { roomId: sessionId } = useParams<{ roomId: string }>();
  const [phase, setPhase] = useState<Phase>('awaiting-desktop');
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hasTrust, setHasTrust] = useState(false);
  const infoRef = useRef<PhoneSessionInfo | null>(null);
  const inflightRef = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    if (!sessionId) {
      queueMicrotask(() => {
        setPhase('error');
        setErrorMsg('Missing session id');
      });
      return () => ctl.abort();
    }
    (async () => {
      try {
        const [info, trustToken] = await Promise.all([
          awaitDesktopReady(sessionId, ctl.signal),
          loadTrustToken(),
        ]);
        if (ctl.signal.aborted) return;
        infoRef.current = info;
        setHasTrust(!!trustToken);
        setPhase('ready');
      } catch (e) {
        if (ctl.signal.aborted) return;
        setPhase('error');
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctl.abort();
  }, [sessionId]);

  async function pair() {
    if (!sessionId || !infoRef.current || inflightRef.current) return;
    inflightRef.current = true;
    setPhase(hasTrust ? 'returning' : 'pairing');
    setStatus('starting');
    setErrorMsg(null);
    try {
      const r = await submitPhoneAttestation(sessionId, infoRef.current, {
        onStatus: setStatus,
      });
      setVerdict(r.verdict);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
      if (r.verdict === 'paired') {
        window.setTimeout(() => {
          try {
            window.close();
          } catch {
            /* noop */
          }
        }, 1500);
      }
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      inflightRef.current = false;
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">phone</span>
      </header>

      {(phase === 'awaiting-desktop' || phase === 'pairing' || phase === 'returning') && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/20 text-accent">
              <IconShield className="h-10 w-10" />
            </div>
          </div>
          <div>
            <div className="text-lg font-semibold">
              {phase === 'awaiting-desktop'
                ? 'Waiting for the desktop'
                : phase === 'returning'
                ? 'Welcome back'
                : 'Verifying'}
            </div>
            <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
              <span className="spinner" />
              <span className="pulse-fade">
                {status ||
                  (phase === 'awaiting-desktop'
                    ? 'about a second'
                    : phase === 'returning'
                    ? 'remembered this device'
                    : 'working')}
              </span>
            </div>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent/15 text-accent">
            <IconShield className="h-12 w-12" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {hasTrust ? 'Welcome back' : 'Prove you’re real'}
            </h1>
            <p className="text-sm leading-relaxed text-muted">
              {hasTrust
                ? 'We remember this device. One tap to confirm.'
                : 'One tap. Your phone’s Secure Enclave will confirm this is a real device, and an integrity scan runs alongside it.'}
            </p>
          </div>
          <button onClick={pair} className="btn btn-primary w-full py-4 text-base">
            {hasTrust ? '✓ Confirm' : '🫀 Proof of Life'}
          </button>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted/70">
            {hasTrust ? 'Trusted device · same network' : 'Biometric · no account · no password'}
          </div>
        </div>
      )}

      {phase === 'paired' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/15 text-green-300">
            <IconCheck className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">Verified</div>
            <p className="text-sm text-muted">
              You can close this tab. The desktop has the result.
            </p>
          </div>
        </div>
      )}

      {phase === 'failed' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/15 text-red-300">
            <IconX className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">Not verified</div>
            <p className="text-sm text-muted">{verdict}</p>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/15 text-red-300">
            <IconX className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">Something went wrong</div>
            <p className="break-all text-xs text-muted">{errorMsg}</p>
          </div>
        </div>
      )}
    </div>
  );
}
