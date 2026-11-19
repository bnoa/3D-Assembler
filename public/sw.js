// Service worker of the installed app: works offline once opened.
// Pages: network first (new versions show up at once), the cached copy when offline.
// Other same-origin files (scripts, styles, WASM, icons; their names carry a content hash):
// cache first, filled as they are used, and refreshed in the background.
const CACHE = 'assembler-v3';
const ROOT = new URL('./', self.location).href; // the folder of the app
const SHELL = [ROOT, ROOT + 'manifest.webmanifest', ROOT + 'icons/icon-192.png', ROOT + 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Only the app's own page becomes the offline copy (not an error page of another address).
          if (res.ok && (url.href === ROOT || url.href === ROOT + 'index.html')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(ROOT, copy)); }
          return res;
        })
        .catch(() => caches.match(ROOT)),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    }),
  );
});
