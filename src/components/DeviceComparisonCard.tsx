import { IconCheck, IconX } from './Icons';

interface DeviceComparisonCardProps {
  annotations: Record<string, unknown>;
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

interface Row {
  label: string;
  render: (side: 'desktop' | 'phone') => { display: string; tone: Tone; bool?: boolean };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

function scoreTone(score: number): Tone {
  if (score >= 30) return 'bad';
  if (score >= 15) return 'warn';
  return 'good';
}

function locationString(city: string | null, country: string | null): string {
  if (city && country) return `${city}, ${country}`;
  return city ?? country ?? '—';
}

export function DeviceComparisonCard({ annotations }: DeviceComparisonCardProps) {
  const get = (k: string) => annotations[k];

  const rows: Row[] = [
    {
      label: 'Threat score',
      render: (side) => {
        const n = num(get(`${side}_score`));
        if (n === null) return { display: '—', tone: 'neutral' };
        return { display: `${n} / 100`, tone: scoreTone(n) };
      },
    },
    {
      label: 'Browser',
      render: (side) => {
        const name = str(get(`${side}_browser_name`));
        const version = str(get(`${side}_browser_version`));
        if (!name) return { display: '—', tone: 'neutral' };
        return {
          display: version ? `${name} ${version.split('.')[0]}` : name,
          tone: 'neutral',
        };
      },
    },
    {
      label: 'OS',
      render: (side) => ({
        display: str(get(`${side}_os`)) ?? '—',
        tone: 'neutral',
      }),
    },
    {
      label: 'IP',
      render: (side) => ({
        display: str(get(`${side}_ip`)) ?? '—',
        tone: 'neutral',
      }),
    },
    {
      label: 'Location',
      render: (side) => ({
        display: locationString(
          str(get(`${side}_city`)),
          str(get(`${side}_country`))
        ),
        tone: 'neutral',
      }),
    },
    {
      label: 'Network (ASN)',
      render: (side) => ({
        display: str(get(`${side}_asn_name`)) ?? '—',
        tone: 'neutral',
      }),
    },
    {
      label: 'Mobile network',
      render: (side) => {
        const v = bool(get(`${side}_is_mobile_network`));
        return { display: v ? 'yes' : 'no', tone: 'neutral', bool: v };
      },
    },
    {
      label: 'Proxy',
      render: (side) => {
        const v = bool(get(`${side}_is_proxy`));
        return { display: v ? 'yes' : 'no', tone: v ? 'bad' : 'good', bool: v };
      },
    },
    {
      label: 'VPN',
      render: (side) => {
        const v = bool(get(`${side}_is_vpn`));
        return { display: v ? 'yes' : 'no', tone: v ? 'warn' : 'good', bool: v };
      },
    },
    {
      label: 'Datacenter',
      render: (side) => {
        const v = bool(get(`${side}_dc_asn`));
        return { display: v ? 'yes' : 'no', tone: v ? 'warn' : 'good', bool: v };
      },
    },
    {
      label: 'Apple PAT',
      render: (side) => {
        const v = bool(get(`pat_used_${side}`));
        return {
          display: v ? 'attested' : 'none',
          tone: v ? 'good' : 'neutral',
          bool: v,
        };
      },
    },
  ];

  const toneClass = (t: Tone) =>
    t === 'good'
      ? 'text-green-300'
      : t === 'warn'
        ? 'text-amber-300'
        : t === 'bad'
          ? 'text-red-300'
          : 'text-white/90';

  function Cell({
    cell,
  }: {
    cell: { display: string; tone: Tone; bool?: boolean };
  }) {
    if (cell.bool === true) {
      return (
        <span className={`inline-flex items-center gap-1.5 font-mono text-xs ${toneClass(cell.tone)}`}>
          <IconCheck className="h-3 w-3" /> {cell.display}
        </span>
      );
    }
    if (cell.bool === false) {
      return (
        <span className={`inline-flex items-center gap-1.5 font-mono text-xs ${toneClass(cell.tone)}`}>
          <IconX className="h-3 w-3 opacity-60" /> {cell.display}
        </span>
      );
    }
    return (
      <span className={`break-all font-mono text-xs ${toneClass(cell.tone)}`}>
        {cell.display}
      </span>
    );
  }

  return (
    <div className="card overflow-hidden p-0">
      <div className="grid grid-cols-2 border-b border-edge/60 bg-white/[0.02] sm:grid-cols-[1fr_1fr_1fr]">
        <div className="hidden border-r border-edge/60 px-4 py-3 sm:block" />
        <div className="label flex items-center gap-2 border-r border-edge/40 px-4 py-3">
          <span className="glow-dot amber" /> Desktop
        </div>
        <div className="label flex items-center gap-2 px-4 py-3">
          <span className="glow-dot" /> Phone
        </div>
      </div>
      <dl className="divide-y divide-edge/40">
        {rows.map((r) => {
          const d = r.render('desktop');
          const p = r.render('phone');
          return (
            <div
              key={r.label}
              className="grid grid-cols-2 items-baseline gap-2 px-4 py-2.5 sm:grid-cols-[1fr_1fr_1fr]"
            >
              <dt className="col-span-2 text-[11px] uppercase tracking-[0.12em] text-muted sm:col-span-1">
                {r.label}
              </dt>
              <dd className="border-r border-edge/40 pr-3 sm:pr-4">
                <Cell cell={d} />
              </dd>
              <dd className="pl-1 sm:pl-2">
                <Cell cell={p} />
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
