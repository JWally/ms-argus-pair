import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { completePhoneSession } from '../lib/pair';

type Phase = 'idle' | 'pairing' | 'paired' | 'failed' | 'error';

export function Pair() {
  const { roomId: sessionId } = useParams<{ roomId: string }>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inflightRef = useRef(false);

  useEffect(() => {
    return () => {
      inflightRef.current = false;
    };
  }, []);

  async function start() {
    if (!sessionId) {
      setPhase('error');
      setErrorMsg('Missing session id');
      return;
    }
    if (inflightRef.current) return;
    inflightRef.current = true;
    setPhase('pairing');
    setStatus('initializing');
    setErrorMsg(null);
    try {
      const r = await completePhoneSession(sessionId, { onStatus: setStatus });
      setVerdict(r.verdict);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      inflightRef.current = false;
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          argus<span className="text-accent">·</span>pair
        </h1>
        <span className="pill">phone</span>
      </header>

      <section className="panel space-y-4">
        <h2 className="text-lg font-semibold">Pair this phone with the desktop</h2>
        <p className="text-sm text-muted break-all">
          session: <span className="text-white">{sessionId?.slice(0, 24)}…</span>
        </p>
        {phase === 'idle' && (
          <button className="btn btn-primary" onClick={start}>
            Tap to pair
          </button>
        )}
        {phase === 'pairing' && (
          <div className="text-xs uppercase tracking-wider text-muted">
            status: <span className="text-white">{status}</span>
          </div>
        )}
      </section>

      {phase === 'paired' && (
        <section className="panel space-y-3 border-accent">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-green-400" />
            <span className="text-sm font-semibold">Paired</span>
          </div>
          <p className="text-sm text-muted">
            You may return to the desktop. The verdict was <code>{verdict}</code>.
          </p>
        </section>
      )}

      {phase === 'failed' && (
        <section className="panel border-red-500/50">
          <div className="text-sm text-red-400">verdict: {verdict}</div>
        </section>
      )}

      {phase === 'error' && (
        <section className="panel border-red-500/50">
          <div className="text-sm text-red-400">error: {errorMsg}</div>
        </section>
      )}
    </div>
  );
}
