import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Splash } from './components/Splash';
import './index.css';

// Globals shared with pair.ts so the controllerchange-driven SW reload
// can defer firing while a pair session is mid-flight. See the
// addEventListener('controllerchange', …) handler below.
declare global {
  interface Window {
    __argusSessionInFlight?: boolean;
    __argusPendingReload?: boolean;
    __argusFlushPendingReload?: () => void;
  }
}

// Route-split: each page lands in its own Vite chunk. Phone users
// hitting /pair/:id download only the Pair chunk + entry, NOT the
// raffle / leaderboard / QR generator that live in Demo. Saves
// ~150KB minified on the phone-side cold load.
//
// Named exports → default-export shape that React.lazy expects.
const Demo = lazy(() => import('./pages/Demo').then((m) => ({ default: m.Demo })));
const Pair = lazy(() => import('./pages/Pair').then((m) => ({ default: m.Pair })));

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/" element={<Demo />} />
          <Route path="/pair/:roomId" element={<Pair />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);

// Register the asset/HTML-cache service worker for returning visits.
// Only in production builds — keeps `vite dev` HMR uncontested.
// Failure is non-fatal; the app works fine without the SW.
//
// Cache-lock prevention layers:
//   1. registration.update() forces the browser to revalidate sw.js
//      on every load, not just navigation. Catches the case where the
//      SW file changed but the cached registration would have skipped
//      the fetch.
//   2. controllerchange fires when a new SW activates and takes over.
//      That happens after a deploy with skipWaiting() — the page is
//      still running old JS at that moment, so we reload to pick up
//      the new bundle. The `refreshing` latch stops the reload-loop
//      that would otherwise fire on every navigation.
//   3. ?fresh=1 query param: handled in sw.js, wipes caches and pulls
//      from network. Manual escape for stuck clients.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    let refreshing = false;
    /**
     * Auto-refresh on a TRUE SW update — i.e. the page was being
     * controlled by an OLD SW and a NEW SW just took over. Skips the
     * first-install case where `controllerchange` fires only because
     * there was no controller before; reloading then is wasted and
     * shows as a "pre-flash" on the demo. Tracks the update via
     * `updatefound` + the new worker's `statechange` so we only reload
     * when we have unambiguous evidence of an actual update.
     */
    const doReload = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    const maybeReload = () => {
      if (window.__argusSessionInFlight) {
        window.__argusPendingReload = true;
        return;
      }
      doReload();
    };
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        const handleNewWorker = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated' && navigator.serviceWorker.controller) {
              // Genuine update: there was a prior controller and a new
              // SW has just activated to replace it.
              maybeReload();
            }
          });
        };
        registration.addEventListener('updatefound', () => {
          handleNewWorker(registration.installing);
        });
        // Browsers already revalidate sw.js on navigation; explicit
        // update() here is belt-and-suspenders for SPAs that don't
        // navigate often. Failure is non-fatal.
        registration.update().catch(() => {
          /* update check failed — non-fatal, browser retries on next nav */
        });
      })
      .catch(() => {
        /* registration failed (private mode, no quota, etc.) — silent */
      });
    // The session-end path (in pair.ts / Pair.tsx) calls this so the
    // deferred reload fires the moment the user is no longer mid-flow.
    window.__argusFlushPendingReload = () => {
      if (window.__argusPendingReload && !window.__argusSessionInFlight) {
        doReload();
      }
    };
  });
}
