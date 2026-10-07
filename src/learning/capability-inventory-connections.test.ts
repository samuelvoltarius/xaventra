/**
 * 2.89 integration — the capability inventory reads connections from the one connection
 * truth (connections/connection-state.ts), not from its own status read.
 * Live way: the learning gate's own deps (defaultLearnDeps → capabilityInventory) on the
 * runtime data directory, compared with connectedConnectorIds() for the same data.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixtures = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    return { dir: mkdtempSync(join(tmpdir(), 'xv-inv-conn-')) }
})
// Only the connection part is under test: register and mesh view stay empty (fast, no network).
vi.mock('../tools/complete-registry.js', () => ({ getToolRegistry: () => ({ getAll: () => [] }) }))
vi.mock('../mesh/node-strengths.js', async importOriginal => ({ ...(await importOriginal<any>()), collectNodeStrengths: async () => [] }))
vi.mock('../core/data-root.js', async importOriginal => ({ ...(await importOriginal<any>()), getNovaDataDir: (...parts: string[]) => join(fixtures.dir, ...parts) }))

const { connectionIdFor, saveConnection } = await import('../connections/connection-store.js')
const { connectedConnectorIds } = await import('../connections/connection-state.js')
const { capabilityInventory } = await import('./capability-inventory.js')
const { defaultLearnDeps } = await import('./capability-learning.js')

const at = '2026-10-07T10:00:00.000Z'
const conn = (connectorId: string, over: Record<string, unknown> = {}) => ({
    id: connectionIdFor(connectorId), connectorId, trust: 'geprueft', title: connectorId, kategorie: 'zuhause', datenklasse: 'lokal', auth: 'token',
    transport: { art: 'http', url: 'http://192.0.2.60:8080/mcp' }, status: 'verbunden', createdAt: at, updatedAt: at, approvedBy: 'telegram:1001', erlaubteWerkzeuge: [], ...over,
}) as any

const light = { tools: () => [], strengths: async () => [], toolHealth: () => [], learned: () => [], cloud: () => [], runtime: async () => undefined, embedding: () => 'notbehelf' as const }

beforeAll(() => {
    vi.stubEnv('HASS_URL', '')
    vi.stubEnv('HASS_TOKEN', '')
    const dataDir = fixtures.dir
    saveConnection(conn('n8n'), { dataDir })
    saveConnection(conn('gmail', { auth: 'oauth', status: 'wartet-auf-anmeldung' }), { dataDir })
    // A Home Assistant record that came from the configuration — the configuration is gone.
    saveConnection(conn('home-assistant', { auth: 'ha-login', herkunft: 'konfiguriert', basis: 'http://192.0.2.30:8123' }), { dataDir })
})
afterAll(() => { vi.unstubAllEnvs() })

describe('capability inventory ← connection truth', () => {
    it('connected is exactly what connectionState says (a stale configured HA record is not connected)', async () => {
        const inventory = await capabilityInventory({ ...light })
        expect([...inventory.connected].sort()).toEqual([...connectedConnectorIds()].sort())
        expect(inventory.connected.has('n8n')).toBe(true)
        expect(inventory.connected.has('home-assistant')).toBe(false)
        expect(inventory.connections?.get('gmail')).toBe('wartet-auf-anmeldung')
        expect(inventory.connections?.get('home-assistant')).not.toBe('verbunden')
    })

    it('live: the learning gate deps see the same connections, and inventoryNow stays on the same truth', async () => {
        const deps = defaultLearnDeps()
        const inventory = await deps.inventory()
        expect([...inventory.connected].sort()).toEqual([...connectedConnectorIds()].sort())
        saveConnection(conn('gmail', { auth: 'oauth', status: 'verbunden' }), { dataDir: fixtures.dir })
        const now = deps.inventoryNow?.()
        expect(now?.connected.has('gmail')).toBe(true)
        expect([...(now?.connected || [])].sort()).toEqual([...connectedConnectorIds()].sort())
    })
})
