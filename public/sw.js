/* eslint-disable no-undef */
/**
 * Tiny app-shell service worker.
 *
 * Scope is deliberately narrow:
 * - cache same-origin static app assets for fast repeat phone paints
 * - leave navigations network-only so HTML always points at the latest
 *   hashed bundles
 * - never intercept /api, mutation requests, or third-party SDK traffic
 *
 * Do not add API routes here. The pair/auth ceremony must always see
 * fresh network state.
 */
const CACHE = 'pair-shell-v20260603-3';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(['/favicon.svg']).catch(() => {});
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('pair-') && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isApiRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest'
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isApiRequest(url)) return;
  if (request.mode === 'navigate') return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
