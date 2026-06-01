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
//
// Deliberately bare: no controllerchange auto-reload, no updatefound
// listener, no registration.update() polling. The browser activates a
// new SW naturally on the next navigation; reloading mid-session
// (which Safari was eager to do) drops the WebSocket and forces the
// user to start over. Users on stale code see the new bundle on their
// next visit — that's a one-visit staleness window, fine.
//
// Manual escape for any stuck client: ?fresh=1 (handled in sw.js).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* registration failed (private mode, no quota, etc.) — silent */
    });
  });
}
