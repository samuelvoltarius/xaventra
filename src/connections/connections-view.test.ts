import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConnections, formatConnectionsText, listConnections, registerConnectionSource, unregisterConnectionSource, type ViewDeps } from './connections-view.js'
import { registerConnectionsApi } from './connections-api.js'
import { saveConnection, writeConnectionSecrets, type ConnectionRecord } from './connection-store.js'
import { detectDeterministicCommand } from '../core/deterministic-query.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-view-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); unregisterConnectionSource('ki-test') })

const connected = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
    id: 'c-google-calendar', connectorId: 'google-calendar', trust: 'geprueft', title: 'Google Kalender', kategorie: 'kalender', datenklasse: 'cloud', auth: 'oauth',
    transport: { art: 'http', url: 'https://mcp.example.com/kalender' }, status: 'verbunden', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    approvedBy: 'telegram:42', erlaubteWerkzeuge: [], capabilities: { list_events: 'lesen', create_event: 'schreiben', delete_event: 'loeschen' }, ...over,
})
const deps = (dir: string, extra: Partial<ViewDeps> = {}): ViewDeps => ({
    dataDir: dir, directoryCachePath: join(dir, 'none.json'), env: {},
    devices: () => [{ type: 'homeassistant', host: '192.168.1.10', port: 8123, status: 'gefunden' }, { type: 'moonraker', host: '192.168.1.20', port: 7125, status: 'eingerichtet' }],
    accounts: () => [{ kind: 'gmail', label: 'alf…@example.com' }],
    connections: () => [connected()], ...extra,
})

describe('Verbindungen: Gefunden / Möglich / Verbunden (2.85 Paket A, Punkt 6)', () => {
    it('shows found services quietly, the grouped catalog with local/cloud and logo, and what a connection may do', async () => {
        const view = await collectConnections(deps(tmp()))
        expect(view.gefunden.map(item => [item.title, item.connectorId, item.verbunden])).toEqual([
            ['Home Assistant', 'home-assistant', false], ['Drucker (Klipper)', undefined, true], ['Gmail', 'gmail', false],
        ])
        expect(view.gefunden[0]).toMatchObject({ fund: 'im Netz 192.168.1.10:8123', datenklasse: 'lokal' })
        expect(view.gefunden[0].icon).toMatch(/^data:image\/svg\+xml/)
        const labels = view.moeglich.gruppen.map(group => group.label)
        expect(labels).toEqual(['Zuhause', 'Kommunikation', 'Kalender', 'Dateien', 'Entwicklung', 'Infrastruktur'])
        const kalender = view.moeglich.gruppen.find(group => group.kategorie === 'kalender')!.eintraege[0]
        expect(kalender).toMatchObject({ connectorId: 'google-calendar', status: 'verbunden', datenklasse: 'cloud', trust: 'geprueft' })
        const gmail = view.moeglich.gruppen.find(group => group.kategorie === 'kommunikation')!.eintraege[0]
        expect(gmail.hinweis).toMatch(/Google-OAuth-Client/)
        expect(view.verbunden[0].darf).toMatchObject({ lesen: ['list_events'], fragt: ['create_event'], nie: ['delete_event'] })
        expect(view.verbunden[0].darf.sonst).toMatch(/Privates geht nie in die Cloud/)
    })

    it('self-hosted services found by the discovery appear under Gefunden, with a connector where the catalog has one', async () => {
        const view = await collectConnections(deps(tmp(), { devices: () => [
            { type: 'n8n', host: '192.168.1.40', port: 5678, status: 'gefunden' }, { type: 'jellyfin', host: '192.168.1.41', port: 8096, status: 'gefunden' },
        ] }))
        expect(view.gefunden.find(item => item.title === 'n8n')).toMatchObject({ connectorId: 'n8n', fund: 'im Netz 192.168.1.40:5678', datenklasse: 'lokal' })
        expect(view.gefunden.find(item => item.title === 'Jellyfin')!.connectorId).toBeUndefined()
    })

    it('other packages dock their finds (KI-Modelle, Suche/Hilfsdienste) without scanning here', async () => {
        registerConnectionSource({ id: 'ki-test', list: () => [{ id: 'ollama', title: 'Ollama (lokal)', kategorie: 'ki-modelle', wirkung: '3 Modelle', fund: 'im Netz 192.168.1.30:11434', verbunden: false }] })
        const view = await collectConnections(deps(tmp()))
        expect(view.gefunden.find(item => item.id === 'ki-test:ollama')).toMatchObject({ kategorie: 'ki-modelle', title: 'Ollama (lokal)' })
        registerConnectionSource({ id: 'ki-test', list: () => { throw new Error('kaputt') } })
        await expect(collectConnections(deps(tmp()))).resolves.toBeTruthy()
    })

    it('listConnections() for the first start: flat, status gefunden | moeglich | verbunden', async () => {
        const list = await listConnections(deps(tmp()))
        expect(list.filter(item => item.status === 'gefunden').map(item => item.title)).toEqual(['Home Assistant', 'Gmail'])
        // 2.85 Integration: a set-up device in use counts as connected (the first start shows real numbers).
        expect(list.filter(item => item.status === 'verbunden').map(item => item.title)).toEqual(['Google Kalender', 'Drucker (Klipper)'])
        expect(list.some(item => item.status === 'moeglich' && item.connectorId === 'github')).toBe(true)
        expect(list.some(item => item.status === 'moeglich' && item.connectorId === 'google-calendar')).toBe(false)
    })

    it('Telegram: a natural question routes to the short list (no slash command needed)', async () => {
        for (const text of ['Womit kannst du dich verbinden?', 'welche Verbindungen hast du', 'Was ist verbunden?', 'zeig mir deine Verbindungen']) {
            expect(detectDeterministicCommand(text), text).toMatchObject({ command: 'verbindungen', args: '', risk: 'read-only' })
        }
        expect(detectDeterministicCommand('Verbinde mich mit Peter')).toBeNull()
        const text = await formatConnectionsText(deps(tmp()))
        expect(text).toMatch(/Verbunden: Google Kalender/)
        expect(text).toMatch(/Gefunden: Home Assistant, Gmail/)
        expect(text).toMatch(/Zuhause: Home Assistant \(lokal\)/)
        expect(text.split('\n').length).toBeLessThanOrEqual(12)
    })

    it('desktop API: owner only; Verbinden creates the card; nothing of the stored login is ever returned', async () => {
        const dir = tmp()
        saveConnection(connected(), { dataDir: dir })
        const fake = ['AT', 'fake', 'login', 'value'].join('-')
        writeConnectionSecrets('c-google-calendar', { oauth: { tokens: { access_token: fake } } }, { dataDir: dir })
        const app = express(); app.use(express.json())
        let owner = false
        registerConnectionsApi(app, {
            ownerOnly: (_req, res) => { if (owner) return true; res.status(403).json({ error: 'Owner authorization required' }); return false },
            deps: () => ({ dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, redirectBase: 'http://127.0.0.1:3011', env: {}, directoryCachePath: join(dir, 'none.json'), devices: () => [], accounts: () => [], foundHomeAssistant: () => ['http://ha.example.com:8123'] }),
        })
        const server = app.listen(0, '127.0.0.1')
        await new Promise<void>(resolve => server.once('listening', resolve))
        const base = `http://127.0.0.1:${(server.address() as any).port}/api/desktop/verbindungen`
        try {
            expect((await fetch(base)).status).toBe(403)
            owner = true
            const view = await (await fetch(base)).text()
            expect(view).toContain('Google Kalender')
            expect(view).not.toContain(fake)
            const res = await fetch(`${base}/verbinden`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectorId: 'home-assistant' }) })
            const body = await res.json() as any
            expect(res.status).toBe(200)
            expect(body.cardId).toMatch(/^k[a-f0-9]{12}$/)
            expect((await fetch(`${base}/..%2F..%2Fetc/trennen`, { method: 'POST' })).status).toBe(404)
        } finally { server.close() }
    })
})
