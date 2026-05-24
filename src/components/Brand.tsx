/**
 * Brand mark — a small "P" rendered as a stylised paired-link glyph.
 * Used as the wordmark for the captcha; deliberately neutral, not
 * branded as the underlying detection service.
 */
export function BrandMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="brand-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7b34c5" />
          <stop offset="100%" stopColor="#3f1466" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#brand-grad)" />
      <path
        d="M11 9h7a5 5 0 0 1 0 10h-3v4h-4V9zm4 3v4h3a2 2 0 0 0 0-4h-3z"
        fill="#fff"
      />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <BrandMark className="h-7 w-7" />
      <span className="text-base font-semibold tracking-tight text-white/90">Pair</span>
    </div>
  );
}
