import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode-svg';
import {
  startDesktopSession,
  submitRaffleEntry,
  fetchLeaderboard,
  fetchRaffleStatus,
  HttpError,
  type DesktopAttestedSummary,
  type LeaderboardRow,
  type RaffleStatus as RaffleEntryGate,
} from '../lib/pair';
import { startHostedVerify, submitHostedMerchantLeg } from '../lib/hosted';
import { Wordmark } from '../components/Brand';
import { AnnotationsCard } from '../components/AnnotationsCard';
import { DeviceComparisonCard } from '../components/DeviceComparisonCard';
import { IconCheck, IconX, IconPhone, IconShield } from '../components/Icons';

type Phase = 'idle' | 'scanning' | 'waiting' | 'paired' | 'failed' | 'error' | 'timeout';

// Contest target: first handle to this many entries wins.
const CONTEST_TARGET = 1000;

function ContestPill() {
  return (
    <span className="pill">
      <span className="contest-dot" aria-hidden /> Contest live
    </span>
  );
}

function ScoreboardRow({
  rank,
  row,
  highlight,
}: {
  rank: number;
  row: LeaderboardRow;
  highlight: boolean;
}) {
  const isLeader = rank === 1;
  return (
    <li
      className={`flex items-center justify-between rounded-md px-3 py-2 font-mono text-sm ${
        highlight
          ? 'bg-accent/25 font-semibold text-white ring-1 ring-accent/50'
          : isLeader
            ? 'bg-white/[0.04] font-semibold text-white'
            : 'text-white/80'
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="w-7 shrink-0 text-right tabular-nums text-muted/70">{rank}</span>
        <span className="truncate">{row.code}</span>
      </span>
      <span className="tabular-nums text-muted">{row.count}</span>
    </li>
  );
}

/**
 * Pre-arrival loading state: the argus.pair wordmark bounces around
 * the QR slot DVD-screensaver style. X and Y on non-commensurate
 * periods so the path never repeats. Random starting position per
 * mount via negative animation-delay — looks fresh every load
 * instead of always starting from the top-left corner.
 */
function QrLoadingGlyphs() {
  // Negative animation-delay sampled inside each animation's full
  // period — picks a random phase so the wordmark starts mid-flight
  // somewhere inside the slot rather than always from (0,0). Lazy
  // useState initializer keeps the values stable across re-renders
  // while staying per-mount-random; it's the React-idiomatic way to
  // do "compute once on first render" without tripping the
  // react-hooks lint rules around purity or ref-reads.
  const [starts] = useState(() => ({
    x: `-${(Math.random() * 7.3).toFixed(2)}s`,
    y: `-${(Math.random() * 5.1).toFixed(2)}s`,
  }));
  return (
    <div className="qr-dvd-stage relative aspect-square w-full overflow-hidden" aria-hidden>
      <div className="qr-dvd-x" style={{ animationDelay: starts.x }}>
        <div className="qr-dvd-y" style={{ animationDelay: starts.y }}>
          argus.pair
        </div>
      </div>
    </div>
  );
}

function QrPanel({ svg }: { svg: string | null }) {
  return (
    <div className="mx-auto w-full max-w-[18rem] sm:max-w-[22rem] lg:max-w-[24rem]">
      <div className="qr-frame w-full">
        {svg ? (
          <div
            className="qr-svg qr-arrived block aspect-square w-full text-white/90"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <QrLoadingGlyphs />
        )}
      </div>
    </div>
  );
}

type RaffleStatus = 'idle' | 'submitting' | 'entered' | 'error';

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [, setVerdict] = useState<string | null>(null);
  const [verdictReason, setVerdictReason] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Record<string, unknown> | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [desktopAttested, setDesktopAttested] = useState<DesktopAttestedSummary | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [handleInput, setHandleInput] = useState('');
  const [raffleStatus, setRaffleStatus] = useState<RaffleStatus>('idle');
  const [raffleError, setRaffleError] = useState<string | null>(null);
  const [raffleEntry, setRaffleEntry] = useState<{ code: string; count: number } | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [entryGate, setEntryGate] = useState<RaffleEntryGate | null>(null);
  const [hostedStatus, setHostedStatus] = useState<'idle' | 'starting' | 'error'>('idle');
  const [hostedError, setHostedError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);

  async function refreshLeaderboard() {
    try {
      setLeaderboard(await fetchLeaderboard());
    } catch {
      /* keep stale data on transient errors */
    }
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchLeaderboard();
        if (!cancelled) setLeaderboard(rows);
      } catch {
        /* keep stale */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once paired, probe the server-side raffle gate (rate-limit + dedupe)
  // so we can hide the form upfront when the user has already hit their
  // hourly cap or this session already counted. Degrades to "show the
  // form" on any error — the submit endpoint still returns the real
  // verdict.
  useEffect(() => {
    if (phase !== 'paired' || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const g = await fetchRaffleStatus(sessionId);
        if (!cancelled) setEntryGate(g);
      } catch {
        if (!cancelled) setEntryGate({ status: 'ok' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, sessionId]);

  const qrSvg = useMemo(() => {
    if (!pairUrl) return null;
    // Standard QR conventions for maximum scanner compatibility:
    // black modules on white background, full module size (no inter-
    // module gaps), 2-module quiet zone padding. The stylized
    // white-on-dark + dot-grid look we used to ship scanned fine in
    // good light but fell over on iOS Camera in dim conditions.
    return new QRCode({
      content: pairUrl,
      padding: 2,
      color: '#000000',
      background: '#ffffff',
      ecl: 'M',
      container: 'svg-viewbox',
    }).svg();
  }, [pairUrl]);

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
      setSessionId(session.sessionId);
      setPairUrl(session.pairUrl);
      setPhase('waiting');
      const r = await session.result;
      setVerdict(r.verdict);
      setVerdictReason(r.reason);
      setAnnotations((r as { annotations?: Record<string, unknown> }).annotations ?? null);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Session-expired isn't a fault — the user simply didn't scan in
      // time. Route it to a calmer screen rather than the red error card.
      if (msg.includes('session expired')) {
        setPhase('timeout');
      } else {
        setPhase('error');
        setErrorMsg(msg);
      }
    }
  }

  async function startHostedDemo() {
    if (hostedStatus === 'starting') return;
    setHostedStatus('starting');
    setHostedError(null);
    try {
      const start = await startHostedVerify();
      await submitHostedMerchantLeg(start);
      window.location.assign(start.redirectUrl);
    } catch (e) {
      setHostedStatus('error');
      setHostedError(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    stopRef.current?.();
    stopRef.current = null;
    setPhase('idle');
    setPairUrl(null);
    setVerdict(null);
    setVerdictReason(null);
    setAnnotations(null);
    setErrorMsg(null);
    setEntryGate(null);
    setDesktopAttested(null);
    setSessionId(null);
    setRaffleStatus('idle');
    setRaffleError(null);
    setRaffleEntry(null);
    setHandleInput('');
    startedRef.current = true;
    void startDemo();
  }

  async function submitHandle(e: FormEvent) {
    e.preventDefault();
    if (!sessionId || raffleStatus === 'submitting') return;
    setRaffleStatus('submitting');
    setRaffleError(null);
    try {
      const r = await submitRaffleEntry(sessionId, handleInput);
      setRaffleEntry({ code: r.code, count: r.count });
      setRaffleStatus('entered');
      void refreshLeaderboard();
    } catch (e) {
      setRaffleStatus('error');
      if (e instanceof HttpError) {
        const err = (e.bodyJson?.error as string | undefined) ?? `http_${e.status}`;
        const bucket = e.bodyJson?.bucket as string | undefined;
        if (err === 'rate_limited') {
          const site = e.bodyJson?.site as string | undefined;
          setRaffleError(
            `Rate-limited on ${site ?? 'this site'} (${bucket ?? 'bucket'} hit cap). Try again next hour.`
          );
        } else if (err === 'session_already_entered') {
          const code = e.bodyJson?.code as string | undefined;
          setRaffleError(
            code ? `This session already counted for ${code}.` : 'Session already used.'
          );
        } else if (err === 'invalid_handle') {
          setRaffleError('Handle must be 3-64 chars: letters, digits, . _ @ -');
        } else if (err === 'session_not_paired') {
          setRaffleError('Pair the phone first.');
        } else if (err === 'session_not_found') {
          setRaffleError('Session expired. Hit "Run again" and re-pair.');
        } else {
          setRaffleError(err);
        }
      } else {
        setRaffleError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startDemo();
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-10 px-6 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Wordmark />
        <div className="flex flex-wrap items-center gap-2">
          <ContestPill />
          <span className="pill">
            <IconShield className="h-3 w-3" /> dual-device check
          </span>
        </div>
      </header>

      {/* Hero — text left, QR right (or result panel right after pairing) */}
      <section className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
        <div className="flex flex-col justify-center">
          <span className="pill w-fit">
            <IconShield className="h-3 w-3" /> Real-time integrity
          </span>
          <h1 className="mt-5 text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl lg:text-5xl">
            QR Captcha <span className="hero-strike text-muted/60">Demo</span>{' '}
            <span className="text-accent-bright">Challenge</span>
          </h1>
          <p className="mt-5 text-base leading-relaxed text-white/85">
            Nothing to install. Nothing to sign into. Nothing to worry about.
          </p>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">
            Two devices, an integrity check, good to go.
          </p>
          <p className="contest-throb mt-3 max-w-xl text-base font-semibold leading-relaxed text-white/95 sm:font-normal">
            <em className="text-accent-bright">How to Win!</em> Complete the CAPTCHA (qr thing) and
            enter <em>an</em> email (doesn&apos;t have to be your private email). First one to 1,000
            wins!
          </p>

          {/* Mobile-only inline QR — sits right under the intro line. */}
          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <div className="mt-6 lg:hidden">
              <QrPanel svg={qrSvg} />
              <div className="neon-callout mx-auto mt-4 max-w-[18rem] sm:max-w-[22rem]">
                <div className="neon-track">
                  <span className="neon-text-green">Scan · with · a · friend&apos;s · phone</span>
                  <span className="neon-text-red">See · the · demo</span>
                  <span className="neon-text-green">No · install · No · login</span>
                  <span className="neon-text-red">Try · it · live</span>
                  <span className="neon-text-green">Scan · with · a · friend&apos;s · phone</span>
                  <span className="neon-text-red">See · the · demo</span>
                  <span className="neon-text-green">No · install · No · login</span>
                  <span className="neon-text-red">Try · it · live</span>
                </div>
              </div>
            </div>
          )}

          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <div className="card mt-6 p-4">
              <div className="label mb-2 flex items-center gap-2">
                <span className="spinner" /> {status || (qrSvg ? 'waiting for phone' : 'starting')}
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
          )}

          <div className="card mt-4 p-4">
            <div className="label mb-2">Same-phone path</div>
            <p className="mb-3 text-sm leading-relaxed text-white/80">
              On mobile, use hosted redirect instead of QR pairing.
            </p>
            <button
              className="btn btn-primary w-full py-3 text-sm"
              onClick={() => void startHostedDemo()}
              disabled={hostedStatus === 'starting'}
            >
              {hostedStatus === 'starting' ? 'Starting redirect' : 'Try mobile redirect'}
            </button>
            {hostedError && <p className="mt-3 break-all text-xs text-red-200">{hostedError}</p>}
          </div>

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

        {/* Right column: desktop-only QR. */}
        <div className="hidden lg:block lg:pl-4">
          {(phase === 'idle' || phase === 'scanning' || phase === 'waiting') && (
            <QrPanel svg={qrSvg} />
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
                  {verdictReason
                    ? verdictReason.replace(/_/g, ' ')
                    : 'both attestations checked out'}
                </div>
              </div>
              <button
                className="btn w-full border-green-500/40 hover:border-green-400/60 sm:w-auto"
                onClick={reset}
              >
                Run again
              </button>
            </div>
          </div>

          <div className="contest-panel card card-accent relative overflow-hidden p-7 sm:p-8">
            <div className="relative">
              <div className="flex items-center justify-between">
                <span className="label flex items-center gap-2">
                  <span className="contest-dot" aria-hidden /> Contest · live
                </span>
                <span className="label">first to {CONTEST_TARGET.toLocaleString()}</span>
              </div>
              <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                Claim your spot.
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted">
                One entry per paired session. Three per hour per device. First handle to{' '}
                {CONTEST_TARGET.toLocaleString()} entries wins.
              </p>

              {raffleStatus === 'entered' ? (
                <div className="mt-6 rounded-xl border border-accent/40 bg-accent/15 px-5 py-4">
                  <div className="label text-accent-bright">you&apos;re in · code</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-white">
                    {raffleEntry?.code} <span className="text-muted">·</span> {raffleEntry?.count}{' '}
                    {raffleEntry?.count === 1 ? 'entry' : 'entries'}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    Find this code on the scoreboard below.
                  </div>
                </div>
              ) : entryGate?.status === 'rate_limited' ? (
                <div className="mt-6 rounded-xl border border-amber-400/35 bg-amber-400/10 px-5 py-4">
                  <div className="label text-amber-200">limit reached</div>
                  <div className="mt-1 text-sm text-white">
                    You&rsquo;ve used your {entryGate.cap} entries this hour
                    {entryGate.site && entryGate.site !== 'unknown' ? (
                      <>
                        {' '}
                        on <span className="font-mono text-amber-200">{entryGate.site}</span>
                      </>
                    ) : null}
                    . The quota rolls over at the top of the next hour.
                  </div>
                </div>
              ) : entryGate?.status === 'already_entered' ? (
                <div className="mt-6 rounded-xl border border-accent/40 bg-accent/15 px-5 py-4">
                  <div className="label text-accent-bright">already counted · code</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-white">
                    {entryGate.code}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    This session was used earlier. Find your code on the scoreboard below.
                  </div>
                </div>
              ) : (
                <form onSubmit={submitHandle} className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <input
                    type="text"
                    inputMode="email"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="handle or email"
                    value={handleInput}
                    onChange={(e) => setHandleInput(e.target.value)}
                    className="contest-input w-full flex-1 rounded-xl border-2 border-accent/50 bg-black/55 px-4 py-4 font-mono text-base text-white placeholder:text-muted/80 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/60"
                    minLength={3}
                    maxLength={64}
                    required
                  />
                  <button
                    type="submit"
                    className="btn btn-primary px-6 py-4 text-base"
                    disabled={raffleStatus === 'submitting' || handleInput.trim().length < 3}
                  >
                    {raffleStatus === 'submitting' ? 'Sending…' : 'Enter →'}
                  </button>
                </form>
              )}
              {entryGate?.status === 'ok' && typeof entryGate.used === 'number' && (
                <div className="mt-2 text-xs text-muted/80">
                  {entryGate.cap! - entryGate.used} of {entryGate.cap} entries left this hour.
                </div>
              )}
              {raffleError && (
                <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {raffleError}
                </div>
              )}

              {leaderboard.length > 0 && (
                <div className="mt-7 border-t border-edge/60 pt-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="label">Scoreboard</h3>
                    <span className="label text-muted/70">top 25</span>
                  </div>
                  <ol className="space-y-1">
                    {leaderboard.map((r, i) => (
                      <ScoreboardRow
                        key={r.code}
                        rank={i + 1}
                        row={r}
                        highlight={raffleEntry?.code === r.code}
                      />
                    ))}
                  </ol>
                </div>
              )}
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
              <button
                className="btn w-full border-red-500/40 hover:border-red-400/60 sm:w-auto"
                onClick={reset}
              >
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

      {/* Timeout — calmer than an error, because expiring a QR is normal. */}
      {phase === 'timeout' && (
        <section className="card border-white/15 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
              <IconShield className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xl font-semibold">QR code timed out</div>
              <div className="text-sm text-muted">
                The code expires after five minutes. Generate a fresh one and try again.
              </div>
            </div>
            <button className="btn btn-primary w-full sm:w-auto" onClick={reset}>
              New QR
            </button>
          </div>
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
            <button
              className="btn w-full border-red-500/40 hover:border-red-400/60 sm:w-auto"
              onClick={reset}
            >
              Retry
            </button>
          </div>
        </section>
      )}

      <section className="prose-body mt-4 space-y-8 border-t border-white/10 pt-10">
        <div className="space-y-3">
          <p className="text-lg leading-relaxed text-white/85">
            Scan a QR code on your laptop with your phone. A quick integrity check of the network
            and the devices, and the site gets a yes/no signal: &ldquo;this looks like a real device
            operated by a real person.&rdquo;
          </p>
          <p className="text-lg leading-relaxed text-white/85">That&apos;s the whole idea.</p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Why I made this</h2>
          <p className="text-lg leading-relaxed text-white/85">
            When Google shipped QR-code reCAPTCHA, a lot of people objected.<sup>*</sup> Not because
            the idea of using a phone was bad, but because of what came with it.
          </p>
          <p className="text-lg leading-relaxed text-white/85">The usual complaints were:</p>
          <ul className="list-disc space-y-1 pl-6 text-lg leading-relaxed text-white/85">
            <li>you had to install or use Google&apos;s app;</li>
            <li>you had to be signed into a Google account;</li>
            <li>the check tied an unrelated website session back to Google identity;</li>
            <li>it pushed more of the web through one identity provider.</li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            So the underlying pattern is still interesting from a CAPTCHA perspective. To pass, a
            bot has to fake clean fingerprints on two devices, route both through a clean changing
            network, and coordinate the two in real time. Real people do that dozens of times a day
            without thinking about it. The question is whether that gap is wide enough to make a
            useful CAPTCHA.
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
          <p className="text-lg leading-relaxed text-white/85">
            This version is deliberately small:
          </p>
          <ul className="list-disc space-y-1 pl-6 text-lg leading-relaxed text-white/85">
            <li>no app install;</li>
            <li>no account;</li>
            <li>no third-party identity provider;</li>
            <li>no cross-site user profile;</li>
            <li>native camera scan;</li>
            <li>works with the phone&apos;s browser.</li>
          </ul>
          <p className="text-lg leading-relaxed text-white/85">
            The desktop shows a QR code. The phone scans it. The phone performs a device integrity
            check. The server gets only what it needs to make this one decision.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            For Apple devices that can already produce a Private Access Token, the QR step can be
            skipped entirely.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="text-lg leading-relaxed text-white/85">
            The verdict combines three signals.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            First, a <strong className="text-white">network check</strong>: where is the request
            actually coming from? Cloud datacenter IPs, anonymizing proxies, residential proxy
            networks, and corporate filters all leave different fingerprints.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            Second, a <strong className="text-white">browser check</strong>: a small script looks
            for obvious automation tells. Playwright, Puppeteer hooks, fake timing, navigator
            inconsistencies, and other browser-side signals.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            Third, a <strong className="text-white">phone check</strong>: the phone proves it is
            real hardware using the platform&apos;s existing attestation path — Secure Enclave on
            iPhone, StrongBox on Android, TPM on Windows. A VM or emulator should not be able to
            fake that cleanly.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            None of these signals is perfect. Combined, they make cheap automation more expensive.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Accessibility matters</h2>
          <p className="text-lg leading-relaxed text-white/85">
            A lot of current CAPTCHA systems quietly punish people using assistive technology,
            low-vision users, privacy-hardened browsers, or anyone who simply does not move a mouse
            in the expected way.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            This approach should be less hostile. Holding up a phone for Face ID, Touch ID, or a
            device prompt is already a familiar interaction for many people. It is not perfect, but
            it avoids some of the worst assumptions baked into behavioral CAPTCHA systems.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">Not a silver bullet</h2>
          <p className="text-lg leading-relaxed text-white/85">
            This does not stop every attacker.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            It catches the long tail: headless browsers, scripted clients, disposable VMs, basic bot
            traffic, and residential proxy abuse.
          </p>
          <p className="text-lg leading-relaxed text-white/85">
            Payment fraud, account takeover, and high-value abuse still need defense in depth. This
            is the front gate, not the whole security system.
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="text-3xl font-semibold tracking-tight">
            Why I think this is worth exploring
          </h2>
          <p className="text-lg leading-relaxed text-white/85">
            Modern CAPTCHAs are losing to AI. GPT-class vision models solve image puzzles with high
            accuracy. Commercial solver services advertise 99%+ success rates against reCAPTCHA,
            hCaptcha, and FunCaptcha — often for a few dollars per thousand calls. A free Chrome
            extension routes the audio fallback through speech-to-text. And the enterprise-tier
            defenses sites pay six figures for — Akamai Bot Manager, HUMAN Security (formerly
            PerimeterX) — have bypass walkthroughs published on commercial scraping blogs.
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
                href="https://anti-captcha.com/"
                className="font-medium text-violet-300 underline underline-offset-4 hover:text-violet-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Anti-Captcha — real people solving CAPTCHAs around the clock for about a dollar per
                thousand
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
            Meanwhile, phones already have hardware-backed integrity systems. Browsers already have
            native camera support. Platforms already have biometric prompts. The pieces exist —
            FIDO/WebAuthn even ships the cross-device pattern (desktop QR → phone authenticates) for{' '}
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
            The question is whether we can use them without turning every login, comment form, or
            checkout page into another identity checkpoint.
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
