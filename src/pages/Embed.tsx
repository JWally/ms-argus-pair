import { useEffect, useRef, useState } from 'react';
import { startDesktopSession, type DesktopSession } from '../lib/pair';
import { QrCanvas, buildQrMatrix, type QrMatrix } from '../lib/qr';

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
  const [status, setStatus] = useState('starting…');
  const [connected, setConnected] = useState(false);
  const sessionRef = useRef<DesktopSession | null>(null);

  useEffect(() => {
    const postUp = (msg: UpMsg) =>
      window.parent.postMessage({ source: 'argus-captcha', ...msg }, hostOrigin);

    let cancelled = false;
    (async () => {
      try {
        const session = await startDesktopSession(
          {
            onStatus: (s) => !cancelled && setStatus(s),
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
        setStatus('Scan with your phone');
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
        setStatus(verdict.verdict === 'paired' ? 'Paired ✓' : 'Pairing failed');
      } catch (e) {
        if (cancelled) return;
        setStatus('Error');
        postUp({ event: 'error', message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current?.stop();
    };
  }, [hostOrigin, cpi]);

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-bg-primary p-4 text-fg-primary">
      <div className="w-full max-w-[16rem]">
        <div className="qr-stage relative aspect-square w-full overflow-hidden rounded-lg bg-white p-3">
          {matrix ? (
            <div
              className={`qr-svg absolute inset-0 block aspect-square w-full ${
                connected ? 'qr-blurred' : 'qr-arrived'
              }`}
            >
              <QrCanvas matrix={matrix} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-fg-muted">…</div>
          )}
        </div>
      </div>
      <p className="text-sm text-fg-secondary" aria-live="polite">
        {connected ? 'Phone connected — finishing…' : status}
      </p>
    </div>
  );
}
