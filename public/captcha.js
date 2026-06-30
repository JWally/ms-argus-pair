/*
 * Argus Captcha — embeddable QR device-pairing widget loader.
 *
 *   <script src="https://<host>/captcha.js" data-cpi="argus_cpi_live_..."
 *           data-onresult="myCallback"></script>
 *   <div class="argus-captcha"></div>
 *
 * The loader injects a CROSS-ORIGIN iframe pointing at this script's own origin
 * (/embed), so all sensitive work (session, ECDH, attestation, QR pixels) runs
 * in Argus's origin, isolated from the host page. The loader only relays the
 * result message up to the host's callback. The host MUST verify the returned
 * sessionId server-to-server — the browser message is a notification, not proof.
 */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me) return;
  var EMBED_ORIGIN = new URL(me.src).origin; // where the iframe app is served from
  var defaultCpi = me.getAttribute('data-cpi') || '';
  var defaultCb = me.getAttribute('data-onresult') || '';
  var hostOrigin = window.location.origin;

  function resolveCb(name, optsCb) {
    if (typeof optsCb === 'function') return optsCb;
    if (name && typeof window[name] === 'function') return window[name];
    return null;
  }

  function render(el, opts) {
    opts = opts || {};
    if (!el || el.__argusMounted) return null;
    el.__argusMounted = true;
    var cpi = opts.cpi || defaultCpi;
    var onResult = resolveCb(defaultCb, opts.onResult);

    var iframe = document.createElement('iframe');
    iframe.src =
      EMBED_ORIGIN +
      '/embed?cpi=' +
      encodeURIComponent(cpi) +
      '&origin=' +
      encodeURIComponent(hostOrigin);
    iframe.title = 'Argus device pairing';
    iframe.setAttribute('referrerpolicy', 'origin');
    iframe.style.cssText =
      'border:0;display:block;width:100%;max-width:340px;height:420px;color-scheme:light dark;';
    el.appendChild(iframe);

    function onMsg(e) {
      if (e.origin !== EMBED_ORIGIN) return; // only trust messages from the embed origin
      if (e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d || d.source !== 'argus-captcha') return;
      if (typeof opts.onEvent === 'function') opts.onEvent(d);
      if (d.event === 'result' && onResult) {
        onResult({ sessionId: d.sessionId, verdict: d.verdict, reason: d.reason });
      }
    }
    window.addEventListener('message', onMsg);

    return {
      destroy: function () {
        window.removeEventListener('message', onMsg);
        iframe.remove();
        el.__argusMounted = false;
      },
    };
  }

  function auto() {
    var els = document.querySelectorAll('.argus-captcha');
    for (var i = 0; i < els.length; i++) render(els[i], {});
  }

  window.argusCaptcha = { render: render, _auto: auto, embedOrigin: EMBED_ORIGIN };

  if (document.readyState !== 'loading') auto();
  else document.addEventListener('DOMContentLoaded', auto);
})();
