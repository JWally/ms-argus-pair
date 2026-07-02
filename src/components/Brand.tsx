/**
 * Pair product mark — uses the same concentric "eye/target" glyph as the
 * main Argus marketing site (ms-argus-www Logo), rendered in an accent box.
 */
function BrandMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-accent text-white ${className}`}
      aria-hidden
    >
      <svg
        width="60%"
        height="60%"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
        <path d="M12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z" />
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <BrandMark className="h-7 w-7" />
      <span className="text-base font-semibold tracking-tight text-fg-primary">Argus Pair</span>
    </div>
  );
}
