interface AnnotationsCardProps {
  annotations: Record<string, unknown>;
}

interface Row {
  key: string;
  label: string;
  display: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

function renderValue(v: unknown): string {
  if (v === true) return '✓';
  if (v === false) return '✗';
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function toneFor(key: string, value: unknown): Row['tone'] {
  // PAT / WebAuthn attested → positive
  if (
    (key === 'pat_used_desktop' ||
      key === 'pat_used_phone' ||
      key === 'phone_webauthn_attested' ||
      key === 'phone_webauthn_user_verified' ||
      key === 'phone_is_phone') &&
    value === true
  )
    return 'good';
  // Datacenter / both-phone → caution
  if ((key === 'desktop_dc_asn' || key === 'phone_dc_asn' || key === 'phone_to_phone') && value === true)
    return 'warn';
  // Scores
  if (key === 'desktop_score' || key === 'phone_score') {
    const n = typeof value === 'number' ? value : 0;
    if (n >= 30) return 'bad';
    if (n >= 15) return 'warn';
    return 'good';
  }
  if (key === 'total_score') {
    const n = typeof value === 'number' ? value : 0;
    if (n >= 50) return 'bad';
    if (n >= 30) return 'warn';
    return 'good';
  }
  return 'neutral';
}

const LABELS: Record<string, string> = {
  desktop_score: 'Desktop score',
  phone_score: 'Phone score',
  total_score: 'Total score',
  pat_used_desktop: 'PAT (desktop)',
  pat_used_phone: 'PAT (phone)',
  desktop_is_phone: 'Desktop is mobile-class',
  phone_is_phone: 'Phone is mobile-class',
  desktop_dc_asn: 'Desktop on datacenter',
  phone_dc_asn: 'Phone on datacenter',
  phone_to_phone: 'Phone-to-phone pairing',
  phone_webauthn_attested: 'WebAuthn attested',
  phone_webauthn_aaguid: 'WebAuthn AAGUID',
  phone_webauthn_format: 'WebAuthn format',
  phone_webauthn_credential_backed_up: 'Credential backed up',
  phone_webauthn_user_verified: 'User verified (biometric)',
  phone_webauthn_error: 'WebAuthn error',
  score_lookup_skipped: 'Score lookup skipped',
  desktop_projection_present: 'Desktop projection found',
  phone_projection_present: 'Phone projection found',
};

const ORDER = [
  'desktop_score',
  'phone_score',
  'total_score',
  'desktop_is_phone',
  'phone_is_phone',
  'phone_to_phone',
  'desktop_dc_asn',
  'phone_dc_asn',
  'pat_used_desktop',
  'pat_used_phone',
  'phone_webauthn_attested',
  'phone_webauthn_user_verified',
  'phone_webauthn_format',
  'phone_webauthn_aaguid',
  'phone_webauthn_credential_backed_up',
  'phone_webauthn_error',
  'score_lookup_skipped',
  'desktop_projection_present',
  'phone_projection_present',
];

export function AnnotationsCard({ annotations }: AnnotationsCardProps) {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const k of ORDER) {
    if (k in annotations) {
      seen.add(k);
      rows.push({
        key: k,
        label: LABELS[k] ?? k,
        display: renderValue(annotations[k]),
        tone: toneFor(k, annotations[k]),
      });
    }
  }
  for (const k of Object.keys(annotations)) {
    if (seen.has(k)) continue;
    rows.push({
      key: k,
      label: LABELS[k] ?? k,
      display: renderValue(annotations[k]),
      tone: toneFor(k, annotations[k]),
    });
  }

  if (rows.length === 0) return null;

  const toneClass = (t: Row['tone']) =>
    t === 'good'
      ? 'text-green-300'
      : t === 'warn'
        ? 'text-amber-300'
        : t === 'bad'
          ? 'text-red-300'
          : 'text-white/85';

  return (
    <div className="card p-4">
      <div className="label mb-3">Signal summary</div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-1.5 last:border-0"
          >
            <dt className="text-xs text-muted">{r.label}</dt>
            <dd className={`font-mono text-xs ${toneClass(r.tone)}`}>{r.display}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
