import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    connectionDemand, demandFromRuns, matchRequestWords, noteOwnerRequest, recordConnectionAnswer, runConnectionDemandTick,
} from './connection-demand.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-bedarf-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-10-02T12:00:00Z')
const ownerRun = (tools: Array<{ toolName: string; success: boolean }>, at = NOW - DAY, extra: Record<string, unknown> = {}) => ({
    runId: `r${Math.random()}`, userId: 'owner', channel: 'telegram', status: 'failed', updatedAt: new Date(at).toISOString(), tools,
    contract: {}, validation: { validator: 'nova-execution-kernel', success: false }, ...extra,
}) as any
const fix = (run: any) => ({ ...run, contract: { id: run.runId } })

describe('Bedarfsregel für Verbindungen (2.85 Paket A, Punkt 5 — wie Scout 2.84)', () => {
    it('an owner run that failed at a service tool is a need for exactly that connector', () => {
        const signals = demandFromRuns([fix(ownerRun([{ toolName: 'hass_turn_off', success: false }]))], NOW)
        expect(signals).toEqual([{ connectorId: 'home-assistant', source: 'owner-lauf', at: NOW - DAY, detail: 'hass_turn_off' }])
        // Not an owner run, too old, or a tool that worked: no need.
        expect(demandFromRuns([ownerRun([{ toolName: 'hass_turn_off', success: false }])], NOW)).toEqual([])
        expect(demandFromRuns([fix(ownerRun([{ toolName: 'hass_turn_off', success: false }], NOW - 15 * DAY))], NOW)).toEqual([])
        expect(demandFromRuns([fix(ownerRun([{ toolName: 'hass_turn_off', success: true }]))], NOW)).toEqual([])
    })

    it('request words map to connectors (word boundaries, umlauts)', () => {
        expect(matchRequestWords('Welche Termine habe ich morgen?')).toEqual(['google-calendar'])
        expect(matchRequestWords('Mach das Licht im Bad aus')).toEqual(['home-assistant'])
        expect(matchRequestWords('Lichtblick Kalenderwoche')).toEqual([])
    })

    it('found only → never a card; one failed owner request → card; three requests in 14 days → card; two → none', async () => {
        const dir = tmp()
        const emit = vi.fn()
        const base = { statePath: join(dir, 'bedarf.json'), isMain: true, connected: () => new Set<string>(), sink: { emit } }
        // Found (Home Assistant on the network) but never needed: nothing.
        let result = await runConnectionDemandTick({ ...base, now: NOW, runs: () => [], found: () => ['home-assistant'] })
        expect(result.emitted).toEqual([])
        // Two calendar questions: still nothing.
        noteOwnerRequest('Welche Termine habe ich heute?', { statePath: base.statePath, now: NOW - 3 * DAY, connected: () => new Set() })
        noteOwnerRequest('Habe ich morgen einen Termin?', { statePath: base.statePath, now: NOW - 2 * DAY, connected: () => new Set() })
        result = await runConnectionDemandTick({ ...base, now: NOW, runs: () => [], found: () => [] })
        expect(result.emitted).toEqual([])
        // Third one: card for Google Kalender.
        noteOwnerRequest('Trag mir den Termin ein', { statePath: base.statePath, now: NOW - DAY, connected: () => new Set() })
        result = await runConnectionDemandTick({ ...base, now: NOW, runs: () => [], found: () => [] })
        expect(result.emitted.map(item => item.connectorId)).toEqual(['google-calendar'])
        expect(emit.mock.calls[0][0]).toMatchObject({ kind: 'connect', connectorId: 'google-calendar', title: 'Google Kalender verbinden?' })
        expect(emit.mock.calls[0][0].evidence.join(' ')).toMatch(/3× nach Kalender gefragt/)
        // A failed "Licht aus" run → Home Assistant card right away.
        result = await runConnectionDemandTick({ ...base, now: NOW + 1, runs: () => [fix(ownerRun([{ toolName: 'hass_turn_off', success: false }]))], found: () => ['home-assistant'] })
        expect(result.emitted.map(item => item.connectorId)).toEqual(['home-assistant'])
        expect(emit.mock.calls[1][0].evidence.join(' ')).toMatch(/gefunden/)
        // Not twice within 14 days.
        result = await runConnectionDemandTick({ ...base, now: NOW + 2, runs: () => [fix(ownerRun([{ toolName: 'hass_turn_off', success: false }]))], found: () => [] })
        expect(result.emitted).toEqual([])
        // Stored: connector, kind, time — never the request text.
        expect(readFileSync(base.statePath, 'utf8')).not.toMatch(/Termin|Licht/)
    })

    it('a self-hosted service is proposed from words only when it was found on the network', async () => {
        const dir = tmp()
        const statePath = join(dir, 'bedarf.json')
        const emit = vi.fn()
        for (const day of [3, 2, 1]) noteOwnerRequest('Kannst du eine Automatisierung bauen?', { statePath, now: NOW - day * DAY, connected: () => new Set() })
        expect((await runConnectionDemandTick({ statePath, isMain: true, now: NOW, runs: () => [], found: () => [], connected: () => new Set(), sink: { emit } })).emitted).toEqual([])
        const found = await runConnectionDemandTick({ statePath, isMain: true, now: NOW, runs: () => [], found: async () => ['n8n'], connected: () => new Set(), sink: { emit } })
        expect(found.emitted.map(item => item.connectorId)).toEqual(['n8n'])
    })

    it('connected services and declined proposals stay quiet; workers never propose', async () => {
        const dir = tmp()
        const statePath = join(dir, 'bedarf.json')
        const emit = vi.fn()
        const runs = () => [fix(ownerRun([{ toolName: 'hass_turn_off', success: false }]))]
        expect((await runConnectionDemandTick({ statePath, isMain: false, now: NOW, runs, found: () => [], connected: () => new Set(), sink: { emit } })).emitted).toEqual([])
        expect((await runConnectionDemandTick({ statePath, isMain: true, now: NOW, runs, found: () => [], connected: () => new Set(['home-assistant']), sink: { emit } })).emitted).toEqual([])
        recordConnectionAnswer('home-assistant', 'nein', { statePath, now: NOW })
        expect((await runConnectionDemandTick({ statePath, isMain: true, now: NOW + DAY * 20, runs: () => [fix(ownerRun([{ toolName: 'hass_turn_off', success: false }], NOW + DAY * 19))], found: () => [], connected: () => new Set(), sink: { emit } })).emitted).toEqual([])
        expect(emit).not.toHaveBeenCalled()
        // Requests about a connected service are not recorded at all.
        noteOwnerRequest('Licht aus', { statePath, now: NOW, connected: () => new Set(['home-assistant']) })
        expect(connectionDemand({ statePath, now: NOW, runs: [] }).get('home-assistant')).toBeUndefined()
    })
})
