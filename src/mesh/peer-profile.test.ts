import { describe, expect, it } from 'vitest'
import { peerStateWithCapabilities } from './mesh-transport-runtime.js'

const profile = {
    schema: 1, nodeId: 'xaventra-spark', hostname: 'ns2.serveone.at', platform: 'linux', arch: 'x64', version: '2.79.3',
    role: 'worker', runtime: 'container', rootReadOnly: true, noNewPrivileges: true, cpus: 2, ramGB: 4,
    gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'image', tools: ['curl'],
    selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '',
}

describe('peer Knotenprofil (Stufe 1, S1.1)', () => {
    it('binds the profile to the authenticated source node, not the id it claims', () => {
        const state = peerStateWithCapabilities(undefined, 'xaventra-ns2', { runtimes: [], capabilities: [], profile }, 'fp', 1_000)
        expect(state.profile?.nodeId).toBe('xaventra-ns2')
        expect(state.profileSeen).toBe(1_000)
    })

    it('keeps the last profile when a later message carries none (sent only on change)', () => {
        const first = peerStateWithCapabilities(undefined, 'xaventra-ns2', { runtimes: [], capabilities: [], profile }, 'fp', 1_000)
        const snapshot = peerStateWithCapabilities(first, 'xaventra-ns2', { snapshot: { version: 1, nodes: [] } }, 'fp', 31_000)
        expect(snapshot.profile?.runtime).toBe('container')
        expect(snapshot.profileSeen).toBe(1_000)
        expect(snapshot.lastSeen).toBe(31_000)
    })

    it('drops a malformed profile instead of storing it', () => {
        const state = peerStateWithCapabilities(undefined, 'xaventra-ns2', { runtimes: [], capabilities: [], profile: { schema: 9, evil: true } }, 'fp', 1_000)
        expect(state.profile).toBeUndefined()
    })
})
