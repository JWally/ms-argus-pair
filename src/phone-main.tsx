import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Pair } from './pages/Pair';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/pair/:roomId" element={<Pair />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

// Phone-only app-shell SW. It never runs on the desktop entry and only caches
// same-origin visual shell assets; Argus, API, WebSocket, and proof traffic stay
// network-owned.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/phone-sw.js', { scope: '/pair/' }).catch((e) => {
      console.warn('[argus-pair] phone service worker registration failed', e);
    });
  });
}
