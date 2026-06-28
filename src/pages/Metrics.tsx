import { Link } from 'react-router-dom';
import { Wordmark } from '../components/Brand';
import { IconShield } from '../components/Icons';

const rows = [
  ['Device continuity', 'SDK key across merchant, Argus, merchant'],
  ['Network continuity', 'ASN, country, proxy, datacenter, VPN'],
  ['Risk drift', 'score ceiling and leg-to-leg spread'],
  ['Approval', 'server-consumed code plus merchant cookie'],
] as const;

export function Metrics() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-10 px-6 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Wordmark />
        <Link className="pill" to="/merchant">
          Merchant
        </Link>
      </header>
      <main>
        <span className="pill w-fit">
          <IconShield className="h-3 w-3" /> metrics
        </span>
        <h1 className="mt-5 text-3xl font-semibold leading-tight">Continuity checks</h1>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {rows.map(([title, value]) => (
            <div className="card p-5" key={title}>
              <div className="label">{title}</div>
              <div className="mt-2 text-sm text-white/80">{value}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
