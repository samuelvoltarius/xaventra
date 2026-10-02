/**
 * 2.85 Paket I — der Wächter leitet seine Ziele selbst ab (Live-Befund
 * 02.10.: „Wächter-Ziele: 0“, „1 Knoten, 0/0 Ziele ok“ bei 5 Mesh-Knoten).
 * Testdaten nur example.com / Dokumentationsadressen, keine Netzaufrufe.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createThoughtStore } from '../planner/thoughts.js'
import { deriveWatchTargets, derivedSourcesFrom, isWatchableNodeAddress, type DerivedResult, type DerivedSources } from './derived.js'
import { buildWatchOverview, countWatchTargets, createWatchEngine, formatWatchStatusLines, resolveWatchTargets } from './engine.js'
import type { WatchProbeDeps } from './probes.js'
import type { WatchSample } from './sample.js'
import { parseWatchSettings } from './settings.js'
import { loadManagedTargets, removeManagedTarget } from './targets.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'waechter-selbst-')); dirs.push(dir); return dir }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const NOON = Date.UTC(2026, 9, 1, 10, 0)

const SOURCES: DerivedSources = {
    localNodeId: 'xaventra-spark',
    meshNodes: [
        { nodeId: 'xaventra-spark', url: 'http://spark.example.com:9091' },
        { nodeId: 'xaventra-ns1', url: 'http://ns1.example.com:9091' },
        { nodeId: 'xaventra-ns2', url: 'https://ns2.example.com:9443' },
        { nodeId: 'xaventra-nas', ip: '100.64.0.21' },
        { nodeId: 'xaventra-lab', ip: '172.17.0.2' }, // docker bridge: never
        { nodeId: 'alt', ip: '100.64.0.99', lifecycle: 'tombstoned' },
        { nodeId: 'nur-name' },
    ],
    devices: [
        { type: 'moonraker', name: 'Drucker', host: 'printer.example.com', port: 7125, status: 'eingerichtet' },
        { type: 'homeassistant', name: 'Home Assistant', host: 'ha.example.com', port: 8123, status: 'gefunden' },
        { type: 'octoprint', name: 'Alter Drucker', host: 'old.example.com', port: 80, status: 'abgelehnt' },
        { type: 'octoprint', name: 'Pausiert', host: 'paused.example.com', port: 80, status: 'aus' },
        { type: 'nas', name: 'Vaultwarden', host: 'vault.example.com', port: 443, status: 'gefunden' },
    ],
    aiServices: [
        { name: 'Ollama', host: 'localhost', port: 11434, status: 'running' },
        { name: 'vLLM', host: 'localhost', port: 8000, status: 'running', nodeId: 'xaventra-ns1' },
        { name: 'vLLM', host: 'gpu.example.com', port: 8000, status: 'running', nodeId: 'xaventra-lab' },
        { name: 'ComfyUI', host: 'localhost', port: 8188, status: 'installed' },
    ],
    proxmoxUrl: 'https://pve.example.com:8006',
}

describe('selbst abgeleitete Wächter-Ziele: feste Regeln', () => {
    it('leitet Knoten, Proxmox, Geräte und laufende KI-Dienste ab — gekennzeichnet als selbst, ohne Raten', () => {
        const { targets, tls } = deriveWatchTargets(SOURCES)
        expect(targets.map(target => `${target.kind} ${target.host}${target.port ? `:${target.port}` : ''} ${target.origin}`)).toEqual([
            'ping 100.64.0.21 selbst',
            'tcp ns1.example.com:9091 selbst',
            'tcp ns2.example.com:9443 selbst',
            'tcp pve.example.com:8006 selbst',
            'tcp ha.example.com:8123 selbst',
            'tcp printer.example.com:7125 selbst',
            'tcp gpu.example.com:8000 selbst',
            'tcp 127.0.0.1:11434 selbst',
        ])
        expect(targets.map(target => target.name)).toContain('Knoten xaventra-ns1')
        expect(tls).toEqual([
            { name: 'Knoten xaventra-ns2', host: 'ns2.example.com', port: 9443 },
            { name: 'Proxmox', host: 'pve.example.com', port: 8006 },
        ])
    })

    it('ist deterministisch (Reihenfolge der Quellen egal) und hat eine Obergrenze', () => {
        const shuffled: DerivedSources = { ...SOURCES, meshNodes: [...SOURCES.meshNodes].reverse(), devices: [...SOURCES.devices].reverse(), aiServices: [...SOURCES.aiServices].reverse() }
        expect(deriveWatchTargets(shuffled)).toEqual(deriveWatchTargets(SOURCES))
        const many: DerivedSources = { localNodeId: 'x', meshNodes: [], aiServices: [], devices: Array.from({ length: 80 }, (_, index) => ({ type: 'moonraker', name: `D${index}`, host: `d${index}.example.com`, port: 7125, status: 'gefunden' })) }
        expect(deriveWatchTargets(many).targets).toHaveLength(24)
    })

    it('Adressregel: nur Tailnet/LAN, nie Docker, Loopback oder Link-local', () => {
        expect(['100.64.0.1', '100.127.255.254', '10.0.0.5', '192.168.1.2'].every(isWatchableNodeAddress)).toBe(true)
        expect(['172.17.0.2', '127.0.0.1', '169.254.1.1', '100.128.0.1', '8.8.8.8', 'nas.example.com', ''].some(isWatchableNodeAddress)).toBe(false)
    })

    it('includeDevices=false hält auch gefundene Geräte heraus; vom Owner entfernte Ziele kommen nicht wieder', () => {
        const noDevices = deriveWatchTargets(SOURCES, { includeDevices: false }).targets
        expect(noDevices.some(target => target.host.endsWith('printer.example.com') || target.host === 'ha.example.com')).toBe(false)
        const removed = deriveWatchTargets(SOURCES, { removed: ['tcp:ns1.example.com:9091', 'tls:pve.example.com:8006'] })
        expect(removed.targets.some(target => target.host === 'ns1.example.com')).toBe(false)
        expect(removed.tls.map(item => item.host)).toEqual(['ns2.example.com'])
    })

    it('Owner-Ziele haben Vorrang: gleicher Host und Port wird nicht doppelt geprüft', () => {
        const settings = parseWatchSettings({ watch: { targets: [{ name: 'Mein Drucker', host: 'printer.example.com', kind: 'http', port: 7125, path: '/server/info' }] } })
        const derived = deriveWatchTargets(SOURCES).targets
        const { targets } = resolveWatchTargets(settings, [{ name: 'HA', host: 'ha.example.com', port: 8123 }], [], derived)
        expect(targets.filter(target => target.host === 'printer.example.com').map(target => target.origin)).toEqual(['config'])
        expect(targets.filter(target => target.host === 'ha.example.com').map(target => target.origin)).toEqual(['geraet'])
        expect(targets.filter(target => target.origin === 'selbst')).toHaveLength(derived.length - 2)
    })

    it('baut die Quellen aus Config-Peers, Registry, Scan und Proxmox (eigene Dienste heißen beim Scanner „local“)', () => {
        const sources = derivedSourcesFrom({
            localNodeId: 'xaventra-spark',
            now: NOON,
            config: {
                mesh: { direct: { peers: [{ nodeId: 'xaventra-ns1', url: 'http://ns1.example.com:9091' }, { name: 'xaventra-nas' }] } },
                infra: { proxmox: { enabled: true, url: 'https://pve.example.com', fingerprint: 'AA:'.repeat(31) + 'AA' } },
            },
            registryNodes: [
                { node_id: 'xaventra-nas', ip: '100.64.0.21', last_heartbeat: new Date(NOON - 60_000).toISOString() },
                { node_id: 'weg', ip: '100.64.0.30', last_heartbeat: new Date(NOON - 30 * 86_400_000).toISOString() },
            ],
            scanServices: [
                { name: 'Ollama', host: 'localhost', port: 11434, status: 'running', sourceNode: 'local' },
                { name: 'vLLM', host: 'localhost', port: 8000, status: 'running', sourceNode: 'ns1', metadata: { source: 'mesh-advertised', nodeId: 'xaventra-ns1' } },
            ],
        })
        expect(sources.proxmoxUrl).toBe('https://pve.example.com:8006')
        expect(sources.aiServices.map(service => service.nodeId)).toEqual([undefined, 'xaventra-ns1'])
        const { targets } = deriveWatchTargets(sources)
        expect(targets.map(target => target.id)).toEqual(['ping:100.64.0.21', 'tcp:ns1.example.com:9091', 'tcp:pve.example.com:8006', 'tcp:127.0.0.1:11434'])
    })
})

function sample(nodeId: string, at: number): WatchSample {
    return { schema: 1, nodeId, at: new Date(at).toISOString(), cpuLoad: 0.2, ramUsedPct: 40, ramTotalGB: 16, disks: [{ mount: '/', usedPct: 50, totalGB: 100, freeGB: 50 }], tempC: null, services: [], responseMs: 1 }
}

function engineWith(clock: { now: number }, derived: DerivedResult, probes: Partial<WatchProbeDeps>) {
    const dataDir = tmp()
    const watchDir = join(dataDir, 'watch')
    const thoughts = createThoughtStore({ dataDir, now: () => clock.now })
    const calls: string[] = []
    const engine = createWatchEngine({
        // watch.enabled is NOT set: the runtime hands the engine `enabled: true` once anything is to be watched.
        settings: { ...parseWatchSettings({}), enabled: true },
        watchDir,
        localNodeId: 'xaventra-spark',
        isMain: () => true,
        collect: async () => sample('xaventra-spark', clock.now),
        devices: () => [],
        derivedTargets: async () => derived,
        probes: {
            async tcp(host, port) { calls.push(`tcp ${host}:${port}`); return { ok: true, ms: 2, detail: 'verbunden' } },
            async http(url) { calls.push(`http ${url}`); return { ok: true, ms: 2, detail: 'HTTP 200' } },
            async ping(host) { calls.push(`ping ${host}`); return { ok: true, ms: 1, detail: 'Antwort' } },
            async tlsValidTo(host, port) { calls.push(`tls ${host}:${port}`); return clock.now + 90 * 86_400_000 },
            newestMtime: () => null,
            now: () => clock.now,
            ...probes,
        },
        thoughts: { add: input => thoughts.add(input), resolve: id => thoughts.setStatus(id, 'erledigt', 'waechter') },
    })
    return { engine, thoughts, calls, watchDir }
}

describe('selbst abgeleitete Ziele im Wächter-Lauf', () => {
    it('prüft sie mit den vorhandenen Proben (tcp/ping, TLS nur Ablauf) und legt dabei keinen Gedanken an', async () => {
        const clock = { now: NOON }
        const derived = deriveWatchTargets(SOURCES)
        const { engine, thoughts, calls, watchDir } = engineWith(clock, derived, {})
        const result = await engine.tick()
        expect(result.targets).toBe(derived.targets.length)
        expect(calls).toContain('tcp ns1.example.com:9091')
        expect(calls).toContain('ping 100.64.0.21')
        expect(calls).toContain('tls pve.example.com:8006')
        expect(calls.some(call => call.startsWith('http'))).toBe(false)
        expect(thoughts.list()).toEqual([])
        const snapshot = JSON.parse(readFileSync(join(watchDir, 'snapshot.json'), 'utf8'))
        expect(snapshot.reachability.every((item: any) => item.origin === 'selbst')).toBe(true)
        expect(snapshot.certs.map((cert: any) => cert.host)).toEqual(['ns2.example.com', 'pve.example.com'])
    })

    it('erstmaliger Ausfall nach „ok“: genau ein stilles Ereignis (keine Karte); nie erreicht: kein Alarm', async () => {
        const clock = { now: NOON }
        let ns1Up = true
        const derived = deriveWatchTargets({ ...SOURCES, devices: [], aiServices: [], proxmoxUrl: null })
        const { engine, thoughts } = engineWith(clock, derived, {
            async tcp(host) { return host === 'ns1.example.com' && ns1Up ? { ok: true, ms: 2, detail: 'verbunden' } : { ok: false, ms: null, detail: 'ECONNREFUSED' } },
        })
        await engine.tick(); clock.now += 300_000
        ns1Up = false
        for (let i = 0; i < 4; i++) { await engine.tick(); clock.now += 300_000 }
        const down = thoughts.list().filter(item => item.title.includes('nicht erreichbar'))
        expect(down.map(item => item.title)).toEqual(['Knoten xaventra-ns1 nicht erreichbar'])
        expect(down[0].kind).toBe('ereignis')
        expect(down[0].proposal).toBeUndefined()
        // ns2 was never reachable from here: no alarm, no recovery message later either.
        ns1Up = true
        await engine.tick()
        expect(thoughts.list().filter(item => item.title.includes('wieder erreichbar')).map(item => item.title)).toEqual(['Knoten xaventra-ns1 wieder erreichbar'])
        expect(thoughts.list().some(item => item.title.includes('xaventra-ns2'))).toBe(false)
    })
})

describe('Status und Knoten: echte Zahl, Messwerte der anderen Knoten aus dem Herzschlag', () => {
    it('/status-Zahl = Ziele der letzten Runde; Knoten aus signierten Herzschlag-Werten, ohne neue Verbindung', async () => {
        const clock = { now: NOON }
        const { engine, watchDir } = engineWith(clock, deriveWatchTargets(SOURCES), {})
        await engine.tick()
        const peers = [
            { nodeId: 'xaventra-ns1', lastSeen: NOON - 30_000, hardware: { cores: 4, cpu_load: 2, ram_used_percent: 61, disk_gb: 100, disk_free_gb: 20, temp: 48 } },
            { nodeId: 'xaventra-nas', lastSeen: NOON - 60_000, hardware: { cores: 2, ram_used_percent: 30 } },
            { nodeId: 'xaventra-spark', lastSeen: NOON, hardware: { ram_used_percent: 99 } }, // own: the sample wins
            { nodeId: 'uralt', lastSeen: NOON - 3 * 86_400_000, hardware: { ram_used_percent: 10 } },
            { nodeId: 'ohne-werte', lastSeen: NOON },
        ]
        const overview = buildWatchOverview({ ...parseWatchSettings({}), enabled: true }, watchDir, NOON, peers)
        expect(overview.nodes.map(node => `${node.nodeId}:${node.source}`)).toEqual(['xaventra-nas:herzschlag', 'xaventra-ns1:herzschlag', 'xaventra-spark:messung'])
        const ns1 = overview.nodes.find(node => node.nodeId === 'xaventra-ns1')!
        expect(ns1.ramUsedPct).toBe(61)
        expect(ns1.cpuLoad).toBe(0.5)
        expect(ns1.disks[0].usedPct).toBe(80)
        expect(ns1.tempC).toBe(48)
        expect(overview.nodes.find(node => node.nodeId === 'xaventra-spark')!.ramUsedPct).toBe(40)
        expect(countWatchTargets(overview)).toBe(8)
        expect(formatWatchStatusLines(overview)[0]).toMatch(/^Wächter: 3 Knoten, 8\/8 Ziele ok/)
    })

    it('ohne Lauf zählt die Status-Zahl 0, nicht nur Config + /monitor', () => {
        expect(countWatchTargets(buildWatchOverview(parseWatchSettings({}), tmp(), NOON))).toBe(0)
        const slash = readFileSync(new URL('../core/slash-commands.ts', import.meta.url), 'utf8')
        expect(slash).toMatch(/countWatchTargets\(/)
    })

    it('Worker-Messwerte werden angenommen, sobald der Wächter läuft — nicht erst mit autonomy.watch.enabled', async () => {
        const runtime = await import('./runtime.js')
        runtime.setWatchConfig({ watch: { enabled: false } }, { nightwatch: { enabled: true, configPath: join(tmp(), 'nightwatch.json'), journalDir: tmp() } })
        try {
            const result = await runtime.ingestPeerWatchSample('xaventra-ns1', sample('xaventra-ns1', Date.now()), ['xaventra-ns1'])
            expect(result.reason).not.toBe('aus')
        } finally {
            runtime.setWatchConfig(undefined)
        }
    })
})

describe('Owner entfernt ein selbst abgeleitetes Ziel', () => {
    it('/monitor remove vermerkt es; danach wird es nie wieder abgeleitet', () => {
        const watchDir = tmp()
        const derived = deriveWatchTargets(SOURCES).targets
        expect(removeManagedTarget(watchDir, 'knoten xaventra-ns1', derived)).toBe(true)
        expect(removeManagedTarget(watchDir, 'gibt es nicht', derived)).toBe(false)
        const stored = loadManagedTargets(watchDir)
        expect(stored.targets).toEqual([])
        expect(stored.removedDerived).toEqual(['tcp:ns1.example.com:9091'])
        const again = deriveWatchTargets(SOURCES, { removed: stored.removedDerived })
        expect(again.targets.some(target => target.name === 'Knoten xaventra-ns1')).toBe(false)
    })
})

describe('2.85 Integration I ← A/C: neue Funde der Discovery werden ohne Zusatzregel Wächter-Ziele', () => {
    it('selbst gehostete Dienste (Paket A) und Hilfsdienste im eigenen Netz (Paket C) erscheinen als Ziele', () => {
        const sources = derivedSourcesFrom({
            localNodeId: 'xaventra-spark',
            devices: [
                { type: 'paperless', name: 'Paperless-ngx (Dokumente)', host: 'docs.example.com', port: 8000, status: 'gefunden' },
                { type: 'n8n', name: 'n8n (Automationen)', host: 'flows.example.com', port: 5678, status: 'gefunden' },
                { type: 'immich', name: 'Immich (Fotos)', host: 'fotos.example.com', port: 2283, status: 'abgelehnt' },
            ],
            scanServices: [{ name: 'searxng', host: 'search.example.com', port: 8088, status: 'running', sourceNode: 'local', metadata: { source: 'own-network' } }],
        })
        const names = deriveWatchTargets(sources).targets.map(target => `${target.name} ${target.host}:${target.port} ${target.origin}`)
        expect(names).toEqual(expect.arrayContaining([
            'Paperless-ngx (Dokumente) docs.example.com:8000 selbst',
            'n8n (Automationen) flows.example.com:5678 selbst',
            'KI-Dienst searxng search.example.com:8088 selbst',
        ]))
        expect(names.some(name => name.includes('fotos.example.com'))).toBe(false)
    })
})
