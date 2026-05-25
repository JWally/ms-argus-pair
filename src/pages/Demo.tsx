import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { startDesktopSession, type DesktopAttestedSummary } from '../lib/pair';
import { Wordmark } from '../components/Brand';
import { AnnotationsCard } from '../components/AnnotationsCard';
import { DeviceComparisonCard } from '../components/DeviceComparisonCard';
import { IconCheck, IconX, IconPhone, IconQR, IconShield } from '../components/Icons';

type Phase = 'idle' | 'scanning' | 'waiting' | 'paired' | 'failed' | 'error';

function StepIndicator({ phase }: { phase: Phase }) {
  const steps: Array<{ n: number; title: string; state: 'pending' | 'active' | 'done' }> = [
    {
      n: 1,
      title: 'Prepare',
      state:
        phase === 'idle' || phase === 'scanning'
          ? 'active'
          : 'done',
    },
    {
      n: 2,
      title: 'Scan with phone',
      state:
        phase === 'waiting'
          ? 'active'
          : phase === 'paired' || phase === 'failed' || phase === 'error'
            ? 'done'
            : 'pending',
    },
    {
      n: 3,
      title: 'Verified',
      state:
        phase === 'paired' || phase === 'failed' || phase === 'error' ? 'done' : 'pending',
    },
  ];
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
      {steps.map((s) => (
        <div className="step" key={s.n}>
          <span className={`step-dot ${s.state === 'active' ? 'active' : ''} ${s.state === 'done' ? 'done' : ''}`}>
            {s.state === 'done' ? <IconCheck className="h-3 w-3" /> : s.n}
          </span>
          <span className={s.state === 'pending' ? 'text-muted' : 'text-white/90'}>{s.title}</span>
        </div>
      ))}
    </div>
  );
}

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [, setVerdict] = useState<string | null>(null);
  const [verdictReason, setVerdictReason] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Record<string, unknown> | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [desktopAttested, setDesktopAttested] = useState<DesktopAttestedSummary | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);

  useEffect(
    () => () => {
      stopRef.current?.();
    },
    []
  );

  async function startDemo() {
    setPhase('scanning');
    setStatus('preparing session');
    setVerdict(null);
    setVerdictReason(null);
    setAnnotations(null);
    setErrorMsg(null);
    setDesktopAttested(null);
    try {
      const session = await startDesktopSession({
        onStatus: setStatus,
        onDesktopAttested: setDesktopAttested,
      });
      stopRef.current = session.stop;
      setPairUrl(session.pairUrl);
      setQrDataUrl(
        await QRCode.toDataURL(session.pairUrl, {
          width: 320,
          margin: 1,
          color: { dark: '#ffffff', light: '#0a0a0a00' },
        })
      );
      setPhase('waiting');
      const r = await session.result;
      setVerdict(r.verdict);
      setVerdictReason(r.reason);
      setAnnotations((r as { annotations?: Record<string, unknown> }).annotations ?? null);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    stopRef.current?.();
    stopRef.current = null;
    setPhase('idle');
    setPairUrl(null);
    setQrDataUrl(null);
    setVerdict(null);
    setVerdictReason(null);
    setAnnotations(null);
    setErrorMsg(null);
    setDesktopAttested(null);
    startedRef.current = true;
    void startDemo();
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startDemo();
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-10 px-6 py-10 sm:py-16">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">
          <IconShield className="h-3 w-3" /> dual-device check
        </span>
      </header>

      {/* Hero — text left, QR right (or result panel right after pairing) */}
      <section className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
        <div className="flex flex-col justify-center">
          <span className="pill w-fit">
            <IconShield className="h-3 w-3" /> Real-time integrity
          </span>
          <h1 className="mt-5 text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl lg:text-5xl">
            QR Captcha Demo
          </h1>
          <ul className="mt-5 space-y-1 text-base text-white/85">
            <li>— Nothing to install</li>
            <li>— Nothing to sign into</li>
            <li>— Nothing to worry about</li>
          </ul>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
            Two devices, an integrity check, and you&apos;re good to go.
          </p>
          <div className="mt-7">
            <StepIndicator phase={phase} />
          </div>
        </div>

        {/* Right column: QR + status (when waiting) or result panel (when done) */}
        <div className="space-y-4 lg:pl-4">
          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <>
              <div className="qr-frame mx-auto">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="pairing QR code" className="h-72 w-72 rounded-lg" />
                ) : (
                  <div className="flex h-72 w-72 items-center justify-center text-muted">
                    <IconQR className="h-12 w-12 opacity-40" />
                  </div>
                )}
              </div>
              <div className="card p-4">
                <div className="label mb-2 flex items-center gap-2">
                  <span className="spinner" />{' '}
                  {status || (qrDataUrl ? 'waiting for phone' : 'starting')}
                </div>
                <div className="space-y-2 text-sm text-white/80">
                  <div className="flex items-start gap-3">
                    <IconPhone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span>Open your phone camera and point it at the code.</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span>Your phone will ask for a biometric — tap through.</span>
                  </div>
                </div>
              </div>
              {pairUrl && (
                <div className="text-center text-xs text-muted">
                  Can&apos;t scan?{' '}
                  <a
                    className="break-all text-accent underline-offset-2 hover:underline"
                    href={pairUrl}
                  >
                    Open on this device
                  </a>
                </div>
              )}
            </>
          )}

          {/* When PAT is clean, replace the status card body with the
              APPROVED panel — the QR stays visible so the demo still
              communicates what was bypassed. */}
          {(phase === 'scanning' || phase === 'waiting') && desktopAttested?.clean && (
            <div className="card card-accent border-green-500/40 p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-300">
                  <IconCheck className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-base font-semibold tracking-tight text-green-200">
                    APPROVED
                  </div>
                  <p className="text-xs text-white/80">
                    Verified Apple device
                    {desktopAttested.summary?.browser_name
                      ? ` (${desktopAttested.summary.browser_name}${
                          desktopAttested.summary.os ? ` · ${desktopAttested.summary.os}` : ''
                        })`
                      : ''}
                    . In production this step would be skipped.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Paired */}
      {phase === 'paired' && (
        <section className="flex flex-col gap-6">
          <div className="card card-accent p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-300">
                <IconCheck className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xl font-semibold">Verified</div>
                <div className="text-sm text-muted">
                  {verdictReason ? verdictReason.replace(/_/g, ' ') : 'both attestations checked out'}
                </div>
              </div>
              <button className="btn w-full border-green-500/40 hover:border-green-400/60 sm:w-auto" onClick={reset}>
                Run again
              </button>
            </div>
          </div>
          {annotations && (
            <>
              <DeviceComparisonCard annotations={annotations} />
              <AnnotationsCard annotations={annotations} />
            </>
          )}
        </section>
      )}

      {/* Failed */}
      {phase === 'failed' && (
        <section className="flex flex-col gap-6">
          <div className="card border-red-500/40 p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-300">
                <IconX className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xl font-semibold">Verification denied</div>
                <div className="text-sm text-muted">
                  {verdictReason ? verdictReason.replace(/_/g, ' ') : 'a rule rejected the pair'}
                </div>
              </div>
              <button className="btn w-full border-red-500/40 hover:border-red-400/60 sm:w-auto" onClick={reset}>
                Try again
              </button>
            </div>
          </div>
          {annotations && (
            <>
              <DeviceComparisonCard annotations={annotations} />
              <AnnotationsCard annotations={annotations} />
            </>
          )}
        </section>
      )}

      {/* Error */}
      {phase === 'error' && (
        <section className="card border-red-500/40 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-300">
              <IconX className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xl font-semibold">Something went wrong</div>
              <div className="break-all text-sm text-muted">{errorMsg}</div>
            </div>
            <button className="btn w-full border-red-500/40 hover:border-red-400/60 sm:w-auto" onClick={reset}>
              Retry
            </button>
          </div>
        </section>
      )}

      <section className="prose-body mt-4 space-y-6 border-t border-white/10 pt-10">
        <h2 className="text-2xl font-semibold tracking-tight">A different take on reCAPTCHA</h2>
        <p className="text-sm leading-relaxed text-white/80">
          Google&apos;s reCAPTCHA — from the &ldquo;click all the bicycles&rdquo; puzzles of v2
          to the invisible behavioral scoring of v3 and reCAPTCHA Enterprise — has two structural
          problems beyond bot-catching effectiveness.
        </p>
        <p className="text-sm leading-relaxed text-white/80">
          The behavioral signals exclude real people. v3 scores mouse movement, scroll cadence,
          dwell time, focus changes. Visitors using assistive tech — screen readers, keyboard
          navigation, switch controls — don&apos;t produce that telemetry, so they look bot-like.
          Users on privacy-hardened browsers (Brave, Firefox in strict mode, Tor) strip the
          signals reCAPTCHA depends on. Both groups fail the silent score and get bounced to
          puzzles, which are themselves inaccessible by design. The audio fallback is degraded
          and routinely defeated; the visual puzzles assume good eyesight, a steady hand, and a
          fast device. Older phones, slow connections, and low-vision users all get stuck.
        </p>

        <h3 className="text-lg font-semibold tracking-tight">How this works</h3>
        <p className="text-sm leading-relaxed text-white/80">
          Three signals carry the verdict.
        </p>
        <ul className="list-disc space-y-3 pl-5 text-sm leading-relaxed text-white/80">
          <li>
            <strong className="text-white">Network integrity.</strong> Datacenter IPs, anonymizing
            proxies, mobile-network re-origination, corporate TLS shields — independently
            identifiable from TCP, JA4, and HTTP/2 fingerprints without trusting the client.
            Cleanness here is most of the score.
          </li>
          <li>
            <strong className="text-white">Browser integrity.</strong> A small SDK runs in the
            browser and signs an envelope over what it sees: real Chrome vs. headless Chromium,
            automation hooks, CDP timing tells, native-function tamper checks. The signature is
            bound to a non-extractable ECDSA key in IndexedDB, so the signal can&apos;t be replayed
            cross-origin.
          </li>
          <li>
            <strong className="text-white">Cryptographic device proof.</strong> The phone runs a
            WebAuthn ceremony against its platform authenticator — Secure Enclave on iOS,
            StrongBox on Android, TPM on Windows Hello. The signed assertion proves real hardware,
            not a virtualized environment.
          </li>
        </ul>
        <p className="text-sm leading-relaxed text-white/80">
          Apple devices that pass Private Access Token attestation skip straight through. Apple
          has already vouched for the device and the network path is independently verified, so
          there&apos;s nothing left to check — the QR shows up but you don&apos;t actually need
          to scan it. That&apos;s the green &ldquo;APPROVED&rdquo; panel above.
        </p>

        <h3 className="text-lg font-semibold tracking-tight">Why it&apos;s more inclusive</h3>
        <p className="text-sm leading-relaxed text-white/80">
          Almost everyone has a phone. A user who can&apos;t use a mouse, can&apos;t see image
          puzzles, or runs a privacy-hardened desktop browser can still complete the pair by
          holding up their phone for a fingerprint or face prompt — the same gesture they use to
          unlock the device. No puzzle, no audio, no behavioral profile. The phone-side
          WebAuthn ceremony is the same accessibility-tested flow that signs people into their
          bank.
        </p>

        <h3 className="text-lg font-semibold tracking-tight">What this isn&apos;t</h3>
        <p className="text-sm leading-relaxed text-white/80">
          Not a silver bullet. This catches the long tail of automated traffic — proxies,
          headless browsers, instrumented devices, residential botnets — but a determined attacker
          with a real consumer phone on a real residential IP is harder. Risk-shifting still
          matters: payment screens, account-takeover-sensitive endpoints, and content moderation
          queues need defense-in-depth. This is the front gate and the &ldquo;is this a person at
          all&rdquo; check, not the only line.
        </p>
        <p className="text-sm leading-relaxed text-white/80">
          Other patterns layer on top: device-bound credentials with longer-lived attestations
          (the trust token issued here is a 12-hour version), risk scoring at the merchant API,
          manual review for high-value transactions. But for the broad case of &ldquo;is this
          session automated,&rdquo; most users complete the check in about ten seconds — including
          the people reCAPTCHA quietly excludes today.
        </p>
      </section>

      <footer className="mt-auto pt-6 text-center text-[10px] uppercase tracking-[0.2em] text-muted/60">
        Two devices · one signed envelope · zero passwords
      </footer>
    </div>
  );
}
