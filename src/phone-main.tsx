import './index.css';
import type { PairEvents, PhoneSessionInfo, SubmitPhoneAttestationOptions } from './lib/pair';

// Tiny DOM phone entry. It paints the cheap phone challenge from the QR hash first,
// then imports the heavier pair/auth modules while the user is occupied.
type ProofChoice = 'passkey' | 'google';
type Phase =
  | 'awaiting-desktop'
  | 'ready'
  | 'challenge'
  | 'returning'
  | 'pairing'
  | 'paired'
  | 'failed'
  | 'taken'
  | 'timeout'
  | 'error';

type PairModule = typeof import('./lib/pair');
type OAuthModule = typeof import('./lib/oauth');

interface Runtime {
  pairMod?: PairModule;
  oauthMod?: OAuthModule;
  info: PhoneSessionInfo | null;
  phase: Phase;
  status: string;
  verdict: string | null;
  errorMsg: string | null;
  hasTrust: boolean;
  passkeyHint: boolean;
  trustChecked: boolean;
  nonce: string | null;
  challengeIndex: number;
  desktopReady: boolean;
  inflight: boolean;
  fastPassAttempted: boolean;
  startedInChallenge: boolean;
  ctl: AbortController;
}

const DRAW_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');
const root = rootElement;
const phonePerfStartedAt = window.performance.now();
let firstRenderReported = false;

const sessionId = sessionIdFromPath();
const initialNonce = nonceFromPairHash();
const state: Runtime = {
  info: null,
  phase: initialNonce ? 'challenge' : 'awaiting-desktop',
  status: '',
  verdict: null,
  errorMsg: sessionId ? null : 'Missing session id',
  hasTrust: false,
  passkeyHint: false,
  trustChecked: false,
  nonce: initialNonce,
  challengeIndex: 0,
  desktopReady: false,
  inflight: false,
  fastPassAttempted: false,
  startedInChallenge: Boolean(initialNonce),
  ctl: new AbortController(),
};
// /p/<token> is the sparse-QR entry: redeem the short token for the connection
// blob, then hand off to the normal /pair flow (below) untouched.
const pairToken = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)/)?.[1];
if (pairToken) {
  sendPhonePerf('token_redeem_start', { entry: 'pair_token' });
  void redeemPairTokenAndGo(pairToken);
} else {
  if (!sessionId) state.phase = 'error';
  render();
  window.requestAnimationFrame(() => {
    void bootstrap();
  });
}

window.addEventListener('pagehide', () => {
  state.ctl.abort();
  state.info?.conn.close();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/phone-sw.js', { scope: '/pair/' }).catch((e: unknown) => {
      console.warn('[argus-pair] phone service worker registration failed', e);
    });
  });
}

function sessionIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/pair\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Redeem the short pairing token (single-use) for {sessionId, wsUrl, e, pt, n},
 * then navigate to /pair/{sessionId}#<fragment> — the exact URL the existing
 * phone flow already knows how to consume. Same-origin `/api`.
 */
async function redeemPairTokenAndGo(token: string): Promise<void> {
  try {
    const res = await fetch('/api/pair-token/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error(`redeem ${res.status}`);
    const b = (await res.json()) as {
      sessionId: string;
      wsUrl: string;
      e: string;
      pt: string;
      n: string;
    };
    sendPhonePerf('token_redeem_done', { entry: 'pair_token', sessionId: b.sessionId });
    const hash = new URLSearchParams({ wsUrl: b.wsUrl, e: b.e, pt: b.pt, n: b.n }).toString();
    window.location.replace(
      `/pair/${encodeURIComponent(b.sessionId)}${window.location.search}#${hash}`
    );
  } catch {
    sendPhonePerf('token_redeem_error', { entry: 'pair_token' });
    state.phase = 'error';
    render();
  }
}

function nonceFromPairHash(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('n');
}

function isDebugMode(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === 'true';
}

function setState(patch: Partial<Runtime>): void {
  Object.assign(state, patch);
  render();
}

async function bootstrap(): Promise<void> {
  if (!sessionId) return;
  sendPhonePerf('bootstrap_start');
  try {
    const [pairMod, trustMod] = await Promise.all([
      import('./lib/pair'),
      import('./lib/device-trust'),
    ]);
    if (state.ctl.signal.aborted) return;
    state.pairMod = pairMod;
    sendPhonePerf('pair_import_done');

    let trustSettled = false;
    const trustFallback = window.setTimeout(() => {
      if (trustSettled || state.ctl.signal.aborted) return;
      sendPhonePerf('trust_check_timeout');
      setState({ trustChecked: true });
    }, 1500);
    void trustMod.loadTrustToken().then((trustToken) => {
      trustSettled = true;
      window.clearTimeout(trustFallback);
      if (state.ctl.signal.aborted) return;
      setState({
        hasTrust: Boolean(trustToken),
        passkeyHint: pairMod.hasPasskeyHint(),
        trustChecked: true,
      });
      sendPhonePerf('trust_check_done', { hasTrust: Boolean(trustToken) });
      maybeStartFastPass();
    });

    const info = await pairMod.awaitDesktopReady(sessionId, state.ctl.signal);
    if (state.ctl.signal.aborted) return;
    state.info = instrumentScan(info);
    state.nonce = info.nonce;
    state.desktopReady = true;
    sendPhonePerf('desktop_ready', {
      hasTrust: state.hasTrust,
      startedInChallenge: state.startedInChallenge,
    });
    if (state.hasTrust) {
      // Hide the scan latency behind the dialpad as soon as the trusted-device
      // path is possible. The eventual POST is still device-trust only.
      void state.info.getScanPromise();
    }
    if (!state.startedInChallenge) state.phase = 'ready';
    render();
    maybeStartFastPass();
  } catch (e) {
    if (state.ctl.signal.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    sendPhonePerf('bootstrap_error', { error: msg.slice(0, 80) });
    if (msg.includes("didn't finish scanning") || msg.includes('session expired')) {
      setState({ phase: 'timeout' });
    } else {
      setState({ phase: 'error', errorMsg: msg });
    }
  }
}

function maybeStartFastPass(): void {
  if (
    isDebugMode() ||
    state.fastPassAttempted ||
    state.inflight ||
    !state.hasTrust ||
    !state.trustChecked ||
    !state.desktopReady ||
    !state.info ||
    !state.pairMod ||
    state.verdict
  ) {
    return;
  }
  state.fastPassAttempted = true;
  sendPhonePerf('fast_pass_attempt');
  void pair('passkey', { keepDialpad: true, trustOnly: true });
}

function advanceChallenge(): void {
  if (state.verdict === 'paired') {
    try {
      window.close();
    } catch {
      /* noop */
    }
    return;
  }
  if (state.inflight && state.hasTrust) {
    setState({ challengeIndex: state.challengeIndex + 1 });
    return;
  }
  if (!state.desktopReady || !state.trustChecked || !state.info) {
    setState({ challengeIndex: state.challengeIndex + 1 });
    return;
  }
  if (isDebugMode()) {
    setState({ phase: 'ready' });
    return;
  }
  if (state.hasTrust) {
    setState({ phase: 'returning' });
    void pair();
    return;
  }
  setState({ phase: 'ready' });
}

async function pair(
  proofMode: ProofChoice = 'passkey',
  opts: { keepDialpad?: boolean; trustOnly?: boolean } = {}
): Promise<void> {
  if (!sessionId || !state.info || !state.pairMod || state.inflight) return;
  sendPhonePerf('pair_start', { proofMode, trustOnly: opts.trustOnly === true });
  state.inflight = true;
  if (opts.keepDialpad) {
    state.status = 'starting';
    state.errorMsg = null;
    updateBioDrawActionLabel();
  } else {
    setState({
      phase: state.hasTrust ? 'returning' : 'pairing',
      status: 'starting',
      errorMsg: null,
    });
  }
  try {
    const passkeyMode = state.passkeyHint ? 'passkey-auth' : 'passkey-create';
    const options: SubmitPhoneAttestationOptions = {
      mode: proofMode === 'google' ? 'oauth' : passkeyMode,
    };
    if (proofMode === 'google') {
      const oauthMod = await loadOAuthModule();
      const oauthResult = await oauthMod.runOAuthProofOfLife('google', state.info.nonce);
      if (oauthMod.isOAuthError(oauthResult)) {
        setState({ phase: 'ready', errorMsg: oauthResult.error });
        return;
      }
      options.oauthResult = oauthResult;
    }

    const events: PairEvents = {
      onStatus: (status) => {
        if (opts.keepDialpad) {
          state.status = status;
          updateBioDrawActionLabel();
          return;
        }
        setState({ status });
      },
    };
    const result = await state.pairMod.submitPhoneAttestation(sessionId, state.info, events, {
      ...options,
      trustOnly: opts.trustOnly,
    });
    sendPhonePerf('attest_done', { verdict: result.verdict, trustOnly: opts.trustOnly === true });
    if (
      passkeyMode === 'passkey-auth' &&
      result.annotations?.phone_webauthn_error === 'credential_not_registered'
    ) {
      state.pairMod.clearPasskeyHint();
      state.passkeyHint = false;
    }
    if (opts.keepDialpad && result.verdict === 'paired') {
      state.verdict = result.verdict;
      state.status = 'done';
      state.phase = 'challenge';
      updateBioDrawActionLabel();
    } else {
      setState({
        verdict: result.verdict,
        status: result.verdict === 'paired' ? 'done' : state.status,
        phase: result.verdict === 'paired' ? 'paired' : 'failed',
      });
    }
    if (!opts.keepDialpad && (result.verdict === 'paired' || result.verdict === 'failed')) {
      window.setTimeout(
        () => {
          try {
            window.close();
          } catch {
            /* noop */
          }
        },
        result.verdict === 'paired' ? 1500 : 3500
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendPhonePerf('pair_error', { trustOnly: opts.trustOnly === true, error: msg.slice(0, 80) });
    if (opts.keepDialpad) {
      state.hasTrust = false;
      setState({
        phase: 'ready',
        status: '',
        errorMsg: 'Trusted device expired. Choose a check.',
      });
      return;
    }
    setState({
      phase: msg.includes('session_paired_with_other_device') ? 'taken' : 'error',
      errorMsg: msg,
    });
  } finally {
    state.inflight = false;
  }
}

async function loadOAuthModule(): Promise<OAuthModule> {
  state.oauthMod ??= await import('./lib/oauth');
  return state.oauthMod;
}

function hashChallenge(nonce: string, challengeIndex: number): number {
  let h = 2166136261;
  for (const ch of `${nonce}:${challengeIndex}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function render(): void {
  reportFirstRender();
  if ((state.phase === 'challenge' || state.phase === 'awaiting-desktop') && state.nonce) {
    renderBioDraw();
    return;
  }
  if (state.phase === 'ready') {
    void renderReady();
    return;
  }
  renderPanel();
}

function reportFirstRender(): void {
  if (firstRenderReported) return;
  firstRenderReported = true;
  queueMicrotask(() => sendPhonePerf('first_render', { initialPhase: state.phase }));
}

function instrumentScan(info: PhoneSessionInfo): PhoneSessionInfo {
  let scanStarted = false;
  let scanSettled = false;
  return {
    ...info,
    getScanPromise: () => {
      if (!scanStarted) {
        scanStarted = true;
        sendPhonePerf('scan_start', { hasTrust: state.hasTrust });
      }
      return info.getScanPromise().then(
        (result) => {
          if (!scanSettled) {
            scanSettled = true;
            sendPhonePerf('scan_done', {
              hasTrust: state.hasTrust,
              attested: Boolean(result.attestation),
              durationMs: Math.round(result.durationMs),
            });
          }
          return result;
        },
        (error: unknown) => {
          if (!scanSettled) {
            scanSettled = true;
            sendPhonePerf('scan_error', {
              hasTrust: state.hasTrust,
              error:
                error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80),
            });
          }
          throw error;
        }
      );
    },
  };
}

function sendPhonePerf(event: string, extra: Record<string, unknown> = {}): void {
  try {
    const payload = JSON.stringify({
      event,
      sessionId,
      elapsedMs: Math.round(window.performance.now() - phonePerfStartedAt),
      pathKind: pairToken ? 'pair_token' : sessionId ? 'pair' : 'unknown',
      phase: state.phase,
      hasTrust: state.hasTrust,
      trustChecked: state.trustChecked,
      desktopReady: state.desktopReady,
      ...extra,
    });
    if (navigator.sendBeacon?.('/api/phone-perf', payload)) return;
    void fetch('/api/phone-perf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* best-effort telemetry */
    });
  } catch {
    /* best-effort telemetry */
  }
}

function renderBioDraw(): void {
  const nonce = state.nonce;
  if (!nonce) return;
  const targetLetter = drawLetterFromNonce(nonce, state.challengeIndex);
  let hasDrawn = false;
  root.innerHTML = `
    <div class="bio-draw app">
      <header>
        <h1>ARGUS <span class="accent">PAIR</span></h1>
        <p class="subtitle">Handwriting Biometric Captcha</p>
      </header>
      <main>
        <div class="timer">00:30.000</div>
        <div class="challenge-digits">
          <div class="bio-draw-challenge" aria-label="Draw target">
            <span>DRAW</span>
            <strong>${targetLetter}</strong>
          </div>
        </div>
        <div class="canvas-area canvas-idle">
          <canvas class="drawing-canvas bio-draw-canvas" aria-label="Draw the requested letter"></canvas>
          <div class="canvas-overlay bio-draw-overlay">
            <p class="canvas-overlay-text">Draw the Character You See Above</p>
            <p class="canvas-overlay-start">-- CLICK HERE TO START --</p>
          </div>
        </div>
        <div class="action-stack">
          <button type="button" disabled class="btn btn-next btn-stack bio-draw-send">Next</button>
          <button type="button" disabled class="btn btn-erase btn-stack bio-draw-erase">Erase</button>
        </div>
      </main>
    </div>`;

  const canvas = root.querySelector<HTMLCanvasElement>('.bio-draw-canvas');
  const overlay = root.querySelector<HTMLElement>('.bio-draw-overlay');
  const canvasArea = root.querySelector<HTMLElement>('.canvas-area');
  const erase = root.querySelector<HTMLElement>('.bio-draw-erase');
  const send = root.querySelector<HTMLElement>('.bio-draw-send');
  const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  let drawing = false;

  const vibrate = (pattern: number | number[]) => {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* noop */
    }
  };

  const syncCanvas = () => {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const pointFromEvent = (event: PointerEvent) => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const update = () => {
    overlay?.classList.toggle('bio-draw-overlay-hidden', hasDrawn);
    canvasArea?.classList.toggle('canvas-idle', !hasDrawn);
    canvasArea?.classList.toggle('canvas-active', hasDrawn);
    setDisabled(erase, !hasDrawn);
    if (send) {
      setDisabled(send, !hasDrawn);
    }
  };

  const clear = () => {
    hasDrawn = false;
    syncCanvas();
    update();
  };

  syncCanvas();
  new ResizeObserver(syncCanvas).observe(canvas!);

  canvas?.addEventListener('pointerdown', (event) => {
    if (!ctx || !canvas) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (!point) return;
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    if (!hasDrawn) vibrate(5);
    hasDrawn = true;
    update();
  });
  canvas?.addEventListener('pointermove', (event) => {
    if (!drawing || !ctx) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (!point) return;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    if (!hasDrawn) vibrate(5);
    hasDrawn = true;
    update();
  });
  const stopTracing = (event: PointerEvent) => {
    drawing = false;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas?.addEventListener('pointerup', stopTracing);
  canvas?.addEventListener('pointercancel', stopTracing);
  erase?.addEventListener('click', clear);
  send?.addEventListener('click', advanceChallenge);
  update();
  updateBioDrawActionLabel();
}

function drawLetterFromNonce(nonce: string, challengeIndex: number): string {
  return DRAW_LETTERS[hashChallenge(nonce, challengeIndex) % DRAW_LETTERS.length];
}

function updateBioDrawActionLabel(): void {
  const send = root.querySelector<HTMLButtonElement>('.bio-draw-send');
  if (!send) return;
  send.textContent = state.verdict === 'paired' ? 'DONE' : 'Next';
}

function setDisabled(
  element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  } | null,
  disabled: boolean
): void {
  if (!element) return;
  if (disabled) {
    element.setAttribute('disabled', '');
  } else {
    element.removeAttribute('disabled');
  }
}

async function renderReady(): Promise<void> {
  const googleConfigured = await isGoogleConfigured();
  root.innerHTML = `
    <div class="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-base font-semibold tracking-tight text-white/90">argus<span style="color:#b388ff">.pair</span></div>
        <span class="pill">${isDebugMode() ? 'debug' : 'phone'}</span>
      </header>
      <div class="flex flex-1 flex-col items-center justify-center gap-8 text-center">
        <div class="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent/15 text-accent">◆</div>
        <div class="space-y-2">
          <h1 class="text-2xl font-semibold tracking-tight">${state.hasTrust ? 'Welcome back' : 'Choose a check'}</h1>
          <p class="text-sm leading-relaxed text-muted">${
            state.hasTrust
              ? 'We remember this device. One tap to confirm.'
              : 'Use a passkey if you already have one, or pick another proof.'
          }</p>
        </div>
        ${state.errorMsg ? `<div class="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-xs text-red-100">${escapeHtml(state.errorMsg)}</div>` : ''}
        <div class="w-full space-y-3">
          ${
            state.hasTrust
              ? '<button data-action="confirm" class="btn btn-primary w-full py-4 text-base">Confirm</button>'
              : `
              <button data-action="passkey" class="btn btn-primary w-full py-4 text-base">Use passkey</button>
              ${googleConfigured ? '<button data-action="google" class="btn w-full py-4 text-base">Continue with Google</button>' : ''}`
          }
        </div>
        <div class="text-[11px] uppercase tracking-[0.18em] text-muted/70">${
          state.hasTrust
            ? 'Trusted device · same network'
            : googleConfigured
              ? 'Passkey · Google · device check'
              : 'Passkey · device check'
        }</div>
      </div>
  </div>`;
  root.querySelector('[data-action="confirm"]')?.addEventListener('click', () => void pair());
  root
    .querySelector('[data-action="passkey"]')
    ?.addEventListener('click', () => void pair('passkey'));
  root
    .querySelector('[data-action="google"]')
    ?.addEventListener('click', () => void pair('google'));
}

async function isGoogleConfigured(): Promise<boolean> {
  try {
    const mod = await loadOAuthModule();
    return mod.PROVIDERS_CONFIGURED.google;
  } catch {
    return false;
  }
}

function renderPanel(): void {
  const isBusy =
    state.phase === 'awaiting-desktop' || state.phase === 'pairing' || state.phase === 'returning';
  const title = panelTitle();
  const body = panelBody();
  const icon =
    state.phase === 'paired'
      ? '✓'
      : state.phase === 'failed' || state.phase === 'error'
        ? '×'
        : '◆';
  root.innerHTML = `
    <div class="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-base font-semibold tracking-tight text-white/90">argus<span style="color:#b388ff">.pair</span></div>
        <span class="pill">${isDebugMode() ? 'debug' : 'phone'}</span>
      </header>
      <div class="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <div class="relative">
          ${isBusy ? '<div class="absolute inset-0 animate-ping rounded-full bg-accent/30"></div>' : ''}
          <div class="relative flex h-20 w-20 items-center justify-center rounded-full ${panelToneClass()} text-3xl">${icon}</div>
        </div>
        <div class="space-y-2">
          <div class="text-xl font-semibold">${title}</div>
          <p class="break-all text-sm text-muted">${escapeHtml(body)}</p>
        </div>
        ${isBusy ? `<div class="mt-1 flex items-center justify-center gap-2 text-xs text-muted"><span class="spinner"></span><span class="pulse-fade">${escapeHtml(state.status || 'working')}</span></div>` : ''}
      </div>
    </div>`;
}

function panelTitle(): string {
  if (state.phase === 'awaiting-desktop') return 'Waiting for the desktop';
  if (state.phase === 'returning') return 'Welcome back';
  if (state.phase === 'pairing') return 'Verifying';
  if (state.phase === 'paired') return 'Verified';
  if (state.phase === 'failed') return 'Not verified';
  if (state.phase === 'taken') return 'This code is already paired';
  if (state.phase === 'timeout') return 'QR code timed out';
  return 'Something went wrong';
}

function panelBody(): string {
  if (state.phase === 'awaiting-desktop') return 'about a second';
  if (state.phase === 'returning') return state.status || 'remembered this device';
  if (state.phase === 'pairing') return state.status || 'working';
  if (state.phase === 'paired') return 'You can close this tab. The desktop has the result.';
  if (state.phase === 'failed') return state.verdict ?? 'failed';
  if (state.phase === 'taken')
    return 'Another device beat you to it. Ask the desktop for a fresh QR code.';
  if (state.phase === 'timeout')
    return 'The desktop has not finished or the code expired. Ask the desktop for a fresh QR code.';
  return state.errorMsg ?? 'Unknown error';
}

function panelToneClass(): string {
  if (state.phase === 'paired') return 'bg-green-500/15 text-green-300';
  if (state.phase === 'failed' || state.phase === 'error') return 'bg-red-500/15 text-red-300';
  return 'bg-accent/15 text-accent';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return '&quot;';
  });
}
