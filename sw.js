// Service Worker for 睡眠トラッカー PWA
const CACHE_NAME = 'sleep-tracker-v14';

// self.registration.scope を使って GitHub Pages のサブパスに対応
const SCOPE = self.registration.scope;
const ASSETS = [
  SCOPE,
  `${SCOPE}index.html`,
  `${SCOPE}manifest.json`,
  `${SCOPE}css/style.css`,
  `${SCOPE}js/app.js`,
  `${SCOPE}icons/icon-192.png`,
  `${SCOPE}icons/icon-512.png`,
  `${SCOPE}icons/icon-180.png`,
];

// Install: cache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first strategy (offline support)
self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests
  if (
    event.request.method !== 'GET' ||
    !event.request.url.startsWith(self.location.origin)
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Cache successful responses
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // For navigation requests, return the cached index.html
          if (event.request.mode === 'navigate') {
            return caches.match(`${SCOPE}index.html`);
          }
        });
    })
  );
});
