/**
 * 2.85 Paket C, Live-Befund Spark 02.10.: Der Software-Scout sagte „kein Ollama
 * auf dem Knoten“, der KI-Scanner „installiert“. Eine Quelle (Scanner) und drei
 * Zustände: läuft / installiert, aber aus / fehlt. Ein installiertes, gestopptes
 * Ollama wird nie von selbst gestartet oder installiert — kein Vorschlag, der es
 * bräuchte.
 */
import { describe, expect, it, vi } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'

const scan = vi.hoisted(() => ({ services: [] as any[], scanned: true }))
vi.mock('../core/node-profile.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../core/node-profile.js')>()),
    collectNodeProfile: async () => profile({ nodeId: 'xaventra-spark', services: [{ name: 'vllm', type: 'llm', status: 'running' }] }),
}))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ getMeshPeerStates: () => ({}) }))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'xaventra-spark' }))
vi.mock('../mesh/ai-scanner.js', () => ({
    getLastScanResult: () => (scan.scanned ? { lastScan: '2026-10-02T08:00:00Z', scanDurationMs: 1, services: scan.services } : null),
    getDiscoveredServices: () => scan.services,
}))

import { findSoftwareCandidate } from './software-candidates.js'
import { assessCandidate, collectScoutNodes, ollamaState, type ScoutNode } from './software-scout.js'

function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'n', hostname: 'h', platform: 'linux', arch: 'arm64', version: '2.84.0', role: 'main', runtime: 'native',
        rootReadOnly: false, noNewPrivileges: true, cpus: 20, ramGB: 120, gpu: { name: null, backend: 'cpu', viaVllm: false }, services: [],
        installPath: 'host-agent', tools: ['apt'],
        selfCheck: { status: 'ok', checkedAt: '2026-10-02T07:59:00.000Z', items: [
            { id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: '40 % belegt, 800 GB frei' },
            { id: 'memory', label: 'Arbeitsspeicher', status: 'ok', detail: '35 % frei' },
        ] },
        collectedAt: '2026-10-02T07:59:00.000Z', ...over,
    } as NodeProfile
}
const node = (services: NodeProfile['services']): ScoutNode => ({ nodeId: 'xaventra-spark', local: true, profile: profile({ services }) })
const model = findSoftwareCandidate('embedding-nomic-embed-text')!

describe('Ollama: läuft / installiert, aber aus / fehlt', () => {
    it('drei Zustände aus den Diensten', () => {
        expect(ollamaState(profile({ services: [{ name: 'ollama', type: 'llm', status: 'running' }] }))).toBe('laeuft')
        expect(ollamaState(profile({ services: [{ name: 'ollama', type: 'llm', status: 'installed' }] }))).toBe('aus')
        expect(ollamaState(profile({ services: [{ name: 'ollama', type: 'llm', status: 'stopped' }] }))).toBe('aus')
        expect(ollamaState(profile({ services: [] }))).toBe('fehlt')
    })

    it('installiert, aber aus → kein Vorschlag, der Ollama starten müsste; ehrlicher Grund', () => {
        const fit = assessCandidate(model, node([{ name: 'ollama', type: 'llm', status: 'installed' }]))
        expect(fit.status).toBe('passt-nicht')
        expect(fit.route).toBe('keiner')
        expect(fit.reasons[0]).toMatch(/Ollama installiert, aber aus/)
        expect(fit.reasons[0]).toMatch(/nicht von selbst gestartet/)
    })

    it('fehlt → wie bisher „kein Ollama“, läuft → kein Ollama-Grund', () => {
        expect(assessCandidate(model, node([])).reasons[0]).toMatch(/kein Ollama auf dem Knoten/)
        const running = assessCandidate(model, node([{ name: 'ollama', type: 'llm', status: 'running' }]))
        expect(running.reasons.join(' ')).not.toMatch(/Ollama installiert, aber aus|kein Ollama/)
    })

    it('eigener Knoten: der Scout übernimmt den Zustand aus dem KI-Scanner (eine Quelle)', async () => {
        scan.scanned = true
        scan.services = [
            { id: 'vllm@localhost:8000', name: 'vllm', type: 'llm', status: 'running', endpoint: 'http://localhost:8000', host: 'localhost', sourceNode: 'local', models: ['qwen'] },
            { id: 'ollama-installed', name: 'ollama', type: 'llm', status: 'installed', endpoint: '', host: 'localhost', sourceNode: 'local', models: [] },
            { id: 'ollama@192.168.50.20:11434', name: 'ollama', type: 'llm', status: 'running', endpoint: 'http://192.168.50.20:11434', host: '192.168.50.20', sourceNode: '192.168.50.20', models: ['llama3.2:3b'] },
        ]
        const [own] = await collectScoutNodes()
        expect(own.local).toBe(true)
        expect(ollamaState(own.profile)).toBe('aus')
        expect(own.profile.services).toEqual(expect.arrayContaining([{ name: 'ollama', type: 'llm', status: 'installed' }, { name: 'vllm', type: 'llm', status: 'running' }]))
        // a running Ollama on another LAN device is not this node's Ollama
        expect(own.profile.services!.some(item => item.name === 'ollama' && item.status === 'running')).toBe(false)
    })
})
