import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { peerCapabilitiesWithChanges } from './mesh-transport-runtime.js'
import { listStrengthChanges } from './node-strengths.js'

// 2.86 Paket J Punkt 2: neue Software/Hardware geht über den vorhandenen
// signierten Herzschlag (node.capabilities) an alle; wer das Profil empfängt,
// führt die Karte und vermerkt, was sich geändert hat. Kein neuer Port.
const profile = (patch: Record<string, unknown> = {}) => ({
    schema: 1, nodeId: 'gelogen', hostname: 'a.example.com', platform: 'linux', arch: 'x64', version: '2.85.0',
    role: 'worker', runtime: 'native', rootReadOnly: false, noNewPrivileges: false, cpus: 8, ramGB: 32,
    gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'host-agent', tools: ['git'],
    selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...patch,
})

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xav-strength-')); vi.stubEnv('NOVA_RUNTIME_ROOT', root) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('Änderungen an Knoten-Stärken beim Empfang des signierten Profils', () => {
    it('vermerkt neue GPU und neuen Dienst für die authentifizierte Quelle, nicht die behauptete ID', async () => {
        const first = await peerCapabilitiesWithChanges(undefined, 'knoten-a', { runtimes: [], profile: profile() }, 'fp', 1_000)
        expect(first.changes).toEqual([])
        const second = await peerCapabilitiesWithChanges(first.state, 'knoten-a', {
            runtimes: [], profile: profile({ gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false }, services: [{ name: 'comfyui', type: 'image', status: 'running' }] }),
        }, 'fp', 2_000)
        expect(second.state.profile?.gpu.name).toBe('NVIDIA RTX 4090')
        expect(second.changes).toEqual(expect.arrayContaining([expect.stringMatching(/neue GPU/), expect.stringMatching(/neuer Dienst: comfyui/)]))
        const stored = await listStrengthChanges()
        expect(stored[0]).toMatchObject({ nodeId: 'knoten-a' })
        expect(stored[0].changes.join(' ')).toMatch(/RTX 4090/)
    })

    it('ohne Profil (Nachricht trägt keins) und ohne Änderung wird nichts vermerkt', async () => {
        const first = await peerCapabilitiesWithChanges(undefined, 'knoten-b', { runtimes: [], profile: profile() }, 'fp', 1_000)
        const again = await peerCapabilitiesWithChanges(first.state, 'knoten-b', { runtimes: [], profile: profile() }, 'fp', 2_000)
        const none = await peerCapabilitiesWithChanges(again.state, 'knoten-b', { runtimes: [] }, 'fp', 3_000)
        expect([again.changes, none.changes]).toEqual([[], []])
        expect(await listStrengthChanges()).toEqual([])
    })
})
