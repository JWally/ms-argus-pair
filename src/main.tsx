import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Splash } from './components/Splash';
import './index.css';

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
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registration.update().catch(() => {
          /* update check failed — non-fatal, browser retries on next nav */
        });
      })
      .catch(() => {
        /* registration failed (private mode, no quota, etc.) — silent */
      });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}
