/* eslint-disable no-undef */
/**
 * Retired root-scope service worker.
 *
 * Kept only so browsers that previously installed /sw.js can update to this
 * no-op worker and unregister. New desktop pages do not register any SW.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })()
  );
});
