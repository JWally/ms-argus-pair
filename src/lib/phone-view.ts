export type PhonePhase =
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

interface PhoneReadyViewOptions {
  canUseTrust: boolean;
  googleConfigured: boolean;
  debug: boolean;
  errorMessage: string | null;
}

interface PhonePanelViewOptions {
  phase: PhonePhase;
  status: string;
  verdict: string | null;
  errorMessage: string | null;
  debug: boolean;
}

export function renderPhoneReadyView({
  canUseTrust,
  googleConfigured,
  debug,
  errorMessage,
}: PhoneReadyViewOptions): string {
  return `
    <div class="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      ${phoneHeader(debug)}
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
        ${errorMessage ? `<div class="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-xs text-red-100">${escapeHtml(errorMessage)}</div>` : ''}
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
}

export function renderPhonePanelView(options: PhonePanelViewOptions): string {
  const busy =
    options.phase === 'awaiting-desktop' ||
    options.phase === 'pairing' ||
    options.phase === 'returning';
  const icon =
    options.phase === 'paired'
      ? '✓'
      : options.phase === 'failed' || options.phase === 'error'
        ? '×'
        : '◆';
  return `
    <div class="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      ${phoneHeader(options.debug)}
      <div class="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <div class="relative">
          ${busy ? '<div class="absolute inset-0 animate-ping rounded-full bg-accent/30"></div>' : ''}
          <div class="relative flex h-20 w-20 items-center justify-center rounded-full ${panelToneClass(options.phase)} text-3xl">${icon}</div>
        </div>
        <div class="space-y-2">
          <div class="text-xl font-semibold">${panelTitle(options.phase)}</div>
          <p class="break-all text-sm text-muted">${escapeHtml(panelBody(options))}</p>
        </div>
        ${busy ? `<div class="mt-1 flex items-center justify-center gap-2 text-xs text-muted"><span class="spinner"></span><span class="pulse-fade">${escapeHtml(options.status || 'working')}</span></div>` : ''}
      </div>
    </div>`;
}

function phoneHeader(debug: boolean): string {
  return `<header class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-base font-semibold tracking-tight text-white/90">argus<span style="color:#b388ff">.pair</span></div>
        <span class="pill">${debug ? 'debug' : 'phone'}</span>
      </header>`;
}

function panelTitle(phase: PhonePhase): string {
  if (phase === 'awaiting-desktop') return 'Waiting for the desktop';
  if (phase === 'returning') return 'Welcome back';
  if (phase === 'pairing') return 'Verifying';
  if (phase === 'paired') return 'Verified';
  if (phase === 'failed') return 'Not verified';
  if (phase === 'taken') return 'This code is already paired';
  if (phase === 'timeout') return 'QR code timed out';
  return 'Something went wrong';
}

function panelBody({ phase, status, verdict, errorMessage }: PhonePanelViewOptions): string {
  if (phase === 'awaiting-desktop') return 'about a second';
  if (phase === 'returning') return status || 'remembered this device';
  if (phase === 'pairing') return status || 'working';
  if (phase === 'paired') return 'You can close this tab. The desktop has the result.';
  if (phase === 'failed') return verdict ?? 'failed';
  if (phase === 'taken')
    return 'Another device beat you to it. Ask the desktop for a fresh QR code.';
  if (phase === 'timeout')
    return 'The desktop has not finished or the code expired. Ask the desktop for a fresh QR code.';
  return errorMessage ?? 'Unknown error';
}

function panelToneClass(phase: PhonePhase): string {
  if (phase === 'paired') return 'bg-green-500/15 text-green-300';
  if (phase === 'failed' || phase === 'error') return 'bg-red-500/15 text-red-300';
  return 'bg-accent/15 text-accent';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    return '&quot;';
  });
}
