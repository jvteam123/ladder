// Micro Ladder — minimal service worker
// Purpose: satisfies Chrome/Android's PWA installability requirement for a
// registered service worker with a fetch handler, so the native
// "beforeinstallprompt" install banner/button is offered on Android.
// This is intentionally a thin pass-through cache (app-shell only);
// it does not attempt full offline support of dynamic content.

const CACHE_NAME = 'micro-ladder-v1';
const APP_SHELL = ['./matchmaker.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first, falling back to cache (so updates are picked up immediately
// when online, but the app still loads if offline).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
