// Xaventra als Web-App (2.86 Paket O, „Handy zuerst“).
// Regeln: NUR die statischen Seitendateien werden zwischengespeichert, damit die
// App auch bei schlechtem Netz startet. API-Antworten, Anmelde-Rückkehr, Anfragen
// mit Token und alles außer GET auf dem eigenen Ursprung fasst dieser Worker nie
// an – die gehen immer direkt ans Netz und landen in keinem Cache.
'use strict'
// v5 (2.88): dazu zugaenge.js (Verbindungen → Proxmox, Passwort-Tresor) und sehen.js (Dein Computer, Aktivität, Regeln).
// v3 (2.87): telefon.js. Dieselbe Liste wie DASHBOARD_UI_FILES in src/dev/copy-dashboard-assets.ts (ohne sw.js selbst, Test pwa.test.ts).
const CACHE = 'xaventra-ui-v5'
const STATIC = Object.freeze([
  '/', '/index.html', '/bridge.js', '/pwa.js', '/werkzeugkasten.js', '/onboarding.js', '/telefon.js', '/zugaenge.js', '/connections.js', '/cockpit.js', '/sehen.js', '/anruf.js', '/anruf-worklet.js', '/app.js',
  '/styles.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
])

function isStatic(request) {
  if (request.method !== 'GET') return false
  if (request.headers && (request.headers.get('authorization') || request.headers.get('x-nova-dashboard-token'))) return false
  let url
  try { url = new URL(request.url) } catch { return false }
  if (url.origin !== self.location.origin || url.search) return false
  return STATIC.includes(url.pathname)
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})

// Netz zuerst (Updates kommen sofort an), Cache nur als Rückfall ohne Netz.
self.addEventListener('fetch', event => {
  const request = event.request
  if (!isStatic(request)) return
  event.respondWith(fetch(request)
    .then(response => {
      if (response && response.ok) {
        const copy = response.clone()
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => undefined)
      }
      return response
    })
    .catch(() => caches.match(request).then(hit => hit || caches.match('/'))))
})
