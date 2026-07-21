/*
 * Argus Captcha — embeddable QR device-pairing widget loader.
 *
 *   <script src="https://static-captcha.argus.pw/captcha.js"
 *           data-cpi="argus_cpi_live_..." data-challenge-id="..."
 *           data-onresult="myCallback"></script>
 *   <div class="argus-captcha"></div>
 *
 * The loader injects a CROSS-ORIGIN iframe at the Argus pairing app's `/embed`
 * (the origin is baked at build time — see __EMBED_ORIGIN__ — because this
 * loader is served from a separate CDN, so we can't infer the app origin from
 * the script URL). All sensitive work (session, ECDH, attestation, QR pixels)
 * runs in the Argus origin, isolated from the host page. The host MUST verify
 * the returned token server-to-server (POST /api/verify) — the browser message
 * is a notification, not proof.
 */

import { parseCaptchaMessage, type CaptchaResult } from './message-contract';

// Replaced at build time by esbuild `define`.
declare const __EMBED_ORIGIN__: string;

interface RenderOpts {
  cpi?: string;
  challengeId?: string;
  embedOrigin?: string;
  onResult?: (r: CaptchaResult) => void;
  onEvent?: (e: Record<string, unknown>) => void;
}

interface MobileSsoOpts {
  cpi?: string;
  challengeId?: string;
  returnUrl: string;
}

interface CaptchaHandle {
  destroy: () => void;
}

(function () {
  const me = document.currentScript as HTMLScriptElement | null;
  if (!me) return;

  // Embed origin: data-embed-origin override (testing) else the baked default.
  const BAKED_ORIGIN = me.getAttribute('data-embed-origin') || __EMBED_ORIGIN__;
  const defaultCpi = me.getAttribute('data-cpi') || '';
  const defaultChallengeId = me.getAttribute('data-challenge-id') || '';
  const defaultCbName = me.getAttribute('data-onresult') || '';
  const hostOrigin = window.location.origin;
  const win = window as unknown as Record<string, unknown>;
  // Matches Tailwind's max-w-md: roomy enough for the widget while still
  // yielding to narrower merchant containers and mobile viewports.
  const DEFAULT_WIDGET_MAX_WIDTH = '28rem';

  const resolveCb = (name: string, optsCb?: RenderOpts['onResult']) => {
    if (typeof optsCb === 'function') return optsCb;
    const fn = name ? win[name] : null;
    return typeof fn === 'function' ? (fn as (r: CaptchaResult) => void) : null;
  };

  function render(el: Element, opts: RenderOpts = {}): CaptchaHandle | null {
    const slot = el as Element & { __argusMounted?: boolean };
    if (!slot || slot.__argusMounted) return null;
    slot.__argusMounted = true;

    const cpi = opts.cpi || defaultCpi;
    const challengeId = opts.challengeId || defaultChallengeId;
    const origin = opts.embedOrigin || BAKED_ORIGIN;
    const onResult = resolveCb(defaultCbName, opts.onResult);

    const iframe = document.createElement('iframe');
    iframe.src =
      origin +
      '/embed?cpi=' +
      encodeURIComponent(cpi) +
      '&challengeId=' +
      encodeURIComponent(challengeId) +
      '&origin=' +
      encodeURIComponent(hostOrigin);
    iframe.title = 'Argus device pairing';
    iframe.setAttribute('referrerpolicy', 'origin');
    // color-scheme:normal keeps the iframe transparent — a light-host/dark-embed
    // scheme mismatch would otherwise force an opaque canvas behind the widget.
    // The 420px height is a pre-render fallback; the embed posts its real
    // height via `size` events and we follow it.
    iframe.style.cssText = `border:0;display:block;width:100%;max-width:${DEFAULT_WIDGET_MAX_WIDTH};height:420px;color-scheme:normal;background:transparent;`;
    slot.appendChild(iframe);

    // Report the host viewport down so the widget can adapt to small screens —
    // media queries inside the iframe only ever see the iframe's own width.
    const sendViewport = () => {
      iframe.contentWindow?.postMessage(
        { source: 'argus-captcha-host', event: 'viewport', width: window.innerWidth },
        origin
      );
    };
    iframe.addEventListener('load', sendViewport);
    window.addEventListener('resize', sendViewport);

    const onMsg = (e: MessageEvent) => {
      const message = parseCaptchaMessage(e, origin, iframe.contentWindow);
      if (!message) return;
      if (message.sizeHeight !== null) {
        // Follow the widget's reported height (clamped — a compromised embed
        // shouldn't be able to blow the iframe up over the host page).
        iframe.style.height = Math.min(640, Math.max(260, Math.ceil(message.sizeHeight))) + 'px';
        return;
      }
      if (typeof opts.onEvent === 'function') opts.onEvent(message.payload);
      if (message.result && onResult) onResult(message.result);
    };
    window.addEventListener('message', onMsg);

    return {
      destroy() {
        window.removeEventListener('message', onMsg);
        window.removeEventListener('resize', sendViewport);
        iframe.remove();
        slot.__argusMounted = false;
      },
    };
  }

  function startMobileSso(opts: MobileSsoOpts): void {
    const cpi = opts.cpi || defaultCpi;
    const challengeId = opts.challengeId || defaultChallengeId;
    if (!cpi || !challengeId || !opts.returnUrl) {
      throw new Error('cpi, challengeId, and returnUrl are required');
    }
    const launch = new URL('/sso/mobile', BAKED_ORIGIN);
    launch.search = new URLSearchParams({
      cpi,
      challengeId,
      returnUrl: opts.returnUrl,
    }).toString();
    window.location.assign(launch.toString());
  }

  const auto = () => {
    document.querySelectorAll('.argus-captcha').forEach((el) => render(el, {}));
  };

  win.argusCaptcha = { render, startMobileSso, _auto: auto, embedOrigin: BAKED_ORIGIN };
  if (document.readyState !== 'loading') auto();
  else document.addEventListener('DOMContentLoaded', auto);
})();
