/**
 * /desktop – Direktverbindung: HTTP + WebSocket gateway on the Main.
 *
 * Own listener (default 127.0.0.1:18793) instead of the dashboard: the
 * dashboard only serves loopback Host names with the dashboard token, the
 * gateway serves the tailnet host name from `tailscale serve` with a
 * one-time link. Keeping them apart means neither weakens the other.
 *
 *   GET  /desktop/s/<token>      checks the link (does not consume it) and
 *                                 auto-submits a POST — link-preview bots and
 *                                 prefetchers that only GET never burn a link
 *   POST /desktop/s/<token>      consumes the link, returns the noVNC page
 *                                 with a session id (one WebSocket, 60 s)
 *   GET  /desktop/novnc/<file>   noVNC client files from `novncDir`
 *   WS   /desktop/ws/<session>   RFB proxy to the configured target; the
 *                                 gateway does the VNC-Auth itself
 *
 * Every request must come from loopback (tailscale serve) or 100.64.0.0/10
 * (tailnet), otherwise 403.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { connect as netConnect, type Socket } from 'node:net'
import { dirname, extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { isLoopbackAddress, isSameOriginRequest } from '../dashboard/access-guard.js'
import type { DesktopDirectConfig, DesktopMode } from './config.js'
import { ByteQueue, clientHandshake, RfbClientFilter, upstreamHandshake } from './rfb.js'
import { MODE_TEXT, type DesktopDirectStore, type DesktopSession } from './store.js'

const LINK_PATH = /^\/desktop\/s\/([A-Za-z0-9_-]{1,128})$/
const WS_PATH = /^\/desktop\/ws\/([A-Za-z0-9_-]{1,128})$/
const NOVNC_PREFIX = '/desktop/novnc/'
const MAX_WS_PAYLOAD = 8 * 1024 * 1024
const FAILED_LIMIT_PER_MINUTE = 30

const STATIC_TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

/** Loopback (tailscale serve on the Main) or the Tailscale CGNAT range 100.64.0.0/10. */
export function isAllowedDesktopSource(address: string | undefined | null): boolean {
    if (isLoopbackAddress(address)) return true
    const raw = String(address || '').trim().toLowerCase()
    const v4 = raw.startsWith('::ffff:') ? raw.slice(7) : raw
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
    if (!match || match.slice(1).some(part => Number(part) > 255)) return false
    return Number(match[1]) === 100 && Number(match[2]) >= 64 && Number(match[2]) <= 127
}

/** Directory with `core/rfb.js`: configured, Debian/Ubuntu package, or an installed @novnc/novnc. */
export function resolveNovncDir(configured?: string): string | null {
    const candidates: string[] = []
    if (configured) candidates.push(resolve(configured))
    else {
        candidates.push('/usr/share/novnc')
        try { candidates.push(dirname(createRequire(import.meta.url).resolve('@novnc/novnc/package.json'))) } catch { /* not installed */ }
    }
    for (const dir of candidates) {
        try { if (statSync(join(dir, 'core', 'rfb.js')).isFile()) return realpathSync(dir) } catch { /* next */ }
    }
    return null
}

/**
 * Read the VNC password for the upstream handshake. Refuses symlinks and
 * group/other-readable files on POSIX. Errors never contain the content.
 */
export function readVncPassword(file: string | undefined): Buffer | null {
    if (!file) return null
    let stat
    try { stat = lstatSync(file) } catch { throw new Error('Passwortdatei nicht lesbar') }
    if (!stat.isFile()) throw new Error('Passwortdatei ist keine reguläre Datei')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Passwortdatei hat zu offene Rechte (0600 nötig)')
    const raw = readFileSync(file)
    let end = raw.length
    while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--
    const password = Buffer.from(raw.subarray(0, end))
    raw.fill(0)
    if (password.length === 0) throw new Error('Passwortdatei ist leer')
    return password
}

interface Upstream {
    write(data: Buffer): void
    close(): void
}

function connectUpstream(target: string, onData: (data: Buffer) => void, onEnd: (reason: string) => void): Promise<Upstream> {
    const url = new URL(target)
    return new Promise((resolvePromise, reject) => {
        let settled = false
        const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)) } else onEnd(reason) }
        if (url.protocol === 'tcp:') {
            const socket: Socket = netConnect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) })
            socket.setNoDelay(true)
            socket.setTimeout(10_000, () => { if (!settled) socket.destroy(new Error('timeout')) })
            socket.on('data', onData)
            socket.on('error', () => fail('Desktop nicht erreichbar'))
            socket.on('close', () => fail('Desktop hat die Verbindung beendet'))
            socket.once('connect', () => {
                settled = true
                socket.setTimeout(0)
                resolvePromise({ write: data => { socket.write(data) }, close: () => socket.destroy() })
            })
            return
        }
        const ws = new WebSocket(target, ['binary'], { perMessageDeflate: false, handshakeTimeout: 10_000, maxPayload: MAX_WS_PAYLOAD })
        ws.binaryType = 'nodebuffer'
        ws.on('message', (data: Buffer, isBinary: boolean) => { if (isBinary !== false) onData(Buffer.isBuffer(data) ? data : Buffer.from(data as any)) })
        ws.on('error', () => fail('Desktop nicht erreichbar'))
        ws.on('close', () => fail('Desktop hat die Verbindung beendet'))
        ws.once('open', () => {
            settled = true
            resolvePromise({ write: data => { if (ws.readyState === WebSocket.OPEN) ws.send(data) }, close: () => ws.terminate() })
        })
    })
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function securityHeaders(res: ServerResponse, nonce?: string): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', [
        "default-src 'none'", `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`, "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
    ].join('; '))
}

function page(res: ServerResponse, status: number, title: string, body: string, nonce?: string): void {
    securityHeaders(res, nonce)
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>`
        + '<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:15px system-ui,sans-serif}main{padding:24px;max-width:560px}button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #666;background:#2a2a2a;color:#eee}'
        + '#bar{display:flex;gap:12px;align-items:center;padding:6px 10px;background:#1d1d1d;border-bottom:1px solid #333;flex-wrap:wrap}#bar b{font-weight:600}.badge{padding:2px 8px;border-radius:10px;background:#334}.control{background:#633}#screen{position:absolute;top:44px;left:0;right:0;bottom:0}</style>'
        + `</head><body>${body}</body></html>`)
}

function textPage(res: ServerResponse, status: number, text: string): void {
    page(res, status, 'Xaventra Desktop', `<main><h1>Xaventra Desktop</h1><p>${escapeHtml(text)}</p></main>`)
}

function viewerPage(res: ServerResponse, session: DesktopSession, sessionId: string, sessionMaxMs: number): void {
    const nonce = randomBytes(16).toString('base64')
    const mode: DesktopMode = session.mode
    const action = mode === 'control' ? 'Zurückgeben' : 'Trennen'
    const body = `<div id="bar"><b>${escapeHtml(session.desktop.label)}</b><span class="badge${mode === 'control' ? ' control' : ''}">${MODE_TEXT[mode]}</span>`
        + `<span id="status">Verbinde …</span><span id="left"></span><button id="end" type="button">${action}</button></div>`
        + `<div id="screen" data-session="${escapeHtml(sessionId)}" data-mode="${mode}" data-max="${Math.round(sessionMaxMs / 1000)}"></div>`
        + `<script type="module" nonce="${nonce}">
import RFB from '../novnc/core/rfb.js'
const screen = document.getElementById('screen')
const status = document.getElementById('status')
const url = new URL('../ws/' + screen.dataset.session, location.href)
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
screen.removeAttribute('data-session')
const rfb = new RFB(screen, url.href, { shared: true })
rfb.viewOnly = screen.dataset.mode !== 'control'
rfb.scaleViewport = true
rfb.resizeSession = false
rfb.addEventListener('connect', () => { status.textContent = 'Verbunden' })
rfb.addEventListener('disconnect', () => { status.textContent = 'Sitzung beendet — neuer Link über /desktop'; document.getElementById('end').disabled = true })
document.getElementById('end').addEventListener('click', () => rfb.disconnect())
let left = Number(screen.dataset.max)
setInterval(() => { left = Math.max(0, left - 1); document.getElementById('left').textContent = 'noch ' + Math.floor(left / 60) + ' min' }, 1000)
</script>`
    page(res, 200, `${session.desktop.label} – ${MODE_TEXT[mode]}`, body, nonce)
}

export interface DesktopGateway {
    server: Server
    address: string
    close(): Promise<void>
}

export interface GatewayOptions {
    /** Override for tests (noVNC directory). */
    novncDir?: string | null
    log?: (line: string) => void
}

export function createDesktopGateway(config: DesktopDirectConfig, store: DesktopDirectStore, options: GatewayOptions = {}): Server {
    const log = options.log || ((line: string) => console.warn(line))
    const novncDir = options.novncDir !== undefined ? options.novncDir : resolveNovncDir(config.novncDir)
    const failures = new Map<string, { minute: number; count: number }>()
    const tooManyFailures = (ip: string) => {
        const minute = Math.floor(Date.now() / 60_000)
        const entry = failures.get(ip)
        return Boolean(entry && entry.minute === minute && entry.count >= FAILED_LIMIT_PER_MINUTE)
    }
    const noteFailure = (ip: string) => {
        const minute = Math.floor(Date.now() / 60_000)
        const entry = failures.get(ip)
        failures.set(ip, entry && entry.minute === minute ? { minute, count: entry.count + 1 } : { minute, count: 1 })
        if (failures.size > 500) failures.clear()
    }

    const wss = new WebSocketServer({
        noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false,
        handleProtocols: protocols => (protocols.has('binary') ? 'binary' : false),
    })

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const ip = req.socket.remoteAddress || ''
        const path = (() => { try { return new URL(req.url || '/', 'http://gateway.invalid').pathname } catch { return '' } })()
        if (!isAllowedDesktopSource(ip)) {
            store.audit('abgelehnt', { reason: 'fremde-ip', sourceIp: ip.replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) })
            return textPage(res, 403, 'Nur aus dem Tailnet erreichbar.')
        }
        if (path.startsWith(NOVNC_PREFIX) && req.method === 'GET') return serveNovnc(path.slice(NOVNC_PREFIX.length), res)
        const link = LINK_PATH.exec(path)
        if (!link) return textPage(res, 404, 'Nicht gefunden.')
        if (tooManyFailures(ip)) return textPage(res, 429, 'Zu viele ungültige Versuche — bitte kurz warten.')
        const token = link[1]
        if (req.method === 'GET') {
            const code = store.checkLink(token)
            if (code !== 'ok') { noteFailure(ip); return textPage(res, 410, 'Link ungültig, abgelaufen oder bereits benutzt. Neuer Link über /desktop in Telegram.') }
            if (!novncDir) return textPage(res, 503, 'Der noVNC-Client ist auf dem Main nicht bereitgestellt (siehe docs/DESKTOP_DIRECT.md). Der Link bleibt gültig.')
            const nonce = randomBytes(16).toString('base64')
            // Auto-submit: a browser connects with one tap, a GET-only prefetcher never consumes the link.
            return page(res, 200, 'Xaventra Desktop', '<main><h1>Xaventra Desktop</h1><form id="go" method="post" action=""><button type="submit">Verbinden</button></form></main>'
                + `<script nonce="${nonce}">document.getElementById('go').submit()</script>`, nonce)
        }
        if (req.method === 'POST') {
            if (!isSameOriginRequest(req.headers.host, typeof req.headers.origin === 'string' ? req.headers.origin : undefined)) {
                noteFailure(ip)
                return textPage(res, 403, 'Fremder Ursprung.')
            }
            if (!novncDir) return textPage(res, 503, 'Der noVNC-Client ist auf dem Main nicht bereitgestellt (siehe docs/DESKTOP_DIRECT.md). Der Link bleibt gültig.')
            req.resume()
            const result = store.redeemLink(token, ip)
            if (result.code !== 'ok' || !result.session || !result.sessionId) { noteFailure(ip); return textPage(res, 410, 'Link ungültig, abgelaufen oder bereits benutzt. Neuer Link über /desktop in Telegram.') }
            return viewerPage(res, result.session, result.sessionId, config.sessionMaxMs)
        }
        securityHeaders(res)
        res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Methode nicht erlaubt')
    })

    function serveNovnc(rel: string, res: ServerResponse): void {
        if (!novncDir) return textPage(res, 404, 'noVNC nicht bereitgestellt.')
        let decoded = ''
        try { decoded = decodeURIComponent(rel) } catch { return textPage(res, 400, 'Ungültiger Pfad.') }
        if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part === '' || part.startsWith('.'))) return textPage(res, 400, 'Ungültiger Pfad.')
        const type = STATIC_TYPES[extname(decoded).toLowerCase()]
        if (!type) return textPage(res, 404, 'Nicht gefunden.')
        const file = resolve(novncDir, decoded)
        if (!file.startsWith(novncDir + sep)) return textPage(res, 400, 'Ungültiger Pfad.')
        try {
            if (!existsSync(file) || !statSync(file).isFile() || !realpathSync(file).startsWith(novncDir + sep)) return textPage(res, 404, 'Nicht gefunden.')
            securityHeaders(res)
            res.setHeader('Cache-Control', 'private, max-age=3600')
            res.writeHead(200, { 'Content-Type': type })
            res.end(readFileSync(file))
        } catch { textPage(res, 404, 'Nicht gefunden.') }
    }

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const ip = req.socket.remoteAddress || ''
        const reject = (status: number, text: string) => {
            socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
            socket.destroy()
        }
        if (!isAllowedDesktopSource(ip)) {
            store.audit('abgelehnt', { reason: 'fremde-ip', sourceIp: ip.replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) })
            return reject(403, 'Forbidden')
        }
        const path = (() => { try { return new URL(req.url || '/', 'http://gateway.invalid').pathname } catch { return '' } })()
        const match = WS_PATH.exec(path)
        if (!match) return reject(404, 'Not Found')
        if (!isSameOriginRequest(req.headers.host, typeof req.headers.origin === 'string' ? req.headers.origin : undefined)) return reject(403, 'Forbidden')
        if (tooManyFailures(ip)) return reject(429, 'Too Many Requests')
        const session = store.claimSession(match[1])
        if (!session) { noteFailure(ip); return reject(410, 'Gone') }
        wss.handleUpgrade(req, socket, head, ws => { void runSession(ws, session) })
    })

    async function runSession(ws: WebSocket, session: DesktopSession): Promise<void> {
        let streaming = false
        let upstream: Upstream | null = null
        const upQueue = new ByteQueue()
        const clientQueue = new ByteQueue()
        const filter = new RfbClientFilter(session.mode)
        let ending = false
        const end = (reason: string) => {
            if (ending) return
            ending = true
            upQueue.fail(new Error('beendet'))
            clientQueue.fail(new Error('beendet'))
            try { upstream?.close() } catch { /* ignore */ }
            try { if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 60)) } catch { /* ignore */ }
            store.endSession(session, reason)
        }
        session.closer = reason => end(reason)
        const toUpstream = (data: Buffer) => {
            const result = filter.push(data)
            for (const message of result.forward) upstream?.write(message)
            if (result.error) { log(`[Desktop-Direkt] ${session.desktop.id}: ${result.error} — Sitzung beendet`); end('protokollfehler') }
        }
        ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (!isBinary) return
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as any)
            if (streaming) toUpstream(chunk)
            else clientQueue.push(chunk)
        })
        ws.on('close', () => end('getrennt'))
        ws.on('error', () => end('getrennt'))
        try {
            upstream = await connectUpstream(session.desktop.target, data => {
                if (streaming) { if (ws.readyState === WebSocket.OPEN) ws.send(data) } else upQueue.push(data)
            }, reason => end(reason === 'Desktop hat die Verbindung beendet' ? 'desktop-getrennt' : 'desktop-fehler'))
            if (ending) { upstream.close(); return }
            let password = readVncPassword(session.desktop.vncPasswordFile)
            try {
                await upstreamHandshake({ read: size => upQueue.read(size), write: data => upstream!.write(data) }, password)
            } finally {
                password?.fill(0)
                password = null
            }
            await clientHandshake({ read: size => clientQueue.read(size), write: data => ws.send(data) })
            // Always shared: Alfred never kicks Xaventra's or another viewer's connection.
            upstream.write(Buffer.from([1]))
            streaming = true
            const pendingServer = upQueue.takeRest()
            if (pendingServer.length) ws.send(pendingServer)
            const pendingClient = clientQueue.takeRest()
            if (pendingClient.length) toUpstream(pendingClient)
        } catch (error) {
            log(`[Desktop-Direkt] ${session.desktop.id}: ${String((error as Error)?.message || error).slice(0, 160)}`)
            end('verbindungsfehler')
        }
    }

    server.on('close', () => { wss.close() })
    return server
}
