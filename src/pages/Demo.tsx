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
            Two devices, an integrity check, good to go.
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
          <p className="text-lg leading-relaxed text-white/85">
            Scan a QR code on your laptop with your phone. A quick integrity check of the
            network and the devices, and the site gets a yes/no signal: &ldquo;this looks like
            a real device operated by a real person.&rdquo;
          </p>
          <p className="text-lg leading-relaxed text-white/85">That&apos;s the whole idea.</p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Why I made this</h2>
          <p className="text-lg leading-relaxed text-white/85">
            When Google shipped QR-code reCAPTCHA, a lot of people objected.<sup>*</sup> Not
            because the idea of using a phone was bad, but because of what came with it.
          </p>
          <p className="text-lg leading-relaxed text-white/85">The usual complaints were:</p>
          <ul className="list-disc space-y-1 pl-6 text-lg leading-relaxed text-white/85">
            <li>you had to install or use Google&apos;s app;</li>
            <li>you had to be signed into a Google account;</li>
            <li>the check tied an unrelated website session back to Google identity;</li>
            <li>it pushed more of the web through one identity provider.</li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            So the underlying pattern is still interesting from a CAPTCHA perspective. To pass,
            a bot has to fake clean fingerprints on two devices, route both through a clean
            changing network, and coordinate the two in real time. Real people do that dozens
            of times a day without thinking about it. The question is whether that gap is wide
            enough to make a useful CAPTCHA.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            So I wanted to see what the same idea looks like without the Google account part.
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
          <h2 className="text-3xl font-semibold tracking-tight">What&apos;s different here</h2>
          <p className="text-lg leading-relaxed text-white/85">This version is deliberately small:</p>
          <ul className="list-disc space-y-1 pl-6 text-lg leading-relaxed text-white/85">
            <li>no app install;</li>
            <li>no account;</li>
            <li>no third-party identity provider;</li>
            <li>no cross-site user profile;</li>
            <li>native camera scan;</li>
            <li>works with the phone&apos;s browser.</li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            The desktop shows a QR code. The phone scans it. The phone performs a device
            integrity check. The server gets only what it needs to make this one decision.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            For Apple devices that can already produce a Private Access Token, the QR step can
            be skipped entirely.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="text-lg leading-relaxed text-white/85">
            The verdict combines three signals.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            First, a <strong className="text-white">network check</strong>: where is the
            request actually coming from? Cloud datacenter IPs, anonymizing proxies, residential
            proxy networks, and corporate filters all leave different fingerprints.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            Second, a <strong className="text-white">browser check</strong>: a small script
            looks for obvious automation tells. Playwright, Puppeteer hooks, fake timing,
            navigator inconsistencies, and other browser-side signals.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            Third, a <strong className="text-white">phone check</strong>: the phone proves it
            is real hardware using the platform&apos;s existing attestation path — Secure
            Enclave on iPhone, StrongBox on Android, TPM on Windows. A VM or emulator should
            not be able to fake that cleanly.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            None of these signals is perfect. Combined, they make cheap automation more
            expensive.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Accessibility matters</h2>
          <p className="text-lg leading-relaxed text-white/85">
            A lot of current CAPTCHA systems quietly punish people using assistive technology,
            low-vision users, privacy-hardened browsers, or anyone who simply does not move a
            mouse in the expected way.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            This approach should be less hostile. Holding up a phone for Face ID, Touch ID,
            or a device prompt is already a familiar interaction for many people. It is not
            perfect, but it avoids some of the worst assumptions baked into behavioral CAPTCHA
            systems.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Not a silver bullet</h2>
          <p className="text-lg leading-relaxed text-white/85">This does not stop every attacker.</p>
          <p className="text-lg leading-relaxed text-white/85">
            It catches the long tail: headless browsers, scripted clients, disposable VMs,
            basic bot traffic, and residential proxy abuse.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            A determined attacker with a real phone on a real residential IP is harder.
            Payment fraud, account takeover, and high-value abuse still need defense in depth.
            This is the front gate, not the whole security system.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Why I think this is worth exploring</h2>
          <p className="text-lg leading-relaxed text-white/85">
            Modern CAPTCHAs are losing to AI. GPT-class vision models solve image puzzles
            with high accuracy. Commercial solver services advertise 99%+ success rates
            against reCAPTCHA, hCaptcha, and FunCaptcha — often for a few dollars per
            thousand calls. A free Chrome extension routes the audio fallback through
            speech-to-text. And the enterprise-tier defenses sites pay six figures
            for — Akamai Bot Manager, HUMAN Security (formerly PerimeterX) — have
            bypass walkthroughs published on commercial scraping blogs.
          </p>
          <ul className="list-disc space-y-1 pl-6 text-base leading-relaxed text-white/80">
            <li>
              <a
                href="https://cheq.ai/blog/testing-ai-gpt-4v-against-captcha/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                CHEQ — testing GPT-4V against CAPTCHA (~80% solve rate on five puzzles)
              </a>
            </li>
            <li>
              <a
                href="https://www.capsolver.com/blog/All/best-captcha-solver"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                CapSolver — commercial solver pricing for reCAPTCHA / hCaptcha / FunCaptcha
              </a>
            </li>
            <li>
              <a
                href="https://github.com/dessant/buster"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Buster — free Chrome extension that solves reCAPTCHA audio with speech-to-text
              </a>
            </li>
            <li>
              <a
                href="https://scrapfly.io/blog/posts/how-to-bypass-akamai-anti-scraping"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Scrapfly — how to bypass Akamai Bot Manager
              </a>
            </li>
            <li>
              <a
                href="https://www.zenrows.com/blog/perimeterx-bypass"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                ZenRows — how to bypass HUMAN Security (PerimeterX)
              </a>
            </li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            Meanwhile, phones already have hardware-backed integrity systems. Browsers already
            have native camera support. Platforms already have biometric prompts. The pieces
            exist — FIDO/WebAuthn even ships the cross-device pattern (desktop QR → phone
            authenticates) for{' '}
            <a
              href="https://www.corbado.com/blog/webauthn-passkey-qr-code"
              className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
              target="_blank"
              rel="noopener noreferrer"
            >
              passkey hybrid transport
            </a>{' '}
            sign-in flows.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            The question is whether we can use them without turning every login, comment form,
            or checkout page into another identity checkpoint.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            That is what this demo is testing.
          </p>
        </div>
      </section>

      <footer className="mt-auto pt-6 text-center text-[10px] uppercase tracking-[0.2em] text-muted/60">
        Two devices · one signed envelope · zero passwords
      </footer>
    </div>
  );
}
