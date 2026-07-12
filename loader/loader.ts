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
 * runs in the Argus origin, isolated from the host page. The loader only relays
 * the result message up to the host's callback. The host MUST verify the
 * returned token server-to-server (POST /api/verify) — the browser message is a
 * notification, not proof.
 */

// Replaced at build time by esbuild `define`.
declare const __EMBED_ORIGIN__: string;

type CaptchaResult = {
  sessionId: string;
  verdict: string;
  reason: string | null;
  token: string | null;
};

interface RenderOpts {
  cpi?: string;
  challengeId?: string;
  embedOrigin?: string;
  ssoReturnUrl?: string;
  onResult?: (r: CaptchaResult) => void;
  onEvent?: (e: Record<string, unknown>) => void;
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
  const defaultSsoReturnUrl = me.getAttribute('data-sso-return-url') || '';
  const defaultCbName = me.getAttribute('data-onresult') || '';
  const hostOrigin = window.location.origin;
  const win = window as unknown as Record<string, unknown>;

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
    const ssoReturnUrl = opts.ssoReturnUrl || defaultSsoReturnUrl;
    const onResult = resolveCb(defaultCbName, opts.onResult);

    const iframe = document.createElement('iframe');
    iframe.src =
      origin +
      '/embed?cpi=' +
      encodeURIComponent(cpi) +
      '&challengeId=' +
      encodeURIComponent(challengeId) +
      '&origin=' +
      encodeURIComponent(hostOrigin) +
      '&ssoReturnUrl=' +
      encodeURIComponent(ssoReturnUrl);
    iframe.title = 'Argus device pairing';
    iframe.setAttribute('referrerpolicy', 'origin');
    // color-scheme:normal keeps the iframe transparent — a light-host/dark-embed
    // scheme mismatch would otherwise force an opaque canvas behind the widget.
    // The 420px height is a pre-render fallback; the embed posts its real
    // height via `size` events and we follow it.
    iframe.style.cssText =
      'border:0;display:block;width:100%;max-width:320px;height:420px;color-scheme:normal;background:transparent;';
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
      if (e.origin !== origin) return; // only trust the embed origin
      if (e.source !== iframe.contentWindow) return;
      const d = e.data as (Record<string, unknown> & { source?: string; event?: string }) | null;
      if (!d || d.source !== 'argus-captcha') return;
      if (d.event === 'size' && typeof d.height === 'number') {
        // Follow the widget's reported height (clamped — a compromised embed
        // shouldn't be able to blow the iframe up over the host page).
        iframe.style.height = Math.min(640, Math.max(260, Math.ceil(d.height))) + 'px';
        return;
      }
      if (typeof opts.onEvent === 'function') opts.onEvent(d);
      if (d.event === 'result' && onResult) {
        onResult({
          sessionId: String(d.sessionId ?? ''),
          verdict: String(d.verdict ?? ''),
          reason: (d.reason as string | null) ?? null,
          token: (d.token as string | null) ?? null,
        });
      }
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

  const auto = () => {
    document.querySelectorAll('.argus-captcha').forEach((el) => render(el, {}));
  };

  win.argusCaptcha = { render, _auto: auto, embedOrigin: BAKED_ORIGIN };
  if (document.readyState !== 'loading') auto();
  else document.addEventListener('DOMContentLoaded', auto);
})();
