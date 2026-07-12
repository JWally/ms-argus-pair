import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Splash } from './components/Splash';
import './fonts.css';
import './index.css';

// Route-split: each page lands in its own Vite chunk. Phone users
// hitting /pair/:id download only the Pair chunk + entry. Saves ~150KB
// minified on the phone-side cold load.
//
// Named exports → default-export shape that React.lazy expects.
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
const Embed = lazy(() => import('./pages/Embed').then((m) => ({ default: m.Embed })));

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Splash />}>
        <Routes>
          {/* Marketing moved to ms-argus-www (/captcha). This is the app
              subdomain — no landing at `/`; entry points are the routes below. */}
          <Route path="/merchant" element={<MerchantSso />} />
          <Route path="/sso/challenge/:sessionId" element={<SsoChallenge />} />
          <Route path="/merchant/validate" element={<MerchantValidate />} />
          <Route path="/pair/:roomId" element={<Pair />} />
          <Route path="/embed" element={<Embed />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);
