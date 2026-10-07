import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./smart-device-route.js', async importOriginal => ({ ...(await importOriginal<any>()), approvedSmartRoute: () => 'local' }))
import { isRecordConnected } from './device-connect.js'
import type { DeviceRecord } from './device-registry.js'

// 2.88.1 (live 07.10.2026): the device list said "Tuya-Gerät — verbunden" while the
// connections view (2.87.1) correctly said not connected: the local way was approved,
// but the local key had never been entered.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'keyed-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tuya = { id: 'dev-00000000c1', type: 'networkservice', name: 'x', host: '192.0.2.5', port: 6668, via: 'udp', status: 'eingerichtet',
    foundAt: '2026-10-06T10:00:00.000Z', lastSeenAt: '2026-10-06T10:00:00.000Z', approvedBy: 'telegram:111', approvedAt: '2026-10-06T10:00:00.000Z', evidence: {},
    hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: '2026-10-06T10:00:00.000Z' } } as unknown as DeviceRecord

describe('a keyed device is connected only with its key', () => {
    it('approved local way without key → not connected', () => {
        expect(isRecordConnected(dir, tuya)).toBe(false)
    })
    it('a non-keyed device with an approved way stays connected (Gegenprobe)', () => {
        const printer = { ...tuya, id: 'dev-00000000e1', type: 'moonraker', hardware: undefined } as unknown as DeviceRecord
        expect(isRecordConnected(dir, printer)).toBe(true)
    })
})
