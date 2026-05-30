/* eslint-disable no-undef */
/**
 * Service worker for ms-argus-pair.
 *
 * Strategy:
 *   - /assets/* (Vite's content-hashed bundles) → cache-first.
 *     File names rotate on every build, so a cache hit is always
 *     fresh. Saves a network round-trip on returning visitors.
 *   - everything else (index.html, /api/*, /favicon.svg, etc.) →
 *     pass through to the network. We never cache HTML or API
 *     responses — staleness there breaks the demo.
 *
 * Cache invalidation: bumping CACHE_VERSION invalidates the prior
 * cache on activation. Hashed asset names mean we rarely need to
 * bump, but it's the only escape hatch for a wedged client.
 */
const CACHE_VERSION = 'v1';
const ASSET_CACHE = `pair-assets-${CACHE_VERSION}`;

// Take over open clients ASAP — without this, the SW only activates
// for new pages. For a demo where users often hard-refresh once they
// notice the SW exists, this is the friendlier behaviour.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('pair-assets-') && k !== ASSET_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin /assets/*. Everything else (HTML, /api,
  // cross-origin CDN bundles like argus-loader, Google's GIS script)
  // is left to the browser's default network path.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/assets/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const resp = await fetch(req);
      // Only cache successful responses. Don't poison the cache with
      // 404s or 500s — those should hit the network every time so the
      // user sees the error if it persists.
      if (resp.ok) {
        cache.put(req, resp.clone()).catch(() => {
          /* quota or no-storage error — non-fatal, just don't cache */
        });
      }
      return resp;
    })()
  );
});
