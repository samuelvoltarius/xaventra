import { request } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 2.86 Paket O, Punkt 11 „Handy zuerst“: dieselbe Oberfläche als installierbare
// Web-App. Der Service-Worker cached NUR die statischen Seitendateien, nie
// API-Antworten oder Token. Mikrofon nur für die eigene Seite (Anrufen).

const renderer = (name: string) => readFileSync(fileURLToPath(new URL(`../../desktop/renderer/${name}`, import.meta.url)), 'utf8')

describe('PWA: Auslieferung über den Dashboard-Server', () => {
    let port = ''
    let stop: () => Promise<void> = async () => undefined
    const sandbox = join(process.cwd(), '.nova-test-tmp', `pwa-${randomUUID()}`)

    beforeAll(async () => {
        mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
        vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
        process.env.XAVENTRA_DASHBOARD_HOSTS = 'main.example.com'
        const server = await import('./server.js')
        const url = await server.startDashboard(0, '127.0.0.1')
        port = new URL(url).port
        stop = server.stopDashboard
    }, 60_000)
    afterAll(async () => { await stop(); delete process.env.XAVENTRA_DASHBOARD_HOSTS; vi.restoreAllMocks() })

    type Reply = { status: number; body: string; headers: Record<string, any> }
    const send = (path: string, headers: Record<string, string> = {}) => new Promise<Reply>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }))
        })
        req.on('error', reject)
        req.end()
    })

    it('liefert Manifest, Service-Worker und Icons aus', async () => {
        const manifest = await send('/manifest.webmanifest')
        expect(manifest.status).toBe(200)
        expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json/)
        const data = JSON.parse(manifest.body)
        expect(data).toMatchObject({ name: 'Xaventra', start_url: '/', scope: '/', display: 'standalone', lang: 'de' })
        expect(data.icons.map((icon: any) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
        const sw = await send('/sw.js')
        expect(sw.status).toBe(200)
        expect(sw.headers['content-type']).toMatch(/javascript/)
        expect(sw.headers['cache-control']).toBe('no-store')
        // Icons sind Binärdateien; die Reparatur-Sandbox kopiert keine (dann 404, Seite läuft trotzdem).
        const { existsSync } = await import('node:fs')
        for (const icon of data.icons) {
            const shipped = existsSync(fileURLToPath(new URL(`../../desktop/renderer${icon.src}`, import.meta.url)))
            expect((await send(icon.src)).status, icon.src).toBe(shipped ? 200 : 404)
        }
    })

    it('Mikrofon nur für die eigene Seite, Kamera/Ort weiter aus', async () => {
        const page = await send('/')
        expect(page.headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()')
    })

    it('ein eingetragener Tailnet-Name (tailscale serve) wird bedient, fremde weiter nicht', async () => {
        expect((await send('/', { host: 'main.example.com' })).status).toBe(200)
        expect((await send('/', { host: 'rebound.example.net' })).status).toBe(403)
    })
})

describe('PWA: Icons sind Beiwerk', () => {
    it('die Seite wird auch ohne Bild-Dateien gefunden (z. B. Reparatur-Sandbox ohne Binärdateien)', async () => {
        const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { UI_FILES, resolveUiDir } = await import('./server.js')
        const base = mkdtempSync(join(tmpdir(), 'ui-'))
        try {
            mkdirSync(join(base, 'public'))
            for (const name of Object.keys(UI_FILES).filter(name => !name.endsWith('.png'))) writeFileSync(join(base, 'public', name), 'x')
            expect(resolveUiDir(base)).toBe(join(base, 'public'))
        } finally { rmSync(base, { recursive: true, force: true }) }
    })
})

describe('PWA: Seite und Service-Worker', () => {
    it('index.html verweist auf das Manifest und lädt pwa.js (kein Inline-Skript)', () => {
        const html = renderer('index.html')
        expect(html).toContain('<link rel="manifest" href="manifest.webmanifest">')
        expect(html).toContain('<script src="pwa.js" defer></script>')
        expect(html).toContain('<script src="anruf.js" defer></script>')
        expect(html).not.toMatch(/<script>(?!<\/script>)/)
    })

    function loadWorker() {
        const listeners: Record<string, (event: any) => void> = {}
        const cached: string[] = []
        const caches = {
            open: async () => ({ addAll: async (urls: string[]) => { cached.push(...urls) }, put: async (req: any) => { cached.push(typeof req === 'string' ? req : req.url) }, match: async () => undefined }),
            keys: async () => ['xaventra-ui-alt'],
            delete: async () => true,
            match: async () => undefined,
        }
        const self: any = { addEventListener: (type: string, fn: any) => { listeners[type] = fn }, location: { origin: 'https://main.example.com' }, skipWaiting: () => undefined, clients: { claim: async () => undefined } }
        vm.runInNewContext(renderer('sw.js'), { self, caches, fetch: async () => ({ ok: true, clone() { return this } }), URL, Promise, console })
        return { listeners, cached }
    }

    it('cached bei der Installation nur statische Seitendateien', async () => {
        const { listeners, cached } = loadWorker()
        let pending: Promise<unknown> = Promise.resolve()
        listeners.install({ waitUntil: (p: Promise<unknown>) => { pending = p } })
        await pending
        expect(cached.length).toBeGreaterThan(3)
        for (const url of cached) expect(url, url).not.toMatch(/api|token|verbindungen/i)
        expect(cached).toEqual(expect.arrayContaining(['/', '/app.js', '/bridge.js', '/styles.css', '/manifest.webmanifest']))
    })

    // 2.86 Zusammenstecken (O + M): die Web-App startet auch ohne Netz mit ALLEN Seitendateien
    // (auch dem Cockpit „Heute“ aus Paket M) — aber nie mit API-Antworten oder Token.
    it('cached jede Seitendatei der einen Oberfläche (auch cockpit.js), sonst nichts', async () => {
        const { DASHBOARD_UI_FILES } = await import('../dev/copy-dashboard-assets.js')
        const { listeners, cached } = loadWorker()
        let pending: Promise<unknown> = Promise.resolve()
        listeners.install({ waitUntil: (p: Promise<unknown>) => { pending = p } })
        await pending
        const expected = DASHBOARD_UI_FILES.filter(name => name !== 'sw.js').map(name => `/${name}`)
        expect([...cached].filter(url => url !== '/').sort()).toEqual([...expected].sort())
        const { listeners: l2 } = loadWorker()
        const handled = (url: string) => { let r = false; l2.fetch({ request: { url, method: 'GET', headers: { get: () => null } }, respondWith: () => { r = true } }); return r }
        expect(handled('https://main.example.com/cockpit.js')).toBe(true)
        expect(handled('https://main.example.com/cockpit.js?token=abc')).toBe(false)
        expect(handled('https://main.example.com/api/desktop/gefuehrt')).toBe(false)
        expect(handled('https://main.example.com/sw.js')).toBe(false)
    })

    it('fasst API-Aufrufe, fremde Ursprünge und Nicht-GET nie an', () => {
        const { listeners } = loadWorker()
        const handled = (url: string, method = 'GET', headers: Record<string, string> = {}) => {
            let responded = false
            listeners.fetch({ request: { url, method, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, mode: 'cors' }, respondWith: () => { responded = true } })
            return responded
        }
        expect(handled('https://main.example.com/api/desktop/heute')).toBe(false)
        expect(handled('https://main.example.com/app.js', 'GET', { authorization: 'Bearer x' })).toBe(false)
        expect(handled('https://main.example.com/api/desktop/rooms/1/messages', 'POST')).toBe(false)
        expect(handled('https://other.example.com/app.js')).toBe(false)
        expect(handled('https://main.example.com/verbindungen/rueckkehr?state=x')).toBe(false)
        expect(handled('https://main.example.com/app.js')).toBe(true)
        expect(handled('https://main.example.com/')).toBe(true)
    })

    it('pwa.js meldet den Service-Worker nur im Browser an (nicht in der Desktop-App)', () => {
        const source = renderer('pwa.js')
        const register = vi.fn(async () => ({}))
        const run = (web: boolean) => vm.runInNewContext(source, {
            window: { novaDesktop: { web }, isSecureContext: true, addEventListener: (_: string, fn: () => void) => fn() },
            navigator: { serviceWorker: { register } }, console,
        })
        run(false)
        expect(register).not.toHaveBeenCalled()
        run(true)
        expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    })
})
