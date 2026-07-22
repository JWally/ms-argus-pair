import { useEffect, useRef, useState } from 'react';
import { readEmbedConfig, readEmbedViewportWidth } from '../lib/embed-config';
import {
  getEmbedPresentation,
  SCAN_HINT_DELAY_MS,
  type EmbedCompletion,
} from '../lib/embed-presentation';
import { startEmbedSession, type EmbedHostMessage } from '../lib/embed-session';
import { EmbedView } from './EmbedView';
import './embed.css';

/**
 * Embeddable pairing widget controller.
 *
 * The session runtime owns QR resources and protocol completion; the view owns
 * markup. This controller keeps iframe effects and posts only to the exact host
 * origin supplied by the loader (`*` remains the unframed development fallback).
 */

function postHostMessage(hostOrigin: string, message: EmbedHostMessage): void {
  window.parent.postMessage({ source: 'argus-captcha', ...message }, hostOrigin);
}

export function Embed() {
  const [{ hostOrigin, cpi, challengeId }] = useState(() =>
    readEmbedConfig(window.location.search)
  );
  const [qrReady, setQrReady] = useState(false);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showScanHint, setShowScanHint] = useState(false);
  const [completion, setCompletion] = useState<EmbedCompletion>(null);
  const [compact, setCompact] = useState(false);
  const moduleRef = useRef<HTMLDivElement | null>(null);

  // The iframe's media queries cannot see the embedding page width.
  useEffect(() => {
    if (window.parent === window) return;
    const onMessage = (event: MessageEvent) => {
      const width = readEmbedViewportWidth(event, window.parent, hostOrigin);
      if (width !== null) setCompact(width < 640);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [hostOrigin]);

  // Report the module's real height so the loader can fit the iframe.
  useEffect(() => {
    const element = moduleRef.current;
    if (!element || window.parent === window) return;
    const reportHeight = () =>
      postHostMessage(hostOrigin, {
        event: 'size',
        height: Math.ceil(element.offsetHeight),
      });
    const observer = new ResizeObserver(reportHeight);
    observer.observe(element);
    reportHeight();
    return () => observer.disconnect();
  }, [hostOrigin]);

  useEffect(() => {
    if (!qrReady || connected || completion) return;
    const timer = window.setTimeout(() => setShowScanHint(true), SCAN_HINT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connected, completion, qrReady]);

  useEffect(() => {
    const run = startEmbedSession(
      { cpi, challengeId },
      {
        onConnected: () => setConnected(true),
        onQrReady: (imageUrl) => {
          setQrImageUrl(imageUrl);
          setQrReady(true);
        },
        onQrFrame: setQrImageUrl,
        onCompletion: setCompletion,
        notifyHost: (message) => postHostMessage(hostOrigin, message),
      }
    );
    return run.stop;
  }, [challengeId, cpi, hostOrigin]);

  const presentation = getEmbedPresentation({ connected, completion, showScanHint });
  return (
    <EmbedView
      ref={moduleRef}
      compact={compact}
      qrReady={qrReady}
      qrImageUrl={qrImageUrl}
      connected={connected}
      presentation={presentation}
    />
  );
}
