import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('discoverNodes: Version eines Direct-Mesh-Workers', () => {
    let dir = ''
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); if (dir) rmSync(dir, { recursive: true, force: true }) })

    it('zeigt die Version aus dem Peer-Profil statt "?"', async () => {
        dir = mkdtempSync(join(tmpdir(), 'nova-peer-version-'))
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        writeFileSync(join(dir, 'nova.config.json'), JSON.stringify({ mesh: { direct: { peers: [{ nodeId: 'worker-a', url: 'https://worker-a.example.com' }] } } }))
        writeFileSync(join(dir, '.nova-data', 'mesh-peer-state.json'), JSON.stringify({
            'worker-a': { nodeId: 'worker-a', lastSeen: Date.now(), status: 'online', profile: { nodeId: 'worker-a', version: '2.89.1' } },
            'worker-b': { nodeId: 'worker-b', lastSeen: Date.now(), status: 'online' },
        }))
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        process.env.NOVA_NODE_ID = 'main-node'
        vi.resetModules()
        const { discoverNodes } = await import('./mesh-registry.js')
        const nodes = await discoverNodes({ remote: false })
        expect(nodes.find(n => n.node_id === 'worker-a')?.version).toBe('2.89.1')
        expect(nodes.find(n => n.node_id === 'worker-b')?.version).toBe('?')
    })
})
