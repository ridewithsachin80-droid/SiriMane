// sw-guest.js — service worker for the resident portal only.
//
// DELIBERATE RULE: this caches the app SHELL (page, logo, fonts) so the portal
// opens instantly on patchy 4G. It NEVER caches anything under /api/. Dues,
// ledgers and payment status must always be live — a stale ₹ figure shown to a
// resident is worse than a spinner.
const SHELL_CACHE = 'sirimane-guest-shell-v2';
const SHELL = ['/guest', '/guest.html', '/images/logo.png', '/images/icon-192.png', '/images/icon-512.png', '/manifest-guest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll fails the whole install if any one URL 404s, so add them
      // individually and tolerate misses.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never touch the API — always straight to the network.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first so a deployed update is picked up immediately;
  // fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put('/guest.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/guest.html').then(r => r || caches.match('/guest')))
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(req).then(hit => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
