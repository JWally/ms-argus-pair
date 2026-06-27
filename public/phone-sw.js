/* eslint-disable no-undef */
/**
 * Phone-only visual shell cache.
 *
 * Scope is /pair/. Do not cache JavaScript, Argus SDK resources, API calls,
 * WebSockets, navigations, proof material, or attestation traffic.
 */
const CACHE = 'pair-phone-visual-v20260627-1';

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
        keys.filter((key) => key.startsWith('pair-phone-') && key !== CACHE).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isVisualShellAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest' ||
    (url.pathname.startsWith('/assets/') && url.pathname.endsWith('.css'))
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
  if (request.mode === 'navigate') return;

  const url = new URL(request.url);
  if (isVisualShellAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
