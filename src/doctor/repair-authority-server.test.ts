import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { it, expect } from 'vitest'
import { createRepairAuthorityServer, type RepairOperatorGrant } from './repair-authority-server.js'
import { repairHash, verifyRepairValue } from './repair-activation.js'

it.each(['valid', 'no-grant', 'different-patch', 'expired-grant', 'different-main', 'different-epoch', 'lease-unavailable', 'state-without-drain', 'fresh-state-proof', 'stale-state-proof', 'short-grant', 'short-ticket', 'short-state-proof'])(
    'separate HTTP authority evaluates %s without acquiring a lease', async scenario => {
        const keys = generateKeyPairSync('ed25519'), now = Date.now()
        const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        const binding = { proposalId: 'proposal', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'answer', targetId: 'runtime' }
        const ticket = { ...binding, attemptId: `repair-${randomUUID()}`, expiresAt: now + 60_000 }
        const grant: RepairOperatorGrant = { binding, expiresAt: scenario === 'expired-grant' ? now - 1 : now + 60_000, holderNodeId: 'main', leaseEpoch: 7 }
        if (scenario === 'different-patch') grant.binding = { ...binding, candidateHash: 'd'.repeat(64) }
        if (scenario.includes('state-proof')) grant.quiescence = { bindingHash: repairHash(ticket), verifiedAt: scenario === 'stale-state-proof' ? now - 30_000 : now, expiresAt: now + 20_000, externalWritersQuiesced: true }
        if (scenario === 'short-grant') grant.expiresAt = now + 2000
        if (scenario === 'short-ticket') ticket.expiresAt = now + 2000
        if (scenario === 'short-state-proof') grant.quiescence!.expiresAt = now + 2000
        let reads = 0
        const server = createRepairAuthorityServer({ privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            readGrant: () => scenario === 'no-grant' ? undefined : grant,
            readLease: async () => { reads++; return scenario === 'lease-unavailable' ? undefined : {
                holderNodeId: scenario === 'different-main' ? 'other' : 'main', epoch: scenario === 'different-epoch' ? 8 : 7, expiresAt: now + 60_000,
            } },
        })
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
            const challenge = randomUUID(), route = scenario.includes('state-') ? 'state' : 'authority'
            const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/${route}`, {
                method: 'POST', body: JSON.stringify({ challenge, ticket }), signal: AbortSignal.timeout(5000),
            })
            const decision: any = verifyRepairValue(await response.json(), publicKey)
            expect(decision.allowed).toBe(['valid', 'fresh-state-proof', 'short-grant', 'short-ticket', 'short-state-proof'].includes(scenario))
            if (scenario.startsWith('short-')) expect(decision.expiresAt).toBeLessThanOrEqual(now + 2000)
            expect(decision.challenge).toBe(challenge); expect(decision.bindingHash).toBe(repairHash(ticket))
            expect(reads).toBe(1)
        } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    },
)
