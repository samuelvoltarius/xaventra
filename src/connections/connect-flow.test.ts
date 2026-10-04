import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, listApprovalCards } from '../core/approval-cards.js'
import { BUILTIN_CONNECTORS, loadConnectorCatalog, type ConnectorManifest } from './connector-catalog.js'
import { getConnection, loadConnections, readConnectionSecrets, connectionSecretsPath } from './connection-store.js'
import {
    allowConnectionTool, beginLogin, completeLoginAndConnect, connectAndTest, connectFromApproval, disconnectConnection, requestConnect, submitAccess, type ConnectDeps, type ConnectionGateway,
} from './connect-flow.js'
import { haBearerFetch, startLogin } from './connector-login.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-conn-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const gmail = BUILTIN_CONNECTORS.find(entry => entry.name === 'gmail')!
const testCloud: ConnectorManifest = {
    ...structuredClone(gmail), name: 'test-cloud', title: 'Testdienst', scopes: undefined,
    transport: { art: 'http', url: 'https://mcp.example.com/mcp' }, capabilities: { list_items: 'lesen', create_item: 'schreiben' }, findet: undefined, bedarf: undefined,
}
const catalog = loadConnectorCatalog([...BUILTIN_CONNECTORS, testCloud])
const OWNER = { userId: '42', ownerIds: ['42'] }
const SECRET_AT = 'AT-secret-access-123456'
const SECRET_RT = 'RT-secret-refresh-654321'

function fakeGateway(): ConnectionGateway & { connected: string[]; disconnected: string[] } {
    const gateway = {
        connected: [] as string[], disconnected: [] as string[],
        async connect(record: any) { gateway.connected.push(record.id); return { ok: true, at: '2026-10-02T00:00:00.000Z', werkzeuge: 2, lesend: 1, fragend: 1, gesperrt: 0 } },
        disconnect(record: any) { gateway.disconnected.push(record.id) },
    }
    return gateway
}

/** OAuth server at example.com: protected resource metadata, AS metadata, DCR, token. */
function oauthFetch(calls: Array<{ url: string; body?: string }> = []) {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    return vi.fn(async (input: any, init?: any) => {
        const url = String(input instanceof URL ? input.href : input)
        calls.push({ url, body: init?.body ? String(init.body) : undefined })
        if (url.startsWith('https://mcp.example.com/.well-known/oauth-protected-resource')) return json(200, { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'] })
        if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
            return json(200, {
                issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token',
                registration_endpoint: 'https://auth.example.com/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
                grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
            })
        }
        if (url === 'https://auth.example.com/register') return json(201, { client_id: 'dyn-client-1', redirect_uris: ['http://127.0.0.1:3011/verbindungen/rueckkehr'], token_endpoint_auth_method: 'none' })
        if (url === 'https://auth.example.com/token') return json(200, { access_token: SECRET_AT, token_type: 'Bearer', expires_in: 3600, refresh_token: SECRET_RT })
        return new Response('not found', { status: 404 })
    })
}

function depsFor(dir: string, extra: Partial<ConnectDeps> = {}): ConnectDeps & { gateway: ReturnType<typeof fakeGateway> } {
    return {
        dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, catalog, redirectBase: 'http://127.0.0.1:3011', env: {},
        gateway: fakeGateway(), askLogin: vi.fn(), foundHomeAssistant: () => ['http://ha.example.com:8123'], ...extra,
    } as any
}

async function pressJa(dir: string, cardId: string) {
    const card = listApprovalCards({ dataDir: dir, ledger: null }).find(item => item.id === cardId)!
    const token = card.buttons.find(button => button.answer === 'ja')!.token
    return answerApprovalCard(`ac:${token}`, OWNER, { dataDir: dir, ledger: null })
}

describe('Verbinden = eine Karte (2.85 Paket A, Punkt 4)', () => {
    it('discovered HA approval immediately offers login, then reads actual functions after callback without another owner command', async () => {
        const dir = tmp()
        const fetchFn = vi.fn(async (input: any) => String(input).endsWith('/auth/token')
            ? new Response(JSON.stringify({ access_token: SECRET_AT, refresh_token: SECRET_RT, token_type: 'Bearer', expires_in: 3600 }), { status: 200 })
            : String(input).endsWith('/api/template') ? new Response(JSON.stringify([{ entity_id: 'light.office', device_id: 'b'.repeat(32), manufacturer: 'Shelly', model: 'Test light' }]), { status: 200 })
            : new Response(JSON.stringify([{ entity_id: 'light.office', state: 'off', attributes: { friendly_name: 'Bürolicht' } }]), { status: 200 }))
        const deps = depsFor(dir, { fetchFn })
        expect(loadConnections({ dataDir: dir })).toEqual([])
        const approved = await connectFromApproval('home-assistant', 'telegram:42', deps)
        expect(approved.ok).toBe(true)
        const url = new URL(approved.message.match(/https?:\/\/\S*\/auth\/authorize\?\S+/)![0])
        expect(url.origin).toBe('http://ha.example.com:8123')
        expect(deps.gateway.connected).toEqual([])
        expect(fetchFn).not.toHaveBeenCalled()
        const callback = await completeLoginAndConnect({ state: url.searchParams.get('state'), code: 'owner-approved-code' }, deps)
        expect(callback.ok).toBe(true)
        const { refreshHaInventory } = await import('../sensing/ha-inventory.js')
        const inventory = await refreshHaInventory(dir, null, new AbortController().signal, fetchFn)
        expect(inventory[0]).toMatchObject({ status: 'ok', functions: [{ id: 'light.office', name: 'Bürolicht', state: 'off', manufacturer: 'Shelly', model: 'Test light' }] })
        expect(fetchFn.mock.calls.map(call => String(call[0]))).toEqual(['http://ha.example.com:8123/auth/token', 'http://ha.example.com:8123/api/states', 'http://ha.example.com:8123/api/template'])
        expect(approved.message).not.toContain(SECRET_AT)
        expect(JSON.stringify(inventory)).not.toContain(SECRET_RT)
    })
    it('one card per service; nothing is written before the Ja', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        const first = await requestConnect({ connectorId: 'home-assistant' }, deps)
        const again = await requestConnect({ connectorId: 'home-assistant' }, deps)
        expect(first.ok && first.created).toBe(true)
        expect(again.ok && again.created).toBe(false)
        expect(first.ok && first.card.aktion.kind).toBe('verbindung-herstellen')
        expect(first.ok && first.card.beleg).toContain('http://ha.example.com:8123')
        expect(first.ok && first.card.buttons.map(button => button.answer)).toEqual(['ja', 'nein', 'spaeter'])
        expect(loadConnections({ dataDir: dir })).toEqual([])
        expect((await requestConnect({ connectorId: 'gibt-es-nicht' }, deps)).ok).toBe(false)
    })

    it('Ja writes the connection; a service without login is connected and tested at once', async () => {
        const dir = tmp()
        const deps = depsFor(dir)
        const request = await requestConnect({ connectorId: 'dateien', ordner: join(dir, 'freigabe') }, deps)
        expect(request.ok).toBe(true)
        const answer = await pressJa(dir, (request as any).card.id)
        expect(answer.message).toMatch(/verbunden und getestet: 2 Werkzeuge/)
        const record = loadConnections({ dataDir: dir })[0]
        expect(record).toMatchObject({ connectorId: 'dateien', status: 'verbunden', approvedBy: 'telegram:42', trust: 'geprueft' })
        expect(record.transport).toMatchObject({ art: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', join(dir, 'freigabe')] })
        expect(deps.gateway.connected).toEqual([record.id])
        // A folder that is the whole drive is refused before any card.
        expect((await requestConnect({ connectorId: 'dateien', ordner: '/' }, depsFor(tmp()))).ok).toBe(false)
    })

    it('OAuth: Ja → login link (PKCE, own state) → return → tokens only in the 0600 secrets file → connected', async () => {
        const dir = tmp()
        const calls: Array<{ url: string; body?: string }> = []
        const deps = depsFor(dir, { fetchFn: oauthFetch(calls) as any })
        const request = await requestConnect({ connectorId: 'test-cloud' }, deps)
        const answer = await pressJa(dir, (request as any).card.id)
        expect(answer.message).toMatch(/einmal anmelden/)
        const id = loadConnections({ dataDir: dir })[0].id
        const login = await beginLogin(id, deps)
        expect(login.ok).toBe(true)
        const url = new URL(login.url!)
        expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3011/verbindungen/rueckkehr')
        expect(url.searchParams.get('client_id')).toBe('dyn-client-1')
        const state = url.searchParams.get('state')!
        expect(state).toMatch(/^[a-f0-9]{48}$/)

        const done = await completeLoginAndConnect({ state, code: 'code-from-browser' }, deps)
        expect(done).toMatchObject({ ok: true })
        expect(getConnection(id, { dataDir: dir })!.status).toBe('verbunden')
        const tokenCall = calls.find(call => call.url === 'https://auth.example.com/token')!
        expect(tokenCall.body).toContain('code_verifier=')
        expect(readConnectionSecrets(id, { dataDir: dir }).oauth?.tokens?.access_token).toBe(SECRET_AT)
        if (process.platform !== 'win32') expect(statSync(connectionSecretsPath(id, { dataDir: dir })).mode & 0o777).toBe(0o600)
        // Never in the connection file, the cards, the answers.
        const visible = [readFileSync(join(dir, 'connections', 'connections.json'), 'utf8'), JSON.stringify(listApprovalCards({ dataDir: dir, ledger: null })), answer.message, done.message, login.message]
        for (const text of visible) { expect(text).not.toContain(SECRET_AT); expect(text).not.toContain(SECRET_RT) }
        for (const name of readdirSync(join(dir, 'approval-cards'))) expect(readFileSync(join(dir, 'approval-cards', name), 'utf8')).not.toContain(SECRET_AT)

        // The return is single use.
        expect((await completeLoginAndConnect({ state, code: 'again' }, deps)).ok).toBe(false)
    })

    it('a stale or unknown return is refused; Google without the owner\'s OAuth client says so instead of guessing', async () => {
        const dir = tmp()
        let now = 1_000_000
        const deps = depsFor(dir, { fetchFn: oauthFetch() as any, now: () => now })
        await pressJa(dir, ((await requestConnect({ connectorId: 'test-cloud' }, deps)) as any).card.id)
        const id = loadConnections({ dataDir: dir })[0].id
        const state = new URL((await beginLogin(id, deps)).url!).searchParams.get('state')!
        now += 16 * 60_000
        expect((await completeLoginAndConnect({ state, code: 'late' }, deps)).message).toMatch(/abgelaufen/)
        expect((await completeLoginAndConnect({ state: 'f'.repeat(48), code: 'x' }, deps)).ok).toBe(false)

        const dir2 = tmp()
        const deps2 = depsFor(dir2)
        await pressJa(dir2, ((await requestConnect({ connectorId: 'google-calendar' }, deps2)) as any).card.id)
        const login = await beginLogin(loadConnections({ dataDir: dir2 })[0].id, deps2)
        expect(login).toMatchObject({ ok: false })
        expect(login.message).toMatch(/OAuth-Zugang des Owners/)
    })

    it('Home Assistant: own login flow (IndieAuth client id, PKCE), fresh bearer, expiry → exactly one request', async () => {
        const dir = tmp()
        let now = 5_000_000
        const tokenBodies: string[] = []
        let refreshWorks = true
        const fetchFn = vi.fn(async (input: any, init?: any) => {
            const url = String(input)
            if (url === 'http://ha.example.com:8123/auth/token') {
                const body = String(init?.body || '')
                tokenBodies.push(body)
                if (body.includes('grant_type=refresh_token') && !refreshWorks) return new Response('{"error":"invalid_grant"}', { status: 400 })
                return new Response(JSON.stringify({ access_token: body.includes('refresh_token') ? 'HA-AT-2' : 'HA-AT-1', refresh_token: 'HA-RT', expires_in: 1800, token_type: 'Bearer' }), { status: 200 })
            }
            if (url === 'http://ha.example.com:8123/api/mcp') return new Response('{}', { status: 200, headers: { 'x-auth': new Headers(init?.headers).get('authorization') || '' } })
            return new Response('', { status: 404 })
        })
        const askLogin = vi.fn()
        const deps = depsFor(dir, { fetchFn: fetchFn as any, now: () => now, askLogin })
        await pressJa(dir, ((await requestConnect({ connectorId: 'home-assistant' }, deps)) as any).card.id)
        const id = loadConnections({ dataDir: dir })[0].id
        const start = await startLogin(id, deps)
        const url = new URL((start as any).url)
        expect(url.origin + url.pathname).toBe('http://ha.example.com:8123/auth/authorize')
        expect(url.searchParams.get('client_id')).toBe('http://127.0.0.1:3011/')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        const done = await completeLoginAndConnect({ state: url.searchParams.get('state'), code: 'ha-code' }, deps)
        expect(done.ok).toBe(true)
        expect(tokenBodies[0]).toContain('grant_type=authorization_code')
        expect(tokenBodies[0]).toContain('client_id=http%3A%2F%2F127.0.0.1%3A3011%2F')
        expect(tokenBodies[0]).toContain('code_verifier=')

        const haFetch = haBearerFetch(id, deps)
        expect((await haFetch('http://ha.example.com:8123/api/mcp', {})).headers.get('x-auth')).toBe('Bearer HA-AT-1')
        now += 1800_000
        expect((await haFetch('http://ha.example.com:8123/api/mcp', {})).headers.get('x-auth')).toBe('Bearer HA-AT-2')
        refreshWorks = false
        now += 1800_000
        await expect(haFetch('http://ha.example.com:8123/api/mcp', {})).rejects.toThrow(/abgelaufen/)
        await expect(haFetch('http://ha.example.com:8123/api/mcp', {})).rejects.toThrow(/abgelaufen/)
        expect(getConnection(id, { dataDir: dir })!.status).toBe('abgelaufen')
        expect(askLogin).toHaveBeenCalledTimes(1)
        // A new successful login clears the request marker (next expiry asks again, once).
        const again = new URL(((await startLogin(id, deps)) as any).url)
        refreshWorks = true
        expect((await completeLoginAndConnect({ state: again.searchParams.get('state'), code: 'ha-code-2' }, deps)).ok).toBe(true)
        expect(getConnection(id, { dataDir: dir })!.loginAskedAt).toBeUndefined()
    })

    it('connection failure with 401 marks the login expired (one request), Trennen removes the stored login', async () => {
        const dir = tmp()
        const askLogin = vi.fn()
        const deps = depsFor(dir, { askLogin })
        await pressJa(dir, ((await requestConnect({ connectorId: 'dateien', ordner: join(dir, 'f') }, deps)) as any).card.id)
        const id = loadConnections({ dataDir: dir })[0].id
        const failing = { connect: async () => { throw new Error('HTTP 401 Unauthorized') }, disconnect: () => undefined }
        await connectAndTest(id, { ...deps, gateway: failing })
        await connectAndTest(id, { ...deps, gateway: failing })
        expect(askLogin).toHaveBeenCalledTimes(1)
        const result = await disconnectConnection(id, deps)
        expect(result.ok).toBe(true)
        expect(getConnection(id, { dataDir: dir })!.status).toBe('getrennt')
        expect(readConnectionSecrets(id, { dataDir: dir })).toEqual({})
        expect(deps.gateway.disconnected).toEqual([id])
    })

    it('found self-hosted service (n8n): address from the discovery, owner enters only the token, Bearer only in the runtime config', async () => {
        const dir = tmp()
        const deps = depsFor(dir, { foundServices: (type: string) => type === 'n8n' ? ['http://n8n.example.com:5678'] : [] })
        const request = await requestConnect({ connectorId: 'n8n' }, deps)
        expect((request as any).card.beleg).toContain('http://n8n.example.com:5678')
        const answer = await pressJa(dir, (request as any).card.id)
        expect(answer.message).toMatch(/Zugang in „Verbindungen“ eintragen/)
        const record = loadConnections({ dataDir: dir })[0]
        expect(record).toMatchObject({ status: 'wartet-auf-zugang', basis: 'http://n8n.example.com:5678', transport: { art: 'http', url: 'http://n8n.example.com:5678/mcp-server/http' } })
        expect((await submitAccess(record.id, {}, deps)).ok).toBe(false)
        const done = await submitAccess(record.id, { N8N_MCP_TOKEN: 'n8n-token-secret-123' }, deps)
        expect(done.ok).toBe(true)
        expect(readFileSync(join(dir, 'connections', 'connections.json'), 'utf8')).not.toContain('n8n-token-secret-123')
        const { connectionServerConfig } = await import('../mcp/mcp-runtime.js')
        const config = await connectionServerConfig(getConnection(record.id, { dataDir: dir })!, deps)
        expect(config).toMatchObject({ transport: 'http', url: 'http://n8n.example.com:5678/mcp-server/http', allowLanHttp: true, headers: { Authorization: 'Bearer n8n-token-secret-123' } })
        // Paperless: the found address fills PAPERLESS_URL, the token is the only owner input.
        const dir2 = tmp()
        const deps2 = depsFor(dir2, { foundServices: (type: string) => type === 'paperless' ? ['http://paperless.example.com:8000'] : [] })
        await pressJa(dir2, ((await requestConnect({ connectorId: 'paperless' }, deps2)) as any).card.id)
        const paperless = loadConnections({ dataDir: dir2 })[0]
        expect((await submitAccess(paperless.id, { PAPERLESS_TOKEN: 'pl-token' }, deps2)).ok).toBe(true)
        expect(readConnectionSecrets(paperless.id, { dataDir: dir2 }).zugang).toEqual({ PAPERLESS_URL: 'http://paperless.example.com:8000', PAPERLESS_TOKEN: 'pl-token' })
    })

    it('community: only over an https remote, never from a package; tools are allowed one by one', async () => {
        const dir = tmp()
        const cachePath = join(dir, 'registry.json')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: 1, complete: true, entries: [
            { name: 'io.example/wetter', title: 'Wetter', description: 'Wetterdaten', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/wetter', auth: false }], packages: [], trust: 'community' },
            { name: 'io.example/nurpaket', title: 'Nur Paket', description: 'x', version: '1.0.0', remotes: [], packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0', transport: 'stdio' }], trust: 'community' },
        ] }))
        const deps = depsFor(dir, { directoryCachePath: cachePath })
        expect((await requestConnect({ connectorId: 'io.example/nurpaket' }, deps)).message).toMatch(/nie automatisch/)
        const request = await requestConnect({ connectorId: 'io.example/wetter' }, deps)
        expect((request as any).card.beleg).toMatch(/NICHT GEPRÜFT/)
        await pressJa(dir, (request as any).card.id)
        const record = loadConnections({ dataDir: dir })[0]
        expect(record).toMatchObject({ trust: 'community', status: 'verbunden', transport: { art: 'http', url: 'https://mcp.example.com/wetter' } })
        expect((await allowConnectionTool(record.id, 'set_alarm', deps)).ok).toBe(true)
        expect(getConnection(record.id, { dataDir: dir })!.erlaubteWerkzeuge).toEqual(['set_alarm'])
    })
})
