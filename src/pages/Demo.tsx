import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { startDesktopSession } from '../lib/pair';
import { Wordmark } from '../components/Brand';
import { AnnotationsCard } from '../components/AnnotationsCard';
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
    try {
      const session = await startDesktopSession({ onStatus: setStatus });
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
    startedRef.current = true;
    void startDemo();
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startDemo();
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-10 px-6 py-10 sm:py-16">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">
          <IconShield className="h-3 w-3" /> dual-device check
        </span>
      </header>

      <section className="flex flex-col gap-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Pair your phone to continue
          </h1>
          <p className="max-w-2xl text-sm text-muted sm:text-base">
            Two-device verification. Scan the code with your phone — both sides run an integrity
            check, your phone confirms it&apos;s real hardware, and you&apos;re through. Usually
            takes about 10 seconds.
          </p>
        </div>

        <StepIndicator phase={phase} />
      </section>

      {/* QR / status panel */}
      {(phase === 'scanning' || phase === 'waiting') && (
        <section className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
          <div className="qr-frame mx-auto">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="pairing QR code" className="h-72 w-72 rounded-lg" />
            ) : (
              <div className="flex h-72 w-72 items-center justify-center text-muted">
                <IconQR className="h-12 w-12 opacity-40" />
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="card p-5">
              <div className="label mb-2 flex items-center gap-2">
                <span className="spinner" /> {status || (qrDataUrl ? 'waiting for phone' : 'starting')}
              </div>
              <div className="space-y-3 text-sm text-white/80">
                <div className="flex items-start gap-3">
                  <IconPhone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <span>
                    Open your phone camera and point it at the code on the left.
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <span>
                    Your phone will ask for a biometric to prove it&apos;s a real device. Tap
                    through.
                  </span>
                </div>
              </div>
            </div>
            {pairUrl && (
              <div className="text-xs text-muted">
                Can&apos;t scan?{' '}
                <a className="break-all text-accent underline-offset-2 hover:underline" href={pairUrl}>
                  Open on this device
                </a>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Paired */}
      {phase === 'paired' && (
        <section className="flex flex-col gap-6">
          <div className="card card-accent flex items-center gap-4 p-6">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15 text-green-300">
              <IconCheck className="h-6 w-6" />
            </span>
            <div className="flex-1">
              <div className="text-xl font-semibold">Verified</div>
              <div className="text-sm text-muted">
                {verdictReason ? verdictReason.replace(/_/g, ' ') : 'both attestations checked out'}
              </div>
            </div>
            <button className="btn" onClick={reset}>
              Run again
            </button>
          </div>
          {annotations && <AnnotationsCard annotations={annotations} />}
        </section>
      )}

      {/* Failed */}
      {phase === 'failed' && (
        <section className="flex flex-col gap-6">
          <div className="card flex items-center gap-4 border-red-500/40 p-6">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-300">
              <IconX className="h-6 w-6" />
            </span>
            <div className="flex-1">
              <div className="text-xl font-semibold">Verification denied</div>
              <div className="text-sm text-muted">
                {verdictReason ? verdictReason.replace(/_/g, ' ') : 'a rule rejected the pair'}
              </div>
            </div>
            <button className="btn" onClick={reset}>
              Try again
            </button>
          </div>
          {annotations && <AnnotationsCard annotations={annotations} />}
        </section>
      )}

      {/* Error */}
      {phase === 'error' && (
        <section className="card flex items-center gap-4 border-red-500/40 p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-300">
            <IconX className="h-6 w-6" />
          </span>
          <div className="flex-1">
            <div className="text-xl font-semibold">Something went wrong</div>
            <div className="break-all text-sm text-muted">{errorMsg}</div>
          </div>
          <button className="btn" onClick={reset}>
            Retry
          </button>
        </section>
      )}

      <footer className="mt-auto pt-6 text-center text-[10px] uppercase tracking-[0.2em] text-muted/60">
        Two devices · one signed envelope · zero passwords
      </footer>
    </div>
  );
}
