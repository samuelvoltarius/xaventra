import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2.82.0 (DOPPELUNGEN Gruppe 1, Punkt 2): L21 meldete einen Ausfall alle
// 30 min erneut, solange er dauerte, und dieselbe Meldung landete zusätzlich
// über die Insight Engine in der nächsten Chat-Antwort. Jetzt: genau eine
// Meldung beim Übergang (entprellt) und genau eine bei der Erholung.

const ssh = vi.hoisted(() => ({ fail: true }))
const execFile = vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    if (ssh.fail) cb(new Error('Connection timed out'), '', '')
    else cb(null, '', '')
})
vi.mock('node:child_process', () => ({ exec: vi.fn(), execFile }))
vi.mock('../mesh/node-intelligence.js', () => ({ NodeIntelligence: { getOrDiscover: vi.fn(async () => ({ healthCmd: 'uptime' })), discover: vi.fn(async () => ({ healthCmd: 'uptime' })) } }))
vi.mock('../mesh/ai-scanner.js', () => ({ getLastScanResult: () => null }))
vi.mock('../core/health-contract.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    probeHttpService: vi.fn(async (name: string, url: string) => ({ name, url, state: 'down' })),
}))
const mesh = vi.hoisted(() => ({ nodes: [] as any[] }))
vi.mock('../mesh/mesh-registry.js', () => ({
    discoverNodes: vi.fn(async () => mesh.nodes),
    getOnlineNodes: vi.fn(async () => mesh.nodes.filter(node => node.status !== 'offline')),
}))

const { getNodeHealthMonitor, nodeAlertTransitions } = await import('./L21-node-health.js')

const snap = (online: boolean, warnings: string[] = []) => ({ name: 'Pi5', host: 'pi@192.0.2.21', online, timestamp: 0, warnings })

async function freshMonitor() {
    const monitor = getNodeHealthMonitor() as any
    monitor.stop()
    await new Promise(resolve => setTimeout(resolve, 20))
    monitor.history = { snapshots: [], lastAlert: {} }
    monitor.lastSnapshots = new Map()
    const alerts: Array<{ message: string; kind?: string }> = []
    monitor.setAlertCallback(async (message: string, kind?: string) => { alerts.push({ message, kind }) })
    return { monitor, alerts }
}

describe('L21: one message per transition, one per recovery', () => {
    beforeEach(() => { ssh.fail = true; mesh.nodes = []; execFile.mockClear() })

    it('pure transitions: debounced alarm once, recovery once, nothing in between', () => {
        let state: any
        const alarms: string[] = []
        const recovered: string[] = []
        for (let i = 0; i < 12; i++) {
            const result = nodeAlertTransitions(state, snap(false, ['Erreichbarkeit unbekannt: SSH fehlgeschlagen']), `t${i}`)
            state = result.state
            alarms.push(...result.alarms)
            recovered.push(...result.recovered)
        }
        expect(alarms).toHaveLength(1)
        expect(recovered).toHaveLength(0)
        for (let i = 0; i < 3; i++) {
            const result = nodeAlertTransitions(state, snap(true), `ok${i}`)
            state = result.state
            alarms.push(...result.alarms)
            recovered.push(...result.recovered)
        }
        expect(alarms).toHaveLength(1)
        expect(recovered).toHaveLength(1)
    })

    it('a single failed probe (flap) does not alarm', () => {
        const first = nodeAlertTransitions(undefined, snap(false, ['Erreichbarkeit unbekannt: x']), 'a')
        const second = nodeAlertTransitions(first.state, snap(true), 'b')
        expect([...first.alarms, ...second.alarms, ...second.recovered]).toEqual([])
    })

    it('a new, different problem on an already alarmed node is its own message; changing numbers are not', () => {
        let result = nodeAlertTransitions(undefined, snap(true, ['Speicherplatz knapp: 91% belegt']), 'a')
        result = nodeAlertTransitions(result.state, snap(true, ['Speicherplatz knapp: 92% belegt']), 'b')
        expect(result.alarms).toHaveLength(1)
        result = nodeAlertTransitions(result.state, snap(true, ['Speicherplatz knapp: 93% belegt']), 'c')
        expect(result.alarms).toHaveLength(0)
        result = nodeAlertTransitions(result.state, snap(true, ['Speicherplatz knapp: 93% belegt', 'RAM kritisch: 97% belegt']), 'd')
        result = nodeAlertTransitions(result.state, snap(true, ['Speicherplatz knapp: 93% belegt', 'RAM kritisch: 97% belegt']), 'e')
        expect(result.alarms).toEqual(['RAM kritisch: 97% belegt'])
    })

    it('ssh node down for 40 min: one alert; back up: one recovery', async () => {
        const { monitor, alerts } = await freshMonitor()
        monitor.nodes = [{ name: 'Pi5', host: 'pi@192.0.2.21', role: 'edge' }]
        // 5-min takt over 40 min (the old 30-min cooldown re-alerted after 30 min)
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            for (let i = 0; i < 8; i++) { await monitor.checkAllNodes(); vi.setSystemTime(Date.now() + 5 * 60_000) }
        } finally { vi.useRealTimers() }
        expect(alerts).toHaveLength(1)
        expect(alerts[0].kind).toBe('alarm')
        ssh.fail = false
        for (let i = 0; i < 3; i++) await monitor.checkAllNodes()
        expect(alerts).toHaveLength(2)
        expect(alerts[1].kind).toBe('erholt')
        expect(alerts[1].message).toMatch(/Pi5/)
    })

    it('a mesh node that stops its heartbeat is reported once (Self-Doctor no longer repeats it); a long-dead registry row is not', async () => {
        const { monitor, alerts } = await freshMonitor()
        monitor.nodes = []
        const recent = new Date(Date.now() - 20 * 60_000).toISOString()
        const ancient = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
        mesh.nodes = [
            { node_id: 'worker-b', hostname: 'worker-b', ip: '198.51.100.7', status: 'offline', last_heartbeat: recent, capabilities: [] },
            { node_id: 'old-c', hostname: 'old-c', ip: '198.51.100.8', status: 'offline', last_heartbeat: ancient, capabilities: [] },
        ]
        for (let i = 0; i < 6; i++) await monitor.checkAllNodes()
        expect(alerts).toHaveLength(1)
        expect(alerts[0].message).toMatch(/worker-b/)
        mesh.nodes = [{ ...mesh.nodes[0], status: 'online', last_heartbeat: new Date().toISOString() }, mesh.nodes[1]]
        await monitor.checkAllNodes()
        expect(alerts).toHaveLength(2)
        expect(alerts[1].kind).toBe('erholt')
    })

    it('daemon no longer copies L21 alerts into the insight engine (chat reply)', () => {
        const source = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        expect(source).not.toMatch(/nodeHealth\.setAlertCallback\(async \(message: string\) => \{\s*insightEngine\.recordInsight/)
        expect(source).not.toMatch(/origHealthAlert/)
    })
})
