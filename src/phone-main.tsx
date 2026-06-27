import './index.css';
import type { PairEvents, PhoneSessionInfo, SubmitPhoneAttestationOptions } from './lib/pair';

// Tiny DOM phone entry. It paints the cheap dialpad from the QR hash first,
// then imports the heavier pair/auth modules while the user is occupied.
type ProofChoice = 'passkey-auth' | 'passkey-create' | 'google';
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

interface Challenge {
  left: number;
  right: number;
  answer: string;
}

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
  startedInChallenge: boolean;
  ctl: AbortController;
}

const KEYS = [
  ['1', ' '],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ' '],
  ['0', '+'],
  ['#', ' '],
] as const;

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');
const root = rootElement;

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
  startedInChallenge: Boolean(initialNonce),
  ctl: new AbortController(),
};
if (!sessionId) state.phase = 'error';

render();
window.requestAnimationFrame(() => {
  void bootstrap();
});

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
  try {
    const [pairMod, trustMod] = await Promise.all([
      import('./lib/pair'),
      import('./lib/device-trust'),
    ]);
    if (state.ctl.signal.aborted) return;
    state.pairMod = pairMod;

    let trustSettled = false;
    const trustFallback = window.setTimeout(() => {
      if (trustSettled || state.ctl.signal.aborted) return;
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
    });

    const info = await pairMod.awaitDesktopReady(sessionId, state.ctl.signal);
    if (state.ctl.signal.aborted) return;
    state.info = info;
    state.nonce = info.nonce;
    state.desktopReady = true;
    if (!state.startedInChallenge) state.phase = 'ready';
    render();
  } catch (e) {
    if (state.ctl.signal.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("didn't finish scanning") || msg.includes('session expired')) {
      setState({ phase: 'timeout' });
    } else {
      setState({ phase: 'error', errorMsg: msg });
    }
  }
}

function advanceChallenge(): void {
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
  proofMode: ProofChoice = state.passkeyHint ? 'passkey-auth' : 'passkey-create'
): Promise<void> {
  if (!sessionId || !state.info || !state.pairMod || state.inflight) return;
  state.inflight = true;
  setState({ phase: state.hasTrust ? 'returning' : 'pairing', status: 'starting', errorMsg: null });
  try {
    const options: SubmitPhoneAttestationOptions = {
      mode: proofMode === 'google' ? 'oauth' : proofMode,
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

    const events: PairEvents = { onStatus: (status) => setState({ status }) };
    const result = await state.pairMod.submitPhoneAttestation(
      sessionId,
      state.info,
      events,
      options
    );
    if (
      proofMode === 'passkey-auth' &&
      result.annotations?.phone_webauthn_error === 'credential_not_registered'
    ) {
      state.pairMod.clearPasskeyHint();
      state.passkeyHint = false;
    }
    setState({ verdict: result.verdict, phase: result.verdict === 'paired' ? 'paired' : 'failed' });
    if (result.verdict === 'paired' || result.verdict === 'failed') {
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

function challengeFromNonce(nonce: string, challengeIndex: number): Challenge {
  const h = hashChallenge(nonce, challengeIndex);
  const left = 2 + (h % 8);
  const right = 2 + (Math.floor(h / 11) % 8);
  return { left, right, answer: String(left * right) };
}

function render(): void {
  if ((state.phase === 'challenge' || state.phase === 'awaiting-desktop') && state.nonce) {
    renderDialpad();
    return;
  }
  if (state.phase === 'ready') {
    void renderReady();
    return;
  }
  renderPanel();
}

function renderDialpad(): void {
  const nonce = state.nonce;
  if (!nonce) return;
  const challenge = challengeFromNonce(nonce, state.challengeIndex);
  let entered = '';
  let complete = false;
  const readyToContinue = state.desktopReady && state.trustChecked;
  root.innerHTML = `
    <div class="dialer">
      <div class="dialer-screen">
        <div class="dialer-prompt">Solve this</div>
        <div class="dialer-display-row">
          <span class="dialer-display-spacer" aria-hidden></span>
          <div class="dialer-display"><span class="dialer-equation"></span></div>
          <button type="button" class="dialer-backspace" aria-label="Backspace" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="dialer-backspace-icon" aria-hidden="true">
              <path d="M21 5H9.5a2 2 0 0 0-1.5.7L2 12l6 6.3a2 2 0 0 0 1.5.7H21a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"></path>
              <line x1="18" y1="9" x2="12" y2="15"></line>
              <line x1="12" y1="9" x2="18" y2="15"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="dialer-keypad">
        ${KEYS.map(
          ([digit, letters]) => `
          <button type="button" class="dialer-key" data-digit="${digit}" aria-label="Dial ${digit}">
            <span class="dialer-key-digit">${digit}</span>
            <span class="dialer-key-letters">${letters}</span>
          </button>`
        ).join('')}
      </div>
      <button type="button" disabled class="dialer-send">${readyToContinue ? 'SEND' : 'NEXT'}</button>
    </div>`;

  const display = root.querySelector('.dialer-display');
  const equation = root.querySelector('.dialer-equation');
  const backspace = root.querySelector('.dialer-backspace');
  const keypad = root.querySelector('.dialer-keypad');
  const send = root.querySelector('.dialer-send');
  const keyButtons = [...root.querySelectorAll('.dialer-key')];

  const update = () => {
    complete = entered === challenge.answer;
    if (equation) {
      equation.innerHTML = `${challenge.left} x ${challenge.right} = ${entered}${
        complete ? '' : '<span class="dialer-caret" aria-hidden="true"></span>'
      }`;
    }
    backspace?.classList.toggle('dialer-backspace-on', entered.length > 0 && !complete);
    setDisabled(backspace, entered.length === 0 || complete);
    keypad?.classList.toggle('dialer-keypad-muted', complete);
    if (send) {
      setDisabled(send, !complete);
      send.classList.toggle('dialer-send-armed', complete);
    }
    for (const button of keyButtons) {
      const digit = button.getAttribute('data-digit') ?? '';
      setDisabled(button, complete);
      button.classList.toggle(
        'dialer-key-target',
        !complete && digit === challenge.answer[entered.length]
      );
    }
  };
  const vibrate = (pattern: number | number[]) => {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* noop */
    }
  };
  const shake = () => {
    display?.classList.add('dialer-shake');
    window.setTimeout(() => display?.classList.remove('dialer-shake'), 180);
  };
  const press = (digit: string) => {
    if (complete) return;
    if (digit === 'backspace') {
      entered = entered.slice(0, -1);
      vibrate(4);
      update();
      return;
    }
    if (!/^[0-9]$/.test(digit)) return;
    const expected = challenge.answer[entered.length];
    if (digit !== expected) {
      shake();
      vibrate(8);
      return;
    }
    entered += digit;
    vibrate(entered === challenge.answer ? [18, 40, 18] : 4);
    update();
  };

  backspace?.addEventListener('click', () => press('backspace'));
  for (const button of keyButtons) {
    button.addEventListener('click', () => press(button.getAttribute('data-digit') ?? ''));
  }
  send?.addEventListener('click', advanceChallenge);
  update();
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
              <button data-action="passkey-auth" class="btn btn-primary w-full py-4 text-base">${state.passkeyHint ? 'Use passkey' : 'Use existing passkey'}</button>
              ${googleConfigured ? '<button data-action="google" class="btn w-full py-4 text-base">Continue with Google</button>' : ''}
              <button data-action="passkey-create" class="btn w-full py-4 text-base">Create a new passkey</button>`
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
    .querySelector('[data-action="passkey-auth"]')
    ?.addEventListener('click', () => void pair('passkey-auth'));
  root
    .querySelector('[data-action="google"]')
    ?.addEventListener('click', () => void pair('google'));
  root
    .querySelector('[data-action="passkey-create"]')
    ?.addEventListener('click', () => void pair('passkey-create'));
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
