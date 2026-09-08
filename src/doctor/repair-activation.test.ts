import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairActivationController, signRepairValue, repairHash, type RepairTicket, type RepairDeploymentDriver, type IndependentRepairProbe } from './repair-activation.js'

function setup() {
    const root = mkdtempSync(join(tmpdir(), 'repair-controller-'))
    const keys = generateKeyPairSync('ed25519'), privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const binding = { proposalId: 'patch-1', patchHash: repairHash('patch'), baselineHash: repairHash('old'), candidateHash: repairHash('new'), probeId: 'answer', targetId: 'fixture' }
    const ticket: RepairTicket = { ...binding, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 }
    let current = 'old', healthy = true, authority = true
    const driver: RepairDeploymentDriver = {
        hasAuthority: vi.fn(async () => authority), prepare: vi.fn(async () => ({ binding, releaseId: 'new', previousReleaseId: 'old' })),
        activate: vi.fn(async () => { current = 'new' }), rollback: vi.fn(async () => { current = 'old' }), currentRelease: vi.fn(async () => current),
    }
    const probe: IndependentRepairProbe = vi.fn(async (probeId, targetId, challenge) => ({ probeId, targetId, challenge,
        observedAt: Date.now(), releaseId: current, state: current === 'new' && healthy ? 'healthy' : 'fault', fingerprint: current === 'new' && healthy ? 'answer:42' : 'answer:41' }))
    return { root, ticket, driver, probe, signed: () => signRepairValue(ticket, privateKey),
        controller: new RepairActivationController(root, publicKey, driver, probe), setHealthy: (v: boolean) => healthy = v, setAuthority: (v: boolean) => authority = v }
}

describe('external repair activation / scripted driver observations', () => {
    it('requires original fault then independently healthy new runtime', async () => {
        const f = setup(), result = await f.controller.activate(f.signed())
        expect(result).toMatchObject({ status: 'resolved', before: { state: 'fault', releaseId: 'old' }, after: { state: 'healthy', releaseId: 'new' } })
        expect(f.driver.activate).toHaveBeenCalledTimes(1)
        expect(f.driver.rollback).not.toHaveBeenCalled()
        expect(JSON.parse(readFileSync(join(f.root, `${f.ticket.attemptId}.json`), 'utf8')).status).toBe('resolved')
    })
    it('replay returns durable result without repeating external change', async () => {
        const f = setup(), signed = f.signed()
        await f.controller.activate(signed)
        expect((await f.controller.activate(signed)).status).toBe('resolved')
        expect(f.driver.activate).toHaveBeenCalledTimes(1)
    })
    it('cannot approve by modifying a signed ticket', async () => {
        const f = setup(), signed = f.signed(); signed.payload.candidateHash = repairHash('evil')
        await expect(f.controller.activate(signed)).rejects.toThrow('signature')
        expect(f.driver.prepare).not.toHaveBeenCalled()
    })
    it('does not overwrite an existing receipt on an authorized but mismatched replay', async () => {
        const f = setup(); await f.controller.activate(f.signed())
        const path = join(f.root, `${f.ticket.attemptId}.json`), original = readFileSync(path, 'utf8')
        f.ticket.patchHash = repairHash('different approved patch')
        await expect(f.controller.activate(f.signed())).rejects.toThrow('replay binding')
        expect(readFileSync(path, 'utf8')).toBe(original)
        expect(f.driver.activate).toHaveBeenCalledTimes(1)
    })
    it('cannot activate an expired ticket', async () => {
        const f = setup(); f.ticket.expiresAt = Date.now() - 1
        await expect(f.controller.activate(f.signed())).rejects.toThrow('expired')
        expect(f.driver.prepare).not.toHaveBeenCalled()
    })
    it('blocks an artifact for a different patch', async () => {
        const f = setup(); vi.mocked(f.driver.prepare).mockResolvedValue({ releaseId: 'new', previousReleaseId: 'old', binding: { ...f.ticket, patchHash: repairHash('wrong') } })
        expect((await f.controller.activate(f.signed())).status).toBe('blocked')
        expect(f.driver.activate).not.toHaveBeenCalled()
    })
    for (const state of ['healthy', 'unknown'] as const) it(`does not repair a ${state} baseline`, async () => {
        const f = setup()
        vi.mocked(f.probe).mockImplementation(async (probeId, targetId, challenge) => ({ probeId, targetId, challenge, observedAt: Date.now(), releaseId: 'old', state, fingerprint: 'same' }))
        expect((await f.controller.activate(f.signed())).status).toBe('blocked')
        expect(f.driver.activate).not.toHaveBeenCalled()
    })
    for (const field of ['challenge', 'targetId', 'probeId', 'releaseId', 'observedAt'] as const) it(`rejects stale/wrong ${field}`, async () => {
        const f = setup()
        vi.mocked(f.probe).mockImplementation(async (probeId, targetId, challenge) => ({ probeId, targetId, challenge, observedAt: Date.now(), releaseId: 'old', state: 'fault', fingerprint: 'fault', [field]: field === 'observedAt' ? 0 : 'wrong' }))
        expect((await f.controller.activate(f.signed())).status).toBe('blocked')
        expect(f.driver.activate).not.toHaveBeenCalled()
    })
    it('failed semantic recovery triggers rollback and original-behaviour verification', async () => {
        const f = setup(); f.setHealthy(false)
        expect(await f.controller.activate(f.signed())).toMatchObject({ status: 'rolled-back', after: { state: 'fault' }, restoration: { fingerprint: 'answer:41', releaseId: 'old' } })
        expect(f.driver.rollback).toHaveBeenCalledOnce()
    })
    it('lost authority blocks rollback writes and retains crash ownership', async () => {
        const f = setup(); vi.mocked(f.driver.activate).mockImplementation(async () => { f.setAuthority(false) })
        expect((await f.controller.activate(f.signed())).status).toBe('blocked')
        expect(f.driver.rollback).not.toHaveBeenCalled()
        expect(existsSync(join(f.root, 'activation.lock'))).toBe(true)
    })
    it('failed rollback is never reported as restored and blocks new attempts', async () => {
        const f = setup(); f.setHealthy(false); vi.mocked(f.driver.rollback).mockRejectedValue(new Error('service refused stop'))
        expect((await f.controller.activate(f.signed())).status).toBe('blocked')
        f.ticket.attemptId = `repair-${randomUUID()}`
        await expect(f.controller.activate(f.signed())).rejects.toThrow()
        expect(f.driver.activate).toHaveBeenCalledTimes(1)
    })
    it('a second process cannot start while the first owns activation', async () => {
        const f = setup(); let release!: () => void
        vi.mocked(f.driver.hasAuthority).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(true) }))
        const first = f.controller.activate(f.signed())
        await expect(f.controller.activate(f.signed())).rejects.toThrow()
        release(); await first
        expect(f.driver.activate).toHaveBeenCalledTimes(1)
    })
})
