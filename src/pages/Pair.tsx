import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { awaitDesktopReady, submitPhoneAttestation, type PhoneSessionInfo } from '../lib/pair';
import { loadTrustToken } from '../lib/device-trust';
import { isOAuthError, PROVIDERS_CONFIGURED, runGoogleProofOfLife } from '../lib/oauth';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconX, IconShield } from '../components/Icons';

function GoogleGlyph(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.71H.957v2.332A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.4 5.4 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A9 9 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A9 9 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

type Phase =
  | 'awaiting-desktop'
  | 'ready'
  | 'returning'
  | 'pairing'
  | 'paired'
  | 'failed'
  | 'taken'
  | 'timeout'
  | 'error';

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
        const msg = e instanceof Error ? e.message : String(e);
        // The desktop took too long to scan, or the session TTL ran
        // out before we got here. Both are routine, not faults.
        if (msg.includes("didn't finish scanning") || msg.includes('session expired')) {
          setPhase('timeout');
        } else {
          setPhase('error');
          setErrorMsg(msg);
        }
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
      const msg = e instanceof Error ? e.message : String(e);
      // Server distinguishes "QR is already paired with a different
      // device" from generic errors. Show a calmer screen.
      if (msg.includes('session_paired_with_other_device')) {
        setPhase('taken');
      } else {
        setPhase('error');
        setErrorMsg(msg);
      }
    } finally {
      inflightRef.current = false;
    }
  }

  async function pairWithGoogle() {
    if (!sessionId || !infoRef.current || inflightRef.current) return;
    inflightRef.current = true;
    setPhase('pairing');
    setStatus('opening google');
    setErrorMsg(null);
    try {
      const oauth = await runGoogleProofOfLife(infoRef.current.nonce);
      if (isOAuthError(oauth)) {
        throw new Error(`google: ${oauth.error}`);
      }
      setStatus('signed in — running integrity scan');
      const r = await submitPhoneAttestation(
        sessionId,
        infoRef.current,
        { onStatus: setStatus },
        { mode: 'oauth', oauthResult: oauth }
      );
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
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('session_paired_with_other_device')) {
        setPhase('taken');
      } else {
        setPhase('error');
        setErrorMsg(msg);
      }
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
            {hasTrust ? 'Confirm' : 'Proof of Life'}
          </button>
          {PROVIDERS_CONFIGURED.google && !hasTrust && (
            <>
              <div className="flex w-full items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-muted/50">
                <span className="h-px flex-1 bg-edge/60" />
                <span>or</span>
                <span className="h-px flex-1 bg-edge/60" />
              </div>
              <button
                onClick={pairWithGoogle}
                className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-white py-3.5 text-sm font-medium text-slate-800 transition hover:bg-white/95"
              >
                <GoogleGlyph />
                Continue with Google
              </button>
            </>
          )}
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

      {phase === 'taken' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/15 text-accent">
            <IconShield className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">This code is already paired</div>
            <p className="text-sm text-muted">
              Another device beat you to it. Ask the desktop for a fresh QR code.
            </p>
          </div>
        </div>
      )}

      {phase === 'timeout' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/15 text-accent">
            <IconShield className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">QR code timed out</div>
            <p className="text-sm text-muted">
              The desktop hasn’t finished or the code expired. Ask the desktop for a fresh QR code.
            </p>
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
