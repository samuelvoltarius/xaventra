import { describe, expect, it } from 'vitest'
import { connectionAwareness } from './connection-awareness.js'
import type { ConnectionRecord } from '../connections/connection-store.js'
import type { MCPServer } from '../mcp/mcp-client.js'

const connection = (patch: Partial<ConnectionRecord> = {}): ConnectionRecord => ({ id: 'c-house', connectorId: 'homeassistant', title: 'Mein Zuhause', trust: 'geprueft', datenklasse: 'lokal', status: 'verbunden', auth: 'ha-login', kategorie: 'weitere', transport: { art: 'http', url: 'http://secret-endpoint/?token=must-not-leak' }, createdAt: '', updatedAt: '', approvedBy: 'owner', erlaubteWerkzeuge: [], ...patch })
const server = (patch: Partial<MCPServer> = {}): MCPServer => ({ name: 'house', transport: 'http', connected: true, resources: [{ uri: 'secret-resource', name: 'private' }], prompts: [], tools: [{ name: 'get_devices', description: 'Geräte lesen', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'HassTurnOn', description: 'Licht einschalten', inputSchema: { type: 'object' } }, { name: 'delete_device', description: 'Löschen', inputSchema: { type: 'object' } }], ...patch })

describe('canonical connection awareness', () => {
    it('explains concrete live model capabilities and existing node work paths', () => {
        const result = connectionAwareness([{ name: 'spark', address: '192.168.0.2', online: true, capabilities: [{ name: 'llm', provider: 'qwen', available: true }, { name: 'vision', provider: 'stopped-model', available: false }] }], [], [], new Set(['mesh_delegate', 'mesh_exchange_send', 'mesh_screenshot']))
        expect(result).toContain('Sprachmodell (qwen)')
        expect(result).not.toContain('stopped-model')
        expect(result).toContain('Empfangsbeleg')
        expect(result).toContain('grafischer Sitzung')
    })
    it('does not call an offline node usable or claim absent tools', () => {
        const result = connectionAwareness([{ name: 'old', address: 'host', online: false, capabilities: [{ name: 'llm', provider: 'stale-model', available: true }] }], [], [], new Set())
        expect(result).not.toContain('stale-model')
        expect(result).not.toContain('mesh_screenshot')
        expect(result).toContain('veraltet/offline')
    })
    it('uses real MCP catalog with connection policy, not generic tool counts', () => {
        const result = connectionAwareness([], [server()], [connection()], new Set())
        expect(result).toContain('Mein Zuhause: MCP-Transport verbunden')
        expect(result).toContain('get_devices: Geräte lesen')
        expect(result).toContain('HassTurnOn: Licht einschalten; Zustimmung pro Aufruf nötig')
        expect(result).toContain('delete_device: Löschen; gesperrt')
        expect(result).not.toContain('must-not-leak')
        expect(result).not.toContain('secret-resource')
        expect(result).toContain('kein Beleg einer erfolgreichen Aktion')
    })
    it('suppresses a stale catalog after transport disconnect or login expiry', () => {
        for (const [s, c] of [[server({ connected: false }), connection()], [server(), connection({ status: 'abgelaufen' })]] as const) {
            const result = connectionAwareness([], [s], [c], new Set())
            expect(result).toContain('nicht aktuell verbunden')
            expect(result).not.toContain('get_devices')
        }
    })
    it('shows pending login without treating stored connected status as live', () => {
        const result = connectionAwareness([], [], [connection({ status: 'wartet-auf-anmeldung' }), connection({ id: 'c-other', title: 'Andere Verbindung' })], new Set())
        expect(result).toContain('Verbindungsdialog erforderlich')
        expect(result).toContain('Andere Verbindung: Zugang verbunden; kein aktueller MCP-Transport belegt')
    })
    it('keeps community write tools hidden and unbound catalogs unapproved', () => {
        const community = connectionAwareness([], [server()], [connection({ trust: 'community' })], new Set())
        expect(community).toContain('get_devices')
        expect(community).not.toContain('HassTurnOn')
        const unbound = connectionAwareness([], [server()], [], new Set())
        expect(unbound).toContain('Freigabe beim Aufruf prüfen')
        expect(unbound).not.toContain('laut Verbindungspolicy lesend')
    })
    it('reports absent catalogs honestly and redacts descriptions', () => {
        expect(connectionAwareness([], [], [], new Set())).toContain('Keine MCP-Verbindung im aktuellen Bestand')
        const result = connectionAwareness([], [server({ tools: [{ name: 'read', description: 'api_key=secret-value', inputSchema: { type: 'object' } }] })], [], new Set())
        expect(result).not.toContain('secret-value')
    })
    it('reserves space for MCP and the permission boundary even with large node inventories', () => {
        const nodes = Array.from({ length: 20 }, (_, i) => ({ name: `node-${i}`, address: 'local', online: true,
            capabilities: Array.from({ length: 20 }, (_, j) => ({ name: 'llm', provider: `model-${j}-` + 'x'.repeat(90), available: true })) }))
        const result = connectionAwareness(nodes, [server()], [connection()], new Set(['mesh_delegate']))
        expect(result).toContain('get_devices: Geräte lesen')
        expect(result).toContain('Keine Verbindung oder Aktion wurde')
        expect(result).toContain('gekürzt')
        expect(result.length).toBeLessThan(6000)
    })
})
