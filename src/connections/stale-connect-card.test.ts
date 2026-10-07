/**
 * 2.89 Paket B, Punkt 0 (dringend): an old „verbinden?“ card must never reset a
 * connection that is already connected. Live way: the real card store, the real
 * executor registration (requestConnect registers it) and answerApprovalCard.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, listApprovalCards, maintainApprovalCards } from '../core/approval-cards.js'
import { BUILTIN_CONNECTORS, loadConnectorCatalog } from './connector-catalog.js'
import { connectionIdFor, getConnection, saveConnection, type ConnectionRecord } from './connection-store.js'
import { establishConnection, registerConnectCardExecutor, requestConnect, type ConnectDeps } from './connect-flow.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-stale-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const catalog = loadConnectorCatalog([...BUILTIN_CONNECTORS])
const OWNER = { userId: '42', ownerIds: ['42'] }

function depsFor(dir: string): ConnectDeps {
    return {
        dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, catalog, redirectBase: 'http://127.0.0.1:3011', env: {},
        gateway: { connect: vi.fn(async () => ({ ok: true, at: '2026-10-07T00:00:00.000Z', werkzeuge: 1, lesend: 1, fragend: 0, gesperrt: 0 })), disconnect: vi.fn() },
        askLogin: vi.fn(), foundHomeAssistant: () => ['http://192.0.2.10:8123'],
    } as any
}

function connectedHa(dir: string): ConnectionRecord {
    const iso = '2026-10-07T00:00:00.000Z'
    return saveConnection({
        id: connectionIdFor('home-assistant'), connectorId: 'home-assistant', trust: 'geprueft', title: 'Home Assistant', kategorie: 'zuhause', datenklasse: 'lokal',
        auth: 'ha-login', transport: { art: 'http', url: 'http://192.0.2.10:8123/api/mcp' }, basis: 'http://192.0.2.10:8123', status: 'verbunden',
        createdAt: iso, updatedAt: iso, approvedBy: 'telegram:42', erlaubteWerkzeuge: [], letzterTest: { ok: true, at: iso, werkzeuge: 3, lesend: 3, fragend: 0, gesperrt: 0 },
    }, { dataDir: dir })
}

const requestIdOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'connections', 'requests.json'), 'utf8')).requests[0].id as string

describe('2.89 B0: eine alte Verbinden-Karte setzt nie eine bestehende Verbindung zurück', () => {
    it('Ja on an old card after the service got connected: connection stays „verbunden“, the card closes itself', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        const request = await requestConnect({ connectorId: 'home-assistant' }, deps)
        expect(request.ok).toBe(true)
        // Meanwhile Home Assistant got connected on another way (login finished, device card …).
        connectedHa(dir)
        const card = listApprovalCards({ dataDir: dir, ledger: null }).find(item => item.id === (request as any).card.id)!
        const token = card.buttons.find(button => button.answer === 'ja')!.token
        const answer = await answerApprovalCard(`ac:${token}`, OWNER, { dataDir: dir, ledger: null })
        expect(answer.ok).toBe(false)
        expect(answer.message).toMatch(/erledigt/i)
        expect(getConnection(connectionIdFor('home-assistant'), { dataDir: dir })?.status).toBe('verbunden')
        expect(listApprovalCards({ dataDir: dir, ledger: null }).find(item => item.id === card.id)?.status).toBe('erledigt')
    })

    it('the card maintenance closes such a card without any press', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        registerConnectCardExecutor(deps, { force: true })
        const request = await requestConnect({ connectorId: 'home-assistant' }, deps)
        connectedHa(dir)
        const { settled } = maintainApprovalCards({ dataDir: dir, ledger: null })
        expect(settled.map(item => item.id)).toEqual([(request as any).card.id])
    })

    it('establishConnection itself refuses to overwrite a connected record (defence in depth)', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        await requestConnect({ connectorId: 'home-assistant' }, deps)
        const requestId = requestIdOf(dir)
        connectedHa(dir)
        const result = await establishConnection(requestId, 'telegram:42', deps)
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/schon verbunden/)
        const record = getConnection(connectionIdFor('home-assistant'), { dataDir: dir })!
        expect(record.status).toBe('verbunden')
        expect(record.letzterTest?.werkzeuge).toBe(3)
    })

    it('a connection that only waits or failed is still set up again by the card', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        await requestConnect({ connectorId: 'home-assistant' }, deps)
        const requestId = requestIdOf(dir)
        saveConnection({ ...connectedHa(dir), status: 'fehler' }, { dataDir: dir })
        const result = await establishConnection(requestId, 'telegram:42', deps)
        expect(result.ok).toBe(true)
        expect(getConnection(connectionIdFor('home-assistant'), { dataDir: dir })?.status).toBe('wartet-auf-anmeldung')
    })
})
