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

  // Serve icon directly from cache to prevent network request on every notification
  if (url.pathname.includes('icon-192.png')) {
    event.respondWith(
      caches.match(event.request).then((response) => response || fetch(event.request))
    );
    return;
  }

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

// ── Web Push Event Listeners ─────────────────────────────────────
self.addEventListener('push', function(event) {
  if (event.data) {
    try {
      const data = event.data.json();
      const title = data.title || 'تنبيه جديد';
      const options = {
        body: data.body || 'لديك إشعار جديد',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: {
          url: data.link ? '/?link=' + data.link + '&targetId=' + (data.targetId || '') : '/',
          type: data.type
        }
      };

      event.waitUntil(self.registration.showNotification(title, options));
    } catch (err) {
      console.error('[SW] Error parsing push data:', err);
    }
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const targetUrl = event.notification.data.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If a window is already open, focus it and navigate
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus().then(() => client.navigate(targetUrl));
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
