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
          width: 440,
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

          {/* Status card + fallback link live under the step indicator,
              not under the QR — keeps the right column tight around the
              code itself. */}
          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <>
              <div className="card mt-6 p-4">
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
                <div className="mt-3 text-center text-sm text-white/70">
                  Can&apos;t scan?{' '}
                  <a
                    className="break-all font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                    href={pairUrl}
                  >
                    Open on this device
                  </a>
                </div>
              )}
            </>
          )}

          {(phase === 'scanning' || phase === 'waiting') && desktopAttested?.clean && (
            <div className="card card-accent mt-4 border-green-500/40 p-4">
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

        {/* Right column: just the QR. */}
        <div className="lg:pl-4">
          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <div className="qr-frame mx-auto w-fit">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="pairing QR code"
                  className="mx-auto block h-96 w-96 rounded-lg"
                />
              ) : (
                <div className="mx-auto flex h-96 w-96 items-center justify-center text-muted">
                  <IconQR className="h-12 w-12 opacity-40" />
                </div>
              )}
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

      <section className="prose-body mt-4 space-y-8 border-t border-white/10 pt-10">
        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">TL;DR</h2>
          <p className="text-lg leading-relaxed text-white/85">
            There was a lot of commotion when Google shipped QR-code reCAPTCHA. I wanted to see
            if the same idea worked without the parts that made people angry.<sup>*</sup>
          </p>
          <p className="text-base text-white/70">
            <sup>*</sup> Reading on what shipped and why people pushed back:
          </p>
          <ul className="list-disc space-y-1 pl-6 text-base leading-relaxed text-white/80">
            <li>
              <a
                href="https://cloud.google.com/blog/products/identity-security/introducing-google-cloud-fraud-defense-the-next-evolution-of-recaptcha/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google&apos;s announcement — &ldquo;the next evolution of reCAPTCHA&rdquo;
              </a>
            </li>
            <li>
              <a
                href="https://cybernews.com/privacy/google-qr-code-recaptcha-requires-approved-phone/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Cybernews — locks out anyone without a vetted iPhone or Android
              </a>
            </li>
            <li>
              <a
                href="https://www.androidauthority.com/grapheneos-google-apple-approved-devices-web-warning-3665319/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                GrapheneOS — &ldquo;enormously anti-competitive&rdquo;
              </a>
            </li>
            <li>
              <a
                href="https://privatecaptcha.com/blog/google-cloud-fraud-defence-wei/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Private Captcha — Cloud Fraud Defence is just Web Environment Integrity repackaged
              </a>
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">What I want</h2>
          <p className="text-lg leading-relaxed text-white/85">
            I don&apos;t like installing apps — most things work better as websites. I hate signing
            up for accounts I&apos;ll use once. But my phone is on me anyway. A check that uses
            the phone I&apos;m already carrying, with no install and no account, is a fair trade.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">What Google shipped</h2>
          <p className="text-lg leading-relaxed text-white/85">
            A QR code on the desktop, scanned with the Google app on your phone. The app talks
            to Google, confirms the device and your account, and the desktop gets a verdict back.
            However:
          </p>
          <ul className="list-disc space-y-2 pl-6 text-lg leading-relaxed text-white/85">
            <li>The Google app has to be installed — the camera scanner won&apos;t do.</li>
            <li>You have to be signed in to a Google account.</li>
            <li>
              It binds an unrelated site&apos;s session to your Google identity, on properties
              people specifically use to stay outside that ecosystem.
            </li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            The complaint is about being forced into using or creating a Google account to
            access sites that have nothing to do with Google.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">What&apos;s different here</h2>
          <ul className="list-disc space-y-2 pl-6 text-lg leading-relaxed text-white/85">
            <li>
              No apps to install. Scan with your native camera. Works with your phone&apos;s
              browser.
            </li>
            <li>No account, anywhere.</li>
            <li>
              Data minimization in the spirit of hCaptcha. Only what&apos;s needed to make this
              one decision is collected — nothing pooled across sites, nothing handed to
              third parties.
            </li>
            <li>
              Apple devices that pass Private Access Token attestation skip the scan entirely —
              the device has already been independently vouched for.
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="text-lg leading-relaxed text-white/85">Three signals combine into the verdict:</p>
          <ul className="list-disc space-y-2 pl-6 text-lg leading-relaxed text-white/85">
            <li>
              <strong className="text-white">Network check.</strong> Look at where the request
              is actually coming from. Cloud datacenter IPs, anonymizing proxies, residential
              proxy networks, and corporate filters all leave fingerprints in the connection
              itself — no need to take the browser&apos;s word for it.
            </li>
            <li>
              <strong className="text-white">Browser check.</strong> A small piece of code runs
              in the browser and looks for the obvious tells of automation: headless Chrome,
              Selenium / Playwright / Puppeteer hooks, faked timing, faked navigator data. Real
              browsers pass; automation rigs don&apos;t.
            </li>
            <li>
              <strong className="text-white">Phone check.</strong> The phone proves it&apos;s
              real hardware using the same chip that runs TouchID / FaceID — Secure Enclave on
              iPhone, StrongBox on Android, TPM on Windows. A virtual machine or emulator
              can&apos;t fake this.
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">More inclusive</h2>
          <p className="text-lg leading-relaxed text-white/85">
            Almost everyone has a phone. Users on assistive tech, low-vision users, and people
            running privacy-hardened browsers all fail current reCAPTCHA — silently, because the
            behavioral score expects mouse movement and the puzzles assume good eyesight. Holding
            up a phone for a fingerprint or face prompt works for all of them.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Not a silver bullet</h2>
          <p className="text-lg leading-relaxed text-white/85">
            This catches the long tail: proxies, headless browsers, instrumented devices,
            residential botnets. A determined attacker with a real phone on a real residential
            IP is harder. Payment screens and account-takeover endpoints still need
            defense-in-depth. This is the front gate, not the only line.
          </p>
        </div>
      </section>

      <footer className="mt-auto pt-6 text-center text-[10px] uppercase tracking-[0.2em] text-muted/60">
        Two devices · one signed envelope · zero passwords
      </footer>
    </div>
  );
}
