import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeLastSeen, isHeartbeatFresh, NODE_OFFLINE_AFTER_MS } from './mesh-node-lifecycle.js'

// 2.89.2 (live 08.10.2026): /api/desktop/nodes showed a deleted k8s worker as "online 2.89.1".
// One freshness rule for every source: a node is online only with a fresh heartbeat.

describe('heartbeat freshness rule', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    it('accepts fresh, rejects stale, missing, unparsable and far-future heartbeats', () => {
        expect(isHeartbeatFresh(now - 30_000, now)).toBe(true)
        expect(isHeartbeatFresh(new Date(now - NODE_OFFLINE_AFTER_MS - 1).toISOString(), now)).toBe(false)
        expect(isHeartbeatFresh('', now)).toBe(false)
        expect(isHeartbeatFresh(undefined, now)).toBe(false)
        expect(isHeartbeatFresh('not-a-date', now)).toBe(false)
        expect(isHeartbeatFresh(now + 10 * 60_000, now)).toBe(false)
    })
    it('describes the last sighting in plain words', () => {
        expect(describeLastSeen(now - 10 * 60_000, now)).toBe('vor 10 min')
        expect(describeLastSeen('', now)).toBe('unbekannt')
    })
})

describe('node list: registry rows and direct peers use the same freshness', () => {
    let dir = ''
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); delete process.env.NOVA_MESH_SUPABASE_URL; delete process.env.NOVA_MESH_SUPABASE_KEY; if (dir) rmSync(dir, { recursive: true, force: true }) })

    async function setup() {
        dir = mkdtempSync(join(tmpdir(), 'nova-node-fresh-'))
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        writeFileSync(join(dir, 'nova.config.json'), JSON.stringify({ mesh: { direct: { peers: [{ nodeId: 'peer-fresh', url: 'https://peer-fresh.example.com' }, { nodeId: 'peer-old', url: 'https://peer-old.example.com' }] } } }))
        writeFileSync(join(dir, '.nova-data', 'mesh-peer-state.json'), JSON.stringify({
            'peer-fresh': { nodeId: 'peer-fresh', lastSeen: Date.now() - 20_000, status: 'online' },
            'peer-old': { nodeId: 'peer-old', lastSeen: Date.now() - 10 * 60_000, status: 'online' },
        }))
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        process.env.NOVA_NODE_ID = 'main-node'
        process.env.NOVA_MESH_SUPABASE_URL = 'https://mesh.example.com/rest/v1'
        process.env.NOVA_MESH_SUPABASE_KEY = 'test-key'
        const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString()
        const row = (id: string, extra: Record<string, unknown>) => ({ node_id: id, hostname: id, ip: '192.0.2.10', platform: 'linux', version: '2.89.1', tools_count: 3, status: 'online', capabilities: [], ...extra })
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [
            row('k8s-fresh', { last_heartbeat: iso(20_000) }),
            row('k8s-deleted', { last_heartbeat: iso(10 * 60_000) }),
            // No heartbeat at all, only a freshly bumped updated_at: must not count as seen.
            row('k8s-no-beat', { updated_at: iso(1_000) }),
        ] })))
        vi.resetModules()
    }

    it('discoverNodes: fresh online, 10-minute-old and heartbeat-less rows offline', async () => {
        await setup()
        const { discoverNodes } = await import('./mesh-registry.js')
        const nodes = await discoverNodes({ includeHistorical: true })
        const status = (id: string) => nodes.find(n => n.node_id === id)?.status
        expect(status('k8s-fresh')).toBe('online')
        expect(status('k8s-deleted')).toBe('offline')
        expect(status('k8s-no-beat')).toBe('offline')
        expect(status('peer-fresh')).toBe('online')
        expect(status('peer-old')).toBe('offline')
    })

    it('/api/desktop/nodes inventory: offline entries say "zuletzt gesehen"', async () => {
        await setup()
        const { NodeEnrollmentService } = await import('../desktop/node-enrollment.js')
        const inventory = await new NodeEnrollmentService(join(dir, 'enroll.json')).inventory(true)
        const byId = (id: string) => inventory.nodes.find(n => n.id === id)
        expect(byId('k8s-fresh')).toMatchObject({ online: true, status: 'online', statusText: 'online 2.89.1' })
        expect(byId('k8s-deleted')).toMatchObject({ online: false, status: 'offline' })
        expect(byId('k8s-deleted').statusText).toBe('offline (zuletzt gesehen vor 10 min)')
        expect(byId('k8s-no-beat')).toMatchObject({ online: false })
        expect(byId('k8s-no-beat').statusText).toContain('zuletzt gesehen unbekannt')
        expect(byId('peer-old')).toMatchObject({ online: false })
        expect(byId('peer-fresh')).toMatchObject({ online: true })
    })
})
