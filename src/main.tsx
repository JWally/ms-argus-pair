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

// App-shell SW for repeat phone paints. It deliberately does not own
// /api or mutation requests, and we do not force a controllerchange
// reload — Safari reloads during validation were the old failure mode.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => {
      console.warn('[argus-pair] service worker registration failed', e);
    });
  });
}
