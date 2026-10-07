import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectConnections } from './connections-view.js'

// 2.88 (live 07.10.2026): the paired Hue bridge (4 lamps) showed "verbunden=false":
// its two records (bridge service "gefunden", paired one "eingerichtet") were merged
// and the first status won; the stored pairing key was never looked at.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hue-view-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (id: string, port: number, status: string) => ({ id, type: 'networkservice', name: 'x', host: '192.0.2.143', port, via: 'mdns', status,
    foundAt: '2026-10-06T10:00:00.000Z', lastSeenAt: '2026-10-06T10:00:00.000Z', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } })

describe('Hue bridge shows connected once paired', () => {
    it('stored pairing key → verbunden', async () => {
        mkdirSync(join(dir, 'secrets', 'smart-devices'), { recursive: true })
        writeFileSync(join(dir, 'secrets', 'smart-devices', 'dev-00000000b2.json'), JSON.stringify({ hueKey: 'x'.repeat(20) }))
        const view = await collectConnections({ dataDir: dir, connections: () => [], devices: () => [rec('dev-00000000b1', 80, 'gefunden'), rec('dev-00000000b2', 443, 'eingerichtet')], consolidation: {} } as any)
        const hue = view.gefunden.find(entry => /hue/i.test(entry.title))
        expect(hue?.verbunden).toBe(true)
    })
    it('without key and without setup → not connected (Gegenprobe)', async () => {
        const view = await collectConnections({ dataDir: dir, connections: () => [], devices: () => [rec('dev-00000000b1', 80, 'gefunden'), rec('dev-00000000b2', 443, 'gefunden')], consolidation: {} } as any)
        const hue = view.gefunden.find(entry => /hue/i.test(entry.title))
        expect(hue?.verbunden).toBe(false)
    })
})
