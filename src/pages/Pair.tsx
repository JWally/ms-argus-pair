import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  awaitDesktopReady,
  clearPasskeyHint,
  submitPhoneAttestation,
  type PhoneSessionInfo,
} from '../lib/pair';
import { loadTrustToken } from '../lib/device-trust';
import { isOAuthError, PROVIDERS_CONFIGURED, runOAuthProofOfLife } from '../lib/oauth';
import { Dialpad } from '../components/Dialpad';
import { IconCheck, IconShield, IconX } from '../components/Icons';
import {
  ActivityScreen,
  isActivityPhase,
  PhoneShell,
  ReadyScreen,
  TerminalScreen,
} from './PairScreens';

type ProofChoice = 'integrity' | 'passkey' | 'passkey-create' | 'google';

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
  const [freshProofRequired, setFreshProofRequired] = useState(false);
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
        setFreshProofRequired(info.freshProofRequired);
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
  // submitPhoneAttestation. Fresh devices pick a proof path from the
  // menu so Private Browsing does not blindly create passkeys forever.
  async function pair(proofMode: ProofChoice = 'passkey') {
    if (!sessionId || !infoRef.current || inflightRef.current) return;
    const info = infoRef.current;
    inflightRef.current = true;
    setPhase(hasTrust && !info.freshProofRequired ? 'returning' : 'pairing');
    setStatus('starting');
    setErrorMsg(null);
    try {
      const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth';
      const oauthResult =
        proofMode === 'google' ? await runOAuthProofOfLife('google', info.nonce) : null;
      if (oauthResult && isOAuthError(oauthResult)) {
        setPhase('ready');
        setErrorMsg(oauthResult.error);
        return;
      }
      const r = await submitPhoneAttestation(
        sessionId,
        info,
        {
          onStatus: setStatus,
        },
        {
          mode:
            proofMode === 'integrity'
              ? 'integrity'
              : proofMode === 'google'
                ? 'oauth'
                : passkeyMode,
          ...(oauthResult ? { oauthResult } : {}),
        }
      );
      if (
        proofMode !== 'integrity' &&
        passkeyMode === 'passkey-auth' &&
        r.annotations?.phone_webauthn_error === 'credential_not_registered'
      ) {
        clearPasskeyHint();
      }
      setVerdict(r.verdict);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Server distinguishes "QR is already paired with a different
      // device" from generic errors. Show a calmer screen.
      if (msg.includes('session_paired_with_other_device')) {
        setPhase('taken');
      } else {
        if (phase === 'ready' || proofMode === 'passkey' || proofMode === 'passkey-create') {
          setPhase('ready');
        } else {
          setPhase('error');
        }
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
    if (!infoRef.current.proofRequired) {
      setPhase('pairing');
      void pair('integrity');
      return;
    }
    if (infoRef.current.freshProofRequired) {
      setPhase('ready');
      return;
    }
    // Calculator solved + desktop ready. Returning trusted devices can
    // redeem silently; fresh or storage-partitioned phones choose a proof
    // path so we do not force a new passkey registration every scan.
    if (hasTrust) {
      setPhase('returning');
      void pair();
      return;
    }
    setPhase('ready');
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
        onSend={advanceChallenge}
      />
    );
  }

  return (
    <PhoneShell debug={isDebugMode()}>
      {isActivityPhase(phase) && <ActivityScreen phase={phase} status={status} />}

      {phase === 'ready' && (
        <ReadyScreen
          hasTrust={hasTrust && !freshProofRequired}
          errorMsg={errorMsg}
          googleConfigured={PROVIDERS_CONFIGURED.google}
          onConfirm={() => pair()}
          onPasskey={() => pair('passkey')}
          onCreatePasskey={() => pair('passkey-create')}
          onGoogle={() => pair('google')}
        />
      )}

      {phase === 'paired' && (
        <TerminalScreen
          icon={<IconCheck className="h-10 w-10" />}
          tone="success"
          title="Verified"
          message="You can close this tab. The desktop has the result."
        />
      )}

      {phase === 'failed' && (
        <TerminalScreen
          icon={<IconX className="h-10 w-10" />}
          tone="error"
          title="Not verified"
          message={verdict}
        />
      )}

      {phase === 'taken' && (
        <TerminalScreen
          icon={<IconShield className="h-10 w-10" />}
          tone="accent"
          title="This code is already paired"
          message="Another device beat you to it. Ask the desktop for a fresh QR code."
        />
      )}

      {phase === 'timeout' && (
        <TerminalScreen
          icon={<IconShield className="h-10 w-10" />}
          tone="accent"
          title="QR code timed out"
          message="The desktop hasn’t finished or the code expired. Ask the desktop for a fresh QR code."
        />
      )}

      {phase === 'error' && (
        <TerminalScreen
          icon={<IconX className="h-10 w-10" />}
          tone="error"
          title="Something went wrong"
          message={errorMsg}
          compactMessage
        />
      )}
    </PhoneShell>
  );
}
