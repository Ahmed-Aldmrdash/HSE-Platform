// Service worker — Work Permits PWA  v2.3.2
// Strategy: Network-first for app shell (JS/CSS/HTML) so updates land instantly.
// API calls always bypass the SW entirely.
// skipWaiting + clients.claim = zero wait for new SW to take control.

const CACHE_NAME  = 'work-permits-shell-v2.3.2';
const APP_SHELL   = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// ── Install: cache the shell, then immediately activate ──────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn('[SW] install cache error:', err))
  );
  self.skipWaiting(); // don't wait for old SW to finish — take control immediately
});

// ── Activate: delete ALL old caches, claim open tabs instantly ───────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => {
          console.log('[SW] deleting old cache:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim(); // take control of all open pages without reload
});

// ── Fetch: Network-first for app shell, bypass for API ───────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — permit data must always be live
  if (url.pathname.startsWith('/api/')) return;

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    // Network-first: always try the network so updated JS/CSS loads immediately
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        // Offline fallback: serve from cache if network fails
        caches.match(event.request)
      )
  );
});

// ── SKIP_WAITING message: allow app.js to force immediate activation ─────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
