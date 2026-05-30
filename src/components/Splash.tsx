import type { ReactElement } from 'react';

/**
 * Visual match for the inline pre-React splash in `index.html`. Used as
 * the Suspense fallback while a route chunk is in flight, so there's no
 * visual flash when React mounts and replaces the inline DOM.
 *
 * Keep this purely visual — no hooks, no async, no business logic. Any
 * weight added here lands in the entry chunk and erodes the route-split
 * win.
 */
export function Splash(): ReactElement {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.5rem',
        background: '#0a0a0a',
        color: 'rgba(255, 255, 255, 0.92)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      <div style={{ fontSize: '1.15rem', fontWeight: 600, letterSpacing: '0.04em' }}>
        argus<span style={{ color: '#b388ff' }}>.pair</span>
      </div>
      <div
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          border: '2px solid rgba(255, 255, 255, 0.18)',
          borderTopColor: '#b388ff',
          animation: 'argusPairSpin 0.7s linear infinite',
        }}
      />
    </div>
  );
}
