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

// No service worker registration or cleanup runs here. The old SW
// cached HTML + assets and produced enough Safari-reload + stale-
// bundle pain that we retired it. `public/sw.js` remains as a
// permanent self-uninstaller for any rare returning client that
// still has the old worker registered — the browser fetches it on
// its next update check, activates it, and the new worker deletes
// its own caches and calls registration.unregister() to remove
// itself. That file MUST stay shipped (deleting it would 404 the
// update probe and orphan those clients on the old code path).
