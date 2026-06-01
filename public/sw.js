/* eslint-disable no-undef */
/**
 * Service worker for ms-argus-pair.
 *
 * Caching strategy:
 *
 *   /assets/*    (Vite content-hashed bundles)  → cache-first
 *     File names rotate per build, so a cache hit is always content-
 *     correct. Saves a network round-trip on returning visitors.
 *
 *   HTML (navigation requests, text/html)       → stale-while-revalidate
 *     Cached entry serves first, refresh fires in the background. The
 *     first byte of the inline splash paints in <50ms on a returning
 *     visit, even on a janky connection. Bounded by HTML_TTL_MS so a
 *     deploy can't strand a user on stale HTML indefinitely.
 *
 *   /api/*, /favicon.svg, cross-origin scripts   → pass through.
 *
 * Staleness contract:
 *
 *   Stale HTML references stale /assets/*.js hashes. With HTML_TTL_MS
 *   at 30min, that's the maximum window in which a returning visitor
 *   can run old JS after a deploy:
 *     - within 30min of deploy: cached HTML served, old JS served via
 *       cache-first; concurrently background-refreshes HTML for next
 *       visit.
 *     - after 30min: cached HTML is treated as miss, network HTML
 *       fetched and awaited; new asset hashes referenced; new JS
 *       cached as it's loaded.
 *
 *   Old JS files stay in the asset cache after that window but are
 *   never requested again (their URLs are not referenced by any HTML
 *   the SW will serve). They become dead-weight entries that the
 *   browser evicts under quota pressure. We don't eagerly evict
 *   because doing so on every HTML refresh would defeat the warm-
 *   cache win we're optimising for.
 *
 *   To purge everything manually (recovery escape hatch):
 *     navigator.serviceWorker.controller.postMessage('purge-cache');
 *
 * Cache versioning:
 *
 *   Bump CACHE_VERSION to invalidate every prior cache on activation.
 *   Content-hashed assets mean that's rarely necessary, but it's the
 *   only sure escape hatch for a wedged client.
 */
const CACHE_VERSION = 'v2';
const ASSET_CACHE = `pair-assets-${CACHE_VERSION}`;
const HTML_CACHE = `pair-html-${CACHE_VERSION}`;

// Stale HTML is served for this long before we block on the network.
// 30min strikes a balance: long enough that the rapid-revisit case
// (back button, retry, re-pair within the hour) is instant, short
// enough that a post-deploy visitor doesn't run old code for long.
const HTML_TTL_MS = 30 * 60 * 1000;

// Single cache key for HTML — Vite serves the same index.html for
// every route (SPA fallback), so caching per-URL would just duplicate
// the same response under N keys and miss the cross-route warmup
// (e.g. visited / before, scanning a QR to /pair/abc → still warm).
const HTML_CACHE_KEY = new Request(new URL('/', self.location.origin).href);

// Custom response header we stamp on cached HTML to age it out. Not a
// standard header — the SW puts it on, the SW reads it back. Browsers
// don't strip custom response headers from cache entries.
const CACHED_AT_HEADER = 'x-sw-cached-at';

self.addEventListener('install', (event) => {
  // Take over open clients ASAP — without this, the SW only activates
  // for new pages. For a demo where users often hard-refresh once they
  // notice the SW exists, this is the friendlier behaviour.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              (k.startsWith('pair-assets-') && k !== ASSET_CACHE) ||
              (k.startsWith('pair-html-') && k !== HTML_CACHE)
          )
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Escape hatch: postMessage('purge-cache') from any page wipes every
// SW cache. Useful when debugging stuck clients without asking the
// user to clear site data manually.
self.addEventListener('message', (event) => {
  if (event.data !== 'purge-cache') return;
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('pair-')).map((k) => caches.delete(k)));
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin (argus-loader CDN, Google GIS, etc.) — leave to browser.
  if (url.origin !== self.location.origin) return;

  // Escape hatch: any URL with ?fresh=1 (or fresh anywhere) bypasses
  // the cache and wipes all SW caches in the background. Power-user
  // way to unstick a wedged client without DevTools:
  //   https://captcha-dev-jw.argus.pw/?fresh=1
  //   https://captcha-dev-jw.argus.pw/pair/<id>?fresh=1
  // Triggers a fresh fetch + full purge; the user gets clean state
  // and every other tab on this origin reloads via controllerchange.
  if (url.searchParams.get('fresh') === '1') {
    event.respondWith(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith('pair-')).map((k) => caches.delete(k)));
        return fetch(req, { cache: 'reload' });
      })()
    );
    return;
  }

  // Content-hashed bundles: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(req));
    return;
  }

  // HTML navigation: stale-while-revalidate with TTL bound.
  const accept = req.headers.get('accept') || '';
  if (req.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith(staleWhileRevalidateHtml(req));
    return;
  }
  // Anything else (/favicon.svg, /sw.js itself, etc.) falls through to
  // the browser's default network path.
});

async function cacheFirstAsset(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  // Only cache successful responses. 4xx/5xx shouldn't poison cache —
  // those should hit the network every time so the failure is visible
  // if it persists.
  if (resp.ok) {
    cache.put(req, resp.clone()).catch(() => {
      /* quota / no-storage — non-fatal */
    });
  }
  return resp;
}

async function staleWhileRevalidateHtml(req) {
  const cache = await caches.open(HTML_CACHE);
  const cached = await cache.match(HTML_CACHE_KEY);

  // Always kick off a network refresh against the actual navigated URL.
  // CloudFront returns the same index.html for any SPA route, so
  // freshness of any path implies freshness of the canonical entry.
  const networkPromise = fetch(req)
    .then(async (resp) => {
      if (resp.ok) {
        // Re-emit with our cached-at timestamp so we can TTL the entry
        // on subsequent reads. We blob() the body because Response
        // bodies are single-use streams.
        const body = await resp.clone().blob();
        const headers = new Headers(resp.headers);
        headers.set(CACHED_AT_HEADER, Date.now().toString());
        const stamped = new Response(body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
        await cache.put(HTML_CACHE_KEY, stamped).catch(() => {
          /* quota — non-fatal */
        });
      }
      return resp;
    })
    .catch(() => null);

  if (cached) {
    const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER) ?? '0');
    const age = Date.now() - cachedAt;
    // Fresh-enough cache → serve immediately, let network refresh in
    // the background (the promise is intentionally unawaited).
    if (cachedAt > 0 && age < HTML_TTL_MS) {
      networkPromise.catch(() => {});
      return cached;
    }
  }

  // Cache miss or TTL exceeded → block on the network. Fall back to
  // the stale cached copy only if the network outright failed (offline)
  // — better stale than blank.
  const fresh = await networkPromise;
  if (fresh) return fresh;
  if (cached) return cached;
  return new Response('Offline and no cached HTML available', { status: 504 });
}
