import { useEffect, useState, type FormEvent } from 'react';
import { redeemHostedCode, submitHostedRaffleEntry } from '../lib/hosted';
import { fetchLeaderboard, type LeaderboardRow } from '../lib/pair';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';

type Phase = 'redeeming' | 'passed' | 'failed' | 'error';
type EntryPhase = 'idle' | 'submitting' | 'entered' | 'error';

export function HostedCallback() {
  const [phase, setPhase] = useState<Phase>('redeeming');
  const [reason, setReason] = useState<string | null>(null);
  const [callbackCode, setCallbackCode] = useState('');
  const [handle, setHandle] = useState('');
  const [entryPhase, setEntryPhase] = useState<EntryPhase>('idle');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entry, setEntry] = useState<{ code: string; count: number } | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);

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
      setCallbackCode(code);
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

  useEffect(() => {
    let alive = true;
    void fetchLeaderboard()
      .then((rows) => {
        if (alive) setLeaderboard(rows);
      })
      .catch(() => {
        /* keep empty */
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submitEntry(e: FormEvent) {
    e.preventDefault();
    if (!callbackCode || entryPhase === 'submitting') return;
    setEntryPhase('submitting');
    setEntryError(null);
    try {
      const result = await submitHostedRaffleEntry(callbackCode, handle);
      setEntry({ code: result.code, count: result.count });
      setEntryPhase('entered');
      setLeaderboard(await fetchLeaderboard());
    } catch (e) {
      setEntryPhase('error');
      setEntryError(e instanceof Error ? e.message : String(e));
    }
  }

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
          {phase === 'passed' ? (
            <div className="w-full text-left">
              {entryPhase === 'entered' ? (
                <div className="rounded-xl border border-accent/40 bg-accent/15 px-5 py-4 text-center">
                  <div className="label text-accent-bright">you&apos;re in · code</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-white">
                    {entry?.code} <span className="text-muted">·</span> {entry?.count}{' '}
                    {entry?.count === 1 ? 'entry' : 'entries'}
                  </div>
                </div>
              ) : (
                <form onSubmit={submitEntry} className="space-y-3">
                  <input
                    type="text"
                    inputMode="email"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="handle or email"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    className="contest-input w-full rounded-xl border-2 border-accent/50 bg-black/55 px-4 py-4 font-mono text-base text-white placeholder:text-muted/80 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/60"
                    minLength={3}
                    maxLength={64}
                    required
                  />
                  <button
                    className="btn btn-primary w-full py-4 text-base"
                    disabled={entryPhase === 'submitting' || handle.trim().length < 3}
                  >
                    {entryPhase === 'submitting' ? 'Sending' : 'Enter'}
                  </button>
                  {entryError && <p className="break-all text-xs text-red-200">{entryError}</p>}
                </form>
              )}
              {leaderboard.length > 0 && (
                <ol className="mt-5 space-y-1">
                  {leaderboard.slice(0, 5).map((row, idx) => (
                    <li
                      key={`${row.code}-${idx}`}
                      className={`flex items-center justify-between rounded-md px-3 py-2 font-mono text-sm ${
                        entry?.code === row.code ? 'bg-accent/25 text-white' : 'bg-white/[0.04]'
                      }`}
                    >
                      <span className="truncate">{row.code}</span>
                      <span className="tabular-nums text-muted">{row.count}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : (
            <a className="btn btn-primary w-full py-4 text-base" href="/">
              Back to demo
            </a>
          )}
        </div>
      )}
    </div>
  );
}
