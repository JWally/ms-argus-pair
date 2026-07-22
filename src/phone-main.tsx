import './index.css';
import type { PairEvents, PhoneSessionInfo, SubmitPhoneAttestationOptions } from './lib/pair';
import { mountPhoneDrawingBoard, type PhoneDrawingBoard } from './lib/phone-drawing-board';
import { decidePhonePairFailure, type PhoneProofMode } from './lib/phone-pair-failure';
import { isPairSessionTimeout } from './lib/pair-timeout';
import { createPhonePerfReporter, type PhonePerfBatch } from './lib/phone-perf';
import { renderPhonePanelView, renderPhoneReadyView, type PhonePhase } from './lib/phone-view';

// Tiny DOM phone entry. It paints the cheap phone challenge from the QR hash first,
// then imports the heavier pair/auth modules while the user is occupied.
type ProofChoice = PhoneProofMode;
type PhonePair = (typeof import('./lib/phone-pair'))['phonePair'];
type OAuthModule = typeof import('./lib/oauth');

interface Runtime {
  pairMod?: PhonePair;
  oauthMod?: OAuthModule;
  info: PhoneSessionInfo | null;
  phase: PhonePhase;
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

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');
const root = rootElement;
let firstRenderReported = false;
let bioDrawStarted = false;
let challengeCompleteSignaled = false;
let drawingBoard: PhoneDrawingBoard | undefined;

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
  drawingBoard?.stop();
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
      import('./lib/phone-pair').then(({ phonePair }) => phonePair),
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
  void pair('passkey', { keepDrawingBoard: true, trustOnly: true });
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
    void pair('integrity', { keepDrawingBoard: true });
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
  opts: { keepDrawingBoard?: boolean; trustOnly?: boolean } = {}
): Promise<void> {
  if (!sessionId || !state.info || !state.pairMod || state.inflight) return;
  const keepDrawingBoard = opts.keepDrawingBoard === true;
  recordPhonePerf('pair_start', { proofMode, trustOnly: opts.trustOnly === true });
  state.inflight = true;
  startPairUi(keepDrawingBoard);
  try {
    const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth';
    const options: SubmitPhoneAttestationOptions = {
      mode:
        proofMode === 'integrity' ? 'integrity' : proofMode === 'google' ? 'oauth' : passkeyMode,
    };
    if (proofMode === 'google') {
      const oauthMod = await loadOAuthModule();
      const oauthResult = await oauthMod.runGoogleProofOfLife(state.info.nonce);
      if (oauthMod.isOAuthError(oauthResult)) {
        setState({ phase: 'ready', errorMsg: oauthResult.error });
        return;
      }
      options.oauthResult = oauthResult;
    }

    const result = await state.pairMod.submitPhoneAttestation(
      sessionId,
      state.info,
      createPairEvents(keepDrawingBoard),
      {
        ...options,
        trustOnly: opts.trustOnly,
      }
    );
    applyPairResult(result, {
      proofMode,
      passkeyMode,
      keepDrawingBoard,
      trustOnly: opts.trustOnly === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = decidePhonePairFailure(error, {
      proofMode,
      keepDrawingBoard,
    });
    recordPhonePerf('pair_error', {
      trustOnly: opts.trustOnly === true,
      error: message.slice(0, 80),
    });
    if (failure.resetTrust) state.hasTrust = false;
    setState({
      phase: failure.phase,
      ...(failure.clearStatus ? { status: '' } : {}),
      errorMsg: failure.errorMessage,
    });
  } finally {
    state.inflight = false;
  }
}

function startPairUi(keepDrawingBoard: boolean): void {
  if (keepDrawingBoard) {
    state.status = 'starting';
    state.errorMsg = null;
    updateBioDrawActionLabel();
    return;
  }
  setState({
    phase: state.hasTrust && !state.info?.freshProofRequired ? 'returning' : 'pairing',
    status: 'starting',
    errorMsg: null,
  });
}

function createPairEvents(keepDrawingBoard: boolean): PairEvents {
  return {
    onStatus: (status) => {
      if (keepDrawingBoard) {
        state.status = status;
        updateBioDrawActionLabel();
        return;
      }
      setState({ status });
    },
  };
}

type PhoneAttestationResult = Awaited<ReturnType<PhonePair['submitPhoneAttestation']>>;

function applyPairResult(
  result: PhoneAttestationResult,
  options: {
    proofMode: ProofChoice;
    passkeyMode: 'passkey-create' | 'passkey-auth';
    keepDrawingBoard: boolean;
    trustOnly: boolean;
  }
): void {
  recordPhonePerf('attest_done', {
    verdict: result.verdict,
    trustOnly: options.trustOnly,
  });
  flushPhonePerf('attest_done');
  state.finalizeAfterDone = result.finalizeAfterDone;
  if (
    options.proofMode !== 'integrity' &&
    options.passkeyMode === 'passkey-auth' &&
    result.annotations?.phone_webauthn_error === 'credential_not_registered'
  ) {
    state.pairMod?.clearPasskeyHint();
  }
  if (options.keepDrawingBoard) {
    // Background verdict calculation must not interrupt the drawing challenge or
    // disclose its result on the phone. Store it only to unlock DONE; the
    // desktop receives and enforces the unmodified server verdict.
    state.verdict = result.verdict;
    state.status = 'done';
    state.phase = 'challenge';
    updateBioDrawActionLabel();
    return;
  }
  setState({
    verdict: result.verdict,
    status: 'done',
    phase: 'paired',
  });
  window.setTimeout(() => void finalizePhoneStateAndClose(), 1500);
}

async function loadOAuthModule(): Promise<OAuthModule> {
  state.oauthMod ??= await import('./lib/oauth');
  return state.oauthMod;
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
  drawingBoard?.stop();
  drawingBoard = undefined;
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
  drawingBoard?.stop();
  drawingBoard = mountPhoneDrawingBoard({
    root,
    nonce,
    challengeIndex: state.challengeIndex,
    started: bioDrawStarted,
    done: Boolean(state.verdict),
    onStarted: () => {
      bioDrawStarted = true;
    },
    onAdvance: advanceChallenge,
  });
}

function updateBioDrawActionLabel(): void {
  drawingBoard?.setDone(Boolean(state.verdict));
}

async function renderReady(): Promise<void> {
  const googleConfigured = await isGoogleConfigured();
  root.innerHTML = renderPhoneReadyView({
    canUseTrust: state.hasTrust && !state.info?.freshProofRequired,
    googleConfigured,
    debug: isDebugMode(),
    errorMessage: state.errorMsg,
  });
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
  root.innerHTML = renderPhonePanelView({
    phase: state.phase,
    status: state.status,
    verdict: state.verdict,
    errorMessage: state.errorMsg,
    debug: isDebugMode(),
  });
}
