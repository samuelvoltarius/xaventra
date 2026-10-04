import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentAwareness, recordDiscoveryObservation } from './awareness.js'
import { mentionsEnvironment } from '../core/request-capabilities.js'
import { recordCandidates } from './device-registry.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
describe('background environment awareness', () => {
    it('recognizes the reported LAN question without requiring a scan command', () => {
        expect(mentionsEnvironment('welche geräte findest du im netzwerk? die du verwalten und sterun könntest?')).toBe(true)
    })
    it('persists bounded coverage and exposes it only to the owner', () => {
        const root = mkdtempSync(join(tmpdir(), 'awareness-')); roots.push(root)
        recordDiscoveryObservation(root, { scannedHosts: 154, probes: 1297, timedOut: true, truncated: true } as any)
        expect(environmentAwareness(root, 'owner')).toContain('154 Adressen, 1297 Prüfungen')
        expect(environmentAwareness(root, 'owner')).toContain('Teilsuche')
        expect(environmentAwareness(root, 'user')).toBe('')
    })
    it('does not infer an empty network from missing observations', () => {
        const root = mkdtempSync(join(tmpdir(), 'awareness-')); roots.push(root)
        expect(environmentAwareness(root, 'owner')).toContain('daraus folgt nicht')
    })
    it('does not call an actively probed address only a neighbor-cache entry', () => {
        const root = mkdtempSync(join(tmpdir(), 'awareness-')); roots.push(root)
        recordCandidates(root, [{ type: 'networkdevice', host: '192.168.1.2', port: 0, via: 'neighbor' }], Date.now() - 100_000)
        recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.2', port: 80, via: 'tcp' }])
        const view = environmentAwareness(root, 'owner')
        expect(view).not.toContain('LAN-Gerät (Nachbartabelle')
        expect(view).toContain('beobachtete Ports 80')
    })
    it('groups address aliases only with matching confirmed identities, never matching port sets', () => {
        const root = mkdtempSync(join(tmpdir(), 'awareness-')); roots.push(root)
        const hardware = { kind: 'light' as const, label: 'Lamp', certainty: 'confirmed' as const, identity: 'uuid:lamp', manufacturer: 'Vendor', model: 'Lamp', observedAt: new Date().toISOString() }
        recordCandidates(root, [{ type: 'networkservice', host: '192.168.1.2', port: 80, via: 'http', hardware },
            { type: 'networkservice', host: '192.168.1.3', port: 80, via: 'http', hardware },
            { type: 'networkservice', host: '192.168.1.4', port: 80, via: 'tcp' }])
        const view = environmentAwareness(root, 'owner')
        expect(view).toContain('192.168.1.2, 192.168.1.3 (gleiche gemeldete Gerätekennung')
        expect(view).not.toContain('192.168.1.2, 192.168.1.3, 192.168.1.4')
        expect(view).toContain('keine gemeinsame Freigabe')
    })
})
