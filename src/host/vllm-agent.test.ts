import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDockerHostAgent } from './docker-agent.js'
import { createHostVllmSwitcher, parseModelIds, type VllmLaunchOptions } from './vllm-agent.js'
import { DEFAULT_VLLM_TARGETS, issueVllmTicket, VLLM_TICKET_TTL_MS, verifyVllmTicket, vllmTicketBytes, type VllmOperation, type VllmPurpose, type VllmTicket } from '../install/vllm-ticket.js'

// Phase 8 (host side): no real spark-models.sh is started — the launcher is a mock.

const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
const pem = (k: any, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString()
const publicKey = pem(keys.publicKey, 'spki'), privateKey = pem(keys.privateKey, 'pkcs8')
const PLAN = 'v0123456789ab'
const ticket = (operation: VllmOperation, target = 'coder', purpose: VllmPurpose = 'wechsel', overrides: Partial<{ planId: string; nodeId: string; approvedBy: string }> = {}, now = Date.now()) =>
    issueVllmTicket({ operation, purpose, target, planId: PLAN, approvedBy: 'owner:111', nodeId: 'spark', clientId: 'main', targets: DEFAULT_VLLM_TARGETS, ...overrides }, privateKey, now)
const resign = (payload: VllmTicket, key = privateKey) => ({ payload, signature: sign(null, vllmTicketBytes(payload), key).toString('base64') })

let home: string, stateDir: string, launches: Array<{ file: string; args: string[]; options: VllmLaunchOptions }>, exitNow: Array<(code: number) => void>
const launcher = {
    async launch(file: string, args: string[], options: VllmLaunchOptions) {
        launches.push({ file, args, options })
        return { pid: 4242, exited: new Promise<number | null>(resolve => exitNow.push(resolve)) }
    },
}
function switcher() {
    return createHostVllmSwitcher({ nodeId: 'spark', clientId: 'main', stateDir, ticketPublicKey: publicKey, user: { uid: 1000, gid: 998, home, name: 'tgbrutus' }, script: join(home, 'spark-models.sh') }, launcher)
}
const marker = () => join(home, '.spark-stage-saved-target')

// Windows runners may expose an 8.3 TEMP path (e.g. RUNNER~1), which is
// deliberately outside the host-agent's closed path alphabet. Keep the mock
// Linux host fixture under the checkout, without relaxing production validation.
const fixtureParent = join(process.env.NOVA_PROJECT_ROOT || process.cwd(), '.nova-test-tmp')
mkdirSync(fixtureParent, { recursive: true })
const fixtureRoot = mkdtempSync(join(fixtureParent, 'vllm-'))

beforeEach(() => {
    home = mkdtempSync(join(fixtureRoot, 'home-'))
    stateDir = mkdtempSync(join(tmpdir(), 'vllm-state-'))
    launches = []; exitNow = []
    writeFileSync(join(home, 'spark-models.sh'), '#!/bin/sh\nexit 0\n')
    writeFileSync(join(home, '.spark-current-model'), 'flash\n')
    writeFileSync(join(home, '.spark-model-ids'), '# ziel=id\nflash=qwen\ncoder=qwen\nnano qwen-nano\nevil=$(id)\n')
})

describe('vLLM-Tickets', () => {
    it('werden nur für Ziele der geschlossenen Liste und nur mit Owner-Freigabe ausgestellt', () => {
        expect(() => ticket('wechseln', 'flash; rm -rf /')).toThrow(/Liste/)
        expect(() => ticket('wechseln', 'gpt-4o')).toThrow(/Liste/)
        expect(() => ticket('wechseln', 'coder', 'wechsel', { approvedBy: 'model:qwen' })).toThrow(/Owner/)
        expect(() => ticket('wechseln', 'coder', 'wechsel', { approvedBy: 'policy:erlauben' })).toThrow(/Owner/)
        expect(() => ticket('stoppen' as VllmOperation)).toThrow()
        expect(ticket('wechseln').payload.id).toMatch(/^vllm-[a-f0-9-]{36}$/)
    })

    it('lehnt gefälschte, veränderte, abgelaufene und fremde Tickets ab', () => {
        const ctx = { nodeId: 'spark', clientId: 'main', publicKey, targets: DEFAULT_VLLM_TARGETS }
        const good = ticket('wechseln')
        expect(verifyVllmTicket(good, ctx).target).toBe('coder')
        const bad: unknown[] = [
            undefined, {}, { payload: good.payload }, { ...good, signature: 'AAAA' },
            resign(good.payload, pem(other.privateKey, 'pkcs8')),
            { payload: { ...good.payload, target: 'nano' }, signature: good.signature },
            resign({ ...good.payload, target: 'flash;reboot' }),
            resign({ ...good.payload, operation: 'stoppen' as VllmOperation }),
            resign({ ...good.payload, expiresAt: Date.now() + 60 * 60_000 }),
            ticket('wechseln', 'coder', 'wechsel', {}, Date.now() - VLLM_TICKET_TTL_MS - 1),
            ticket('wechseln', 'coder', 'wechsel', { nodeId: 'ns1' }),
            resign({ ...good.payload, command: 'docker stop vllm' } as any),
            { ...good, extra: true },
        ]
        for (const value of bad) expect(() => verifyVllmTicket(value, ctx)).toThrow()
    })
})

describe('Host-Agent: vLLM-Wechsel am Spark', () => {
    it('lehnt unsichere Home-Pfade weiterhin vor jedem Start ab', () => {
        expect(() => createHostVllmSwitcher({ nodeId: 'spark', clientId: 'main', stateDir,
            ticketPublicKey: publicKey, user: { uid: 1000, gid: 998, home: home + '~unsafe' } }, launcher)).toThrow(/Benutzer ungültig/)
        expect(launches).toEqual([])
    })
    it('liest Zustand und Modell-IDs (nur Ziele der Liste, keine Shell-Werte)', async () => {
        expect(parseModelIds('flash=qwen\ncoder: qwen-coder\nnano qwen\nevil=$(id)\nfoo=bar', DEFAULT_VLLM_TARGETS)).toEqual({ flash: 'qwen', coder: 'qwen-coder', nano: 'qwen' })
        const state = await switcher().state()
        expect(state).toMatchObject({ currentTarget: 'flash', maintenance: false, ownMarkerPlan: null, switchRunning: false })
        expect(state.modelIds).toEqual({ flash: 'qwen', coder: 'qwen', nano: 'qwen-nano' })
    })

    it('markieren → wechseln (abgekoppelt, fester argv, als vLLM-Benutzer) → freigeben', async () => {
        const agent = switcher()
        expect(await agent.action(ticket('markieren'))).toMatchObject({ success: true, savedTarget: 'flash' })
        expect(readFileSync(marker(), 'utf8')).toBe('flash\n')
        const launched = await agent.action(ticket('wechseln'))
        expect(launched).toMatchObject({ success: true, target: 'coder' })
        expect(launches).toHaveLength(1)
        expect(launches[0].file).toBe(join(home, 'spark-models.sh'))
        expect(launches[0].args).toEqual(['switch', 'coder'])
        expect(launches[0].options).toMatchObject({ uid: 1000, gid: 998, cwd: home })
        expect(Object.keys(launches[0].options.env).sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'USER'])
        expect((await agent.state()).switchRunning).toBe(true)
        exitNow[0](0)
        await new Promise(resolve => setImmediate(resolve))
        expect((await agent.state()).switchRunning).toBe(false)
        expect(await agent.action(ticket('freigeben'))).toMatchObject({ success: true })
        expect(existsSync(marker())).toBe(false)
    })

    it('wechselt nie ohne eigene Wartungsmarke und überschreibt nie eine fremde', async () => {
        const agent = switcher()
        await expect(agent.action(ticket('wechseln'))).rejects.toThrow(/eigenen Wartungsmarke/)
        writeFileSync(marker(), 'qwen35\n')
        await expect(agent.action(ticket('markieren'))).rejects.toThrow(/existiert bereits/)
        await expect(agent.action(ticket('freigeben'))).rejects.toThrow(/fremde Marke bleibt/)
        expect(readFileSync(marker(), 'utf8')).toBe('qwen35\n')
        expect(launches).toEqual([])
    })

    it('Einmal-Tickets: Wiederholung und Ticket eines anderen Plans werden abgelehnt', async () => {
        const agent = switcher()
        const mark = ticket('markieren')
        await agent.action(mark)
        await expect(agent.action(mark)).rejects.toThrow(/bereits verwendet/)
        await expect(agent.action(ticket('wechseln', 'coder', 'wechsel', { planId: 'vffffffffffff' }))).rejects.toThrow(/eigenen Wartungsmarke/)
        const switchTicket = ticket('wechseln')
        await agent.action(switchTicket)
        await expect(agent.action(switchTicket)).rejects.toThrow(/bereits verwendet/)
        // A second switch must wait; the way back may run while a hung start is still alive.
        await expect(agent.action(ticket('wechseln', 'nano'))).rejects.toThrow(/läuft bereits/)
        expect(await agent.action(ticket('wechseln', 'flash', 'rueckweg'))).toMatchObject({ success: true, purpose: 'rueckweg' })
        expect(launches.map(item => item.args)).toEqual([['switch', 'coder'], ['switch', 'flash']])
    })

    it('Host-Zielliste ist geschlossen: ein vom Main erlaubtes, am Host nicht gelistetes Ziel wird abgelehnt', async () => {
        const agent = createHostVllmSwitcher({ nodeId: 'spark', clientId: 'main', stateDir, ticketPublicKey: publicKey, user: { uid: 1000, gid: 998, home }, script: join(home, 'spark-models.sh'), targets: ['flash', 'nano'] }, launcher)
        await expect(agent.action(ticket('markieren'))).rejects.toThrow(/Liste/)
    })

    it('verweigert root als vLLM-Benutzer', () => {
        expect(() => createHostVllmSwitcher({ nodeId: 'spark', clientId: 'main', stateDir, ticketPublicKey: publicKey, user: { uid: 0, gid: 0, home } }, launcher)).toThrow(/nicht root/)
    })
})

describe('Host-Agent-Server: nur state und action, keine Stopp-Route', () => {
    const token = 'synthetic-test-token-'.repeat(3)
    let server: ReturnType<typeof createDockerHostAgent>, base: string
    beforeEach(async () => {
        mkdirSync(stateDir, { recursive: true })
        server = createDockerHostAgent({ nodeId: 'spark', clientId: 'main', token, stateDir }, { call: async () => [] }, undefined, switcher())
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as any).port}`
    })
    afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const post = async (path: string, body: unknown) => {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { status: res.status, json: await res.json() as any }
    }

    it('state und action laufen über den authentifizierten Socket; stop/kill/exec gibt es nicht', async () => {
        expect((await post('/v1/vllm/state', {})).json).toMatchObject({ success: true, currentTarget: 'flash' })
        expect((await post('/v1/vllm/action', { ticket: ticket('markieren') })).json).toMatchObject({ success: true })
        for (const path of ['/v1/vllm/stop', '/v1/vllm/stoppen', '/v1/vllm/kill', '/v1/vllm/exec']) expect((await post(path, {})).status).toBe(404)
        const extra = await post('/v1/vllm/action', { ticket: ticket('wechseln'), command: 'docker stop sparkrun' })
        expect(extra.status).toBe(409)
        expect(launches).toEqual([])
    })
})
