import './index.css';
import type { PairEvents, PhoneSessionInfo, SubmitPhoneAttestationOptions } from './lib/pair';
import { startBioDotPlate } from './lib/bio-dot-plate';
import { isPairSessionTimeout } from './lib/pair-timeout';
import { createPhonePerfReporter, type PhonePerfBatch } from './lib/phone-perf';

// Tiny DOM phone entry. It paints the cheap phone challenge from the QR hash first,
// then imports the heavier pair/auth modules while the user is occupied.
type ProofChoice = 'integrity' | 'passkey' | 'passkey-create' | 'google';
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
  trustChecked: boolean;
  nonce: string | null;
  challengeIndex: number;
  desktopReady: boolean;
  inflight: boolean;
  fastPassAttempted: boolean;
  startedInChallenge: boolean;
  finalizeAfterDone?: () => Promise<'paired' | 'failed' | null>;
  ctl: AbortController;
}

const DRAW_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');
const root = rootElement;
let firstRenderReported = false;
let bioDrawStarted = false;
let challengeCompleteSignaled = false;
let stopBioDotPlate: (() => void) | undefined;

const sessionId = sessionIdFromPath();
const phonePerf = createPhonePerfReporter({
  currentSessionId: sessionId,
  send: postPhonePerfBatch,
  storage: getPhonePerfStorage(),
});
const initialNonce = nonceFromPairHash();
const state: Runtime = {
  info: null,
  phase: initialNonce ? 'challenge' : 'awaiting-desktop',
  status: '',
  verdict: null,
  errorMsg: sessionId ? null : 'Missing session id',
  hasTrust: false,
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
  recordPhonePerf('token_redeem_start', { entry: 'pair_token' });
  void redeemPairTokenAndGo(pairToken);
} else {
  if (!sessionId) state.phase = 'error';
  render();
  window.requestAnimationFrame(() => {
    void bootstrap();
  });
}

window.addEventListener('pagehide', () => {
  flushPhonePerf('pagehide');
  // Best-effort: a phone closed mid-challenge shouldn't leave the desktop
  // holding a finished verdict until the hold cap expires.
  signalChallengeComplete();
  state.ctl.abort();
  state.info?.conn.close();
});

// One-shot: releases the desktop's verdict-reveal gate. Fired when the user
// taps DONE, whenever the challenge screen is dismissed for any other phase
// (proof menu, returning, error), or on pagehide as a last resort.
function signalChallengeComplete(): void {
  if (challengeCompleteSignaled || !state.startedInChallenge) return;
  if (!state.info || !state.pairMod) return;
  challengeCompleteSignaled = true;
  state.pairMod.signalChallengeDone(state.info);
}

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
      proofRequired: boolean;
      freshProofRequired: boolean;
    };
    recordPhonePerf('token_redeem_done', { entry: 'pair_token', sessionId: b.sessionId });
    phonePerf.handoff(b.sessionId);
    const hash = new URLSearchParams({
      wsUrl: b.wsUrl,
      e: b.e,
      pt: b.pt,
      n: b.n,
      pr: b.proofRequired ? '1' : '0',
      fr: b.freshProofRequired ? '1' : '0',
    }).toString();
    window.location.replace(
      `/pair/${encodeURIComponent(b.sessionId)}${window.location.search}#${hash}`
    );
  } catch {
    recordPhonePerf('token_redeem_error', { entry: 'pair_token' });
    flushPhonePerf('token_redeem_error');
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

/**
 * Bootstrap work finishes while the user may already be drawing. Updating
 * trust/desktop readiness must not replace the active canvas: doing so erases
 * the in-progress stroke and looks like a page reload. Visual phase changes
 * still use setState(); this helper is only for background readiness fields.
 */
function setBackgroundState(patch: Partial<Runtime>): void {
  const preserveActiveChallenge =
    state.phase === 'challenge' && root.querySelector('.bio-draw') !== null;
  Object.assign(state, patch);
  if (!preserveActiveChallenge) render();
}

async function bootstrap(): Promise<void> {
  if (!sessionId) return;
  recordPhonePerf('bootstrap_start');
  try {
    const [pairMod, trustMod] = await Promise.all([
      import('./lib/pair'),
      import('./lib/device-trust'),
    ]);
    if (state.ctl.signal.aborted) return;
    state.pairMod = pairMod;
    recordPhonePerf('pair_import_done');

    let trustSettled = false;
    const trustFallback = window.setTimeout(() => {
      if (trustSettled || state.ctl.signal.aborted) return;
      recordPhonePerf('trust_check_timeout');
      setBackgroundState({ trustChecked: true });
      maybeStartFastPass();
    }, 1500);
    void trustMod.loadTrustToken().then((trustToken) => {
      trustSettled = true;
      window.clearTimeout(trustFallback);
      if (state.ctl.signal.aborted) return;
      setBackgroundState({
        hasTrust: Boolean(trustToken),
        trustChecked: true,
      });
      recordPhonePerf('trust_check_done', { hasTrust: Boolean(trustToken) });
      maybeStartFastPass();
    });

    const info = await pairMod.awaitDesktopReady(sessionId, state.ctl.signal, {
      challenge: state.startedInChallenge,
      onScanStart: () => recordPhonePerf('scan_start', { hasTrust: state.hasTrust }),
      onScanDone: (result) =>
        recordPhonePerf('scan_done', {
          hasTrust: state.hasTrust,
          attested: Boolean(result.attestation),
          durationMs: Math.round(result.durationMs),
        }),
      onScanError: (error: unknown) =>
        recordPhonePerf('scan_error', {
          hasTrust: state.hasTrust,
          error: error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80),
        }),
    });
    if (state.ctl.signal.aborted) return;
    state.info = info;
    state.nonce = info.nonce;
    state.desktopReady = true;
    recordPhonePerf('desktop_ready', {
      hasTrust: state.hasTrust,
      startedInChallenge: state.startedInChallenge,
    });
    if (!state.startedInChallenge) {
      state.phase = 'ready';
      render();
    }
    maybeStartFastPass();
  } catch (e) {
    if (state.ctl.signal.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    recordPhonePerf('bootstrap_error', { error: msg.slice(0, 80) });
    flushPhonePerf('bootstrap_error');
    if (isPairSessionTimeout(e)) {
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
    !state.info.proofRequired ||
    state.info.freshProofRequired ||
    !state.pairMod ||
    state.verdict
  ) {
    return;
  }
  state.fastPassAttempted = true;
  recordPhonePerf('fast_pass_attempt');
  void pair('passkey', { keepDialpad: true, trustOnly: true });
}

function advanceChallenge(): void {
  if (state.verdict) {
    // The DONE tap ends the phone interaction without exposing the decision.
    // The desktop still receives and enforces the server's actual verdict.
    signalChallengeComplete();
    // iOS may refuse window.close() for a tab opened by its QR scanner.
    // Render the normal terminal state first so a refused close cannot leave
    // the user staring at what looks like a stuck challenge.
    setState({ phase: 'paired', status: 'done' });
    void finalizePhoneStateAndClose();
    return;
  }
  if (state.inflight) {
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
  if (!state.info.proofRequired) {
    // Keep the challenge moving while the already-running scan is submitted.
    // The button becomes DONE only after the paired verdict arrives.
    setState({ challengeIndex: state.challengeIndex + 1 });
    void pair('integrity', { keepDialpad: true });
    return;
  }
  if (state.info.freshProofRequired) {
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

async function finalizePhoneStateAndClose(): Promise<void> {
  if (state.finalizeAfterDone) {
    try {
      await Promise.race([
        state.finalizeAfterDone(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1_000)),
      ]);
    } catch {
      /* best-effort release */
    }
  }
  try {
    window.close();
  } catch {
    /* noop */
  }
}

async function pair(
  proofMode: ProofChoice = 'passkey',
  opts: { keepDialpad?: boolean; trustOnly?: boolean } = {}
): Promise<void> {
  if (!sessionId || !state.info || !state.pairMod || state.inflight) return;
  recordPhonePerf('pair_start', { proofMode, trustOnly: opts.trustOnly === true });
  state.inflight = true;
  if (opts.keepDialpad) {
    state.status = 'starting';
    state.errorMsg = null;
    updateBioDrawActionLabel();
  } else {
    setState({
      phase: state.hasTrust && !state.info.freshProofRequired ? 'returning' : 'pairing',
      status: 'starting',
      errorMsg: null,
    });
  }
  try {
    const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth';
    const options: SubmitPhoneAttestationOptions = {
      mode:
        proofMode === 'integrity' ? 'integrity' : proofMode === 'google' ? 'oauth' : passkeyMode,
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
    recordPhonePerf('attest_done', {
      verdict: result.verdict,
      trustOnly: opts.trustOnly === true,
    });
    flushPhonePerf('attest_done');
    state.finalizeAfterDone = result.finalizeAfterDone;
    if (
      proofMode !== 'integrity' &&
      passkeyMode === 'passkey-auth' &&
      result.annotations?.phone_webauthn_error === 'credential_not_registered'
    ) {
      state.pairMod.clearPasskeyHint();
    }
    if (opts.keepDialpad) {
      // Background verdict calculation must not interrupt the drawing challenge or
      // disclose its result on the phone. Store it only to unlock DONE; the
      // desktop receives and enforces the unmodified server verdict.
      state.verdict = result.verdict;
      state.status = 'done';
      state.phase = 'challenge';
      updateBioDrawActionLabel();
    } else {
      setState({
        verdict: result.verdict,
        status: 'done',
        phase: 'paired',
      });
    }
    if (!opts.keepDialpad) {
      window.setTimeout(() => void finalizePhoneStateAndClose(), 1500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordPhonePerf('pair_error', {
      trustOnly: opts.trustOnly === true,
      error: msg.slice(0, 80),
    });
    if (opts.keepDialpad) {
      state.hasTrust = false;
      setState({
        phase: 'ready',
        status: '',
        errorMsg: 'Trusted device expired. Choose a check.',
      });
      return;
    }
    if (proofMode === 'passkey' || proofMode === 'passkey-create') {
      setState({ phase: 'ready', errorMsg: msg });
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
  // Leaving the challenge for any other screen (proof menu, returning,
  // paired, error) also counts as "user is done drawing".
  signalChallengeComplete();
  stopBioDotPlate?.();
  stopBioDotPlate = undefined;
  if (state.phase === 'ready') {
    void renderReady();
    return;
  }
  renderPanel();
}

function reportFirstRender(): void {
  if (firstRenderReported) return;
  firstRenderReported = true;
  queueMicrotask(() => recordPhonePerf('first_render', { initialPhase: state.phase }));
}

function phonePerfFields(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId,
    pathKind: pairToken ? 'pair_token' : sessionId ? 'pair' : 'unknown',
    phase: state.phase,
    hasTrust: state.hasTrust,
    trustChecked: state.trustChecked,
    desktopReady: state.desktopReady,
    ...extra,
  };
}

function recordPhonePerf(event: string, extra: Record<string, unknown> = {}): void {
  phonePerf.record(event, phonePerfFields(extra));
}

function flushPhonePerf(reason: string): void {
  phonePerf.flush(reason, phonePerfFields());
}

function postPhonePerfBatch(batch: PhonePerfBatch): void {
  try {
    const payload = JSON.stringify(batch);
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

function getPhonePerfStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function renderBioDraw(): void {
  const nonce = state.nonce;
  if (!nonce) return;
  const targetLetter = drawLetterFromNonce(nonce, state.challengeIndex);
  const challengeSeed = hashChallenge(nonce, state.challengeIndex);
  let hasDrawn = false;
  stopBioDotPlate?.();
  stopBioDotPlate = undefined;
  root.innerHTML = `
    <div class="bio-draw app">
      <header>
        <h1>ARGUS <span class="accent">PAIR</span></h1>
        <p class="subtitle">Handwriting Biometric Captcha</p>
      </header>
      <main>
        <div class="challenge-digits">
          <div class="bio-draw-challenge" aria-label="Draw ${targetLetter}">
            <span>DRAW</span>
            <canvas class="bio-draw-dot-canvas" aria-label="${targetLetter}"></canvas>
          </div>
        </div>
        <div class="canvas-area canvas-idle">
          <canvas class="drawing-canvas bio-draw-canvas" aria-label="Draw the requested letter"></canvas>
          <div class="canvas-overlay bio-draw-overlay${
            bioDrawStarted ? ' bio-draw-overlay-hidden' : ''
          }">
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

  const plate = root.querySelector<HTMLCanvasElement>('.bio-draw-dot-canvas');
  const canvas = root.querySelector<HTMLCanvasElement>('.bio-draw-canvas');
  const overlay = root.querySelector<HTMLElement>('.bio-draw-overlay');
  const canvasArea = root.querySelector<HTMLElement>('.canvas-area');
  const erase = root.querySelector<HTMLElement>('.bio-draw-erase');
  const send = root.querySelector<HTMLElement>('.bio-draw-send');
  const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  let drawing = false;
  if (plate) {
    stopBioDotPlate = startBioDotPlate(plate, targetLetter, challengeSeed);
  }

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
    overlay?.classList.toggle('bio-draw-overlay-hidden', bioDrawStarted);
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
    bioDrawStarted = true;
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
  send.textContent = state.verdict ? 'DONE' : 'Next';
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
  const canUseTrust = state.hasTrust && !state.info?.freshProofRequired;
  root.innerHTML = `
    <div class="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-base font-semibold tracking-tight text-white/90">argus<span style="color:#b388ff">.pair</span></div>
        <span class="pill">${isDebugMode() ? 'debug' : 'phone'}</span>
      </header>
      <div class="flex flex-1 flex-col items-center justify-center gap-8 text-center">
        <div class="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent/15 text-accent">◆</div>
        <div class="space-y-2">
          <h1 class="text-2xl font-semibold tracking-tight">${canUseTrust ? 'Welcome back' : 'Choose a check'}</h1>
          <p class="text-sm leading-relaxed text-muted">${
            canUseTrust
              ? 'We remember this device. One tap to confirm.'
              : 'Use a passkey if you already have one, or pick another proof.'
          }</p>
        </div>
        ${state.errorMsg ? `<div class="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-xs text-red-100">${escapeHtml(state.errorMsg)}</div>` : ''}
        <div class="w-full space-y-3">
          ${
            canUseTrust
              ? '<button data-action="confirm" class="btn btn-primary w-full py-4 text-base">Confirm</button>'
              : `
              <button data-action="passkey" class="btn btn-primary w-full py-4 text-base">Use passkey</button>
              <button data-action="passkey-create" class="btn w-full py-4 text-base">Create passkey</button>
              ${googleConfigured ? '<button data-action="google" class="btn w-full py-4 text-base">Continue with Google</button>' : ''}`
          }
        </div>
        <div class="text-[11px] uppercase tracking-[0.18em] text-muted/70">${
          canUseTrust
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
    .querySelector('[data-action="passkey-create"]')
    ?.addEventListener('click', () => void pair('passkey-create'));
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
