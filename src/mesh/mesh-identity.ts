import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import type { MeshEnvelope, MeshEnvelopeKind, MeshFence, MeshPrincipal } from './transport-contracts.js'

interface IdentityFile { nodeId: string; privateKey: string; publicKey: string; createdAt: string }

function stable(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}

function atomicWrite(path: string, value: unknown): void {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
}

export class MeshIdentity {
    private sequence = 0
    readonly nodeId: string
    readonly publicKey: string
    private readonly privateKey: string

    constructor(nodeId: string, dir = getNovaDataDir('mesh-identity')) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const path = join(dir, `${nodeId}.json`)
        let identity: IdentityFile | null = null
        try { identity = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile } catch { /* first boot */ }
        if (!identity?.privateKey || !identity.publicKey || identity.nodeId !== nodeId) {
            const pair = generateKeyPairSync('ed25519')
            identity = {
                nodeId,
                privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                createdAt: new Date().toISOString(),
            }
            atomicWrite(path, identity)
        }
        this.nodeId = nodeId
        this.privateKey = identity.privateKey
        this.publicKey = identity.publicKey
    }

    create<T>(params: {
        kind: MeshEnvelopeKind; targetNode: string | '*'; payload: T; principal: MeshPrincipal
        runId?: string; fence?: MeshFence; ttlMs?: number
    }): MeshEnvelope<T> {
        const payloadHash = createHash('sha256').update(stable(params.payload)).digest('hex')
        const unsigned = {
            version: 1 as const, id: randomUUID(), kind: params.kind,
            sourceNode: this.nodeId, targetNode: params.targetNode,
            createdAt: Date.now(), expiresAt: Date.now() + (params.ttlMs || 60_000),
            nonce: randomBytes(18).toString('base64url'), sequence: ++this.sequence,
            runId: params.runId, principal: params.principal, fence: params.fence,
            payload: params.payload, payloadHash, publicKey: this.publicKey,
        }
        const signature = sign(null, Buffer.from(stable(unsigned)), this.privateKey).toString('base64url')
        return { ...unsigned, signature }
    }

    static verify(envelope: MeshEnvelope): boolean {
        const { signature, ...unsigned } = envelope
        const hash = createHash('sha256').update(stable(envelope.payload)).digest('hex')
        if (hash !== envelope.payloadHash) return false
        try { return verify(null, Buffer.from(stable(unsigned)), envelope.publicKey, Buffer.from(signature, 'base64url')) }
        catch { return false }
    }

    static fingerprint(publicKey: string): string {
        return createHash('sha256').update(publicKey).digest('hex').slice(0, 24)
    }
}

export class MeshReplayGuard {
    private readonly seen = new Map<string, number>()
    constructor(private readonly maxSkewMs = 2 * 60_000, private readonly maxEntries = 20_000, private readonly path?: string) {
        if (path) {
            try {
                const stored = JSON.parse(readFileSync(path, 'utf8')) as Array<[string, number]>
                const now = Date.now()
                for (const [key, expiresAt] of stored) if (expiresAt > now) this.seen.set(key, expiresAt)
            } catch { /* first boot or corrupt disposable replay cache */ }
        }
    }

    accept(envelope: MeshEnvelope, now = Date.now()): { accepted: boolean; reason?: string } {
        if (Math.abs(now - envelope.createdAt) > this.maxSkewMs || envelope.expiresAt < now) {
            return { accepted: false, reason: 'expired_or_clock_skew' }
        }
        const key = `${envelope.sourceNode}:${envelope.id}:${envelope.nonce}`
        if (this.seen.has(key)) return { accepted: false, reason: 'replay' }
        this.seen.set(key, envelope.expiresAt)
        if (this.seen.size > this.maxEntries) {
            for (const [id, expiresAt] of this.seen) {
                if (expiresAt < now || this.seen.size > this.maxEntries) this.seen.delete(id)
                else break
            }
        }
        this.persist()
        return { accepted: true }
    }

    private persist(): void {
        if (!this.path) return
        const dir = this.path.slice(0, Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\')))
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
        const temporary = `${this.path}.tmp`
        writeFileSync(temporary, JSON.stringify([...this.seen]))
        renameSync(temporary, this.path)
    }
}
