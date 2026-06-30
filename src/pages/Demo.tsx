import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { QrCanvas, buildQrMatrix, type QrMatrix } from '../lib/qr';
import {
  fetchLeaderboard,
  fetchRaffleStatus,
  HttpError,
  startDesktopSession,
  submitRaffleEntry,
  type DesktopAttestedSummary,
  type LeaderboardRow,
  type RaffleStatus as RaffleEntryGate,
} from '../lib/pair';
import { Wordmark } from '../components/Brand';
import { AnnotationsCard } from '../components/AnnotationsCard';
import { DeviceComparisonCard } from '../components/DeviceComparisonCard';
import { IconCheck, IconX, IconPhone, IconShield } from '../components/Icons';

type Phase = 'idle' | 'scanning' | 'waiting' | 'paired' | 'failed' | 'error' | 'timeout';
type RaffleStatus = 'idle' | 'submitting' | 'entered' | 'error';

const CONTEST_TARGET = 1000;

interface MarketingCard {
  label: string;
  title: string;
  body: string;
}

const MARKETING_CARDS: MarketingCard[] = [
  {
    label: '01',
    title: 'Challenge the device graph',
    body: 'Pair the desktop session to a phone-side proof so scripted traffic has to control two coherent devices at once.',
  },
  {
    label: '02',
    title: 'Keep the user in flow',
    body: 'A native camera scan plus Face ID, Touch ID, passkey, or OAuth proof replaces puzzle solving with a familiar device action.',
  },
  {
    label: '03',
    title: 'Control the outcome',
    body: 'The backend receives a signed verdict it can combine with Argus browser, network, and account risk rules — allow, step up, review, or block.',
  },
];

const USE_CASES = [
  'High-risk login and password reset',
  'Signup abuse and promotion farming',
  'Checkout, card testing, and account recovery',
  'Human handoff when silent integrity is not enough',
];

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
      className={`flex items-center justify-between rounded-lg px-3 py-2 font-mono text-sm ${
        highlight
          ? 'bg-accent/25 font-semibold text-white ring-1 ring-accent/50'
          : isLeader
            ? 'bg-white/[0.04] font-semibold text-fg-primary'
            : 'text-fg-secondary'
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="w-7 shrink-0 text-right tabular-nums text-fg-muted">{rank}</span>
        <span className="truncate">{row.code}</span>
      </span>
      <span className="tabular-nums text-fg-muted">{row.count}</span>
    </li>
  );
}

function StatusPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-light px-3 py-1 text-xs font-medium text-accent">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
        style={{ animation: 'argusPulse 2s ease-in-out infinite' }}
      />
      {children}
    </span>
  );
}

/**
 * Pre-arrival loading state: the argus.pair wordmark bounces around
 * the QR slot DVD-screensaver style. X and Y on non-commensurate
 * periods so the path never repeats.
 */
function QrLoadingGlyphs() {
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

function QrPanel({ matrix, disabled = false }: { matrix: QrMatrix | null; disabled?: boolean }) {
  const flipTiles = disabled ? Array.from({ length: 144 }, (_, i) => i) : [];
  return (
    <div
      className={`qr-frame mx-auto w-full max-w-[18rem] sm:max-w-[22rem] lg:max-w-[24rem] ${
        disabled ? 'qr-disabled' : ''
      }`}
      aria-disabled={disabled}
    >
      {matrix ? (
        <div className="qr-stage relative aspect-square w-full overflow-hidden rounded-lg">
          <div
            className={`qr-svg absolute inset-0 block aspect-square w-full ${
              disabled ? 'qr-blurred' : 'qr-arrived'
            }`}
          >
            <QrCanvas matrix={matrix} />
          </div>
          {disabled && (
            <div className="qr-flip-grid" aria-hidden>
              {flipTiles.map((tile) => (
                <span
                  className="qr-flip-tile"
                  key={tile}
                  style={{ animationDelay: `${(tile % 12) * 18 + Math.floor(tile / 12) * 9}ms` }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <QrLoadingGlyphs />
      )}
    </div>
  );
}

const NAV_LINKS: ReadonlyArray<[string, string]> = [
  ['#demo', 'Demo'],
  ['#how', 'How it works'],
  ['#integrate', 'Integration'],
];

function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg-primary/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <a href="#top" className="shrink-0">
          <Wordmark />
        </a>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-bg-tertiary hover:text-fg-primary"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            className="btn-secondary-sm hidden uppercase tracking-wide sm:inline-flex"
            to="/merchant"
          >
            Mobile SSO
          </Link>
          <a
            href="mailto:hello@argus.pw"
            className="btn-primary-sm hidden uppercase tracking-wide sm:inline-flex"
          >
            Talk to us
          </a>
          <button
            type="button"
            aria-label="Toggle menu"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-fg-secondary transition-colors hover:bg-bg-tertiary md:hidden"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {open ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-bg-primary md:hidden">
          <div className="mx-auto flex max-w-6xl flex-col px-4 py-3 sm:px-6">
            {NAV_LINKS.map(([href, label]) => (
              <a
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm font-medium text-fg-secondary hover:bg-bg-tertiary hover:text-fg-primary"
              >
                {label}
              </a>
            ))}
            <Link
              to="/merchant"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm font-medium uppercase tracking-wide text-fg-secondary hover:bg-bg-tertiary hover:text-fg-primary"
            >
              Mobile SSO
            </Link>
            <a
              href="mailto:hello@argus.pw"
              onClick={() => setOpen(false)}
              className="mt-2 btn-primary-sm uppercase tracking-wide"
            >
              Talk to us
            </a>
          </div>
        </div>
      )}
    </header>
  );
}

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [phoneConnected, setPhoneConnected] = useState(false);
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

  const qrMatrix = useMemo<QrMatrix | null>(
    () => (pairUrl ? buildQrMatrix(pairUrl) : null),
    [pairUrl]
  );

  const showPairing = phase === 'idle' || phase === 'scanning' || phase === 'waiting';

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
    setPhoneConnected(false);
    setEntryGate(null);
    setRaffleStatus('idle');
    setRaffleError(null);
    setRaffleEntry(null);
    setHandleInput('');
    try {
      const session = await startDesktopSession({
        onStatus: setStatus,
        onDesktopAttested: setDesktopAttested,
        onPhoneConnected: () => {
          setPhoneConnected(true);
          setStatus('phone connected');
        },
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
      if (msg.includes('session expired')) {
        setPhase('timeout');
      } else {
        setPhase('error');
        setErrorMsg(msg);
      }
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
    setPhoneConnected(false);
    setDesktopAttested(null);
    setSessionId(null);
    setEntryGate(null);
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
          setRaffleError('Session expired. Run the challenge again and re-pair.');
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
    <div className="flex min-h-[100dvh] flex-col bg-bg-primary text-fg-primary">
      <Nav />

      <main className="flex-1">
        <section id="top" className="relative overflow-hidden" style={{ scrollMarginTop: '5rem' }}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 70% 55% at 50% -10%, var(--accent-light) 0%, transparent 70%)',
            }}
          />
          <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
            <div className="flex flex-col justify-center">
              <StatusPill>Real-time integrity · agentic defense</StatusPill>

              <h1
                className="mt-5 text-3xl font-semibold leading-[1.1] tracking-tight text-fg-primary sm:text-4xl lg:text-5xl"
                style={{
                  textShadow: '0 0 2px rgba(0, 0, 0, 0.7), 0 2px 14px rgba(0, 0, 0, 0.55)',
                }}
              >
                Stop sophisticated bots.
                <span
                  className="mt-2 block text-accent"
                  style={{
                    textShadow:
                      '0 0 1px rgba(255, 255, 255, 0.28), 0 0 14px rgba(255, 255, 255, 0.12)',
                  }}
                >
                  Prove the human.
                </span>
              </h1>

              <p className="mt-5 max-w-xl text-lg leading-relaxed text-fg-secondary">
                When silent signals aren&rsquo;t enough, Argus Pair escalates the risky session to a
                device-backed proof — and hands your backend a signed verdict on every agent hitting
                your flows.
              </p>
              <p className="mt-4 max-w-xl text-lg leading-relaxed text-fg-primary">
                No app install. No puzzle marketplace. No third-party identity checkpoint.
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <a
                  href="#demo"
                  className="btn-primary-lg uppercase tracking-wide"
                  onClick={() => {
                    if (!showPairing) reset();
                  }}
                >
                  Run the challenge
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </a>
                <a href="#how" className="btn-secondary-lg">
                  How it works
                </a>
              </div>

              <ul className="mt-8 grid gap-3 text-sm text-fg-secondary sm:grid-cols-2">
                {[
                  'Cross-device proof for high-risk sessions',
                  'Passkey, OAuth, and trusted-device paths',
                  'Server-side verdict — never client-side trust',
                  'Silent when possible, explicit when it counts',
                ].map((claim) => (
                  <li key={claim} className="flex items-start gap-2">
                    <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span>{claim}</span>
                  </li>
                ))}
              </ul>

              {/* On a phone you can't scan a desktop QR with the same device —
                  route mobile visitors to the mobile SSO proof instead. */}
              <div className="mt-7 lg:hidden">
                <Link
                  to="/merchant"
                  className="btn-primary-lg w-full justify-center uppercase tracking-wide"
                >
                  Use mobile SSO
                </Link>
              </div>
            </div>

            {/* Desktop-only: the QR is scanned with a separate phone. Mobile
                visitors use the "Use mobile SSO" path in the hero column. */}
            <div id="demo" className="hidden p-4 lg:block lg:pl-4">
              {showPairing ? (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-[0.18em] text-fg-muted">
                      Live challenge
                    </span>
                    <span className="inline-flex items-center gap-2 text-xs text-fg-secondary">
                      <span className="spinner" />
                      {phoneConnected ? 'Phone connected' : status || 'starting'}
                    </span>
                  </div>
                  <QrPanel matrix={qrMatrix} disabled={phoneConnected} />
                  <div className="mt-5 grid gap-3 text-sm text-fg-secondary">
                    <div className="flex items-start gap-3">
                      <IconPhone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                      <span>
                        {phoneConnected
                          ? 'Finish on your phone — this page updates automatically.'
                          : 'Open your phone camera and scan the QR code.'}
                      </span>
                    </div>
                    <div className="flex items-start gap-3">
                      <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                      <span>Phone proof binds back to this desktop session.</span>
                    </div>
                  </div>
                </div>
              ) : (
                <ResultPanel
                  phase={phase}
                  verdictReason={verdictReason}
                  errorMsg={errorMsg}
                  onReset={reset}
                />
              )}
            </div>
          </div>
        </section>

        {desktopAttested?.clean && showPairing && (
          <section className="border-y border-border bg-bg-secondary/40">
            <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
              <div className="flex items-start gap-3 text-sm">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-positive/15 text-positive">
                  <IconCheck className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-semibold text-fg-primary">Desktop integrity passed</div>
                  <div className="text-fg-secondary">
                    Verified Apple device
                    {desktopAttested.summary?.browser_name
                      ? ` (${desktopAttested.summary.browser_name}${
                          desktopAttested.summary.os ? ` · ${desktopAttested.summary.os}` : ''
                        })`
                      : ''}
                    . In production, clean low-risk sessions can skip the phone step.
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        <section id="how" className="border-t border-border bg-bg-secondary/40">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-3xl text-center">
              <StatusPill>How it works</StatusPill>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg-primary sm:text-4xl">
                Adaptive defense, built for fraud teams.
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-fg-secondary">
                Pair is the visible step-up for sessions where silent browser and network integrity
                need a second device to settle the decision — detect, prove, and control the
                outcome.
              </p>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {MARKETING_CARDS.map((card) => (
                <article
                  key={card.label}
                  className="rounded-2xl border border-border bg-bg-primary p-6"
                >
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                    {card.label}
                  </div>
                  <h3 className="mt-4 text-xl font-semibold text-fg-primary">{card.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-fg-secondary">{card.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <StatusPill>Use cases</StatusPill>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg-primary sm:text-4xl">
                Challenge only when the economics make sense.
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-fg-secondary">
                Keep normal users on the silent Argus path. Escalate when the browser, network,
                account, or transaction asks for stronger proof.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {USE_CASES.map((item) => (
                <div key={item} className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <IconCheck className="h-5 w-5 text-accent" />
                  <div className="mt-3 text-base font-semibold text-fg-primary">{item}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="integrate" className="border-t border-border bg-bg-secondary/40">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="grid gap-6 lg:grid-cols-2">
              <article className="rounded-2xl border border-border bg-bg-primary p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">
                  1
                </div>
                <h3 className="mt-5 text-xl font-semibold text-fg-primary">Trigger on risk</h3>
                <p className="mt-3 text-sm leading-relaxed text-fg-secondary">
                  Call Pair from signup, login, checkout, or recovery when your rules want more
                  evidence than a silent scan can provide.
                </p>
              </article>
              <article className="rounded-2xl border border-border bg-bg-primary p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">
                  2
                </div>
                <h3 className="mt-5 text-xl font-semibold text-fg-primary">
                  Redeem the verdict server-side
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-fg-secondary">
                  The user returns with a bound session result. Your backend decides whether to
                  allow, step up, review, or block.
                </p>
              </article>
            </div>
          </div>
        </section>

        {(phase === 'paired' || phase === 'failed') && annotations && (
          <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pb-16 sm:px-6">
            <DeviceComparisonCard annotations={annotations} />
            <AnnotationsCard annotations={annotations} />
          </section>
        )}

        {phase === 'paired' && (
          <section className="border-t border-border bg-bg-secondary/40">
            <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
              <div className="rounded-2xl border border-accent-border bg-bg-primary p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <StatusPill>Game live</StatusPill>
                  <span className="text-xs font-medium uppercase tracking-[0.18em] text-fg-muted">
                    first to {CONTEST_TARGET.toLocaleString()}
                  </span>
                </div>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg-primary">
                  Claim your spot.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-secondary">
                  One entry per paired session. Three per hour per device. First handle to{' '}
                  {CONTEST_TARGET.toLocaleString()} entries wins.
                </p>

                {raffleStatus === 'entered' ? (
                  <div className="mt-6 rounded-xl border border-accent-border bg-accent-light px-5 py-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                      you&apos;re in · code
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold text-fg-primary">
                      {raffleEntry?.code} <span className="text-fg-muted">·</span>{' '}
                      {raffleEntry?.count} {raffleEntry?.count === 1 ? 'entry' : 'entries'}
                    </div>
                    <div className="mt-1 text-xs text-fg-secondary">
                      Find this code on the scoreboard below.
                    </div>
                  </div>
                ) : entryGate?.status === 'rate_limited' ? (
                  <div className="mt-6 rounded-xl border border-amber-400/35 bg-amber-400/10 px-5 py-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200">
                      limit reached
                    </div>
                    <div className="mt-1 text-sm text-fg-primary">
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
                  <div className="mt-6 rounded-xl border border-accent-border bg-accent-light px-5 py-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                      already counted · code
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold text-fg-primary">
                      {entryGate.code}
                    </div>
                    <div className="mt-1 text-xs text-fg-secondary">
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
                      className="w-full flex-1 rounded-xl border border-border bg-bg-secondary px-4 py-4 font-mono text-base text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/35"
                      minLength={3}
                      maxLength={64}
                      required
                    />
                    <button
                      type="submit"
                      className="btn-primary px-6 py-4 text-base"
                      disabled={raffleStatus === 'submitting' || handleInput.trim().length < 3}
                    >
                      {raffleStatus === 'submitting' ? 'Sending...' : 'Enter'}
                    </button>
                  </form>
                )}
                {entryGate?.status === 'ok' && typeof entryGate.used === 'number' && (
                  <div className="mt-2 text-xs text-fg-muted">
                    {entryGate.cap! - entryGate.used} of {entryGate.cap} entries left this hour.
                  </div>
                )}
                {raffleError && (
                  <div className="mt-3 rounded-md border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-red-200">
                    {raffleError}
                  </div>
                )}

                {leaderboard.length > 0 && (
                  <div className="mt-7 border-t border-border pt-5">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
                        Scoreboard
                      </h3>
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
                        top 25
                      </span>
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
          </section>
        )}

        <section className="border-t border-border">
          <div className="relative mx-auto w-full max-w-6xl overflow-hidden px-4 py-16 sm:px-6 sm:py-24">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse 60% 70% at 50% 100%, var(--accent-light) 0%, transparent 70%)',
              }}
            />
            <div className="relative mx-auto max-w-3xl text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-fg-primary sm:text-4xl">
                Flip the economics of bad bots in your favor.
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-fg-secondary">
                Run Pair after Argus Integrity, not instead of it. Silent when possible, explicit
                when needed.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <a href="mailto:hello@argus.pw" className="btn-primary-lg uppercase tracking-wide">
                  Talk to us
                </a>
                <Link to="/merchant" className="btn-secondary-lg">
                  Try mobile SSO
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-4 py-8 text-center text-xs text-fg-muted">
        Argus Pair · device-backed step-up challenge
      </footer>
    </div>
  );
}

function ResultPanel({
  phase,
  verdictReason,
  errorMsg,
  onReset,
}: {
  phase: Phase;
  verdictReason: string | null;
  errorMsg: string | null;
  onReset(): void;
}) {
  if (phase === 'paired') {
    return (
      <div className="rounded-2xl border border-positive/40 bg-positive/10 p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-positive/15 text-positive">
          <IconCheck className="h-6 w-6" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold text-fg-primary">Verified</h2>
        <p className="mt-2 text-sm text-fg-secondary">
          {verdictReason ? verdictReason.replace(/_/g, ' ') : 'both attestations checked out'}
        </p>
        <button className="btn-secondary mt-6 w-full sm:w-auto" onClick={onReset}>
          Run again
        </button>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="rounded-2xl border border-negative/40 bg-negative/10 p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-negative/15 text-negative">
          <IconX className="h-6 w-6" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold text-fg-primary">Verification denied</h2>
        <p className="mt-2 text-sm text-fg-secondary">
          {verdictReason ? verdictReason.replace(/_/g, ' ') : 'a rule rejected the pair'}
        </p>
        <button className="btn-secondary mt-6 w-full sm:w-auto" onClick={onReset}>
          Try again
        </button>
      </div>
    );
  }

  if (phase === 'timeout') {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-6">
        <IconShield className="h-10 w-10 text-accent" />
        <h2 className="mt-5 text-2xl font-semibold text-fg-primary">QR code timed out</h2>
        <p className="mt-2 text-sm text-fg-secondary">
          The code expires quickly. Generate a fresh one and try again.
        </p>
        <button className="btn-primary mt-6 w-full sm:w-auto" onClick={onReset}>
          New QR
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-negative/40 bg-negative/10 p-6">
      <IconX className="h-10 w-10 text-negative" />
      <h2 className="mt-5 text-2xl font-semibold text-fg-primary">Something went wrong</h2>
      <p className="mt-2 break-all text-sm text-fg-secondary">{errorMsg}</p>
      <button className="btn-secondary mt-6 w-full sm:w-auto" onClick={onReset}>
        Retry
      </button>
    </div>
  );
}
