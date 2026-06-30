// sw.js. OpenBook service worker.
//
// Intentionally minimal. It exists so OpenBook is installable as a PWA (an app on
// the home screen), but it deliberately does NOT cache app code or API responses.
// That means a deploy is never served stale and your session is never cached: every
// request passes straight through to the network exactly as without a worker.
//
// skipWaiting + clients.claim mean a new worker takes over immediately on the next
// load, so we are never stuck on an old worker. If we ever want real offline support
// we can add a careful network-first cache here later.
//
// TO REMOVE THE PWA LATER: do NOT just delete this file (a 404 does not unregister an
// already-installed worker). Instead ship a version of this file whose activate calls
// self.registration.unregister(), keep it deployed for one update cycle, then delete
// the file. This file is served with Cache-Control: no-cache (see server.js) so that
// replacement reaches installed clients quickly.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop any caches a previous version of this worker might have created, then claim
  // open pages so this no-cache worker is in control everywhere right away.
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* caches API may be unavailable; ignore */ }
    await self.clients.claim();
  })());
});

// A fetch handler must exist for installability, but we do not call respondWith, so
// the browser handles every request normally (network, with no SW caching).
self.addEventListener('fetch', () => { /* network passthrough, no caching */ });
