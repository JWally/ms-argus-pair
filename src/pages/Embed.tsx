import { useEffect, useRef, useState } from 'react';
import { startDesktopSession, type DesktopSession } from '../lib/pair';
import { QrCanvas, buildQrMatrix, type QrMatrix } from '../lib/qr';
import './embed.css';

/**
 * Embeddable pairing widget body.
 *
 * Served cross-origin inside the customer's `captcha.js` iframe. It runs the
 * normal desktop pairing session (which already does ECDH + device attestation
 * via the integrity SDK), renders the QR with lib/qr, and posts lifecycle +
 * result messages UP to the host page. The host verifies `sessionId`
 * server-to-server against GET /v1/session/{cpi}/{session_id} — the browser
 * message is a notification, never the trusted verdict.
 *
 * Visual direction: the captcha as a live device handshake — a dark "secure
 * module" whose signature is the desktop <-> phone co-attestation track. Styles
 * are scoped under `.aegis` in embed.css.
 *
 * Security: we only ever postMessage to the exact host origin the loader handed
 * us via `?origin=`, never `*` (except the dev fallback when unframed).
 */

type UpMsg =
  | { event: 'ready'; sessionId: string }
  | { event: 'connected' }
  | {
      event: 'result';
      sessionId: string;
      verdict: string;
      reason: string | null;
      token: string | null;
    }
  | { event: 'error'; message: string };

const CPI_FORMAT = /^argus_cpi_(test|live)_[A-Za-z0-9]{10,40}$/;

type Phase = 'scanning' | 'pairing' | 'verified' | 'failed';

const COPY: Record<Phase, { title: string; sub: string }> = {
  scanning: { title: 'Scan with your phone', sub: 'Point your camera at the code' },
  pairing: { title: 'Phone connected — verifying…', sub: 'Checking this is a real device' },
  verified: { title: 'Verified', sub: "You're all set" },
  failed: { title: "Couldn't verify", sub: 'Try again on a trusted network' },
};

const STATUS_LABEL: Record<Phase, string> = {
  scanning: 'live · secure',
  pairing: 'pairing',
  verified: 'verified',
  failed: 'blocked',
};

const svg = { fill: 'none', stroke: 'currentColor' } as const;

const EyeMark = () => (
  <svg className="ax-eye" viewBox="0 0 24 24" strokeWidth={2} {...svg}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);
const MonitorIcon = () => (
  <svg viewBox="0 0 24 24" strokeWidth={1.8} {...svg}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);
const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" strokeWidth={1.8} {...svg}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);
const SealCheck = () => (
  <svg className="ax-ring" viewBox="0 0 48 48" strokeWidth={2.4} {...svg}>
    <circle cx="24" cy="24" r="21" opacity="0.28" />
    <circle cx="24" cy="24" r="14" />
    <path
      d="M17.5 24.5l4.5 4.5 9-10"
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const SealCross = () => (
  <svg className="ax-ring" viewBox="0 0 48 48" strokeWidth={2.4} {...svg}>
    <circle cx="24" cy="24" r="21" opacity="0.28" />
    <circle cx="24" cy="24" r="14" />
    <path d="M19 19l10 10M29 19l-10 10" strokeWidth={3.2} strokeLinecap="round" />
  </svg>
);

/** Read the loader-provided config from the iframe URL (host origin + merchant CPI). */
function useEmbedConfig(): { hostOrigin: string; cpi: string | undefined } {
  const params = new URLSearchParams(window.location.search);
  const hostOrigin = params.get('origin') || '*';
  const rawCpi = params.get('cpi') || '';
  // Only forward a well-formed CPI; otherwise fall back to the engine default.
  return { hostOrigin, cpi: CPI_FORMAT.test(rawCpi) ? rawCpi : undefined };
}

export function Embed() {
  const { hostOrigin, cpi } = useEmbedConfig();
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState<null | 'paired' | 'failed'>(null);
  const sessionRef = useRef<DesktopSession | null>(null);

  useEffect(() => {
    const postUp = (msg: UpMsg) =>
      window.parent.postMessage({ source: 'argus-captcha', ...msg }, hostOrigin);

    let cancelled = false;
    (async () => {
      try {
        const session = await startDesktopSession(
          {
            onPhoneConnected: () => {
              if (cancelled) return;
              setConnected(true);
              postUp({ event: 'connected' });
            },
            onError: (e) => postUp({ event: 'error', message: String(e) }),
          },
          { cpi }
        );
        if (cancelled) {
          session.stop();
          return;
        }
        sessionRef.current = session;
        setMatrix(buildQrMatrix(session.pairUrl));
        postUp({ event: 'ready', sessionId: session.sessionId });

        const verdict = await session.result;
        if (cancelled) return;
        // Fetch the server-signed verdict token to hand the host for siteverify.
        const token = await session.getVerdictToken();
        if (cancelled) return;
        postUp({
          event: 'result',
          sessionId: session.sessionId,
          verdict: verdict.verdict,
          reason: verdict.reason,
          token,
        });
        setDone(verdict.verdict === 'paired' ? 'paired' : 'failed');
      } catch (e) {
        if (cancelled) return;
        setDone('failed');
        postUp({ event: 'error', message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current?.stop();
    };
  }, [hostOrigin, cpi]);

  const phase: Phase =
    done === 'paired'
      ? 'verified'
      : done === 'failed'
        ? 'failed'
        : connected
          ? 'pairing'
          : 'scanning';
  const copy = COPY[phase];

  return (
    <div className="aegis-stage">
      <div className={`aegis ${phase}`}>
        <div className="ax-bar">
          <div className="ax-brand">
            <EyeMark />
            <span className="ax-name">ARGUS</span>
          </div>
          <div className="ax-stat">
            <span className="ax-dot" />
            <span>{STATUS_LABEL[phase]}</span>
          </div>
        </div>

        <div className="ax-scan">
          <div className="ax-tile">
            {matrix ? <QrCanvas matrix={matrix} /> : <span className="ax-tile-load" />}
          </div>
          <div className="ax-seal">
            {phase === 'verified' ? <SealCheck /> : phase === 'failed' ? <SealCross /> : null}
          </div>
          <span className="ax-tick tl" />
          <span className="ax-tick tr" />
          <span className="ax-tick bl" />
          <span className="ax-tick br" />
        </div>

        <p className="ax-label" aria-live="polite">
          {copy.title}
          <span className="ax-sub">{copy.sub}</span>
        </p>

        <div className="ax-link">
          <div className="ax-node here">
            <span className="ax-chip">
              <MonitorIcon />
            </span>
            <span className="ax-tag">this device</span>
          </div>
          <div className="ax-track">
            <span className="ax-rail" />
            <span className="ax-live" />
            <span className="ax-pulse" />
          </div>
          <div className={`ax-node ${phase === 'scanning' ? '' : 'here'}`}>
            <span className="ax-chip">
              <PhoneIcon />
            </span>
            <span className="ax-tag">your phone</span>
          </div>
        </div>
      </div>
    </div>
  );
}
