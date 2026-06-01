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

// Service worker is deliberately NOT registered here. We had one that
// cached assets + HTML for a 24h stale-while-revalidate window, but
// Safari + stale bundles + an in-flight argus scan turned out to be a
// long tail of "why did desktop hang?" reports. The win (a few hundred
// ms on cellular cold-load) wasn't worth the debugging tax.
//
// For visitors who already installed the old SW: nuke it. The /sw.js
// file in this build is a self-uninstaller that deletes its own caches
// and unregisters itself. Belt-and-suspenders, we also drive the
// unregister from here so the SW never even runs on this page load.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => {
      void r.unregister();
    });
  });
  if ('caches' in window) {
    void window.caches.keys().then((keys) => {
      keys
        .filter((k) => k.startsWith('pair-'))
        .forEach((k) => {
          void window.caches.delete(k);
        });
    });
  }
}
