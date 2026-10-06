// Web-App-Anmeldung (2.86 Paket O): nur im Browser (Handy/Tailnet), nie in der
// Desktop-App. Service-Worker gehen nur über HTTPS (z. B. tailscale serve) oder localhost.
;(() => {
  const desktop = window.novaDesktop
  if (!desktop || desktop.web !== true) return
  if (!window.isSecureContext || !navigator.serviceWorker) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => console.warn('Web-App:', error && error.message))
  })
})()
