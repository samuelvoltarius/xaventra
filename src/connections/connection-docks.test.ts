/**
 * 2.85 Integration: the docks between the nine packages.
 *
 *   B → A  the first start counts what „Verbindungen“ shows (registerConnectionsProvider)
 *   C → A  KI-Modelle and Suche/Hilfsdienste appear in „Verbindungen“ — Gefunden,
 *          Möglich and Verbunden, one place (registerConnectionSource)
 *   F ↔ A  one need, one recipient: a failing service tool is classified once by
 *          `classifyNeed`; the connection need rule asks it (registerServiceNeedRule)
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLlmConnectionList, type KeyStoreLike } from '../llm/llm-connections.js'
import { summarizeConnections, registerConnectionsProvider } from '../onboarding/connections-port.js'
import { classifyNeed } from '../install/software-demand.js'
import { collectConnections, formatConnectionsText, listConnections, type ViewDeps } from './connections-view.js'
import { registerConnectionDocks, unregisterConnectionDocks } from './connection-docks.js'
import { demandFromRuns } from './connection-demand.js'

const repoFile = (name: string) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')
const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-docks-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); unregisterConnectionDocks(); registerConnectionsProvider(null) })

const KEY = ['sk-test-', 'example-0000000000001234'].join('')
const store: KeyStoreLike = {
    setApiKey() { /* not used */ },
    getProfile: id => id === 'llm-key:openai' ? { type: 'api_key', provider: 'openai', key: KEY } : null,
    deleteProfile: () => false,
}
/** Paket C's real list builder with test inputs (no scan, no provider call). */
const llm = () => ({
    alle: buildLlmConnectionList({
        includeMasks: true,
        services: [
            { id: 'a', name: 'ollama', type: 'llm', endpoint: 'http://192.168.1.30:11434', models: ['qwen3.5:4b', 'nomic-embed-text'], status: 'running', sourceNode: 'local', host: '192.168.1.30', metadata: { source: 'own-network' } },
            { id: 'b', name: 'searxng', type: 'search', endpoint: 'http://search.example.com:8088', models: [], status: 'running', sourceNode: 'local', host: 'search.example.com', metadata: { source: 'own-network' } },
        ],
        registry: null, codex: null,
    }, store, {}, {}),
})
const viewDeps = (dir: string): ViewDeps => ({
    dataDir: dir, directoryCachePath: join(dir, 'none.json'), env: {},
    devices: () => [{ type: 'homeassistant', host: '192.168.1.10', port: 8123, status: 'gefunden' }],
    accounts: () => [], connections: () => [],
})
const NOW = Date.parse('2026-10-02T12:00:00Z')
const failedRun = (toolName: string) => ({
    runId: 'r1', userId: 'owner', channel: 'telegram', status: 'failed', updatedAt: '2026-10-01T12:00:00.000Z', contract: { id: 'r1' },
    validation: { validator: 'nova-execution-kernel', success: false }, tools: [{ toolName, success: false, result: 'HTTP 500' }],
}) as any

describe('2.85 Andockstellen (B → A, C → A, F ↔ A)', () => {
    it('B → A: the first start shows the real numbers of „Verbindungen“ once docked', async () => {
        const dir = tmp()
        expect((await summarizeConnections()).available).toBe(false)
        registerConnectionDocks({ view: () => viewDeps(dir), llm })
        const summary = await summarizeConnections()
        expect(summary.available).toBe(true)
        // Home Assistant waits for a connection; the local Ollama and SearXNG need none (lokal = usable).
        expect(summary.gefunden).toBe(1)
        expect(summary.beispiele).toEqual(['Home Assistant'])
        // Usable local services and the connected cloud provider count as connected.
        expect(summary.verbunden).toBe(3)
    })

    it('C → A: KI-Modelle and Suche/Hilfsdienste in Gefunden, Möglich and Verbunden — one place, no duplicates', async () => {
        const dir = tmp()
        registerConnectionDocks({ view: () => viewDeps(dir), llm })
        const view = await collectConnections(viewDeps(dir))
        const found = view.gefunden.filter(item => item.kategorie === 'ki-modelle' || item.kategorie === 'hilfsdienste')
        expect(found.map(item => [item.kategorie, item.datenklasse, item.verbunden])).toEqual([['ki-modelle', 'lokal', true], ['hilfsdienste', 'lokal', true]])
        expect(found[0].fund).toBe('im Netz 192.168.1.30:11434')
        expect(found[1].title).toMatch(/^SearXNG/)
        // Möglich: cloud providers grouped as „KI-Modelle“, with the official way (key, account login only where allowed).
        const group = view.moeglich.gruppen.find(item => item.kategorie === 'ki-modelle')!
        expect(group.label).toBe('KI-Modelle')
        const anthropic = group.eintraege.find(item => item.connectorId === 'llm:anthropic')!
        expect(anthropic).toMatchObject({ datenklasse: 'cloud', status: 'moeglich', llm: { provider: 'anthropic', konto: null } })
        expect(group.eintraege.find(item => item.connectorId === 'llm:openrouter')!.llm).toMatchObject({ konto: 'openrouter-pkce' })
        expect(group.eintraege.some(item => item.connectorId === 'llm:openai')).toBe(false)
        // Verbunden: the connected provider with its mask only, disconnectable.
        const openai = view.verbunden.find(item => item.connectorId === 'llm:openai')!
        expect(openai).toMatchObject({ status: 'verbunden', datenklasse: 'cloud', llm: { provider: 'openai', trennbar: true, maske: '••••1234' } })
        expect(JSON.stringify(view)).not.toContain(KEY)
        // Every finding exactly once.
        const ids = [...view.gefunden.map(item => item.id), ...view.verbunden.map(item => item.id), ...view.moeglich.gruppen.flatMap(item => item.eintraege.map(entry => entry.connectorId))]
        expect(new Set(ids).size).toBe(ids.length)
        // Telegram and the first start read the same model.
        const text = await formatConnectionsText(viewDeps(dir))
        expect(text).toMatch(/Verbunden: .*OpenAI/)
        expect(text).toMatch(/KI-Modelle: .*Anthropic/)
        const flat = await listConnections(viewDeps(dir))
        expect(flat.filter(item => item.title.startsWith('OpenAI')).map(item => item.status)).toEqual(['verbunden'])
    })

    it('F ↔ A: a failing service tool is classified once — Verbindungen, not the Bug-Finder — and the need rule asks that place', () => {
        const dir = tmp()
        registerConnectionDocks({ view: () => viewDeps(dir), llm, connected: () => new Set() })
        expect(classifyNeed('hass_turn_off', 'HTTP 401 Unauthorized')).toMatchObject({ kind: 'dienst', service: 'home-assistant', recipient: 'verbindungen' })
        expect(classifyNeed('calendar_list_events', 'no credentials')).toMatchObject({ kind: 'dienst', service: 'google-calendar' })
        expect(classifyNeed('web_search', 'HTTP 500')).toMatchObject({ kind: 'code' })
        expect(demandFromRuns([failedRun('hass_turn_off')], NOW).map(item => item.connectorId)).toEqual(['home-assistant'])
        unregisterConnectionDocks()
        // Connected: the failure is a fault of the tool → Bug-Finder, and no connection need.
        registerConnectionDocks({ view: () => viewDeps(dir), llm, connected: () => new Set(['home-assistant']) })
        expect(classifyNeed('hass_turn_off', 'HTTP 500')).toMatchObject({ kind: 'code', recipient: 'bug-finder' })
        expect(demandFromRuns([failedRun('hass_turn_off')], NOW)).toEqual([])
        // The connection need rule has no second tool rule of its own: it reads classifyNeed.
        const source = repoFile('src/connections/connection-demand.ts')
        expect(source).toMatch(/classify: Classify = classifyNeed/)
        expect(source).not.toMatch(/function connectorForTool[\s\S]*demandFromRuns[\s\S]*connectorForTool\(String\(tool\.toolName/)
    })

    it('wired at start: desktop API and daemon dock once', () => {
        const desktop = repoFile('src/desktop/desktop-api.ts')
        const daemon = repoFile('src/daemon.ts')
        expect(desktop).toMatch(/registerConnectionDocks\(\)/)
        expect(daemon).toMatch(/registerConnectionDocks\(\)/)
    })
})
