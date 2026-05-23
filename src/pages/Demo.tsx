import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createRoom } from '../lib/pairing';

type Phase = 'idle' | 'pairing' | 'paired' | 'error';

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phoneHello, setPhoneHello] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      stopRef.current?.();
    },
    []
  );

  async function startDemo() {
    setPhase('pairing');
    setStatus('initializing');
    setPhoneHello(null);
    setErrorMsg(null);
    try {
      const session = await createRoom({
        onStatus: setStatus,
        onMessage: (data) => {
          if (typeof data === 'string') setPhoneHello(data);
        },
        onError: (e) => {
          console.error(e);
        },
      });
      stopRef.current = session.stop;
      const url = `${window.location.origin}/pair/${session.roomId}`;
      setPairUrl(url);
      setQrDataUrl(
        await QRCode.toDataURL(url, {
          width: 320,
          margin: 1,
          color: { dark: '#ffffff', light: '#0a0a0a' },
        })
      );
      await session.ready;
      setPhase('paired');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          argus<span className="text-accent">·</span>pair
        </h1>
        <span className="pill">demo · v0.1</span>
      </header>

      <section className="panel space-y-4">
        <h2 className="text-lg font-semibold">Phone-pair captcha demo</h2>
        <p className="text-sm text-muted">
          Click start, scan the QR with your phone. The desktop and the phone form a peer-to-peer
          WebRTC connection through a signaling broker — no app install. Once the channel opens, the
          phone sends a greeting and the desktop is &quot;paired&quot;.
        </p>
        {phase === 'idle' && (
          <button className="btn btn-primary" onClick={startDemo}>
            Start pairing
          </button>
        )}
        {phase !== 'idle' && (
          <div className="text-xs uppercase tracking-wider text-muted">
            status: <span className="text-white">{status}</span>
          </div>
        )}
      </section>

      {qrDataUrl && phase !== 'paired' && (
        <section className="panel flex flex-col items-center gap-4">
          <img src={qrDataUrl} alt="pairing QR code" className="rounded-md border border-edge" />
          <div className="text-xs text-muted text-center">
            Scan with your phone, or open the URL below:
            <br />
            <a className="text-accent underline" href={pairUrl ?? '#'}>
              {pairUrl}
            </a>
          </div>
        </section>
      )}

      {phase === 'paired' && (
        <section className="panel space-y-3 border-accent">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-green-400" />
            <span className="text-sm font-semibold">Paired with phone</span>
          </div>
          {phoneHello && (
            <div className="rounded border border-edge bg-bg p-3 text-sm">
              <div className="text-xs uppercase tracking-wider text-muted">Phone said</div>
              <div className="mt-1 font-mono">{phoneHello}</div>
            </div>
          )}
          <button
            className="btn"
            onClick={() => {
              stopRef.current?.();
              stopRef.current = null;
              setPhase('idle');
              setPairUrl(null);
              setQrDataUrl(null);
              setPhoneHello(null);
            }}
          >
            Reset
          </button>
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
