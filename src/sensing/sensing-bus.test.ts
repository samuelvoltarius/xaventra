import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SensingBus, type SensingAdapter } from './event-bus.js'
import { JsonlEventSink, JsonlThoughtSink, type SensingThought, type ThoughtSink } from './ports.js'
import { parseSensingConfig } from './config.js'
import { approveDevice, loadDevices, monitoredDevices, recordCandidates, setDeviceStatus } from './device-registry.js'
import { decideDelivery, DEFAULT_NOTIFY_POLICY } from './notify-policy.js'
import { learnQuietHours, readOwnerTimestamps } from './quiet-hours.js'
import { createSystemAdapter } from './adapters/system.js'
import { detectAccounts, readAuthProfileShapes } from './accounts.js'
import * as runtime from './runtime.js'

const dirs: string[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); runtime.stopSensing(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const NOON = Date.parse('2026-10-01T10:00:00Z') // 12:00 Wien
const readThoughts = (dataDir: string): SensingThought[] => {
    try { return readFileSync(join(dataDir, 'sensing', 'thoughts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}

function ok(id: string, n = 1): SensingAdapter {
    let i = 0
    return { id, source: 'system', intervalMs: 10, timeoutMs: 200, poll: async () => [{ kind: 'test.ok', subject: id, summary: `${id} lebt ${i}`, severity: 'info', dedupeKey: `${id}:${i++ % n}`, evidence: {} }] }
}

describe('Ereignis-Bus: Fehler isoliert', () => {
    it('ein werfender und ein hängender Adapter bringen den Bus nicht zum Stehen', async () => {
        const dataDir = tmp('sense-bus-')
        const bus = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), now: () => NOON })
        bus.register({ id: 'kaputt', source: 'system', intervalMs: 10, timeoutMs: 200, poll: async () => { throw new Error('boom') } })
        bus.register({ id: 'haengt', source: 'system', intervalMs: 10, timeoutMs: 60, poll: () => new Promise(() => {}) })
        bus.register(ok('gut', 100))
        const started = Date.now()
        const events = await bus.runAllOnce()
        expect(Date.now() - started).toBeLessThan(1000)
        expect(events.map(e => e.subject)).toEqual(['gut'])
        const status = Object.fromEntries(bus.getStatus().map(s => [s.id, s]))
        expect(status.kaputt.errors).toBe(1)
        expect(status.haengt.lastError).toContain('Zeitlimit')
        expect(status.gut.errors).toBe(0)
        // Der Bus läuft weiter: zweiter Durchgang liefert wieder.
        expect((await bus.runAllOnce()).map(e => e.subject)).toEqual(['gut'])
    })

    it('ein kaputter Sink stoppt weder Bus noch andere Sinks', async () => {
        const dataDir = tmp('sense-sink-')
        const bus = new SensingBus({ dataDir, eventSink: { writeEvent: () => { throw new Error('disk full') } }, thoughtSink: new JsonlThoughtSink(dataDir), now: () => NOON })
        bus.register(ok('gut'))
        vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(await bus.runAdapter('gut')).toHaveLength(1)
        expect(readThoughts(dataDir)).toHaveLength(1)
    })

    it('zeitgesteuert: läuft mit eigenem Takt weiter, auch wenn ein Adapter dauernd wirft', async () => {
        const dataDir = tmp('sense-timer-')
        let good = 0
        const bus = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), now: () => NOON })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        bus.register({ id: 'kaputt', source: 'system', intervalMs: 5, timeoutMs: 50, poll: async () => { throw new Error('immer') } })
        bus.register({ id: 'gut', source: 'system', intervalMs: 20, timeoutMs: 50, poll: async () => { good++; return [] } })
        vi.useFakeTimers()
        try {
            bus.start()
            await vi.advanceTimersByTimeAsync(3000)
        } finally { bus.stop(); vi.useRealTimers() }
        expect(good).toBeGreaterThan(50)
    })
})

describe('Ereignis-Bus: Port, Entprellen, Ruhezeiten', () => {
    it('schreibt das dokumentierte Port-Format und entprellt', async () => {
        const dataDir = tmp('sense-port-')
        const bus = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), now: () => NOON, nodeId: 'spark' })
        bus.register(ok('a', 1))
        await bus.runAdapter('a'); await bus.runAdapter('a')
        const events = readFileSync(join(dataDir, 'sensing', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ schema: 'xaventra.sensing.event/1', source: 'system', kind: 'test.ok', severity: 'info' })
        expect(events[0].hint).toBeUndefined()
        const [thought] = readThoughts(dataDir)
        expect(thought).toMatchObject({ schema: 'xaventra.sensing.thought/1', status: 'neu', importance: 'normal', level: 'selbst', origin: { nodeId: 'spark', role: 'main' }, delivery: { notify: true, reason: 'ok' } })
    })

    it('Ruhezeit 22–7 nur Dringendes, max. 10 Meldungen am Tag', () => {
        const night = Date.parse('2026-10-01T21:30:00Z') // 23:30 Wien
        let counter = { day: '', count: 0 }
        expect(decideDelivery('normal', DEFAULT_NOTIFY_POLICY, counter, night).delivery).toMatchObject({ notify: false, reason: 'ruhezeit' })
        expect(decideDelivery('dringend', DEFAULT_NOTIFY_POLICY, counter, night).delivery).toMatchObject({ notify: true, urgent: true })
        const reasons: string[] = []
        for (let i = 0; i < 12; i++) {
            const result = decideDelivery('hoch', DEFAULT_NOTIFY_POLICY, counter, NOON)
            counter = result.counter
            reasons.push(result.delivery.reason)
        }
        expect(reasons.filter(r => r === 'ok')).toHaveLength(10)
        expect(reasons.slice(10)).toEqual(['tageslimit', 'tageslimit'])
        expect(decideDelivery('niedrig', DEFAULT_NOTIFY_POLICY, counter, NOON).delivery.reason).toBe('nur-protokoll')
    })
})

describe('Worker sendet nichts direkt an den Owner', () => {
    it('der Sensing-Code kennt keinen Kanal und keinen Messenger', () => {
        const root = fileURLToPath(new URL('.', import.meta.url))
        const files = [...readdirSync(root).map(name => join(root, name)), ...readdirSync(join(root, 'adapters')).map(name => join(root, 'adapters', name))]
            .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        expect(files.length).toBeGreaterThan(8)
        for (const file of files) {
            const text = readFileSync(file, 'utf8')
            const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
            expect(code, file).not.toMatch(/from ['"][^'"]*(channels|telegram|whatsapp|discord|slack|mesh)\//)
            expect(code, file).not.toMatch(/sendGovernedProactive|sendMessage\(|\.send\(\s*\{|ProactiveMessenger\s*\(|new ProactiveMessenger/)
        }
    })

    it('Mesh-Worker starten das Wahrnehmen nicht; Main schreibt nur in den Port', async () => {
        const dataDir = tmp('sense-worker-')
        runtime.setSensingConfig({ enabled: true, adapters: { system: { enabled: true } } }, {}, dataDir)
        expect(runtime.startSensing({ nodeOnly: true })).toMatchObject({ started: false })
        const written: SensingThought[] = []
        const sink: ThoughtSink = { writeThought: thought => { written.push(thought) } }
        runtime.setSensingSinks({ thoughtSink: sink })
        const bus = runtime.buildSensingBus({ role: 'worker', nodeId: 'ns2' })
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        mkdirSync(join(dataDir, 'self-heal', 'journal'), { recursive: true })
        const journal = join(dataDir, 'self-heal', 'journal', '2026-10-01.jsonl')
        writeFileSync(journal, '')
        await bus.runAllOnce()
        appendFileSync(journal, `${JSON.stringify({ id: 'h1', at: '2026-10-01T10:00:00Z', node: 'ns2', recipe: 'log-rotation', ergebnis: 'rueckweg-gescheitert', message: 'x' })}\n`)
        await bus.runAllOnce()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(written).toHaveLength(1)
        expect(written[0].origin).toEqual({ nodeId: 'ns2', role: 'worker' })
        runtime.setSensingSinks({})
    })

    it('P8: ohne Config am Main alles an, am Worker alles aus; enabled:false schaltet ab', () => {
        const main = parseSensingConfig(undefined, {} as NodeJS.ProcessEnv)
        expect(main.enabled).toBe(true)
        expect(main.discovery.enabled).toBe(true)
        expect(Object.values(main.adapters).every(adapter => adapter.enabled === true)).toBe(true)
        const worker = parseSensingConfig(undefined, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv)
        expect(worker.enabled).toBe(false)
        expect(worker.discovery.enabled).toBe(false)
        expect(Object.values(worker.adapters).every(adapter => adapter.enabled === false)).toBe(true)
        const off = parseSensingConfig({ enabled: false, discovery: { enabled: false }, adapters: { mail: { enabled: false } } }, {} as NodeJS.ProcessEnv)
        expect([off.enabled, off.discovery.enabled, off.adapters.mail.enabled, off.adapters.printer.enabled]).toEqual([false, false, false, true])
        runtime.setSensingConfig({ enabled: false }, {}, tmp('sense-off-'))
        expect(runtime.startSensing({ nodeOnly: false })).toMatchObject({ started: false })
    })
})

describe('P8: gefundene Geräte werden ohne Karte lesend überwacht', () => {
    const lan = { eth0: [{ address: '192.168.1.20', netmask: '255.255.255.248', family: 'IPv4', internal: false }] }
    const owner = { principalId: 'alfred', permission: 'owner' }

    it('Fund → sofort eingerichtet (selbst, lesend) + Gedanke „gefunden + überwacht“ mit Beleg, keine Karte', async () => {
        const dataDir = tmp('sense-dev-')
        runtime.setSensingConfig({ discovery: { mdns: false, deadlineSec: 5, ratePerSec: 200 } }, {}, dataDir)
        const text = await runtime.runDiscoveryNow({
            interfaces: lan,
            tcpProbe: async (host, port) => host === '192.168.1.21' && port === 7125,
            httpProbe: async () => ({ status: 200, body: '{"result":{"klippy_state":"ready"}}' }),
            mdnsBrowse: undefined,
        })
        expect(text).toContain('Neu gefunden')
        expect(text).toContain('überwacht, nur lesend')
        const [device] = loadDevices(dataDir)
        expect(device).toMatchObject({ status: 'eingerichtet', approvedBy: 'auto:lesend', host: '192.168.1.21', port: 7125, type: 'moonraker' })
        expect(monitoredDevices(dataDir).map(d => d.id)).toEqual([device.id])
        const thoughts = readThoughts(dataDir)
        expect(thoughts).toHaveLength(1)
        expect(thoughts[0].level).toBe('selbst')
        expect(thoughts[0].action).toBeUndefined()
        expect(thoughts[0].title).toContain('Gefunden + überwacht')
        expect(thoughts[0].evidence).toMatchObject({ geraet: device.id, adresse: '192.168.1.21:7125' })

        // Der Drucker-Adapter fragt das Gerät jetzt (nur lesend) ab — ohne dass jemand „Ja“ gedrückt hat.
        const urls: string[] = []
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => { urls.push(String(url)); return new Response('{"result":{"status":{}}}', { status: 200 }) })
        await runtime.buildSensingBus().runAllOnce()
        expect(urls[0]).toMatch(/^http:\/\/192\.168\.1\.21:7125\/printer\/objects\/query/)

        // Owner-Korrektur bleibt: aus heißt aus, auch beim nächsten Suchlauf.
        expect(setDeviceStatus(dataDir, device.id, 'aus', owner).ok).toBe(true)
        await runtime.runDiscoveryNow({ interfaces: lan, tcpProbe: async (host, port) => host === '192.168.1.21' && port === 7125, httpProbe: async () => ({ status: 200, body: '{"result":{"klippy_state":"ready"}}' }), mdnsBrowse: undefined })
        expect(monitoredDevices(dataDir)).toEqual([])
        expect(loadDevices(dataDir)[0].status).toBe('aus')
        // Nicht-Owner kann weiterhin nichts einrichten.
        expect(approveDevice(dataDir, device.id, { principalId: 'gast', permission: 'user' }).ok).toBe(false)
        await expect(runtime.handleGeraeteCommand(`ja ${device.id}`, { principalId: 'x', permission: 'admin' })).resolves.toContain('nur für den Owner')
    })

    it('Gerät mit nötigem Token → genau EINE Bitte an den Owner (ohne Karte), keine Wiederholung, keine Überwachung ohne Zugang', async () => {
        const dataDir = tmp('sense-dev-key-')
        runtime.setSensingConfig({ discovery: { mdns: false, deadlineSec: 5, ratePerSec: 200 } }, {}, dataDir)
        const deps = {
            interfaces: lan,
            tcpProbe: async (host: string, port: number) => host === '192.168.1.22' && port === 8123,
            httpProbe: async () => ({ status: 200, body: '{"name": "Home Assistant"}' }),
            mdnsBrowse: undefined,
        }
        const text = await runtime.runDiscoveryNow(deps)
        expect(text).toContain('Zugang fehlt')
        const [device] = loadDevices(dataDir)
        expect(device).toMatchObject({ status: 'gefunden', type: 'homeassistant' })
        expect(device.ownerAskedAt).toBeTruthy()
        expect(monitoredDevices(dataDir)).toEqual([])
        const first = readThoughts(dataDir)
        expect(first).toHaveLength(1)
        expect(first[0].action).toBeUndefined()
        expect(first[0].level).toBe('selbst')
        expect(first[0].title).toContain('brauche einmal den Zugang')
        expect(first[0].proposal).toContain('Home-Assistant-Token')
        // Zweiter und dritter Suchlauf: keine weitere Bitte.
        await runtime.runDiscoveryNow(deps)
        await runtime.runDiscoveryNow(deps)
        expect(readThoughts(dataDir)).toHaveLength(1)
        expect(JSON.stringify(readThoughts(dataDir))).not.toMatch(/token["']?\s*:\s*["'][^"']{8,}/i)
    })

    it('Gegenprobe Konten: fehlender Login → genau eine Bitte, keine Karte, nie wiederholt', async () => {
        const dataDir = tmp('sense-acct-ask-')
        const expired = { version: 1, profiles: { google: { type: 'oauth', provider: 'google', access: 'x', refresh: 'r', expires: Date.now() - 1000, email: 'owner@example.com' } } }
        writeFileSync(join(dataDir, 'auth.json'), JSON.stringify(expired))
        runtime.setSensingConfig({}, {}, dataDir)
        await runtime.proposeAccounts()
        await runtime.proposeAccounts()
        const asks = readThoughts(dataDir)
        expect(asks).toHaveLength(1)
        expect(asks[0].action).toBeUndefined()
        expect(asks[0].title).toContain('brauche einmal deinen Login')
    })

    it('Suche ist aus, solange der Schalter auf false steht', async () => {
        runtime.setSensingConfig({ discovery: { enabled: false } }, {}, tmp('sense-dev-off-'))
        const probe = vi.fn()
        expect(await runtime.runDiscoveryNow({ tcpProbe: probe })).toContain('ist aus')
        expect(probe).not.toHaveBeenCalled()
    })

    it('Suche läuft selbst nach dem Start (ohne Befehl), nur am Main', async () => {
        vi.useFakeTimers()
        try {
            const dataDir = tmp('sense-auto-')
            runtime.setSensingConfig({ adapters: { printer: { enabled: false }, homeassistant: { enabled: false }, mail: { enabled: false }, system: { enabled: false } }, discovery: { firstRunDelaySec: 1, intervalHours: 1, mdns: false, deadlineSec: 1, maxHosts: 1 } }, {}, dataDir)
            const runner = vi.fn(async () => 'ok')
            expect(runtime.startSensing({ nodeOnly: true, discoveryRunner: runner })).toMatchObject({ started: false })
            await vi.advanceTimersByTimeAsync(5_000)
            expect(runner).not.toHaveBeenCalled()
            const started = runtime.startSensing({ nodeOnly: false, discoveryRunner: runner })
            expect(started).toMatchObject({ started: true })
            expect(started.reason).toContain('Geräte-Suche selbstständig')
            await vi.advanceTimersByTimeAsync(1_000)
            expect(runner).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(60 * 60_000)
            expect(runner).toHaveBeenCalledTimes(2)
            runtime.stopSensing()
            await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
            expect(runner).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('Eigene Systeme, Konten, Ruhezeiten', () => {
    it('System-Adapter meldet nur neue Zeilen (keine Altlasten beim Start)', async () => {
        const dataDir = tmp('sense-sys-')
        mkdirSync(join(dataDir, 'self-heal', 'journal'), { recursive: true })
        const file = join(dataDir, 'self-heal', 'journal', '2026-10-01.jsonl')
        const entry = (id: string) => JSON.stringify({ id, recipe: 'logs-rotieren', ergebnis: 'rueckweg-gescheitert', node: 'spark', at: '2026-10-01T02:00:00Z' })
        writeFileSync(file, `${entry('h1')}\n`)
        const adapter = createSystemAdapter({ dataDir, intervalMs: 1, timeoutMs: 1 })
        const state: Record<string, unknown> = {}
        expect(await adapter.poll({ signal: new AbortController().signal, now: 0, state })).toEqual([])
        appendFileSync(file, `${entry('h2')}\n`)
        const events = await adapter.poll({ signal: new AbortController().signal, now: 0, state })
        expect(events.map(e => [e.kind, e.severity])).toEqual([['system.self-heal', 'urgent']])
    })

    it('2.82.0 ein Wächter: Nachtwache-Befunde meldet nur der Wächter, nicht der System-Adapter', async () => {
        const dataDir = tmp('sense-nw-')
        mkdirSync(join(dataDir, 'nightwatch'), { recursive: true })
        const file = join(dataDir, 'nightwatch', '2026-10-01.jsonl')
        const report = (hour: string) => JSON.stringify({ startedAt: `2026-10-01T${hour}:00:00Z`, results: [{ id: 'vllm', label: 'vLLM', host: 'spark', status: 'fehler', severity: 'critical', message: 'HTTP 503' }] })
        writeFileSync(file, `${report('02')}\n`)
        const adapter = createSystemAdapter({ dataDir, intervalMs: 1, timeoutMs: 1 })
        const state: Record<string, unknown> = {}
        await adapter.poll({ signal: new AbortController().signal, now: 0, state })
        appendFileSync(file, `${report('03')}\n`)
        expect(await adapter.poll({ signal: new AbortController().signal, now: 0, state })).toEqual([])
    })

    it('Konten nur aus eigenen Quellen, ohne Token in der Ausgabe', () => {
        const dataDir = tmp('sense-acct-')
        // Fake OAuth value built at runtime (no key-like literal in the repo).
        const fakeAccess = ['ya29', 'SEHR', 'GEHEIM'].join('-')
        writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({ version: 1, profiles: { google: { type: 'oauth', provider: 'google', access: fakeAccess, refresh: 'r', expires: Date.now() + 3600_000, email: 'owner@example.com' } } }))
        const accounts = detectAccounts(parseSensingConfig({ enabled: true, adapters: { mail: { enabled: false } } }), readAuthProfileShapes(dataDir))
        expect(accounts).toHaveLength(1)
        expect(accounts[0]).toMatchObject({ kind: 'gmail', connected: false, needsOwnerLogin: false })
        // P8: with the (default-on) mail sensor and a valid token the account is read right away.
        expect(detectAccounts(parseSensingConfig({}, {} as NodeJS.ProcessEnv), readAuthProfileShapes(dataDir))[0]).toMatchObject({ connected: true })
        expect(accounts[0].label).toBe('Gmail own…@example.com')
        expect(JSON.stringify(accounts)).not.toContain('ya29')
    })

    it('Ruhezeiten: Vorschlag aus eigenen Zeitstempeln, sonst vorsichtiger Standard', () => {
        const dataDir = tmp('sense-quiet-')
        mkdirSync(join(dataDir, 'sessions'), { recursive: true })
        const lines: string[] = []
        for (let day = 1; day <= 14; day++) {
            for (const hour of [8, 9, 11, 13, 15, 17, 19, 21, 22]) { // UTC → 10..24/0 Uhr Wien (Sommerzeit)
                lines.push(JSON.stringify({ ts: new Date(Date.UTC(2026, 8, day, hour, 5)).toISOString(), channel: 'telegram', role: 'user', content: 'Privater Text' }))
                lines.push(JSON.stringify({ ts: new Date(Date.UTC(2026, 8, day, hour, 6)).toISOString(), channel: 'telegram', role: 'assistant', content: 'Antwort' }))
            }
        }
        writeFileSync(join(dataDir, 'sessions', 'alfred.jsonl'), `${lines.join('\n')}\n`)
        const ts = readOwnerTimestamps(dataDir, ['alfred'], Date.UTC(2026, 9, 1))
        expect(ts).toHaveLength(14 * 9)
        const proposal = learnQuietHours(ts, 'Europe/Vienna')
        expect(proposal.learned).toBe(true)
        expect(proposal).toMatchObject({ start: 1, end: 10 })
        expect(learnQuietHours(ts.slice(0, 20)).learned).toBe(false)
        expect(learnQuietHours([])).toMatchObject({ start: 22, end: 7, learned: false })
    })
})
