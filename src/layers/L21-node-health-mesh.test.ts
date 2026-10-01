import { beforeEach, describe, expect, it, vi } from 'vitest'

// Live 01.10.2026 (Spark journal): "Nas — Probleme erkannt: Erreichbarkeit
// unbekannt: SSH fehlgeschlagen ...". The Spark service deliberately has no
// SSH key; the NAS reports over the signed mesh. The config entry "Nas" was
// not recognised as the mesh node xaventra-nas (different address), so L21
// SSH-probed it and alerted on the failure.

const execFile = vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    cb(new Error('Permission denied (publickey).'), '', '')
})
vi.mock('node:child_process', () => ({ exec: vi.fn(), execFile }))
const getOrDiscover = vi.fn(async () => ({ healthCmd: 'uptime' }))
vi.mock('../mesh/node-intelligence.js', () => ({ NodeIntelligence: { getOrDiscover, discover: vi.fn(async () => ({ healthCmd: 'uptime' })) } }))
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

const { getNodeHealthMonitor, configNodeCoveredByMesh } = await import('./L21-node-health.js')

function nasMeshNode(status: 'online' | 'offline' = 'online') {
    return {
        node_id: 'xaventra-nas', hostname: 'f6a1c0ffee12', ip: '100.86.40.9', platform: 'linux', version: '2.80.0',
        tools_count: 1, status, capabilities: [], last_heartbeat: new Date().toISOString(),
    }
}

describe('L21 uses the signed mesh heartbeat for mesh nodes (Hotfix 2.80.1, Befund 2)', () => {
    beforeEach(() => {
        execFile.mockClear()
        getOrDiscover.mockClear()
    })

    it('does not SSH-probe or alert on a config node that is a mesh node with a fresh heartbeat', async () => {
        mesh.nodes = [nasMeshNode('online')]
        const monitor = getNodeHealthMonitor() as any
        monitor.stop()
        // Let the constructor's own mesh load settle (vitest resolves a
        // concurrent first dynamic import of a mocked module to the original).
        await new Promise(resolve => setTimeout(resolve, 20))
        monitor.nodes = [{ name: 'Nas', host: 'admin@192.168.1.20', role: 'edge' }]
        monitor.history = { snapshots: [], lastAlert: {} }
        const alerts: string[] = []
        monitor.setAlertCallback(async (message: string) => { alerts.push(message) })

        const results = await monitor.checkAllNodes()

        expect(execFile).not.toHaveBeenCalled()
        expect(alerts.filter(text => /SSH/.test(text))).toEqual([])
        expect(results.flatMap((snapshot: any) => snapshot.warnings).filter((text: string) => /SSH/.test(text))).toEqual([])
        const nas = results.find((snapshot: any) => /nas|f6a1/i.test(snapshot.name))
        expect(nas?.online).toBe(true)
    })

    it('recognises the config entry by name, node id suffix, address or update-node mapping', () => {
        const node = nasMeshNode()
        expect(configNodeCoveredByMesh({ name: 'Nas', host: 'admin@192.168.1.20' }, [node])).toBe(true)
        expect(configNodeCoveredByMesh({ name: 'storage', host: 'admin@100.86.40.9' }, [node])).toBe(true)
        expect(configNodeCoveredByMesh({ name: 'storage', host: 'admin@10.0.0.9' }, [node], [{ nodeId: 'xaventra-nas', name: 'storage' }])).toBe(true)
        expect(configNodeCoveredByMesh({ name: 'Pi5', host: 'pi@100.64.0.21' }, [node])).toBe(false)
        expect(configNodeCoveredByMesh({ name: 'as', host: 'pi@100.64.0.21' }, [node])).toBe(false)
    })

    it('still SSH-probes a config node that is not in the mesh (Pi5 without Xaventra)', async () => {
        mesh.nodes = [nasMeshNode('online')]
        const monitor = getNodeHealthMonitor() as any
        monitor.nodes = [{ name: 'Pi5', host: 'pi@100.64.0.21', role: 'edge' }]
        monitor.history = { snapshots: [], lastAlert: {} }
        await monitor.checkAllNodes()
        expect(getOrDiscover).toHaveBeenCalledTimes(1)
    })
})
