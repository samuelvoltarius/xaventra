// Service Worker for Push Notifications
// This runs in the background and handles push events

self.addEventListener('install', (event) => {
    console.log('Service Worker installed');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activated');
    event.waitUntil(self.clients.claim());
});

// Handle push notifications
self.addEventListener('push', (event) => {
    console.log('Push received:', event);

    let data = {
        title: 'Clawdbot',
        body: 'New notification',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'clawdbot-notification',
    };

    try {
        if (event.data) {
            data = { ...data, ...event.data.json() };
        }
    } catch (e) {
        console.error('Error parsing push data:', e);
    }

    const options = {
        body: data.body,
        icon: data.icon,
        badge: data.badge,
        tag: data.tag,
        vibrate: [200, 100, 200],
        data: data,
        actions: [
            { action: 'view', title: '👁️ View' },
            { action: 'dismiss', title: '✕ Dismiss' },
        ],
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
    console.log('Notification clicked:', event);
    event.notification.close();

    if (event.action === 'dismiss') {
        return;
    }

    // Open the app
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then((clientList) => {
            // If app is already open, focus it
            for (const client of clientList) {
                if (client.url.includes('/') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open new window
            if (self.clients.openWindow) {
                return self.clients.openWindow('/');
            }
        })
    );
});
