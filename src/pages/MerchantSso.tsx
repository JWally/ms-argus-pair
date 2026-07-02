import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconCheck, IconPhone, IconShield } from '../components/Icons';
import { startSsoSession } from '../lib/pair';

function newMerchantSessionId(): string {
  const existing = window.sessionStorage.getItem('argus-demo-merchant-session');
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.sessionStorage.setItem('argus-demo-merchant-session', id);
  return id;
}

export function MerchantSso() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'idle' | 'profiling' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const merchantSessionId = useMemo(() => newMerchantSessionId(), []);
  const sessionShort = merchantSessionId.slice(0, 8);

  async function begin() {
    setStatus('profiling');
    setError(null);
    try {
      const s = await startSsoSession(merchantSessionId);
      window.sessionStorage.setItem(`argus-demo-sso-nonce:${s.sessionId}`, s.nonce);
      navigate(`${s.challengeUrl}?n=${encodeURIComponent(s.nonce)}`);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-8 px-5 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge/60 pb-4">
        <Wordmark />
      </header>

      <main className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section className="sso-shell">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <span className="pill w-fit">
                <IconShield className="h-3 w-3" /> merchant
              </span>
              <h1 className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.08] sm:text-5xl">
                Checkout continuity
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
                This merchant page starts a browser integrity check, bounces to Argus, then
                validates the same device before returning to checkout.
              </p>
            </div>
            <div className="sso-session">
              <div className="label">merchant session</div>
              <div className="mt-2 font-mono text-lg text-white">{sessionShort}</div>
            </div>
          </div>

          <div className="sso-route mt-8">
            <div className="sso-route-node sso-route-node-active">
              <IconPhone className="h-4 w-4" />
              <span>merchant</span>
            </div>
            <div className="sso-route-line" />
            <div className="sso-route-node">
              <IconShield className="h-4 w-4" />
              <span>argus</span>
            </div>
            <div className="sso-route-line" />
            <div className="sso-route-node">
              <IconCheck className="h-4 w-4" />
              <span>validate</span>
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="btn btn-primary px-6 py-4 text-base sm:min-w-44"
              onClick={begin}
              disabled={status === 'profiling'}
            >
              {status === 'profiling' ? 'Profiling...' : 'Continue'}
            </button>
            <Link className="btn px-6 py-4 text-base" to="/">
              QR demo
            </Link>
          </div>
          {error && (
            <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
        </section>

        <aside className="sso-side-panel">
          <div className="label mb-5">decision contract</div>
          <div className="space-y-4">
            <div className="sso-check-row">
              <IconCheck className="h-4 w-4 shrink-0 text-accent" />
              <div>
                <div className="text-sm font-semibold text-white">Same device</div>
                <div className="text-xs text-muted">SDK key continuity across all legs.</div>
              </div>
            </div>
            <div className="sso-check-row">
              <IconCheck className="h-4 w-4 shrink-0 text-accent" />
              <div>
                <div className="text-sm font-semibold text-white">Nearby network</div>
                <div className="text-xs text-muted">ASN, country, proxy, datacenter, VPN.</div>
              </div>
            </div>
            <div className="sso-check-row">
              <IconCheck className="h-4 w-4 shrink-0 text-accent" />
              <div>
                <div className="text-sm font-semibold text-white">Single-use return</div>
                <div className="text-xs text-muted">Code is redeemed before approval cookie.</div>
              </div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
