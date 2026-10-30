import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { erneuereFaellig, handlePanoptesCommand, lauschSchleife, parsePanoptesConfig, pruneAutoStandbilder, readKopplung, setPanoptesConfig, speichereKopplung, startPanoptes, stopPanoptes, verarbeiteEreignis, writeKopplung } from './panoptes-standbild.js'
import { assertSendableImage } from '../media/image-source-policy.js'

const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(32)])
const ID = 'b'.repeat(32), ID2 = 'c'.repeat(32)
const JWT = ['fixture', 'kopplung', String(4711)].join('-')
const URL_A = 'http://100.64.1.2:8180', URL_B = 'http://100.64.1.3:8180'
const cfg = { enabled: true, urls: [URL_A, URL_B] }
const ANFRAGE = 'd'.repeat(32)
const NOW = 1_800_000_000_000
const event = (extra: Record<string, unknown> = {}) => ({ art: 'person' as const, zeit: NOW - 1000, ereignisId: ID, ...extra })
let root = '', logged: string[] = []
const deps = (over: Record<string, unknown> = {}) => ({ now: () => NOW, log: (line: string) => { logged.push(line) }, notify: vi.fn(async () => true), evaluate: vi.fn(async () => 'Eine Person neben der Fahrertür.'),
    fetchFn: vi.fn(async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })), sleep: async () => undefined, ...over }) as any

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'panoptes-')); logged = []
    vi.stubEnv('NOVA_RUNTIME_ROOT', root)
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    setPanoptesConfig(cfg, root)
    writeKopplung(root, { jwt: JWT, kopplungId: 'kid-1', url: URL_A, pairedAt: NOW })
})
afterEach(() => { stopPanoptes(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const stills = () => { const dir = join(root, '.nova-vision', 'auto'); return existsSync(dir) ? readdirSync(dir) : [] }

describe('Schalter', () => {
    it('ist Standard aus; an nur ausdrücklich und mit gültiger Adresse', () => {
        expect(parsePanoptesConfig(undefined).enabled).toBe(false)
        expect(parsePanoptesConfig({ enabled: 'true', urls: [URL_A] }).enabled).toBe(false)
        expect(parsePanoptesConfig({ enabled: true }).enabled).toBe(false)
        expect(parsePanoptesConfig({ enabled: true, urls: ['http://u:p@100.64.1.2'] }).enabled).toBe(false)
        expect(parsePanoptesConfig({ enabled: true, urls: ['ftp://100.64.1.2'] }).enabled).toBe(false)
        expect(parsePanoptesConfig({ enabled: true, urls: [URL_A, URL_B] })).toEqual(cfg)
    })
    it('der Kopplungs-JWT liegt versiegelt, nie im Klartext', () => {
        expect(readFileSync(join(root, 'secrets', 'panoptes', 'kopplung.json'), 'utf8')).not.toContain(JWT)
        expect(readKopplung(root)?.jwt).toBe(JWT)
    })
})

describe('Ereignis → genau ein Bild', () => {
    it('holt das Bild, legt es privat ab, wertet es aus und benachrichtigt den Besitzer', async () => {
        const d = deps()
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: 'gemeldet' })
        expect(stills()).toEqual([`panoptes_${ID}.jpg`])
        const path = join(root, '.nova-vision', 'auto', `panoptes_${ID}.jpg`)
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(assertSendableImage(path)).toMatchObject({ source: 'auto', mime: 'image/jpeg' })
        expect(d.notify).toHaveBeenCalledOnce()
        const [sentPath, text] = d.notify.mock.calls[0]
        expect(sentPath).toBe(path)
        expect(text).toMatch(/Person/)
        expect(text).toContain('Eine Person neben der Fahrertür.')
    })
    it('dieselbe ereignisId holt nie ein zweites Bild, auch nach Neustart', async () => {
        const d = deps()
        await verarbeiteEreignis(root, cfg, event(), d)
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: 'doppelt' })
        expect(d.fetchFn).toHaveBeenCalledOnce()
        expect(d.notify).toHaveBeenCalledOnce()
    })
    it('fehlt die ereignisId: ehrlich loggen, nichts erraten, kein Abruf', async () => {
        const d = deps()
        expect(await verarbeiteEreignis(root, cfg, { art: 'bewegung', zeit: NOW, ohneId: true }, d)).toMatchObject({ status: 'ohne-id' })
        expect(d.fetchFn).not.toHaveBeenCalled()
        expect(logged.join(' ')).toMatch(/ohne ereignisId/)
    })
    it('älter als 15 Minuten: kein Abruf', async () => {
        const d = deps()
        expect(await verarbeiteEreignis(root, cfg, event({ zeit: NOW - 16 * 60_000 }), d)).toMatchObject({ status: 'zu-alt' })
        expect(d.fetchFn).not.toHaveBeenCalled()
    })
    it('eigene Drosselung unter 10 Abrufen je Minute', async () => {
        const d = deps()
        const ids = Array.from({ length: 12 }, (_, i) => String(i).padStart(32, 'a').replace(/[^a-f0-9]/g, 'a'))
        for (const ereignisId of ids) await verarbeiteEreignis(root, cfg, event({ ereignisId }), d)
        expect(d.fetchFn.mock.calls.length).toBeLessThanOrEqual(6)
    })
    it('ohne Kopplung geschieht nichts', async () => {
        const empty = mkdtempSync(join(tmpdir(), 'panoptes-leer-')), d = deps()
        expect(await verarbeiteEreignis(empty, cfg, event(), d)).toMatchObject({ status: 'nicht-gekoppelt' })
        expect(d.fetchFn).not.toHaveBeenCalled()
    })
})

describe('Gegenproben', () => {
    const answer = (status: number, grund: string) => vi.fn(async () => new Response(JSON.stringify({ ok: false, grund }), { status }))
    it('403 ohne Recht: kein Bild, der Besitzer erfährt es genau einmal', async () => {
        const d = deps({ fetchFn: answer(403, 'nicht_erlaubt') })
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: 'nicht_erlaubt' })
        await verarbeiteEreignis(root, cfg, event({ ereignisId: ID2 }), d)
        expect(stills()).toEqual([])
        expect(d.notify).toHaveBeenCalledOnce()
        expect(d.notify.mock.calls[0][0]).toBeNull()
        expect(d.notify.mock.calls[0][1]).toMatch(/Standbild bei Ereignis/)
    })
    it.each([[404, 'nicht_gefunden'], [410, 'zu_alt'], [429, 'zu_oft']])('%i: kein Bild, keine Bildmeldung', async (status, grund) => {
        const d = deps({ fetchFn: answer(status, grund) })
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: grund })
        expect(stills()).toEqual([])
        expect(d.notify).not.toHaveBeenCalled()
    })
    it('misslingt die Auswertung, geht das Bild trotzdem raus; misslingt die Zustellung, steht das im Ergebnis', async () => {
        const d = deps({ evaluate: vi.fn(async () => { throw new Error('MiniMax weg') }), notify: vi.fn(async () => false) })
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: 'nicht-zugestellt' })
        expect(d.notify).toHaveBeenCalledOnce()
    })
    it('ohne eingerichteten Versand: ehrlich nicht zugestellt, das Bild bleibt privat', async () => {
        const d = deps(); delete d.notify
        expect(await verarbeiteEreignis(root, cfg, event(), d)).toMatchObject({ status: 'nicht-zugestellt' })
        expect(stills()).toEqual([`panoptes_${ID}.jpg`])
    })
    it('der JWT steht in keinem Log, keinem Ergebnis, keiner Datei außerhalb des Tresors', async () => {
        const d = deps()
        const result = await verarbeiteEreignis(root, cfg, event(), d)
        expect(JSON.stringify(result) + logged.join('\n')).not.toContain(JWT)
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
        for (const path of walk(root)) expect(readFileSync(path, 'latin1').includes(JWT), path).toBe(false)
    })
    it('Koordinaten aus dem Ereignis landen nirgends', async () => {
        const d = deps()
        await verarbeiteEreignis(root, cfg, { ...event(), lat: 47.123456, lon: 13.654321 } as any, d)
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
        for (const path of walk(root)) expect(readFileSync(path, 'latin1').includes('47.123456'), path).toBe(false)
        expect(JSON.stringify(d.notify.mock.calls) + logged.join('\n')).not.toContain('47.123456')
    })
})

describe('Ablage', () => {
    it('Standbilder leben höchstens 72 Stunden', () => {
        const dir = join(root, '.nova-vision', 'auto'); mkdirSync(dir, { recursive: true })
        const old = join(dir, `panoptes_${ID}.jpg`), fresh = join(dir, `panoptes_${ID2}.jpg`)
        writeFileSync(old, JPEG); writeFileSync(fresh, JPEG)
        const past = new Date(Date.now() - 73 * 3600_000); utimesSync(old, past, past)
        expect(pruneAutoStandbilder()).toBe(1)
        expect(readdirSync(dir)).toEqual([`panoptes_${ID2}.jpg`])
    })
    it('die Bild-Sperre lässt nur frische Panoptes-Standbilder durch', () => {
        const dir = join(root, '.nova-vision', 'auto'); mkdirSync(dir, { recursive: true })
        const other = join(dir, 'ereignis.jpg'), old = join(dir, `panoptes_${ID}.jpg`)
        writeFileSync(other, JPEG); writeFileSync(old, JPEG)
        expect(() => assertSendableImage(other)).toThrow(/nicht freigegeben/)
        const past = new Date(Date.now() - 73 * 3600_000); utimesSync(old, past, past)
        expect(() => assertSendableImage(old)).toThrow(/nicht freigegeben/)
    })
})

describe('/panoptes', () => {
    const owner = { principalId: 'owner-1', permission: 'owner' }
    it('nur für den Besitzer; ohne Schalter kein Abruf', async () => {
        setPanoptesConfig({ enabled: false, urls: [] }, root)
        expect(await handlePanoptesCommand('koppeln', { principalId: 'g', permission: 'user' })).toMatch(/nur für den Owner/)
        expect(await handlePanoptesCommand('koppeln', owner)).toMatch(/aus/)
    })
    it('koppeln zeigt die Prüfzahl; der Besitzer erlaubt am Auto; das Recht schaltet er selbst ein', async () => {
        const empty = mkdtempSync(join(tmpdir(), 'panoptes-kopp-'))
        setPanoptesConfig(cfg, empty)
        const calls: any[] = []
        const fetchFn = vi.fn(async (url: any, init: any = {}) => {
            calls.push([String(url), init.body])
            return String(url).endsWith('/anfrage') ? new Response(JSON.stringify({ ok: true, id: ANFRAGE, abfrageAlleMs: 1 }), { status: 200 })
                : new Response(JSON.stringify({ status: 'erlaubt', jwt: JWT, kopplungId: 'kid-9' }), { status: 200 })
        })
        const done = vi.fn()
        const text = await handlePanoptesCommand('koppeln', owner, { fetchFn: fetchFn as any, sleep: async () => undefined, onFertig: done })
        const pruefzahl = /\b(\d{4})\b/.exec(text)?.[1]
        expect(pruefzahl).toBeTruthy()
        expect(JSON.parse(calls[0][1])).toEqual({ geraet: 'Xaventra', pruefzahl, art: 'dienst' })
        expect(text).not.toContain(JWT)
        await vi.waitFor(() => expect(done).toHaveBeenCalled())
        expect(readKopplung(empty)).toMatchObject({ jwt: JWT, kopplungId: 'kid-9' })
        expect(String(done.mock.calls[0][0])).toMatch(/Standbild bei Ereignis/)
    })
})

describe('Kopplung: der JWT kommt nur einmal', () => {
    const owner = { principalId: 'owner-1', permission: 'owner' }
    const pairing = (status: Record<string, unknown>) => vi.fn(async (url: any) => String(url).endsWith('/anfrage')
        ? new Response(JSON.stringify({ ok: true, id: ANFRAGE, abfrageAlleMs: 1 }), { status: 200 }) : new Response(JSON.stringify(status), { status: 200 }))
    it('speichert versiegelt und liest zurück; erst dann Erfolg', () => {
        const empty = mkdtempSync(join(tmpdir(), 'panoptes-save-'))
        expect(speichereKopplung(empty, { jwt: JWT, kopplungId: 'k', url: URL_A, pairedAt: NOW })).toBe(true)
        expect(readKopplung(empty)?.jwt).toBe(JWT)
    })
    it('Gegenprobe: kann der Tresor nicht schreiben, kommt „neu koppeln“, kein Erfolg, kein Lauscher', async () => {
        const blocked = mkdtempSync(join(tmpdir(), 'panoptes-block-'))
        writeFileSync(join(blocked, 'secrets'), 'eine Datei, kein Ordner')
        setPanoptesConfig(cfg, blocked)
        const done = vi.fn(), fetchFn = pairing({ status: 'erlaubt', jwt: JWT, kopplungId: 'k' })
        await handlePanoptesCommand('koppeln', owner, { fetchFn: fetchFn as any, sleep: async () => undefined, onFertig: done })
        await vi.waitFor(() => expect(done).toHaveBeenCalled())
        expect(String(done.mock.calls[0][0])).toMatch(/neu koppeln/)
        expect(String(done.mock.calls[0][0])).not.toMatch(/gekoppelt\./i)
        expect(String(done.mock.calls[0][0])).not.toContain(JWT)
        expect(readKopplung(blocked)).toBeUndefined()
    })
    it.each(['abgelehnt', 'abgelaufen', 'abgeholt'])('%s: nichts gespeichert, kein neuer Versuch', async status => {
        const empty = mkdtempSync(join(tmpdir(), 'panoptes-nein-'))
        setPanoptesConfig(cfg, empty)
        const done = vi.fn(), fetchFn = pairing({ status })
        await handlePanoptesCommand('koppeln', owner, { fetchFn: fetchFn as any, sleep: async () => undefined, onFertig: done })
        await vi.waitFor(() => expect(done).toHaveBeenCalled())
        expect(readKopplung(empty)).toBeUndefined()
        expect(fetchFn).toHaveBeenCalledTimes(2)
    })
    it('nimmt die erste Adresse, die antwortet, und merkt sie sich', async () => {
        const empty = mkdtempSync(join(tmpdir(), 'panoptes-adr-'))
        setPanoptesConfig(cfg, empty)
        const seen: string[] = []
        const fetchFn = vi.fn(async (url: any) => {
            seen.push(String(url))
            if (String(url).startsWith(URL_A)) throw new Error('offline')
            return String(url).endsWith('/anfrage') ? new Response(JSON.stringify({ ok: true, id: ANFRAGE, abfrageAlleMs: 1 }), { status: 200 })
                : new Response(JSON.stringify({ status: 'erlaubt', jwt: JWT, kopplungId: 'k' }), { status: 200 })
        })
        const done = vi.fn()
        await handlePanoptesCommand('koppeln', owner, { fetchFn: fetchFn as any, sleep: async () => undefined, onFertig: done })
        await vi.waitFor(() => expect(done).toHaveBeenCalled())
        stopPanoptes()
        expect(seen[0].startsWith(URL_A)).toBe(true)
        expect(readKopplung(empty)?.url).toBe(URL_B)
    })
})

describe('Ereignisstrom: Abbruch und Wiederverbinden', () => {
    const stream = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const ereignis = `event: ereignis\ndata: {"art":"person","zeit":${NOW},"ereignisId":"${ID}"}\n\n`
    it('verbindet nach Abbruch mit wachsendem Abstand neu, wechselt die Adresse und stoppt bei 401', async () => {
        const urls: string[] = [], waits: number[] = []
        const answers: Array<() => Promise<Response>> = [
            async () => { throw new Error('offline') }, async () => { throw new Error('offline') },
            async () => stream(ereignis), async () => stream(''), async () => new Response('', { status: 401 }),
        ]
        const fetchFn = vi.fn(async (url: any) => {
            const text = String(url)
            if (text.includes('/standbild/')) return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
            urls.push(text); return answers.shift()!()
        })
        const d = deps({ fetchFn, sleep: async (ms: number) => { waits.push(ms) } })
        expect(await lauschSchleife(root, cfg, { ...d, signal: new AbortController().signal })).toBe('abgelehnt')
        expect(waits.slice(0, 4)).toEqual([5000, 10_000, 20_000, 40_000])
        expect(urls[0].startsWith(URL_A)).toBe(true)
        expect(urls[1].startsWith(URL_B)).toBe(true)
        expect(stills()).toEqual([`panoptes_${ID}.jpg`])
        expect(d.notify).toHaveBeenCalledTimes(2)
        expect(String(d.notify.mock.calls.at(-1)[1])).toMatch(/neu koppeln/)
    })
    it('der Abstand endet bei fünf Minuten; lange Offline-Zeiten fluten nicht', async () => {
        const waits: number[] = [], controller = new AbortController()
        const fetchFn = vi.fn(async () => { throw new Error('offline') })
        const d = deps({ fetchFn, sleep: async (ms: number) => { waits.push(ms); if (waits.length >= 12) controller.abort() } })
        expect(await lauschSchleife(root, cfg, { ...d, signal: controller.signal })).toBe('beendet')
        expect(Math.max(...waits)).toBe(300_000)
        expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(13)
    })
    it('Offline ist normal: höchstens eine Log-Zeile je Stunde, keine Meldung an den Besitzer', async () => {
        const controller = new AbortController(), lines: string[] = []
        let clock = NOW, runs = 0
        const d = deps({ fetchFn: vi.fn(async () => { throw new Error('offline') }), now: () => clock, log: (line: string) => { lines.push(line) },
            sleep: async () => { clock += 10 * 60_000; if (++runs >= 12) controller.abort() } })
        await lauschSchleife(root, cfg, { ...d, signal: controller.signal })
        expect(lines.filter(line => /nicht erreichbar/.test(line)).length).toBeLessThanOrEqual(3)
        expect(d.notify).not.toHaveBeenCalled()
    })
    it('eine stabile Verbindung setzt den Abstand zurück', async () => {
        let clock = NOW
        const waits: number[] = [], controller = new AbortController()
        const answers: Array<() => Promise<Response>> = [async () => { throw new Error('x') }, async () => { clock += 120_000; return stream('') }, async () => { throw new Error('x') }]
        const fetchFn = vi.fn(async () => { const next = answers.shift(); if (!next) { controller.abort(); throw new Error('ende') } return next() })
        const d = deps({ fetchFn, now: () => clock, sleep: async (ms: number) => { waits.push(ms) } })
        await lauschSchleife(root, cfg, { ...d, signal: controller.signal })
        expect(waits).toEqual([5000, 5000, 10_000])
    })
})

describe('Sitzung erneuern', () => {
    const renewed = () => vi.fn(async () => new Response(JSON.stringify({ jwt: 'frisch' }), { status: 200 }))
    it('erst nach 24 h; der neue JWT liegt versiegelt, die Kopplung bleibt', async () => {
        const early = renewed()
        expect(await erneuereFaellig(root, cfg, deps({ fetchFn: early, now: () => NOW + 23 * 3600_000 }))).toBe(false)
        expect(early).not.toHaveBeenCalled()
        const due = renewed()
        expect(await erneuereFaellig(root, cfg, deps({ fetchFn: due, now: () => NOW + 25 * 3600_000 }))).toBe(true)
        expect(readKopplung(root)).toMatchObject({ jwt: 'frisch', kopplungId: 'kid-1', renewedAt: NOW + 25 * 3600_000 })
        expect(await erneuereFaellig(root, cfg, deps({ fetchFn: due, now: () => NOW + 26 * 3600_000 }))).toBe(false)
    })
    it('offline bleibt der alte JWT, und beim nächsten Mal wird es wieder versucht', async () => {
        const failing = vi.fn(async () => { throw new Error('offline') })
        expect(await erneuereFaellig(root, cfg, deps({ fetchFn: failing, now: () => NOW + 25 * 3600_000 }))).toBe(false)
        expect(readKopplung(root)?.jwt).toBe(JWT)
        expect(await erneuereFaellig(root, cfg, deps({ fetchFn: renewed(), now: () => NOW + 26 * 3600_000 }))).toBe(true)
    })
    it('der Timer läuft: nach einem Tag ruft er Erneuern von selbst', async () => {
        vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] })
        try {
            const calls: string[] = []
            const fetchFn = vi.fn(async (url: any, init: any = {}) => {
                calls.push(String(url))
                if (String(url).includes('/erneuern')) return new Response(JSON.stringify({ jwt: 'frisch' }), { status: 200 })
                await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort'))))
                return new Response('')
            })
            expect(startPanoptes({ enabled: true, urls: [URL_A] }, root, { fetchFn: fetchFn as any, log: () => undefined })).toMatchObject({ started: true })
            await vi.advanceTimersByTimeAsync(25 * 3600_000)
            expect(calls.some(url => url.endsWith('/api/sitzung/erneuern'))).toBe(true)
            await vi.waitFor(() => expect(readKopplung(root)?.jwt).toBe('frisch'))
        } finally { stopPanoptes(); vi.useRealTimers() }
    })
})
