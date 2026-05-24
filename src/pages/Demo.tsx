import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { startDesktopSession } from '../lib/pair';

type Phase = 'idle' | 'scanning' | 'waiting' | 'paired' | 'failed' | 'error';

export function Demo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [verdictReason, setVerdictReason] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      stopRef.current?.();
    },
    []
  );

  async function startDemo() {
    setPhase('scanning');
    setStatus('initializing');
    setVerdict(null);
    setVerdictReason(null);
    setErrorMsg(null);
    try {
      const session = await startDesktopSession({ onStatus: setStatus });
      stopRef.current = session.stop;
      setPairUrl(session.pairUrl);
      setQrDataUrl(
        await QRCode.toDataURL(session.pairUrl, {
          width: 320,
          margin: 1,
          color: { dark: '#ffffff', light: '#0a0a0a' },
        })
      );
      setPhase('waiting');
      const r = await session.result;
      setVerdict(r.verdict);
      setVerdictReason(r.reason);
      setPhase(r.verdict === 'paired' ? 'paired' : 'failed');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    stopRef.current?.();
    stopRef.current = null;
    setPhase('idle');
    setPairUrl(null);
    setQrDataUrl(null);
    setVerdict(null);
    setVerdictReason(null);
    setErrorMsg(null);
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          argus<span className="text-accent">·</span>pair
        </h1>
        <span className="pill">demo · v0.2 (co-attest)</span>
      </header>

      <section className="panel space-y-4">
        <h2 className="text-lg font-semibold">Phone-pair captcha demo</h2>
        <p className="text-sm text-muted">
          Click start. The desktop runs an Argus integrity scan and signs an envelope binding itself
          to a server-issued nonce. You scan the QR with your phone. The phone runs its own
          integrity scan, signs an envelope binding to the same nonce plus the desktop&apos;s
          identity. Server verifies both signatures and emits a verdict.
        </p>
        {phase === 'idle' && (
          <button className="btn btn-primary" onClick={startDemo}>
            Start pairing
          </button>
        )}
        {phase !== 'idle' && phase !== 'paired' && phase !== 'failed' && phase !== 'error' && (
          <div className="text-xs uppercase tracking-wider text-muted">
            status: <span className="text-white">{status}</span>
          </div>
        )}
      </section>

      {qrDataUrl && phase === 'waiting' && (
        <section className="panel flex flex-col items-center gap-4">
          <img src={qrDataUrl} alt="pairing QR code" className="rounded-md border border-edge" />
          <div className="text-center text-xs text-muted">
            Scan with your phone, or open the URL below:
            <br />
            <a className="break-all text-accent underline" href={pairUrl ?? '#'}>
              {pairUrl}
            </a>
          </div>
        </section>
      )}

      {phase === 'paired' && (
        <section className="panel space-y-3 border-accent">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-green-400" />
            <span className="text-sm font-semibold">Paired</span>
          </div>
          <div className="rounded border border-edge bg-bg p-3 text-sm">
            <div className="text-xs uppercase tracking-wider text-muted">Verdict</div>
            <div className="mt-1 font-mono">{verdict}</div>
            {verdictReason && (
              <>
                <div className="mt-3 text-xs uppercase tracking-wider text-muted">Reason</div>
                <div className="mt-1 font-mono text-xs">{verdictReason}</div>
              </>
            )}
          </div>
          <button className="btn" onClick={reset}>
            Reset
          </button>
        </section>
      )}

      {phase === 'failed' && (
        <section className="panel space-y-3 border-red-500/50">
          <div className="text-sm text-red-400">verdict: {verdict}</div>
          {verdictReason && <div className="text-xs text-muted">reason: {verdictReason}</div>}
          <button className="btn" onClick={reset}>
            Reset
          </button>
        </section>
      )}

      {phase === 'error' && (
        <section className="panel border-red-500/50">
          <div className="text-sm text-red-400">error: {errorMsg}</div>
          <button className="btn mt-3" onClick={reset}>
            Reset
          </button>
        </section>
      )}
    </div>
  );
}
