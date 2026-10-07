/**
 * 2.89 Paket B — „Eine Verbindungs-Wahrheit“, der Live-Weg: dieselben Fixture-Daten,
 * ALLE Stellen gleichzeitig gefragt — Geräteliste, Verbindungsansicht, Smart-Geräte-Seite,
 * Karten und die Verbindungsfrage durch die echte Nachrichten-Pipeline. Alle müssen
 * dasselbe sagen wie connectionState.
 *
 * Fixture (doc addresses only): Home Assistant 192.0.2.30 connected; Hue Bridge = two
 * records, the pairing key on the „gefunden“ one; Tuya with an approved local way but
 * no key; a watched 3D printer; a watched TV without any way.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const fixtures = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    return { dir: mkdtempSync(join(tmpdir(), 'xv-truth-')), agent: (await import('vitest')).vi.fn() }
})

// The whole runtime reads this fixture as its data directory.
vi.mock('../core/data-root.js', async importOriginal => ({ ...(await importOriginal<any>()), getNovaDataDir: (...parts: string[]) => join(fixtures.dir, ...parts) }))
// Pipeline harness (as one-owner-pipeline.test.ts): scripted agent, no network.
vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: (from: string, channel: string) => ({ allowed: true, permission: from === '1001' ? 'owner' : 'user', isNewUser: false, user: { id: from, channel, permissionSource: 'configured' } }),
    getUserPermission: (from: string) => from === '1001' ? 'owner' : 'user',
    setUserPermission: () => true,
    isGroupChat: () => false, shouldCoalesce: () => false, isCoalescedMarker: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
}))
vi.mock('../core/soul.js', () => ({
    soulExists: () => true, buildSystemPromptFromSoul: () => 'Fixture identity', loadSoul: () => ({}),
    getOnboardingMessage: () => '', isOnboardingResponse: () => false,
    parseOnboardingResponse: () => ({}), saveSoul: () => undefined, getOnboardingConfirmation: () => '',
}))
vi.mock('../agents/nova-runner.js', () => ({ runNovaAgent: fixtures.agent, clearSession: () => undefined }))
vi.mock('../llm/response-cache.js', () => ({ getCachedResponse: () => null, cacheResponse: vi.fn() }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))

const { connectionState, standKontext } = await import('./connection-state.js')
const { collectConnections } = await import('./connections-view.js')
const { requestConnect } = await import('./connect-flow.js')
const { connectionIdFor, saveConnection } = await import('./connection-store.js')
const { consolidateDevices } = await import('../sensing/device-consolidation.js')
const { ownerGeraeteAntworten } = await import('../sensing/device-overview.js')
const { createDeviceConnectExecutor, offerDeviceConnections, DEVICE_CONNECT_KIND } = await import('../sensing/device-connect.js')
const { registerSmartAccessApi } = await import('../sensing/smart-access-api.js')
const { sensingDeviceFingerprint } = await import('../sensing/device-registry.js')
const { createApprovalCard, listApprovalCards, maintainApprovalCards, registerCardExecutor } = await import('../core/approval-cards.js')
const { handleMessage } = await import('../core/message-pipeline.js')

const dir = fixtures.dir
const at = new Date(Date.now() - 60_000).toISOString()
const OWNER = 'telegram:1001'
const dev = (id: string, p: Record<string, unknown>) => ({ id, name: `${p.type} ${p.host}`, via: 'http', status: 'gefunden', foundAt: at, lastSeenAt: at, evidence: {}, ...p }) as any
const ha = dev('dev-00000000a1', { type: 'homeassistant', host: '192.0.2.30', port: 8123, evidence: { uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Home', version: '2026.9.1' } })
const hueA = dev('dev-00000000b1', { type: 'networkservice', host: '192.0.2.143', port: 80, via: 'mdns', evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } })
const hueB = dev('dev-00000000b2', { type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', status: 'eingerichtet', approvedBy: OWNER, approvedAt: at,
    evidence: { service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' },
    hardware: { kind: 'bridge', label: 'Hue Bridge', certainty: 'confirmed', identity: '001788fffe0a1b2c', ecosystem: 'hue', connector: 'hue-readonly', access: 'hue-pairing-v1', observedAt: at } })
const tuya = dev('dev-00000000c1', { type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', status: 'eingerichtet', approvedBy: OWNER, approvedAt: at,
    hardware: { kind: 'unknown', label: 'Tuya', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at } })
const printer = dev('dev-00000000e1', { type: 'moonraker', host: '192.0.2.40', port: 7125, status: 'eingerichtet', approvedBy: 'auto:lesend', approvedAt: at })
const tv = dev('dev-00000000f1', { type: 'networkdevice', host: '192.0.2.50', port: 8008, via: 'mdns', status: 'eingerichtet', evidence: { service: '_googlecast._tcp.local' } })
const devices = [ha, hueA, hueB, tuya, printer, tv]

beforeAll(() => {
    mkdirSync(join(dir, 'sensing'), { recursive: true })
    writeFileSync(join(dir, 'sensing', 'devices.json'), JSON.stringify({ version: 1, devices }))
    writeFileSync(join(dir, 'sensing', 'smart-routes.json'), JSON.stringify({ version: 1, choices: {
        [tuya.id]: { fingerprint: sensingDeviceFingerprint(tuya), owner: OWNER, route: 'local', approved: true },
        [hueB.id]: { fingerprint: sensingDeviceFingerprint(hueB), owner: OWNER, route: 'local', approved: true },
    } }))
    mkdirSync(join(dir, 'secrets', 'smart-devices'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'smart-devices', `${hueA.id}.json`), JSON.stringify({ hueKey: 'x'.repeat(20) }))
    saveConnection({
        id: connectionIdFor('home-assistant'), connectorId: 'home-assistant', trust: 'geprueft', title: 'Home Assistant', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'ha-login',
        transport: { art: 'http', url: 'http://192.0.2.30:8123/api/mcp' }, basis: 'http://192.0.2.30:8123', status: 'verbunden', createdAt: at, updatedAt: at, approvedBy: OWNER, erlaubteWerkzeuge: [],
    }, { dataDir: dir })
    fixtures.agent.mockImplementation(async () => ({ content: 'Modell-Antwort', sessionId: 's', toolsExecuted: [], toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: false } }))
})

const geraete = () => consolidateDevices(devices, {}).geraete
const geraetMit = (host: string) => geraete().find(g => g.adressen.includes(host))!
const truth = (host: string) => connectionState(dir, { geraet: geraetMit(host) }, standKontext(dir))

describe('2.89: alle Stellen sagen für dieselben Daten dasselbe', () => {
    it('die eine Wahrheit (Erwartung)', () => {
        expect(truth('192.0.2.30').zustand).toBe('verbunden')
        expect(truth('192.0.2.143').zustand).toBe('verbunden')
        expect(truth('192.0.2.5')).toEqual({ zustand: 'wartet', grund: 'Code aus der Tuya-App fehlt noch' })
        expect(truth('192.0.2.40').zustand).toBe('verbunden')
        expect(truth('192.0.2.50').zustand).toBe('gefunden')
    })

    it('Verbindungsansicht', async () => {
        const view = await collectConnections({ dataDir: dir, env: {}, accounts: () => [], directoryCachePath: join(dir, 'none.json') } as any)
        for (const host of ['192.0.2.30', '192.0.2.143', '192.0.2.5', '192.0.2.40', '192.0.2.50']) {
            const item = view.gefunden.find(entry => entry.fund.includes(`${host}:`))!
            expect(item, host).toBeDefined()
            expect({ host, zustand: item.zustand, verbunden: item.verbunden }).toEqual({ host, zustand: truth(host).zustand, verbunden: truth(host).zustand === 'verbunden' })
        }
    })

    it('Geräteliste', async () => {
        const { text, details } = await ownerGeraeteAntworten(dir, { kick: () => undefined })
        expect(text).toMatch(/Home Assistant — verbunden/)
        expect(text).toMatch(/Hue Bridge — verbunden/)
        expect(text).toContain('Tuya-Gerät — wartet: Code aus der Tuya-App fehlt noch')
        expect(text).toMatch(/3D-Drucker — ich sehe seinen Fortschritt/)
        expect(text).toMatch(/Fernseher[^\n]* — gefunden/)
        expect(text).not.toMatch(/Fernseher[^\n]*verbunden/)
        expect(details).toMatch(/192\.0\.2\.5 · [^\n]*wartet: Code aus der Tuya-App fehlt noch/)
    })

    it('Smart-Geräte-Seite', async () => {
        const handlers: Record<string, any> = {}
        const app: any = { get: (path: string, handler: any) => { handlers[`GET ${path}`] = handler }, post: (path: string, handler: any) => { handlers[`POST ${path}`] = handler } }
        registerSmartAccessApi(app, { ownerOnly: () => true, authoritative: () => true, root: () => dir, owner: async () => ({ principalId: OWNER, permission: 'owner' }) as any })
        let body: any
        await handlers['GET /api/desktop/smart-geraete']({}, { setHeader: () => undefined, json: (value: unknown) => { body = value } })
        const byId = (id: string) => body.devices.find((d: any) => d.id === id)
        // The paired Hue bridge: key on the OTHER record of the same device — still connected here.
        expect(byId(hueB.id)).toMatchObject({ zustand: truth('192.0.2.143').zustand, verbunden: true })
        expect(byId(tuya.id)).toMatchObject({ zustand: 'wartet', grund: truth('192.0.2.5').grund, accessStored: false })
    })

    it('Karten: nichts Verbundenes wird gefragt, eine alte Frage schließt sich, die Verbinden-Karte sagt „schon verbunden“', async () => {
        registerCardExecutor(createDeviceConnectExecutor({ dataDir: dir }))
        const opts = { dataDir: dir, ledger: null }
        // An old HA device question from before the login …
        createApprovalCard({ art: DEVICE_CONNECT_KIND, titel: 'Home Assistant verbinden?', beleg: 'b', vorschlag: 'v', aktion: { kind: DEVICE_CONNECT_KIND, ref: ha.id }, dedupeKey: 'geraet:alt' }, opts)
        // … closes itself, because the one truth says „verbunden“.
        expect(maintainApprovalCards(opts).settled.map(card => card.aktion.ref)).toEqual([ha.id])
        await offerDeviceConnections({ dataDir: dir, ctx: {}, cardOpts: opts })
        const offen = listApprovalCards({ ...opts, status: 'offen' })
        expect(offen.filter(card => [ha.id, hueA.id, hueB.id].includes(card.aktion.ref.split(':')[0]))).toEqual([])
        const connect = await requestConnect({ connectorId: 'home-assistant' }, { dataDir: dir, cardOpts: opts, env: {} } as any)
        expect(connect).toMatchObject({ ok: false, message: 'Home Assistant ist schon verbunden.' })
    })

    it('Verbindungsfrage durch die echte Pipeline', async () => {
        const ask = async (text: string) => {
            const replies: string[] = []
            const state: any = { config: { channels: { telegram: { allowFrom: ['1001'] } } }, llm: { modelId: 'alias', providerId: 'local', complete: vi.fn() }, tools: { execute: vi.fn() }, startTime: Date.now() }
            await handleMessage('Telegram', '1001', text, async reply => { replies.push(reply) }, state, async () => '')
            return replies.join('\n')
        }
        expect(await ask('Kannst du dich mit Home Assistant verbinden?')).toBe('Ja — Home Assistant ist schon verbunden. Ich nutze es schon.')
        expect(await ask('Kannst du dich mit Hue verbinden?')).toBe('Ja — Hue Bridge ist schon verbunden.')
        expect(await ask('Kannst du dich mit Tuya verbinden?')).toMatch(/^Tuya-Gerät ist angefangen, aber noch nicht fertig: Code aus der Tuya-App fehlt noch/)
    })
})
