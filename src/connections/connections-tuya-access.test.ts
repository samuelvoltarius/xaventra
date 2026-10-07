import { describe, expect, it } from 'vitest'
import { collectConnections } from './connections-view.js'

// 2.87.1 (live 07.10.2026): after "Ja" on the Tuya card (local way chosen) the device
// counted as "verbunden" and the owner got "✅ Tuya-Gerät ist verbunden. Probier mal:"
// although the local key from the Tuya app had never been entered.

const tuya = (status: string) => ({ id: 'dev-00000000c1', type: 'networkservice', name: 'x', host: '192.0.2.5', port: 6668, via: 'udp', status,
    foundAt: '2026-10-06T10:00:00.000Z', lastSeenAt: '2026-10-06T10:00:00.000Z', approvedBy: 'telegram:111', approvedAt: '2026-10-06T10:00:00.000Z', evidence: {},
    hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: '2026-10-06T10:00:00.000Z' } })

describe('a keyed smart device is only "verbunden" with its access stored', () => {
    it('Tuya with an approved route but no local key is not connected', async () => {
        const view = await collectConnections({ dataDir: 'C:/nonexistent-xaventra-test', connections: () => [], devices: () => [tuya('eingerichtet')], consolidation: {} } as any)
        const item = view.gefunden.find(entry => entry.id.includes('192.0.2.5'))
        expect(item?.verbunden).toBe(false)
    })
})
