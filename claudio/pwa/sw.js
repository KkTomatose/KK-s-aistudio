// sw.js — Service Worker for Claudio FM PWA
const CACHE_NAME = 'claudio-v4';
const PRE_CACHE = ['/pwa/index.html', '/pwa/app.js'];

// Install: pre-cache shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRE_CACHE).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for /tts/*.mp3, network-first for others
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache-first for TTS audio
  if (url.pathname.startsWith('/tts/') && url.pathname.endsWith('.mp3')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first for app shell
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Message: pre-fetch a URL (from app.js for next song)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'PREFETCH' && event.data?.url) {
    caches.open(CACHE_NAME).then(cache => {
      fetch(event.data.url).then(res => {
        if (res.status === 200) {
          cache.put(event.data.url, res);
        }
      }).catch(() => {});
    });
    return;
  }

  if (event.data?.type === 'DELETE_CACHE' && event.data?.url) {
    caches.open(CACHE_NAME).then(cache => {
      cache.delete(event.data.url).catch(() => {});
    });
  }
});
