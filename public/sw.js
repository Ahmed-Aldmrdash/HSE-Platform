self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'منصة السلامة والصحة المهنية';
  const options = {
    body: data.body || 'إشعار جديد في المنصة',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [200, 100, 200],
    data: { url: data.link || data.actionUrl || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const targetUrl = event.notification.data.url || '/';
      // Check if there is already a window/tab open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
