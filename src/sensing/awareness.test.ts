import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentAwareness, recordDiscoveryObservation } from './awareness.js'
import { mentionsEnvironment } from '../core/request-capabilities.js'

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
})
