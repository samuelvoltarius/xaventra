import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { RepairDrain } from '../doctor/repair-drain.js'
import { createRepairDrainServer } from '../doctor/repair-drain-server.js'
import { getToolRegistry } from './complete-registry.js'

it('registry handlers retrieved directly cannot bypass configured maintenance admission', async () => {
    const key = generateKeyPairSync('ed25519'), privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const root = join(process.cwd(), '.nova-data', randomUUID()), drain = new RepairDrain(root, ['fixture'])
    const server = createRepairDrainServer({ drain, privateKey, operatorPublicKey: publicKey, receiptPublicKey: publicKey, nodes: { fixture: { publicKey, settledTools: [] } } })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const path = join(root, 'local-client.json'), prior = process.env.XAVENTRA_REPAIR_DRAIN_CLIENT_FILE
    writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}/drain`, actor: 'fixture', privateKey, authorityPublicKey: publicKey }), { mode: 0o600 })
    process.env.XAVENTRA_REPAIR_DRAIN_CLIENT_FILE = path
    let ran = false
    const completeToolRegistry = getToolRegistry()
    const name = `drain_${randomUUID().replaceAll('-', '')}`
    completeToolRegistry.register({ name, description: 'isolated regression', parameters: {}, handler: async () => { ran = true; return 'not allowed' } } as any)
    try {
        drain.begin({ proposalId: 'p', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'original', targetId: 'fixture', attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 })
        await expect(completeToolRegistry.get(name)!.handler({})).rejects.toThrow()
        expect(ran).toBe(false)
    } finally {
        if (prior === undefined) delete process.env.XAVENTRA_REPAIR_DRAIN_CLIENT_FILE; else process.env.XAVENTRA_REPAIR_DRAIN_CLIENT_FILE = prior
        completeToolRegistry.unregister(name)
        await new Promise<void>(r => server.close(() => r()))
    }
})
