import { useEffect, useState } from 'react';
import { redeemHostedCode } from '../lib/hosted';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';

type Phase = 'redeeming' | 'passed' | 'failed' | 'error';

export function HostedCallback() {
  const [phase, setPhase] = useState<Phase>('redeeming');
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code') ?? '';
      const state = params.get('state') ?? '';
      const expectedState = (() => {
        try {
          const raw = window.sessionStorage.getItem('argus-hosted-demo');
          return raw ? (JSON.parse(raw) as { state?: string }).state : null;
        } catch {
          return null;
        }
      })();
      if (!code || !state || (expectedState && state !== expectedState)) {
        throw new Error('callback_state_mismatch');
      }
      const result = await redeemHostedCode(code);
      if (alive) {
        setReason(result.reason);
        setPhase(result.verdict === 'passed' ? 'passed' : 'failed');
      }
    })().catch((e) => {
      if (alive) {
        setPhase('error');
        setReason(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="pill">callback</span>
      </header>

      {phase === 'redeeming' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/20 text-accent">
              <IconShield className="h-10 w-10" />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
            <span className="spinner" />
            <span className="pulse-fade">redeeming one-time code</span>
          </div>
        </div>
      )}

      {(phase === 'passed' || phase === 'failed' || phase === 'error') && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div
            className={`flex h-20 w-20 items-center justify-center rounded-full ${
              phase === 'passed' ? 'bg-green-500/15 text-green-300' : 'bg-red-500/15 text-red-300'
            }`}
          >
            {phase === 'passed' ? (
              <IconCheck className="h-10 w-10" />
            ) : (
              <IconX className="h-10 w-10" />
            )}
          </div>
          <div className="space-y-2">
            <div className="text-xl font-semibold">
              {phase === 'passed' ? 'Verified' : 'Not verified'}
            </div>
            <p className="break-all text-xs text-muted">{reason}</p>
          </div>
          <a className="btn btn-primary w-full py-4 text-base" href="/">
            Back to demo
          </a>
        </div>
      )}
    </div>
  );
}
