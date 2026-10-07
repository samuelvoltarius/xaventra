/**
 * 2.85 Paket C — der vorhandene KI-Dienst-Scanner findet auch unbekannte
 * Geräte im eigenen LAN/Tailnet (net-scope-Regeln), erkennt SearXNG und
 * loggt den 5-min-Lokalscan nur noch bei Änderung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mesh-registry.js', () => ({
    discoverNodes: async () => [],
    updateLocalAIServices: async () => undefined,
    getLocalNodeId: () => 'test-node',
}))
vi.mock('./capability-graph.js', () => ({ getCapabilityGraph: () => ({ ingest: () => ({ nodes: [] }) }) }))
vi.mock('./capability-graph-sync.js', () => ({ syncCapabilityGraphOnce: async () => undefined }))

import {
    AI_SERVICE_PROBES, getDiscoveredSearxngUrl, isSearxngConfig, scanAllAIServices, scanOwnNetworkAIServices,
    type DiscoveredAIService,
} from './ai-scanner.js'
import { resetAiProbeClient, type DiscoveryProbeClient } from './discovery-probe.js'

const LAN = { eth0: [{ address: '192.168.50.10', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const TAGS = JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] })
const SEARX = JSON.stringify({ instance_name: 'SearXNG', categories: ['general'], engines: [{ name: 'wikipedia' }], safe_search: 0 })

const ALLOWED_PATHS = new Set(AI_SERVICE_PROBES.flatMap(probe => [probe.healthEndpoint, probe.modelsEndpoint].filter(Boolean) as string[]))

function fakeNet(open: Record<string, number[]>, bodies: Record<string, string>) {
    const tcp: string[] = []
    const http: string[] = []
    return {
        tcp, http,
        deps: {
            interfaces: LAN as any,
            tcpProbe: async (host: string, port: number) => { tcp.push(`${host}:${port}`); return (open[host] || []).includes(port) },
            httpGet: async (url: string) => { http.push(url); return bodies[url] ?? null },
            sleep: async () => undefined,
        },
    }
}

const opts = { deadlineMs: 60_000, ratePerSec: 1000, concurrency: 8, maxHosts: 512, tailnetHosts: [] as string[] }

describe('KI-Scanner: Phase eigenes Netz', () => {
    it('findet Ollama und SearXNG auf fremden Geräten im eigenen /24, nur über erlaubte lesende Pfade', async () => {
        const net = fakeNet(
            { '192.168.50.20': [11434], '192.168.50.30': [8888] },
            { 'http://192.168.50.20:11434/api/tags': TAGS, 'http://192.168.50.30:8888/config': SEARX },
        )
        const report = await scanOwnNetworkAIServices(opts, net.deps)
        const byId = Object.fromEntries(report.services.map(service => [service.id, service]))
        expect(byId['ollama@192.168.50.20:11434']).toMatchObject({ type: 'llm', status: 'running', sourceNode: '192.168.50.20', models: ['qwen3:8b', 'nomic-embed-text'], metadata: { source: 'own-network', datenklasse: 'lokal' } })
        expect(byId['ollama-embeddings@192.168.50.20:11434']).toMatchObject({ type: 'embeddings', models: ['nomic-embed-text'] })
        expect(byId['searxng@192.168.50.30:8888']).toMatchObject({ type: 'search', endpoint: 'http://192.168.50.30:8888' })
        // own address is phase 1's job; every HTTP path is a known read-only probe path
        expect(net.tcp.some(entry => entry.startsWith('192.168.50.10:'))).toBe(false)
        for (const url of net.http) expect(ALLOWED_PATHS.has(new URL(url).pathname)).toBe(true)
        // HTTP only after an open TCP port
        expect(net.http.every(url => ['192.168.50.20', '192.168.50.30'].includes(new URL(url).hostname))).toBe(true)
    })

    it('öffentliche oder fremde Adressen werden nie angefasst; Tailnet nur mit eigenem Interface', async () => {
        const net = fakeNet({}, {})
        const report = await scanOwnNetworkAIServices({ ...opts, maxHosts: 4, tailnetHosts: ['8.8.8.8', '100.64.7.5', '10.9.9.9'] }, net.deps)
        const hosts = new Set(net.tcp.map(entry => entry.split(':')[0]))
        for (const forbidden of ['8.8.8.8', '100.64.7.5', '10.9.9.9']) expect(hosts.has(forbidden)).toBe(false)
        expect(report.rejected.map(item => item.host).sort()).toEqual(['10.9.9.9', '100.64.7.5', '8.8.8.8'])
        expect([...hosts].every(host => host.startsWith('192.168.50.'))).toBe(true)
    })

    it('harte Gesamtzeit: nach Ablauf keine neue Verbindung', async () => {
        let t = 0
        const net = fakeNet({}, {})
        const deps = { ...net.deps, now: () => t, tcpProbe: async (host: string, port: number) => { net.tcp.push(`${host}:${port}`); t += 50; return false } }
        const report = await scanOwnNetworkAIServices({ ...opts, deadlineMs: 1000, concurrency: 1 }, deps)
        expect(report.timedOut).toBe(true)
        expect(net.tcp.length).toBeLessThanOrEqual(21)
    })

    it('Rate-Limit: höchstens ratePerSec Verbindungsstarts pro Sekunde', async () => {
        let t = 0
        const net = fakeNet({}, {})
        const deps = { ...net.deps, now: () => t, sleep: async (ms: number) => { t += ms } }
        const report = await scanOwnNetworkAIServices({ ...opts, deadlineMs: 2000, ratePerSec: 10, concurrency: 4 }, deps)
        expect(report.probes).toBeLessThanOrEqual(21)
    })
})

describe('SearXNG erkennen', () => {
    it('erkennt die /config-Antwort, nicht beliebiges JSON', () => {
        expect(isSearxngConfig(SEARX)).toBe(true)
        expect(isSearxngConfig(JSON.stringify({ data: [] }))).toBe(false)
        expect(isSearxngConfig('<html>searxng</html>')).toBe(false)
        expect(AI_SERVICE_PROBES.filter(probe => probe.name === 'searxng').map(probe => probe.defaultPort).sort()).toEqual([8080, 8088, 8888])
    })

    it('bevorzugt eine Instanz auf diesem Rechner vor einer im LAN', () => {
        const svc = (host: string, sourceNode: string): DiscoveredAIService => ({ id: `searxng@${host}`, name: 'searxng', type: 'search', provider: 'searxng', host, port: 8888, endpoint: `http://${host}:8888`, models: [], status: 'running', lastSeen: '2026-10-02T00:00:00Z', sourceNode })
        expect(getDiscoveredSearxngUrl([svc('192.168.50.30', '192.168.50.30'), svc('localhost', 'local')])).toBe('http://localhost:8888')
        expect(getDiscoveredSearxngUrl([svc('192.168.50.30', '192.168.50.30')])).toBe('http://192.168.50.30:8888')
        expect(getDiscoveredSearxngUrl([])).toBeNull()
    })
})

describe('Scanlauf: Netz-Phase eingebunden, Log nur bei Änderung', () => {
    let bodies: Record<string, string | null> = {}
    beforeEach(() => {
        vi.stubEnv('NOVA_NODE_ONLY', '')
        vi.stubEnv('NOVA_NO_SIDE_EFFECTS', '')
        bodies = {}
        resetAiProbeClient({
            probe: async (url: string) => bodies[url] ?? null,
            allowsService: () => true,
            recordService: () => undefined,
            lastLatency: () => null,
        } as unknown as DiscoveryProbeClient)
    })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetAiProbeClient() })

    it('5-min-Lokalscan: unverändert → keine Zeile; Änderung → Zeilen', async () => {
        const logs: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
        const light = { forceFresh: true, skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, logOnlyOnChange: true }
        await scanAllAIServices(light)
        logs.length = 0
        await scanAllAIServices(light)
        expect(logs.filter(line => line.includes('[AIScan]'))).toEqual([])
        bodies['http://localhost:11434/api/tags'] = TAGS
        await scanAllAIServices(light)
        expect(logs.some(line => line.includes('[AIScan]') && line.includes('ollama'))).toBe(true)
    })

    it('Netz-Funde landen im Scan-Ergebnis und bleiben bis zum nächsten stündlichen Lauf erhalten', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const found: DiscoveredAIService = { id: 'vllm@192.168.50.40:8000', name: 'vllm', type: 'llm', provider: 'vllm', host: '192.168.50.40', port: 8000, endpoint: 'http://192.168.50.40:8000', models: ['qwen'], status: 'running', lastSeen: new Date().toISOString(), sourceNode: '192.168.50.40', metadata: { source: 'own-network' } }
        const ownNetworkScan = vi.fn(async () => ({ services: [found], scannedHosts: 254, probes: 10, rejected: [], timedOut: false, durationMs: 5 }))
        const first = await scanAllAIServices({ forceFresh: true, skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, ownNetwork: true, ownNetworkScan })
        expect(ownNetworkScan).toHaveBeenCalledTimes(1)
        expect(first.services.map(service => service.id)).toContain('vllm@192.168.50.40:8000')
        const later = await scanAllAIServices({ forceFresh: true, skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, ownNetworkScan })
        expect(ownNetworkScan).toHaveBeenCalledTimes(1)
        expect(later.services.map(service => service.id)).toContain('vllm@192.168.50.40:8000')
    })

    it('Netz-Phase aus im Test-/Abnahmemodus (NOVA_NO_SIDE_EFFECTS=1): kein Netzscan in CI', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.stubEnv('NOVA_NO_SIDE_EFFECTS', '1')
        const ownNetworkScan = vi.fn(async () => ({ services: [], scannedHosts: 0, probes: 0, rejected: [], timedOut: false, durationMs: 0 }))
        await scanAllAIServices({ forceFresh: true, skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, ownNetwork: true, ownNetworkScan })
        expect(ownNetworkScan).not.toHaveBeenCalled()
    })

    it('Netz-Phase aus, wenn autonomy.sensing.discovery.enabled=false', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const previous = (globalThis as any).__novaState
        ;(globalThis as any).__novaState = { ...(previous || {}), config: { autonomy: { sensing: { discovery: { enabled: false } } } } }
        try {
            const ownNetworkScan = vi.fn(async () => ({ services: [], scannedHosts: 0, probes: 0, rejected: [], timedOut: false, durationMs: 0 }))
            await scanAllAIServices({ forceFresh: true, skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, ownNetwork: true, ownNetworkScan })
            expect(ownNetworkScan).not.toHaveBeenCalled()
        } finally { (globalThis as any).__novaState = previous }
    })
})
