import type { ReactNode } from 'react';
import { Wordmark } from '../components/Brand';
import { IconShield } from '../components/Icons';

export type PairActivityPhase = 'awaiting-desktop' | 'pairing' | 'returning';

export function isActivityPhase(phase: string): phase is PairActivityPhase {
  return phase === 'awaiting-desktop' || phase === 'pairing' || phase === 'returning';
}

function activityTitle(phase: PairActivityPhase): string {
  if (phase === 'awaiting-desktop') return 'Waiting for the desktop';
  if (phase === 'returning') return 'Welcome back';
  return 'Verifying';
}

function activityStatus(phase: PairActivityPhase, status: string): string {
  if (status) return status;
  if (phase === 'awaiting-desktop') return 'about a second';
  if (phase === 'returning') return 'remembered this device';
  return 'working';
}

export function PhoneShell({ debug, children }: { debug: boolean; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">{debug ? 'debug' : 'phone'}</span>
      </header>
      {children}
    </div>
  );
}

export function ActivityScreen({ phase, status }: { phase: PairActivityPhase; status: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div className="relative">
        <div className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/20 text-accent">
          <IconShield className="h-10 w-10" />
        </div>
      </div>
      <div>
        <div className="text-lg font-semibold">{activityTitle(phase)}</div>
        <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
          <span className="spinner" />
          <span className="pulse-fade">{activityStatus(phase, status)}</span>
        </div>
      </div>
    </div>
  );
}

export function ReadyScreen({
  hasTrust,
  errorMsg,
  googleConfigured,
  onConfirm,
  onPasskey,
  onCreatePasskey,
  onGoogle,
}: {
  hasTrust: boolean;
  errorMsg: string | null;
  googleConfigured: boolean;
  onConfirm: () => void;
  onPasskey: () => void;
  onCreatePasskey: () => void;
  onGoogle: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-accent/15 text-accent">
        <IconShield className="h-12 w-12" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {hasTrust ? 'Welcome back' : 'Choose a check'}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {hasTrust
            ? 'We remember this device. One tap to confirm.'
            : 'Use a passkey if you already have one, or pick another proof.'}
        </p>
      </div>
      {errorMsg && (
        <div className="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-xs text-red-100">
          {errorMsg}
        </div>
      )}
      {hasTrust ? (
        <button onClick={onConfirm} className="btn btn-primary w-full py-4 text-base">
          Confirm
        </button>
      ) : (
        <div className="w-full space-y-3">
          <button onClick={onPasskey} className="btn btn-primary w-full py-4 text-base">
            Use passkey
          </button>
          <button onClick={onCreatePasskey} className="btn w-full py-4 text-base">
            Create passkey
          </button>
          {googleConfigured && (
            <button onClick={onGoogle} className="btn w-full py-4 text-base">
              Continue with Google
            </button>
          )}
        </div>
      )}
      <ProofOptionsLabel hasTrust={hasTrust} googleConfigured={googleConfigured} />
    </div>
  );
}

function ProofOptionsLabel({
  hasTrust,
  googleConfigured,
}: {
  hasTrust: boolean;
  googleConfigured: boolean;
}) {
  const label = hasTrust
    ? 'Trusted device · same network'
    : googleConfigured
      ? 'Passkey · Google · device check'
      : 'Passkey · device check';
  return <div className="text-[11px] uppercase tracking-[0.18em] text-muted/70">{label}</div>;
}

export function TerminalScreen({
  icon,
  tone,
  title,
  message,
  compactMessage = false,
}: {
  icon: ReactNode;
  tone: 'accent' | 'error' | 'success';
  title: string;
  message: string | null;
  compactMessage?: boolean;
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-green-500/15 text-green-300'
      : tone === 'error'
        ? 'bg-red-500/15 text-red-300'
        : 'bg-accent/15 text-accent';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div className={`flex h-20 w-20 items-center justify-center rounded-full ${toneClass}`}>
        {icon}
      </div>
      <div className="space-y-2">
        <div className="text-xl font-semibold">{title}</div>
        <p className={compactMessage ? 'break-all text-xs text-muted' : 'text-sm text-muted'}>
          {message}
        </p>
      </div>
    </div>
  );
}
