import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    emergencyLeaseDecision, grantEmergencyForTests, handleSuccessionRequest, installSuccessionControllerForTests,
    isEmergencyTermValid, reconcileLeaseDecision, resetSuccessionRuntimeForTests,
} from './succession-runtime.js'
import { checkDelegatedFence, observeFenceEpoch, parseFenceToken } from './fence-highwater.js'
import { adoptFence, checkFence, resetFenceStateForTests } from './fence.js'
import { JournalReplica, deriveJournalKeys, sealEntry } from './state-journal.js'
import { createSuccessionLocalApi } from './succession-local-api.js'
import { sendSuccessionMoveNotice } from '../core/daemon-channels.js'
import type { SuccessionController } from './succession.js'

let runtimeRoot = ''
beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'xv-succession-rt-'))
    mkdirSync(join(runtimeRoot, '.nova-data'), { recursive: true })
    vi.stubEnv('NOVA_RUNTIME_ROOT', runtimeRoot)
    writeFileSync(join(runtimeRoot, 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'ha' } }))
    vi.spyOn(process, 'cwd').mockReturnValue(runtimeRoot)
    resetFenceStateForTests()
    resetSuccessionRuntimeForTests()
})
afterEach(() => {
    resetSuccessionRuntimeForTests()
    resetFenceStateForTests()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
})

const fakeController = (mode: string, notice: string | null = null) => {
    let pending = notice
    return {
        mode: () => mode,
        takeMoveNotice: () => { const value = pending; pending = null; return value },
        adoptTerm: vi.fn(async () => true),
        noteLeaseLost: vi.fn(async () => undefined),
        secret: () => undefined,
        isActingMain: () => mode === 'main' || mode === 'emergency-main',
        status: () => ({ mode, epoch: 0, reason: '', secretsUnlocked: false }),
    } as unknown as SuccessionController
}

describe('2.88 emergency term in the lease layer', () => {
    it('is honoured only while no majority is reachable', () => {
        const controller = fakeController('emergency-main')
        installSuccessionControllerForTests(controller)
        grantEmergencyForTests(9, 60_000)
        const denied = { leader: false, quorumReachable: false, reason: 'witness quorum denied: 0/2 approvals (1/3 authenticated responses)' }
        const kept = reconcileLeaseDecision('telegram', denied)
        expect(kept.leader).toBe(true)
        expect(kept.coordinator).toBe('emergency')
        expect(kept.fencingToken).toMatch(/^telegram:e9:/)
        // Majority back and held by another node: the emergency term ends at once.
        const other = reconcileLeaseDecision('nova-main', { leader: false, quorumReachable: true, heldByOther: true, reason: 'held by node-b' })
        expect(other.leader).toBe(false)
        expect(emergencyLeaseDecision('nova-main')).toBeNull()
        expect(controller.noteLeaseLost).toHaveBeenCalled()
    })

    it('a majority lease for this node replaces the emergency term', () => {
        const controller = fakeController('emergency-main')
        installSuccessionControllerForTests(controller)
        grantEmergencyForTests(9, 60_000)
        const regular = reconcileLeaseDecision('nova-main', { leader: true, epoch: 11, coordinator: 'witness', quorumReachable: true, reason: 'quorum' })
        expect(regular.epoch).toBe(11)
        expect(emergencyLeaseDecision('nova-main')).toBeNull()
        expect(controller.adoptTerm).toHaveBeenCalledWith(11)
    })

    it('an emergency fence is valid only while the term runs', async () => {
        installSuccessionControllerForTests(fakeController('emergency-main'))
        grantEmergencyForTests(4, 60_000)
        expect(isEmergencyTermValid(4)).toBe(true)
        expect(isEmergencyTermValid(3)).toBe(false)
        adoptFence({ service: 'nova-main', epoch: 4, token: 'nova-main:e4:node-b', coordinator: 'emergency', nodeId: 'node-b', instanceId: 'i', deadlineMono: performance.now() + 60_000 })
        expect((await checkFence('nova-main', { live: true })).ok).toBe(true)
        resetSuccessionRuntimeForTests()
        expect((await checkFence('nova-main', { live: true })).ok).toBe(false)
    })

    it('workers accept emergency tokens and still refuse the old Main after an epoch change', async () => {
        expect(parseFenceToken('nova-main:e7:node-b')).toEqual({ service: 'nova-main', epoch: 7, nodeId: 'node-b' })
        expect((await checkDelegatedFence({ service: 'nova-main', epoch: 7, token: 'nova-main:e7:node-b', sourceNode: 'node-b' })).ok).toBe(true)
        const old = await checkDelegatedFence({ service: 'nova-main', epoch: 6, token: 'nova-main:q6:node-a', sourceNode: 'node-a' })
        expect(old.ok).toBe(false)
        expect(old.reason).toMatch(/stale epoch 6/)
        expect(observeFenceEpoch('nova-main', 8).accepted).toBe(true)
        expect((await checkDelegatedFence({ service: 'nova-main', epoch: 7, token: 'nova-main:e7:node-b', sourceNode: 'node-b' })).ok).toBe(false)
    })
})

describe('2.88 succession requests between nodes', () => {
    it('binds journal writes to the sending node and only serves main nodes', async () => {
        const keys = deriveJournalKeys('r'.repeat(48))
        const replica = new JournalReplica('node-c', keys)
        installSuccessionControllerForTests(fakeController('follower'), { mainNodes: ['node-a', 'node-b', 'node-c'], replica })
        vi.spyOn(await import('./mesh-registry.js'), 'getLocalNodeId').mockReturnValue('node-c')
        const entry = sealEntry(keys, { seq: 1, epoch: 1, nodeId: 'node-a', kind: 'term', prevHash: '', payload: {} })
        const forged = await handleSuccessionRequest({ op: 'deliver', message: { entries: [entry] } }, 'node-b')
        expect(forged.success).toBe(false)
        const real = await handleSuccessionRequest({ op: 'deliver', message: { entries: [entry] } }, 'node-a')
        expect(real.success).toBe(true)
        expect((real.result as { ok: boolean }).ok).toBe(true)
        expect((await handleSuccessionRequest({ op: 'export' }, 'node-worker')).success).toBe(false)
        expect((await handleSuccessionRequest({ op: 'export' }, 'node-b')).result).toMatchObject({ nodeId: 'node-c', highWater: 1 })
        expect((await handleSuccessionRequest({ op: 'share', request: { requester: 'node-b', requesterPublicKey: 'x', epoch: 2 } }, 'node-b')).success).toBe(false)
    })
})

describe('2.88 move notice on Telegram', () => {
    it('is sent once, only with live authority and a known chat', async () => {
        installSuccessionControllerForTests(fakeController('main', 'Ich bin jetzt auf RECHNER-B umgezogen, alles da.'))
        const sent: Array<[string, string]> = []
        const adapter = { bot: { sendMessage: async (chat: string, text: string) => { sent.push([chat, text]) } } }
        const state = { channels: { telegram: null, whatsapp: null, discord: null }, adminChatId: '4242' } as any
        expect(await sendSuccessionMoveNotice(adapter, state, async () => false)).toBe(false)
        expect(sent).toEqual([])
        expect(await sendSuccessionMoveNotice(adapter, state, async () => true)).toBe(true)
        expect(await sendSuccessionMoveNotice(adapter, state, async () => true)).toBe(false)
        expect(sent).toEqual([['4242', 'Ich bin jetzt auf RECHNER-B umgezogen, alles da.']])
    })
})

describe('2.88 local owner door (safe mode)', () => {
    const start = async (claim = vi.fn(async (code: string) => code === 'Sonne-Mond-42'
        ? { ok: true, reason: 'Dieser Rechner ist jetzt Notfall-Main.' } : { ok: false, reason: 'Der Notfallcode stimmt nicht.' })) => {
        const setup = vi.fn(() => ({ ok: true, reason: 'gespeichert' }))
        const api = createSuccessionLocalApi({ status: () => ({ mode: 'safe', text: 'Sicherer Modus' }), claim, setup, ownerToken: () => 'owner-token-1234567890' })
        const port = await api.listen(0)
        return { api, port, claim, setup }
    }

    it('accepts the right code, refuses a wrong one and never echoes it', async () => {
        const { api, port, claim } = await start()
        const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn')
        try {
            const post = (code: string) => fetch(`http://127.0.0.1:${port}/nachfolge/notfall`, { method: 'POST', body: JSON.stringify({ code }) })
            const wrong = await post('falsch-falsch-1')
            expect(wrong.status).toBe(403)
            expect(await wrong.text()).not.toContain('falsch')
            const right = await post('Sonne-Mond-42')
            expect(right.status).toBe(200)
            expect(claim).toHaveBeenCalledTimes(2)
            const status = await (await fetch(`http://127.0.0.1:${port}/nachfolge`)).json()
            expect(status.mode).toBe('safe')
            const logged = [...log.mock.calls, ...warn.mock.calls].flat().join(' ')
            expect(logged).not.toMatch(/Sonne|falsch/)
        } finally { api.server.close() }
    })

    it('refuses non-loopback hosts and needs the owner token to change the code', async () => {
        const { api, port, setup } = await start()
        try {
            // fetch cannot override Host; DNS rebinding is simulated with a raw request.
            const { request } = await import('node:http')
            const rebindingStatus = await new Promise<number>((resolve, reject) => {
                const req = request({ host: '127.0.0.1', port, path: '/nachfolge', headers: { host: 'evil.example.com' } }, res => { res.resume(); resolve(res.statusCode || 0) })
                req.on('error', reject)
                req.end()
            })
            expect(rebindingStatus).toBe(403)
            const proxied = await fetch(`http://127.0.0.1:${port}/nachfolge`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
            expect(proxied.status).toBe(403)
            const anonymous = await fetch(`http://127.0.0.1:${port}/nachfolge/notfallcode`, { method: 'POST', body: JSON.stringify({ code: 'Neuer-Code-77' }) })
            expect(anonymous.status).toBe(401)
            expect(setup).not.toHaveBeenCalled()
            const owner = await fetch(`http://127.0.0.1:${port}/nachfolge/notfallcode`, {
                method: 'POST', headers: { authorization: 'Bearer owner-token-1234567890' }, body: JSON.stringify({ code: 'Neuer-Code-77' }),
            })
            expect(owner.status).toBe(200)
        } finally { api.server.close() }
    })
})
