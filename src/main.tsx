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
const MerchantSso = lazy(() =>
  import('./pages/MerchantSso').then((m) => ({ default: m.MerchantSso }))
);
const SsoChallenge = lazy(() =>
  import('./pages/SsoChallenge').then((m) => ({ default: m.SsoChallenge }))
);
const MerchantValidate = lazy(() =>
  import('./pages/MerchantValidate').then((m) => ({ default: m.MerchantValidate }))
);
const ClaimSpot = lazy(() => import('./pages/ClaimSpot').then((m) => ({ default: m.ClaimSpot })));
const Metrics = lazy(() => import('./pages/Metrics').then((m) => ({ default: m.Metrics })));

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/" element={<Demo />} />
          <Route path="/merchant" element={<MerchantSso />} />
          <Route path="/sso/challenge/:sessionId" element={<SsoChallenge />} />
          <Route path="/merchant/validate" element={<MerchantValidate />} />
          <Route path="/claim" element={<ClaimSpot />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/pair/:roomId" element={<Pair />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);
