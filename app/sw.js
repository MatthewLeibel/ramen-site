// RAMen in the browser: works offline. The app's own files are kept in a cache (the model and the chats are in the
// browser's private file system, written by worker.js). A new version replaces the old cache on its first start.
const VERSION = 'ramen-web-1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'worker.js', 'ramen.js', 'ramen.wasm', 'manifest.webmanifest',
  'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;   // the model download goes straight out
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then((hit) => hit || fetch(e.request).catch(() =>
      e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
