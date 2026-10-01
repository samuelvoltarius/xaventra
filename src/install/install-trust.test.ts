import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { approveQueuedInstallByTrust, proposeCatalogInstall, type InstallQueueDeps, type InstallTargetNode } from './install-queue.js'

// The trust ladder may install from the catalog on its own (Alfred 01.10.:
// selbstständig) — but it signs as what it is, never as the owner, and only
// while the kind is really promoted.
const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spark: InstallTargetNode = { nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia', version: '2.82.0' }

function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'install-trust-'))
    const host = {
        execute: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'spark', ticketId: ticket.payload.id, catalogId: ticket.payload.catalogId, evidenceHash: 'e'.repeat(64), newPackages: ['ffmpeg'] })),
        rollback: vi.fn(async () => ({ success: true })), status: vi.fn(async () => null),
    }
    const deps: InstallQueueDeps = { dataDir, ticketPrivateKey: privateKey, hostNodeId: 'spark', hostClientId: 'xaventra-main', hostClient: host as any, now: () => Date.parse('2026-10-01T10:00:00Z') }
    const proposal = proposeCatalogInstall('ffmpeg', spark, deps, 'scan').proposal!
    return { deps, host, proposal }
}

describe('Installation über die Vertrauensleiter', () => {
    it('nicht hochgestuft: kein Ticket', async () => {
        const { deps, host, proposal } = setup()
        const result = await approveQueuedInstallByTrust(proposal.id, deps, { isPromoted: () => false })
        expect(result.ok).toBe(false)
        expect(host.execute).not.toHaveBeenCalled()
    })

    it('hochgestuft: Ticket signiert als policy:vertrauensleiter, nie als owner', async () => {
        const { deps, host, proposal } = setup()
        const result = await approveQueuedInstallByTrust(proposal.id, deps, { isPromoted: kind => kind === 'install-katalog' })
        expect(result.ok).toBe(true)
        expect(host.execute).toHaveBeenCalledTimes(1)
        expect(host.execute.mock.calls[0][0].payload.approvedBy).toBe('policy:vertrauensleiter')
    })

    it('Missions-Ausführer gibt die Vertrauensleiter nie als Owner aus', () => {
        const source = readFileSync(fileURLToPath(new URL('../core/responsibility-runtime.ts', import.meta.url)), 'utf8')
        expect(source).not.toMatch(/ctx\.approvedBy \|\| ctx\.trustedBy/)
    })
})
