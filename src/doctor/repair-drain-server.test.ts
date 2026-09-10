import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { RepairDrain } from './repair-drain.js'
import { RepairDrainClient } from './repair-drain-client.js'
import { createRepairDrainServer } from './repair-drain-server.js'
import { signRepairValue, type RepairReceipt } from './repair-activation.js'

const keys = () => { const k = generateKeyPairSync('ed25519'); return {
    privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
} }
const ticket = () => ({ proposalId: 'p', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'original', targetId: 'fixture', attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 })
async function fixture(run: (f: any) => Promise<void>) {
    const authority = keys(), operator = keys(), node = keys(), observer = keys(), receipt = keys(), updateReceipt = keys()
    const drain = new RepairDrain(join(process.cwd(), '.nova-data', randomUUID()), ['a', 'b'])
    const server = createRepairDrainServer({ drain, privateKey: authority.privateKey, operatorPublicKey: operator.publicKey,
        receiptPublicKey: receipt.publicKey, updateReceiptPublicKey: updateReceipt.publicKey, nodes: { a: { publicKey: node.publicKey, settledTools: ['read_file'] }, b: { publicKey: keys().publicKey, settledTools: [] } },
        observers: { watcher: observer.publicKey } })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as any).port}/drain`
    const client = (actor: string, privateKey: string) => new RepairDrainClient({ url, actor, privateKey, authorityPublicKey: authority.publicKey })
    try { await run({ drain, node: client('a', node.privateKey), operator: client('operator', operator.privateKey), observer: client('watcher', observer.privateKey),
        bad: client('a', keys().privateKey), receiptKey: receipt.privateKey, updateReceiptKey: updateReceipt.privateKey }) }
    finally { await new Promise<void>(r => server.close(() => r())) }
}
it('requires pinned signatures and operator-only maintenance, observers can only read', async () => fixture(async f => {
    const t = ticket()
    await expect(f.bad.request('admit', { id: randomUUID(), tool: 'read_file' })).rejects.toThrow()
    await expect(f.node.request('begin', t)).rejects.toThrow()
    await expect(f.observer.request('begin', t)).rejects.toThrow()
    await expect(f.observer.request('admit', { id: randomUUID(), tool: 'read_file' })).rejects.toThrow()
    await f.operator.request('begin', t)
    expect(await f.observer.request('status', t)).toMatchObject({ toolActionsDrained: true, externalWritersQuiesced: false })
}))
it.each(['installed', 'rolled-back'])('reopens routine update only with separately pinned %s evidence', async status => fixture(async f => {
    const t = { ...ticket(), proposalId: 'upstream-fixture' }; await f.operator.request('begin', t)
    const receipt = { ticket: t, status, before: 'baseline', after: 'candidate', restoration: 'baseline', releaseId: 'new', previousReleaseId: 'old', updatedAt: Date.now() }
    const release = (r: any, key = f.updateReceiptKey) => f.operator.request('release-update', { ticket: t, receipt: signRepairValue(r, key) })
    await expect(release(receipt, f.receiptKey)).rejects.toThrow()
    await expect(f.node.request('release-update', { ticket: t, receipt: signRepairValue(receipt, f.updateReceiptKey) })).rejects.toThrow()
    await expect(release({ ...receipt, status: 'blocked' })).rejects.toThrow()
    await expect(release({ ...receipt, ticket: { ...t, targetId: 'other' } })).rejects.toThrow()
    await expect(release({ ...receipt, before: '' })).rejects.toThrow()
    if (status === 'rolled-back') await expect(release({ ...receipt, restoration: 'different' })).rejects.toThrow()
    await release(receipt)
    expect(await f.node.execute('read_file', true, async () => 'resumed')).toBe('resumed')
}))
it('tracks actual promise completion after the caller stops waiting', async () => fixture(async f => {
    let finish!: () => void, entered!: () => void
    const started = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { finish = r })
    const action = f.node.execute('read_file', true, async () => { entered(); await gate; return 'actual result' })
    await started
    const t = ticket(); await f.operator.request('begin', t)
    try {
        expect(await Promise.race([action, Promise.resolve('caller timed out')])).toBe('caller timed out')
        expect(await f.operator.request('status', t)).toMatchObject({ toolActionsDrained: false, pending: 1 })
        let ran = false
        await expect(f.node.execute('read_file', true, async () => { ran = true })).rejects.toThrow()
        expect(ran).toBe(false)
    } finally { finish(); await action }
    expect(await f.operator.request('status', t)).toMatchObject({ toolActionsDrained: true, pending: 0 })
}))
it('cannot turn an unclassified action into a settled one by renaming it at completion', async () => fixture(async f => {
    const permit = await f.node.request('admit', { id: randomUUID(), tool: 'run_command' })
    await f.node.request('settle', { ...permit, tool: 'read_file', certain: true })
    const t = ticket(); await f.operator.request('begin', t)
    expect(await f.operator.request('status', t)).toMatchObject({ toolActionsDrained: false, uncertain: 1 })
}))
it.each(['resolved', 'rolled-back'] as const)('reopens only on independent %s receipt and reconciles lost replies without reopening a new hold', async status => fixture(async f => {
    const t = ticket(); await f.operator.request('begin', t)
    const observation = { probeId: t.probeId, targetId: t.targetId, challenge: randomUUID(), observedAt: Date.now(), state: 'fault' as const, fingerprint: 'original-failure', releaseId: 'old' }
    const receipt: RepairReceipt = { binding: t, status, releaseId: 'new', previousReleaseId: 'old', before: observation, updatedAt: Date.now(),
        after: { ...observation, state: 'healthy', releaseId: 'new' }, restoration: observation }
    const release = (r: RepairReceipt, key = f.receiptKey) => f.operator.request('release', { ticket: t, receipt: signRepairValue(r, key) })
    await expect(release(receipt, keys().privateKey)).rejects.toThrow()
    await expect(release({ ...receipt, status: 'blocked' })).rejects.toThrow()
    await expect(release({ ...receipt, before: { ...observation, releaseId: 'wrong' } })).rejects.toThrow()
    if (status === 'rolled-back') await expect(release({ ...receipt, restoration: { ...observation, state: 'healthy' } })).rejects.toThrow()
    expect(await f.operator.request('status', t)).toMatchObject({ toolActionsDrained: true })
    await release(receipt)
    const next = ticket(); await f.operator.request('begin', next)
    await release(receipt) // Lost earlier reply may be retried, but only that ticket.
    await expect(f.node.execute('read_file', true, async () => 'no')).rejects.toThrow()
    await expect(f.operator.request('begin', t)).rejects.toThrow()
}))
