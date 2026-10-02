import { beforeEach, describe, expect, it, vi } from 'vitest'

// MI-2: node addresses come from the shared registry and are untrusted. The
// former latency probe pinged them (via execFile, after a host check). Since
// 2.86 Paket J the router ranks nodes from signed facts only and pings
// nothing, so a registry-controlled address can never reach a process.

const childProcess = vi.hoisted(() => ({ exec: vi.fn(), execFile: vi.fn(), execSync: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => childProcess)
vi.mock('./mesh-registry.js', () => ({
    getLocalNodeId: () => 'main-x',
    getAvailableNodes: async () => [
        { node_id: 'evil', hostname: 'evil', ip: '1.1.1.1;touch /tmp/pwned', capabilities: ['chat'], status: 'online' },
        { node_id: 'evil2', hostname: 'evil2', ip: '$(id)', capabilities: ['chat'], status: 'online' },
    ],
}))

describe('MI-2 mesh-router without a latency probe', () => {
    beforeEach(() => { for (const fn of Object.values(childProcess)) fn.mockClear() })

    it('never starts a process for routing, whatever the registry contains', async () => {
        const { routeTask } = await import('./mesh-router.js')
        const facts = { now: Date.now(), measurements: [], nodes: [] }
        for (const text of ['Konvertiere das Video nach mp4', 'Erzeuge ein Bild', 'Führe das Python-Script aus', 'Wie geht es dir?']) {
            await routeTask(text, false, facts)
        }
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
    })

    it('no ping helpers are exported any more', async () => {
        const router = await import('./mesh-router.js') as Record<string, unknown>
        expect(router.measureLatency).toBeUndefined()
        expect(router.isSafePingHost).toBeUndefined()
    })
})
