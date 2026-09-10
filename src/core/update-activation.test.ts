import { it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UpdateActivationController } from './update-activation.js'
import { signRepairValue } from '../doctor/repair-activation.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'update-activation-')); roots.push(root)
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const ticket = { proposalId: 'upstream-fixture', targetId: 'fixture', probeId: 'health', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 }
    const { attemptId, expiresAt, ...binding } = ticket
    let current = 'old'
    const driver = { hasAuthority: vi.fn(async () => true), prepare: vi.fn(async () => ({ releaseId: 'new', previousReleaseId: 'old', binding })),
        currentRelease: vi.fn(async () => current), beginMaintenance: vi.fn(async () => {}), activate: vi.fn(async () => { current = 'new' }), rollback: vi.fn(async () => { current = 'old' }) }
    const probe = vi.fn(async (release: string) => release === 'old' ? 'baseline' : 'candidate'), complete = vi.fn(async () => {})
    const signed = signRepairValue(ticket, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    const controller = new UpdateActivationController(root, publicKey, driver, probe, complete)
    return { root, keys, publicKey, signed, ticket, driver, probe, complete, controller }
}
it('installs only after independent baseline and candidate acceptance; replay never re-executes', async () => {
    const f = fixture(), result = await f.controller.deploy(f.signed, {})
    expect(result).toMatchObject({ status: 'installed', before: 'baseline', after: 'candidate' })
    expect(f.complete).toHaveBeenCalledTimes(1)
    const restarted = new UpdateActivationController(f.root, f.publicKey, f.driver, f.probe, f.complete)
    expect(await restarted.deploy(f.signed, {})).toEqual(result)
    expect(f.driver.activate).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1)
    expect(existsSync(join(f.root, 'activation.lock'))).toBe(false)
})
it('rolls back failed independent acceptance and verifies the original fingerprint', async () => {
    const f = fixture(); f.probe.mockImplementation(async r => { if (r === 'new') throw Error('bad'); return 'baseline' })
    expect(await f.controller.deploy(f.signed, {})).toMatchObject({ status: 'rolled-back', restoration: 'baseline' })
    expect(f.driver.rollback).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1)
})
it('retains ownership and never reopens admission when rollback evidence differs', async () => {
    const f = fixture(); f.probe.mockResolvedValueOnce('baseline').mockRejectedValueOnce(Error('bad')).mockResolvedValueOnce('different')
    expect((await f.controller.deploy(f.signed, {})).status).toBe('blocked')
    expect(f.complete).not.toHaveBeenCalled(); expect(existsSync(join(f.root, 'activation.lock'))).toBe(true)
})
it('lost fencing after candidate switch forbids rollback under an obsolete lease', async () => {
    const f = fixture(); f.driver.activate.mockImplementation(async () => { f.driver.hasAuthority.mockResolvedValue(false) })
    expect((await f.controller.deploy(f.signed, {})).status).toBe('blocked')
    expect(f.driver.rollback).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled()
})
it('does not stop a healthy old container when baseline acceptance fails', async () => {
    const f = fixture(); f.probe.mockRejectedValueOnce(Error('baseline unknown'))
    expect((await f.controller.deploy(f.signed, {})).status).toBe('blocked')
    expect(f.driver.activate).not.toHaveBeenCalled(); expect(f.driver.beginMaintenance).not.toHaveBeenCalled()
})
it('does not infer drain rollback from a failed maintenance request', async () => {
    const f = fixture(); f.driver.beginMaintenance.mockRejectedValue(Error('lost reply'))
    expect((await f.controller.deploy(f.signed, {})).status).toBe('blocked')
    expect(existsSync(join(f.root, 'activation.lock'))).toBe(true); expect(f.driver.activate).not.toHaveBeenCalled()
})
it('rejects changed or expired signed tickets before driver calls', async () => {
    const f = fixture()
    await expect(f.controller.deploy({ ...f.signed, payload: { ...f.ticket, targetId: 'other' } }, {})).rejects.toThrow()
    const expired = signRepairValue({ ...f.ticket, expiresAt: 1 }, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    await expect(f.controller.deploy(expired, {})).rejects.toThrow()
    expect(f.driver.prepare).not.toHaveBeenCalled()
})
it('never overwrites an earlier receipt with a conflicting replay', async () => {
    const f = fixture(); await f.controller.deploy(f.signed, {})
    const changed = signRepairValue({ ...f.ticket, probeId: 'other' }, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    await expect(f.controller.deploy(changed, {})).rejects.toThrow('replay')
    expect(f.controller.status(f.ticket.attemptId)?.ticket.probeId).toBe('health')
})
