import type { EmbedPhase } from '../lib/embed-presentation';

const svg = { fill: 'none', stroke: 'currentColor' } as const;

export const EyeMark = () => (
  <svg className="ax-eye" viewBox="0 0 24 24" strokeWidth={2} {...svg}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const MonitorIcon = () => (
  <svg viewBox="0 0 24 24" strokeWidth={1.8} {...svg}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);

export const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" strokeWidth={1.8} {...svg}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);

export function EmbedSeal({ phase }: { phase: EmbedPhase }) {
  if (phase === 'scanning' || phase === 'pairing') return null;

  return (
    <svg className="ax-ring" viewBox="0 0 48 48" strokeWidth={2.4} {...svg}>
      <circle cx="24" cy="24" r="21" opacity="0.28" />
      <circle cx="24" cy="24" r="14" />
      {phase === 'verified' ? (
        <path
          d="M17.5 24.5l4.5 4.5 9-10"
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : phase === 'timeout' ? (
        <path d="M24 16.5v8l5 3" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M19 19l10 10M29 19l-10 10" strokeWidth={3.2} strokeLinecap="round" />
      )}
    </svg>
  );
}
