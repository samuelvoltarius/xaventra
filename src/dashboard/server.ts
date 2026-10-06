/**
 * Xaventra im Browser – derselbe Weg wie die Desktop-App.
 *
 * Es gibt EINE Oberfläche: desktop/renderer (index.html, bridge.js, app.js, werkzeugkasten.js,
 * styles.css). Electron lädt sie aus dem Paket und spricht über preload/IPC;
 * dieser Server liefert dieselben Dateien über HTTP aus, und bridge.js ersetzt
 * dort die IPC durch fetch mit dem Desktop-Token als Bearer. Daten gibt es
 * nur über die Desktop-API (/api/desktop/*); eine zweite Dashboard-API mit
 * eigenen Seiten gibt es nicht mehr (2.83: die alte Vanilla-Seite unter
 * src/dashboard/public und ihre ~70 Sonder-Endpunkte sind entfernt).
 *
 * Sicherheitsregeln (unverändert):
 * - Bindung nur an dashboard.host (Standard 127.0.0.1), ein Port, kein Ausweichen.
 * - H-1: unbekannter Host (DNS-Rebinding) oder fremder Origin → 403, vor allem anderen.
 * - C-1/H-2: jede API braucht ein Token. Mit NOVA_DESKTOP_API_TOKEN prüft die
 *   Desktop-API selbst (Bearer = Owner); ohne es gilt das Gateway-Token
 *   (.nova-gateway-token) und die Desktop-API bleibt im Nicht-Owner-Modus.
 * - Die Seitendateien enthalten keine Daten und kein Token; sie sind ohne
 *   Token ladbar, alles Weitere nicht.
 */

import express from 'express'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dashboardAddress, listenDashboard } from './listener.js'
import { dashboardTokenFromHeaders, isAllowedDashboardHost, isSameOriginRequest, isValidDashboardToken } from './access-guard.js'
import { getGatewayAuth } from '../infra/gateway-auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The one UI. Built copy (dist/dashboard/public) first, the source tree as fallback. */
export const UI_FILES: Readonly<Record<string, string>> = Object.freeze({
    'index.html': 'text/html; charset=utf-8',
    'bridge.js': 'text/javascript; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'werkzeugkasten.js': 'text/javascript; charset=utf-8',
    'onboarding.js': 'text/javascript; charset=utf-8',
    'connections.js': 'text/javascript; charset=utf-8',
    'cockpit.js': 'text/javascript; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
    // 2.86 Paket O: Anrufen + installierbare Web-App (Handy über das Tailnet).
    'anruf.js': 'text/javascript; charset=utf-8',
    'anruf-worklet.js': 'text/javascript; charset=utf-8',
    'pwa.js': 'text/javascript; charset=utf-8',
    'sw.js': 'text/javascript; charset=utf-8',
    'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    'icon-192.png': 'image/png',
    'icon-512.png': 'image/png',
    'apple-touch-icon.png': 'image/png',
})
export function resolveUiDir(base = __dirname): string | null {
    for (const dir of [join(base, 'public'), resolve(base, '..', '..', 'desktop', 'renderer')]) {
        // Bild-Dateien (Web-App-Icons) sind Beiwerk: fehlen sie (z. B. Reparatur-Sandbox ohne Binärdateien), gibt es dafür 404.
        if (Object.keys(UI_FILES).filter(name => !name.endsWith('.png')).every(name => existsSync(join(dir, name)))) return dir
    }
    return null
}

export const UI_CSP = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
    "manifest-src 'self'", "worker-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ')

const app = express()
const server = createServer(app)

/** Gateway token (infra/gateway-auth.ts, 0600). Without a readable token no API answers (fail-closed). */
function dashboardToken(): string {
    try { return getGatewayAuth().token || '' } catch { return '' }
}
function hasDashboardToken(headers: import('node:http').IncomingHttpHeaders): boolean {
    return isValidDashboardToken(dashboardTokenFromHeaders(headers as Record<string, string | string[] | undefined>), dashboardToken())
}
/** Concrete bind host from startDashboard (wildcards add nothing); loopback names are always allowed. */
const dashboardConfiguredHosts = new Set<string>()

app.disable('x-powered-by')

// H-1: DNS rebinding and cross-origin requests are refused before anything else.
app.use((req, res, next) => {
    if (!isAllowedDashboardHost(req.headers.host, dashboardConfiguredHosts)) {
        console.warn(`[Dashboard] Blocked ${req.method} ${req.path}: unknown Host ${req.headers.host || '-'}`)
        return void res.status(403).json({ error: 'Forbidden: unknown Host' })
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (!isSameOriginRequest(req.headers.host, origin)) {
        console.warn(`[Dashboard] Blocked ${req.method} ${req.path}: foreign Origin ${origin}`)
        return void res.status(403).json({ error: 'Forbidden: foreign Origin' })
    }
    next()
})

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // 2.86 Paket O: Mikrofon nur für die eigene Seite („Anrufen“); Kamera und Ort bleiben aus.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
    res.setHeader('Cache-Control', 'no-store')
    next()
})

// C-1/H-2: every API route needs a token (see header comment).
app.use('/api', (req, res, next) => {
    const desktop = req.path === '/desktop' || req.path.startsWith('/desktop/')
    if (desktop && process.env.NOVA_DESKTOP_API_TOKEN) return next()
    if (hasDashboardToken(req.headers)) return next()
    res.status(401).json({ error: 'Dashboard token required' })
})
app.use(express.json({ limit: '256kb' }))

// Message handler of the real pipeline (wired by daemon-channels).
let novaMessageHandler: ((message: string, channel: string) => Promise<string>) | null = null
export function setNovaMessageHandler(handler: (message: string, channel: string) => Promise<string>): void {
    novaMessageHandler = handler
}
const { registerDesktopApi } = await import('../desktop/desktop-api.js')
registerDesktopApi(app, () => novaMessageHandler)

app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route' }) })

// 2.85 Paket A: browser return of a connection login (OAuth / Home Assistant). Not under /api:
// the browser arrives here from the service; the single-use `state` is the proof, never a token.
app.get('/verbindungen/rueckkehr', async (req, res) => {
    try {
        const { handleLoginReturn } = await import('../connections/login-return.js')
        const page = await handleLoginReturn(req.query as Record<string, unknown>)
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        res.status(page.status).type('text/html; charset=utf-8').send(page.html)
    } catch { res.status(500).type('text/plain; charset=utf-8').send('Anmeldung konnte nicht abgeschlossen werden.') }
})

// The one UI. An old bookmark with ?token= never leaves the token in the
// address bar: redirect to the bare page (the token is typed into the UI).
app.get(['/', '/index.html', ...Object.keys(UI_FILES).map(name => `/${name}`)], (req, res) => {
    if (typeof req.query.token === 'string') return void res.redirect(303, '/')
    const name = req.path === '/' ? 'index.html' : req.path.slice(1)
    const dir = resolveUiDir()
    if (!dir || !UI_FILES[name]) return void res.status(503).type('text/plain; charset=utf-8').send('Xaventra: Oberfläche nicht gebaut (npm run build).')
    if (!existsSync(join(dir, name))) return void res.status(404).type('text/plain; charset=utf-8').send('Nicht gefunden.')
    res.setHeader('Content-Type', UI_FILES[name])
    if (name === 'index.html') res.setHeader('Content-Security-Policy', UI_CSP)
    res.send(readFileSync(join(dir, name)))
})
app.use((_req, res) => { res.status(404).type('text/plain; charset=utf-8').send('Nicht gefunden.') })

// 2.86 Paket O: „Anrufen“ — WebSocket mit Einmal-Ticket (gleiche Host-/Origin-Regeln wie oben).
server.on('upgrade', (req, socket, head) => {
    void import('../desktop/voice-api.js').then(({ handleVoiceUpgrade }) => handleVoiceUpgrade(req, socket, head, {
        allowedHost: host => isAllowedDashboardHost(host, dashboardConfiguredHosts),
        sameOrigin: isSameOriginRequest,
        resolveHandler: () => novaMessageHandler,
    })).then(handled => { if (!handled) socket.destroy() }).catch(() => socket.destroy())
})

// ============================================
// Start / Stop
// ============================================

let dashboardStarted = false
let dashboardPort = 3011
let dashboardUrl = ''

export function getDashboardAddress(): string | null { return dashboardAddress(server) }

/** Zusätzliche Host-Namen, unter denen die Seite erreichbar sein darf (genaue Namen, keine Muster). */
export function dashboardPublicHosts(configured: readonly string[] = [], env = process.env.XAVENTRA_DASHBOARD_HOSTS): string[] {
    const names = [...configured, ...String(env || '').split(',')].map(name => String(name || '').trim().toLowerCase())
    return [...new Set(names.filter(name => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(name)))]
}

export async function startDashboard(port: number = 3011, host: string = '127.0.0.1', publicHosts: readonly string[] = []): Promise<string> {
    if (dashboardStarted) return dashboardUrl
    const bindHost = String(host || '').trim().toLowerCase()
    if (bindHost && !['0.0.0.0', '::', '[::]'].includes(bindHost)) dashboardConfiguredHosts.add(bindHost)
    // 2.86 Paket O: Handy über das Tailnet (`tailscale serve` → https://<name>.ts.net). Nur ausdrücklich
    // eingetragene Namen (dashboard.publicHosts bzw. XAVENTRA_DASHBOARD_HOSTS), nie ein Platzhalter.
    for (const name of dashboardPublicHosts(publicHosts)) dashboardConfiguredHosts.add(name)
    if (!resolveUiDir()) console.warn('[Dashboard] Oberfläche fehlt (dist/dashboard/public) — npm run build ausführen')
    if (!dashboardToken() && !process.env.NOVA_DESKTOP_API_TOKEN) console.warn('[Dashboard] Kein Token lesbar: die API bleibt gesperrt')
    dashboardUrl = await listenDashboard(server, port, host)
    dashboardStarted = true
    dashboardPort = Number(new URL(dashboardUrl).port)
    // 2.86 Paket N: a login return address another browser can reach (only when the listener is not loopback).
    try { const { noteDashboardAddress } = await import('../connections/connect-flow.js'); noteDashboardAddress(dashboardUrl) } catch { /* optional */ }
    console.log(`\n✨ Xaventra im Browser: ${dashboardUrl}  (Desktop-Token in den Einstellungen der Seite eintragen)\n`)
    return dashboardUrl
}

export async function stopDashboard(): Promise<void> {
    if (!dashboardStarted) return
    server.closeAllConnections?.()
    await new Promise<void>((resolveStop, reject) => server.close(error => error ? reject(error) : resolveStop()))
    dashboardStarted = false
    console.log(`[Dashboard] Stopped port ${dashboardPort} after leadership loss`)
}

/** Test hook: the Express app without listening. */
export function dashboardApp(): express.Express { return app }

export default { startDashboard, stopDashboard, setNovaMessageHandler, getDashboardAddress }
