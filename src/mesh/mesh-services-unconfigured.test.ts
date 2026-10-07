import { describe, expect, it, vi } from 'vitest'
import { RelayMeshTransport } from './relay-mesh-transport.js'
import { SupabaseMeshTransport } from './supabase-mesh-transport.js'

// 2.89.1 (live acceptance, standalone instance): a transport that was never set up
// (no URL / key) is "nicht eingerichtet", not "unhealthy".
const transports = [
    new RelayMeshTransport('node-a', {}),
    new SupabaseMeshTransport('node-a', {}),
    new RelayMeshTransport('node-a', { url: 'https://relay.example.com', token: 'test-token' }),
]
vi.mock('./mesh-transport-runtime.js', () => ({ getMeshTransport: () => ({ transportHealth: () => transports.map(item => item.health()) }) }))

describe('mesh_services in standalone', () => {
    it('reports unconfigured transports as not set up and keeps a configured one honest', async () => {
        const { formatMeshServices } = await import('./mesh-registry.js')
        const text = await formatMeshServices()
        expect(text).toContain('⚪ relay: nicht eingerichtet')
        expect(text).toContain('⚪ supabase: nicht eingerichtet')
        expect(text).toContain('🟢 relay: healthy')
        expect(text).not.toContain('unhealthy')
    })
    it('a configured transport with an error is still unhealthy', async () => {
        const broken = new SupabaseMeshTransport('node-a', { url: 'https://db.example.com', key: 'test-key' })
        ;(broken as any).lastError = 'boom'
        expect(broken.health()).toMatchObject({ configured: true, healthy: false })
    })
})
