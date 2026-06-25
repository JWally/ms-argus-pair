import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { awaitDesktopReady, submitPhoneAttestation, type PhoneSessionInfo } from '../lib/pair';
import { loadTrustToken } from '../lib/device-trust';
import { Wordmark } from '../components/Brand';
import { Dialpad } from '../components/Dialpad';
import { IconCheck, IconX, IconShield } from '../components/Icons';

type Phase =
  | 'awaiting-desktop'
  | 'ready'
  | 'challenge'
  | 'dialpad'
  | 'returning'
  | 'pairing'
  | 'paired'
  | 'failed'
  | 'taken'
  | 'timeout'
  | 'error';

// Debug mode disables the trusted-device auto-pass so we always land on
// the buttons screen — useful for demos / inspecting the ceremony. Flag
// rides through from the desktop's `?debug=true` query param via the QR
// URL. UI-only: server-side verification is unchanged.
function isDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('debug') === 'true';
}

function nonceFromPairHash(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('n');
}

export function Pair() {
  const { roomId: sessionId } = useParams<{ roomId: string }>();
  const initialNonce = nonceFromPairHash();
  const [phase, setPhase] = useState<Phase>(initialNonce ? 'challenge' : 'awaiting-desktop');
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hasTrust, setHasTrust] = useState(false);
  const [trustChecked, setTrustChecked] = useState(false);
  const [nonce, setNonce] = useState<string | null>(initialNonce);
  const [challengeIndex, setChallengeIndex] = useState(0);
  const [desktopReady, setDesktopReady] = useState(false);
  const infoRef = useRef<PhoneSessionInfo | null>(null);
  const inflightRef = useRef(false);
  const startedInChallengeRef = useRef(!!initialNonce);

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
        let trustSettled = false;
        const trustFallback = window.setTimeout(() => {
          if (trustSettled || ctl.signal.aborted) return;
          setTrustChecked(true);
        }, 1500);
        void loadTrustToken().then((trustToken) => {
          trustSettled = true;
          window.clearTimeout(trustFallback);
          if (ctl.signal.aborted) return;
          setHasTrust(!!trustToken);
          setTrustChecked(true);
        });

        const info = await awaitDesktopReady(sessionId, ctl.signal);
        if (ctl.signal.aborted) return;
        infoRef.current = info;
        setNonce(info.nonce);
        setDesktopReady(true);
        if (!startedInChallengeRef.current) {
          setPhase('ready');
        }
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
    return () => {
      ctl.abort();
      // Close the WS opened during awaitDesktopReady. After phone-attest
      // returns the server already pushed the verdict to the desktop;
      // the phone has no further use for the socket.
      infoRef.current?.conn.close();
    };
  }, [sessionId]);

  // Auto-close the phone tab once the verdict is in. Paired closes
  // quickly (1.5s) since there's nothing to read; failed gives the
  // user enough time to read the reason (3.5s) before closing so the
  // experience isn't "tap → see Not Verified for half a second → tab
  // gone." 'taken', 'timeout', 'error' all stay open — those need the
  // user to decide what to do next.
  useEffect(() => {
    if (phase !== 'paired' && phase !== 'failed') return;
    const delayMs = phase === 'paired' ? 1500 : 3500;
    const timer = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        /* noop — works only when window.opener exists / popup context */
      }
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Returning devices still try silent device-trust redeem first inside
  // submitPhoneAttestation. Fresh devices run the default passkey proof.
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

  function advanceChallenge() {
    if (!desktopReady || !trustChecked || !infoRef.current) {
      setChallengeIndex((i) => i + 1);
      return;
    }
    // Debug mode intentionally lands on the button screen for inspection.
    if (isDebugMode()) {
      setPhase('ready');
      return;
    }
    // Calculator solved + desktop ready → pair immediately. The dialpad solve
    // is the human gesture + intent, so there's no separate "Verify this
    // device" tap (passkeys are off the mobile UX). Returning trusted devices
    // still hit the silent redeem inside pair().
    setPhase(hasTrust ? 'returning' : 'pairing');
    void pair();
  }

  // Full-bleed render for the dialpad phase — no Wordmark/pill chrome,
  // no constrained max-w-sm wrapper. The dialer takes the whole viewport
  // for the iPhone Phone-app silhouette to read correctly.
  if ((phase === 'challenge' || phase === 'dialpad') && nonce) {
    const readyToContinue = desktopReady && trustChecked;
    return (
      <Dialpad
        key={`${nonce}:${challengeIndex}`}
        nonce={nonce}
        challengeIndex={challengeIndex}
        actionLabel={readyToContinue ? 'SEND' : 'NEXT'}
        onSend={phase === 'dialpad' ? () => void pair() : advanceChallenge}
      />
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">{isDebugMode() ? 'debug' : 'phone'}</span>
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
              {hasTrust ? 'Welcome back' : 'Quick check'}
            </h1>
            <p className="text-sm leading-relaxed text-muted">
              {hasTrust
                ? 'We remember this device. One tap to confirm.'
                : 'One tap to confirm this is a real device.'}
            </p>
          </div>
          <button onClick={() => pair()} className="btn btn-primary w-full py-4 text-base">
            {hasTrust ? 'Confirm' : 'Verify this device'}
          </button>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted/70">
            {hasTrust ? 'Trusted device · same network' : 'No account · no password'}
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
