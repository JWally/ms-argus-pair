import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Splash } from './components/Splash';
import './fonts.css';
import './index.css';

// Pair and Embed remain route-split. The SSO pages intentionally share one
// chunk so moving between its stages cannot flash the Suspense fallback.
//
// Named exports → default-export shape that React.lazy expects.
const Pair = lazy(() => import('./pages/Pair').then((m) => ({ default: m.Pair })));
const SsoRoute = lazy(() => import('./pages/SsoRoutes').then((m) => ({ default: m.SsoRoute })));
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
          <Route path="/merchant" element={<SsoRoute page="merchant" />} />
          <Route path="/sso/challenge/:sessionId" element={<SsoRoute page="challenge" />} />
          <Route path="/merchant/validate" element={<SsoRoute page="validate" />} />
          <Route path="/sso/mobile" element={<SsoRoute page="mobile" />} />
          <Route path="/pair/:roomId" element={<Pair />} />
          <Route path="/embed" element={<Embed />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);
