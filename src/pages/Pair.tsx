import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { joinRoom } from '../lib/pairing';

type Phase = 'idle' | 'joining' | 'connected' | 'error';

export function Pair() {
  const { roomId } = useParams<{ roomId: string }>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      stopRef.current?.();
    },
    []
  );

  async function start() {
    if (!roomId) {
      setPhase('error');
      setErrorMsg('Missing room id');
      return;
    }
    setPhase('joining');
    setStatus('initializing');
    setErrorMsg(null);
    try {
      const session = await joinRoom(roomId, {
        onStatus: setStatus,
        onConnected: (dc) => {
          try {
            dc.send(`hello from phone · ${new Date().toLocaleTimeString()}`);
          } catch (e) {
            console.warn('send failed', e);
          }
        },
      });
      stopRef.current = session.stop;
      await session.ready;
      setPhase('connected');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
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
          room: <span className="text-white">{roomId}</span>
        </p>
        {phase === 'idle' && (
          <button className="btn btn-primary" onClick={start}>
            Tap to pair
          </button>
        )}
        {phase !== 'idle' && (
          <div className="text-xs uppercase tracking-wider text-muted">
            status: <span className="text-white">{status}</span>
          </div>
        )}
      </section>

      {phase === 'connected' && (
        <section className="panel space-y-3 border-accent">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-green-400" />
            <span className="text-sm font-semibold">Connected</span>
          </div>
          <p className="text-sm text-muted">
            You may return to the desktop. The pairing succeeded.
          </p>
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
