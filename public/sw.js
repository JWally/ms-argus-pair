/* eslint-disable no-undef */
/**
 * Self-uninstalling service worker.
 *
 * The previous SW cached assets + HTML for fast returning-visit paints,
 * but a stale-bundle window on top of Safari + an in-flight argus scan
 * produced enough "why did this hang?" reports to retire the whole
 * mechanism. See main.tsx for the rationale.
 *
 * This file exists solely so that browsers which still have the old
 * worker registered fetch a NEW worker (this one), activate it, and
 * watch it unregister itself + delete every cache it created.
 *
 * Keep this file in place for at least one HTML_TTL_MS window
 * (~24h after the previous SW shipped) and ideally indefinitely —
 * any client that hasn't visited in that window still has the old
 * SW until it fetches /sw.js again. Deleting this file would 404
 * the update probe and orphan those clients on the old code path.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('pair-')).map((k) => caches.delete(k))
      );
      // Unregister, then leave the client alone. With no fetch handler
      // on this worker, network requests already fall through to the
      // browser starting NOW; the actual deregistration completes when
      // there are no controlled clients left (i.e. on next navigation).
      // We deliberately do NOT force a reload — the previous build's
      // controllerchange-driven reload was the source of Safari's
      // "page reloads after validate" misbehaviour.
      await self.registration.unregister().catch(() => {});
    })()
  );
});

// No fetch handler. All requests fall through to the network.
