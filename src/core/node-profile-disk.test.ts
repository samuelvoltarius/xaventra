import { describe, expect, it } from 'vitest'
import { localDiskFacts, profileFingerprint, sanitizeNodeProfile, type NodeProfile } from './node-profile.js'

// 2.86 Paket J Punkt 2: die Platte gehört ins signierte Knotenprofil ("C viel
// Platte → Speicher/Backups"). Neue Platte = Änderung (geht sofort raus); der
// freie Platz driftet und löst allein keinen neuen Versand aus.
function profile(patch: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'knoten-c', hostname: 'nas.example.com', platform: 'linux', arch: 'x64', version: '2.85.0',
        role: 'worker', runtime: 'container', rootReadOnly: true, noNewPrivileges: true, cpus: 4, ramGB: 8,
        gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'image', tools: [],
        selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...patch,
    }
}

describe('Knotenprofil: Platte (Paket J)', () => {
    it('liest Gesamt- und freie Größe der Datenplatte lokal (ohne Netz, ohne Kindprozess)', () => {
        const disk = localDiskFacts(process.cwd())
        expect(disk).not.toBeNull()
        expect(disk!.totalGB).toBeGreaterThan(0)
        expect(disk!.freeGB).toBeGreaterThanOrEqual(0)
        expect(disk!.freeGB).toBeLessThanOrEqual(disk!.totalGB)
    })

    it('nimmt die Platte eines Peers begrenzt an und verwirft Unsinn', () => {
        expect(sanitizeNodeProfile({ ...profile(), disk: { totalGB: 16000, freeGB: 9000, extra: 1 } })!.disk).toEqual({ totalGB: 16000, freeGB: 9000 })
        expect(sanitizeNodeProfile({ ...profile(), disk: { totalGB: 'viel' } })!.disk).toBeUndefined()
        expect(sanitizeNodeProfile(profile())!.disk).toBeUndefined()
    })

    it('Fingerabdruck: neue Platte zählt als Änderung, freier Platz nicht', () => {
        const base = profileFingerprint(profile({ disk: { totalGB: 4000, freeGB: 3000 } }))
        expect(profileFingerprint(profile({ disk: { totalGB: 4000, freeGB: 2950 } }))).toBe(base)
        expect(profileFingerprint(profile({ disk: { totalGB: 16000, freeGB: 3000 } }))).not.toBe(base)
    })
})
