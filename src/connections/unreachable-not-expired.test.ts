import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, listApprovalCards } from '../core/approval-cards.js'
import { BUILTIN_CONNECTORS, loadConnectorCatalog } from './connector-catalog.js'
import { getConnection, loadConnections } from './connection-store.js'
import { completeLoginAndConnect, connectAndTest, requestConnect, type ConnectDeps } from './connect-flow.js'
import { haBearerFetch, startLogin } from './connector-login.js'
import { connectionState } from './connection-state.js'

// B3 (28.10.2026, VM 130 nach dem Umzug): HA unter 192.168.0.30 war von der VM aus nicht
// erreichbar ("fetch failed"). Der Eintrag stand trotzdem auf `status: abgelaufen` mit
// `loginAskedAt` 01:06 und im Log: "error: 'Home Assistant: Anmeldung abgelaufen'".

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-unreach-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const catalog = loadConnectorCatalog([...BUILTIN_CONNECTORS])
const OWNER = { userId: '42', ownerIds: ['42'] }

function depsFor(dir: string, extra: Partial<ConnectDeps> = {}): ConnectDeps {
    return {
        dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, catalog, redirectBase: 'http://127.0.0.1:3011', env: {},
        gateway: { connect: async () => ({ ok: true, at: '2026-10-28T00:00:00.000Z', werkzeuge: 22, lesend: 10, fragend: 12, gesperrt: 0 }), disconnect: () => undefined },
        askLogin: vi.fn(), foundHomeAssistant: () => ['http://192.168.0.30:8123'], ...extra,
    } as any
}

async function connectedHa(dir: string, deps: ConnectDeps) {
    const card = await requestConnect({ connectorId: 'home-assistant' }, deps) as any
    const token = listApprovalCards({ dataDir: dir, ledger: null }).find(item => item.id === card.card.id)!.buttons.find(b => b.answer === 'ja')!.token
    await answerApprovalCard(`ac:${token}`, OWNER, { dataDir: dir, ledger: null })
    const id = loadConnections({ dataDir: dir })[0].id
    const url = new URL(((await startLogin(id, deps)) as any).url)
    expect((await completeLoginAndConnect({ state: url.searchParams.get('state'), code: 'ha-code' }, deps)).ok).toBe(true)
    return id
}

describe('B3: unreachable is not expired', () => {
    it('token refresh that cannot reach HA → "nicht erreichbar" with address, no login request', async () => {
        const dir = tmp()
        let now = 5_000_000
        let online = true
        const fetchFn = vi.fn(async (input: any) => {
            if (!online) throw new TypeError('fetch failed')
            if (String(input).endsWith('/auth/token')) return new Response(JSON.stringify({ access_token: 'HA-AT', refresh_token: 'HA-RT', expires_in: 1800 }), { status: 200 })
            return new Response('{}', { status: 200 })
        })
        const askLogin = vi.fn()
        const deps = depsFor(dir, { fetchFn: fetchFn as any, now: () => now, askLogin })
        const id = await connectedHa(dir, deps)

        online = false
        now += 1800_000
        const error = await haBearerFetch(id, deps)('http://192.168.0.30:8123/api/mcp', {}).catch(e => e as Error)
        expect(error.message).not.toMatch(/abgelaufen/)
        expect(error.message).toMatch(/nicht erreichbar/)
        expect(error.message).toContain('http://192.168.0.30:8123')
        expect((error as any).status).not.toBe(401)
        const record = getConnection(id, { dataDir: dir })!
        expect(record.status).toBe('nicht-erreichbar')
        expect(record.loginAskedAt).toBeUndefined()
        expect(record.nichtErreichbar).toMatchObject({ adresse: 'http://192.168.0.30:8123' })
        expect(askLogin).not.toHaveBeenCalled()
        expect(connectionState(dir, { verbindung: record }).grund).toBe('nicht erreichbar (http://192.168.0.30:8123)')

        // Back online: the refresh works again and the connection is connected without any login.
        online = true
        await haBearerFetch(id, deps)('http://192.168.0.30:8123/api/mcp', {})
        expect(getConnection(id, { dataDir: dir })!.status).toBe('verbunden')
        expect(askLogin).not.toHaveBeenCalled()
    })

    it('a rejected refresh (HTTP 400 invalid_grant) still means expired — exactly one request', async () => {
        const dir = tmp()
        let now = 5_000_000
        let reject = false
        const fetchFn = vi.fn(async (input: any) => {
            if (String(input).endsWith('/auth/token')) return reject ? new Response('{"error":"invalid_grant"}', { status: 400 }) : new Response(JSON.stringify({ access_token: 'HA-AT', refresh_token: 'HA-RT', expires_in: 1800 }), { status: 200 })
            return new Response('{}', { status: 200 })
        })
        const askLogin = vi.fn()
        const deps = depsFor(dir, { fetchFn: fetchFn as any, now: () => now, askLogin })
        const id = await connectedHa(dir, deps)
        reject = true
        now += 1800_000
        await expect(haBearerFetch(id, deps)('http://192.168.0.30:8123/api/mcp', {})).rejects.toThrow(/abgelaufen/)
        expect(getConnection(id, { dataDir: dir })!.status).toBe('abgelaufen')
        expect(askLogin).toHaveBeenCalledTimes(1)
    })

    it('connect test with "fetch failed" → nicht erreichbar, never a login', async () => {
        const dir = tmp()
        const askLogin = vi.fn()
        const deps = depsFor(dir, { askLogin, fetchFn: vi.fn(async () => new Response(JSON.stringify({ access_token: 'HA-AT', refresh_token: 'HA-RT', expires_in: 1800 }), { status: 200 })) as any })
        const id = await connectedHa(dir, deps)
        const failing = { connect: async () => { throw new Error('MCP home-assistant connection failed: fetch failed') }, disconnect: () => undefined }
        const result = await connectAndTest(id, { ...deps, gateway: failing } as any)
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/nicht erreichbar/)
        expect(result.message).toContain('http://192.168.0.30:8123')
        expect(getConnection(id, { dataDir: dir })!.status).toBe('nicht-erreichbar')
        expect(askLogin).not.toHaveBeenCalled()
    })
})
