import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { createRepairControllerServer } from './repair-controller-server.js'
import { signRepairValue, verifyRepairValue, type RepairDeploymentDriver } from './repair-activation.js'

it('retains recovery receipt when admission release fails; status retries release without redeploying', async () => {
    const key = generateKeyPairSync('ed25519'), publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const binding = { proposalId: 'p', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'original', targetId: 'fixture' }
    const ticket = { ...binding, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 }
    let current = 'old'
    const driver: RepairDeploymentDriver = { hasAuthority: async () => true, prepare: async () => ({ binding, releaseId: 'new', previousReleaseId: 'old' }),
        beginMaintenance: vi.fn(async () => undefined), activate: vi.fn(async () => { current = 'new' }), rollback: async () => { current = 'old' }, currentRelease: async () => current }
    const onVerifiedReceipt = vi.fn(async signed => { expect(verifyRepairValue<any>(signed, publicKey).status).toBe('resolved') })
        .mockRejectedValueOnce(Error('drain unreachable'))
    const server = createRepairControllerServer({ stateRoot: join(process.cwd(), '.nova-data', randomUUID()), approvalPublicKey: publicKey, receiptPrivateKey: privateKey,
        driver, onVerifiedReceipt, probe: async (probeId, targetId, challenge) => ({ probeId, targetId, challenge, observedAt: Date.now(), releaseId: current,
            state: current === 'old' ? 'fault' : 'healthy', fingerprint: current }) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const send = (body: unknown) => fetch(`http://127.0.0.1:${(server.address() as any).port}/repair`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    try {
        expect((await send({ operation: 'activate', ticket: signRepairValue(ticket, privateKey) })).status).toBe(409)
        const status = await send({ operation: 'status', attemptId: ticket.attemptId })
        expect(verifyRepairValue<any>(await status.json(), publicKey).status).toBe('resolved')
        expect(driver.activate).toHaveBeenCalledOnce(); expect(driver.beginMaintenance).toHaveBeenCalledOnce()
        expect(onVerifiedReceipt).toHaveBeenCalledTimes(2)
    } finally { await new Promise<void>(r => server.close(() => r())) }
})
